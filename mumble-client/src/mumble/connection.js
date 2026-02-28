/**
 * MumbleConnection — TLS connection to a Mumble server.
 *
 * Handles authentication, message routing, channel/user state tracking,
 * audio encode/decode, and ping keepalive.
 *
 * Events emitted:
 *   ready         — connection established + ServerSync received
 *   channelState  — channel created or updated
 *   channelRemove — channel deleted
 *   userState     — user joined / updated
 *   userRemove    — user left
 *   textMessage   — text message received
 *   audio         — decoded PCM from another user ({ senderSession, pcm: Int16Array })
 *   error         — connection error
 *   disconnected  — socket closed
 */
const tls = require('tls');
const path = require('path');
const EventEmitter = require('events');
const MumbleProtocol = require('./protocol');
const Voice = require('./voice');

class MumbleConnection extends EventEmitter {
  /**
   * @param {object} config
   * @param {string} config.host — Mumble server hostname
   * @param {number} config.port — Mumble server port (default 64738)
   * @param {string} config.username — display name
   */
  constructor(config) {
    super();
    this.config = config;
    this.protocol = new MumbleProtocol();
    this.voice = new Voice();
    this.socket = null;
    this.ready = false;
    this.session = null;
    this.channels = new Map();
    this.users = new Map();
    this.pingInterval = null;
    this.sequenceNumber = 0;
    this._audioProtoType = null;
  }

