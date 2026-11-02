'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, load, fakeWs, fakeDatabase } = require('./helpers');

process.env.SUPERUSER_NAMES = 'alex';

const db = stub('database', fakeDatabase({
  getAvatarPath: async (u) => (u === 'Spoof' ? 'javascript:alert(1)' : u === 'Bob' ? '/uploads/avatars/Bob_9.png' : null),
}));

// A stand-in for Lexicon: accounts with passwords, SSO tokens, and a record of what was asked of it
const accounts = {
  alex: { id: 1, username: 'alex', displayName: 'Alex', password: 'right-pass' },
  bob: { id: 2, username: 'bob', displayName: 'Bob', password: 'bob-pass' },
  mallory: { id: 3, username: 'mallory', displayName: 'alex', password: 'mal-pass' }, // renamed her display name to the admin's
};
const calls = { verify: 0, create: [], history: [], stored: [], queued: [] };
const lexiconFake = {
  async verifyCredentials(username, password) {
    calls.verify++;
    if (username === 'down') return { ok: false, status: 503 };
    if (username === 'locked') return { ok: false, status: 429, retryAfterSec: 42 };
    const a = accounts[String(username).toLowerCase()];
    if (!a || a.password !== password) return { ok: false, status: 401 };
    return { ok: true, player: { id: a.id, username: a.username, displayName: a.displayName } };
  },
  async validateSsoToken(token) {
    const map = { 'sso-alex': 'alex', 'sso-mallory': 'mallory', 'sso-bob': 'bob' };
    const u = map[token];
    return u ? { valid: true, userId: accounts[u].id, username: u, displayName: accounts[u].displayName } : { valid: false };
  },
  async getOrCreateUser(name) {
    calls.create.push(name);
    const a = accounts[String(name).toLowerCase()];
    return a ? { id: a.id, username: a.username, displayName: a.displayName } : { id: 50, username: name, displayName: name };
  },
  async getChannelMessages(...args) { calls.history.push(args); return []; },
  async storeMessage(m) { calls.stored.push(m); return { messageId: 77 }; },
  async queueToLivestream(...args) { calls.queued.push(args); return { ok: true }; },
  async searchMedia() { return []; },
};
stub('lexicon-client', lexiconFake);

const config = load('config');
const sec = load('security');
const featureRegistry = load('feature-registry');
const { handleClientMessage, isAdminFor } = load('client-handler');

let ipCounter = 0;
function session(overrides = {}) {
  const ws = fakeWs();
  const client = { userId: null, username: null, channelId: null, authenticated: false, ip: `10.0.0.${++ipCounter}`, ...overrides };
  const mumble = [];
  const voice = { started: [], moved: [] };
  const ctx = {
    mumble: { sendTextMessage: (channels, html) => mumble.push({ channels, html }) },
    channels: new Map([[0, { id: 0, name: 'Root' }], [5, { id: 5, name: 'Locked' }]]),
    voiceBridge: {
      startSession: async (...a) => voice.started.push(a),
      moveToChannel: (...a) => voice.moved.push(a),
      stopSession() {},
    },
    clients: new Map(),
    webClients: new Map(),
    broadcastAll() {},
    broadcastToChannel(ch, m) { (ctx.broadcasts ||= []).push({ ch, m }); },
    broadcastChannelUpdate() {},
    broadcastChannelRemove() {},
    sendPostAuthChannelTopUp() {},
    sessions: new sec.SessionStore(),
    lexicon: lexiconFake,
  };
  const send = (msg) => handleClientMessage(ws, msg, client, ctx);
  return { ws, client, ctx, mumble, voice, send };
}

function setSecurity({ nameOnly = false, nameOnlyAdmin = false } = {}) {
  config.security.allowNameOnlyLogin = nameOnly;
  config.security.nameOnlyAdmin = nameOnlyAdmin;
}

test.beforeEach(() => {
  setSecurity();
  featureRegistry.features.clear();
  calls.create.length = calls.history.length = calls.stored.length = calls.queued.length = 0;
});

// ── signing in ────────────────────────────────────────────

