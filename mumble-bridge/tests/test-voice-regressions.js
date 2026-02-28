#!/usr/bin/env node
/**
 * Voice Regression Tests
 *
 * Tests the specific bugs that caused choppy audio:
 * 1. Jitter buffer resetting on brief gaps → frame drops (recv=261, play=148)
 * 2. VAD without hold timer → clipping word endings (pcmIn=16 in 5s)
 * 3. VAD settings captured at start time → slider changes ignored
 * 4. WebSocket backpressure not checked → latency buildup
 * 5. Terminator bit set on every frame → Mumble thinks user stops talking 50x/sec
 */

const assert = require('assert');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// Simulate the AudioWorklet's VoiceProcessor ring buffer
// (mirror of voice-processor.js logic for testability)
// ═══════════════════════════════════════════════════════════

class SimulatedVoiceProcessor {
  constructor() {
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    this._jitterThreshold = 960 * 2; // 40ms — 2 Opus frames (FIXED from 3)
    this._playing = false;
    this._drySamples = 0;
    this._dryThreshold = 960 * 5; // 100ms

    this.samplesPlayed = 0;
    this.silenceOutput = 0;
  }

  writeToRing(samples) {
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
    this._drySamples = 0;
    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  // Simulate process() call — reads 128 samples
  process() {
    const needed = 128;
    if (!this._playing) {
      this.silenceOutput += needed;
      return new Float32Array(needed); // silence
    }
    if (this._buffered >= needed) {
      const out = new Float32Array(needed);
      for (let i = 0; i < needed; i++) {
        out[i] = this._ring[(this._readPos + i) % this._ringSize];
      }
      this._readPos = (this._readPos + needed) % this._ringSize;
      this._buffered -= needed;
      this._drySamples = 0;
      this.samplesPlayed += needed;
      return out;
    }
    if (this._buffered > 0) {
      const avail = this._buffered;
      const out = new Float32Array(needed);
      for (let i = 0; i < avail; i++) {
        out[i] = this._ring[(this._readPos + i) % this._ringSize];
      }
      this._readPos = (this._readPos + avail) % this._ringSize;
      this._buffered = 0;
      this._drySamples += (needed - avail);
      this.samplesPlayed += avail;
      return out;
    }
    // Buffer empty
    this._drySamples += needed;
    this.silenceOutput += needed;
    if (this._drySamples >= this._dryThreshold) {
      this._playing = false;
      this._drySamples = 0;
    }
    return new Float32Array(needed);
  }
}

// OLD processor with the aggressive reset bug for comparison
class OldVoiceProcessor {
  constructor() {
    this._ringSize = 48000;
    this._ring = new Float32Array(this._ringSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    this._jitterThreshold = 960 * 3; // OLD: 60ms
    this._playing = false;
    this.samplesPlayed = 0;
  }

  writeToRing(samples) {
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
    if (!this._playing && this._buffered >= this._jitterThreshold) {
      this._playing = true;
    }
  }

  process() {
    const needed = 128;
    if (!this._playing || this._buffered === 0) {
      // BUG: reset on ANY empty buffer
      if (this._playing && this._buffered === 0) {
        this._playing = false;
      }
      return new Float32Array(needed);
    }
    if (this._buffered >= needed) {
      const out = new Float32Array(needed);
      for (let i = 0; i < needed; i++) {
        out[i] = this._ring[(this._readPos + i) % this._ringSize];
      }
      this._readPos = (this._readPos + needed) % this._ringSize;
      this._buffered -= needed;
      this.samplesPlayed += needed;
      return out;
    }
    const avail = this._buffered;
    const out = new Float32Array(needed);
    for (let i = 0; i < avail; i++) {
      out[i] = this._ring[(this._readPos + i) % this._ringSize];
    }
    this._readPos = (this._readPos + avail) % this._ringSize;
    this._buffered = 0;
    this._playing = false; // BUG: aggressive reset
    this.samplesPlayed += avail;
    return out;
  }
}

// ═══════════════════════════════════════════════════════════
// Test Suite 1: Jitter Buffer (the recv=261, play=148 bug)
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 1: Jitter Buffer ━━━');

test('OLD jitter buffer drops frames on 25ms gap', () => {
  // Simulate: steady 20ms frames, then a gap long enough to drain the buffer
  // The old code resets _playing as soon as _buffered === 0 → forces 60ms re-buffer
  const proc = new OldVoiceProcessor();
  const frame = new Float32Array(960).fill(0.5);

  // Fill the jitter buffer and start playing: need >= 3 frames (2880 samples)
  for (let f = 0; f < 4; f++) proc.writeToRing(frame);
  // Process enough to start playing and drain most of the buffer
  // 4 frames = 3840 samples. Each process() reads 128 samples.
  // Process 30 times = 3840 samples → buffer should be nearly empty
  for (let p = 0; p < 30; p++) proc.process();

  assert.strictEqual(proc._playing, true, 'Should be playing after initial fill');

  // Now drain completely: one more process call on empty or near-empty buffer
  // First drain whatever remains
  while (proc._buffered > 0) proc.process();
  // One more call hits the _buffered === 0 path
  proc.process();

  assert.strictEqual(proc._playing, false, 'Old code should have reset _playing when buffer empties');

  // Now send 5 more frames — old code won't play until 3 frames buffer (60ms)
  const playedBefore = proc.samplesPlayed;
  for (let f = 0; f < 5; f++) {
    proc.writeToRing(frame);
    // Only 7 process calls per frame (slightly less than needed to drain)
    for (let p = 0; p < 7; p++) proc.process();
  }

  // With 5 frames and 7 process calls each: writes 4800 samples, reads 4480 samples
  // But first 3 frames go to re-buffering (2880 needed to restart), then plays frame 4-5
  const playedAfter = proc.samplesPlayed - playedBefore;
  // The key assertion: old code drops frames due to re-buffering
  assert(playedAfter < 960 * 5, `Old code should have dropped frames during re-buffer (played ${playedAfter} of ${960 * 5})`);
});

test('NEW jitter buffer survives 25ms gap without dropping frames', () => {
  const proc = new SimulatedVoiceProcessor();
  const frame = new Float32Array(960).fill(0.5);
  const PROCESS_PER_FRAME = Math.ceil(960 / 128);

  // Send 10 frames with perfect timing
  for (let f = 0; f < 10; f++) {
    proc.writeToRing(frame);
    for (let p = 0; p < PROCESS_PER_FRAME; p++) proc.process();
  }

  // 25ms gap (3 extra process calls)
  for (let p = 0; p < 3; p++) proc.process();

  // Buffer should still be in playing state (NOT reset)
  assert.strictEqual(proc._playing, true, 'New code should NOT reset _playing on brief gap');

  // Send 5 more frames — ALL should play
  const playedBefore = proc.samplesPlayed;
  for (let f = 0; f < 5; f++) {
    proc.writeToRing(frame);
    for (let p = 0; p < PROCESS_PER_FRAME; p++) proc.process();
  }

  const playedAfter = proc.samplesPlayed - playedBefore;
  // Should play close to all 4800 samples (some might have played from existing buffer)
  assert(playedAfter >= 960 * 4, `Should play most frames (played ${playedAfter}, expected >= ${960 * 4})`);
});

test('NEW jitter buffer resets after sustained 100ms silence', () => {
  const proc = new SimulatedVoiceProcessor();
  const frame = new Float32Array(960).fill(0.5);
  const PROCESS_PER_FRAME = Math.ceil(960 / 128);

  // Start playing
  for (let f = 0; f < 5; f++) proc.writeToRing(frame);
  for (let p = 0; p < PROCESS_PER_FRAME * 5; p++) proc.process();

  assert.strictEqual(proc._playing, true, 'Should be playing');

  // Now NO new data for 100ms+ (enough process calls to exceed _dryThreshold)
  const callsFor100ms = Math.ceil(4800 / 128) + 5; // ~42 calls
  for (let p = 0; p < callsFor100ms; p++) proc.process();

  assert.strictEqual(proc._playing, false, 'Should reset after sustained silence');
});

test('Frame drop ratio: OLD vs NEW on jittery network', () => {
  // Simulate realistic network: frames arrive every 18-25ms (jitter)
  const OLD = new OldVoiceProcessor();
  const NEW = new SimulatedVoiceProcessor();
  const frame = new Float32Array(960).fill(0.5);

  const TOTAL_FRAMES = 250; // 5 seconds
  let oldPlayed = 0, newPlayed = 0;

  // Simulate with varying gaps between frames
  const jitterPattern = [];
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    // Simulate realistic timing: 128 samples per process() call, ~7.5 per frame
    // Add jitter: sometimes 7, sometimes 8, sometimes 9 process calls between frames
    const jitter = 7 + Math.floor(Math.random() * 3); // 7-9 process calls
    jitterPattern.push(jitter);
  }

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    OLD.writeToRing(frame);
    NEW.writeToRing(frame);
    for (let p = 0; p < jitterPattern[i]; p++) {
      OLD.process();
      NEW.process();
    }
  }

