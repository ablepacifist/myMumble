/**
 * Voice — Opus encode/decode, audio mixing, and Mumble audio packet handling.
 *
 * Each sender gets their own Opus decoder to maintain correct codec state.
 * The mixer sums multiple senders' frames with Int16 clamping.
 */
const OpusScript = require('opusscript');

class Voice {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate — default 48000
   * @param {number} opts.channels — default 1 (mono)
   * @param {number} opts.frameDuration — default 20 (ms)
   */
  constructor({ sampleRate = 48000, channels = 1, frameDuration = 20 } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.frameDuration = frameDuration;
    this.samplesPerFrame = (sampleRate * frameDuration) / 1000; // 960

    this.encoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
    this.encoder.setBitrate(48000); // 48 kbps — matches Mumble default quality
    this.decoders = new Map(); // senderId → { decoder, lastUsed }
  }

  /**
   * Encode 960 Int16 PCM samples to an Opus frame.
   * @param {Int16Array} pcm — exactly 960 samples
   * @returns {Buffer|null} — Opus frame, or null on error
   */
  encode(pcm) {
    if (!(pcm instanceof Int16Array) || pcm.length !== this.samplesPerFrame) {
      return null;
    }
    try {
      const result = this.encoder.encode(
        Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        this.samplesPerFrame,
      );
      return Buffer.from(result);
    } catch (_) {
      return null;
    }
  }

  /**
   * Decode an Opus frame to 960 Int16 PCM samples.
   * Uses a per-sender decoder to maintain correct Opus state.
   * @param {Buffer} opusData — Opus frame, or null for PLC (packet loss concealment)
   * @param {string} senderId — unique ID per sender
   * @returns {Int16Array|null}
   */
  decode(opusData, senderId) {
    let entry = this.decoders.get(senderId);
    if (!entry) {
      entry = {
        decoder: new OpusScript(this.sampleRate, this.channels, OpusScript.Application.VOIP),
        lastUsed: Date.now(),
        lastSeq: -1,
      };
      this.decoders.set(senderId, entry);
    }
    entry.lastUsed = Date.now();

    try {
      const decoded = entry.decoder.decode(opusData === null ? null : Buffer.from(opusData));
      // decoded is a Buffer of Int16LE samples
      return new Int16Array(
        decoded.buffer,
        decoded.byteOffset,
        decoded.byteLength / 2,
      );
    } catch (_) {
      return null;
    }
  }

  /**
   * Decode an Opus frame with PLC gap-fill for missing sequence numbers.
   * Returns an array of one or more Int16Array frames (PLC frames + actual frame).
   * @param {Buffer} opusData — the Opus frame data
   * @param {string} senderId — unique ID per sender
   * @param {number} sequenceNumber — Mumble sequence number
   * @returns {Int16Array[]}
   */
  decodeWithPLC(opusData, senderId, sequenceNumber) {
    let entry = this.decoders.get(senderId);
    if (!entry) {
      entry = {
        decoder: new OpusScript(this.sampleRate, this.channels, OpusScript.Application.VOIP),
        lastUsed: Date.now(),
        lastSeq: -1,
      };
      this.decoders.set(senderId, entry);
    }
    entry.lastUsed = Date.now();

    const frames = [];

    // Detect gaps and generate PLC frames (max 3 to prevent runaway)
    if (entry.lastSeq >= 0 && sequenceNumber > entry.lastSeq + 1) {
      const gap = Math.min(sequenceNumber - entry.lastSeq - 1, 3);
      for (let i = 0; i < gap; i++) {
        try {
          const plc = entry.decoder.decode(null);
          frames.push(new Int16Array(plc.buffer, plc.byteOffset, plc.byteLength / 2));
        } catch (_) {
          // If PLC fails, push silence
          frames.push(new Int16Array(this.samplesPerFrame));
        }
      }
    }
    entry.lastSeq = sequenceNumber;

    // Decode the actual frame
    try {
      const decoded = entry.decoder.decode(Buffer.from(opusData));
      frames.push(new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2));
    } catch (_) {
      frames.push(new Int16Array(this.samplesPerFrame));
    }

