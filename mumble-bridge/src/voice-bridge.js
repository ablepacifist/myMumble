/**
 * Voice Bridge — per-user Mumble connections for web voice chat.
 *
 * Each web user gets their OWN TLS connection to the Mumble server.
 * Mumble handles all audio mixing and routing natively.
 * Audio travels as binary over the existing WebSocket — no WebRTC, no TURN.
 *
 * Flow:
 *   Browser mic → AudioWorklet PCM → WebSocket binary → encode Opus → Mumble UDPTunnel
 *   Mumble UDPTunnel → decode Opus → PCM → WebSocket binary → AudioWorklet → speaker
 */
const tls = require('tls');
const path = require('path');
const protobuf = require('protobufjs');
const OpusScript = require('opusscript');
const config = require('./config');

// Mumble message type IDs we need
const MSG_TYPE = {
  Version: 0,
  UDPTunnel: 1,
  Authenticate: 2,
  Ping: 3,
  ServerSync: 5,
  ChannelState: 7,
  UserState: 9,
  CryptSetup: 15,
  CodecVersion: 21,
};

class VoiceBridge {
  constructor() {
    this.sessions = new Map(); // peerId -> VoiceSession
    this.proto = null;
    this.messageTypes = {};
    this.sampleRate = 48000;
    this.channels = 1;
    this.frameDuration = 20; // ms
    this.samplesPerFrame = (this.sampleRate * this.frameDuration) / 1000; // 960
  }

  /**
   * Load protobuf definitions (call once at startup).
   */
  async init() {
    const protoPath = path.join(__dirname, '..', 'proto', 'Mumble.proto');
    this.proto = await protobuf.load(protoPath);

    for (const [name, id] of Object.entries(MSG_TYPE)) {
      try {
        this.messageTypes[name] = this.proto.lookupType(`MumbleProto.${name}`);
      } catch (e) {
        // skip
      }
    }
    console.log('[Voice] Bridge initialized');
  }

  /**
   * Start a voice session for a web user.
   * Creates a dedicated Mumble connection for them.
   *
   * @param {string} peerId - Unique ID for this voice session
   * @param {string} username - Display name (will appear in Mumble)
   * @param {WebSocket} ws - The user's WebSocket (for sending audio back)
   * @returns {Promise<VoiceSession>}
   */
  async startSession(peerId, username, ws) {
    // Clean up existing session if any
    this.stopSession(peerId);

    const session = new VoiceSession(peerId, username, ws, this);
    this.sessions.set(peerId, session);

    try {
      await session.connect();
      console.log(`[Voice] Session started for ${username} (${peerId}), ${this.sessions.size} active`);
      return session;
    } catch (err) {
      this.sessions.delete(peerId);
      throw err;
    }
  }

  /**
   * Stop a voice session.
   */
  stopSession(peerId) {
    const session = this.sessions.get(peerId);
    if (session) {
      session.disconnect();
      this.sessions.delete(peerId);
      console.log(`[Voice] Session stopped for ${session.username} (${peerId}), ${this.sessions.size} active`);
    }
  }

  /**
   * Handle incoming binary audio from a web user's WebSocket.
   * @param {string} peerId
   * @param {Buffer} data - Raw PCM Int16LE samples (960 samples = 1920 bytes)
   */
  handleAudioFromBrowser(peerId, data) {
    const session = this.sessions.get(peerId);
    if (!session || !session.ready) return;
    session.sendAudioToMumble(data);
  }

  /**
   * Move a voice session's Mumble user to a specific channel.
   * @param {string} peerId
   * @param {number} channelId - The Mumble channel ID to move to
   */
  moveToChannel(peerId, channelId) {
    const session = this.sessions.get(peerId);
    if (session) session.moveToChannel(channelId);
  }

  /**
   * Get active session count.
   */
  getStats() {
    return {
      activeSessions: this.sessions.size,
      sessionIds: Array.from(this.sessions.keys()),
    };
  }
}

/**
 * A single user's voice session — their own Mumble connection.
 */
