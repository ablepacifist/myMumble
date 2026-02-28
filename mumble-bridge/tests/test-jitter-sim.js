#!/usr/bin/env node
/**
 * DIAGNOSTIC: Jitter Buffer Frame Drop Simulation
 *
 * The voice-processor.js AudioWorklet uses a ring buffer with a jitter gate:
 *   - Waits until 3 frames (2880 samples, 60ms) are buffered before playing
 *   - When buffer runs dry, RESETS _playing to false → needs 3 frames again
 *
 * This test simulates the exact AudioWorklet algorithm with realistic timing
 * to prove whether the jitter buffer causes frame drops.
 *
 * We simulate:
 *   - Frames arriving at ~20ms intervals WITH jitter (±0-10ms)
 *   - process() draining at 128 samples per 2.67ms render quantum
 *   - Count: received frames vs actually "played" samples
 *
 * If played < received, the jitter buffer is dropping frames (choppy audio).
 *
 * Usage:
 *   node tests/test-jitter-sim.js
 */

// ── Replicate voice-processor.js algorithm exactly ──
class SimulatedWorklet {
  constructor(label) {
    this.label = label;
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    this._jitterThreshold = 960 * 3; // 2880 samples = 60ms
    this._playing = false;

    // Counters
    this.framesReceived = 0;
    this.samplesWritten = 0;
    this.samplesPlayed = 0;
    this.samplesSilence = 0;
    this.underruns = 0;       // times buffer ran dry during playback
    this.reBufferEvents = 0;  // times _playing was reset to false
  }

  /** Simulate receiving a frame from the server (called at ~20ms + jitter). */
  writeFrame(samples) {
    this.framesReceived++;
    const len = samples.length;

    // Overflow check (same as voice-processor.js)
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
    this.samplesWritten += len;

    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  /** Simulate process() — called every ~2.67ms, reads 128 samples. */
  process() {
    const needed = 128;

    if (!this._playing || this._buffered === 0) {
      this.samplesSilence += needed;
      // THIS IS THE KEY LINE — when buffer is dry and _playing was true,
      // it resets _playing to false, requiring 3 frames to restart
      if (this._playing && this._buffered === 0) {
        this._playing = false;
        this.reBufferEvents++;
        this.underruns++;
      }
      return;
    }

    if (this._buffered >= needed) {
      this._readPos = (this._readPos + needed) % this._ringSize;
      this._buffered -= needed;
      this.samplesPlayed += needed;
    } else {
      // Partial
      const avail = this._buffered;
      this.samplesPlayed += avail;
      this.samplesSilence += (needed - avail);
      this._readPos = (this._readPos + avail) % this._ringSize;
      this._buffered = 0;
      this._playing = false; // ← THE BUG: re-triggers jitter gate
      this.reBufferEvents++;
      this.underruns++;
    }
  }
}

// ── Same but with the FIX: don't reset _playing on underrun ──
class FixedWorklet {
  constructor(label) {
    this.label = label;
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    this._jitterThreshold = 960 * 2; // reduced to 2 frames (40ms) for faster start
    this._playing = false;

    this.framesReceived = 0;
    this.samplesWritten = 0;
    this.samplesPlayed = 0;
    this.samplesSilence = 0;
    this.underruns = 0;
    this.reBufferEvents = 0;
  }

