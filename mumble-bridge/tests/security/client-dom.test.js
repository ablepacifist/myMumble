'use strict';
/**
 * Runs the real web client (public/index.html + js/*.js) in a simulated browser, feeds it hostile data as if it
 * came from the server, and checks the resulting page. Needs jsdom, which the Lexicon website project already
 * has; the tests are skipped if it cannot be found.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const JSDOM_CANDIDATES = [
  process.env.JSDOM_PATH,
  path.join(__dirname, '..', '..', 'node_modules', 'jsdom'),
  path.join(__dirname, '..', '..', '..', '..', 'Lexicon', 'node_modules', 'jsdom'),
  'C:\\Users\\HP\\full-back-end-server\\Lexicon\\node_modules\\jsdom',
].filter(Boolean);

let JSDOM = null;
for (const c of JSDOM_CANDIDATES) {
  try { ({ JSDOM } = require(c)); break; } catch (_) { /* try the next */ }
}
const skip = JSDOM ? false : 'jsdom not available';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.CLOSED = 3;

const openWindows = [];
test.afterEach(() => { while (openWindows.length) { try { openWindows.pop().close(); } catch (_) { /* already closed */ } } });

function boot({ search = '', session = null, withRenderer = true } = {}) {
  FakeWebSocket.instances.length = 0;
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, {
    url: 'https://voice.alex-dyakin.com/' + search,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = FakeWebSocket;
      window.alert = () => {};
      window.confirm = () => true;
      window.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => '' });
      window.HTMLElement.prototype.scrollIntoView = () => {};
      if (session) window.sessionStorage.setItem('bridgeSession', session);
    },
  });
  const { window } = dom;
  openWindows.push(window);
  for (const f of (withRenderer ? ['js/rich-text-renderer.js', 'js/chat.js'] : ['js/chat.js'])) window.eval(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
  return { window, document: window.document, dom };
}

// Every attribute that could run script or reach the network from hostile data
function assertPageIsInert(document, label = '') {
  const bad = [];
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) bad.push(`<${el.tagName.toLowerCase()} ${attr.name}>`);
      if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && /^\s*(javascript|data:text\/html|vbscript):/i.test(attr.value)) bad.push(`${attr.name}=${attr.value}`);
    }
    if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'FORM', 'LINK', 'META'].includes(el.tagName.toUpperCase())
        && !el.closest('head') && !el.hasAttribute('data-allowed')) {
      if (!(el.tagName.toUpperCase() === 'SVG')) bad.push(`<${el.tagName.toLowerCase()}> element in body`);
    }
  }
  assert.deepEqual(bad, [], `${label}: dangerous markup found: ${bad.join(', ')}`);
}

const PAYLOADS = [
  '<img src=x onerror=window.__pwn=1>',
  '"><img src=x onerror=window.__pwn=1>',
  "'><svg onload=window.__pwn=1>",
  '<script>window.__pwn=1</script>',
  '<iframe src="javascript:window.__pwn=1"></iframe>',
  '<a href="javascript:window.__pwn=1">x</a>',
  '<<img src=x onerror=window.__pwn=1',
  '**<img src=x onerror=window.__pwn=1>**',
  '||<img src=x onerror=window.__pwn=1>||',
  '`<img src=x onerror=window.__pwn=1>`',
  'https://x.example/"onmouseover="window.__pwn=1',
  "https://x.example/'onmouseover='window.__pwn=1",
  'https://x.example/a.png"onerror="window.__pwn=1',
  "https://x.example/a.png'),alert(1),('",
  '[click](https://x.example/"onmouseover="window.__pwn=1)',
];

function signIn(t) {
  const { window, document } = t;
  document.querySelector('#username-input').value = 'bob';
  document.querySelector('#password-input').value = 'pw';
  document.querySelector('#login-btn').click();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.receive({ type: 'auth_ok', username: 'Bob', userId: 2, isAdmin: true, sessionToken: 'T'.repeat(43), verified: true });
  return { ws, window, document };
}

test('login form: username + password are sent, the password is not kept after sign-in', { skip }, () => {
  const { window, document } = boot();
  document.querySelector('#username-input').value = 'bob';
  document.querySelector('#password-input').value = 'hunter2';
  document.querySelector('#login-btn').click();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  assert.deepEqual(ws.sent[0], { type: 'auth', username: 'bob', password: 'hunter2' });
  ws.receive({ type: 'auth_ok', username: 'Bob', userId: 2, isAdmin: false, sessionToken: 'S'.repeat(43), verified: true });
  assert.equal(document.querySelector('#password-input').value, '', 'password field cleared');
  assert.equal(window.sessionStorage.getItem('bridgeSession'), 'S'.repeat(43));
  assert.ok(document.querySelector('#chat-screen').classList.contains('active'));
});