class VoiceSession {
  constructor(peerId, username, ws, bridge) {
    this.peerId = peerId;
    this.username = username;
    this.ws = ws;
    this.bridge = bridge;
    this.socket = null;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.sequenceNumber = 0;
    this.pingInterval = null;
    this.mumbleSession = null;

    // Per-session Opus encoder (one encoder for OUR mic stream is fine)
    this.opusEncoder = new OpusScript(bridge.sampleRate, bridge.channels, OpusScript.Application.VOIP);

    // Per-SENDER Opus decoders. Mumble does NOT mix audio — it sends
    // separate Opus streams per talking user, each with their own state.
    // Using one decoder for all streams produces garbled output.
    this.opusDecoders = new Map(); // senderSession -> { decoder, lastUsed }
    this._decoderCleanupInterval = setInterval(() => this._cleanupIdleDecoders(), 30000);

    // ── Diagnostic counters (temporary) ──
    this._diag = { pcmIn: 0, opusOut: 0, mumbleIn: 0, pcmOut: 0, encErr: 0, decErr: 0, wsErr: 0, echoSkip: 0 };
    this._diagInterval = setInterval(() => {
      const d = this._diag;
      if (d.pcmIn || d.mumbleIn) {
        console.log(`[Voice][DIAG] ${this.username}: pcmIn=${d.pcmIn} opusOut=${d.opusOut} mumbleIn=${d.mumbleIn} pcmOut=${d.pcmOut} echoSkip=${d.echoSkip} encErr=${d.encErr} decErr=${d.decErr} wsErr=${d.wsErr}`);
      }
      this._diag = { pcmIn: 0, opusOut: 0, mumbleIn: 0, pcmOut: 0, encErr: 0, decErr: 0, wsErr: 0, echoSkip: 0 };
    }, 5000);
  }

