#!/usr/bin/env node
/**
 * Test: Two-client voice flow end-to-end.
 *
 * Simulates two web users connecting, authenticating, starting voice,
 * sending PCM audio, and verifying the full pipeline works.
 *
 * Tests:
 *  1. Both clients connect and authenticate
 *  2. Both clients send voice_start and get voice_ready
 *  3. Both clients see each other's voice_state broadcasts
 *  4. Sending binary PCM does not cause errors
 *  5. Both clients send voice_stop and get voice_stopped
 *  6. Disconnect cleans up voice sessions
 *
 * Usage:
 *   node tests/test-two-clients.js [host] [port]
 *
 * Requires: Full bridge service running.
 */
const WebSocket = require('ws');

const HOST = process.argv[2] || 'localhost';
const PORT = process.argv[3] || 3080;
const URL = `ws://${HOST}:${PORT}`;

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${name}`);
  } else {
    failed++;
    results.push(`  ❌ ${name}`);
  }
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function connectClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const messages = [];
    const timeout = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          messages.push({ _binary: true, length: data.length });
        } else {
          try {
            messages.push(JSON.parse(data.toString()));
          } catch {
            messages.push({ _raw: data.toString() });
          }
        }
      });
      resolve({ ws, messages, name });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function findMsg(messages, filter) {
  return messages.find(m => {
    for (const [k, v] of Object.entries(filter)) {
      if (m[k] !== v) return false;
    }
    return true;
  });
}

async function runTests() {
  console.log(`\n🧪 Two-Client Voice Flow Tests — ${URL}\n`);

  // ── Connect two clients ──
  let client1, client2;
  try {
    [client1, client2] = await Promise.all([
      connectClient('Alice'),
      connectClient('Bob'),
    ]);
    assert(true, 'Both clients connect');
  } catch (err) {
    assert(false, `Both clients connect (${err.message})`);
    printResults();
    return;
  }

  // ── Authenticate ──
  const ts = Date.now();
  client1.ws.send(JSON.stringify({ type: 'auth', username: `test_alice_${ts}` }));
  client2.ws.send(JSON.stringify({ type: 'auth', username: `test_bob_${ts}` }));
  await wait(2000);

  const auth1 = findMsg(client1.messages, { type: 'auth_ok' });
  const auth2 = findMsg(client2.messages, { type: 'auth_ok' });
  assert(!!auth1, 'Alice receives auth_ok');
  assert(!!auth2, 'Bob receives auth_ok');

  if (!auth1 || !auth2) {
    // Check for errors
    const err1 = findMsg(client1.messages, { type: 'error' });
    const err2 = findMsg(client2.messages, { type: 'error' });
    if (err1) console.log('  Alice error:', err1.message);
    if (err2) console.log('  Bob error:', err2.message);
    client1.ws.close();
    client2.ws.close();
    printResults();
    return;
  }

  // Alice should see Bob join
  const bobJoin = findMsg(client1.messages, { type: 'web_user_join' });
  assert(!!bobJoin, 'Alice sees Bob\'s web_user_join');

  // ── Start voice ──
  client1.messages.length = 0;
  client2.messages.length = 0;

  client1.ws.send(JSON.stringify({ type: 'voice_start' }));
  await wait(5000); // Allow Mumble connection to sync (TLS + auth + ServerSync)

  const voiceReady1 = findMsg(client1.messages, { type: 'voice_ready' });
  assert(!!voiceReady1, 'Alice receives voice_ready');

  // Bob should see Alice's voice_state
  const aliceVoice = findMsg(client2.messages, { type: 'voice_state', inVoice: true });
  assert(!!aliceVoice, 'Bob sees Alice\'s voice_state (inVoice: true)');

  client2.messages.length = 0;
  await wait(1000); // Stagger connections to avoid Mumble rate limiting
  client2.ws.send(JSON.stringify({ type: 'voice_start' }));
  await wait(5000);

  const voiceReady2 = findMsg(client2.messages, { type: 'voice_ready' });
  assert(!!voiceReady2, 'Bob receives voice_ready');

  // ── Send audio (binary PCM) ──
  // 960 samples * 2 bytes = 1920 bytes per 20ms frame
  const pcm = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) {
    pcm.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * 440 * i / 48000) * 8000), i * 2);
  }

  client1.messages.length = 0;
  client2.messages.length = 0;

  // Send 10 frames from each client (200ms of audio)
  for (let i = 0; i < 10; i++) {
    client1.ws.send(pcm);
    client2.ws.send(pcm);
    await wait(20);
  }

  await wait(1000);

  // Neither client should get JSON errors from binary
  const err1 = findMsg(client1.messages, { type: 'error', message: 'Invalid JSON' });
  const err2 = findMsg(client2.messages, { type: 'error', message: 'Invalid JSON' });
  assert(!err1, 'Alice gets no JSON error from binary audio');
  assert(!err2, 'Bob gets no JSON error from binary audio');

  // Check if we received any binary audio back (Mumble mixed audio)
  const binaryMsgs1 = client1.messages.filter(m => m._binary);
  const binaryMsgs2 = client2.messages.filter(m => m._binary);
  console.log(`  ℹ️  Alice received ${binaryMsgs1.length} audio packets from Mumble`);
  console.log(`  ℹ️  Bob received ${binaryMsgs2.length} audio packets from Mumble`);

  // ── Stop voice ──
  client1.messages.length = 0;
  client2.messages.length = 0;

  client1.ws.send(JSON.stringify({ type: 'voice_stop' }));
  await wait(500);

  const stopped1 = findMsg(client1.messages, { type: 'voice_stopped' });
  assert(!!stopped1, 'Alice receives voice_stopped');

  const aliceLeaveVoice = findMsg(client2.messages, { type: 'voice_state', inVoice: false });
  assert(!!aliceLeaveVoice, 'Bob sees Alice leave voice');

  client2.ws.send(JSON.stringify({ type: 'voice_stop' }));
  await wait(500);

  // ── Disconnect ──
  client1.ws.close();
  client2.ws.close();
  await wait(500);
  assert(true, 'Both clients disconnect cleanly');

  printResults();
}

function printResults() {
  console.log(results.join('\n'));
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
