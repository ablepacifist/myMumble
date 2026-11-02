'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const net = require('net');
const { stub, load, fakeDatabase } = require('./helpers');

// pick a free port, then tell the bridge to use it
const port = await_free_port();
function await_free_port() {
  // synchronous-ish: derive from the process id to avoid collisions between parallel test files
  return 41000 + (process.pid % 2000);
}

process.env.WS_PORT = String(port);
process.env.SUPERUSER_NAMES = 'alex';
process.env.WS_MAX_PAYLOAD_BYTES = '4096';

stub('database', fakeDatabase());
const accounts = { bob: { id: 2, username: 'bob', displayName: 'Bob', password: 'bob-pass' } };
stub('lexicon-client', {
  async verifyCredentials(u, p) {
    const a = accounts[u];
    return a && a.password === p ? { ok: true, player: { id: a.id, username: a.username, displayName: a.displayName } } : { ok: false, status: 401 };
  },
  async getOrCreateUser(n) { return { id: 50, username: n, displayName: n }; },
  async validateSsoToken() { return { valid: false }; },
});
stub('voice-bridge', class { async init() {} startSession() {} stopSession() {} handleAudioFromBrowser() {} });

const config = load('config');
const BridgeWebSocketServer = load('ws-server');

let server;
const open = [];

function connect(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const msgs = [];
    ws.on('message', (d, isBinary) => { if (!isBinary) msgs.push(JSON.parse(d.toString())); });
    ws.on('open', () => { open.push(ws); resolve({ ws, msgs }); });
    ws.on('error', reject);
    ws.on('unexpected-response', (req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(10); } return false; };

test.before(async () => {
  const mumble = new EventEmitter();
  mumble.sendTextMessage = () => {};
  server = new BridgeWebSocketServer(mumble);
  server.channels.set(0, { id: 0, name: 'Root' });
  server.users.set(1, { session: 1, name: 'SomeoneOnMumble' });
  await server.start();
});

test.after(async () => {
  for (const ws of open) { try { ws.terminate(); } catch (_) {} }
  await new Promise((r) => server.wss.close(r));
  server.httpServer.close();
  clearInterval(server.sweeper);
});

test('a page on another website cannot open a socket; the site, the app and plain clients can', async () => {
  await assert.rejects(connect({ Origin: 'https://evil.example' }), (e) => e.status === 403);
  await assert.rejects(connect({ Origin: 'https://alex-dyakin.com.evil.example' }), (e) => e.status === 403);
  await connect({ Origin: 'https://voice.alex-dyakin.com' });
  await connect({ Origin: 'capacitor://localhost' });
  await connect({ Origin: `http://127.0.0.1:${port}` });   // same-origin LAN access
  await connect();                                           // non-browser client, no Origin
});

test('nothing about Mumble users or channels is sent before signing in', async () => {
  const { msgs } = await connect();
  await wait(100);
  assert.deepEqual(msgs, []);
});

test('after signing in the client receives the channels and Mumble users', async () => {
  const { ws, msgs } = await connect();
  ws.send(JSON.stringify({ type: 'auth', username: 'bob', password: 'bob-pass' }));
  assert.ok(await until(() => msgs.some((m) => m.type === 'server_state')), JSON.stringify(msgs));
  const state = msgs.find((m) => m.type === 'server_state');
  assert.deepEqual(state.channels.map((c) => c.id), [0]);
  assert.equal(state.users[0].name, 'SomeoneOnMumble');
  const ok = msgs.find((m) => m.type === 'auth_ok');
  assert.ok(ok.sessionToken && ok.verified);
});

test('name-only sign-in is refused over the wire and the socket gets no access', async () => {
  const { ws, msgs } = await connect();
  ws.send(JSON.stringify({ type: 'auth', username: 'alex' }));
  assert.ok(await until(() => msgs.some((m) => m.type === 'auth_error')));
  ws.send(JSON.stringify({ type: 'text', channelId: 0, text: 'hi' }));
  assert.ok(await until(() => msgs.some((m) => m.message === 'Not authenticated')));
  assert.equal(msgs.some((m) => m.type === 'server_state' || m.type === 'auth_ok'), false);
});

test('oversized frames are rejected by the socket layer', async () => {
  const { ws } = await connect();
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.send(JSON.stringify({ type: 'auth', username: 'x', password: 'y'.repeat(10000) }));
  assert.equal(await closed, 1009, 'message too big');
});

test('a flood of messages is throttled, then the connection is dropped', async () => {
  const { ws, msgs } = await connect();
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  for (let i = 0; i < 400; i++) ws.send(JSON.stringify({ type: 'ping_flood', i }));
  assert.ok(await until(() => msgs.some((m) => /too quickly/.test(m.message || ''))));
  assert.equal(await closed, 1008);
});

test('garbage that is not JSON does not crash the server', async () => {
  const { ws, msgs } = await connect();
  ws.send('{not json');
  assert.ok(await until(() => msgs.some((m) => m.message === 'Invalid JSON')));
  ws.send('null');
  ws.send('123');
  await wait(100);
  const again = await connect();   // server still accepts connections
  assert.ok(again.ws.readyState === WebSocket.OPEN);
});

test('too many connections from one address are refused', async () => {
  server.maxConnectionsPerAddress = 3;
  const socks = [];
  let refused = 0;
  for (let i = 0; i < 6; i++) {
    const c = await connect();
    socks.push(c.ws);
    c.ws.on('close', (code) => { if (code === 1013) refused++; });
  }
  await wait(200);
  assert.ok(refused >= 1, 'at least one extra connection was turned away');
  server.maxConnectionsPerAddress = 40;
  socks.forEach((s) => s.terminate());
});

test('the web page and the avatar lookup still work on the same port', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/avatar/Nobody`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).avatarUrl, '/uploads/avatars/default.jpg');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>|<!DOCTYPE html>/i);
});
