'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stub, load, fakeDatabase } = require('./helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const DIAG_TOKEN = 'diag-token-for-tests-0123456789';

let lexiconStub, bridge, base, sessions, tmp, publicDir;
let tokens = {};
const uploads = [];
const avatars = { set: [], removed: [] };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// raw request so that paths such as /../x reach the server untouched
function raw(method, rawPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({ host: url.hostname, port: url.port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(fields, file) {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const auth = (name) => ({ authorization: `Bearer ${tokens[name]}` });

test.before(async () => {
  // A stand-in for Lexicon that serves chat files
  lexiconStub = http.createServer((req, res) => {
    if (req.url === '/api/chat/files/1') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/api/chat/files/2') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
    res.writeHead(404); res.end();
  });
  const lexPort = await listen(lexiconStub);
  process.env.LEXICON_API_URL = `http://127.0.0.1:${lexPort}`;
  process.env.SUPERUSER_NAMES = 'alex';
  process.env.DIAG_TOKEN = DIAG_TOKEN;
  process.env.CSP_MODE = 'enforce';

  stub('database', fakeDatabase({
    getAvatarPath: async (u) => (u === 'Alice' ? '/uploads/avatars/Alice_1.png' : u === 'Evil' ? 'javascript:alert(1)' : null),
    setAvatarPath: async (...a) => { avatars.set.push(a); },
    removeAvatarPath: async (u) => { avatars.removed.push(u); },
  }));
  stub('lexicon-client', {
    uploadChatFile: async (...args) => { uploads.push(args); return { id: 5, url: '/api/chat/files/5', mimeType: args[2] }; },
    getVapidKey: async () => 'PUBLICKEY',
  });
  stub('voice-bridge', { voiceBridgeInstance: { diag: { getTailLogs: (n) => `LOGS:${n}`, exportSummary: () => ({ ok: 1 }), listLogFiles: () => ['a.log'] } } });

  const sec = load('security');
  sessions = new sec.SessionStore();
  tokens.alice = await sessions.create({ userId: 11, loginName: 'alice', displayName: 'Alice', strong: true });
  tokens.admin = await sessions.create({ userId: 1, loginName: 'alex', displayName: 'Alex', strong: true });
  tokens.impostor = await sessions.create({ userId: 99, loginName: 'mallory', displayName: 'alex', strong: true });
  tokens.weakAdminName = await sessions.create({ userId: 98, loginName: 'alex', displayName: 'alex', strong: false });

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-http-'));
  publicDir = path.join(tmp, 'public');
  fs.mkdirSync(path.join(publicDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<link href="/css/x.css"><script src="/js/app.js"></script>');
  fs.writeFileSync(path.join(publicDir, 'js', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(publicDir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(tmp, 'public-old'));
  fs.writeFileSync(path.join(tmp, 'public-old', 'secret.txt'), 'sibling secret');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"outside":true}');

  const { createHttpServer } = load('http-server');
  bridge = createHttpServer(publicDir, { sessions });
  base = `http://127.0.0.1:${await listen(bridge)}`;
});

test.after(() => {
  bridge.close();
  lexiconStub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('static files are served, with security headers and an enforced CSP', async () => {
  const r = await raw('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body.toString(), /app\.js\?v=/, 'cache-busting still applied');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(r.headers['content-security-policy'], /unsafe-inline.*script|script-src[^;]*unsafe/);
  assert.equal((await raw('GET', '/js/app.js')).status, 200);
});

test('path traversal, sibling folders and dot-files are refused', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/js/../../package.json',
    '/../public-old/secret.txt', '/%2e%2e%2fpublic-old%2fsecret.txt', '/.env', '/js/../.env', '/%2eenv', '/..\\package.json']) {
    const r = await raw('GET', p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body.toString(), /outside|sibling secret|SECRET=1/, `${p} leaked content`);
  }
  assert.equal((await raw('GET', '/%zz')).status, 400, 'bad escapes do not crash the server');
});

test('upload and remove routes need a signed-in session', async () => {
  const m = multipart({ username: 'victim', userId: '1' }, { field: 'avatar', filename: 'a.png', type: 'image/png', data: PNG });
  for (const [p, body, headers] of [['/api/avatar/upload', m.body, m.headers], ['/api/chat/upload', m.body, m.headers],
    ['/api/avatar/remove', Buffer.from('{"username":"victim"}'), { 'content-type': 'application/json' }]]) {
    assert.equal((await raw('POST', p, { headers, body })).status, 401, `${p} anonymous`);
    assert.equal((await raw('POST', p, { headers: { ...headers, authorization: 'Bearer ' + 'x'.repeat(43) }, body })).status, 401, `${p} bad token`);
  }
  assert.equal(avatars.set.length + avatars.removed.length + uploads.length, 0, 'nothing happened');
});

test('avatar upload is always for the signed-in user, whatever the form says', async () => {
  const m = multipart({ username: 'Victim', userId: '1' }, { field: 'avatar', filename: '../../evil.png', type: 'text/html', data: PNG });
  const r = await raw('POST', '/api/avatar/upload', { headers: { ...m.headers, ...auth('alice') }, body: m.body });
  assert.equal(r.status, 200, r.body.toString());
  const { avatarUrl } = JSON.parse(r.body);
  assert.match(avatarUrl, /^\/uploads\/avatars\/Alice_\d+\.png$/, 'named after the session user and the real type');
  assert.deepEqual(avatars.set.at(-1).slice(0, 1), ['Alice']);
  assert.equal(avatars.set.at(-1)[2], 11, 'user id comes from the session');
  assert.ok(fs.existsSync(path.join(publicDir, avatarUrl)));
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.png')));
});

test('avatar upload checks the real bytes, not the declared type', async () => {
  for (const data of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), Buffer.alloc(40, 65)]) {
    const m = multipart({}, { field: 'avatar', filename: 'a.png', type: 'image/png', data });
    const r = await raw('POST', '/api/avatar/upload', { headers: { ...m.headers, ...auth('alice') }, body: m.body });
    assert.equal(r.status, 400);
  }
});

test('an oversized avatar is refused with 413 and not stored', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 100000, 1)]);
  const m = multipart({}, { field: 'avatar', filename: 'a.png', type: 'image/png', data: big });
  const before = avatars.set.length;
  const r = await raw('POST', '/api/avatar/upload', { headers: { ...m.headers, ...auth('alice') }, body: m.body });
  assert.equal(r.status, 413);
  assert.equal(avatars.set.length, before);
});

test('avatar remove acts on the session user only', async () => {
  const r = await raw('POST', '/api/avatar/remove', { headers: { 'content-type': 'application/json', ...auth('alice') }, body: Buffer.from('{"username":"Victim"}') });
  assert.equal(r.status, 200);
  assert.equal(avatars.removed.at(-1), 'Alice');
});

test('chat upload is attributed to the session user and must really be an image', async () => {
  const ok = multipart({ username: 'Victim', userId: '1', channelId: '3' }, { field: 'file', filename: '<b>cat</b>.png', type: 'text/html', data: PNG });
  const r = await raw('POST', '/api/chat/upload', { headers: { ...ok.headers, ...auth('alice') }, body: ok.body });
  assert.equal(r.status, 200, r.body.toString());
  const [data, filename, type, userId, channelId] = uploads.at(-1);
  assert.equal(userId, 11, 'not the userId from the form');
  assert.equal(type, 'image/png', 'real type, not the declared one');
  assert.equal(channelId, 3);
  assert.doesNotMatch(filename, /[<>]/);
  assert.ok(Buffer.isBuffer(data));

  const bad = multipart({ userId: '1' }, { field: 'file', filename: 'x.png', type: 'image/png', data: Buffer.from('<html>not an image at all</html>') });
  assert.equal((await raw('POST', '/api/chat/upload', { headers: { ...bad.headers, ...auth('alice') }, body: bad.body })).status, 400);
});

test('chat files from Lexicon are only ever served as images', async () => {
  const img = await raw('GET', '/api/chat/files/1');
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  const html = await raw('GET', '/api/chat/files/2');
  assert.equal(html.headers['content-type'], 'application/octet-stream');
  assert.equal(html.headers['content-disposition'], 'attachment');
  assert.match(html.headers['content-security-policy'], /sandbox/);
  assert.equal((await raw('GET', '/api/chat/files/3')).status, 404);
  assert.equal((await raw('GET', '/api/chat/files/1/../../secret')).status, 404, 'only the exact file route is proxied');
});

test('avatar lookup stays open but never returns a non-avatar URL', async () => {
  assert.deepEqual(JSON.parse((await raw('GET', '/api/avatar/Alice')).body), { avatarUrl: '/uploads/avatars/Alice_1.png' });
  assert.deepEqual(JSON.parse((await raw('GET', '/api/avatar/Evil')).body), { avatarUrl: '/uploads/avatars/default.jpg' });
  assert.deepEqual(JSON.parse((await raw('GET', '/api/avatar/Nobody')).body), { avatarUrl: '/uploads/avatars/default.jpg' });
});

test('the public push key is still available without signing in', async () => {
  assert.deepEqual(JSON.parse((await raw('GET', '/api/push/vapid-key')).body), { publicKey: 'PUBLICKEY' });
});

test('diagnostics: admin session or DIAG_TOKEN only', async () => {
  assert.equal((await raw('GET', '/api/diag/summary')).status, 401);
  assert.equal((await raw('GET', '/api/diag/logs?lines=5')).status, 401);
  assert.equal((await raw('GET', '/api/diag/files', { headers: auth('alice') })).status, 403, 'ordinary user');
  assert.equal((await raw('GET', '/api/diag/files', { headers: auth('impostor') })).status, 403, 'display name equal to the admin name is not enough');
  assert.equal((await raw('GET', '/api/diag/files', { headers: auth('weakAdminName') })).status, 403, 'unverified name-only session');
  assert.equal((await raw('GET', '/api/diag/files', { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong' } })).status, 401);

  const admin = await raw('GET', '/api/diag/summary', { headers: auth('admin') });
  assert.equal(admin.status, 200);
  assert.deepEqual(JSON.parse(admin.body), { ok: 1 });
  const viaToken = await raw('GET', '/api/diag/logs?lines=99999', { headers: { authorization: `Bearer ${DIAG_TOKEN}` } });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.body.toString(), 'LOGS:5000', 'line count is clamped');
});

test('other methods on static paths are refused', async () => {
  assert.equal((await raw('POST', '/index.html')).status, 405);
  assert.equal((await raw('DELETE', '/js/app.js')).status, 405);
});

test('CORS is granted to the site and the app, not to other websites', async () => {
  const good = await raw('GET', '/api/avatar/Alice', { headers: { origin: 'https://voice.alex-dyakin.com' } });
  assert.equal(good.headers['access-control-allow-origin'], 'https://voice.alex-dyakin.com');
  const app = await raw('GET', '/api/avatar/Alice', { headers: { origin: 'capacitor://localhost' } });
  assert.equal(app.headers['access-control-allow-origin'], 'capacitor://localhost');
  const bad = await raw('GET', '/api/avatar/Alice', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const pre = await raw('OPTIONS', '/api/avatar/upload', { headers: { origin: 'capacitor://localhost' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
});

// ── transition switch for the installed Android app (uploads without a token) ──

test('legacy app uploads (switch ON): the old form-field behaviour works, a token is still honoured, a bad token never falls back', async () => {
  const config = load('config');
  config.security.allowLegacyAppUploads = true;
  try {
    // exactly what the installed Android app sends: username + userId in the form, no Authorization header
    const m = multipart({ username: 'AppUser', userId: '31', channelId: '2' }, { field: 'file', filename: 'p.png', type: 'image/png', data: PNG });
    const r = await raw('POST', '/api/chat/upload', { headers: m.headers, body: m.body });
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(uploads.at(-1)[3], 31);

    const av = multipart({ username: 'AppUser', userId: '31' }, { field: 'avatar', filename: 'a.png', type: 'image/png', data: PNG });
    assert.equal((await raw('POST', '/api/avatar/upload', { headers: av.headers, body: av.body })).status, 200);
    assert.equal(avatars.set.at(-1)[0], 'AppUser');

    const rm = await raw('POST', '/api/avatar/remove', { headers: { 'content-type': 'application/json' }, body: Buffer.from('{"username":"AppUser","userId":31}') });
    assert.equal(rm.status, 200);
    assert.equal(avatars.removed.at(-1), 'AppUser');

    // no name at all is still refused
    assert.equal((await raw('POST', '/api/avatar/remove', { headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })).status, 401);

    // a request that sends a token is held to it, whatever the form claims
    const bound = multipart({ username: 'Victim', userId: '1' }, { field: 'file', filename: 'p.png', type: 'image/png', data: PNG });
    assert.equal((await raw('POST', '/api/chat/upload', { headers: { ...bound.headers, ...auth('alice') }, body: bound.body })).status, 200);
    assert.equal(uploads.at(-1)[3], 11, 'the session, not the form');

    // and a token that is wrong does not quietly become a form-field login
    const forged = multipart({ username: 'Victim', userId: '1' }, { field: 'file', filename: 'p.png', type: 'image/png', data: PNG });
    const before = uploads.length;
    assert.equal((await raw('POST', '/api/chat/upload', { headers: { ...forged.headers, authorization: 'Bearer ' + 'q'.repeat(43) }, body: forged.body })).status, 401);
    assert.equal(uploads.length, before);
  } finally {
    config.security.allowLegacyAppUploads = false;
  }
});

test('legacy app uploads (switch OFF, the default): token-less requests are refused', async () => {
  const config = load('config');
  assert.equal(config.security.allowLegacyAppUploads, false);
  const m = multipart({ username: 'AppUser', userId: '31' }, { field: 'file', filename: 'p.png', type: 'image/png', data: PNG });
  const before = uploads.length;
  assert.equal((await raw('POST', '/api/chat/upload', { headers: m.headers, body: m.body })).status, 401);
  assert.equal(uploads.length, before);
});

// ── Lexicon's avatar proxy proves itself with the shared service token ──

test('Lexicon service token: works on the avatar routes only, and a wrong one is never accepted', async () => {
  const config = load('config');
  const SVC = 'shared-service-token-for-tests-0123456789';
  const WRONG = 'wrong-service-token-for-tests-0123456789';
  config.lexicon.serviceToken = SVC;
  try {
    // what Lexicon's AvatarProxyController sends: the player it already verified, in the form, plus the token
    const av = multipart({ username: 'Carol', userId: '41' }, { field: 'avatar', filename: 'a.png', type: 'image/png', data: PNG });
    const ok = await raw('POST', '/api/avatar/upload', { headers: { ...av.headers, 'x-service-token': SVC }, body: av.body });
    assert.equal(ok.status, 200, ok.body.toString());
    assert.equal(avatars.set.at(-1)[0], 'Carol');
    assert.equal(avatars.set.at(-1)[2], 41);

    const rm = await raw('POST', '/api/avatar/remove', { headers: { 'content-type': 'application/json', 'x-service-token': SVC }, body: Buffer.from('{"username":"Carol","userId":41}') });
    assert.equal(rm.status, 200);
    assert.equal(avatars.removed.at(-1), 'Carol');

    // still has to say who: no name, no action
    assert.equal((await raw('POST', '/api/avatar/remove', { headers: { 'content-type': 'application/json', 'x-service-token': SVC }, body: Buffer.from('{}') })).status, 401);

    // a wrong or empty token is refused outright, even though the legacy switch could otherwise let it through
    config.security.allowLegacyAppUploads = true;
    const before = avatars.set.length;
    for (const bad of [WRONG, '', 'x']) {
      const r = await raw('POST', '/api/avatar/upload', { headers: { ...av.headers, 'x-service-token': bad }, body: av.body });
      assert.equal(r.status, 401, `token "${bad}"`);
    }
    assert.equal(avatars.set.length, before);
    config.security.allowLegacyAppUploads = false;

    // the token buys nothing on the other routes
    const chat = multipart({ username: 'Carol', userId: '41' }, { field: 'file', filename: 'p.png', type: 'image/png', data: PNG });
    const uploadsBefore = uploads.length;
    assert.equal((await raw('POST', '/api/chat/upload', { headers: { ...chat.headers, 'x-service-token': SVC }, body: chat.body })).status, 401);
    assert.equal(uploads.length, uploadsBefore);
    assert.equal((await raw('GET', '/api/diag/summary', { headers: { 'x-service-token': SVC } })).status, 401);
  } finally {
    config.lexicon.serviceToken = '';
    config.security.allowLegacyAppUploads = false;
  }
});

test('with no service token configured, the header is never accepted', async () => {
  const config = load('config');
  assert.equal(config.lexicon.serviceToken, '');
  const av = multipart({ username: 'Carol', userId: '41' }, { field: 'avatar', filename: 'a.png', type: 'image/png', data: PNG });
  for (const hdr of ['', 'anything', 'undefined']) {
    assert.equal((await raw('POST', '/api/avatar/upload', { headers: { ...av.headers, 'x-service-token': hdr }, body: av.body })).status, 401);
  }
});
