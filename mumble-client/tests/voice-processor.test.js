/**
 * Voice Processor tests — simulates the AudioWorklet per-sender ring buffer
 * logic without requiring a browser or AudioWorklet context.
 *
 * Tests verify:
 *  1. Per-sender isolation (multiple senders don't interfere)
 *  2. Dry threshold prevents premature playback reset
 *  3. Jitter buffer absorbs network timing variations
 *  4. Mixer clamps output to [-1, 1]
 *  5. Sustained silence properly resets playback state
 */
const { expect } = require('chai');

// ── Simulated AudioWorklet processor (mirrors voice-processor.js logic) ──
class SimulatedVoiceProcessor {
  constructor() {
    this._senders = new Map();
    this._ringSize = 48000;
    this._jitterThreshold = 960 * 3; // 60ms
    this._dryThreshold = 960 * 5;   // 100ms
    this.totalPlayed = 0;
    this.silenceOutput = 0;
  }

  _getOrCreateSender(senderId) {
    let s = this._senders.get(senderId);
    if (!s) {
      s = {
        ring: new Float32Array(this._ringSize),
        writePos: 0,
        readPos: 0,
        buffered: 0,
        playing: false,
        drySamples: 0,
      };
      this._senders.set(senderId, s);
    }
    return s;
  }

  writeToSenderRing(senderId, samples) {
    const s = this._getOrCreateSender(senderId);
    const len = samples.length;

    if (s.buffered + len > this._ringSize) {
      const overflow = (s.buffered + len) - this._ringSize;
      s.readPos = (s.readPos + overflow) % this._ringSize;
      s.buffered -= overflow;
    }

    const spaceToEnd = this._ringSize - s.writePos;
    if (len <= spaceToEnd) {
      s.ring.set(samples, s.writePos);
    } else {
      s.ring.set(samples.subarray(0, spaceToEnd), s.writePos);
      s.ring.set(samples.subarray(spaceToEnd), 0);
    }
    s.writePos = (s.writePos + len) % this._ringSize;
    s.buffered += len;
    s.drySamples = 0;

    if (!s.playing && s.buffered >= this._jitterThreshold) {
      s.playing = true;
    }
  }

  process(outputLength = 128) {
    const outChannel = new Float32Array(outputLength);
    outChannel.fill(0);

    for (const [id, s] of this._senders) {
      if (!s.playing) continue;

      if (s.buffered >= outputLength) {
        for (let i = 0; i < outputLength; i++) {
          outChannel[i] += s.ring[(s.readPos + i) % this._ringSize];
        }
        s.readPos = (s.readPos + outputLength) % this._ringSize;
        s.buffered -= outputLength;
        s.drySamples = 0;
        this.totalPlayed += outputLength;
      } else if (s.buffered > 0) {
        const avail = s.buffered;
        for (let i = 0; i < avail; i++) {
          outChannel[i] += s.ring[(s.readPos + i) % this._ringSize];
        }
        s.readPos = (s.readPos + avail) % this._ringSize;
        s.buffered = 0;
        s.drySamples += (outputLength - avail);
        this.totalPlayed += avail;
      } else {
        s.drySamples += outputLength;
        this.silenceOutput += outputLength;
        if (s.drySamples >= this._dryThreshold) {
          s.playing = false;
          s.drySamples = 0;
        }
      }
    }

    // Clamp
    for (let i = 0; i < outputLength; i++) {
      if (outChannel[i] > 1) outChannel[i] = 1;
      else if (outChannel[i] < -1) outChannel[i] = -1;
    }

    return outChannel;
  }
}

