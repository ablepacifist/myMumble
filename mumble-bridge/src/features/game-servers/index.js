/**
 * Game Servers feature — status and control of the game servers on GTW, through the
 * gtw-games manager (local HTTP API, 127.0.0.1:8790, bearer token).
 *
 * Who may do what is decided by Lexicon permissions (client.permissions, set at sign-in):
 *   signed in                    see servers, state, players            games_list
 *   GAMESERVER_START             start a stopped server                 games_start
 *   GAMESERVER_REQUEST_RESTART   ask for a restart (runs once the       games_request_restart
 *                                server is empty, or an admin approves)
 *   GAMESERVER_ADMIN             stop, restart now, logs, console,      games_stop, games_restart, games_logs,
 *                                approve/deny requests                  games_command, games_approve_request,
 *                                                                       games_deny_request
 * While Lexicon does not know the GAMESERVER_* permissions yet (no such name in the player's list), only
 * voice-chat admins (client.isAdmin) can act, and they act as game admins.
 *
 * The manager is told `as_admin` for every call and refuses admin-only actions without it, and refuses
 * starts / restart requests for servers its definition keeps admin-only, so a bridge bug cannot widen access.
 *
 * Server → client:
 *   games_status          { available, servers[], restart_requests[], mem_available_gb, caps, error? }
 *   games_action_result   { action, serverId?, ok, message?, error? }
 *   games_logs            { serverId, lines[] }
 *   games_command_result  { serverId, ok, output?, error? }
 *   games_notice          { text }   (for example "bob asked to restart Palworld")
 */
const config = require('../../config');

const PERM = {
  admin: 'GAMESERVER_ADMIN',
  start: 'GAMESERVER_START',
  request: 'GAMESERVER_REQUEST_RESTART',
};
const COOLDOWN_MS = 10_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const RID_RE = /^[a-f0-9]{1,32}$/;

function capsFor(client) {
  if (!client || !client.authenticated) return { view: false, start: false, requestRestart: false, admin: false };
  const perms = Array.isArray(client.permissions) ? client.permissions : null;
  const lexiconKnowsGames = !!perms && perms.some(p => typeof p === 'string' && p.startsWith('GAMESERVER_'));
  if (!lexiconKnowsGames) {
    const admin = !!client.isAdmin;
    return { view: true, start: admin, requestRestart: admin, admin };
  }
  const admin = perms.includes(PERM.admin);
  return {
    view: true,
    admin,
    start: admin || perms.includes(PERM.start),
    requestRestart: admin || perms.includes(PERM.request),
  };
}

/** What a non-admin sees of one server: no PIDs, restart counters or internal errors. */
function publicServer(s) {
  return {
    id: s.id, name: s.name, type: s.type, join_address: s.join_address,
    state: s.state, since: s.since, players: s.players, player_count: s.player_count,
    max_players: s.max_players, version: s.version, can_start: s.can_start,
    start_blocked_reason: s.start_blocked_reason, public: s.public,
  };
}

function publicRequest(r) {
  return {
    id: r.id, server: r.server, created: r.created, reason: r.reason,
    supporters: (r.supporters || []).map(a => ({ name: a && a.name })),
  };
}

class GameServersFeature {
  constructor() {
    this.name = 'game-servers';
    this.messageTypes = [
      'games_list', 'games_start', 'games_stop', 'games_restart', 'games_request_restart',
      'games_approve_request', 'games_deny_request', 'games_logs', 'games_command',
    ];
    this.deps = null;
    this.snapshot = null;      // last manager answer
    this.lastJson = '';
    this.error = null;
    this.timer = null;
    this.lastAction = new Map(); // userKey -> time, simple per-player cooldown
    this.fetch = (...a) => fetch(...a); // replaced in tests
  }

  get enabled() {
    return !!config.games.managerUrl;
  }

