#!/usr/bin/env node
/**
 * DIAGNOSTIC: Choppy voice / frame drops / feedback / one-way audio.
 *
 * Recreates real usage: two clients join voice, send continuous 20ms PCM
 * frames at real-time cadence, and measures:
 *
 *   1. RECEIVE THROUGHPUT — how many audio packets come back from Mumble
 *   2. ECHO               — does sender hear its OWN audio back?
 *   3. FRAME SIZES        — are received PCM frames the expected 1920 bytes?
 *   4. TIMING GAPS        — intervals between received packets (burst/gap)
 *   5. SILENCE RATIO      — are received frames actual audio or silence?
 *   6. BIDIRECTIONAL      — both talk, both hear each other?
 *   7. RESUME AFTER GAP   — does audio resume after silence?
 *
 * Usage:
 *   node tests/test-diagnose-choppy.js [host] [port]
 *
 * Requires: mumble-bridge running.
 */
const WebSocket = require('ws');

const HOST = process.argv[2] || 'localhost';
const PORT = process.argv[3] || 3080;
const URL = `ws://${HOST}:${PORT}`;

const SEND_DURATION_MS = 4000;
const FRAME_INTERVAL_MS = 20;
const FRAME_SIZE_BYTES = 1920;  // 960 samples * 2 bytes Int16LE
const EXPECTED_SEND_FRAMES = SEND_DURATION_MS / FRAME_INTERVAL_MS; // 200

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function makePcmFrame(freqHz = 440, amplitude = 8000) {
  const buf = Buffer.alloc(FRAME_SIZE_BYTES);
  for (let i = 0; i < 960; i++) {
    buf.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * freqHz * i / 48000) * amplitude), i * 2);
  }
  return buf;
}

function isSilent(buf, threshold = 200) {
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) sumSq += int16[i] * int16[i];
  return Math.sqrt(sumSq / int16.length) < threshold;
}

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.binaryType = 'arraybuffer';
    const messages = [];
    const binaryFrames = [];
    const timeout = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 8000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          binaryFrames.push({ data: buf, timestamp: Date.now() });
        } else {
          try { messages.push(JSON.parse(data.toString())); } catch {}
        }
      });
      resolve({ ws, messages, binaryFrames, name });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function findMsg(msgs, filter) {
  return msgs.find(m => Object.entries(filter).every(([k, v]) => m[k] === v));
}

async function auth(client, username) {
  client.ws.send(JSON.stringify({ type: 'auth', username }));
  for (let i = 0; i < 40; i++) {
    if (findMsg(client.messages, { type: 'auth_ok' })) return;
    await wait(100);
  }
  throw new Error(`${client.name} auth timeout`);
}

async function startVoice(client, channelId) {
  client.ws.send(JSON.stringify({ type: 'voice_start', voiceChannelId: channelId }));
  for (let i = 0; i < 80; i++) {
    if (findMsg(client.messages, { type: 'voice_ready' })) return;
    const err = findMsg(client.messages, { type: 'error' });
    if (err) throw new Error(`${client.name} voice error: ${err.message}`);
    await wait(100);
  }
  throw new Error(`${client.name} voice timeout`);
}

async function sendRealtimeAudio(client, durationMs, freqHz = 440) {
  const frame = makePcmFrame(freqHz);
  const frameCount = Math.floor(durationMs / FRAME_INTERVAL_MS);
  let sent = 0;
  for (let i = 0; i < frameCount; i++) {
    if (client.ws.readyState !== WebSocket.OPEN) break;
    client.ws.send(frame);
    sent++;
    await wait(FRAME_INTERVAL_MS);
  }
  return sent;
}

