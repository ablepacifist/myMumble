const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const EventEmitter = require('events');
const config = require('./config');

/**
 * Mumble protocol connection handler.
 * Connects to the Mumble server via TLS TCP and speaks the Mumble protocol.
 *
 * Mumble protocol framing:
 *   [2 bytes: type][4 bytes: length][payload]
 *
 * Message types are defined in Mumble.proto.
 */
class MumbleConnection extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.proto = null;
    this.messageTypes = {};
    this.connected = false;
    this.buffer = Buffer.alloc(0);

    // Mumble protocol message type IDs (from Mumble source)
    this.MESSAGE_TYPE_MAP = {
      0: 'Version',
      1: 'UDPTunnel',
      2: 'Authenticate',
      3: 'Ping',
      4: 'Reject',
      5: 'ServerSync',
      6: 'ChannelRemove',
      7: 'ChannelState',
      8: 'UserRemove',
      9: 'UserState',
      10: 'BanList',
      11: 'TextMessage',
      12: 'PermissionDenied',
      13: 'ACL',
      14: 'QueryUsers',
      15: 'CryptSetup',
      16: 'ContextActionModify',
      17: 'ContextAction',
      18: 'UserList',
      19: 'VoiceTarget',
      20: 'PermissionQuery',
      21: 'CodecVersion',
      22: 'UserStats',
      23: 'RequestBlob',
      24: 'ServerConfig',
      25: 'SuggestConfig',
      26: 'PluginDataTransmission',
    };

    // Reverse map: name -> typeId
    this.MESSAGE_NAME_MAP = {};
    for (const [id, name] of Object.entries(this.MESSAGE_TYPE_MAP)) {
      this.MESSAGE_NAME_MAP[name] = parseInt(id);
    }
  }

  /**
   * Load protobuf definitions.
   */
  async loadProto() {
    const protoPath = path.join(__dirname, '..', 'proto', 'Mumble.proto');
    this.proto = await protobuf.load(protoPath);

    for (const name of Object.values(this.MESSAGE_TYPE_MAP)) {
      try {
        this.messageTypes[name] = this.proto.lookupType(`MumbleProto.${name}`);
      } catch (e) {
        // Some types may not exist in proto file
      }
    }

    console.log(`[Mumble] Loaded ${Object.keys(this.messageTypes).length} message types from proto`);
  }

  /**
   * Connect to the Mumble server.
   * @param {string} username - Username for the bot/bridge connection
   * @param {string} [password] - Server password if required
   */
  connect(username, password) {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        {
          host: config.mumble.host,
          port: config.mumble.port,
          rejectUnauthorized: false, // Mumble uses self-signed certs
        },
        () => {
          console.log(`[Mumble] TLS connected to ${config.mumble.host}:${config.mumble.port}`);
          this.connected = true;

          // Send Version message
          this.sendMessage('Version', {
            versionV1: (1 << 16) | (5 << 8) | 0, // 1.5.0
            release: 'MumbleBridge 1.0',
            os: 'Linux',
            osVersion: 'Node.js',
          });

          // Send Authenticate message
          const authMsg = { username };
          if (password) authMsg.password = password;
          this.sendMessage('Authenticate', authMsg);

          resolve();
        }
      );

      this.socket.on('data', (data) => this._onData(data));
      this.socket.on('error', (err) => {
        console.error(`[Mumble] Connection error:`, err.message);
        this.connected = false;
        this.emit('error', err);
        reject(err);
      });
      this.socket.on('close', () => {
        console.log('[Mumble] Connection closed');
        this.connected = false;
        this.emit('disconnected');
      });
    });
  }

  /**
   * Handle incoming TCP data (buffered framing).
   */
  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 6) {
      const typeId = this.buffer.readUInt16BE(0);
      const length = this.buffer.readUInt32BE(2);

      if (this.buffer.length < 6 + length) break; // Not enough data yet

      const payload = this.buffer.slice(6, 6 + length);
      this.buffer = this.buffer.slice(6 + length);

      this._handleMessage(typeId, payload);
    }
  }

  /**
   * Decode and emit a received message.
   */
  _handleMessage(typeId, payload) {
    const typeName = this.MESSAGE_TYPE_MAP[typeId];
    if (!typeName) return;

    // Skip UDP tunnel (audio) for now — raw binary, not protobuf
    if (typeName === 'UDPTunnel') {
      this.emit('audio', payload);
      return;
    }

    const MessageType = this.messageTypes[typeName];
    if (!MessageType) return;

    try {
      const decoded = MessageType.decode(payload);
      const obj = MessageType.toObject(decoded, { longs: Number, defaults: true });
      this.emit('message', typeName, obj);
      this.emit(typeName, obj); // Also emit by specific type name
    } catch (err) {
      console.error(`[Mumble] Failed to decode ${typeName}:`, err.message);
    }
  }

  /**
   * Send a protobuf message to the Mumble server.
   * @param {string} typeName - Message type name (e.g., 'TextMessage')
   * @param {object} data - Message data
   */
  sendMessage(typeName, data) {
    const typeId = this.MESSAGE_NAME_MAP[typeName];
    if (typeId === undefined) {
      console.error(`[Mumble] Unknown message type: ${typeName}`);
      return;
    }

    const MessageType = this.messageTypes[typeName];
    if (!MessageType) {
      console.error(`[Mumble] No proto type for: ${typeName}`);
      return;
    }

    const err = MessageType.verify(data);
    if (err) {
      console.error(`[Mumble] Invalid message data for ${typeName}:`, err);
      return;
    }

    const message = MessageType.create(data);
    const payload = MessageType.encode(message).finish();

    const header = Buffer.alloc(6);
    header.writeUInt16BE(typeId, 0);
    header.writeUInt32BE(payload.length, 2);

    if (this.socket && this.connected) {
      this.socket.write(Buffer.concat([header, payload]));
    }
  }

  /**
   * Send a text message to a channel.
   * @param {number[]} channelIds - Channel IDs to send to
   * @param {string} text - Message text (HTML allowed)
   */
  sendTextMessage(channelIds, text) {
    this.sendMessage('TextMessage', {
      channelId: channelIds,
      message: text,
    });
  }

  /**
   * Send a ping to keep the connection alive.
   */
  ping() {
    this.sendMessage('Ping', {
      timestamp: Date.now(),
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}

module.exports = MumbleConnection;