    return frames;
  }

  /**
   * Mix multiple Int16 PCM frames into one by summing + clamping.
   * @param {Int16Array[]} frames
   * @returns {Int16Array|null}
   */
  mix(frames) {
    if (!frames || frames.length === 0) return null;
    if (frames.length === 1) return frames[0];

    const result = new Int16Array(this.samplesPerFrame);
    for (let i = 0; i < this.samplesPerFrame; i++) {
      let sum = 0;
      for (const frame of frames) {
        sum += frame[i];
      }
      result[i] = Math.max(-32768, Math.min(32767, sum));
    }
    return result;
  }

  /**
   * Build a complete Mumble UDPTunnel packet (TCP-framed) containing an Opus audio frame.
   * @param {Buffer} opusData — encoded Opus frame
   * @param {number} sequenceNumber
   * @param {boolean} isTerminator — set terminator bit?
   * @returns {Buffer}
   */
  buildAudioPacket(opusData, sequenceNumber, isTerminator = false) {
    // Header byte: Opus (type=4 in bits 7-5), target=0 (normal talking)
    const header = (4 << 5) | 0;

    const seqVarint = this._writeVarint(sequenceNumber);

    let size = opusData.length & 0x1FFF;
    if (isTerminator) size |= 0x2000;
    const sizeVarint = this._writeVarint(size);

    const audioPayload = Buffer.concat([
      Buffer.from([header]),
      seqVarint,
      sizeVarint,
      opusData,
    ]);

    // TCP framing: type=1 (UDPTunnel), length
    const tcpHeader = Buffer.alloc(6);
    tcpHeader.writeUInt16BE(1, 0);
    tcpHeader.writeUInt32BE(audioPayload.length, 2);

    return Buffer.concat([tcpHeader, audioPayload]);
  }

  /**
   * Parse a legacy Mumble audio payload (inside a UDPTunnel message, without TCP framing).
   * @param {Buffer} payload
   * @returns {{ senderSession: number, sequenceNumber: number, opusData: Buffer, isTerminator: boolean }|null}
   */
  parseAudioPayload(payload) {
    if (!payload || payload.length < 2) return null;

    let offset = 0;
    const headerByte = payload[offset++];
    const audioType = (headerByte >> 5) & 0x07;

    if (audioType !== 4) return null; // Not Opus

    // Session varint
    const session = this._readVarint(payload, offset);
    offset += session.length;

    // Sequence varint
    const seq = this._readVarint(payload, offset);
    offset += seq.length;

    // Opus header varint (contains size + optional terminator bit)
    const opusHeader = this._readVarint(payload, offset);
    offset += opusHeader.length;
    const opusSize = opusHeader.value & 0x1FFF;

    if (opusSize === 0 || offset + opusSize > payload.length) return null;

    return {
      senderSession: session.value,
      sequenceNumber: seq.value,
      opusData: payload.slice(offset, offset + opusSize),
      isTerminator: !!(opusHeader.value & 0x2000),
    };
  }

  /** Number of active per-sender decoders. */
  get decoderCount() {
    return this.decoders.size;
  }

  /** Check if a decoder exists for a sender (test helper). */
  _hasDecoder(senderId) {
    return this.decoders.has(senderId);
  }

  /** Force a decoder's lastUsed timestamp into the past (test helper). */
  _forceDecoderAge(senderId, ageMs) {
    const entry = this.decoders.get(senderId);
    if (entry) entry.lastUsed = Date.now() - ageMs;
  }

  /**
   * Remove decoders that have been idle for longer than maxIdleMs.
   * Increased to 60s to avoid destroying Opus state mid-conversation.
   * @param {number} maxIdleMs — default 60000 (60 seconds)
   */
  cleanupIdleDecoders(maxIdleMs = 60000) {
    const now = Date.now();
    for (const [id, entry] of this.decoders) {
      if (now - entry.lastUsed > maxIdleMs) {
        try { entry.decoder.delete(); } catch (_) {}
        this.decoders.delete(id);
      }
    }
  }

  /** Clean up all resources (encoder + all decoders). */
  destroy() {
    if (this.encoder) {
      try { this.encoder.delete(); } catch (_) {}
      this.encoder = null;
    }
    for (const [, entry] of this.decoders) {
      try { entry.decoder.delete(); } catch (_) {}
    }
    this.decoders.clear();
  }

  // ── Mumble varint encoding/decoding ──

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
}

module.exports = Voice;
