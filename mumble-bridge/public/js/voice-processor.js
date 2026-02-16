/**
 * AudioWorklet processor for voice chat.
 * Runs on the audio thread — captures mic PCM and plays received PCM.
 *
 * Uses a ring buffer for playback to avoid GC pressure on the audio thread.
 * Includes a small jitter buffer to smooth out network timing variations.
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
    // Wait until we have at least this many samples before we start playing.
    // This absorbs network timing variations. 960 samples = 20ms = 1 Opus frame.
    this._jitterThreshold = 960 * 2; // 40ms — 2 Opus frames
    this._playing = false;

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

      if (!this._playing || this._buffered === 0) {
        // Not enough data yet or nothing to play — output silence
        outChannel.fill(0);
        // If buffer ran dry, reset jitter gate so we re-buffer
        if (this._playing && this._buffered === 0) {
          this._playing = false;
        }
      } else if (this._buffered >= needed) {
        // Read from ring buffer
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
      } else {
        // Partial data — output what we have + silence
        const avail = this._buffered;
        if (this._readPos + avail <= this._ringSize) {
          outChannel.set(this._ring.subarray(this._readPos, this._readPos + avail), 0);
        } else {
          const first = this._ringSize - this._readPos;
          outChannel.set(this._ring.subarray(this._readPos, this._ringSize), 0);
          outChannel.set(this._ring.subarray(0, avail - first), first);
        }
        // Silence the rest
        for (let i = avail; i < needed; i++) {
          outChannel[i] = 0;
        }
        this._readPos = (this._readPos + avail) % this._ringSize;
        this._buffered = 0;
        this._playing = false; // Re-buffer before playing again
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('voice-processor', VoiceProcessor);