test('nothing but a sign-in message works before signing in', async () => {
  const s = session();
  for (const type of ['text', 'image', 'get_history', 'search_messages', 'join_channel', 'create_channel', 'media_search',
    'now_playing', 'music_queue', 'music_queue_add', 'voice_start', 'avatar_changed', 'push_subscribe', 'command', 'logout', 'dm_send']) {
    await s.send({ type, channelId: 0, text: 'hi' });
  }
  assert.ok(s.ws.sent.every((m) => m.type === 'error' && m.message === 'Not authenticated'), JSON.stringify(s.ws.sent));
  assert.equal(calls.stored.length + calls.history.length, 0);
  assert.equal(s.ctx.mumble && s.mumble.length, 0);
});

test('malformed messages are rejected, not crashed on', async () => {
  const s = session();
  for (const bad of [null, undefined, 5, 'str', [], {}, { type: 5 }, { type: null }]) await s.send(bad);
  assert.ok(s.ws.sent.every((m) => m.type === 'error'));
});

test('name-only sign-in is refused by default', async () => {
  const s = session();
  await s.send({ type: 'auth', username: 'alex' });
  const err = s.ws.last();
  assert.equal(err.type, 'auth_error');
  assert.equal(err.passwordRequired, true);
  assert.equal(s.client.authenticated, false);
  assert.equal(calls.create.length, 0, 'no Lexicon account is looked up or created for an unproven name');
});

