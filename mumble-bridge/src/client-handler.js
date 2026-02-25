/**
 * Client message handler — processes incoming WebSocket messages from web clients.
 */
const { getBridgePool, getMumblePool, getAvatarPath } = require('./database');
const lexicon = require('./lexicon-client');
const config = require('./config');

function isSuperUser(username) {
  return config.superUsers.includes((username || '').toLowerCase());
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
             ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), last_seen = NOW()`,
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
      break;
    }

    case 'text': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      const channelId = msg.channelId || 0;
      const text = msg.text;
      const channelName = ctx.channels.get(channelId)?.name || '';

      ctx.mumble.sendTextMessage([channelId], `<b>${client.username}:</b> ${text}`);

      lexicon.storeMessage({
        channelId,
        channelName,
        userId: client.userId || 0,
        username: client.username,
        content: text,
      }).catch(err => console.error(`[WS] Lexicon message store failed: ${err.message}`));

      ctx.broadcastToChannel(channelId, {
        type: 'text',
        channelId,
        userId: client.userId,
        username: client.username,
        text,
        timestamp: new Date().toISOString(),
      }, ws);
      break;
    }

    case 'get_history': {
      const limit = msg.limit || 50;
      const messages = await lexicon.getChannelMessages(msg.channelId || 0, limit, msg.before || null);
      ws.send(JSON.stringify({
        type: 'history',
        channelId: msg.channelId,
        messages,
        _isRefresh: !!msg._isRefresh,
      }));
      break;
    }

    case 'join_channel': {
      if (client.authenticated) {
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
        ctx.broadcastAll({ type: 'channel_update', channel: newCh });
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
        ctx.broadcastAll({ type: 'channel_remove', channelId: removeId });
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
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

module.exports = { handleClientMessage };
