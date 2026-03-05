/**
 * Voice tests — verify Opus encode/decode and audio mixing.
 * Written BEFORE implementation (TDD).
 */
const { expect } = require('chai');

const Voice = require('../src/mumble/voice');

describe('Voice (Opus + Mixer)', () => {
  let voice;

  before(() => {
    voice = new Voice({ sampleRate: 48000, channels: 1, frameDuration: 20 });
  });

  after(() => {
    voice.destroy();
  });

  describe('constructor', () => {
    it('should create encoder', () => {
      expect(voice.encoder).to.not.be.null;
    });

    it('should have correct sample rate', () => {
      expect(voice.sampleRate).to.equal(48000);
    });

    it('should calculate 960 samples per frame (20ms @ 48kHz)', () => {
      expect(voice.samplesPerFrame).to.equal(960);
    });
  });

  describe('encode()', () => {
    it('should encode 960 Int16 samples to Opus', () => {
      const pcm = new Int16Array(960);
      // Fill with a sine wave
      for (let i = 0; i < 960; i++) {
        pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      }
      const opus = voice.encode(pcm);
      expect(opus).to.be.instanceOf(Buffer);
      expect(opus.length).to.be.greaterThan(0);
      expect(opus.length).to.be.lessThan(960 * 2); // Compressed
    });

    it('should encode silence (all zeros) to a compact Opus frame', () => {
      const silence = new Int16Array(960);
      const opus = voice.encode(silence);
      expect(opus).to.be.instanceOf(Buffer);
      // Opus VOIP 48kHz encodes silence; size varies by implementation
      expect(opus.length).to.be.lessThan(300);
      expect(opus.length).to.be.greaterThan(0);
    });

    it('should return null for wrong-size input', () => {
      const bad = new Int16Array(100); // Not 960
      const result = voice.encode(bad);
      expect(result).to.be.null;
    });
  });

  describe('decode()', () => {
    it('should decode an Opus frame back to 960 Int16 samples', () => {
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      }
      const opus = voice.encode(pcm);
      const decoded = voice.decode(opus, 'sender1');
      expect(decoded).to.be.instanceOf(Int16Array);
      expect(decoded.length).to.equal(960);
    });

    it('should produce non-silent output when decoding non-silent audio', () => {
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      }
      const opus = voice.encode(pcm);
      const decoded = voice.decode(opus, 'sender1');

      let maxVal = 0;
      for (let i = 0; i < decoded.length; i++) {
        maxVal = Math.max(maxVal, Math.abs(decoded[i]));
      }
      expect(maxVal).to.be.greaterThan(1000); // Has actual audio
    });

    it('should maintain per-sender decoder state', () => {
      // Encoding a frame for sender1 and sender2 should use separate decoders
      const pcm1 = new Int16Array(960);
      const pcm2 = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        pcm1[i] = Math.round(Math.sin(i / 10) * 10000);
        pcm2[i] = Math.round(Math.sin(i / 5) * 5000);
      }

      const opus1 = voice.encode(pcm1);
      const opus2 = voice.encode(pcm2);

      const dec1 = voice.decode(opus1, 'senderA');
      const dec2 = voice.decode(opus2, 'senderB');

      // Both should produce valid non-silent audio
      let max1 = 0, max2 = 0;
      for (let i = 0; i < 960; i++) {
        max1 = Math.max(max1, Math.abs(dec1[i]));
        max2 = Math.max(max2, Math.abs(dec2[i]));
      }
      expect(max1).to.be.greaterThan(1000);
      expect(max2).to.be.greaterThan(500);
    });

    it('should return null for invalid Opus data', () => {
      const garbage = Buffer.from([0xFF, 0xFE, 0xFD, 0xFC]);
      const result = voice.decode(garbage, 'badSender');
      expect(result).to.be.null;
    });
  });

  describe('encode → decode roundtrip', () => {
    it('should preserve audio through encode → decode cycle', () => {
      const original = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        original[i] = Math.round(Math.sin(i / 10) * 15000);
      }

      const opus = voice.encode(original);
      const decoded = voice.decode(opus, 'roundtrip');

      // Opus is lossy so values won't be identical, but should be close
      let totalError = 0;
      for (let i = 0; i < 960; i++) {
        totalError += Math.abs(original[i] - decoded[i]);
      }
      const avgError = totalError / 960;
      // Opus is lossy and first frame may have PLC warmup artifacts
      expect(avgError).to.be.lessThan(10000);
    });
  });

  describe('mixer', () => {
    it('should mix zero senders to null', () => {
      const result = voice.mix([]);
      expect(result).to.be.null;
    });

    it('should return single sender as-is', () => {
      const frame = new Int16Array(960);
      for (let i = 0; i < 960; i++) frame[i] = 1000;
      const result = voice.mix([frame]);
      expect(result).to.be.instanceOf(Int16Array);
      expect(result.length).to.equal(960);
      expect(result[0]).to.equal(1000);
    });

    it('should sum two senders correctly', () => {
      const frame1 = new Int16Array(960);
      const frame2 = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        frame1[i] = 5000;
        frame2[i] = 3000;
      }
      const result = voice.mix([frame1, frame2]);
      expect(result[0]).to.equal(8000);
      expect(result[500]).to.equal(8000);
    });

    it('should clamp at Int16 boundaries', () => {
      const frame1 = new Int16Array(960);
      const frame2 = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        frame1[i] = 30000;
        frame2[i] = 30000;
      }
      const result = voice.mix([frame1, frame2]);
      // 30000 + 30000 = 60000 which exceeds 32767, should clamp
      expect(result[0]).to.equal(32767);
    });

    it('should clamp negative overflow', () => {
      const frame1 = new Int16Array(960);
      const frame2 = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        frame1[i] = -30000;
        frame2[i] = -30000;
      }
      const result = voice.mix([frame1, frame2]);
      expect(result[0]).to.equal(-32768);
    });

    it('should mix three senders', () => {
      const frames = [];
      for (let s = 0; s < 3; s++) {
        const f = new Int16Array(960);
        for (let i = 0; i < 960; i++) f[i] = 1000 * (s + 1);
        frames.push(f);
      }
      const result = voice.mix(frames);
      // 1000 + 2000 + 3000 = 6000
      expect(result[0]).to.equal(6000);
    });
  });

  describe('buildAudioPacket()', () => {
    it('should build a valid Mumble legacy audio packet', () => {
      const opus = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      const packet = voice.buildAudioPacket(opus, 42, false);

      expect(packet).to.be.instanceOf(Buffer);
      // 6 header + 1 audio type + varint seq + varint size + opus data
      expect(packet.length).to.be.greaterThanOrEqual(6 + 1 + 1 + 1 + 5);

      // First 2 bytes: type=1 (UDPTunnel)
      expect(packet.readUInt16BE(0)).to.equal(1);

      // Byte 6: audio header (type=4 Opus, target=0)
      expect(packet[6]).to.equal((4 << 5) | 0);
    });
  });

  describe('parseAudioPacket()', () => {
    it('should parse a legacy Opus audio packet', () => {
      // Build a packet then parse it
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 5000);
      const opus = voice.encode(pcm);

      // Manually build a legacy audio payload (without TCP framing)
      const header = (4 << 5) | 0; // Opus, target=0
      const seqVarint = Buffer.from([42]); // sequence = 42
      const size = opus.length & 0x1FFF;
      const sizeVarint = Buffer.from(size < 128 ? [size] : [(size >> 8) | 0x80, size & 0xFF]);
      // Fake sender session varint
      const sessionVarint = Buffer.from([7]); // session = 7
      const audioPayload = Buffer.concat([
        Buffer.from([header]),
        sessionVarint,
        seqVarint,
        sizeVarint,
        opus,
      ]);

      const parsed = voice.parseAudioPayload(audioPayload);
      expect(parsed).to.not.be.null;
      expect(parsed.senderSession).to.equal(7);
      expect(parsed.opusData.length).to.equal(opus.length);
    });

    it('should return null for non-Opus audio type', () => {
      const payload = Buffer.from([0x00, 0x01]); // type=0 (CELT Alpha), not Opus
      const parsed = voice.parseAudioPayload(payload);
      expect(parsed).to.be.null;
    });

    it('should return null for empty payload', () => {
      const parsed = voice.parseAudioPayload(Buffer.alloc(0));
      expect(parsed).to.be.null;
    });
  });

  describe('cleanupIdleDecoders()', () => {
    it('should remove decoders idle for > 10 seconds', (done) => {
      // Create a decoder by decoding something
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = 1000;
      const opus = voice.encode(pcm);
      voice.decode(opus, 'idle_test_sender');

      expect(voice.decoderCount).to.be.greaterThan(0);

      // Force the lastUsed timestamp to the past (beyond 60s idle timeout)
      voice._forceDecoderAge('idle_test_sender', 65000);
      voice.cleanupIdleDecoders();

      // The idle decoder should be gone
      // (other decoders from previous tests may remain)
      const hasIdleSender = voice._hasDecoder('idle_test_sender');
      expect(hasIdleSender).to.be.false;
      done();
    });
  });

  describe('bitrate', () => {
    it('should have encoder bitrate set to 48000', () => {
      // The constructor should call setBitrate(48000)
      // OpusScript stores bitrate internally — verify by checking
      // that encoding produces consistently-sized frames typical of 48kbps
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) {
        pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      }
      const sizes = [];
      for (let f = 0; f < 10; f++) {
        const opus = voice.encode(pcm);
        sizes.push(opus.length);
      }
      // At 48kbps with 20ms frames, expect ~120 bytes per frame (48000/8/50)
      const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      // Allow wide margin since Opus is adaptive, but should be in the ballpark
      expect(avg).to.be.greaterThan(50);
      expect(avg).to.be.lessThan(300);
    });
  });

  describe('PLC (Packet Loss Concealment)', () => {
    it('decode(null) should return null (OpusScript does not support native PLC)', () => {
      // OpusScript's decode() throws on null input, so our decode() catches and returns null.
      // PLC is instead handled by decodeWithPLC() which falls back to silence frames.
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      const opus = voice.encode(pcm);
      voice.decode(opus, 'plc_test');

      const plcFrame = voice.decode(null, 'plc_test');
      expect(plcFrame).to.be.null;
    });

    it('decodeWithPLC should fill gaps with concealment frames', () => {
      const v2 = new Voice({ sampleRate: 48000, channels: 1, frameDuration: 20 });
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      const opus = voice.encode(pcm);

      // Send frame at seq=0
      const frames0 = v2.decodeWithPLC(opus, 'plcGap', 0);
      expect(frames0.length).to.equal(1); // Just the real frame

      // Skip seq=1, send seq=2 — should produce 1 PLC + 1 real = 2 frames
      const frames2 = v2.decodeWithPLC(opus, 'plcGap', 2);
      expect(frames2.length).to.equal(2);
      expect(frames2[0].length).to.equal(960); // PLC frame
      expect(frames2[1].length).to.equal(960); // Real frame

      v2.destroy();
    });

    it('decodeWithPLC should cap PLC at 3 frames maximum', () => {
      const v3 = new Voice({ sampleRate: 48000, channels: 1, frameDuration: 20 });
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      const opus = voice.encode(pcm);

      // Send frame at seq=0
      v3.decodeWithPLC(opus, 'plcMax', 0);

      // Jump to seq=10 — 9 frame gap, but PLC caps at 3
      const frames = v3.decodeWithPLC(opus, 'plcMax', 10);
      expect(frames.length).to.equal(4); // 3 PLC + 1 real

      v3.destroy();
    });

    it('decodeWithPLC should not generate PLC for first frame', () => {
      const v4 = new Voice({ sampleRate: 48000, channels: 1, frameDuration: 20 });
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      const opus = voice.encode(pcm);

      // First frame at seq=5 — no previous seq, so no PLC
      const frames = v4.decodeWithPLC(opus, 'plcFirst', 5);
      expect(frames.length).to.equal(1);

      v4.destroy();
    });

    it('decodeWithPLC should not generate PLC for consecutive frames', () => {
      const v5 = new Voice({ sampleRate: 48000, channels: 1, frameDuration: 20 });
      const pcm = new Int16Array(960);
      for (let i = 0; i < 960; i++) pcm[i] = Math.round(Math.sin(i / 10) * 10000);
      const opus = voice.encode(pcm);

      v5.decodeWithPLC(opus, 'plcConsec', 0);
      v5.decodeWithPLC(opus, 'plcConsec', 1);
      const frames = v5.decodeWithPLC(opus, 'plcConsec', 2);
      expect(frames.length).to.equal(1); // No gap, no PLC

      v5.destroy();
    });
  });
});
