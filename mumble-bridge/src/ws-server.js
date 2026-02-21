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

    // Speaking detection timers per web client
    this._speakingTimers = new Map();
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
    };

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (clientInfo.voicePeerId) {
            this.voiceBridge.handleAudioFromBrowser(clientInfo.voicePeerId, buf);
            // Speaking indicator — broadcast that this user is speaking
            this._handleSpeaking(clientInfo);
          }
        } catch (err) {
          console.error('[WS] Audio processing error:', err.message);
        }
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());

        // 'command' type needs special handling (emitted as event for bot engine)
        if (msg.type === 'command' && clientInfo.authenticated) {
          this.emit && this.emit('bot_command', {
            command: msg.command,
            args: msg.args || [],
            userId: clientInfo.userId,
            username: clientInfo.username,
            channelId: clientInfo.channelId || msg.channelId || 0,
            ws,
          });
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
      if (clientInfo.webClientId) {
        this.webClients.delete(clientInfo.webClientId);
        this._broadcastAll({
          type: 'web_user_leave',
          id: clientInfo.webClientId,
          username: clientInfo.username,
        });
      }
      this.clients.delete(ws);
    });

    ws.send(JSON.stringify({
      type: 'server_state',
      channels: Array.from(this.channels.values()),
      users: Array.from(this.users.values()),
    }));
  }

  /**
   * Detect speaking from audio energy and broadcast voice_speaking events.
   * Since client-side VAD already filters silence, any binary frame = speaking.
   */
  _handleSpeaking(clientInfo) {
    if (!clientInfo.webClientId) return;
    const id = clientInfo.webClientId;

    if (this._speakingTimers.has(id)) {
      clearTimeout(this._speakingTimers.get(id));
    } else {
      // First frame — broadcast speaking=true
      this._broadcastAll({ type: 'voice_speaking', id, speaking: true });
    }

    // After 300ms of no audio, broadcast speaking=false
    this._speakingTimers.set(id, setTimeout(() => {
      this._speakingTimers.delete(id);
      this._broadcastAll({ type: 'voice_speaking', id, speaking: false });
    }, 300));
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
    const data = JSON.stringify(msg);
    for (const [ws, info] of this.clients) {
      if (ws === excludeWs) continue;
      if (ws.readyState === WebSocket.OPEN && (info.channelId === channelId || info.channelId === null)) {
        ws.send(data);
      }
    }
  }
}

module.exports = BridgeWebSocketServer;