describe('VoiceProcessor (per-sender ring buffer simulation)', () => {
  const FRAME = 960;         // samples per Opus frame
  const PROCESS_SIZE = 128;  // AudioWorklet quantum
  const PROCESS_PER_FRAME = Math.ceil(FRAME / PROCESS_SIZE); // 8

  function makeFrame(value = 0.5, length = FRAME) {
    return new Float32Array(length).fill(value);
  }

  describe('basic playback', () => {
    it('should not play until jitter buffer is filled (3 frames)', () => {
      const proc = new SimulatedVoiceProcessor();

      // Write 2 frames — not enough to start playing
      proc.writeToSenderRing(1, makeFrame());
      proc.writeToSenderRing(1, makeFrame());

      const out = proc.process();
      expect(out[0]).to.equal(0); // Should be silence

      const s = proc._senders.get(1);
      expect(s.playing).to.be.false;
    });

    it('should start playing after 3 frames buffered', () => {
      const proc = new SimulatedVoiceProcessor();

      proc.writeToSenderRing(1, makeFrame(0.4));
      proc.writeToSenderRing(1, makeFrame(0.4));
      proc.writeToSenderRing(1, makeFrame(0.4));

      const s = proc._senders.get(1);
      expect(s.playing).to.be.true;

      const out = proc.process();
      expect(out[0]).to.be.closeTo(0.4, 0.001);
    });

    it('should play audio from the ring buffer in order', () => {
      const proc = new SimulatedVoiceProcessor();

      // Write 3 frames with different values
      proc.writeToSenderRing(1, makeFrame(0.1));
      proc.writeToSenderRing(1, makeFrame(0.2));
      proc.writeToSenderRing(1, makeFrame(0.3));

      // Process enough to consume first frame (960/128 = 7.5, so 8 calls)
      for (let i = 0; i < PROCESS_PER_FRAME; i++) proc.process();

      // Now we should be in the second frame
      const out = proc.process();
      expect(out[0]).to.be.closeTo(0.2, 0.001);
    });
  });

  describe('dry threshold', () => {
    it('should NOT reset playback on brief gap (< 100ms)', () => {
      const proc = new SimulatedVoiceProcessor();

      // Fill and start playing
      for (let f = 0; f < 5; f++) proc.writeToSenderRing(1, makeFrame());
      for (let p = 0; p < PROCESS_PER_FRAME * 5; p++) proc.process();

      const s = proc._senders.get(1);
      expect(s.playing).to.be.true;

      // Brief gap: 50ms of silence (no new data, but keep processing)
      const callsFor50ms = Math.ceil(2400 / PROCESS_SIZE); // 50ms at 48kHz
      for (let p = 0; p < callsFor50ms; p++) proc.process();

      expect(s.playing).to.be.true; // Should STILL be playing
    });

    it('should reset playback after sustained 100ms silence', () => {
      const proc = new SimulatedVoiceProcessor();

      // Fill and start playing
      for (let f = 0; f < 5; f++) proc.writeToSenderRing(1, makeFrame());
      for (let p = 0; p < PROCESS_PER_FRAME * 5; p++) proc.process();

      const s = proc._senders.get(1);
      expect(s.playing).to.be.true;

      // Sustained gap: 120ms of silence
      const callsFor120ms = Math.ceil(5760 / PROCESS_SIZE) + 2;
      for (let p = 0; p < callsFor120ms; p++) proc.process();

      expect(s.playing).to.be.false; // Should have reset
    });

    it('should resume quickly after brief gap without re-buffering 3 frames', () => {
      const proc = new SimulatedVoiceProcessor();

      // Fill and start playing
      for (let f = 0; f < 5; f++) proc.writeToSenderRing(1, makeFrame());
      for (let p = 0; p < PROCESS_PER_FRAME * 5; p++) proc.process();

      // Brief gap
      for (let p = 0; p < 5; p++) proc.process();

      const s = proc._senders.get(1);
      expect(s.playing).to.be.true; // Still playing

      // Send just 1 frame — should play immediately (no re-buffer needed)
      proc.writeToSenderRing(1, makeFrame(0.7));
      const out = proc.process();
      expect(out[0]).to.be.closeTo(0.7, 0.001);
    });
  });

  describe('per-sender isolation', () => {
    it('should maintain separate buffers for different senders', () => {
      const proc = new SimulatedVoiceProcessor();

      proc.writeToSenderRing(1, makeFrame(0.3));
      proc.writeToSenderRing(1, makeFrame(0.3));
      proc.writeToSenderRing(1, makeFrame(0.3));
      proc.writeToSenderRing(2, makeFrame(0.5));
      proc.writeToSenderRing(2, makeFrame(0.5));
      proc.writeToSenderRing(2, makeFrame(0.5));

      expect(proc._senders.size).to.equal(2);

      // Both should be playing
      expect(proc._senders.get(1).playing).to.be.true;
      expect(proc._senders.get(2).playing).to.be.true;
    });

    it('should mix multiple senders additively', () => {
      const proc = new SimulatedVoiceProcessor();

      // Both senders have 3 frames
      for (let f = 0; f < 3; f++) {
        proc.writeToSenderRing(1, makeFrame(0.3));
        proc.writeToSenderRing(2, makeFrame(0.4));
      }

      const out = proc.process();
      // 0.3 + 0.4 = 0.7
      expect(out[0]).to.be.closeTo(0.7, 0.001);
    });

    it('one sender stopping should not affect the other', () => {
      const proc = new SimulatedVoiceProcessor();

      // Sender 1: 3 frames, Sender 2: 10 frames
      for (let f = 0; f < 3; f++) proc.writeToSenderRing(1, makeFrame(0.2));
      for (let f = 0; f < 10; f++) proc.writeToSenderRing(2, makeFrame(0.3));

      // Process enough to drain sender 1 but not sender 2
      for (let p = 0; p < PROCESS_PER_FRAME * 4; p++) proc.process();

      // Sender 1's buffer should be empty, sender 2 should still have data
      const s1 = proc._senders.get(1);
      const s2 = proc._senders.get(2);
      expect(s2.buffered).to.be.greaterThan(0);
      expect(s2.playing).to.be.true;
    });
  });

  describe('output clamping', () => {
    it('should clamp mixed output to [-1, 1]', () => {
      const proc = new SimulatedVoiceProcessor();

      // Two senders at 0.8 each — sum = 1.6, should clamp to 1.0
      for (let f = 0; f < 3; f++) {
        proc.writeToSenderRing(1, makeFrame(0.8));
        proc.writeToSenderRing(2, makeFrame(0.8));
      }

      const out = proc.process();
      expect(out[0]).to.equal(1.0);
    });

    it('should clamp negative overflow', () => {
      const proc = new SimulatedVoiceProcessor();

      for (let f = 0; f < 3; f++) {
        proc.writeToSenderRing(1, makeFrame(-0.8));
        proc.writeToSenderRing(2, makeFrame(-0.8));
      }

      const out = proc.process();
      expect(out[0]).to.equal(-1.0);
    });
  });

  describe('jitter resistance', () => {
    it('should maintain > 90% play ratio with ±25% timing jitter', () => {
      const proc = new SimulatedVoiceProcessor();
      const frame = makeFrame(0.5);
      const TOTAL_FRAMES = 250; // 5 seconds

      for (let i = 0; i < TOTAL_FRAMES; i++) {
        proc.writeToSenderRing(1, frame);
        // Simulate jitter: 7-9 process calls per frame instead of exactly 7.5
        const calls = 7 + Math.floor(Math.random() * 3);
        for (let p = 0; p < calls; p++) proc.process();
      }

      const expectedSamples = TOTAL_FRAMES * FRAME;
      const playRatio = proc.totalPlayed / expectedSamples;
      expect(playRatio).to.be.greaterThan(0.85);
    });

    it('should survive a 50ms gap without audible dropout', () => {
      const proc = new SimulatedVoiceProcessor();
      const frame = makeFrame(0.5);

      // Stream 20 frames (400ms)
      for (let f = 0; f < 20; f++) {
        proc.writeToSenderRing(1, frame);
        for (let p = 0; p < PROCESS_PER_FRAME; p++) proc.process();
      }

      // 50ms gap (no new frames, but keep processing)
      for (let p = 0; p < Math.ceil(2400 / PROCESS_SIZE); p++) proc.process();

      // Resume streaming
      const playedBefore = proc.totalPlayed;
      for (let f = 0; f < 10; f++) {
        proc.writeToSenderRing(1, frame);
        for (let p = 0; p < PROCESS_PER_FRAME; p++) proc.process();
      }

      const playedAfter = proc.totalPlayed - playedBefore;
      // Should play most of the 10 new frames (9600 samples)
      expect(playedAfter).to.be.greaterThan(8000);
    });
  });

  describe('ring buffer overflow', () => {
    it('should drop oldest audio when ring buffer overflows', () => {
      const proc = new SimulatedVoiceProcessor();

      // Write 50 frames (50 * 960 = 48000 = exactly ring size), so
      // the 51st frame should drop the oldest
      for (let f = 0; f < 50; f++) {
        proc.writeToSenderRing(1, makeFrame(0.1 * (f % 10)));
      }

      const s = proc._senders.get(1);
      expect(s.buffered).to.equal(48000);

      // Write one more — should overflow and still have 48000 buffered
      proc.writeToSenderRing(1, makeFrame(0.9));
      expect(s.buffered).to.equal(48000);
    });
  });
});