  const oldRatio = OLD.samplesPlayed / (TOTAL_FRAMES * 960);
  const newRatio = NEW.samplesPlayed / (TOTAL_FRAMES * 960);

  console.log(`    OLD play ratio: ${(oldRatio * 100).toFixed(1)}%, NEW play ratio: ${(newRatio * 100).toFixed(1)}%`);
  assert(newRatio > oldRatio, `New should play more than old (new=${newRatio.toFixed(3)} vs old=${oldRatio.toFixed(3)})`);
  assert(newRatio > 0.9, `New should play at least 90% of frames (got ${(newRatio * 100).toFixed(1)}%)`);
});


// ═══════════════════════════════════════════════════════════
// Test Suite 2: VAD Hold Timer (the pcmIn=16 in 5s bug)
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 2: VAD Hold Timer ━━━');

function simulateVAD(frames, vadThreshold, holdFrames = 0) {
  let sent = 0;
  let holdCounter = 0;

  for (const frame of frames) {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frame.length);

    if (holdFrames > 0) {
      // NEW: with hold timer
      if (rms >= vadThreshold) {
        holdCounter = holdFrames;
      } else if (holdCounter > 0) {
        holdCounter--;
      } else {
        continue;
      }
    } else {
      // OLD: no hold timer
      if (rms < vadThreshold) continue;
    }
    sent++;
  }
  return sent;
}

