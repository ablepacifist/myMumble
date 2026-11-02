/**
 * WebSocket server — orchestrates HTTP, WebSocket, Mumble relay, and client handling.
 * Delegates to: http-server.js, mumble-relay.js, client-handler.js
 */
const path = require('path');
const WebSocket = require('ws');
const config = require('./config');
const sec = require('./security');
const { createSessionPersistence } = require('./database');
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

    // Login sessions: opaque tokens issued after a verified sign-in, kept in the bridge database so a restart
    // does not sign everyone out.
    this.sessions = new sec.SessionStore({
      ttlMs: config.security.sessionTtlHours * 60 * 60 * 1000,
      persistence: createSessionPersistence(),
    });
    this.maxConnectionsPerAddress = 40;
  }

  async start() {
    await this.voiceBridge.init();

    this.httpServer = createHttpServer(this.publicDir, { sessions: this.sessions });

    this.wss = new WebSocket.Server({
      server: this.httpServer,
      // Chat is small JSON and voice frames are tiny; refuse anything big instead of buffering it
      maxPayload: config.security.wsMaxPayloadBytes,
      // Only this site, the known apps and non-browser clients may open a socket (blocks other websites)
      verifyClient: (info, done) => {
        if (sec.originAllowed(info.origin, info.req.headers.host)) return done(true);
        console.log(`[WS] Rejected connection from origin ${String(info.origin).slice(0, 100)}`);
        return done(false, 403, 'Origin not allowed');
      },
    });
    this.wss.on('connection', (ws, req) => {
      const ip = sec.clientIp(req);
      let open = 0;
      for (const info of this.clients.values()) if (info.ip === ip) open++;
      if (open >= this.maxConnectionsPerAddress) {
        console.log(`[WS] Too many connections from ${ip}; closing`);
        ws.close(1013, 'Too many connections');
        return;
      }
      console.log(`[WS] New connection from ${ip}`);
      this._handleNewClient(ws, ip);
    });
    this.sweeper = setInterval(() => {
      this.sessions.sweep();
      const purge = this.sessions.persistence && this.sessions.persistence.purge;
      if (purge) purge(Date.now()).catch(() => {});
    }, 60 * 60 * 1000);
    if (this.sweeper.unref) this.sweeper.unref();

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

  _handleNewClient(ws, ip = 'unknown') {
    const clientInfo = { userId: null, username: null, channelId: null, authenticated: false, ip };
    this.clients.set(ws, clientInfo);
    // Chat/control messages only; audio frames are binary and not counted
    const messageLimiter = new sec.RateLimiter(150, 10000);
    let violations = 0;

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
      // Nothing is sent before sign-in; after it, the client gets the channels and users it may see
      sendPostAuthChannelTopUp: (cws, cclient) => this.sendServerState(cws, cclient),
      sessions: this.sessions,
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
      const limit = messageLimiter.take('m');
      if (!limit.ok) {
        violations++;
        if (violations === 1) ws.send(JSON.stringify({ type: 'error', message: 'You are sending messages too quickly' }));
        if (violations > 50) ws.close(1008, 'Rate limit exceeded');
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());

        // 'command' type needs special handling — routed directly into the bot engine.
        if (msg && msg.type === 'command' && clientInfo.authenticated) {
          if (this.botEngine && typeof msg.command === 'string' && msg.command.length <= 64
              && (msg.args === undefined || (Array.isArray(msg.args) && msg.args.length <= 20 && msg.args.every((a) => typeof a === 'string' && a.length <= 500)))) {
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

    // A bad frame (too big, malformed, or a dropped connection) is reported on the socket; without a handler
    // that would surface as an uncaught exception, which one client must never be able to cause.
    ws.on('error', (err) => {
      console.log(`[WS] Socket error from ${clientInfo.username || ip}: ${err.message}`);
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

    // The sign-in screen needs nothing from the server, so the channel and user lists wait until the client is signed in.
  }

  /** Send a signed-in client the channels it may see (restricted ones only if it has access) and the Mumble users. */
  sendServerState(ws, client) {
    const accessFeature = featureRegistry.features?.get('channel-access');
    const all = Array.from(this.channels.values());
    const visibleChannels = accessFeature
      ? accessFeature.filterVisibleChannels(all, client.userId, client.isAdmin)
      : all;
    ws.send(JSON.stringify({
      type: 'server_state',
      channels: visibleChannels,
      users: Array.from(this.users.values()),
    }));
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