  writeFrame(samples) {
    this.framesReceived++;
    const len = samples.length;

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
    this.samplesWritten += len;

    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  process() {
    const needed = 128;

    if (!this._playing) {
      // Initial startup — waiting for jitter buffer fill
      this.samplesSilence += needed;
      return;
    }

    if (this._buffered >= needed) {
      this._readPos = (this._readPos + needed) % this._ringSize;
      this._buffered -= needed;
      this.samplesPlayed += needed;
    } else if (this._buffered > 0) {
      // Partial — play what we have, pad silence, but DON'T reset _playing
      this.samplesPlayed += this._buffered;
      this.samplesSilence += (needed - this._buffered);
      this._readPos = (this._readPos + this._buffered) % this._ringSize;
      this._buffered = 0;
      this.underruns++;
      // FIX: _playing stays true — next frame plays immediately
    } else {
      // Empty — output silence but DON'T reset _playing
      this.samplesSilence += needed;
      this.underruns++;
      // FIX: _playing stays true — no 60ms re-buffer delay
    }
  }
}

function runSimulation(WorkletClass, label, jitterMs) {
  const worklet = new WorkletClass(label);

  const DURATION_MS = 5000;        // 5 seconds of audio
  const FRAME_SAMPLES = 960;       // 20ms @ 48kHz
  const PROCESS_INTERVAL_MS = 128 / 48; // ~2.67ms
  const FRAME_INTERVAL_MS = 20;

  // Simulation clock
  let clock = 0;
  let nextFrameTime = 0;
  let nextProcessTime = 0;
  const frame = new Float32Array(FRAME_SAMPLES);
  frame.fill(0.5); // non-silent audio
  let framesSent = 0;

  while (clock < DURATION_MS) {
    // Time to write a frame?
    if (clock >= nextFrameTime && framesSent < DURATION_MS / FRAME_INTERVAL_MS) {
      worklet.writeFrame(frame);
      framesSent++;
      // Next frame at 20ms + random jitter
      const jitter = (Math.random() * 2 - 1) * jitterMs;
      nextFrameTime = clock + FRAME_INTERVAL_MS + jitter;
    }

    // Time to run process()?
    if (clock >= nextProcessTime) {
      worklet.process();
      nextProcessTime = clock + PROCESS_INTERVAL_MS;
    }

    // Advance clock by smallest step
    const nextEvent = Math.min(
      nextFrameTime < DURATION_MS ? nextFrameTime : Infinity,
      nextProcessTime
    );
    clock = Math.max(clock + 0.01, nextEvent); // avoid infinite loop
  }

  // Drain remaining samples
  for (let i = 0; i < 200; i++) worklet.process();

  return worklet;
}

function printResults(worklet, jitterMs) {
  const totalExpected = worklet.samplesWritten;
  const playRatio = totalExpected > 0 ? worklet.samplesPlayed / totalExpected : 0;
  const lostSamples = totalExpected - worklet.samplesPlayed;
  const lostFrames = Math.round(lostSamples / 960);

  console.log(`  ${worklet.label} (jitter ±${jitterMs}ms):`);
  console.log(`    Frames received:    ${worklet.framesReceived}`);
  console.log(`    Samples written:    ${worklet.samplesWritten}`);
  console.log(`    Samples played:     ${worklet.samplesPlayed}`);
  console.log(`    Samples silence:    ${worklet.samplesSilence}`);
  console.log(`    Play ratio:         ${(playRatio * 100).toFixed(1)}%`);
  console.log(`    Buffer underruns:   ${worklet.underruns}`);
  console.log(`    Re-buffer events:   ${worklet.reBufferEvents}`);
  console.log(`    Lost (est frames):  ~${lostFrames}`);

  if (playRatio < 0.9) {
    console.log(`    ❌ SIGNIFICANT FRAME LOSS (${(playRatio * 100).toFixed(0)}% played)`);
  } else if (playRatio < 0.98) {
    console.log(`    ⚠️  SOME FRAME LOSS`);
  } else {
    console.log(`    ✅ OK`);
  }
  console.log();
  return playRatio;
}

console.log('\n🔬 JITTER BUFFER SIMULATION\n');
console.log('Simulates voice-processor.js AudioWorklet ring buffer');
console.log('with realistic timing to find frame drop root cause.\n');

let hasIssue = false;

// ── Scenario A: Uniform random jitter ──
for (const jitter of [0, 5, 10]) {
  console.log(`━━━ Uniform jitter ±${jitter}ms ━━━`);
  const current = runSimulation(SimulatedWorklet, 'CURRENT', jitter);
  const fixed = runSimulation(FixedWorklet, 'FIXED', jitter);
  const cR = printResults(current, jitter);
  const fR = printResults(fixed, jitter);
  if (cR < 0.98 && fR > cR) hasIssue = true;
}

// ── Scenario B: BURST arrivals (realistic Cloudflare tunnel / Wi-Fi) ──
// Frames arrive in bursts of 2-4, then a proportional gap.
// E.g. 3 frames arrive in 2ms, then 58ms gap (avg still ~20ms/frame).
function runBurstSimulation(WorkletClass, label, burstSize, burstGapMs) {
  const worklet = new WorkletClass(label);
  const DURATION_MS = 5000;
  const FRAME_SAMPLES = 960;
  const PROCESS_INTERVAL_MS = 128 / 48; // ~2.67ms
  const frame = new Float32Array(FRAME_SAMPLES);
  frame.fill(0.5);

  let clock = 0;
  let nextProcessTime = 0;
  let framesSent = 0;
  const totalFrames = 250;

  // Pre-compute burst schedule
  const schedule = [];
  let t = 0;
  while (schedule.length < totalFrames) {
    const burst = Math.min(burstSize, totalFrames - schedule.length);
    for (let i = 0; i < burst; i++) {
      schedule.push(t + i * 0.5); // 0.5ms apart within burst
    }
    t += burstGapMs; // gap between bursts
  }

  let schedIdx = 0;
  while (clock < DURATION_MS + 500) {
    if (schedIdx < schedule.length && clock >= schedule[schedIdx]) {
      worklet.writeFrame(frame);
      framesSent++;
      schedIdx++;
    }
    if (clock >= nextProcessTime) {
      worklet.process();
      nextProcessTime = clock + PROCESS_INTERVAL_MS;
    }
    const nextFrame = schedIdx < schedule.length ? schedule[schedIdx] : Infinity;
    clock = Math.max(clock + 0.01, Math.min(nextFrame, nextProcessTime));
  }
  for (let i = 0; i < 200; i++) worklet.process();
  return worklet;
}

for (const [burstSize, gapMs] of [[2, 40], [3, 60], [4, 80], [5, 100]]) {
  console.log(`━━━ Burst: ${burstSize} frames every ${gapMs}ms ━━━`);
  const current = runBurstSimulation(SimulatedWorklet, 'CURRENT', burstSize, gapMs);
  const fixed = runBurstSimulation(FixedWorklet, 'FIXED', burstSize, gapMs);
  const cR = printResults(current, `burst ${burstSize}x${gapMs}`);
  const fR = printResults(fixed, `burst ${burstSize}x${gapMs}`);
  if (current.reBufferEvents > fixed.reBufferEvents + 2) hasIssue = true;
  if (current.samplesSilence > fixed.samplesSilence * 1.2) hasIssue = true;
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  DIAGNOSIS');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (hasIssue) {
  console.log('  ❌ CURRENT jitter buffer drops frames under realistic jitter');
  console.log('  ✅ FIXED version retains more frames');
  console.log('');
  console.log('  ROOT CAUSE: voice-processor.js resets _playing = false');
  console.log('  every time the ring buffer runs dry. This forces a 60ms');
  console.log('  re-buffering pause (3 frames) before audio resumes.');
  console.log('  During that pause, audio is received but played as silence.');
  console.log('  With even modest network jitter, this creates choppy audio.');
  console.log('');
  console.log('  FIX: Once _playing is true, never reset it. The initial');
  console.log('  jitter buffer provides startup smoothing. After that,');
  console.log('  play whatever is available immediately. Buffer dry = brief');
  console.log('  silence (2.67ms) instead of 60ms re-buffer gap.');
} else {
  console.log('  ✅ No frame drops detected in simulation');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(hasIssue ? 1 : 0);
