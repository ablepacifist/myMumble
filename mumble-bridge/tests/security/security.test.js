'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');
const sec = load('security');

test('escapeHtml neutralises markup and quotes, and tolerates null', () => {
  assert.equal(sec.escapeHtml('<img src=x onerror="a()">&\'`'), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#039;`');
  assert.equal(sec.escapeHtml(null), '');
  assert.equal(sec.escapeHtml(undefined), '');
  assert.equal(sec.escapeHtml(12), '12');
});

test('safeAvatarUrl only passes our own avatar files', () => {
  assert.equal(sec.safeAvatarUrl('/uploads/avatars/alex_1771710676768.webp'), '/uploads/avatars/alex_1771710676768.webp');
  for (const bad of ['javascript:alert(1)', 'https://evil.example/a.png', '//evil.example/a.png', '/uploads/avatars/../../etc/passwd',
    '/uploads/avatars/a b.png', '/uploads/avatars/"onerror=alert(1)', '/other/a.png', null, undefined, 42, '']) {
    assert.equal(sec.safeAvatarUrl(bad), sec.DEFAULT_AVATAR, `should reject ${bad}`);
  }
});

test('safeChatFileUrl and safeImageType', () => {
  assert.equal(sec.safeChatFileUrl('/api/chat/files/12'), '/api/chat/files/12');
  assert.equal(sec.safeChatFileUrl('/api/chat/files/12/thumb'), '/api/chat/files/12/thumb');
  for (const bad of ['/api/chat/files/12/../x', 'javascript:alert(1)', 'https://evil/api/chat/files/1', '/api/chat/files/x', null, 5]) {
    assert.equal(sec.safeChatFileUrl(bad), null);
  }
  assert.equal(sec.safeImageType('IMAGE/PNG'), 'image/png');
  assert.equal(sec.safeImageType('image/svg+xml'), null);
  assert.equal(sec.safeImageType('text/html'), null);
});

test('safeFilename removes path parts, markup and control characters', () => {
  assert.equal(sec.safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sec.safeFilename('C:\\x\\cat<script>.png'), 'catscript.png');
  assert.equal(sec.safeFilename('a"b\'c&d\n.png'), 'abcd.png');
  assert.equal(sec.safeFilename(null), '');
  assert.ok(sec.safeFilename('x'.repeat(500)).length <= 120);
});

test('toId and clampInt accept only plain non-negative integers', () => {
  assert.equal(sec.toId(5), 5);
  assert.equal(sec.toId('7'), 7);
  assert.equal(sec.toId(0), 0);
  for (const bad of [-1, 1.5, '1.5', '1e3', 'abc', '', null, undefined, NaN, Infinity, '99999999999999', {}, [], '1 OR 1=1', '1&userId=2']) {
    assert.equal(sec.toId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(sec.clampInt('9999', 1, 200, 50), 200);
  assert.equal(sec.clampInt('0', 1, 200, 50), 1);
  assert.equal(sec.clampInt('junk', 1, 200, 50), 50);
});

test('sniffImageType reads the real format from the bytes', () => {
  const pad = Buffer.alloc(16);
  assert.equal(sec.sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), 'image/jpeg');
  assert.equal(sec.sniffImageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad])), 'image/png');
  assert.equal(sec.sniffImageType(Buffer.concat([Buffer.from('GIF89a'), pad])), 'image/gif');
  assert.equal(sec.sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), pad])), 'image/webp');
  assert.equal(sec.sniffImageType(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sec.sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sec.sniffImageType(Buffer.alloc(3)), null);
  assert.equal(sec.sniffImageType('not a buffer'), null);
});

test('isAdminIdentity: only a verified login name counts', () => {
  const cfg = { superUsers: ['alex'], nameOnlyAdmin: false };
  assert.equal(sec.isAdminIdentity({ loginName: 'Alex', displayName: 'x', strong: true }, cfg), true, 'case-insensitive login name');
  // a user who renamed their display name to the admin's name is not an admin
  assert.equal(sec.isAdminIdentity({ loginName: 'mallory', displayName: 'alex', strong: true }, cfg), false);
  // a typed name proves nothing
  assert.equal(sec.isAdminIdentity({ loginName: 'alex', displayName: 'alex', strong: false }, cfg), false);
  // transition switch restores the old behaviour for name-only sessions only
  assert.equal(sec.isAdminIdentity({ loginName: 'alex', displayName: 'alex', strong: false }, { ...cfg, nameOnlyAdmin: true }), true);
  assert.equal(sec.isAdminIdentity({ loginName: 'mallory', displayName: 'alex', strong: true }, { ...cfg, nameOnlyAdmin: true }), false);
  assert.equal(sec.isAdminIdentity({ loginName: 'alex', strong: true }, { superUsers: [], nameOnlyAdmin: true }), false);
});

