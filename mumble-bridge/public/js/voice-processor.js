/**
 * AudioWorklet processor for voice chat.
 * Runs on the audio thread — captures mic PCM and plays received PCM.
 *
 * Uses per-sender ring buffers so multiple speakers are mixed at hardware
 * clock precision. Each sender gets independent jitter buffering, and the
 * process() callback additively mixes all active senders every 128 samples
 * (~2.67ms at 48kHz). This eliminates the Node.js setInterval timing jitter
 * that was causing 9-13% of frames to arrive at 40ms instead of 20ms.
 *
 * Messages from main thread:
 *   { type: 'playback', senderId: number, samples: Float32Array }  — audio from a specific sender
 *   { type: 'mute', muted: boolean }                                — mute/unmute mic
 *
 * Messages to main thread:
 *   { type: 'capture', samples: Int16Array }  — mic audio captured
 */
class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.muted = false;

    // ── Per-sender ring buffers for playback ──
    // Each Mumble user gets their own ring buffer with independent jitter
    // buffering. This means each sender's audio stream absorbs its own
    // network jitter without affecting other senders.
    this._senders = new Map(); // senderId -> sender state object
    this._ringSize = 48000;    // 1 second at 48kHz per sender

    // ── Jitter buffer settings ──
    // Initial buffering: wait until we have this many samples before starting.
    // 960 samples = 20ms = 1 Opus frame. Buffer 3 frames (60ms) initially.
    this._jitterThreshold = 960 * 3; // 60ms — 3 Opus frames

    // Once playing, DON'T reset on brief gaps. Only stop after sustained
    // silence (~100ms) to prevent re-buffer penalty on momentary jitter.
    this._dryThreshold = 960 * 5; // 100ms

    this.port.onmessage = (e) => {
      if (e.data.type === 'playback') {
        this._writeToSenderRing(e.data.senderId, e.data.samples);
      } else if (e.data.type === 'mute') {
        this.muted = e.data.muted;
      }
    };
  }

  /**
   * Get or create a ring buffer for a specific sender.
   */
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

  /**
   * Write incoming samples into a specific sender's ring buffer.
   */
  _writeToSenderRing(senderId, samples) {
    const s = this._getOrCreateSender(senderId);
    const len = samples.length;

    // If buffer would overflow, drop oldest audio to make room
    if (s.buffered + len > this._ringSize) {
      const overflow = (s.buffered + len) - this._ringSize;
      s.readPos = (s.readPos + overflow) % this._ringSize;
      s.buffered -= overflow;
    }

    // Write samples into ring, wrapping around if needed
    const spaceToEnd = this._ringSize - s.writePos;
    if (len <= spaceToEnd) {
      s.ring.set(samples, s.writePos);
    } else {
      s.ring.set(samples.subarray(0, spaceToEnd), s.writePos);
      s.ring.set(samples.subarray(spaceToEnd), 0);
    }
    s.writePos = (s.writePos + len) % this._ringSize;
    s.buffered += len;

    // Reset dry counter — we got new data for this sender
    s.drySamples = 0;

    // Start playing once we've buffered enough (jitter buffer filled)
    if (!s.playing && s.buffered >= this._jitterThreshold) {
      s.playing = true;
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

    // ── Playback: mix all sender buffers to output ──
    const output = outputs[0];
    if (output && output[0]) {
      const outChannel = output[0];
      const needed = outChannel.length; // typically 128 samples

      // Start with silence
      outChannel.fill(0);

      for (const [id, s] of this._senders) {
        if (!s.playing) continue;

        if (s.buffered >= needed) {
          // Normal path: read from this sender's ring buffer and ADD to output
          for (let i = 0; i < needed; i++) {
            outChannel[i] += s.ring[(s.readPos + i) % this._ringSize];
          }
          s.readPos = (s.readPos + needed) % this._ringSize;
          s.buffered -= needed;
          s.drySamples = 0;
        } else if (s.buffered > 0) {
          // Partial data — read what we have, rest stays silence
          const avail = s.buffered;
          for (let i = 0; i < avail; i++) {
            outChannel[i] += s.ring[(s.readPos + i) % this._ringSize];
          }
          s.readPos = (s.readPos + avail) % this._ringSize;
          s.buffered = 0;
          s.drySamples += (needed - avail);
        } else {
          // No data from this sender — count dry samples
          s.drySamples += needed;
          if (s.drySamples >= this._dryThreshold) {
            // Sender has been silent long enough — stop playing
            // (will re-buffer on next audio arrival)
            s.playing = false;
            s.drySamples = 0;
          }
        }
      }

      // Clamp output to [-1, 1] to prevent distortion from mixing
      for (let i = 0; i < needed; i++) {
        if (outChannel[i] > 1) outChannel[i] = 1;
        else if (outChannel[i] < -1) outChannel[i] = -1;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('voice-processor', VoiceProcessor);