test('password sign-in verifies against Lexicon and issues a session token', async () => {
  const s = session();
  await s.send({ type: 'auth', username: 'bob', password: 'bob-pass' });
  const ok = s.ws.ofType('auth_ok')[0];
  assert.ok(ok, JSON.stringify(s.ws.sent));
  assert.equal(ok.username, 'Bob');
  assert.equal(ok.userId, 2);
  assert.equal(ok.isAdmin, false);
  assert.equal(ok.verified, true);
  assert.match(ok.sessionToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal((await s.ctx.sessions.get(ok.sessionToken)).loginName, 'bob');
  assert.equal(s.client.authenticated, true);
  assert.deepEqual(db.mappings.at(-1), [2, 'bob', 'Bob']);
  // the avatar handed to everyone is one of ours
  assert.equal(s.ws.ofType('web_users')[0].webClients[0].avatarUrl, '/uploads/avatars/Bob_9.png');
});

test('wrong, missing and oversized passwords do not sign in', async () => {
  for (const password of ['nope', 'x'.repeat(500), 123, {}, null]) {
    const s = session();
    await s.send({ type: 'auth', username: 'bob', password });
    assert.equal(s.client.authenticated, false, `password ${JSON.stringify(password).slice(0, 20)}`);
    assert.ok(['auth_error'].includes(s.ws.last().type) || s.ws.last().type === 'error');
  }
});

test('an unknown account and a wrong password look identical', async () => {
  const a = session(); await a.send({ type: 'auth', username: 'ghost', password: 'x' });
  const b = session(); await b.send({ type: 'auth', username: 'bob', password: 'wrong' });
  assert.equal(a.ws.last().message, b.ws.last().message);
});

test('repeated wrong passwords slow the guesser down, per address and name', async () => {
  const s = session();
  s.client.ip = '198.51.100.7';
  for (let i = 0; i < 5; i++) await s.send({ type: 'auth', username: 'bob', password: 'wrong' + i });
  assert.match(s.ws.last().message, /Invalid username or password/);
  const before = calls.verify;
  await s.send({ type: 'auth', username: 'bob', password: 'wrong6' });   // 6th wrong -> now delayed
  await s.send({ type: 'auth', username: 'bob', password: 'bob-pass' }); // even the right password waits
  assert.match(s.ws.last().message, /Too many failed attempts/);
  assert.equal(calls.verify, before + 1, 'blocked attempts never reach Lexicon');
  // a different address (the real owner) is unaffected
  const other = session();
  await other.send({ type: 'auth', username: 'bob', password: 'bob-pass' });
  assert.equal(other.client.authenticated, true);
});

test('too many sign-in attempts from one address are cut off before Lexicon', async () => {
  const s = session();
  s.client.ip = '198.51.100.99';
  for (let i = 0; i < 20; i++) await s.send({ type: 'auth', username: 'user' + i, password: 'x' });
  const before = calls.verify;
  await s.send({ type: 'auth', username: 'user99', password: 'x' });
  assert.match(s.ws.last().message, /Too many sign-in attempts/);
  assert.equal(calls.verify, before);
});

test('Lexicon being down or throttling is reported honestly and does not count as a wrong password', async () => {
  const down = session(); await down.send({ type: 'auth', username: 'down', password: 'x' });
  assert.match(down.ws.last().message, /unavailable/);
  const locked = session(); await locked.send({ type: 'auth', username: 'locked', password: 'x' });
  assert.match(locked.ws.last().message, /42 seconds/);
});

test('a signed-in socket cannot sign in again as someone else', async () => {
  const s = session();
  await s.send({ type: 'auth', username: 'bob', password: 'bob-pass' });
  await s.send({ type: 'auth', username: 'alex', password: 'right-pass' });
  assert.equal(s.ws.last().type, 'error');
  assert.equal(s.client.username, 'Bob');
});

// ── admin rights ──────────────────────────────────────────

test('the admin signs in with a password and is admin', async () => {
  const s = session();
  await s.send({ type: 'auth', username: 'alex', password: 'right-pass' });
  assert.equal(s.ws.ofType('auth_ok')[0].isAdmin, true);
});

test('renaming your display name to the admin name does not make you admin (password or SSO)', async () => {
  const pw = session();
  await pw.send({ type: 'auth', username: 'mallory', password: 'mal-pass' });
  assert.equal(pw.client.username, 'alex', 'she does show as "alex"');
  assert.equal(pw.client.isAdmin, false);

  const sso = session();
  await sso.send({ type: 'sso_auth', token: 'sso-mallory' });
  assert.equal(sso.client.isAdmin, false);

  const mod = session();
  await mod.send({ type: 'create_channel', name: 'x' });
  assert.equal(mod.ws.last().message, 'Not authenticated');
  await pw.send({ type: 'create_channel', name: 'Hijack' });
  assert.match(pw.ws.last().message, /Only superusers/);
});

test('SSO sign-in works, marks the session verified and keeps admin for the real admin', async () => {
  const s = session();
  await s.send({ type: 'sso_auth', token: 'sso-alex' });
  const ok = s.ws.ofType('auth_ok')[0];
  assert.equal(ok.sso, true);
  assert.equal(ok.verified, true);
  assert.equal(ok.isAdmin, true);
  assert.ok(ok.sessionToken);
  const bad = session();
  await bad.send({ type: 'sso_auth', token: 'forged' });
  assert.equal(bad.ws.last().type, 'auth_error');
  assert.equal(bad.client.authenticated, false);
  const empty = session();
  await empty.send({ type: 'sso_auth', token: {} });
  assert.equal(empty.client.authenticated, false);
});

test('legacy name-only mode (transition switch): works, but is never admin unless NAME_ONLY_ADMIN is also on', async () => {
  setSecurity({ nameOnly: true });
  const s = session();
  await s.send({ type: 'auth', username: 'alex' });
  const ok = s.ws.ofType('auth_ok')[0];
  assert.ok(ok, 'still works during the transition');
  assert.equal(ok.verified, false);
  assert.equal(ok.isAdmin, false);

  setSecurity({ nameOnly: true, nameOnlyAdmin: true });
  const legacy = session();
  await legacy.send({ type: 'auth', username: 'alex' });
  assert.equal(legacy.ws.ofType('auth_ok')[0].isAdmin, true, 'old behaviour only with the explicit switch');
});

test('isAdminFor follows the configured names', () => {
  assert.equal(isAdminFor({ loginName: 'alex', displayName: 'zzz', strong: true }), true);
  assert.equal(isAdminFor({ loginName: 'bob', displayName: 'alex', strong: true }), false);
});

// ── resuming a session ────────────────────────────────────

test('a session token lets a reconnecting client back in without the password, even after a bridge restart', async () => {
  const first = session();
  await first.send({ type: 'auth', username: 'bob', password: 'bob-pass' });
  const token = first.ws.ofType('auth_ok')[0].sessionToken;

  const again = session();
  again.ctx.sessions = first.ctx.sessions;
  await again.send({ type: 'resume', sessionToken: token });
  const ok = again.ws.ofType('auth_ok')[0];
  assert.equal(ok.username, 'Bob');
  assert.equal(ok.sessionToken, token, 'same token, not a new one');
  assert.equal(again.client.authenticated, true);

  const bogus = session();
  await bogus.send({ type: 'resume', sessionToken: 'z'.repeat(43) });
  assert.equal(bogus.ws.last().type, 'auth_error');
  assert.equal(bogus.ws.last().sessionExpired, true);
  assert.equal(bogus.client.authenticated, false);
});

test('a resumed session recomputes admin from current settings instead of trusting a stored flag', async () => {
  const s = session();
  const token = await s.ctx.sessions.create({ userId: 2, loginName: 'bob', displayName: 'Bob', strong: true, isAdmin: true });
  await s.send({ type: 'resume', sessionToken: token });
  assert.equal(s.client.isAdmin, false);
});

test('a name-only session cannot be resumed once name-only sign-in is switched off', async () => {
  setSecurity({ nameOnly: true });
  const a = session();
  await a.send({ type: 'auth', username: 'newbie' });
  const token = a.ws.ofType('auth_ok')[0].sessionToken;
  setSecurity({ nameOnly: false });
  const b = session();
  b.ctx.sessions = a.ctx.sessions;
  await b.send({ type: 'resume', sessionToken: token });
  assert.equal(b.client.authenticated, false);
});

test('logout revokes the session token', async () => {
  const s = session();
  await s.send({ type: 'auth', username: 'bob', password: 'bob-pass' });
  const token = s.ws.ofType('auth_ok')[0].sessionToken;
  await s.send({ type: 'logout' });
  assert.equal(await s.ctx.sessions.get(token), null);
});

// ── what signed-in users can make the server do ───────────

async function signedIn(name = 'bob', pass = 'bob-pass') {
  const s = session();
  await s.send({ type: 'auth', username: name, password: pass });
  s.ws.sent.length = 0;
  return s;
}

test('chat text is escaped before it reaches native Mumble clients (which render HTML)', async () => {
  const s = await signedIn();
  await s.send({ type: 'text', channelId: 0, text: '<img src=x onerror=alert(1)> & "q"' });
  assert.equal(s.mumble.length, 1);
  assert.equal(s.mumble[0].html, '<b>Bob:</b> &lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
  assert.equal(calls.stored.at(-1).content, '<img src=x onerror=alert(1)> & "q"', 'stored as typed; each viewer escapes on display');
  const sent = s.ctx.broadcasts.at(-1).m;
  assert.equal(sent.html, '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
});

test('a user name containing markup is escaped in the Mumble message too', async () => {
  accounts.evil = { id: 9, username: 'evil', displayName: '<script>x</script>', password: 'p' };
  const s = await signedIn('evil', 'p');
  await s.send({ type: 'text', channelId: 0, text: 'hi' });
  assert.equal(s.mumble[0].html, '<b>&lt;script&gt;x&lt;/script&gt;:</b> hi');
});

test('empty, huge and non-string chat text is dropped or refused', async () => {
  const s = await signedIn();
  await s.send({ type: 'text', channelId: 0, text: '   ' });
  await s.send({ type: 'text', channelId: 0, text: { toString: () => '<b>' } });
  assert.equal(s.mumble.length, 0);
  await s.send({ type: 'text', channelId: 0, text: 'x'.repeat(4001) });
  assert.match(s.ws.last().message, /too long/);
  assert.equal(s.mumble.length, 0);
});

test('image messages are rebuilt from validated values only', async () => {
  const s = await signedIn();
  await s.send({
    type: 'image', channelId: '0', fileId: '5',
    fileUrl: 'javascript:alert(1)', thumbnailUrl: 'https://evil.example/t.png',
    originalFilename: '"><img src=x onerror=alert(1)>.png', mimeType: 'image/png',
    width: '640', height: 'DROP TABLE', caption: '<b>hi</b>',
  });
  const m = s.ctx.broadcasts.at(-1).m;
  assert.equal(m.type, 'image');
  assert.equal(m.fileId, 5);
  assert.equal(m.fileUrl, '/api/chat/files/5', 'rebuilt from the id');
  assert.equal(m.thumbnailUrl, null, 'foreign thumbnail dropped');
  assert.doesNotMatch(m.originalFilename, /[<>"']/);
  assert.equal(m.width, 640);
  assert.equal(m.height, null);
  assert.doesNotMatch(s.mumble[0].html, /<img|onerror=alert\(1\)>/);

  for (const bad of [{ fileId: 'abc', mimeType: 'image/png' }, { fileId: 5, mimeType: 'text/html' }, { fileId: 5, mimeType: 'image/svg+xml' }, {}]) {
    const before = s.ctx.broadcasts.length;
    await s.send({ type: 'image', channelId: 0, ...bad });
    assert.equal(s.ctx.broadcasts.length, before, `rejected ${JSON.stringify(bad)}`);
    assert.equal(s.ws.last().message, 'Invalid image');
  }
});

test('a GIF is stored as a GIF; the type comes from the validated mime type', async () => {
  const s = await signedIn();
  await s.send({ type: 'image', channelId: 0, fileId: 8, mimeType: 'image/gif', isGif: false, thumbnailUrl: '/api/chat/files/8/thumb' });
  assert.equal(calls.stored.at(-1).messageType, 'GIF');
  assert.equal(s.ctx.broadcasts.at(-1).m.thumbnailUrl, '/api/chat/files/8/thumb');
});

test('restricted channels: no text, history, join or voice without access', async () => {
  featureRegistry.features.set('channel-access', { canAccess: (ch, uid, admin) => admin || ch !== 5 });
  const s = await signedIn();
  await s.send({ type: 'text', channelId: 5, text: 'psst' });
  await s.send({ type: 'get_history', channelId: 5 });
  await s.send({ type: 'join_channel', channelId: 5 });
  await s.send({ type: 'voice_start', voiceChannelId: 5 });
  assert.equal(s.ws.sent.filter((m) => m.message === 'You do not have access to this channel').length, 4);
  assert.equal(s.mumble.length, 0);
  assert.equal(calls.history.length, 0);
  assert.equal(s.voice.started.length, 0, 'voice never started for a channel the user cannot see');

  // already in voice somewhere else, then tries to hop into the restricted channel
  await s.send({ type: 'voice_start', voiceChannelId: 0 });
  assert.equal(s.voice.started.length, 1);
  await s.send({ type: 'voice_join_channel', channelId: 5 });
  assert.equal(s.voice.moved.length, 0, 'move refused');
  assert.equal(s.ws.last().message, 'You do not have access to this channel');

  const admin = await signedIn('alex', 'right-pass');
  await admin.send({ type: 'voice_start', voiceChannelId: 5 });
  assert.equal(admin.voice.started.length, 1, 'the real admin may');
});

test('voice start still treats channel 0 / absent as "no particular channel", as before', async () => {
  const s = await signedIn();
  await s.send({ type: 'voice_start', voiceChannelId: 0 });
  await s.send({ type: 'voice_start' });
  assert.equal(s.voice.started.length, 2);
  assert.equal(s.voice.moved.length, 0);
  await s.send({ type: 'voice_start', voiceChannelId: 'one; DROP' });
  assert.equal(s.ws.last().message, 'Invalid channel');
});

test('ids from the client are plain integers before they are used in Lexicon calls', async () => {
  const s = await signedIn();
  await s.send({ type: 'get_history', channelId: '0&userId=2', limit: '999999', before: '1 OR 1=1' });
  const [ch, limit, before] = calls.history.at(-1);
  assert.equal(ch, 0);
  assert.equal(limit, 200);
  assert.equal(before, null);
  await s.send({ type: 'music_queue_add', mediaFileId: '7;rm' });
  assert.equal(calls.queued.length, 0);
  await s.send({ type: 'music_queue_add', mediaFileId: '7' });
  assert.deepEqual(calls.queued.at(-1), [2, 7], 'queued as the signed-in user');
});

test('avatar_changed ignores the URL in the message and announces our own record', async () => {
  const s = await signedIn('bob', 'bob-pass');
  const announced = [];
  s.ctx.broadcastAll = (m) => announced.push(m);
  await s.send({ type: 'avatar_changed', avatarUrl: 'javascript:alert(1)' });
  assert.equal(announced.at(-1).type, 'avatar_updated');
  assert.equal(announced.at(-1).avatarUrl, '/uploads/avatars/Bob_9.png');
});

test('a stored avatar path that is not one of ours is never handed out', async () => {
  accounts.spoof = { id: 12, username: 'spoof', displayName: 'Spoof', password: 'p' };
  const s = session();
  await s.send({ type: 'auth', username: 'spoof', password: 'p' });
  assert.equal(s.ws.ofType('web_users')[0].webClients.find((w) => w.username === 'Spoof').avatarUrl, '/uploads/avatars/default.jpg');
});