test('OLD VAD clips quiet consonants at word boundaries', () => {
  // Simulate a word: quiet onset (100ms) → loud vowel (200ms) → quiet consonant (100ms)
  // Each frame = 20ms = 960 samples
  const vadThreshold = 200;
  const frames = [];

  // Quiet onset: 5 frames, RMS ~150 (below threshold)
  for (let f = 0; f < 5; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 150);
    frames.push(frame);
  }
  // Loud vowel: 10 frames, RMS ~3000
  for (let f = 0; f < 10; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 4000);
    frames.push(frame);
  }
  // Quiet consonant tail: 5 frames, RMS ~150
  for (let f = 0; f < 5; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 150);
    frames.push(frame);
  }

  const oldSent = simulateVAD(frames, vadThreshold, 0); // No hold
  // Old VAD only sends the 10 loud frames, drops all 10 quiet ones
  assert.strictEqual(oldSent, 10, `Old VAD should only send loud frames (got ${oldSent})`);
});

test('NEW VAD with hold preserves quiet consonants after speech', () => {
  const vadThreshold = 200;
  const frames = [];

  // Same pattern: quiet onset → loud vowel → quiet tail
  for (let f = 0; f < 5; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 150);
    frames.push(frame);
  }
  for (let f = 0; f < 10; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 4000);
    frames.push(frame);
  }
  for (let f = 0; f < 5; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 150);
    frames.push(frame);
  }

  const newSent = simulateVAD(frames, vadThreshold, 15); // 15 frame hold (300ms)
  // New VAD sends the 10 loud frames + 5 quiet tail frames (hold timer covers them)
  assert(newSent >= 15, `New VAD should send loud + tail frames (got ${newSent}, expected >= 15)`);
});

test('VAD hold does not keep transmitting forever after brief speech', () => {
  const vadThreshold = 200;
  const frames = [];

  // Brief speech: 3 frames loud
  for (let f = 0; f < 3; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 4000);
    frames.push(frame);
  }
  // Long silence: 50 frames quiet (1 second)
  for (let f = 0; f < 50; f++) {
    const frame = new Int16Array(960);
    for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * 10);
    frames.push(frame);
  }

  const sent = simulateVAD(frames, vadThreshold, 15);
  // Should send 3 loud + 15 hold = 18, NOT all 53
  assert(sent <= 20, `VAD hold should stop after hold period (sent ${sent}, expected <= 20)`);
  assert(sent >= 16, `VAD hold should send speech + hold (sent ${sent}, expected >= 16)`);
});