  async init(deps) {
    this.deps = deps;
    if (!this.enabled) {
      console.log('[Games] GAMES_MANAGER_URL not set; Servers panel off');
      return;
    }
    await this.poll();
    this.timer = setInterval(() => this.poll().catch(() => {}), config.games.pollSeconds * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  cleanup() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async call(method, path, body) {
    const res = await this.fetch(config.games.managerUrl.replace(/\/$/, '') + path, {
      method,
      headers: { Authorization: `Bearer ${config.games.managerToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 8000 : 30000),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `manager answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async poll(fresh = false) {
    try {
      this.snapshot = await this.call('GET', fresh ? '/servers?fresh=1' : '/servers');
      this.error = null;
    } catch (err) {
      if (!this.error) console.warn('[Games] manager unreachable:', err.message);
      this.error = 'The game server manager is not answering';
    }
    const { time, ...rest } = this.snapshot || {};
    const json = JSON.stringify([rest, this.error]);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.broadcastStatus();
    }
  }

  statusFor(client) {
    const caps = capsFor(client);
    const snap = this.snapshot;
    const base = { type: 'games_status', caps, available: !!snap && !this.error, error: this.error || undefined };
    if (!snap) return { ...base, servers: [], restart_requests: [] };
    if (caps.admin) return { ...base, ...snap, time: undefined };
    return {
      ...base,
      servers: (snap.servers || []).map(publicServer),
      restart_requests: (snap.restart_requests || []).map(publicRequest),
    };
  }

  forEachClient(fn) {
    const clients = this.deps && this.deps.getClients ? this.deps.getClients() : null;
    if (!clients) return;
    for (const [ws, client] of clients) {
      if (client && client.authenticated && ws.readyState === 1) fn(ws, client);
    }
  }

  broadcastStatus() {
    this.forEachClient((ws, client) => ws.send(JSON.stringify(this.statusFor(client))));
  }

  notice(text, onlyAdmins = false) {
    this.forEachClient((ws, client) => {
      if (!onlyAdmins || capsFor(client).admin) ws.send(JSON.stringify({ type: 'games_notice', text }));
    });
  }

  actor(client) {
    return { id: client.userId ?? null, name: client.loginName || client.username };
  }

  serverName(id) {
    const s = (this.snapshot?.servers || []).find(x => x.id === id);
    return s ? s.name : id;
  }

  reply(ws, action, serverId, ok, text) {
    ws.send(JSON.stringify({ type: 'games_action_result', action, serverId, ok, [ok ? 'message' : 'error']: text }));
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }
    this._handle(ws, client, msg).catch(err => {
      this.reply(ws, msg.type, msg.serverId, false, err.message || 'Failed');
    });
  }

  async _handle(ws, client, msg) {
    const caps = capsFor(client);
    const action = msg.type;
    if (action === 'games_list') {
      if (!this.enabled) {
        ws.send(JSON.stringify({ type: 'games_status', caps, available: false, error: 'Game servers are not set up on this bridge', servers: [], restart_requests: [] }));
        return;
      }
      ws.send(JSON.stringify(this.statusFor(client)));
      return;
    }
    if (!this.enabled) return this.reply(ws, action, msg.serverId, false, 'Game servers are not set up on this bridge');

    const needs = {
      games_start: 'start', games_request_restart: 'requestRestart',
      games_stop: 'admin', games_restart: 'admin', games_logs: 'admin', games_command: 'admin',
      games_approve_request: 'admin', games_deny_request: 'admin',
    }[action];
    if (!caps[needs]) {
      return this.reply(ws, action, msg.serverId, false,
        needs === 'admin' ? 'Only an admin can do that' : 'You are not allowed to do that');
    }

    const isRequestAction = action === 'games_approve_request' || action === 'games_deny_request';
    if (isRequestAction ? !RID_RE.test(String(msg.requestId || '')) : !ID_RE.test(String(msg.serverId || ''))) {
      return this.reply(ws, action, msg.serverId, false, 'Bad server or request id');
    }

    if (!caps.admin && (action === 'games_start' || action === 'games_request_restart')) {
      const key = String(client.userId ?? client.loginName);
      const last = this.lastAction.get(key) || 0;
      if (Date.now() - last < COOLDOWN_MS) return this.reply(ws, action, msg.serverId, false, 'Please wait a few seconds');
      this.lastAction.set(key, Date.now());
    }

    const body = { actor: this.actor(client), as_admin: caps.admin };
    const sid = msg.serverId;
    const who = client.username || client.loginName;
    switch (action) {
      case 'games_start': {
        const r = await this.call('POST', `/servers/${sid}/start`, body);
        this.reply(ws, action, sid, true, r.message);
        this.notice(`${who} started ${this.serverName(sid)}`);
        break;
      }
      case 'games_stop':
      case 'games_restart': {
        const verb = action === 'games_stop' ? 'stop' : 'restart';
        const r = await this.call('POST', `/servers/${sid}/${verb}`, body);
        this.reply(ws, action, sid, true, r.message);
        this.notice(`${who} ${verb === 'stop' ? 'stopped' : 'restarted'} ${this.serverName(sid)}`);
        break;
      }
      case 'games_request_restart': {
        const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '';
        const r = await this.call('POST', `/servers/${sid}/restart-request`, { ...body, reason });
        const n = r.request?.supporters?.length || 1;
        this.reply(ws, action, sid, true, 'Restart requested. It runs once the server has been empty for a few minutes, or when an admin approves.');
        this.notice(`${who} asked to restart ${this.serverName(sid)}${n > 1 ? ` (${n} players asked)` : ''}${reason ? `: ${reason}` : ''}`);
        break;
      }
      case 'games_approve_request':
      case 'games_deny_request': {
        const verb = action === 'games_approve_request' ? 'approve' : 'deny';
        const r = await this.call('POST', `/restart-requests/${msg.requestId}/${verb}`, body);
        this.reply(ws, action, r.request?.server, true, verb === 'approve' ? 'Approved; restarting' : 'Request denied');
        if (verb === 'approve') this.notice(`${who} approved the restart of ${this.serverName(r.request?.server)}`);
        break;
      }
      case 'games_logs': {
        const lines = Math.max(10, Math.min(parseInt(msg.lines) || 200, 1000));
        const r = await this.call('GET', `/servers/${sid}/logs?lines=${lines}`);
        ws.send(JSON.stringify({ type: 'games_logs', serverId: sid, lines: r.lines || [] }));
        return;
      }
      case 'games_command': {
        const command = typeof msg.command === 'string' ? msg.command.trim().slice(0, 500) : '';
        if (!command) return this.reply(ws, action, sid, false, 'Empty command');
        try {
          const r = await this.call('POST', `/servers/${sid}/command`, { ...body, command });
          ws.send(JSON.stringify({ type: 'games_command_result', serverId: sid, ok: true, output: r.output || '' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'games_command_result', serverId: sid, ok: false, error: err.message }));
        }
        return;
      }
    }
    await this.poll(true);
  }
}

const feature = new GameServersFeature();
feature.capsFor = capsFor;
module.exports = feature;