test('a wrong password shows the reason and keeps the sign-in form; trying again works on the same connection', { skip }, () => {
  const { document } = boot();
  document.querySelector('#username-input').value = 'bob';
  document.querySelector('#password-input').value = 'wrong';
  document.querySelector('#login-btn').click();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  ws.receive({ type: 'auth_error', message: 'Invalid username or password' });
  assert.match(document.querySelector('#login-error').textContent, /Invalid username or password/);
  assert.ok(document.querySelector('#login-screen').classList.contains('active'));
  assert.equal(document.querySelector('#password-input').value, '');
  document.querySelector('#password-input').value = 'right';
  document.querySelector('#login-btn').click();
  assert.deepEqual(ws.sent.at(-1), { type: 'auth', username: 'bob', password: 'right' });
  assert.equal(FakeWebSocket.instances.length, 1, 'no second connection needed');
});

test('a reload while signed in resumes by token without asking for the password', { skip }, () => {
  const { document } = boot({ session: 'R'.repeat(43) });
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'connects on its own');
  ws.open();
  assert.deepEqual(ws.sent[0], { type: 'resume', sessionToken: 'R'.repeat(43) });
  ws.receive({ type: 'auth_error', message: 'Your session has ended. Please sign in again.', sessionExpired: true });
  assert.equal(document.defaultView.sessionStorage.getItem('bridgeSession'), null, 'dead token forgotten');
  assert.match(document.querySelector('#login-error').textContent, /session has ended/);
});

test('SSO sign-in from the Lexicon site still works and the token leaves the address bar', { skip }, () => {
  const { window } = boot({ search: '?token=abc123' });
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  assert.deepEqual(ws.sent[0], { type: 'sso_auth', token: 'abc123' });
  assert.equal(window.location.search, '');
});

test('sign out tells the server to end the session and forgets it', { skip }, () => {
  const t = boot();
  const { ws, document, window } = signIn(t);
  document.querySelector('#settings-logout').click();
  assert.ok(ws.sent.some((m) => m.type === 'logout'));
  assert.equal(window.sessionStorage.getItem('bridgeSession'), null);
});

test('hostile channel names, usernames, message text and history never become live markup', { skip }, () => {
  const t = boot();
  const { ws, document, window } = signIn(t);
  let id = 100;
  ws.receive({
    type: 'server_state',
    channels: PAYLOADS.map((p, i) => ({ id: i + 1, name: p, parentId: 0 })).concat([{ id: 0, name: 'Root' }]),
    users: PAYLOADS.map((p, i) => ({ session: i + 1, name: p, channelId: 0 })),
  });
  ws.receive({ type: 'web_users', webClients: PAYLOADS.map((p, i) => ({ id: 'web_' + (i + 10), username: p, channelId: 0, inVoice: i % 2 === 0, voiceChannelId: 1, avatarUrl: p })) });
  for (const p of PAYLOADS) {
    ws.receive({ type: 'text', id: ++id, channelId: 0, username: p, text: p, timestamp: new Date().toISOString() });
    ws.receive({ type: 'text', channelId: 0, username: 'u' + id, text: p, html: undefined, timestamp: new Date().toISOString() }); // no id: key built from the text
  }
  ws.receive({
    type: 'history',
    channelId: 0,
    messages: PAYLOADS.map((p, i) => ({ id: 500 + i, senderName: p, content: p, createdAt: new Date(2026, 0, 1, 0, i).toISOString(), replyToId: 100 + i })),
  });
  ws.receive({ type: 'notifications', notifications: PAYLOADS.map((p, i) => ({ id: i, fromUsername: p, channelName: p, messagePreview: p, createdAt: new Date().toISOString() })) });

  assertPageIsInert(document, 'after hostile text');
  assert.equal(window.__pwn, undefined);
  // the text is still readable by people: shown literally, not dropped
  assert.match(document.querySelector('#messages').textContent, /onerror=window\.__pwn=1/);
});