test('originAllowed: this site, known apps, and no-Origin clients; not other websites', () => {
  assert.equal(sec.originAllowed(undefined, 'voice.alex-dyakin.com'), true);
  assert.equal(sec.originAllowed('https://voice.alex-dyakin.com', 'x'), true);
  assert.equal(sec.originAllowed('https://alex-dyakin.com', 'x'), true);
  assert.equal(sec.originAllowed('capacitor://localhost', 'x'), true);
  assert.equal(sec.originAllowed('http://192.168.1.6:3080', '192.168.1.6:3080'), true, 'same-origin on the LAN');
  assert.equal(sec.originAllowed('https://evil.example', 'voice.alex-dyakin.com'), false);
  assert.equal(sec.originAllowed('https://alex-dyakin.com.evil.example', 'voice.alex-dyakin.com'), false);
  assert.equal(sec.originAllowed('https://evilalex-dyakin.com', 'voice.alex-dyakin.com'), false);
  assert.equal(sec.originAllowed('null', 'voice.alex-dyakin.com'), false);
});

test('clientIp believes forwarding headers only from loopback', () => {
  const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  assert.equal(sec.clientIp(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(sec.clientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(sec.clientIp(req('192.168.1.50', { 'cf-connecting-ip': '1.2.3.4' })), '192.168.1.50', 'spoofed header ignored');
  assert.equal(sec.clientIp(req('127.0.0.1', {})), '127.0.0.1');
});

test('bearerToken and safeEqual', () => {
  const tok = 'A'.repeat(43);
  assert.equal(sec.bearerToken({ headers: { authorization: `Bearer ${tok}` } }), tok);
  assert.equal(sec.bearerToken({ headers: { authorization: 'Bearer short' } }), null);
  assert.equal(sec.bearerToken({ headers: { authorization: `Basic ${tok}` } }), null);
  assert.equal(sec.bearerToken({ headers: {} }), null);
  assert.equal(sec.safeEqual('abc', 'abc'), true);
  assert.equal(sec.safeEqual('abc', 'abd'), false);
  assert.equal(sec.safeEqual('abc', 'abcd'), false);
});

test('RateLimiter allows max per window then recovers', () => {
  let t = 1000;
  const rl = new sec.RateLimiter(3, 1000, () => t);
  assert.ok(rl.take('k').ok && rl.take('k').ok && rl.take('k').ok);
  const blocked = rl.take('k');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
  assert.ok(rl.take('other').ok, 'keys are independent');
  t += 1001;
  assert.ok(rl.take('k').ok, 'window slid past');
});

test('LoginThrottle: free attempts, then doubling waits, cleared by success', () => {
  let t = 0;
  const lt = new sec.LoginThrottle({ freeAttempts: 3, baseMs: 5000, maxMs: 40000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.ok(lt.check('a').ok); lt.failure('a'); }
  assert.ok(lt.check('a').ok, 'still free after 3 failures');
  lt.failure('a');                                   // 4th failure -> 5s
  let r = lt.check('a');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterMs, 5000);
  t += 5001;
  assert.ok(lt.check('a').ok);
  lt.failure('a');                                   // 5th -> 10s
  assert.equal(lt.check('a').retryAfterMs, 10000);
  t += 10001; lt.failure('a'); t += 20001; lt.failure('a');
  assert.ok(lt.check('a').retryAfterMs <= 40000, 'capped');
  assert.ok(lt.check('b').ok, 'other keys unaffected');
  lt.success('a');
  assert.ok(lt.check('a').ok, 'success clears it');
});

test('SessionStore: opaque tokens, expiry, revoke, hashed persistence, restart survival', async () => {
  let t = 1000;
  const saved = new Map();
  const persistence = {
    save: async (h, r) => saved.set(h, r),
    load: async (h) => saved.get(h) || null,
    remove: async (h) => saved.delete(h),
  };
  const info = { userId: 7, loginName: 'bob', displayName: 'Bob', strong: true };
  const store = new sec.SessionStore({ ttlMs: 5000, persistence, now: () => t });
  const token = await store.create(info);

  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.ok(![...saved.keys()].includes(token), 'the raw token is never stored');
  assert.ok([...saved.keys()].every((k) => /^[0-9a-f]{64}$/.test(k)), 'only a SHA-256 is stored');
  assert.equal((await store.get(token)).loginName, 'bob');
  assert.equal(await store.get('x'.repeat(43)), null);
  assert.equal(await store.get(undefined), null);
  assert.equal(await store.get('short'), null);

  // a brand-new store (bridge restart) still honours the token via the database
  const restarted = new sec.SessionStore({ ttlMs: 5000, persistence, now: () => t });
  assert.equal((await restarted.get(token)).userId, 7);

  t += 5001;
  assert.equal(await store.get(token), null, 'expired');
  assert.equal(saved.size, 0, 'expired session removed from the database');

  const t2 = await store.create(info);
  await store.revoke(t2);
  assert.equal(await store.get(t2), null);
  assert.equal(await restarted.get(t2), null);
});

test('SessionStore keeps working if persistence throws', async () => {
  const boom = { save: async () => { throw new Error('db down'); }, load: async () => { throw new Error('db down'); }, remove: async () => { throw new Error('db down'); } };
  const store = new sec.SessionStore({ persistence: boom });
  const token = await store.create({ userId: 1, loginName: 'a', displayName: 'a', strong: true });
  assert.equal((await store.get(token)).userId, 1);
  assert.equal(await store.get('y'.repeat(43)), null);
});
