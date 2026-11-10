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
      res.end(JSON.stringify({ id: 7, username: 'zx' }));
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
