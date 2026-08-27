/**
 * Client message handler — processes incoming WebSocket messages from web clients.
 */
const { getBridgePool, getMumblePool, getAvatarPath } = require('./database');
const lexicon = require('./lexicon-client');
const config = require('./config');
const featureRegistry = require('./feature-registry');
const richText = require('./features/rich-text');
const { findMessageWindow } = require('./message-window');

function isSuperUser(username) {
  return config.superUsers.includes((username || '').toLowerCase());
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

/**
 * Handle a message from a web client.
 * @param {WebSocket} ws - The WebSocket connection
 * @param {object} msg - The parsed JSON message
 * @param {object} client - The client info object
 * @param {object} ctx - Server context { mumble, channels, voiceBridge, clients, webClients, broadcastAll, broadcastToChannel }
 */
async function handleClientMessage(ws, msg, client, ctx) {
  switch (msg.type) {
    case 'auth': {
      if (!msg.username) {
        ws.send(JSON.stringify({ type: 'error', message: 'Username is required' }));
        break;
      }

      const username = msg.username.trim();
      console.log(`[WS] Auth request from: ${username}`);

      const player = await lexicon.getOrCreateUser(username);
      client.username = player.displayName || player.username || username;
      client.userId = player.id;
      client.authenticated = true;

      if (player.id) {
        try {
          const pool = getBridgePool();
          await pool.execute(
            `INSERT INTO user_mapping (lexicon_user_id, lexicon_username, display_name)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE lexicon_user_id = VALUES(lexicon_user_id), display_name = VALUES(display_name), last_seen = NOW()`,
            [player.id, username, client.username]
          );
        } catch (err) {
          console.log(`[WS] User mapping update failed: ${err.message}`);
        }
      }

      client.isAdmin = isSuperUser(client.username);

      ws.send(JSON.stringify({
        type: 'auth_ok',
        username: client.username,
        userId: client.userId,
        isAdmin: client.isAdmin,
      }));

      // Look up avatar
      let avatarUrl = '/uploads/avatars/default.jpg';
      try {
        const ap = await getAvatarPath(client.username);
        if (ap) avatarUrl = ap;
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

    case 'sso_auth': {
      if (!msg.token) {
        ws.send(JSON.stringify({ type: 'error', message: 'SSO token is required' }));
        break;
      }

      console.log(`[WS] SSO auth request`);
      const ssoResult = await lexicon.validateSsoToken(msg.token);

      if (!ssoResult || !ssoResult.valid) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid or expired SSO token' }));
        break;
      }

      // SSO validated — log user in
      const ssoUsername = ssoResult.username;
      const ssoPlayer = await lexicon.getOrCreateUser(ssoUsername);
      client.username = ssoPlayer.displayName || ssoPlayer.username || ssoUsername;
      client.userId = ssoResult.userId || ssoPlayer.id;
      client.authenticated = true;

      if (client.userId) {
        try {
          const pool = getBridgePool();
          await pool.execute(
            `INSERT INTO user_mapping (lexicon_user_id, lexicon_username, display_name)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE lexicon_user_id = VALUES(lexicon_user_id), display_name = VALUES(display_name), last_seen = NOW()`,
            [client.userId, ssoUsername, client.username]
          );
        } catch (err) {
          console.log(`[WS] User mapping update failed: ${err.message}`);
        }
      }

      client.isAdmin = isSuperUser(client.username);

      ws.send(JSON.stringify({
        type: 'auth_ok',
        username: client.username,
        userId: client.userId,
        isAdmin: client.isAdmin,
        sso: true,
      }));

      // Avatar
      let ssoAvatarUrl = '/uploads/avatars/default.jpg';
      try {
        const ap = await getAvatarPath(client.username);
        if (ap) ssoAvatarUrl = ap;
      } catch (_) {}

      const ssoWebClientId = `web_${client.userId}`;
      client.webClientId = ssoWebClientId;
      ctx.webClients.set(ssoWebClientId, {
        username: client.username,
        userId: client.userId,
        channelId: client.channelId || 0,
        inVoice: false,
        voiceChannelId: null,
        avatarUrl: ssoAvatarUrl,
        ws,
      });
      ctx.broadcastAll({
        type: 'web_user_join',
        webClient: { id: ssoWebClientId, username: client.username, channelId: client.channelId || 0, inVoice: false, avatarUrl: ssoAvatarUrl },
      });
      const ssoWebClientList = [];
      for (const [id, wc] of ctx.webClients) {
        ssoWebClientList.push({ id, username: wc.username, channelId: wc.channelId, inVoice: wc.inVoice, voiceChannelId: wc.voiceChannelId, avatarUrl: wc.avatarUrl });
      }
      ws.send(JSON.stringify({ type: 'web_users', webClients: ssoWebClientList }));
      ctx.sendPostAuthChannelTopUp(ws, client);

      // Send unread DM counts
      try {
        const dmsFeature = featureRegistry.features?.get('dms');
        if (dmsFeature && client.userId) {
          const unreads = await dmsFeature.getUnreadCounts(client.userId);
          if (unreads.length > 0) {
            ws.send(JSON.stringify({ type: 'dm_unread_counts', unreads }));
          }
        }
      } catch (_) {}

      console.log(`[WS] SSO login successful: ${client.username} (ID: ${client.userId})`);
      break;
    }

    case 'text': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      const channelId = msg.channelId || 0;
      const text = msg.text;
      const replyToId = /^[0-9]+$/.test(String(msg.replyToMessageId)) ? String(msg.replyToMessageId) : null;

      if (!canAccessChannel(channelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        return;
      }

      const channelName = ctx.channels.get(channelId)?.name || '';

      ctx.mumble.sendTextMessage([channelId], `<b>${client.username}:</b> ${text}`);

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

      const imgChannelId = msg.channelId || 0;

      if (!canAccessChannel(imgChannelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        return;
      }

      const imgChannelName = ctx.channels.get(imgChannelId)?.name || '';

      // Store in Lexicon
      let imgResult = null;
      try {
        imgResult = await lexicon.storeMessage({
          channelId: imgChannelId,
          channelName: imgChannelName,
          userId: client.userId || 0,
          username: client.username,
          content: msg.caption || '',
          messageType: msg.isGif ? 'GIF' : 'IMAGE',
          mediaFileId: msg.fileId,
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
        fileId: msg.fileId,
        fileUrl: msg.fileUrl,
        thumbnailUrl: msg.thumbnailUrl,
        originalFilename: msg.originalFilename,
        mimeType: msg.mimeType,
        width: msg.width,
        height: msg.height,
        caption: msg.caption || '',
        timestamp: new Date().toISOString(),
        id: imgMsgId,
      });

      // Send text fallback to Mumble (Mumble can't render images)
      const linkText = msg.caption
        ? `<b>${client.username}:</b> ${msg.caption} [image: ${msg.originalFilename}]`
        : `<b>${client.username}</b> shared an image: ${msg.originalFilename}`;
      ctx.mumble.sendTextMessage([imgChannelId], linkText);
      break;
    }

    case 'get_history': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      const historyChannelId = msg.channelId || 0;
      if (!canAccessChannel(historyChannelId, client)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
        break;
      }
      const limit = msg.limit || 50;
      const messages = await lexicon.getChannelMessages(historyChannelId, limit, msg.before || null);
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
      const query = (msg.query || '').trim();
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
      if (client.authenticated) {
        if (!canAccessChannel(msg.channelId, client)) {
          ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
          break;
        }
        client.channelId = msg.channelId;
        ws.send(JSON.stringify({ type: 'joined_channel', channelId: msg.channelId }));
      }
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
        const parentId = msg.parentId || 0;
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
      const removeId = msg.channelId;
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
      const results = await lexicon.searchMedia(msg.query);
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
      if (client.userId && msg.mediaFileId) {
        const result = await lexicon.queueToLivestream(client.userId, msg.mediaFileId);
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
      try {
        const peerId = client.username + '_' + client.userId;
        if (client.voicePeerId) {
          ctx.voiceBridge.stopSession(client.voicePeerId);
        }
        client.voicePeerId = peerId;
        await ctx.voiceBridge.startSession(peerId, client.username, ws);

        // Move to the requested voice channel if specified
        const voiceChId = msg.voiceChannelId || null;
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
      const targetChId = msg.channelId;
      if (targetChId === undefined || targetChId === null) break;
      ctx.voiceBridge.moveToChannel(client.voicePeerId, targetChId);
      if (client.webClientId && ctx.webClients.has(client.webClientId)) {
        ctx.webClients.get(client.webClientId).voiceChannelId = targetChId;
        ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: true, voiceChannelId: targetChId });
      }
      break;
    }

    case 'avatar_changed': {
      if (!client.authenticated) break;
      const avatarUrl = msg.avatarUrl || '/uploads/avatars/default.jpg';
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

module.exports = { handleClientMessage };
