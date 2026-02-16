#!/usr/bin/env node
/**
 * Test: Server stability under stress and edge cases.
 *
 * These tests verify the bridge server itself doesn't crash or misbehave.
 * They use ONE voice session to avoid Mumble autoban (10 TLS connects
 * in 120s = global IP ban). Voice multi-client tests are in
 * test-three-clients.js with realistic timing.
 *
 * Tests:
 *  1. Binary before auth (no voicePeerId)
 *  2. Odd-sized binary buffers with active voice session
 *  3. Rapid binary flood (100 frames)
 *  4. Interleaved binary + text at speed
 *  5. Malformed JSON doesn't crash
 *  6. Very large message
 *  7. Multiple concurrent WebSocket clients (text only)
 *  8. Abrupt disconnect mid-voice
 *  9. Server still accepts new clients after all abuse
 *
 * Usage:
 *   node tests/test-stability.js [host] [port]
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

function connectAndAuth(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const messages = [];
    const timeout = setTimeout(() => reject(new Error(`${name}: auth timeout`)), 8000);

    ws.on('open', () => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          messages.push({ _binary: true, length: data.length });
        } else {
          try { messages.push(JSON.parse(data.toString())); } catch {}
        }
      });
      ws.send(JSON.stringify({ type: 'auth', username: name }));
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const check = setInterval(() => {
      const authOk = messages.find(m => m.type === 'auth_ok');
      if (authOk) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve({ ws, messages, name });
      }
    }, 100);
  });
}

function serverIsAlive() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const timeout = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close();
      resolve(true);
    });
    ws.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

async function runTests() {
  console.log(`\n🧪 Server Stability Tests — ${URL}\n`);

  const alive0 = await serverIsAlive();
  assert(alive0, 'Server is alive at start');
  if (!alive0) { printResults(); return; }

  // ── 1: Binary before auth (no voicePeerId set) ──
  {
    const ws = new WebSocket(URL);
    await new Promise((res) => { ws.on('open', res); ws.on('error', res); });
    try {
      ws.send(Buffer.alloc(1920));
      ws.send(Buffer.alloc(960));
      ws.send(Buffer.alloc(13)); // odd size
      await wait(300);
      ws.close();
      assert(true, 'Binary before auth: no crash');
    } catch (e) {
      assert(false, `Binary before auth: ${e.message}`);
    }
  }
  await wait(200);
  assert(await serverIsAlive(), 'Server alive after pre-auth binary');

  // ── 2: Auth, start voice, send odd-sized buffers ──
  let client;
  try {
    client = await connectAndAuth('stress_' + Date.now());
  } catch (e) {
    assert(false, `Auth for stability tests: ${e.message}`);
    printResults();
    return;
  }

  // ONE voice session — kept for the rest of the test
  client.ws.send(JSON.stringify({ type: 'voice_start' }));
  await wait(6000);

  const voiceReady = client.messages.find(m => m.type === 'voice_ready');
  assert(!!voiceReady, 'Voice session starts');
  if (!voiceReady) {
    const err = client.messages.find(m => m.type === 'error');
    if (err) console.log(`    Voice error: ${err.message}`);
  }

  // Int16Array alignment regression test
  const oddSizes = [1, 3, 7, 13, 100, 959, 961, 1919, 1921, 5000];
  for (const size of oddSizes) {
    try { client.ws.send(Buffer.alloc(size)); } catch {}
  }
  await wait(500);
  assert(await serverIsAlive(), 'Server survives odd-sized binary buffers');

  // ── 3: Rapid binary flood ──
  for (let i = 0; i < 100; i++) {
    try { client.ws.send(Buffer.alloc(1920)); } catch { break; }
  }
  await wait(500);
  assert(await serverIsAlive(), 'Server survives 100 rapid binary frames');

  // ── 4: Interleaved binary + text ──
  client.messages.length = 0;
  for (let i = 0; i < 20; i++) {
    try {
      client.ws.send(Buffer.alloc(1920));
      client.ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 1 }));
    } catch { break; }
  }
  await wait(1500);
  const histCount = client.messages.filter(m => m.type === 'history').length;
  assert(histCount === 20, `All 20 interleaved texts get responses (got ${histCount})`);
  assert(await serverIsAlive(), 'Server alive after interleave flood');

  // ── 5: Malformed JSON ──
  const malformed = ['{bad', '', '{"type":}', 'null', '[]', '{"type":"auth"}'];
  for (const m of malformed) {
    try { client.ws.send(m); } catch {}
  }
  await wait(500);
  assert(await serverIsAlive(), 'Server survives malformed JSON');

  // ── 6: Large message ──
  try {
    client.ws.send(JSON.stringify({ type: 'text', channelId: 0, text: 'X'.repeat(100000) }));
    await wait(500);
    assert(await serverIsAlive(), 'Server survives 100KB text message');
  } catch {
    assert(true, 'Server survives 100KB text message (send rejected)');
  }

  // ── 7: Multiple concurrent WS clients (text only, no voice = no Mumble connections) ──
  const extras = [];
  try {
    for (let i = 0; i < 5; i++) {
      extras.push(await connectAndAuth(`conc_${Date.now()}_${i}`));
    }
    assert(true, '5 concurrent WebSocket clients connect');

    for (const c of extras) {
      c.ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 1 }));
    }
    await wait(1000);
    const allGotHistory = extras.every(c => c.messages.some(m => m.type === 'history'));
    assert(allGotHistory, 'All 5 concurrent clients get responses');

    for (const c of extras) c.ws.close();
    await wait(300);
    assert(await serverIsAlive(), 'Server alive after 5 clients disconnect');
  } catch (e) {
    assert(false, `Concurrent clients: ${e.message}`);
    for (const c of extras) try { c.ws.close(); } catch {}
  }

  // ── 8: Abrupt disconnect mid-voice ──
  client.ws.terminate();
  await wait(500);
  assert(await serverIsAlive(), 'Server survives abrupt disconnect mid-voice');

  // ── 9: New client after all abuse ──
  try {
    const finalClient = await connectAndAuth('final_' + Date.now());
    assert(true, 'New client connects after all stress tests');
    finalClient.ws.close();
  } catch (e) {
    assert(false, `New client after stress: ${e.message}`);
  }

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