test('server-supplied avatars and attachments can only point at our own files', { skip }, () => {
  const t = boot();
  const { ws, document } = signIn(t);
  ws.receive({ type: 'web_users', webClients: [
    { id: 'web_20', username: 'EvilA', channelId: 0, inVoice: false, avatarUrl: 'javascript:window.__pwn=1' },
    { id: 'web_21', username: 'EvilB', channelId: 0, inVoice: false, avatarUrl: 'https://tracker.example/pixel.gif' },
    { id: 'web_22', username: 'Fine', channelId: 0, inVoice: false, avatarUrl: '/uploads/avatars/Fine_1.png' },
  ] });
  ws.receive({ type: 'avatar_updated', username: 'EvilA', avatarUrl: '"><img src=x onerror=window.__pwn=1>' });
  ws.receive({ type: 'image', id: 900, channelId: 0, username: 'Mallory', fileId: 5,
    fileUrl: 'javascript:window.__pwn=1', thumbnailUrl: 'https://tracker.example/x.png', originalFilename: '"><svg onload=window.__pwn=1>', mimeType: 'image/png', width: '1;background:url(//x)', height: 'x" onerror="y' });
  ws.receive({ type: 'image', id: 901, channelId: 0, username: 'Mallory', fileUrl: '/api/chat/files/7"onerror="window.__pwn=1', thumbnailUrl: '/api/chat/files/7/thumb', originalFilename: 'ok.png', mimeType: 'image/png', width: 300, height: 200 });
  ws.receive({ type: 'text', id: 902, channelId: 0, username: 'Mallory', text: 'hi', timestamp: new Date().toISOString() });

  assertPageIsInert(document, 'avatars/attachments');
  const srcs = [...document.querySelectorAll('img')].map((i) => i.getAttribute('src')).filter(Boolean);
  for (const s of srcs) {
    assert.ok(/^\/uploads\/avatars\/[\w.-]+(\?t=\d+)?$/.test(s) || /^\/api\/chat\/files\/\d+(\/thumb)?$/.test(s), `unexpected image source: ${s}`);
  }
  assert.ok(srcs.includes('/uploads/avatars/Fine_1.png') || srcs.some((s) => s.startsWith('/uploads/avatars/Fine_1.png')), 'legitimate avatar still shown');
  const attachmentImgs = [...document.querySelectorAll('.message-attachment img')];
  assert.equal(attachmentImgs.length, 1, 'only the attachment with a valid file URL is rendered');
  assert.equal(attachmentImgs[0].getAttribute('src'), '/api/chat/files/7/thumb');
  assert.doesNotMatch(attachmentImgs[0].getAttribute('style') || '', /url\(|;.*;.*;/);
});

test('links in messages (the built-in fallback used when the renderer script is missing): only http(s), nothing can break out of the href', { skip }, () => {
  const t = boot({ withRenderer: false });
  const { ws, document } = signIn(t);
  ws.receive({ type: 'history', channelId: 0, messages: [
    { id: 1, senderName: 'a', content: 'see https://example.com/page?a=1&b=2 and https://example.com/pic.png ok', createdAt: '2026-01-01T00:00:00Z' },
    { id: 2, senderName: 'b', content: 'x https://x.example/"onmouseover="window.__pwn=1 y', createdAt: '2026-01-01T00:01:00Z' },
    { id: 3, senderName: 'c', content: "x https://x.example/pic.png' onerror='window.__pwn=1 y", createdAt: '2026-01-01T00:02:00Z' },
    { id: 4, senderName: 'd', content: 'a [click](https://x.example/"onmouseover="window.__pwn=1) b [ok](https://example.com/ok) c', createdAt: '2026-01-01T00:03:00Z' },
    { id: 5, senderName: 'e', content: "[x](https://x.example/'onmouseover='window.__pwn=1)", createdAt: '2026-01-01T00:04:00Z' },
  ] });
  assertPageIsInert(document, 'links');
  const hrefs = [...document.querySelectorAll('#messages a')].map((a) => a.getAttribute('href'));
  assert.ok(hrefs.length >= 3);
  for (const h of hrefs) assert.match(h, /^https?:\/\/[^"'<>\s]+$/, `suspicious href: ${h}`);
  assert.ok(hrefs.includes('https://example.com/page?a=1&b=2'), 'normal links still work');
  assert.ok(hrefs.includes('https://example.com/ok'), 'normal markdown links still work');
});

test('spoilers and reaction buttons work through delegated handlers, with no inline script', { skip }, () => {
  const t = boot();
  const { ws, document, window } = signIn(t);
  ws.receive({ type: 'text', id: 7, channelId: 0, username: 'Al', text: 'a ||secret|| b', html: 'a <span class="spoiler">secret</span> b', timestamp: new Date().toISOString() });
  const spoiler = document.querySelector('.spoiler');
  assert.ok(spoiler);
  assert.equal(spoiler.hasAttribute('onclick'), false);
  spoiler.click();
  assert.ok(spoiler.classList.contains('revealed'));
  spoiler.click();
  assert.ok(!spoiler.classList.contains('revealed'));

  let opened = null;
  document.addEventListener('reaction:open-picker', (e) => { opened = e.detail.messageId; });
  const btn = document.querySelector('.reaction-add-btn');
  assert.equal(btn.hasAttribute('onclick'), false);
  btn.click();
  assert.equal(opened, '7');
});

test('the rendered page contains no inline event handlers anywhere in the shipped HTML or client code', { skip }, () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'index.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script> blocks');
  for (const f of ['js/chat.js', 'js/rich-text-renderer.js']) {
    const code = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.doesNotMatch(code, /\bon(click|error|load|mouse\w*|focus|change)\s*=\s*["'`\\]/i, f);
  }
});
