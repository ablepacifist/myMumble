/**
 * AudioWorklet processor for voice chat.
 * Captures mic PCM and plays back received PCM via a ring buffer.
 *
 * Messages from main thread:
 *   { type: 'playback', samples: Float32Array }  — audio to play
 *   { type: 'mute', muted: boolean }             — mute/unmute mic
 *
 * Messages to main thread:
 *   { type: 'capture', samples: Int16Array }      — captured mic audio
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;

    // Ring buffer for playback (1 second @ 48kHz)
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;

    // Jitter buffer — wait for 3 frames (60ms) before starting playback
    this._jitterThreshold = 960 * 3;
    this._playing = false;

    this.port.onmessage = (e) => {
      if (e.data.type === 'playback') {
        this._writeToRing(e.data.samples);
      } else if (e.data.type === 'mute') {
        this.muted = e.data.muted;
      }
    };
  }

  _writeToRing(samples) {
    const len = samples.length;

    // Drop oldest if overflow
    if (this._buffered + len > this._ringSize) {
      const overflow = (this._buffered + len) - this._ringSize;
      this._readPos = (this._readPos + overflow) % this._ringSize;
      this._buffered -= overflow;
    }

    const spaceToEnd = this._ringSize - this._writePos;
    if (len <= spaceToEnd) {
      this._ring.set(samples, this._writePos);
    } else {
      this._ring.set(samples.subarray(0, spaceToEnd), this._writePos);
      this._ring.set(samples.subarray(spaceToEnd), 0);
    }
    this._writePos = (this._writePos + len) % this._ringSize;
    this._buffered += len;

    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  process(inputs, outputs) {
    // ── Capture mic ──
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

    // ── Playback ──
    const output = outputs[0];
    if (output && output[0]) {
      const outChannel = output[0];
      const needed = outChannel.length;

      if (!this._playing || this._buffered === 0) {
        outChannel.fill(0);
        if (this._playing && this._buffered === 0) {
          this._playing = false;
        }
      } else if (this._buffered >= needed) {
        const readEnd = this._readPos + needed;
        if (readEnd <= this._ringSize) {
          outChannel.set(this._ring.subarray(this._readPos, readEnd));
        } else {
          const first = this._ringSize - this._readPos;
          outChannel.set(this._ring.subarray(this._readPos, this._ringSize), 0);
          outChannel.set(this._ring.subarray(0, needed - first), first);
        }
        this._readPos = readEnd % this._ringSize;
        this._buffered -= needed;
      } else {
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
        this._playing = false;
      }
    }

    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
