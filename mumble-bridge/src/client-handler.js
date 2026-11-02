/**
 * Client message handler — processes incoming WebSocket messages from web clients.
 */
const { getBridgePool, getMumblePool, getAvatarPath } = require('./database');
const lexicon = require('./lexicon-client');
const config = require('./config');
const sec = require('./security');
const featureRegistry = require('./feature-registry');
const richText = require('./features/rich-text');
const { findMessageWindow } = require('./message-window');

// Only these may be sent before signing in.
const PRE_AUTH_TYPES = new Set(['auth', 'sso_auth', 'resume']);
const MAX_TEXT_LENGTH = 4000;
const MAX_CAPTION_LENGTH = 500;

// Brute-force protection for password logins. The per-address cap also keeps the bridge from burning
// through Lexicon's own per-address limit (every bridge login reaches Lexicon from the same address).
const loginThrottle = new sec.LoginThrottle();
const authAttemptsPerAddress = new sec.RateLimiter(20, 5 * 60 * 1000);
const sweeper = setInterval(() => { loginThrottle.sweep(); authAttemptsPerAddress.sweep(); }, 10 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

/**
 * Admin only for a *verified* login whose Lexicon login name is listed in SUPERUSER_NAMES. The display name is
 * user-editable and a typed name is unproven, so neither counts. The NAME_ONLY_ADMIN transition switch keeps
 * the old behaviour for legacy name-only sessions until it is turned off.
 */
function isAdminFor(identity) {
  return sec.isAdminIdentity(identity, { superUsers: config.superUsers, nameOnlyAdmin: config.security.nameOnlyAdmin });
}

function canAccessChannel(channelId, client) {
  const accessFeature = featureRegistry.features?.get('channel-access');
  return !accessFeature || accessFeature.canAccess(channelId, client.userId, client.isAdmin);
}

/** Merge real pin status (from the bridge-local sidecar table) into a list of Lexicon message rows. */
async function attachPinInfo(messages) {
  const pinFeature = featureRegistry.features?.get('pinned-messages');
  if (!pinFeature || !messages || messages.length === 0) return messages;
  return pinFeature.attachPinInfo(messages);
}

function authError(ws, message, extra = {}) {
  ws.send(JSON.stringify({ type: 'auth_error', message, ...extra }));
}

/**
 * Finish a login that has already been verified (or, for the legacy path, accepted): record the identity on
 * the socket, hand out a session token, and send the client everything it needs to start.
 */
async function completeLogin(ws, client, ctx, identity, { sso = false, sessionToken = null } = {}) {
  client.username = identity.displayName;
  client.userId = identity.userId;
  client.loginName = identity.loginName;
  client.strong = !!identity.strong;
  client.authenticated = true;
  client.isAdmin = isAdminFor(identity);

  if (!sessionToken) {
    sessionToken = await ctx.sessions.create({
      userId: identity.userId ?? null,
      loginName: identity.loginName,
      displayName: identity.displayName,
      strong: !!identity.strong,
    });
  }
  client.sessionToken = sessionToken;

  if (client.userId) {
    try {
      const pool = getBridgePool();
      await pool.execute(
        `INSERT INTO user_mapping (lexicon_user_id, lexicon_username, display_name)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE lexicon_user_id = VALUES(lexicon_user_id), display_name = VALUES(display_name), last_seen = NOW()`,
        [client.userId, identity.loginName, client.username]
      );
    } catch (err) {
      console.log(`[WS] User mapping update failed: ${err.message}`);
    }
  }

  const authOk = {
    type: 'auth_ok',
    username: client.username,
    userId: client.userId,
    isAdmin: client.isAdmin,
    sessionToken,
    verified: client.strong,
  };
  if (sso) authOk.sso = true;
  ws.send(JSON.stringify(authOk));

  // Look up avatar (only ever hand clients one of our own avatar URLs)
  let avatarUrl = sec.DEFAULT_AVATAR;
  try {
    const ap = await getAvatarPath(client.username);
    if (ap) avatarUrl = sec.safeAvatarUrl(ap);
  } catch (_) {}

  const webClientId = `web_${client.userId}`;
  client.webClientId = webClientId;
  ctx.webClients.set(webClientId, {
    username: client.username,
    userId: client.userId,
    channelId: client.channelId || 0,
    inVoice: false,
    voiceChannelId: null,
    avatarUrl,
    ws,
  });
  ctx.broadcastAll({
    type: 'web_user_join',
    webClient: { id: webClientId, username: client.username, channelId: client.channelId || 0, inVoice: false, avatarUrl },
  });
  const webClientList = [];
  for (const [id, wc] of ctx.webClients) {
    webClientList.push({ id, username: wc.username, channelId: wc.channelId, inVoice: wc.inVoice, voiceChannelId: wc.voiceChannelId, avatarUrl: wc.avatarUrl });
  }
  ws.send(JSON.stringify({ type: 'web_users', webClients: webClientList }));
  ctx.sendPostAuthChannelTopUp(ws, client);

  // Send unread DM counts on connect
  try {
    const dmsFeature = featureRegistry.features?.get('dms');
    if (dmsFeature && client.userId) {
      const unreads = await dmsFeature.getUnreadCounts(client.userId);
      if (unreads.length > 0) {
        ws.send(JSON.stringify({ type: 'dm_unread_counts', unreads }));
      }
    }
  } catch (_) {}

  if (sso) console.log(`[WS] SSO login successful: ${client.username} (ID: ${client.userId})`);
}

/** Handle `auth`: a Lexicon username + password (verified), or the legacy name-only login if still allowed. */
async function handleAuth(ws, msg, client, ctx) {
  const lex = ctx.lexicon || lexicon;
  const typed = typeof msg.username === 'string' ? msg.username.trim() : '';
  if (!typed) return ws.send(JSON.stringify({ type: 'error', message: 'Username is required' }));
  if (typed.length > 64) return authError(ws, 'Username is too long');
  const password = typeof msg.password === 'string' ? msg.password : '';

  if (!password) {
    if (!config.security.allowNameOnlyLogin) {
      return authError(ws, 'Enter your Lexicon password to sign in', { passwordRequired: true });
    }
    console.log(`[WS] Auth request (name only) from: ${typed}`);
    const player = await lex.getOrCreateUser(typed);
    return completeLogin(ws, client, ctx, {
      userId: player.id,
      loginName: player.username || typed,
      displayName: player.displayName || player.username || typed,
      strong: false,
    });
  }

  if (password.length > 256) return authError(ws, 'Invalid username or password');
  const ip = client.ip || 'unknown';
  const gate = authAttemptsPerAddress.take(ip);
  if (!gate.ok) {
    return authError(ws, `Too many sign-in attempts. Try again in ${Math.ceil(gate.retryAfterMs / 1000)} seconds.`);
  }
  const key = `${ip}|${typed.toLowerCase()}`;
  const wait = loginThrottle.check(key);
  if (!wait.ok) {
    return authError(ws, `Too many failed attempts. Try again in ${Math.ceil(wait.retryAfterMs / 1000)} seconds.`);
  }

  console.log(`[WS] Auth request (password) from: ${typed}`);
  const result = await lex.verifyCredentials(typed, password);
  if (!result.ok) {
    if (result.status === 429) {
      return authError(ws, `Too many failed attempts. Try again in ${result.retryAfterSec || 60} seconds.`);
    }
    if (result.status >= 500) {
      return authError(ws, 'Sign-in is unavailable right now. Please try again shortly.');
    }
    loginThrottle.failure(key);
    return authError(ws, 'Invalid username or password');
  }
  loginThrottle.success(key);
  const p = result.player;
  return completeLogin(ws, client, ctx, {
    userId: p.id,
    loginName: p.username,
    displayName: p.displayName || p.username,
    strong: true,
  });
}

/** Handle `sso_auth`: a single-use token minted by Lexicon for a signed-in user. */
async function handleSsoAuth(ws, msg, client, ctx) {
  const lex = ctx.lexicon || lexicon;
  if (typeof msg.token !== 'string' || !msg.token) {
    return ws.send(JSON.stringify({ type: 'error', message: 'SSO token is required' }));
  }
  const gate = authAttemptsPerAddress.take(client.ip || 'unknown');
  if (!gate.ok) return authError(ws, 'Too many sign-in attempts. Try again shortly.');

  console.log(`[WS] SSO auth request`);
  const ssoResult = await lex.validateSsoToken(msg.token);
  if (!ssoResult || !ssoResult.valid) {
    return authError(ws, 'Invalid or expired SSO token');
  }

  const ssoUsername = ssoResult.username;
  const ssoPlayer = await lex.getOrCreateUser(ssoUsername);
  return completeLogin(ws, client, ctx, {
    userId: ssoResult.userId || ssoPlayer.id,
    loginName: ssoUsername,
    displayName: ssoPlayer.displayName || ssoPlayer.username || ssoUsername,
    strong: true,
  }, { sso: true });
}

/** Handle `resume`: pick a session back up after a reconnect or bridge restart, using its session token. */
async function handleResume(ws, msg, client, ctx) {
  const record = await ctx.sessions.get(msg.sessionToken);
  if (!record || (!record.strong && !config.security.allowNameOnlyLogin)) {
    return authError(ws, 'Your session has ended. Please sign in again.', { sessionExpired: true });
  }
  return completeLogin(ws, client, ctx, {
    userId: record.userId,
    loginName: record.loginName,
    displayName: record.displayName,
    strong: record.strong,
  }, { sessionToken: msg.sessionToken });
}

/**
 * Handle a message from a web client.
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} msg - The parsed JSON message
 * @param {object} client - The client info object
 * @param {object} ctx - Server context { mumble, channels, voiceBridge, clients, webClients, broadcastAll, broadcastToChannel, sessions }
 */
async function handleClientMessage(ws, msg, client, ctx) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    return;
  }
  if (!client.authenticated && !PRE_AUTH_TYPES.has(msg.type)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    return;
  }
  if (client.authenticated && PRE_AUTH_TYPES.has(msg.type)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Already signed in on this connection' }));
    return;
  }

  switch (msg.type) {
    case 'auth':
      return handleAuth(ws, msg, client, ctx);

    case 'sso_auth':
      return handleSsoAuth(ws, msg, client, ctx);

    case 'resume':
      return handleResume(ws, msg, client, ctx);

    case 'logout': {
      await ctx.sessions.revoke(client.sessionToken);
      client.sessionToken = null;
      ws.send(JSON.stringify({ type: 'logged_out' }));
      break;
    }

    case 'push_subscribe': {
      if (!client.authenticated) return;
      const ok = await lexicon.pushSubscribe({
        userId: client.userId,
        endpoint: msg.subscription?.endpoint,
        keys: msg.subscription?.keys,
        userAgent: msg.userAgent || 'MumbleChat Web',
      });
      ws.send(JSON.stringify({ type: 'push_subscribe_ok', success: ok }));
      break;
    }

    case 'push_unsubscribe': {
      if (!client.authenticated) return;
      await lexicon.pushUnsubscribe(msg.endpoint);
      ws.send(JSON.stringify({ type: 'push_unsubscribe_ok', success: true }));
      break;
    }

    case 'text': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      const channelId = sec.toId(msg.channelId) ?? 0;
      const text = typeof msg.text === 'string' ? msg.text : '';
      const replyToId = /^[0-9]+$/.test(String(msg.replyToMessageId)) ? String(msg.replyToMessageId) : null;

      if (!text.trim()) return;
      if (text.length > MAX_TEXT_LENGTH) {
        ws.send(JSON.stringify({ type: 'error', message: `Message is too long (max ${MAX_TEXT_LENGTH} characters)` }));
        return;
      }

      if (!canAccessChannel(channelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        return;
      }

      const channelName = ctx.channels.get(channelId)?.name || '';

      // Native Mumble clients render HTML, so both the name and the text are escaped
      ctx.mumble.sendTextMessage([channelId], `<b>${sec.escapeHtml(client.username)}:</b> ${sec.escapeHtml(text)}`);

      // Store in Lexicon
      let lexiconResult = null;
      try {
        lexiconResult = await lexicon.storeMessage({
          channelId,
          channelName,
          userId: client.userId || 0,
          username: client.username,
          content: text,
          replyToId,
        });
      } catch (err) {
        console.error(`[Lexicon] Message store failed: ${err.message}`);
      }
      const msgId = lexiconResult?.messageId || null;

      ctx.broadcastToChannel(channelId, {
        type: 'text',
        channelId,
        userId: client.userId,
        username: client.username,
        text,
        html: richText.formatRichText(text),
        timestamp: new Date().toISOString(),
        id: msgId,
        replyToId,
      });

      // Process @mentions (async, non-blocking)
      const mentionsFeature = featureRegistry.features?.get('mentions');
      if (mentionsFeature && mentionsFeature.processMentions) {
        mentionsFeature.processMentions({
          text,
          fromUsername: client.username,
          fromUserId: client.userId,
          channelId,
          channelName,
          messageId: msgId,
        }).catch(err => console.error(`[Mentions] Process failed: ${err.message}`));
      }

      // Forward to Lexicon app notifications (async, non-blocking).
      // userId 0 is valid — use ?? so it isn't coerced to null.
      const notificationsFeature = featureRegistry.features?.get('notifications');
      if (notificationsFeature) {
        notificationsFeature.notifyMessage({
          senderName: client.username,
          fromUserId: client.userId ?? null,
          channelId,
          channelName,
          text,
        }).catch(() => {});
      }

      // Relay to Discord if this Mumble channel has a Discord link.
      const discordFeature = featureRegistry.features?.get('discord-sync');
      if (discordFeature && discordFeature.isLinked(channelId)) {
        discordFeature.getAvatarUrlFor(client.username).then((avatarUrl) => {
          discordFeature.relayToDiscord({ mumbleChannelId: channelId, username: client.username, avatarUrl, text });
        }).catch(() => {});
      }
      break;
    }

    case 'image': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      const imgChannelId = sec.toId(msg.channelId) ?? 0;

      if (!canAccessChannel(imgChannelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        return;
      }

      // Everything below is echoed to every viewer, so it is rebuilt from validated values rather than relayed
      const fileId = sec.toId(msg.fileId);
      const mimeType = sec.safeImageType(msg.mimeType);
      if (fileId === null || !mimeType) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid image' }));
        return;
      }
      const fileUrl = sec.safeChatFileUrl(msg.fileUrl) || `/api/chat/files/${fileId}`;
      const thumbnailUrl = sec.safeChatFileUrl(msg.thumbnailUrl); // null when absent or not one of our file URLs
      const originalFilename = sec.safeFilename(msg.originalFilename) || 'image';
      const caption = typeof msg.caption === 'string' ? msg.caption.slice(0, MAX_CAPTION_LENGTH) : '';
      const width = sec.clampInt(msg.width, 0, 20000, null);
      const height = sec.clampInt(msg.height, 0, 20000, null);

      const imgChannelName = ctx.channels.get(imgChannelId)?.name || '';

      // Store in Lexicon
      let imgResult = null;
      try {
        imgResult = await lexicon.storeMessage({
          channelId: imgChannelId,
          channelName: imgChannelName,
          userId: client.userId || 0,
          username: client.username,
          content: caption,
          messageType: mimeType === 'image/gif' ? 'GIF' : 'IMAGE',
          mediaFileId: fileId,
        });
      } catch (err) {
        console.error(`[Lexicon] Image store failed: ${err.message}`);
      }
      const imgMsgId = imgResult?.messageId || null;

      // Broadcast to channel (including sender — ensures everyone has the real Lexicon ID)
      ctx.broadcastToChannel(imgChannelId, {
        type: 'image',
        channelId: imgChannelId,
        userId: client.userId,
        username: client.username,
        fileId,
        fileUrl,
        thumbnailUrl,
        originalFilename,
        mimeType,
        width,
        height,
        caption,
        timestamp: new Date().toISOString(),
        id: imgMsgId,
      });

      // Send text fallback to Mumble (Mumble can't render images); escaped because Mumble renders HTML
      const who = sec.escapeHtml(client.username);
      const linkText = caption
        ? `<b>${who}:</b> ${sec.escapeHtml(caption)} [image: ${sec.escapeHtml(originalFilename)}]`
        : `<b>${who}</b> shared an image: ${sec.escapeHtml(originalFilename)}`;
      ctx.mumble.sendTextMessage([imgChannelId], linkText);
      break;
    }

    case 'get_history': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      const historyChannelId = sec.toId(msg.channelId) ?? 0;
      if (!canAccessChannel(historyChannelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        break;
      }
      const limit = sec.clampInt(msg.limit, 1, 200, 50);
      const messages = await lexicon.getChannelMessages(historyChannelId, limit, sec.toId(msg.before));
      ws.send(JSON.stringify({
        type: 'history',
        channelId: msg.channelId,
        messages: await attachPinInfo(messages),
        _isRefresh: !!msg._isRefresh,
      }));
      break;
    }

    case 'jump_to_message': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      const jumpChannelId = msg.channelId || 0;
      const targetId = msg.messageId;
      if (!targetId) {
        ws.send(JSON.stringify({ type: 'error', message: 'messageId is required' }));
        break;
      }
      if (!canAccessChannel(jumpChannelId, client)) {
        ws.send(JSON.stringify({ type: 'jump_to_message_result', channelId: jumpChannelId, messageId: targetId, found: false, reason: 'no_access' }));
        break;
      }
      const result = await findMessageWindow(lexicon, jumpChannelId, targetId);
      if (!result.found) {
        ws.send(JSON.stringify({ type: 'jump_to_message_result', channelId: jumpChannelId, messageId: targetId, found: false, reason: 'not_found' }));
        break;
      }
      ws.send(JSON.stringify({
        type: 'jump_to_message_result',
        channelId: jumpChannelId,
        messageId: targetId,
        found: true,
        messages: await attachPinInfo(result.messages),
      }));
      break;
    }

    case 'search_messages': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      const query = (typeof msg.query === 'string' ? msg.query : '').trim().slice(0, 200);
      if (!query) {
        ws.send(JSON.stringify({ type: 'search_results', query, results: [] }));
        break;
      }
      const scopedChannelId = msg.channelId != null ? msg.channelId : -1;
      if (scopedChannelId !== -1 && !canAccessChannel(scopedChannelId, client)) {
        ws.send(JSON.stringify({ type: 'search_results', query, results: [] }));
        break;
      }
      let raw = [];
      try {
        raw = await lexicon.searchMessages(query, scopedChannelId);
      } catch (err) {
        console.error(`[Search] Lexicon search failed: ${err.message}`);
      }
      raw = Array.isArray(raw) ? raw.slice(0, 200) : [];
      const results = raw
        .filter((m) => canAccessChannel(m.channelId != null ? m.channelId : 0, client))
        .slice(0, 50);
      ws.send(JSON.stringify({ type: 'search_results', query, results }));
      break;
    }

    case 'join_channel': {
      const joinId = sec.toId(msg.channelId);
      if (joinId === null) break;
      if (!canAccessChannel(joinId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        break;
      }
      client.channelId = joinId;
      ws.send(JSON.stringify({ type: 'joined_channel', channelId: joinId }));
      break;
    }

    case 'create_channel': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      if (!client.isAdmin) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only superusers can create channels' }));
        break;
      }
      const channelName = (msg.name || '').trim();
      if (!channelName || channelName.length > 50) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel name' }));
        break;
      }
      try {
        // Insert directly into Mumble's MySQL DB (Mumble API rejects due to MissingCertificate)
        const mumbleDb = getMumblePool();
        const [maxRow] = await mumbleDb.execute('SELECT MAX(channel_id) AS maxId FROM channels WHERE server_id = 1');
        const newId = (maxRow[0].maxId || 0) + 1;
        const parentId = sec.toId(msg.parentId) ?? 0;
        await mumbleDb.execute(
          'INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl) VALUES (1, ?, ?, ?, 1)',
          [newId, parentId, channelName]
        );
        console.log(`[WS] Channel "${channelName}" (id=${newId}) created by ${client.username} via DB`);
        // Broadcast the new channel to all clients
        const newCh = { id: newId, name: channelName, parentId };
        ctx.channels.set(newId, newCh);
        ctx.broadcastChannelUpdate(newCh);
        ws.send(JSON.stringify({ type: 'channel_created', channel: newCh }));
      } catch (err) {
        console.error(`[WS] Channel create error:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create channel: ' + err.message }));
      }
      break;
    }

    case 'remove_channel': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      if (!client.isAdmin) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only superusers can delete channels' }));
        break;
      }
      const removeId = sec.toId(msg.channelId);
      if (removeId === null) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }));
        break;
      }
      if (removeId === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Cannot remove the root channel' }));
        break;
      }
      try {
        // Delete from Mumble's MySQL DB (also delete children)
        const mumbleDb = getMumblePool();
        await mumbleDb.execute('DELETE FROM channels WHERE server_id = 1 AND parent_id = ?', [removeId]);
        await mumbleDb.execute('DELETE FROM channels WHERE server_id = 1 AND channel_id = ?', [removeId]);
        console.log(`[WS] Channel ${removeId} deleted by ${client.username} via DB`);
        // Remove from in-memory state and broadcast
        ctx.channels.delete(removeId);
        const accessFeature = featureRegistry.features?.get('channel-access');
        if (accessFeature) await accessFeature.clearChannelAccess(removeId);
        const pinFeature = featureRegistry.features?.get('pinned-messages');
        if (pinFeature) await pinFeature.deleteChannel(removeId).catch(() => {});
        ctx.broadcastChannelRemove(removeId);
      } catch (err) {
        console.error(`[WS] Channel remove error:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to remove channel: ' + err.message }));
      }
      break;
    }

    case 'command': {
      // Handled by bot engine via event emission on ws-server
      break;
    }

    case 'media_search': {
      const results = await lexicon.searchMedia(typeof msg.query === 'string' ? msg.query.slice(0, 200) : '');
      ws.send(JSON.stringify({ type: 'media_results', results }));
      break;
    }

    case 'now_playing': {
      const state = await lexicon.getLivestreamState();
      ws.send(JSON.stringify({ type: 'now_playing', state }));
      break;
    }

    case 'music_queue': {
      const queue = await lexicon.getLivestreamQueue();
      ws.send(JSON.stringify({ type: 'music_queue', queue }));
      break;
    }

    case 'music_queue_add': {
      const mediaFileId = sec.toId(msg.mediaFileId);
      if (client.userId && mediaFileId !== null) {
        const result = await lexicon.queueToLivestream(client.userId, mediaFileId);
        ws.send(JSON.stringify({ type: 'music_queued', result }));
      }
      break;
    }

    case 'music_skip': {
      if (client.userId) {
        const result = await lexicon.skipLivestream(client.userId);
        ws.send(JSON.stringify({ type: 'music_skipped', result }));
      }
      break;
    }

    case 'voice_start': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      // Joining voice in a channel needs the same access as reading its text
      const parsedVoiceCh = msg.voiceChannelId == null ? null : sec.toId(msg.voiceChannelId);
      const requestedVoiceCh = parsedVoiceCh || null; // 0 / absent means "no particular channel", as before
      if (msg.voiceChannelId != null && parsedVoiceCh === null) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }));
        break;
      }
      if (requestedVoiceCh !== null && !canAccessChannel(requestedVoiceCh, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        break;
      }
      try {
        const peerId = client.username + '_' + client.userId;
        if (client.voicePeerId) {
          ctx.voiceBridge.stopSession(client.voicePeerId);
        }
        client.voicePeerId = peerId;
        await ctx.voiceBridge.startSession(peerId, client.username, ws);

        // Move to the requested voice channel if specified
        const voiceChId = requestedVoiceCh;
        if (voiceChId !== null) {
          ctx.voiceBridge.moveToChannel(peerId, voiceChId);
        }

        ws.send(JSON.stringify({ type: 'voice_ready' }));
        console.log(`[Voice] Session started for ${client.username}`);
        if (client.webClientId && ctx.webClients.has(client.webClientId)) {
          const wc = ctx.webClients.get(client.webClientId);
          wc.inVoice = true;
          wc.voiceChannelId = voiceChId;
          ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: true, voiceChannelId: voiceChId });
        }

        // Forward to Lexicon app notifications (async, non-blocking).
        // userId 0 is valid — use ?? so it isn't coerced to null.
        const notifFeature = featureRegistry.features?.get('notifications');
        if (notifFeature) {
          notifFeature.notifyVoiceJoin({
            name: client.username,
            fromUserId: client.userId ?? null,
            channelId: voiceChId || 0,
            channelName: ctx.channels.get(voiceChId)?.name,
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[Voice] Start error for ${client.username}:`, err.message);
        client.voicePeerId = null;
        ws.send(JSON.stringify({ type: 'error', message: 'Voice connection failed: ' + err.message }));
      }
      break;
    }

    case 'voice_join_channel': {
      if (!client.authenticated || !client.voicePeerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in voice' }));
        break;
      }
      if (msg.channelId === undefined || msg.channelId === null) break;
      const targetChId = sec.toId(msg.channelId);
      if (targetChId === null) break;
      if (!canAccessChannel(targetChId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        break;
      }
      ctx.voiceBridge.moveToChannel(client.voicePeerId, targetChId);
      if (client.webClientId && ctx.webClients.has(client.webClientId)) {
        ctx.webClients.get(client.webClientId).voiceChannelId = targetChId;
        ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: true, voiceChannelId: targetChId });
      }
      break;
    }

    case 'avatar_changed': {
      // The client only says "my avatar changed"; the URL always comes from our own record, never from the message
      let avatarUrl = sec.DEFAULT_AVATAR;
      try { avatarUrl = sec.safeAvatarUrl(await getAvatarPath(client.username)); } catch (_) {}
      if (client.webClientId && ctx.webClients.has(client.webClientId)) {
        ctx.webClients.get(client.webClientId).avatarUrl = avatarUrl;
      }
      ctx.broadcastAll({
        type: 'avatar_updated',
        username: client.username,
        avatarUrl,
      });
      break;
    }

    case 'voice_stop': {
      if (client.voicePeerId) {
        ctx.voiceBridge.stopSession(client.voicePeerId);
        console.log(`[Voice] Session stopped for ${client.username}`);
        client.voicePeerId = null;
      }
      if (client.webClientId && ctx.webClients.has(client.webClientId)) {
        const wc = ctx.webClients.get(client.webClientId);
        wc.inVoice = false;
        wc.voiceChannelId = null;
        ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: false, voiceChannelId: null });
      }
      ws.send(JSON.stringify({ type: 'voice_stopped' }));
      break;
    }

    default:
      // Try feature registry before returning error
      if (!featureRegistry.route(ws, client, msg)) {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
  }
}

module.exports = { handleClientMessage, isAdminFor };
