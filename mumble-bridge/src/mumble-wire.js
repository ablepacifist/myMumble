/**
 * Mumble legacy audio wire-format helpers.
 *
 * Mumble audio is NOT sent via the `UDPTunnel` protobuf message (that's an
 * unused stub in Mumble.proto) — it's a hand-built legacy frame written
 * directly to the TLS socket. This is a pure, stateless extraction of the
 * exact framing already proven correct in src/voice-bridge.js (kept private
 * there — this module exists so a second sender, src/music-bot.js, doesn't
 * have to duplicate it. voice-bridge.js itself is intentionally left
 * untouched; it's the most fought-over, timing-sensitive file in the repo).
 */

const UDP_TUNNEL_TYPE_ID = 1;

function writeVarint(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x4000) return Buffer.from([(value >> 8) | 0x80, value & 0xFF]);
  if (value < 0x200000) return Buffer.from([(value >> 16) | 0xC0, (value >> 8) & 0xFF, value & 0xFF]);
  if (value < 0x10000000) return Buffer.from([(value >> 24) | 0xE0, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
  return Buffer.from([0xF0, (value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
}

/** [2-byte typeId][4-byte length][payload] — the standard Mumble TCP frame. */
function buildTcpFrame(typeId, payload) {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(typeId, 0);
  header.writeUInt32BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Build a complete legacy Opus audio packet (TCP-tunneled UDPTunnel frame)
 * ready to write to a Mumble TLS socket.
 * @param {number} sequenceNumber - this connection's own self-incrementing counter
 * @param {Buffer} opusFrame - encoded Opus bytes for one 20ms frame
 * @param {number} target - 0 = normal talk in current channel
 */
function buildLegacyOpusPacket({ sequenceNumber, opusFrame, target = 0 }) {
  const header = (4 << 5) | (target & 0x1F); // type=4 (Opus)
  const seqVarint = writeVarint(sequenceNumber);
  const sizeVarint = writeVarint(opusFrame.length & 0x1FFF);
  const audioPayload = Buffer.concat([Buffer.from([header]), seqVarint, sizeVarint, opusFrame]);
  return buildTcpFrame(UDP_TUNNEL_TYPE_ID, audioPayload);
}

module.exports = { writeVarint, buildTcpFrame, buildLegacyOpusPacket, UDP_TUNNEL_TYPE_ID };
