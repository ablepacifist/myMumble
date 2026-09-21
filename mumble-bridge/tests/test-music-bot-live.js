#!/usr/bin/env node
/**
 * Test: music bot control plane, end-to-end against a live bridge.
 *
 * This only exercises the parts that are mechanically testable over WS —
 * command routing, the two prerequisite bug fixes, and !volume/!stop.
 * Whether audio actually SOUNDS right needs a human in an actual voice
 * channel — this test can't verify that, and doesn't try to.
 *
 * Tests:
 *  1. Web-typed !help actually reaches the bot (prerequisite fix #1 —
 *     the WS 'command' handler used to be dead code)
 *  2. The bot's reply is delivered to web WS clients, not just Mumble
 *     (prerequisite fix #2 — mumble-relay.js drops the bridge's own
 *     TextMessages before they reach web clients)
 *  3. !volume with no args reports the current (default 50%) volume
 *  4. !volume <n> sets and reports the new volume, clamped to [0,150]
 *  5. !play with no voice channel joined gives the "join a voice channel"
 *     soft notice, not a hard error (queuing can succeed independent of
 *     voice presence)
 *  6. !stop is accepted and doesn't error even with nothing playing
 *
 * Usage:
 *   node tests/test-music-bot-live.js [host] [port]
 *
 * Safe to run against the live/production instance — no channels created,
 * no lasting state changes beyond the (harmless, in-memory) volume level.
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
  return new Promise((r) => setTimeout(r, ms));
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    const messages = [];
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch (_) {}
    });
    ws.on('open', () => { clearTimeout(timeout); resolve({ ws, messages }); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function auth(conn, username) {
  conn.messages.length = 0;
  conn.ws.send(JSON.stringify({ type: 'auth', username }));
  return wait(2500).then(() => conn.messages.find((m) => m.type === 'auth_ok'));
}

function send(conn, msg) {
  conn.ws.send(JSON.stringify(msg));
}

async function runTests() {
  console.log(`\n🧪 Music Bot Live Tests — ${URL}\n`);

  let user;
  try {
    user = await connect();
    assert(true, 'Web socket connects');
  } catch (err) {
    assert(false, `Web socket connects (${err.message})`);
    printResults();
    return;
  }

  const authOk = await auth(user, 'musictest_' + Date.now());
  assert(!!authOk, 'Auth succeeds');

  // ── Prerequisite fixes: web-typed command reaches the bot and comes back over WS ──
  user.messages.length = 0;
  send(user, { type: 'command', command: 'help', args: [] });
  await wait(1000);
  const helpReply = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!helpReply, 'Web-typed !help reaches the bot and the reply is delivered over WS');
  assert(!!helpReply && /Mumble Bridge Bot/i.test(helpReply.html || helpReply.text || ''), 'Help reply contains expected content');

  // ── !volume ──
  user.messages.length = 0;
  send(user, { type: 'command', command: 'volume', args: [] });
  await wait(800);
  const volReply1 = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!volReply1 && /\d+%/.test(volReply1.html || ''), 'Bare !volume reports current percentage');

  user.messages.length = 0;
  send(user, { type: 'command', command: 'volume', args: ['30'] });
  await wait(800);
  const volReply2 = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!volReply2 && /30%/.test(volReply2.html || ''), '!volume 30 sets and reports 30%');

  user.messages.length = 0;
  send(user, { type: 'command', command: 'volume', args: ['999'] });
  await wait(800);
  const volReply3 = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!volReply3 && /150%/.test(volReply3.html || ''), '!volume 999 clamps to 150%');

  // restore default so this test doesn't leave volume in a surprising state for real usage
  send(user, { type: 'command', command: 'volume', args: ['50'] });
  await wait(500);

  // ── !play without being in voice — soft notice, not a hard error ──
  user.messages.length = 0;
  send(user, { type: 'command', command: 'play', args: ['test', 'song', 'query', 'xyz123'] });
  await wait(3000); // Lexicon search + queue round trip
  const playReply = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!playReply, 'Web-typed !play gets a response');
  if (playReply) {
    const text = playReply.html || playReply.text || '';
    const isNoResults = /No results/i.test(text);
    const isSoftNotice = /join a voice channel/i.test(text);
    assert(isNoResults || isSoftNotice, `!play without voice presence replies sensibly (got: "${text.slice(0, 80)}")`);
  }

  // ── !stop is safe to call even with nothing active ──
  user.messages.length = 0;
  send(user, { type: 'command', command: 'stop', args: [] });
  await wait(800);
  const stopReply = user.messages.find((m) => m.type === 'text' && m.source === 'bot');
  assert(!!stopReply && /Stopped/i.test(stopReply.html || ''), '!stop is accepted and replies even with nothing playing');

  user.ws.close();
  await wait(300);
  printResults();
}

function printResults() {
  console.log(results.join('\n'));
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
