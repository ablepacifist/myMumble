const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const config = require('./config');
const { getBridgePool } = require('./database');
const lexicon = require('./lexicon-client');
const VoiceBridge = require('./voice-bridge');

/** MIME types for static file serving */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Build version stamp for cache busting (changes on each restart) */
const BUILD_VERSION = Date.now().toString(36);

/**
 * WebSocket server that web clients connect to.
 * Also serves the static web frontend over HTTP on the same port.
 */
class BridgeWebSocketServer {
  /**
   * @param {MumbleConnection} mumbleConn - Active Mumble connection
   */
  constructor(mumbleConn) {
    this.mumble = mumbleConn;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map(); // ws -> { userId, username, channelId }
    this.webClients = new Map(); // peerId -> { username, channelId, inVoice, ws }

    // Mumble state (kept in sync via events)
    this.channels = new Map(); // channelId -> { name, description, parent, ... }
    this.users = new Map(); // session -> { name, channelId, ... }
    this.ownSession = null;

    this.publicDir = path.join(__dirname, '..', 'public');

    // Voice bridge (per-user Mumble connections, no WebRTC)
    this.voiceBridge = new VoiceBridge();
  }

  /**
   * Start the HTTP + WebSocket server.
   */
  async start() {
    // Initialize voice bridge (loads protobuf definitions)
    await this.voiceBridge.init();

    // Create HTTP server that serves static files
    this.httpServer = http.createServer((req, res) => {
      this._handleHttpRequest(req, res);
    });

    // Attach WebSocket server to the HTTP server (same port)
    this.wss = new WebSocket.Server({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
      this._handleNewClient(ws);
    });

    // Listen to Mumble events and relay to web clients
    this._setupMumbleListeners();

    return new Promise((resolve) => {
      this.httpServer.listen(config.ws.port, () => {
        console.log(`[WS] WebSocket server listening on port ${config.ws.port}`);
        console.log(`[HTTP] Web UI available at http://localhost:${config.ws.port}`);
        resolve();
      });
    });
  }

