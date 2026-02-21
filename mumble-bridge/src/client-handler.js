/**
 * Client message handler — processes incoming WebSocket messages from web clients.
 */
const { getBridgePool } = require('./database');
const lexicon = require('./lexicon-client');

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

      ws.send(JSON.stringify({
        type: 'auth_ok',
        username: client.username,
        userId: client.userId,
      }));

      const webClientId = `web_${client.userId}`;
      client.webClientId = webClientId;
      ctx.webClients.set(webClientId, {
        username: client.username,
        userId: client.userId,
        channelId: client.channelId || 0,
        inVoice: false,
        ws,
      });
      ctx.broadcastAll({
        type: 'web_user_join',
        webClient: { id: webClientId, username: client.username, channelId: client.channelId || 0, inVoice: false },
      });
      const webClientList = [];
      for (const [id, wc] of ctx.webClients) {
        webClientList.push({ id, username: wc.username, channelId: wc.channelId, inVoice: wc.inVoice });
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
      const channelName = (msg.name || '').trim();
      if (!channelName || channelName.length > 50) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel name' }));
        break;
      }
      try {
        // Create channel on Mumble server (parent 0 = root)
        ctx.mumble.sendMessage('ChannelState', {
          parent: msg.parentId || 0,
          name: channelName,
        });
        console.log(`[WS] Channel "${channelName}" creation requested by ${client.username}`);
      } catch (err) {
        console.error(`[WS] Channel create error:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to create channel' }));
      }
      break;
    }

    case 'remove_channel': {
      if (!client.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        break;
      }
      const removeId = msg.channelId;
      if (removeId === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Cannot remove the root channel' }));
        break;
      }
      try {
        ctx.mumble.sendMessage('ChannelRemove', { channelId: removeId });
        console.log(`[WS] Channel ${removeId} removal requested by ${client.username}`);
      } catch (err) {
        console.error(`[WS] Channel remove error:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to remove channel' }));
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
        ws.send(JSON.stringify({ type: 'voice_ready' }));
        console.log(`[Voice] Session started for ${client.username}`);
        if (client.webClientId && ctx.webClients.has(client.webClientId)) {
          ctx.webClients.get(client.webClientId).inVoice = true;
          ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: true });
        }
      } catch (err) {
        console.error(`[Voice] Start error for ${client.username}:`, err.message);
        client.voicePeerId = null;
        ws.send(JSON.stringify({ type: 'error', message: 'Voice connection failed: ' + err.message }));
      }
      break;
    }

    case 'voice_stop': {
      if (client.voicePeerId) {
        ctx.voiceBridge.stopSession(client.voicePeerId);
        console.log(`[Voice] Session stopped for ${client.username}`);
        client.voicePeerId = null;
      }
      if (client.webClientId && ctx.webClients.has(client.webClientId)) {
        ctx.webClients.get(client.webClientId).inVoice = false;
        ctx.broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: false });
      }
      ws.send(JSON.stringify({ type: 'voice_stopped' }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

module.exports = { handleClientMessage };