  /**
   * Connect to Mumble as this user, with retry on ECONNRESET.
   * Mumble has an autoban that rejects rapid connections from the same IP.
   * We retry up to 3 times with exponential backoff.
   */
  async connect() {
    const maxRetries = 3;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[Voice] Retry ${attempt}/${maxRetries} for ${this.username} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        await this._connectOnce();
        return; // Success
      } catch (err) {
        lastErr = err;
        // Only retry on ECONNRESET (Mumble autoban), not on other errors
        if (err.code !== 'ECONNRESET' && err.message !== 'read ECONNRESET') {
          throw err;
        }
        console.warn(`[Voice] ECONNRESET for ${this.username} (attempt ${attempt + 1}/${maxRetries + 1})`);
        // Clean up the failed socket before retry
        if (this.socket) {
          try { this.socket.destroy(); } catch (_) {}
          this.socket = null;
        }
      }
    }

    throw lastErr;
  }

  /**
   * Single connection attempt to Mumble.
   */
  _connectOnce() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Mumble connection timeout'));
      }, 10000);

      this.socket = tls.connect(
        {
          host: config.mumble.host,
          port: config.mumble.port,
          rejectUnauthorized: false,
        },
        () => {
          // Send Version — use 1.2.4 so server uses legacy audio format.
          // Mumble 1.5+ introduced protobuf audio framing; we implement legacy.
          this._sendProto('Version', {
            versionV1: (1 << 16) | (2 << 8) | 4,
            release: 'WebVoice 1.0',
            os: 'Web',
            osVersion: 'Browser',
          });

          // Authenticate with a web-prefixed username so it's clear in Mumble
          this._sendProto('Authenticate', {
            username: 'web_' + this.username,
            opus: true,
          });
        }
      );

      this.socket.on('data', (data) => this._onData(data));

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[Voice] Connection error for ${this.username}:`, err.message);
        this.ready = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.ready = false;
        this._stopPing();
      });

      // Wait for ServerSync which means we're fully connected
      this._onSyncResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  /**
   * Handle incoming TCP data — standard Mumble framing.
   * Uses offset tracking instead of Buffer.concat/slice to reduce GC pressure.
   */
  _onData(data) {
    // Append incoming data
    if (this.buffer.length === 0) {
      this.buffer = data; // Zero-copy for common case
    } else {
      this.buffer = Buffer.concat([this.buffer, data]);
    }

    let offset = 0;
    while (offset + 6 <= this.buffer.length) {
      const typeId = this.buffer.readUInt16BE(offset);
      const length = this.buffer.readUInt32BE(offset + 2);

      if (offset + 6 + length > this.buffer.length) break;

      const payload = this.buffer.subarray(offset + 6, offset + 6 + length);
      offset += 6 + length;

      this._handleMessage(typeId, payload);
    }

    // Only allocate a new buffer if we consumed some data
    if (offset > 0) {
      this.buffer = offset < this.buffer.length
        ? Buffer.from(this.buffer.subarray(offset)) // Copy remainder
        : Buffer.alloc(0);
    }
  }

  /**
   * Handle a decoded Mumble message.
   */
  _handleMessage(typeId, payload) {
    switch (typeId) {
      case MSG_TYPE.UDPTunnel:
        this._onMumbleAudio(payload);
        break;

      case MSG_TYPE.ServerSync:
        try {
          const msg = this.bridge.messageTypes.ServerSync.decode(payload);
          this.mumbleSession = msg.session;
          this.ready = true;
          console.log(`[Voice] ${this.username} synced with Mumble, session=${msg.session}`);
          this._startPing();
          if (this._onSyncResolve) {
            this._onSyncResolve();
            this._onSyncResolve = null;
          }
        } catch (e) {
          console.error(`[Voice] ServerSync decode error:`, e.message);
        }
        break;

      case MSG_TYPE.CryptSetup:
        // Server sends crypto setup — we don't use UDP so we just acknowledge
        break;

      case MSG_TYPE.CodecVersion:
        // Codec negotiation — we always use Opus
        break;

      case MSG_TYPE.Ping:
        // Server pong — ignore
        break;

      default:
        // Ignore other messages (ChannelState, UserState, etc.)
        break;
    }
  }

  /**
   * Receive audio from Mumble, decode Opus → PCM, send to browser via WebSocket binary.
   * Mumble sends SEPARATE Opus streams per talking user, so we need a
   * dedicated decoder for each sender to maintain correct Opus state.
   */
  _onMumbleAudio(payload) {
    if (payload.length < 2) return;

    let parsed = null;

    // Try protobuf format first (byte0 == 0x00 for Mumble 1.5+)
    if (payload[0] === 0x00) {
      parsed = this._parseProtobufAudio(payload);
    } else {
      parsed = this._parseLegacyAudio(payload);
    }

    if (!parsed || !parsed.opusData || parsed.opusData.length === 0) return;

    const { senderSession, opusData } = parsed;
    this._diag.mumbleIn++;

    // Never play back our own audio — prevents echo feedback loop
    if (senderSession === this.mumbleSession) {
      this._diag.echoSkip++;
      return;
    }

    // Get or create a decoder for this sender
    let entry = this.opusDecoders.get(senderSession);
    if (!entry) {
      entry = {
        decoder: new OpusScript(this.bridge.sampleRate, this.bridge.channels, OpusScript.Application.VOIP),
        lastUsed: Date.now(),
      };
      this.opusDecoders.set(senderSession, entry);
      console.log(`[Voice][DIAG] ${this.username}: new decoder for sender session ${senderSession}`);
    }
    entry.lastUsed = Date.now();

    // Decode Opus to PCM using the sender-specific decoder
    let pcmBuffer;
    try {
      pcmBuffer = entry.decoder.decode(Buffer.from(opusData));
    } catch (err) {
      this._diag.decErr++;
      console.error(`[Voice][DIAG] Decode error for ${this.username} from sender ${senderSession}:`, err.message);
      return; // Skip bad frames
    }

    // Send raw PCM to browser as binary WebSocket message.
    // Check backpressure: if the WebSocket's send buffer is backed up (> 5 frames
    // worth of data queued), drop this frame to prevent ever-growing latency.
    // This is critical when going through Cloudflare tunnel or slow connections.
    if (this.ws && this.ws.readyState === 1) {
      const MAX_BUFFERED = 1920 * 5; // 5 frames × 1920 bytes = ~100ms
      if (this.ws.bufferedAmount > MAX_BUFFERED) {
        // Drop frame — better to skip than accumulate latency
        return;
      }
      try {
        this.ws.send(pcmBuffer, { binary: true });
        this._diag.pcmOut++;
      } catch (err) {
        this._diag.wsErr++;
        console.error(`[Voice][DIAG] WS send error for ${this.username}:`, err.message);
      }
    }
  }

  /**
   * Clean up decoders for senders who stopped talking (idle > 10s).
   */
  _cleanupIdleDecoders() {
    const now = Date.now();
    for (const [session, entry] of this.opusDecoders) {
      if (now - entry.lastUsed > 10000) {
        try { entry.decoder.delete(); } catch (_) {}
        this.opusDecoders.delete(session);
      }
    }
  }

  /**
   * Receive PCM audio from browser, encode to Opus, send to Mumble.
   * @param {Buffer} pcmData - Int16LE PCM samples
   */
  sendAudioToMumble(pcmData) {
    if (!this.ready || !this.socket) return;
    this._diag.pcmIn++;

    const samplesPerFrame = this.bridge.samplesPerFrame;
    // Copy to aligned buffer — Node.js Buffers can have odd byteOffset
    // which crashes Int16Array constructor with RangeError
    const aligned = Buffer.from(pcmData);
    const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);

    // Process in 960-sample (20ms) chunks
    for (let offset = 0; offset + samplesPerFrame <= int16.length; offset += samplesPerFrame) {
      const frame = int16.slice(offset, offset + samplesPerFrame);

      try {
        const opusFrame = this.opusEncoder.encode(
          Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
          samplesPerFrame
        );

        if (opusFrame && opusFrame.length > 0) {
          this._sendOpusToMumble(opusFrame);
          this._diag.opusOut++;
        }
      } catch (err) {
        this._diag.encErr++;
        console.error(`[Voice][DIAG] Encode error for ${this.username}:`, err.message);
      }
    }
  }

  /**
   * Send an Opus frame to Mumble as UDPTunnel using legacy format.
   */
  _sendOpusToMumble(opusFrame) {
    // Header byte: Opus (type=4, bits 7-5), target=0 (normal talking)
    const header = (4 << 5) | 0;

    const seqVarint = this._writeVarint(this.sequenceNumber++);

    // Size field: opus frame length only. Terminator bit (0x2000) is NOT
    // set — the browser sends a continuous stream of frames, so we never
    // signal end-of-speech mid-stream. The stream ends naturally when
    // frames stop arriving (user mutes or disconnects).
    const sizeVarint = this._writeVarint(opusFrame.length & 0x1FFF);

    // Build complete Mumble-framed UDPTunnel packet in one concat
    const audioLen = 1 + seqVarint.length + sizeVarint.length + opusFrame.length;
    const tcpHeader = Buffer.alloc(6);
    tcpHeader.writeUInt16BE(MSG_TYPE.UDPTunnel, 0);
    tcpHeader.writeUInt32BE(audioLen, 2);

    if (this.socket) {
      this.socket.write(Buffer.concat([tcpHeader, Buffer.from([header]), seqVarint, sizeVarint, opusFrame]));
    }
  }

  /**
   * Parse protobuf-format audio (Mumble 1.5+).
   * Returns { senderSession, opusData } or null.
   */
  _parseProtobufAudio(payload) {
    if (payload[0] !== 0x00) return null;
    try {
      if (!this._audioProtoType) {
        try {
          const protoPath = path.join(__dirname, '..', 'proto', 'MumbleUDP.proto');
          this._audioProtoType = protobuf.loadSync(protoPath).lookupType('MumbleUDP.Audio');
        } catch (e) {
          return null;
        }
      }
      const decoded = this._audioProtoType.decode(payload.slice(1));
      if (!decoded.opusData || decoded.opusData.length === 0) return null;
      return {
        senderSession: decoded.senderSession || 0,
        opusData: decoded.opusData,
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Parse legacy-format audio.
   * Returns { senderSession, opusData } or null.
   */
  _parseLegacyAudio(payload) {
    let offset = 0;
    const header = payload[offset++];
    const audioType = (header >> 5) & 0x07;
    if (audioType !== 4) return null; // Not Opus

    const session = this._readVarint(payload, offset);
    offset += session.length;

    const seq = this._readVarint(payload, offset);
    offset += seq.length;

    const opusHeader = this._readVarint(payload, offset);
    offset += opusHeader.length;
    const opusSize = opusHeader.value & 0x1FFF;

    if (opusSize === 0 || offset + opusSize > payload.length) return null;
    return {
      senderSession: session.value,
      opusData: payload.slice(offset, offset + opusSize),
    };
  }

  _readVarint(buf, offset) {
    if (offset >= buf.length) return { value: 0, length: 0 };
    const v = buf[offset];
    if ((v & 0x80) === 0x00) return { value: v & 0x7F, length: 1 };
    if ((v & 0xC0) === 0x80) {
      if (offset + 1 >= buf.length) return { value: 0, length: 1 };
      return { value: ((v & 0x3F) << 8) | buf[offset + 1], length: 2 };
    }
    if ((v & 0xE0) === 0xC0) {
      if (offset + 2 >= buf.length) return { value: 0, length: 1 };
      return { value: ((v & 0x1F) << 16) | (buf[offset + 1] << 8) | buf[offset + 2], length: 3 };
    }
    if ((v & 0xF0) === 0xE0) {
      if (offset + 3 >= buf.length) return { value: 0, length: 1 };
      return { value: ((v & 0x0F) << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3], length: 4 };
    }
    return { value: 0, length: 1 };
  }

  _writeVarint(value) {
    if (value < 0x80) return Buffer.from([value]);
    if (value < 0x4000) return Buffer.from([(value >> 8) | 0x80, value & 0xFF]);
    if (value < 0x200000) return Buffer.from([(value >> 16) | 0xC0, (value >> 8) & 0xFF, value & 0xFF]);
    if (value < 0x10000000) return Buffer.from([(value >> 24) | 0xE0, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
    return Buffer.from([0xF0, (value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
  }

  /**
   * Move this session's Mumble user to a specific channel.
   */
  moveToChannel(channelId) {
    if (this.ready && this.mumbleSession !== null) {
      this._sendProto('UserState', { session: this.mumbleSession, channelId });
      console.log(`[Voice] Moving ${this.username} to channel ${channelId}`);
    }
  }

  /**
   * Send a protobuf message to this session's Mumble connection.
   */
  _sendProto(typeName, data) {
    const typeId = MSG_TYPE[typeName];
    if (typeId === undefined) return;

    const MessageType = this.bridge.messageTypes[typeName];
    if (!MessageType) return;

    const message = MessageType.create(data);
    const payload = MessageType.encode(message).finish();

    const header = Buffer.alloc(6);
    header.writeUInt16BE(typeId, 0);
    header.writeUInt32BE(payload.length, 2);

    if (this.socket) {
      this.socket.write(Buffer.concat([header, payload]));
    }
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.ready) {
        this._sendProto('Ping', { timestamp: Date.now() });
      }
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
    if (this._diagInterval) {
      clearInterval(this._diagInterval);
      this._diagInterval = null;
    }
    if (this._decoderCleanupInterval) {
      clearInterval(this._decoderCleanupInterval);
      this._decoderCleanupInterval = null;
    }
    if (this.opusEncoder) {
      try { this.opusEncoder.delete(); } catch (e) {}
      this.opusEncoder = null;
    }
    // Clean up ALL per-sender decoders
    for (const [, entry] of this.opusDecoders) {
      try { entry.decoder.delete(); } catch (e) {}
    }
    this.opusDecoders.clear();
    if (this.socket) {
      try { this.socket.destroy(); } catch (e) {}
      this.socket = null;
    }
  }
}

module.exports = VoiceBridge;