  /**
   * Connect to the Mumble server with retry on ECONNRESET.
   */
  async connect() {
    await this.protocol.init(
      path.join(__dirname, '..', '..', 'proto', 'Mumble.proto'),
    );

    const maxRetries = 3;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        await this._connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'ECONNRESET') throw err;
        if (this.socket) {
          try { this.socket.destroy(); } catch (_) {}
          this.socket = null;
        }
      }
    }
    throw lastErr;
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Mumble connection timeout')),
        10000,
      );

      this.socket = tls.connect(
        {
          host: this.config.host,
          port: this.config.port || 64738,
          rejectUnauthorized: false,
        },
        () => {
          // Send Version — use 1.2.4 so server uses legacy audio format
          this._send('Version', {
            versionV1: (1 << 16) | (2 << 8) | 4,
            release: 'MumbleChat 1.0',
            os: process.platform,
            osVersion: process.arch,
          });

          // Authenticate
          this._send('Authenticate', {
            username: this.config.username,
            opus: true,
          });
        },
      );

      this.socket.on('data', (data) => this._onData(data));

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.ready = false;
        this.emit('error', err);
        reject(err);
      });

      this.socket.on('close', () => {
        this.ready = false;
        this._stopPing();
        this.emit('disconnected');
      });

      this._onSyncResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  // ── Incoming Data ──

  _onData(data) {
    const messages = this.protocol.parseMessages(data);
    for (const msg of messages) {
      this._handleMessage(msg.type, msg.payload);
    }
  }

  _handleMessage(typeId, payload) {
    const T = MumbleProtocol.MSG_TYPE;

    switch (typeId) {
      case T.UDPTunnel:
        this._onAudio(payload);
        break;

      case T.ServerSync: {
        const msg = this.protocol.decodePayload('ServerSync', payload);
        this.session = msg.session;
        this.ready = true;
        this._startPing();
        this.emit('ready', { session: this.session, welcomeText: msg.welcomeText });
        if (this._onSyncResolve) {
          this._onSyncResolve();
          this._onSyncResolve = null;
        }
        break;
      }

      case T.ChannelState: {
        const msg = this.protocol.decodePayload('ChannelState', payload);
        const existing = this.channels.get(msg.channelId) || {};
        const ch = {
          ...existing,
          id: msg.channelId,
          ...(msg.name !== undefined && msg.name !== null ? { name: msg.name } : {}),
          ...(msg.parent !== undefined && msg.parent !== null ? { parentId: msg.parent } : {}),
        };
        this.channels.set(ch.id, ch);
        this.emit('channelState', ch);
        break;
      }

      case T.ChannelRemove: {
        const msg = this.protocol.decodePayload('ChannelRemove', payload);
        this.channels.delete(msg.channelId);
        this.emit('channelRemove', msg.channelId);
        break;
      }

      case T.UserState: {
        const msg = this.protocol.decodePayload('UserState', payload);
        const existing = this.users.get(msg.session) || {};
        const user = {
          ...existing,
          session: msg.session,
          ...(msg.name ? { name: msg.name } : {}),
          ...(msg.channelId !== undefined && msg.channelId !== null
            ? { channelId: msg.channelId }
            : {}),
          ...(msg.mute !== undefined ? { mute: msg.mute } : {}),
          ...(msg.deaf !== undefined ? { deaf: msg.deaf } : {}),
          ...(msg.selfMute !== undefined ? { selfMute: msg.selfMute } : {}),
          ...(msg.selfDeaf !== undefined ? { selfDeaf: msg.selfDeaf } : {}),
        };
        this.users.set(msg.session, user);
        this.emit('userState', user);
        break;
      }

      case T.UserRemove: {
        const msg = this.protocol.decodePayload('UserRemove', payload);
        const user = this.users.get(msg.session);
        this.users.delete(msg.session);
        this.emit('userRemove', { session: msg.session, name: user?.name });
        break;
      }

      case T.TextMessage: {
        const msg = this.protocol.decodePayload('TextMessage', payload);
        const sender = this.users.get(msg.actor);
        this.emit('textMessage', {
          actor: msg.actor,
          senderName: sender?.name || 'Unknown',
          channelId: msg.channelId?.[0],
          message: msg.message,
        });
        break;
      }

      case T.Reject: {
        const msg = this.protocol.decodePayload('Reject', payload);
        this.emit('error', new Error(`Server rejected: ${msg.reason || 'Unknown reason'}`));
        break;
      }

      case T.CryptSetup:
      case T.Ping:
      case T.CodecVersion:
      case T.ServerConfig:
      case T.SuggestConfig:
      case T.PermissionQuery:
        // Handled silently
        break;

      default:
        break;
    }
  }

  // ── Audio ──

  _onAudio(payload) {
    if (payload.length < 2) return;

    let parsed = null;
    if (payload[0] === 0x00) {
      parsed = this._parseProtobufAudio(payload);
    } else {
      parsed = this.voice.parseAudioPayload(payload);
    }

    if (!parsed || !parsed.opusData || parsed.opusData.length === 0) return;

    // Skip own audio (echo prevention)
    if (parsed.senderSession === this.session) return;

    const pcm = this.voice.decode(parsed.opusData, `sender_${parsed.senderSession}`);
    if (pcm) {
      this.emit('audio', { senderSession: parsed.senderSession, pcm });
    }
  }

  _parseProtobufAudio(payload) {
    if (payload[0] !== 0x00) return null;
    try {
      if (!this._audioProtoType) {
        const protobuf = require('protobufjs');
        const protoPath = path.join(__dirname, '..', '..', 'proto', 'MumbleUDP.proto');
        this._audioProtoType = protobuf.loadSync(protoPath).lookupType('MumbleUDP.Audio');
      }
      const decoded = this._audioProtoType.decode(payload.slice(1));
      if (!decoded.opusData || decoded.opusData.length === 0) return null;
      return { senderSession: decoded.senderSession || 0, opusData: decoded.opusData };
    } catch (_) {
      return null;
    }
  }

  // ── Outgoing ──

  /**
   * Encode and send PCM audio to Mumble.
   * @param {Int16Array} pcmInt16 — exactly 960 samples
   */
  sendAudio(pcmInt16) {
    if (!this.ready || !this.socket) return;
    const opus = this.voice.encode(pcmInt16);
    if (!opus) return;
    const packet = this.voice.buildAudioPacket(opus, this.sequenceNumber++, false);
    this.socket.write(packet);
  }

  /**
   * Send a text message to one or more channels.
   * @param {number[]} channelIds
   * @param {string} message
   */
  sendTextMessage(channelIds, message) {
    if (!this.ready) return;
    this._send('TextMessage', { channelId: channelIds, message });
  }

  /**
   * Move this user to a different channel.
   * @param {number} channelId
   */
  moveToChannel(channelId) {
    if (!this.ready || this.session === null) return;
    this._send('UserState', { session: this.session, channelId });
  }

  /**
   * Create a sub-channel (requires Make Channel permission).
   * @param {number} parentId
   * @param {string} name
   */
  createChannel(parentId, name) {
    if (!this.ready) return;
    this._send('ChannelState', { parent: parentId, name });
  }

  /**
   * Remove a channel (requires permission).
   * @param {number} channelId
   */
  removeChannel(channelId) {
    if (!this.ready) return;
    this._send('ChannelRemove', { channelId });
  }

  /**
   * Set self-mute state.
   */
  setSelfMute(muted) {
    if (!this.ready || this.session === null) return;
    this._send('UserState', { session: this.session, selfMute: muted });
  }

  /**
   * Set self-deaf state.
   */
  setSelfDeaf(deafened) {
    if (!this.ready || this.session === null) return;
    this._send('UserState', { session: this.session, selfDeaf: deafened });
  }

  // ── Internal ──

  _send(typeName, data) {
    if (!this.socket) return;
    try {
      const buf = this.protocol.encodeMessage(typeName, data);
      this.socket.write(buf);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ready) this._send('Ping', { timestamp: Date.now() });
    }, 15000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.ready = false;
    this._stopPing();
    this.voice.destroy();
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this.channels.clear();
    this.users.clear();
  }
}

module.exports = MumbleConnection;