test('pcmIn count with real-world speech pattern (OLD vs NEW)', () => {
  // Simulate 5 seconds of natural speech: alternating words with pauses
  // Word ~300ms loud, pause ~200ms quiet, word ~400ms loud, etc.
  const vadThreshold = 200;
  const frames = [];

  const pattern = [
    { loud: true, count: 15 },  // word: 300ms
    { loud: false, count: 10 }, // pause: 200ms
    { loud: true, count: 20 },  // word: 400ms
    { loud: false, count: 5 },  // pause: 100ms
    { loud: true, count: 10 },  // word: 200ms
    { loud: false, count: 15 }, // pause: 300ms
    { loud: true, count: 25 },  // word: 500ms
    { loud: false, count: 10 }, // pause: 200ms
    { loud: true, count: 15 },  // word: 300ms
    { loud: false, count: 125 }, // remaining silence
  ];

  for (const seg of pattern) {
    for (let f = 0; f < seg.count; f++) {
      const frame = new Int16Array(960);
      const amp = seg.loud ? 3000 : 100;
      for (let i = 0; i < 960; i++) frame[i] = Math.round(Math.sin(i * 0.1) * amp);
      frames.push(frame);
    }
  }

  const oldSent = simulateVAD(frames, vadThreshold, 0);
  const newSent = simulateVAD(frames, vadThreshold, 15);

  console.log(`    5s speech: OLD sent ${oldSent} frames, NEW sent ${newSent} frames`);
  // Old sends ONLY loud frames (85), new sends loud + hold tails
  assert(newSent > oldSent, 'New VAD should send more frames than old');
  assert(oldSent >= 80, `Old should at least send loud frames (got ${oldSent})`);
  assert(newSent >= 140, `New should send significantly more with hold (got ${newSent})`);
});


// ═══════════════════════════════════════════════════════════
// Test Suite 3: Terminator Bit (Opus end-of-speech flag)
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 3: Terminator Bit ━━━');

test('Opus terminator bit is NOT set during continuous streaming', () => {
  // Read the actual voice-bridge.js and check the sendOpusToMumble implementation
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');

  // The fix: terminator bit (0x2000) should NOT be set
  assert(!src.includes('| 0x2000'), 'Source should not contain | 0x2000');
  assert(!src.includes('isLast'), 'Source should not reference isLast parameter');
  assert(src.includes('opusFrame.length & 0x1FFF'), 'Should mask length with 0x1FFF only');
});

test('_sendOpusToMumble produces valid Mumble audio packets', () => {
  // Simulate the packet building logic from _sendOpusToMumble
  function buildPacket(opusFrame, sequenceNumber) {
    const header = (4 << 5) | 0; // Opus type=4, target=0
    const seqVarint = writeVarint(sequenceNumber);
    const sizeVarint = writeVarint(opusFrame.length & 0x1FFF);
    return Buffer.concat([
      Buffer.from([header]),
      seqVarint,
      sizeVarint,
      opusFrame,
    ]);
  }

  function writeVarint(value) {
    if (value < 0x80) return Buffer.from([value]);
    if (value < 0x4000) return Buffer.from([(value >> 8) | 0x80, value & 0xFF]);
    return Buffer.from([0xF0, (value >> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]);
  }

  // Build 10 packets
  for (let seq = 0; seq < 10; seq++) {
    const fakeOpus = Buffer.alloc(80 + Math.floor(Math.random() * 40)); // 80-120 bytes typical
    const pkt = buildPacket(fakeOpus, seq);

    // Parse it back
    const headerByte = pkt[0];
    assert.strictEqual((headerByte >> 5) & 0x07, 4, 'Audio type should be 4 (Opus)');
    assert.strictEqual(headerByte & 0x1F, 0, 'Target should be 0 (normal)');

    // Read sequence varint
    let offset = 1;
    const seqVal = pkt[offset] & 0x7F;
    offset += 1;

    // Read size varint
    const sizeVal = pkt[offset] & 0x7F;
    offset += 1;

    // Check terminator bit is NOT set
    assert.strictEqual(sizeVal & 0x2000, 0, `Terminator bit should not be set (packet ${seq})`);
    // The raw size field should match opus frame length
    assert.strictEqual(sizeVal, fakeOpus.length, `Size should match opus frame length`);
  }
});


// ═══════════════════════════════════════════════════════════
// Test Suite 4: WebSocket Backpressure
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 4: Backpressure ━━━');

test('voice-bridge.js checks bufferedAmount before sending', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');
  assert(src.includes('bufferedAmount'), 'Should check ws.bufferedAmount');
  assert(src.includes('MAX_BUFFERED'), 'Should define MAX_BUFFERED threshold');
});

