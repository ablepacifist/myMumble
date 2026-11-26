'use strict';
/**
 * The bridge passes the visitor's address to Lexicon when it checks a password (see LexiconClient.verifyCredentials).
 * A throwaway local HTTP server stands in for Lexicon; nothing real is contacted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { load } = require('./helpers');

let seen;
let server;
let port;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/permissions/7') return res.end(JSON.stringify({ userId: 7, role: 'ADMIN', permissions: ['VOICE_ADMIN'] }));
      if (req.url === '/api/permissions/8') { res.statusCode = 404; return res.end('{}'); }
      if (req.url.startsWith('/api/permissions/')) { res.statusCode = 500; return res.end('{}'); }
      res.end(JSON.stringify({ id: 7, username: 'zx', permissions: ['VOICE_ADMIN'] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  process.env.LEXICON_API_URL = `http://127.0.0.1:${port}`;
});

test.after(() => new Promise((r) => server.close(r)));

// src/lexicon-client.js exports one shared client, built when first loaded (after LEXICON_API_URL is set above)
function newClient() {
  return load('lexicon-client');
}

test('a valid visitor address is sent as CF-Connecting-IP on the login check', async () => {
  seen = [];
  const r = await newClient().verifyCredentials('zx', 'pw', '203.0.113.9');
  assert.equal(r.ok, true);
  const login = seen.find((x) => x.url === '/api/auth/login');
  assert.equal(login.headers['cf-connecting-ip'], '203.0.113.9');
});

test('IPv6 visitor addresses are passed on too', async () => {
  seen = [];
  await newClient().verifyCredentials('zx', 'pw', '2001:db8::1');
  assert.equal(seen.find((x) => x.url === '/api/auth/login').headers['cf-connecting-ip'], '2001:db8::1');
});

test('missing, "unknown" or malformed addresses send no header at all', async () => {
  for (const bad of [undefined, null, 'unknown', '', '1.2.3.4, 5.6.7.8', '1.2.3.4\r\nX-Evil: 1', 'x'.repeat(80), 42]) {
    seen = [];
    await newClient().verifyCredentials('zx', 'pw', bad);
    const login = seen.find((x) => x.url === '/api/auth/login');
    assert.equal(login.headers['cf-connecting-ip'], undefined, `no header for ${JSON.stringify(bad)}`);
  }
});

test('the permissions Lexicon returns with a login are passed on', async () => {
  seen = [];
  const r = await newClient().verifyCredentials('zx', 'pw', '203.0.113.9');
  assert.deepEqual(r.player.permissions, ['VOICE_ADMIN']);
});

test('getPermissions: an answer, "no such player" (none), and "no answer" are told apart', async () => {
  const client = newClient();
  assert.deepEqual(await client.getPermissions(7), ['VOICE_ADMIN']);
  assert.deepEqual(await client.getPermissions(8), [], 'unknown player has no permissions');
  assert.equal(await client.getPermissions(9), undefined, 'a Lexicon error is no answer, so the fallback applies');
  seen = [];
  assert.equal(await client.getPermissions('1/../../x'), undefined, 'only plain ids are sent');
  assert.equal(seen.length, 0);
});