async function runDiagnostic() {
  console.log(`\n🔬 CHOPPY VOICE DIAGNOSTIC — ${URL}\n`);

  const ts = Date.now();
  let alice, bob;
  const issues = [];

  // ── Setup ──
  try {
    alice = await connectClient('Alice');
    bob = await connectClient('Bob');
    await auth(alice, `diag_alice_${ts}`);
    await auth(bob, `diag_bob_${ts}`);
    console.log('  ✅ Both clients connected and authenticated');
  } catch (e) {
    console.log(`  ❌ Setup failed: ${e.message}`);
    return;
  }

  try {
    await startVoice(alice);
    await wait(2000);
    await startVoice(bob);
    console.log('  ✅ Both clients in voice\n');
  } catch (e) {
    console.log(`  ❌ Voice setup failed: ${e.message}`);
    alice.ws.close(); bob.ws.close();
    return;
  }

  await wait(1000);
  alice.binaryFrames.length = 0;
  bob.binaryFrames.length = 0;

  // ══════════════════════════════════════════════════════
  // TEST 1: Alice sends 4s, Bob listens
  // ══════════════════════════════════════════════════════
  console.log('━━━ Test 1: Alice sends 4s, Bob listens ━━━');
  const aliceSent = await sendRealtimeAudio(alice, SEND_DURATION_MS, 440);
  await wait(1500);

  const bobRecvCount = bob.binaryFrames.length;
  const aliceEchoCount = alice.binaryFrames.length;
  const recvRatio = bobRecvCount / aliceSent;

  console.log(`  Alice sent:       ${aliceSent} frames (${aliceSent * 20}ms)`);
  console.log(`  Bob received:     ${bobRecvCount} frames`);
  console.log(`  Alice echo:       ${aliceEchoCount} frames`);
  console.log(`  Receive ratio:    ${(recvRatio * 100).toFixed(1)}%`);

  if (recvRatio < 0.5) {
    console.log(`  ❌ SEVERE FRAME LOSS`);
    issues.push(`FRAME LOSS: Bob got ${(recvRatio * 100).toFixed(0)}% of Alice's frames`);
  } else if (recvRatio < 0.8) {
    console.log(`  ⚠️  MODERATE FRAME LOSS`);
    issues.push(`MODERATE LOSS: Bob got ${(recvRatio * 100).toFixed(0)}%`);
  } else {
    console.log(`  ✅ Receive ratio OK`);
  }

  if (aliceEchoCount > 0) {
    console.log(`  ❌ ECHO — Alice hears herself (${aliceEchoCount} frames)`);
    issues.push(`ECHO: Alice heard ${aliceEchoCount} of her own frames`);
  } else {
    console.log(`  ✅ No echo`);
  }

  // ══════════════════════════════════════════════════════
  // TEST 2: Frame sizes
  // ══════════════════════════════════════════════════════
  console.log('\n━━━ Test 2: Received frame sizes ━━━');
  const wrongSizes = bob.binaryFrames.filter(f => f.data.length !== FRAME_SIZE_BYTES);
  if (wrongSizes.length > 0) {
    const sizes = [...new Set(wrongSizes.map(f => f.data.length))].sort((a, b) => a - b);
    console.log(`  ❌ ${wrongSizes.length}/${bobRecvCount} frames wrong size`);
    console.log(`     Expected ${FRAME_SIZE_BYTES}, got: ${sizes.join(', ')}`);
    issues.push(`BAD SIZES: ${wrongSizes.length} frames wrong size (${sizes.join(', ')})`);
  } else if (bobRecvCount > 0) {
    console.log(`  ✅ All ${bobRecvCount} frames are ${FRAME_SIZE_BYTES} bytes`);
  } else {
    console.log(`  ⚠️  No frames to check`);
  }

  // ══════════════════════════════════════════════════════
  // TEST 3: Timing / jitter
  // ══════════════════════════════════════════════════════
  console.log('\n━━━ Test 3: Timing analysis ━━━');
  if (bob.binaryFrames.length >= 2) {
    const gaps = [];
    for (let i = 1; i < bob.binaryFrames.length; i++) {
      gaps.push(bob.binaryFrames[i].timestamp - bob.binaryFrames[i - 1].timestamp);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    const min = gaps[0];
    const max = gaps[gaps.length - 1];
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const burstCount = gaps.filter(g => g < 5).length;
    const gapCount = gaps.filter(g => g > 50).length;

    console.log(`  Gaps (ms): min=${min} median=${median} avg=${avg.toFixed(1)} max=${max}`);
    console.log(`  Bursts (<5ms):  ${burstCount}/${gaps.length}`);
    console.log(`  Large gaps (>50ms): ${gapCount}/${gaps.length}`);

    if (gapCount > gaps.length * 0.2) {
      console.log(`  ❌ HIGH JITTER`);
      issues.push(`JITTER: ${gapCount}/${gaps.length} gaps >50ms`);
    } else {
      console.log(`  ✅ Timing OK`);
    }
  } else {
    console.log(`  ⚠️  Not enough frames`);
  }

  // ══════════════════════════════════════════════════════
  // TEST 4: Silence check
  // ══════════════════════════════════════════════════════
  console.log('\n━━━ Test 4: Audio content ━━━');
  if (bobRecvCount > 0) {
    const silentFrames = bob.binaryFrames.filter(f => isSilent(f.data));
    const nonSilent = bobRecvCount - silentFrames.length;
    console.log(`  Non-silent: ${nonSilent}/${bobRecvCount}`);
    console.log(`  Silent:     ${silentFrames.length}/${bobRecvCount}`);
    if (nonSilent === 0) {
      console.log(`  ❌ ALL SILENCE`);
      issues.push('ALL SILENCE: decode/encode bug');
    } else {
      console.log(`  ✅ Audio content present`);
    }
  } else {
    console.log(`  ⚠️  No frames`);
  }

  // ══════════════════════════════════════════════════════
  // TEST 5: Bidirectional — both talk 2s
  // ══════════════════════════════════════════════════════
  console.log('\n━━━ Test 5: Bidirectional (2s) ━━━');
  alice.binaryFrames.length = 0;
  bob.binaryFrames.length = 0;

  const [aSent, bSent] = await Promise.all([
    sendRealtimeAudio(alice, 2000, 440),
    sendRealtimeAudio(bob, 2000, 660),
  ]);
  await wait(1500);

  const aliceGot = alice.binaryFrames.length;
  const bobGot = bob.binaryFrames.length;

  console.log(`  Alice sent ${aSent}, received ${aliceGot} (${(aliceGot / bSent * 100).toFixed(0)}%)`);
  console.log(`  Bob   sent ${bSent}, received ${bobGot} (${(bobGot / aSent * 100).toFixed(0)}%)`);

  if (aliceGot === 0) { console.log(`  ❌ ONE-WAY: Alice hears nothing`); issues.push('ONE-WAY: Alice hears nothing from Bob'); }
  if (bobGot === 0) { console.log(`  ❌ ONE-WAY: Bob hears nothing`); issues.push('ONE-WAY: Bob hears nothing from Alice'); }

  if (aliceGot > 0 && bobGot > 0) {
    const aR = aliceGot / bSent, bR = bobGot / aSent;
    if (aR < 0.5 || bR < 0.5) {
      console.log(`  ❌ SEVERE FRAME LOSS in bidirectional`);
      issues.push('SEVERE BIDIRECTIONAL LOSS');
    } else if (aR < 0.8 || bR < 0.8) {
      console.log(`  ⚠️  MODERATE FRAME LOSS in bidirectional`);
    } else {
      console.log(`  ✅ Bidirectional OK`);
    }
  }

  // ══════════════════════════════════════════════════════
  // TEST 6: Resume after 1s gap
  // ══════════════════════════════════════════════════════
  console.log('\n━━━ Test 6: Resume after 1s silence ━━━');
  bob.binaryFrames.length = 0;
  await wait(1000);

  const resumeSent = await sendRealtimeAudio(alice, 1000, 440);
  await wait(1000);
  const resumeRecv = bob.binaryFrames.length;

  console.log(`  Sent ${resumeSent}, received ${resumeRecv}`);
  if (resumeRecv === 0) {
    console.log(`  ❌ NO RESUME`);
    issues.push('NO RESUME after silence gap');
  } else if (resumeRecv < resumeSent * 0.5) {
    console.log(`  ⚠️  Poor resume (${(resumeRecv / resumeSent * 100).toFixed(0)}%)`);
  } else {
    console.log(`  ✅ Resume OK`);
  }

  // ══════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  DIAGNOSTIC SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (issues.length === 0) {
    console.log('  ✅ No major issues detected in server pipeline');
    console.log('  If still choppy, issue is client-side (jitter buffer, AudioWorklet)');
  } else {
    console.log('  ISSUES FOUND:');
    for (const i of issues) console.log(`    ❌ ${i}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Cleanup
  alice.ws.send(JSON.stringify({ type: 'voice_stop' }));
  bob.ws.send(JSON.stringify({ type: 'voice_stop' }));
  await wait(300);
  alice.ws.close();
  bob.ws.close();
  await wait(300);
  process.exit(issues.length > 0 ? 1 : 0);
}

runDiagnostic().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