  /**
   * Serve static files from the public/ directory.
   */
  _handleHttpRequest(req, res) {
    // Only handle GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    // Parse URL and resolve file path
    let urlPath = req.url.split('?')[0]; // strip query string
    if (urlPath === '/') urlPath = '/index.html';

    // Security: prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(this.publicDir, safePath);

    // Make sure it's within public/
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // Check if file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Serve the file
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        if (ext === '.html') {
          // Inject cache-busting version into HTML asset URLs
          const html = data.toString('utf8').replace(/\.(css|js)(\?v=[^"']*)?"/g, `.$1?v=${BUILD_VERSION}"`);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(html);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(data);
        }
      });
    });
  }

  /**
   * Handle a new WebSocket client connection.
   */
  _handleNewClient(ws) {
    const clientInfo = { userId: null, username: null, channelId: null, authenticated: false };
    this.clients.set(ws, clientInfo);

    ws.on('message', (raw, isBinary) => {
      // Binary message = audio PCM from browser mic
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
      // Text message = JSON command
      try {
        const msg = JSON.parse(raw.toString());
        this._handleClientMessage(ws, msg).catch(err => {
          console.error('[WS] Message handler error:', err.message);
          try {
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
          } catch (_) {}
        });
      } catch (err) {
        console.error('[WS] Bad JSON from client:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected: ${clientInfo.username || 'unknown'}`);
      // Clean up voice session if active
      if (clientInfo.voicePeerId) {
        this.voiceBridge.stopSession(clientInfo.voicePeerId);
      }
      // Remove from web clients and broadcast
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

    // Send current server state to new client
    ws.send(JSON.stringify({
      type: 'server_state',
      channels: Array.from(this.channels.values()),
      users: Array.from(this.users.values()),
    }));
  }

  /**
   * Handle an incoming message from a web client.
   */
  async _handleClientMessage(ws, msg) {
    const client = this.clients.get(ws);

    switch (msg.type) {
      case 'auth': {
        // No password required — user just provides a username.
        // We look them up in Lexicon, or auto-register if they're new.
        if (!msg.username) {
          ws.send(JSON.stringify({ type: 'error', message: 'Username is required' }));
          break;
        }

        const username = msg.username.trim();
        console.log(`[WS] Auth request from: ${username}`);

        // Get or create user in Lexicon
        const player = await lexicon.getOrCreateUser(username);
        client.username = player.displayName || player.username || username;
        client.userId = player.id;
        client.authenticated = true;

        // Store user mapping in bridge DB
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

        // Track this web client and broadcast their presence
        const webClientId = `web_${client.userId}`;
        client.webClientId = webClientId;
        this.webClients.set(webClientId, {
          username: client.username,
          userId: client.userId,
          channelId: client.channelId || 0,
          inVoice: false,
          ws,
        });
        this._broadcastAll({
          type: 'web_user_join',
          webClient: { id: webClientId, username: client.username, channelId: client.channelId || 0, inVoice: false },
        });
        // Send the full web client list to the newly connected user
        const webClientList = [];
        for (const [id, wc] of this.webClients) {
          webClientList.push({ id, username: wc.username, channelId: wc.channelId, inVoice: wc.inVoice });
        }
        ws.send(JSON.stringify({ type: 'web_users', webClients: webClientList }));
        break;
      }

      case 'text': {
        // Relay text message to Mumble and store it
        if (!client.authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          return;
        }

        const channelId = msg.channelId || 0;
        const text = msg.text;
        const channelName = this.channels.get(channelId)?.name || '';

        // Send to Mumble server
        this.mumble.sendTextMessage([channelId], `<b>${client.username}:</b> ${text}`);

        // Store in Lexicon HSQLDB via API (primary storage)
        lexicon.storeMessage({
          channelId,
          channelName,
          userId: client.userId || 0,
          username: client.username,
          content: text,
        }).catch(err => console.error(`[WS] Lexicon message store failed: ${err.message}`));

        // Broadcast to all web clients in same channel EXCEPT the sender
        // (sender adds the message locally on send, so don't send it twice)
        this._broadcastToChannel(channelId, {
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
        // Retrieve message history from Lexicon API
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

      // Bot commands via text (handled by bot engine)
      case 'command': {
        this.emit && this.emit('bot_command', {
          command: msg.command,
          args: msg.args || [],
          userId: client.userId,
          username: client.username,
          channelId: client.channelId || msg.channelId || 0,
          ws,
        });
        break;
      }

      // Lexicon media search
      case 'media_search': {
        const results = await lexicon.searchMedia(msg.query);
        ws.send(JSON.stringify({ type: 'media_results', results }));
        break;
      }

      // Livestream / music
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

      // ── Voice (per-user Mumble connection) ──────────────
      case 'voice_start': {
        if (!client.authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
          break;
        }
        try {
          const peerId = client.username + '_' + client.userId;
          // Clean up any existing session first
          if (client.voicePeerId) {
            this.voiceBridge.stopSession(client.voicePeerId);
          }
          client.voicePeerId = peerId;
          await this.voiceBridge.startSession(peerId, client.username, ws);
          ws.send(JSON.stringify({ type: 'voice_ready' }));
          console.log(`[Voice] Session started for ${client.username}`);
          // Mark web client as in voice
          if (client.webClientId && this.webClients.has(client.webClientId)) {
            this.webClients.get(client.webClientId).inVoice = true;
            this._broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: true });
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
          this.voiceBridge.stopSession(client.voicePeerId);
          console.log(`[Voice] Session stopped for ${client.username}`);
          client.voicePeerId = null;
        }
        // Mark web client as not in voice
        if (client.webClientId && this.webClients.has(client.webClientId)) {
          this.webClients.get(client.webClientId).inVoice = false;
          this._broadcastAll({ type: 'voice_state', id: client.webClientId, username: client.username, inVoice: false });
        }
        ws.send(JSON.stringify({ type: 'voice_stopped' }));
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  }

  /**
   * Set up listeners on the Mumble connection to relay events to web clients.
   */
  _setupMumbleListeners() {
    this.mumble.on('ServerSync', (msg) => {
      this.ownSession = msg.session;
      console.log(`[Mumble] Synced. Our session: ${msg.session}`);
    });

    this.mumble.on('ChannelState', (msg) => {
      this.channels.set(msg.channelId, {
        id: msg.channelId,
        name: msg.name || this.channels.get(msg.channelId)?.name || '',
        parent: msg.parent,
        description: msg.description || '',
      });
      this._broadcastAll({ type: 'channel_update', channel: this.channels.get(msg.channelId) });
    });

    this.mumble.on('ChannelRemove', (msg) => {
      this.channels.delete(msg.channelId);
      this._broadcastAll({ type: 'channel_remove', channelId: msg.channelId });
    });

    this.mumble.on('UserState', (msg) => {
      const existing = this.users.get(msg.session) || {};
      const user = {
        session: msg.session,
        name: msg.name || existing.name || '',
        channelId: msg.channelId !== undefined ? msg.channelId : existing.channelId,
        mute: msg.mute !== undefined ? msg.mute : existing.mute,
        deaf: msg.deaf !== undefined ? msg.deaf : existing.deaf,
        selfMute: msg.selfMute !== undefined ? msg.selfMute : existing.selfMute,
        selfDeaf: msg.selfDeaf !== undefined ? msg.selfDeaf : existing.selfDeaf,
      };
      this.users.set(msg.session, user);
      this._broadcastAll({ type: 'user_update', user });
    });

    this.mumble.on('UserRemove', (msg) => {
      const user = this.users.get(msg.session);
      this.users.delete(msg.session);
      this._broadcastAll({ type: 'user_remove', session: msg.session, name: user?.name });
    });

    this.mumble.on('TextMessage', (msg) => {
      // Relay Mumble text messages to web clients
      const sender = this.users.get(msg.actor);
      const channelIds = msg.channelId || [];
      const rawText = (msg.message || '').replace(/<[^>]+>/g, '').trim();

      for (const chId of channelIds) {
        // Broadcast to web clients
        this._broadcastToChannel(chId, {
          type: 'text',
          channelId: chId,
          username: sender?.name || 'Unknown',
          text: msg.message,
          source: 'mumble', // So web clients know this came from a native Mumble client
          timestamp: new Date().toISOString(),
        });

        // Also store in Lexicon HSQLDB (so all messages are in one place)
        if (rawText && sender?.name) {
          lexicon.storeMessage({
            channelId: chId,
            channelName: this.channels.get(chId)?.name || '',
            userId: 0, // Mumble native users may not have a Lexicon ID
            username: sender.name,
            content: rawText,
          }).catch(() => {}); // Best-effort storage
        }
      }
    });
  }

  /**
   * Send a message to all connected web clients.
   */
  _broadcastAll(msg) {
    const data = JSON.stringify(msg);
    for (const [ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Send a message to web clients in a specific channel.
   */
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
