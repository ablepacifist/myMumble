/**
 * Game Servers feature — offline tests against a fake gtw-games manager.
 * Run: node --test tests/test-game-servers.js   (or npm run test:games)
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.MASTER_ENV_FILE = '';
process.env.GAMES_MANAGER_TOKEN = 'tok';

const calls = [];
let snapshot = {
  servers: [
    { id: 'mc-java', name: 'Minecraft Java', type: 'minecraft-java', state: 'active', since: 1, players: ['steve'],
      player_count: 1, max_players: 10, main_pid: 1234, restarts: 3, can_start: false, public: { start: true, restart_request: true } },
    { id: 'palworld', name: 'Palworld', type: 'palworld', state: 'inactive', players: null, player_count: null,
      main_pid: 0, restarts: 0, can_start: true, public: { start: true, restart_request: true } },
  ],
  restart_requests: [{ id: 'ab12', server: 'mc-java', created: 1, reason: '', requested_by: { id: 9, name: 'bob' }, supporters: [{ id: 9, name: 'bob' }] }],
  mem_available_gb: 19,
  time: 1,
};

const manager = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{"ok":false,"error":"unauthorized"}'); }
    if (req.method === 'GET' && req.url.startsWith('/servers?') || req.url === '/servers') return res.end(JSON.stringify(snapshot));
    if (req.url === '/servers/palworld/start') return res.end('{"ok":true,"message":"Starting Palworld"}');
    if (req.url === '/servers/mc-java/restart-request') return res.end('{"ok":true,"request":{"id":"ab12","supporters":[{},{}]}}');
    if (req.url === '/servers/mc-java/stop') return res.end('{"ok":true,"message":"Stopping"}');
    if (req.url === '/servers/mc-java/start') { res.statusCode = 409; return res.end('{"ok":false,"error":"already running"}'); }
    res.statusCode = 404; res.end('{"ok":false,"error":"not found"}');
  });
});

function fakeWs() {
  return { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
}
const tick = () => new Promise(r => setTimeout(r, 50));
async function settle(ws, n = 1) {
  for (let i = 0; i < 40 && ws.sent.length < n; i++) await tick();
}

let feature;
const clients = new Map();
const player = { authenticated: true, userId: 5, loginName: 'carl', username: 'Carl', isAdmin: false,
  permissions: ['GAMESERVER_START', 'GAMESERVER_REQUEST_RESTART'] };
const admin = { authenticated: true, userId: 1, loginName: 'zx', username: 'zx', isAdmin: true,
  permissions: ['GAMESERVER_ADMIN', 'GAMESERVER_START', 'GAMESERVER_REQUEST_RESTART', 'VOICE_ADMIN'] };
const wsPlayer = fakeWs();
const wsAdmin = fakeWs();

test.before(async () => {
  await new Promise(r => manager.listen(0, '127.0.0.1', r));
  process.env.GAMES_MANAGER_URL = `http://127.0.0.1:${manager.address().port}`;
  feature = require('../src/features/game-servers');
  clients.set(wsPlayer, player);
  clients.set(wsAdmin, admin);
  await feature.init({ getClients: () => clients });
});

test.after(() => { feature.cleanup(); manager.close(); });

test('capabilities follow Lexicon permissions', () => {
  const c = feature.capsFor;
  assert.deepStrictEqual(c(player), { view: true, admin: false, start: true, requestRestart: true });
  assert.strictEqual(c(admin).admin, true);
  assert.deepStrictEqual(c({ authenticated: true, permissions: ['GAMESERVER_REQUEST_RESTART'] }),
    { view: true, admin: false, start: false, requestRestart: true });
  assert.strictEqual(c({ authenticated: false }).view, false);
});

test('before Lexicon knows GAMESERVER_*, only voice admins can act', () => {
  const c = feature.capsFor;
  assert.strictEqual(c({ authenticated: true, isAdmin: true, permissions: ['VOICE_ADMIN'] }).admin, true);
  assert.strictEqual(c({ authenticated: true, isAdmin: false, permissions: [] }).start, false);
  assert.strictEqual(c({ authenticated: true, isAdmin: false, permissions: undefined }).start, false);
});

test('init broadcasts status; players do not see PIDs or restart counts', () => {
  const p = wsPlayer.sent.find(m => m.type === 'games_status');
  const a = wsAdmin.sent.find(m => m.type === 'games_status');
  assert.ok(p && a);
  assert.strictEqual(p.available, true);
  assert.strictEqual(p.servers[0].main_pid, undefined);
  assert.strictEqual(p.servers[0].restarts, undefined);
  assert.strictEqual(p.restart_requests[0].requested_by, undefined);
  assert.strictEqual(a.servers[0].main_pid, 1234);
  assert.strictEqual(a.caps.admin, true);
});

test('player can start a server; manager gets as_admin=false and the actor', async () => {
  wsPlayer.sent = []; calls.length = 0;
  feature.handleMessage(wsPlayer, player, { type: 'games_start', serverId: 'palworld' });
  await settle(wsPlayer);
  const r = wsPlayer.sent.find(m => m.type === 'games_action_result');
  assert.strictEqual(r.ok, true);
  const call = calls.find(c => c.url === '/servers/palworld/start');
  assert.strictEqual(call.body.as_admin, false);
  assert.deepStrictEqual(call.body.actor, { id: 5, name: 'carl' });
  assert.ok(wsAdmin.sent.some(m => m.type === 'games_notice' && /Carl started Palworld/.test(m.text)));
});

test('player cannot stop a server; nothing reaches the manager', async () => {
  wsPlayer.sent = []; calls.length = 0;
  feature.handleMessage(wsPlayer, player, { type: 'games_stop', serverId: 'mc-java' });
  await settle(wsPlayer);
  assert.strictEqual(wsPlayer.sent[0].ok, false);
  assert.match(wsPlayer.sent[0].error, /admin/);
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0);
});

test('player cooldown blocks rapid repeats', async () => {
  wsPlayer.sent = [];
  feature.handleMessage(wsPlayer, player, { type: 'games_request_restart', serverId: 'mc-java' });
  await settle(wsPlayer);
  assert.match(wsPlayer.sent[0].error, /wait/);
});

test('admin can stop; manager gets as_admin=true', async () => {
  wsAdmin.sent = []; calls.length = 0;
  feature.handleMessage(wsAdmin, admin, { type: 'games_stop', serverId: 'mc-java' });
  await settle(wsAdmin);
  assert.strictEqual(wsAdmin.sent.find(m => m.type === 'games_action_result').ok, true);
  assert.strictEqual(calls.find(c => c.url === '/servers/mc-java/stop').body.as_admin, true);
});

test('manager errors are passed back', async () => {
  wsAdmin.sent = [];
  feature.handleMessage(wsAdmin, admin, { type: 'games_start', serverId: 'mc-java' });
  await settle(wsAdmin);
  const r = wsAdmin.sent.find(m => m.type === 'games_action_result');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'already running');
});

test('bad server ids are refused before the manager is called', async () => {
  wsAdmin.sent = []; calls.length = 0;
  feature.handleMessage(wsAdmin, admin, { type: 'games_stop', serverId: '../etc' });
  await settle(wsAdmin);
  assert.strictEqual(wsAdmin.sent[0].ok, false);
  assert.strictEqual(calls.length, 0);
});

test('unauthenticated clients get an error', () => {
  const ws = fakeWs();
  feature.handleMessage(ws, { authenticated: false }, { type: 'games_list' });
  assert.strictEqual(ws.sent[0].type, 'error');
});

test('manager down shows as unavailable', async () => {
  const url = require('../src/config').games.managerUrl;
  require('../src/config').games.managerUrl = 'http://127.0.0.1:1';
  wsPlayer.sent = [];
  await feature.poll();
  const s = wsPlayer.sent.find(m => m.type === 'games_status');
  assert.strictEqual(s.available, false);
  assert.ok(s.error);
  require('../src/config').games.managerUrl = url;
});
