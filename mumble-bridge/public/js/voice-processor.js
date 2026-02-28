/**
 * AudioWorklet processor for voice chat.
 * Runs on the audio thread — captures mic PCM and plays received PCM.
 *
 * Uses a ring buffer for playback to avoid GC pressure on the audio thread.
 * Includes an adaptive jitter buffer that won't reset on brief gaps.
 *
 * Messages from main thread:
 *   { type: 'playback', samples: Float32Array }  — audio to play out speakers
 *   { type: 'mute', muted: boolean }             — mute/unmute mic
 *
 * Messages to main thread:
 *   { type: 'capture', samples: Int16Array }  — mic audio captured
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;

    // ── Ring buffer for playback (avoids constant allocation) ──
    // 1 second at 48kHz — plenty of room without being wasteful
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;   // Next position to write incoming audio
    this._readPos = 0;    // Next position to read for output
    this._buffered = 0;   // Number of samples currently in the ring

    // ── Jitter buffer ──
    // Initial buffering: wait until we have this many samples before starting.
    // 960 samples = 20ms = 1 Opus frame. We buffer 3 frames (60ms) initially
    // to absorb TCP batching — production logs show 12% of frames arrive in
    // <2ms bursts due to Nagle's algorithm and TCP segment coalescing.
    this._jitterThreshold = 960 * 3; // 60ms — 3 Opus frames
    this._playing = false;

    // Once playing, DON'T reset on brief gaps. Instead, output silence from
    // the ring buffer and only stop after sustained silence (no new data for
    // ~100ms = 4800 samples worth of output without any new writes).
    // This prevents the aggressive re-buffer that was causing frame drops
    // when network jitter caused momentary gaps between Opus frames.
    this._drySamples = 0;               // samples of silence output since last write
    this._dryThreshold = 960 * 5;       // 100ms — stop only after this much silence

    this.port.onmessage = (e) => {
      if (e.data.type === 'playback') {
        this._writeToRing(e.data.samples);
      } else if (e.data.type === 'mute') {
        this.muted = e.data.muted;
      }
    };
  }

  /**
   * Write incoming samples into the ring buffer.
   */
  _writeToRing(samples) {
    const len = samples.length;

    // If buffer would overflow, drop oldest audio to make room
    if (this._buffered + len > this._ringSize) {
      const overflow = (this._buffered + len) - this._ringSize;
      this._readPos = (this._readPos + overflow) % this._ringSize;
      this._buffered -= overflow;
    }

    // Write samples into ring, wrapping around if needed
    const spaceToEnd = this._ringSize - this._writePos;
    if (len <= spaceToEnd) {
      this._ring.set(samples, this._writePos);
    } else {
      // Split write across the wrap boundary
      this._ring.set(samples.subarray(0, spaceToEnd), this._writePos);
      this._ring.set(samples.subarray(spaceToEnd), 0);
    }
    this._writePos = (this._writePos + len) % this._ringSize;
    this._buffered += len;

    // Reset dry counter — we got new data
    this._drySamples = 0;

    // Start playing once we've buffered enough (jitter buffer)
    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  process(inputs, outputs) {
    // ── Capture: send mic audio to main thread ──
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0 && !this.muted) {
      const float32 = input[0];
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage({ type: 'capture', samples: int16 }, [int16.buffer]);
    }

    // ── Playback: output received audio to speakers ──
    const output = outputs[0];
    if (output && output[0]) {
      const outChannel = output[0];
      const needed = outChannel.length; // typically 128

      if (!this._playing) {
        // Haven't buffered enough yet — output silence
        outChannel.fill(0);
      } else if (this._buffered >= needed) {
        // Normal path: read from ring buffer
        const readEnd = this._readPos + needed;
        if (readEnd <= this._ringSize) {
          outChannel.set(this._ring.subarray(this._readPos, readEnd));
        } else {
          // Split read across wrap boundary
          const first = this._ringSize - this._readPos;
          outChannel.set(this._ring.subarray(this._readPos, this._ringSize), 0);
          outChannel.set(this._ring.subarray(0, needed - first), first);
        }
        this._readPos = readEnd % this._ringSize;
        this._buffered -= needed;
        this._drySamples = 0;
      } else if (this._buffered > 0) {
        // Partial data — output what we have + silence for the rest
        const avail = this._buffered;
        if (this._readPos + avail <= this._ringSize) {
          outChannel.set(this._ring.subarray(this._readPos, this._readPos + avail), 0);
        } else {
          const first = this._ringSize - this._readPos;
          outChannel.set(this._ring.subarray(this._readPos, this._ringSize), 0);
          outChannel.set(this._ring.subarray(0, avail - first), first);
        }
        for (let i = avail; i < needed; i++) outChannel[i] = 0;
        this._readPos = (this._readPos + avail) % this._ringSize;
        this._buffered = 0;
        this._drySamples += (needed - avail);
      } else {
        // Buffer empty — output silence but DON'T immediately reset.
        // Only reset after sustained silence so brief jitter gaps don't
        // cause the 40ms re-buffer penalty.
        outChannel.fill(0);
        this._drySamples += needed;
        if (this._drySamples >= this._dryThreshold) {
          this._playing = false;
          this._drySamples = 0;
        }
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('voice-processor', VoiceProcessor);