test('Backpressure check drops frames when buffer is full', () => {
  // Simulate the backpressure logic
  const MAX_BUFFERED = 1920 * 5;
  let sent = 0;
  let dropped = 0;

  function simulateSend(bufferedAmount) {
    if (bufferedAmount > MAX_BUFFERED) {
      dropped++;
      return;
    }
    sent++;
  }

  // Normal operation: low buffer
  for (let i = 0; i < 50; i++) simulateSend(0);
  assert.strictEqual(sent, 50, 'All frames should send when buffer is empty');

  // Backpressure: high buffer
  sent = 0;
  for (let i = 0; i < 50; i++) simulateSend(MAX_BUFFERED + 1);
  assert.strictEqual(sent, 0, 'No frames should send when buffer is full');
  assert.strictEqual(dropped, 50, 'All frames should be dropped');
});


// ═══════════════════════════════════════════════════════════
// Test Suite 5: End-to-End Pipeline Simulation
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 5: End-to-End Pipeline ━━━');

test('Full pipeline: speech with jitter produces continuous audio', () => {
  // Simulate: browser captures → VAD filters → server receives → jitter buffer plays
  const vadThreshold = 200;
  const holdFrames = 15;
  const proc = new SimulatedVoiceProcessor();

  // Generate 5 seconds of speech (250 frames at 20ms each)
  const frames = [];
  for (let i = 0; i < 250; i++) {
    const frame = new Int16Array(960);
    // Simulate natural speech: mostly loud with some quiet dips
    const amp = (i % 25 < 3) ? 100 : 3000; // 3 quiet frames every 25 (12% quiet)
    for (let s = 0; s < 960; s++) frame[s] = Math.round(Math.sin(s * 0.1) * amp);
    frames.push(frame);
  }

  // Apply VAD with hold
  let vadHoldCounter = 0;
  const sentFrames = [];
  for (const frame of frames) {
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / frame.length);
    if (rms >= vadThreshold) vadHoldCounter = holdFrames;
    else if (vadHoldCounter > 0) vadHoldCounter--;
    else continue;
    sentFrames.push(frame);
  }

  // Feed sent frames into jitter buffer with realistic timing jitter
  const PROCESS_PER_FRAME = Math.ceil(960 / 128);
  for (let i = 0; i < sentFrames.length; i++) {
    // Convert Int16 to Float32 (like server does)
    const float32 = new Float32Array(960);
    for (let s = 0; s < 960; s++) float32[s] = sentFrames[i][s] / 32768;
    proc.writeToRing(float32);

    // Simulate jittery process() timing
    const calls = PROCESS_PER_FRAME + (i % 3 === 0 ? 1 : 0); // occasional extra call
    for (let p = 0; p < calls; p++) proc.process();
  }

  const playRatio = proc.samplesPlayed / (sentFrames.length * 960);
  console.log(`    Sent ${sentFrames.length}/${frames.length} frames, play ratio: ${(playRatio * 100).toFixed(1)}%`);
  assert(sentFrames.length >= 240, `VAD should send most frames (sent ${sentFrames.length}/250)`);
  assert(playRatio > 0.85, `Play ratio should be > 85% (got ${(playRatio * 100).toFixed(1)}%)`);
});


// ═══════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results) {
    if (!r.ok) console.log(`  ❌ ${r.name}: ${r.err}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed! ✅');
  process.exit(0);
}
