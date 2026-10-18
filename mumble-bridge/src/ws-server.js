/**
 * WebSocket server — orchestrates HTTP, WebSocket, Mumble relay, and client handling.
 * Delegates to: http-server.js, mumble-relay.js, client-handler.js
 */
const path = require('path');
const WebSocket = require('ws');
const config = require('./config');
const VoiceBridge = require('./voice-bridge');
const { createHttpServer } = require('./http-server');
const { setupMumbleListeners } = require('./mumble-relay');
const { handleClientMessage } = require('./client-handler');
const featureRegistry = require('./feature-registry');

class BridgeWebSocketServer {
  /**
   * @param {MumbleConnection} mumbleConn - Active Mumble connection
   */
  constructor(mumbleConn) {
    this.mumble = mumbleConn;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map();     // ws -> clientInfo
    this.webClients = new Map();  // peerId -> { username, channelId, inVoice, ws }

    // Mumble state (kept in sync via events)
    this.channels = new Map();
    this.users = new Map();
    this.ownSession = null;

    this.publicDir = path.join(__dirname, '..', 'public');
    this.voiceBridge = new VoiceBridge();
  }

  async start() {
    await this.voiceBridge.init();

    this.httpServer = createHttpServer(this.publicDir);

    this.wss = new WebSocket.Server({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => {
      console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
      this._handleNewClient(ws);
    });

    // Shared state object for mumble-relay
    const state = {
      channels: this.channels,
      users: this.users,
    };
    // Keep ownSession in sync (it gets set asynchronously)
    Object.defineProperty(state, 'ownSession', {
      get: () => this.ownSession,
      set: (v) => { this.ownSession = v; },
    });

    setupMumbleListeners(
      this.mumble,
      state,
      (msg) => this._broadcastAll(msg),
      (chId, msg, excludeWs) => this._broadcastToChannel(chId, msg, excludeWs),
      (channel) => this.broadcastChannelUpdate(channel),
      (channelId) => this.broadcastChannelRemove(channelId),
    );

    return new Promise((resolve) => {
      this.httpServer.listen(config.ws.port, () => {
        console.log(`[WS] WebSocket server listening on port ${config.ws.port}`);
        console.log(`[HTTP] Web UI available at http://localhost:${config.ws.port}`);
        resolve();
      });
    });
  }

  _handleNewClient(ws) {
    const clientInfo = { userId: null, username: null, channelId: null, authenticated: false };
    this.clients.set(ws, clientInfo);

    // Context object passed to client-handler
    const ctx = {
      mumble: this.mumble,
      channels: this.channels,
      voiceBridge: this.voiceBridge,
      clients: this.clients,
      webClients: this.webClients,
      broadcastAll: (msg) => this._broadcastAll(msg),
      broadcastToChannel: (chId, msg, excludeWs) => this._broadcastToChannel(chId, msg, excludeWs),
      broadcastChannelUpdate: (channel) => this.broadcastChannelUpdate(channel),
      broadcastChannelRemove: (channelId) => this.broadcastChannelRemove(channelId),
      sendPostAuthChannelTopUp: (cws, cclient) => this.sendPostAuthChannelTopUp(cws, cclient),
    };

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (clientInfo.voicePeerId) {
            this.voiceBridge.handleAudioFromBrowser(clientInfo.voicePeerId, buf);
          }
        } catch (err) {
          console.error('[WS] Audio processing error:', err.message);
        }
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());

        // 'command' type needs special handling — routed directly into the bot engine.
        if (msg.type === 'command' && clientInfo.authenticated) {
          if (this.botEngine) {
            const argsSuffix = (msg.args && msg.args.length) ? ' ' + msg.args.join(' ') : '';
            const raw = `${config.botPrefix}${msg.command}${argsSuffix}`;
            const chId = clientInfo.channelId || 0;
            // senderChannelId must be the user's actual VOICE channel (not their text-view
            // channel) — music should follow "whichever voice channel you're in," and a web
            // user only has a Mumble voice connection at all once they've started voice.
            const webClient = clientInfo.webClientId ? this.webClients.get(clientInfo.webClientId) : null;
            const senderChannelId = webClient && webClient.inVoice ? webClient.voiceChannelId : null;
            this.botEngine._handleCommand(raw, clientInfo.username, clientInfo.userId, chId, senderChannelId);
          }
          return;
        }

