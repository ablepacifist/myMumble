/**
 * MumbleProtocol — Protobuf message encoding/decoding + TCP framing.
 *
 * Mumble TCP framing: 2-byte type (big-endian) + 4-byte length (big-endian) + payload.
 * Each message type maps to a protobuf definition in Mumble.proto.
 */
const protobuf = require('protobufjs');

// Mumble message type IDs (from the Mumble source)
const MSG_TYPE = {
  Version: 0,
  UDPTunnel: 1,
  Authenticate: 2,
  Ping: 3,
  Reject: 4,
  ServerSync: 5,
  ChannelRemove: 6,
  ChannelState: 7,
  UserRemove: 8,
  UserState: 9,
  BanList: 10,
  TextMessage: 11,
  PermissionDenied: 12,
  ACL: 13,
  QueryUsers: 14,
  CryptSetup: 15,
  ContextActionModify: 16,
  ContextAction: 17,
  UserList: 18,
  VoiceTarget: 19,
  PermissionQuery: 20,
  CodecVersion: 21,
  UserStats: 22,
  RequestBlob: 23,
  ServerConfig: 24,
  SuggestConfig: 25,
};

// Reverse map: type ID → message name
const MSG_NAME = {};
for (const [name, id] of Object.entries(MSG_TYPE)) {
  MSG_NAME[id] = name;
}

class MumbleProtocol {
  constructor() {
    this.types = {};
    this._remainder = Buffer.alloc(0);
  }

  /**
   * Load protobuf definitions from a .proto file.
   * @param {string} protoPath — absolute path to Mumble.proto
   */
  async init(protoPath) {
    const root = await protobuf.load(protoPath);
    for (const name of Object.keys(MSG_TYPE)) {
      try {
        this.types[name] = root.lookupType(`MumbleProto.${name}`);
      } catch (_) {
        // UDPTunnel is raw binary, not a protobuf type — skip
      }
    }
  }

  /**
   * Encode a protobuf message with Mumble TCP framing.
   * @param {string} typeName — e.g. 'Version', 'Authenticate', 'Ping'
   * @param {object} data — message fields
   * @returns {Buffer} — complete framed message (6-byte header + payload)
   */
  encodeMessage(typeName, data) {
    const typeId = MSG_TYPE[typeName];
    if (typeId === undefined) throw new Error(`Unknown message type: ${typeName}`);

    const Type = this.types[typeName];
    if (!Type) throw new Error(`No protobuf type for: ${typeName}`);

    const message = Type.create(data);
    const payload = Type.encode(message).finish();

    const header = Buffer.alloc(6);
    header.writeUInt16BE(typeId, 0);
    header.writeUInt32BE(payload.length, 2);

    return Buffer.concat([header, payload]);
  }

  /**
   * Parse one or more Mumble TCP messages from a data buffer.
   * Handles split/incomplete messages across calls via internal remainder.
   * @param {Buffer} data — incoming TCP data
   * @returns {Array<{type: number, payload: Buffer}>}
   */
  parseMessages(data) {
    this._remainder = Buffer.concat([this._remainder, data]);
    const messages = [];

    while (this._remainder.length >= 6) {
      const type = this._remainder.readUInt16BE(0);
      const length = this._remainder.readUInt32BE(2);

      if (this._remainder.length < 6 + length) break; // Incomplete

      const payload = this._remainder.slice(6, 6 + length);
      this._remainder = this._remainder.slice(6 + length);

      messages.push({ type, payload });
    }

    return messages;
  }

  /**
   * Decode a protobuf payload by type name.
   * @param {string} typeName
   * @param {Buffer} payload
   * @returns {object} — decoded protobuf message
   */
  decodePayload(typeName, payload) {
    const Type = this.types[typeName];
    if (!Type) throw new Error(`No protobuf type for: ${typeName}`);
    return Type.decode(payload);
  }

  /** Get any remaining (incomplete) data from the last parseMessages call. */
  getRemainder() {
    return this._remainder;
  }

  /** Clear the internal remainder buffer. */
  resetRemainder() {
    this._remainder = Buffer.alloc(0);
  }
}

// Static constants
MumbleProtocol.MSG_TYPE = MSG_TYPE;
MumbleProtocol.MSG_NAME = MSG_NAME;

module.exports = MumbleProtocol;
