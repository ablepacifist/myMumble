#!/usr/bin/env node
/**
 * Test: WebSocket connection and authentication flow.
 *
 * Tests:
 *  1. Can connect to WebSocket server
 *  2. Can send JSON auth message and receive auth_ok
 *  3. Receives channel/user state after auth
 *  4. Can send/receive text messages
 *  5. Binary messages are NOT misrouted as text
 *  6. Disconnect cleans up properly
 *
 * Usage:
 *   node tests/test-ws-connect.js [host] [port]
 *
 * Defaults to localhost:3080.
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

async function runTests() {
  console.log(`\n🧪 WebSocket Connection Tests — ${URL}\n`);

  // ── Test 1: Basic connection ──
  let ws;
  try {
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(URL);
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
      s.on('open', () => { clearTimeout(timeout); resolve(s); });
      s.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
    assert(true, 'WebSocket connection opens');
  } catch (err) {
    assert(false, `WebSocket connection opens (${err.message})`);
    printResults();
    return;
  }

  // Collect messages
  const messages = [];
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

  // ── Test 2: Send auth and get auth_ok ──
  ws.send(JSON.stringify({ type: 'auth', username: 'test_user_' + Date.now() }));
  await wait(2000); // Wait for auth + state messages

  const authOk = messages.find(m => m.type === 'auth_ok');
  assert(!!authOk, 'Receives auth_ok response');
  assert(authOk && authOk.username, 'auth_ok contains username');
  assert(authOk && authOk.userId !== undefined, 'auth_ok contains userId');

  // ── Test 3: Receives state after auth ──
  const channelUpdate = messages.find(m => m.type === 'channel_update');
  const userUpdate = messages.find(m => m.type === 'user_update');
  const webUsers = messages.find(m => m.type === 'web_users');
  const webJoin = messages.find(m => m.type === 'web_user_join');
  // At least web_users should come (list of web clients)
  assert(!!webUsers, 'Receives web_users list after auth');
  assert(!!webJoin, 'Receives web_user_join broadcast');

  // ── Test 4: Send text message ──
  messages.length = 0;
  ws.send(JSON.stringify({ type: 'text', channelId: 0, text: 'Test message from automated test' }));
  await wait(1000);

  const textMsg = messages.find(m => m.type === 'text');
  assert(!!textMsg, 'Receives text echo after sending message');
  if (textMsg) {
    assert(textMsg.text === 'Test message from automated test', 'Text content matches');
    assert(!!textMsg.timestamp, 'Text has timestamp');
  }

  // ── Test 5: Binary data is handled separately ──
  messages.length = 0;
  // Send a small binary buffer (simulates audio PCM)
  const fakePCM = Buffer.alloc(1920); // 960 Int16 samples
  ws.send(fakePCM);
  await wait(500);

  // We should NOT get an error about 'Invalid JSON' from the binary
  const jsonError = messages.find(m => m.type === 'error' && m.message === 'Invalid JSON');
  assert(!jsonError, 'Binary data not misrouted as JSON text');

  // ── Test 5b: Odd-sized binary doesn't crash server ──
  messages.length = 0;
  // Send buffer with odd byte count — previously crashed the server
  const oddBuffer = Buffer.alloc(1921); // Odd size, unaligned for Int16
  ws.send(oddBuffer);
  await wait(500);

  // Server must still be alive — send a JSON message to verify
  ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 1 }));
  await wait(500);
  const stillAlive = messages.find(m => m.type === 'history');
  assert(!!stillAlive, 'Server survives odd-sized binary data (no crash)');

  // ── Test 5c: Rapid binary + text interleaving ──
  messages.length = 0;
  // Interleave binary and text rapidly — tests ws v8 isBinary routing
  for (let i = 0; i < 5; i++) {
    ws.send(Buffer.alloc(1920));
    ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 1 }));
  }
  await wait(1000);
  const historyResponses = messages.filter(m => m.type === 'history');
  assert(historyResponses.length === 5, 'All 5 interleaved text messages get responses');
  const interleaveErrors = messages.filter(m => m.type === 'error');
  assert(interleaveErrors.length === 0, 'No errors from binary/text interleaving');

  // ── Test 6: Get history ──
  messages.length = 0;
  ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 5 }));
  await wait(1000);

  const history = messages.find(m => m.type === 'history');
  assert(!!history, 'Receives history response');
  assert(history && Array.isArray(history.messages), 'History contains messages array');

  // ── Test 7: Unknown message type returns error ──
  messages.length = 0;
  ws.send(JSON.stringify({ type: 'definitely_not_a_real_type' }));
  await wait(500);

  const unknownErr = messages.find(m => m.type === 'error');
  assert(!!unknownErr, 'Unknown message type returns error');

  // ── Test 8: Clean disconnect ──
  ws.close();
  await wait(500);
  assert(ws.readyState === WebSocket.CLOSED, 'WebSocket closes cleanly');

  // ── Test 9: Second client connection works ──
  let ws2;
  try {
    ws2 = await new Promise((resolve, reject) => {
      const s = new WebSocket(URL);
      const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
      s.on('open', () => { clearTimeout(timeout); resolve(s); });
      s.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
    assert(true, 'Second client can connect');
    ws2.close();
  } catch (err) {
    assert(false, `Second client can connect (${err.message})`);
  }

  await wait(300);
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