        handleClientMessage(ws, msg, clientInfo, ctx).catch(err => {
          console.error('[WS] Message handler error:', err.message);
          try { ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' })); } catch (_) {}
        });
      } catch (err) {
        console.error('[WS] Bad JSON from client:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected: ${clientInfo.username || 'unknown'}`);
      if (clientInfo.voicePeerId) {
        this.voiceBridge.stopSession(clientInfo.voicePeerId);
      }
      // The presence map is keyed by user, not by socket, so a reconnecting client
      // overwrites its own entry. If this close handler runs after that (a dropped
      // socket plus a fast reconnect is enough), an unguarded delete removes the
      // *live* entry and tells everyone the user left while they are still here.
      // Only tear down presence when the entry still belongs to this socket.
      if (clientInfo.webClientId) {
        const entry = this.webClients.get(clientInfo.webClientId);
        if (entry && entry.ws === ws) {
          this.webClients.delete(clientInfo.webClientId);
          this._broadcastAll({
            type: 'web_user_leave',
            id: clientInfo.webClientId,
            username: clientInfo.username,
          });
        } else {
          console.log(`[WS] Stale close for ${clientInfo.webClientId}; presence kept`);
        }
      }
      this.clients.delete(ws);
    });

    const accessFeature = featureRegistry.features?.get('channel-access');
    const visibleChannels = accessFeature
      ? accessFeature.filterVisibleChannels(Array.from(this.channels.values()), null, false)
      : Array.from(this.channels.values());
    ws.send(JSON.stringify({
      type: 'server_state',
      channels: visibleChannels,
      users: Array.from(this.users.values()),
    }));
  }

  /** Send this specific client the restricted channels it can see but wasn't sent pre-auth. */
  sendPostAuthChannelTopUp(ws, client) {
    const accessFeature = featureRegistry.features?.get('channel-access');
    if (!accessFeature) return;
    const extra = Array.from(this.channels.values())
      .filter((ch) => accessFeature.isRestricted(ch.id) && accessFeature.canAccess(ch.id, client.userId, client.isAdmin));
    if (extra.length > 0) {
      ws.send(JSON.stringify({ type: 'server_state', channels: extra, users: [] }));
    }
  }

  _broadcastAll(msg) {
    const data = JSON.stringify(msg);
    for (const [ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  _broadcastToChannel(channelId, msg, excludeWs = null) {
    const accessFeature = featureRegistry.features?.get('channel-access');
    const restricted = accessFeature ? accessFeature.isRestricted(channelId) : false;
    const data = JSON.stringify(msg);
    for (const [ws, info] of this.clients) {
      if (ws === excludeWs || ws.readyState !== WebSocket.OPEN) continue;
      if (restricted) {
        if (info.channelId !== channelId) continue; // no null-passthrough for restricted channels
        if (!accessFeature.canAccess(channelId, info.userId, info.isAdmin)) continue;
        ws.send(data);
      } else if (info.channelId === channelId || info.channelId === null) {
        ws.send(data);
      }
    }
  }

  /** channel_update/channel_remove for a specific channel, filtered to clients who can see it. */
  broadcastChannelUpdate(channel) {
    this._broadcastChannelScoped(channel.id, { type: 'channel_update', channel });
  }

  broadcastChannelRemove(channelId) {
    this._broadcastChannelScoped(channelId, { type: 'channel_remove', channelId });
  }

  _broadcastChannelScoped(channelId, msg) {
    const accessFeature = featureRegistry.features?.get('channel-access');
    if (!accessFeature || !accessFeature.isRestricted(channelId)) {
      this._broadcastAll(msg);
      return;
    }
    const data = JSON.stringify(msg);
    for (const [ws, info] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && accessFeature.canAccess(channelId, info.userId, info.isAdmin)) {
        ws.send(data);
      }
    }
  }
}

module.exports = BridgeWebSocketServer;
