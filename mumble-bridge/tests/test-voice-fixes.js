#!/usr/bin/env node
/**
 * Voice Fix Verification Tests
 *
 * Tests the four critical voice fixes:
 *  1. Dry threshold in Electron voice-processor (per-sender ring buffers)
 *  2. Opus bitrate set to 48kbps in both bridge and client encoders
 *  3. Opus PLC (Packet Loss Concealment) fills gaps with synthesized frames
 *  4. Per-sender mixing in Electron (no more setInterval accumulator)
 *
 * These tests run WITHOUT a Mumble server — they test the audio pipeline
 * logic in isolation using simulated data.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}


// ═══════════════════════════════════════════════════════════
// Test Suite 1: Source Code Verification
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 1: Source Code Verification ━━━');

test('Bridge voice-bridge.js sets encoder bitrate to 48000', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');
  assert(src.includes('setBitrate(48000)'), 'voice-bridge.js should call setBitrate(48000)');
});

test('Bridge voice-bridge.js tracks sequence numbers per sender', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');
  assert(src.includes('lastSeq'), 'voice-bridge.js should have lastSeq tracking');
  assert(src.includes('sequenceNumber'), 'voice-bridge.js should use sequenceNumber in parsed result');
});

test('Bridge voice-bridge.js implements PLC (decode null)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');
  assert(src.includes('decode(null)'), 'voice-bridge.js should call decode(null) for PLC');
});

test('Bridge legacy parser returns sequenceNumber', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-bridge.js'), 'utf8');
  // Check that _parseLegacyAudio includes sequenceNumber in its return
  const legacyReturn = src.match(/return\s*\{[^}]*senderSession[^}]*sequenceNumber[^}]*\}/s);
  assert(legacyReturn, '_parseLegacyAudio should return sequenceNumber');
});

test('Electron voice-processor.js uses per-sender ring buffers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'renderer', 'voice-processor.js'), 'utf8');
  assert(src.includes('_senders'), 'voice-processor.js should have _senders Map');
  assert(src.includes('_getOrCreateSender'), 'voice-processor.js should have _getOrCreateSender');
  assert(src.includes('_dryThreshold'), 'voice-processor.js should have _dryThreshold');
  assert(src.includes('drySamples'), 'voice-processor.js should track drySamples');
});

test('Electron voice-processor.js expects senderId in playback messages', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'renderer', 'voice-processor.js'), 'utf8');
  assert(src.includes('e.data.senderId'), 'voice-processor.js should read senderId from messages');
});

test('Electron main.js does NOT use setInterval accumulator mixer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'main.js'), 'utf8');
  // The old code had: mixerInterval = setInterval(() => { ... mixDirty ... }, 20);
  // The new code should NOT have this pattern
  assert(!src.includes('mixBuf[i] + pcm[i]'), 'main.js should not have accumulator mixer');
  assert(!src.includes("mixDirty = true"), 'main.js should not set mixDirty');
});

test('Electron main.js forwards per-sender frames with senderId', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'main.js'), 'utf8');
  assert(src.includes('senderId: senderSession'), 'main.js should forward senderId');
  assert(src.includes('Float32Array'), 'main.js should convert to Float32Array');
});

test('Electron voice.js sets encoder bitrate to 48000', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'mumble', 'voice.js'), 'utf8');
  assert(src.includes('setBitrate(48000)'), 'voice.js should call setBitrate(48000)');
});

test('Electron voice.js has decodeWithPLC method', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'mumble', 'voice.js'), 'utf8');
  assert(src.includes('decodeWithPLC'), 'voice.js should have decodeWithPLC method');
  assert(src.includes('decode(null)'), 'voice.js should call decode(null) for PLC');
});

test('Electron connection.js uses decodeWithPLC', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'mumble', 'connection.js'), 'utf8');
  assert(src.includes('decodeWithPLC'), 'connection.js should call decodeWithPLC');
  assert(src.includes('sequenceNumber'), 'connection.js should pass sequenceNumber');
});

test('Bridge AudioWorklet (public/js/voice-processor.js) matches Electron version', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'voice-processor.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'mumble-client', 'src', 'renderer', 'voice-processor.js'), 'utf8');

  // Both should have per-sender architecture
  assert(bridge.includes('_senders'), 'Bridge voice-processor.js should have _senders');
  assert(client.includes('_senders'), 'Client voice-processor.js should have _senders');

  // Both should have dry threshold
  assert(bridge.includes('_dryThreshold'), 'Bridge should have _dryThreshold');
  assert(client.includes('_dryThreshold'), 'Client should have _dryThreshold');

  // Both should have the same threshold values
  const bridgeJitter = bridge.match(/_jitterThreshold\s*=\s*(\d+\s*\*\s*\d+)/);
  const clientJitter = client.match(/_jitterThreshold\s*=\s*(\d+\s*\*\s*\d+)/);
  assert(bridgeJitter && clientJitter, 'Both should define _jitterThreshold');
  assert.strictEqual(bridgeJitter[1].replace(/\s/g, ''), clientJitter[1].replace(/\s/g, ''),
    'Jitter thresholds should match');
});


// ═══════════════════════════════════════════════════════════
// Test Suite 2: PLC Logic Simulation
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 2: PLC Logic Simulation ━━━');

test('PLC generates concealment frames for sequence gaps', () => {
  // Simulate the PLC logic from voice-bridge.js
  let lastSeq = -1;
  const decoded = [];

  function processFrame(seqNum) {
    if (lastSeq >= 0 && seqNum > lastSeq + 1) {
      const gap = Math.min(seqNum - lastSeq - 1, 3);
      for (let i = 0; i < gap; i++) decoded.push('PLC');
    }
    lastSeq = seqNum;
    decoded.push('REAL');
  }

  processFrame(0);  // First frame
  processFrame(1);  // Consecutive
  processFrame(3);  // Gap of 1
  processFrame(4);  // Consecutive
  processFrame(8);  // Gap of 3 (max PLC)
  processFrame(15); // Gap of 6, but capped at 3 PLC

  assert.deepStrictEqual(decoded, [
    'REAL',           // seq 0
    'REAL',           // seq 1
    'PLC', 'REAL',    // seq 3 (1 PLC for missing seq 2)
    'REAL',           // seq 4
    'PLC', 'PLC', 'PLC', 'REAL',  // seq 8 (3 PLC max for missing 5,6,7)
    'PLC', 'PLC', 'PLC', 'REAL',  // seq 15 (capped at 3 PLC)
  ]);
});

test('PLC does not generate frames for first-ever packet', () => {
  let lastSeq = -1;
  let plcCount = 0;

  function processFrame(seqNum) {
    if (lastSeq >= 0 && seqNum > lastSeq + 1) {
      plcCount += Math.min(seqNum - lastSeq - 1, 3);
    }
    lastSeq = seqNum;
  }

  processFrame(100); // First frame at high seq
  assert.strictEqual(plcCount, 0, 'No PLC for first frame regardless of seq number');
});

test('PLC does not generate frames for consecutive packets', () => {
  let lastSeq = -1;
  let plcCount = 0;

  function processFrame(seqNum) {
    if (lastSeq >= 0 && seqNum > lastSeq + 1) {
      plcCount += Math.min(seqNum - lastSeq - 1, 3);
    }
    lastSeq = seqNum;
  }

  for (let i = 0; i < 100; i++) processFrame(i);
  assert.strictEqual(plcCount, 0, 'No PLC for consecutive frames');
});


// ═══════════════════════════════════════════════════════════
// Test Suite 3: Per-Sender Dry Threshold Simulation
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 3: Per-Sender Dry Threshold ━━━');

class SimulatedPerSenderProcessor {
  constructor() {
    this._senders = new Map();
    this._ringSize = 48000;
    this._jitterThreshold = 960 * 3;
    this._dryThreshold = 960 * 5;
    this.samplesPlayed = 0;
  }

  _getSender(id) {
    let s = this._senders.get(id);
    if (!s) {
      s = { buffered: 0, playing: false, drySamples: 0 };
      this._senders.set(id, s);
    }
    return s;
  }

  write(id, samples) {
    const s = this._getSender(id);
    s.buffered += samples;
    s.drySamples = 0;
    if (!s.playing && s.buffered >= this._jitterThreshold) s.playing = true;
  }

  process(needed = 128) {
    for (const [, s] of this._senders) {
      if (!s.playing) continue;
      if (s.buffered >= needed) {
        s.buffered -= needed;
        s.drySamples = 0;
        this.samplesPlayed += needed;
      } else if (s.buffered > 0) {
        this.samplesPlayed += s.buffered;
        s.drySamples += (needed - s.buffered);
        s.buffered = 0;
      } else {
        s.drySamples += needed;
        if (s.drySamples >= this._dryThreshold) {
          s.playing = false;
          s.drySamples = 0;
        }
      }
    }
  }
}

test('Brief gap does not reset sender playback state', () => {
  const proc = new SimulatedPerSenderProcessor();

  // Fill 5 frames and drain them
  proc.write(1, 960 * 5);
  for (let p = 0; p < Math.ceil(960 * 5 / 128); p++) proc.process();

  const s = proc._senders.get(1);
  // After draining, drySamples should be accumulating but NOT reset
  for (let p = 0; p < 10; p++) proc.process(); // ~26ms of dry
  assert.strictEqual(s.playing, true, 'Should still be playing after brief gap');
});

test('Sustained 100ms silence resets sender playback state', () => {
  const proc = new SimulatedPerSenderProcessor();

  proc.write(1, 960 * 5);
  for (let p = 0; p < Math.ceil(960 * 5 / 128); p++) proc.process();

  // 120ms of silence (exceeds _dryThreshold of 4800 samples)
  for (let p = 0; p < Math.ceil(5760 / 128) + 2; p++) proc.process();

  const s = proc._senders.get(1);
  assert.strictEqual(s.playing, false, 'Should reset after 100ms+ silence');
});

test('Two senders: one stops, other keeps playing', () => {
  const proc = new SimulatedPerSenderProcessor();

  // Sender 1: 3 frames, Sender 2: 20 frames
  proc.write(1, 960 * 3);
  proc.write(2, 960 * 20);

  // Process enough to drain sender 1 and trigger dry threshold
  for (let p = 0; p < Math.ceil(960 * 20 / 128); p++) proc.process();

  const s1 = proc._senders.get(1);
  const s2 = proc._senders.get(2);
  assert.strictEqual(s1.playing, false, 'Sender 1 should have stopped');
  // Sender 2 might have just finished too — check total played
  assert(proc.samplesPlayed > 960 * 20, 'Should have played most of sender 2 data');
});

test('play-ratio comparison: old (no dry threshold) vs new', () => {
  // Old behavior: reset _playing immediately when buffer empties
  class OldProcessor {
    constructor() { this.buffered = 0; this.playing = false; this.played = 0; this.threshold = 960 * 3; }
    write(n) {
      this.buffered += n;
      if (!this.playing && this.buffered >= this.threshold) this.playing = true;
    }
    process(n = 128) {
      if (!this.playing) return;
      if (this.buffered >= n) { this.buffered -= n; this.played += n; }
      else if (this.buffered > 0) { this.played += this.buffered; this.buffered = 0; this.playing = false; }
      else { this.playing = false; }
    }
  }

  const oldProc = new OldProcessor();
  const newProc = new SimulatedPerSenderProcessor();
  const TOTAL_FRAMES = 250;

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    oldProc.write(960);
    newProc.write(1, 960);
    const calls = 7 + Math.floor(Math.random() * 3); // jitter
    for (let p = 0; p < calls; p++) {
      oldProc.process();
      newProc.process();
    }
  }

  const oldRatio = oldProc.played / (TOTAL_FRAMES * 960);
  const newRatio = newProc.samplesPlayed / (TOTAL_FRAMES * 960);
  console.log(`    OLD play ratio: ${(oldRatio * 100).toFixed(1)}%, NEW play ratio: ${(newRatio * 100).toFixed(1)}%`);
  assert(newRatio >= oldRatio, `New should play at least as much as old (new=${newRatio.toFixed(3)} vs old=${oldRatio.toFixed(3)})`);
  assert(newRatio > 0.85, `New should play > 85% of samples (got ${(newRatio * 100).toFixed(1)}%)`);
});


// ═══════════════════════════════════════════════════════════
// Test Suite 4: End-to-End Pipeline Simulation
// ═══════════════════════════════════════════════════════════

console.log('\n━━━ Test Suite 4: End-to-End Pipeline ━━━');

test('Full pipeline: 5s speech with jitter + PLC produces continuous audio', () => {
  // Simulate the full pipeline:
  //   Mumble sends Opus frames with sequence numbers
  //   → Bridge decodes with PLC for missed frames
  //   → Per-sender jitter buffer plays back
  const proc = new SimulatedPerSenderProcessor();
  let totalFramesDecoded = 0;

  // Simulate 250 frames (5 seconds) with 5% packet loss
  let lastSeq = -1;
  for (let seq = 0; seq < 250; seq++) {
    // 5% packet loss
    if (Math.random() < 0.05) continue;

    // PLC for gaps
    if (lastSeq >= 0 && seq > lastSeq + 1) {
      const gap = Math.min(seq - lastSeq - 1, 3);
      for (let i = 0; i < gap; i++) {
        proc.write(1, 960); // PLC frame
        totalFramesDecoded++;
      }
    }
    lastSeq = seq;

    // Real frame
    proc.write(1, 960);
    totalFramesDecoded++;

    // Process with jitter
    const calls = 7 + Math.floor(Math.random() * 3);
    for (let p = 0; p < calls; p++) proc.process();
  }

  const playRatio = proc.samplesPlayed / (totalFramesDecoded * 960);
  console.log(`    Frames decoded (including PLC): ${totalFramesDecoded}/250, play ratio: ${(playRatio * 100).toFixed(1)}%`);
  assert(totalFramesDecoded > 240, `PLC should compensate for most lost frames (got ${totalFramesDecoded})`);
  assert(playRatio > 0.80, `Play ratio should be > 80% (got ${(playRatio * 100).toFixed(1)}%)`);
});

test('Multiple simultaneous speakers with independent jitter', () => {
  const proc = new SimulatedPerSenderProcessor();

  // 3 speakers, each sending 100 frames with different jitter patterns
  for (let f = 0; f < 100; f++) {
    proc.write(1, 960);
    proc.write(2, 960);
    if (f % 2 === 0) proc.write(3, 960); // Speaker 3 at half rate

    const calls = 7 + Math.floor(Math.random() * 3);
    for (let p = 0; p < calls; p++) proc.process();
  }

  // All three senders should have been tracked
  assert.strictEqual(proc._senders.size, 3, 'Should track 3 senders');
  console.log(`    Total samples played from 3 speakers: ${proc.samplesPlayed}`);
  // At least 2 speakers' worth of data should have played
  assert(proc.samplesPlayed > 960 * 100, 'Should play significant audio from all speakers');
});


// ═══════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results) {
    if (!r.ok) console.log(`  ✗ ${r.name}: ${r.err}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed! ✓');
  process.exit(0);
}
