/**
 * Game Servers panel (🎮 in the channel header).
 *
 * Talks to the bridge's game-servers feature over the chat WebSocket: chat.js forwards every
 * games_* message as a 'bridge:message' event and exposes window.bridgeSend. Which buttons show
 * comes from `caps` in games_status; the bridge and the manager check every action again.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const btn = $('#games-btn');
  const panel = $('#games-panel');
  if (!btn || !panel) return;

  const list = $('#games-list');
  const reqBox = $('#games-requests');
  const memEl = $('#games-mem');
  const consoleBox = $('#games-console');
  const consoleTitle = $('#games-console-title');
  const consoleOut = $('#games-console-out');
  const consoleForm = $('#games-console-form');
  const consoleInput = $('#games-console-input');

  let status = null;
  let consoleServer = null;

  const send = (obj) => window.bridgeSend && window.bridgeSend(obj);

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function ago(sec) {
    if (!sec) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  }

  const STATE_LABEL = {
    active: 'Online', activating: 'Starting', deactivating: 'Stopping',
    inactive: 'Offline', failed: 'Crashed', reloading: 'Reloading',
  };

  function toast(text, bad) {
    const t = el('div', { class: 'games-toast' + (bad ? ' bad' : '') }, text);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 5000);
  }

  function action(type, serverId, extra) {
    send(Object.assign({ type, serverId }, extra || {}));
  }

  function confirmThen(text, fn) {
    if (window.confirm(text)) fn();
  }

  function renderRequests() {
    const reqs = (status && status.restart_requests) || [];
    reqBox.replaceChildren();
    reqBox.classList.toggle('hidden', reqs.length === 0);
    const names = Object.fromEntries((status.servers || []).map(s => [s.id, s.name]));
    for (const r of reqs) {
      const who = (r.supporters || []).map(a => a.name).filter(Boolean).join(', ');
      const row = el('div', { class: 'games-request' },
        el('span', {}, `🔁 ${names[r.server] || r.server}: restart asked by ${who || 'someone'}`,
          r.reason ? ` (${r.reason})` : '', ` · ${ago(r.created)} ago`));
      if (status.caps && status.caps.admin) {
        row.appendChild(el('span', { class: 'games-request-actions' },
          el('button', { class: 'btn btn-small btn-primary', onclick: () => send({ type: 'games_approve_request', requestId: r.id }) }, 'Restart now'),
          el('button', { class: 'btn btn-small btn-secondary', onclick: () => send({ type: 'games_deny_request', requestId: r.id }) }, 'Deny')));
      } else {
        row.appendChild(el('span', { class: 'games-hint' }, 'Runs once the server is empty'));
      }
      reqBox.appendChild(row);
    }
  }

  function card(s, caps) {
    const online = s.state === 'active';
    const players = s.player_count === null || s.player_count === undefined
      ? (online ? 'players: ?' : '')
      : `${s.player_count}/${s.max_players || '?'} players` + (s.players && s.players.length ? `: ${s.players.join(', ')}` : '');

    const buttons = [];
    if (caps.start && !online && s.state !== 'activating') {
      const allowed = s.can_start && (caps.admin || (s.public && s.public.start));
      buttons.push(el('button', {
        class: 'btn btn-small btn-primary', disabled: !allowed,
        title: allowed ? 'Start this server' : (s.start_blocked_reason || 'Only an admin can start this server'),
        onclick: () => action('games_start', s.id),
      }, 'Start'));
    }
    if (online && caps.requestRestart && !caps.admin && s.public && s.public.restart_request) {
      buttons.push(el('button', {
        class: 'btn btn-small btn-secondary',
        title: 'Ask for a restart. It runs once nobody is playing, or when an admin approves.',
        onclick: () => {
          const reason = window.prompt(`Ask to restart ${s.name}? Optional reason:`, '');
          if (reason !== null) action('games_request_restart', s.id, { reason });
        },
      }, 'Request restart'));
    }
    if (caps.admin) {
      if (online) {
        buttons.push(el('button', { class: 'btn btn-small btn-secondary', onclick: () => confirmThen(`Restart ${s.name} now? Players will be disconnected.`, () => action('games_restart', s.id)) }, 'Restart'));
        buttons.push(el('button', { class: 'btn btn-small btn-danger', onclick: () => confirmThen(`Stop ${s.name}?`, () => action('games_stop', s.id)) }, 'Stop'));
      }
      buttons.push(el('button', { class: 'btn btn-small btn-secondary', onclick: () => openConsole(s) }, online ? 'Console' : 'Logs'));
    }

    return el('div', { class: `games-card state-${s.state}` },
      el('div', { class: 'games-card-head' },
        el('span', { class: 'games-dot' }),
        el('span', { class: 'games-name' }, s.name),
        el('span', { class: 'games-state' }, (STATE_LABEL[s.state] || s.state) + (online && s.since ? ` · ${ago(s.since)}` : ''))),
      players ? el('div', { class: 'games-players' }, players) : null,
      s.join_address ? el('div', { class: 'games-join' }, 'Join: ',
        el('code', { title: 'Click to copy', onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(s.join_address); toast('Address copied'); e.stopPropagation(); } }, s.join_address)) : null,
      caps.admin && s.restarts ? el('div', { class: 'games-hint' }, `systemd restarts: ${s.restarts}`) : null,
      buttons.length ? el('div', { class: 'games-actions' }, buttons) : null);
  }

  function render() {
    if (!status) return;
    const caps = status.caps || {};
    memEl.textContent = status.mem_available_gb !== undefined ? `${status.mem_available_gb} GB free` : '';
    list.replaceChildren();
    if (!status.available) {
      list.appendChild(el('div', { class: 'notif-empty' }, status.error || 'Game servers are not available'));
      reqBox.classList.add('hidden');
      return;
    }
    renderRequests();
    const servers = (status.servers || []).slice().sort((a, b) =>
      (b.state === 'active') - (a.state === 'active') || a.name.localeCompare(b.name));
    for (const s of servers) list.appendChild(card(s, caps));
  }

  function openConsole(s) {
    consoleServer = s.id;
    consoleTitle.textContent = `${s.name}: log`;
    consoleOut.textContent = 'Loading…';
    consoleBox.classList.remove('hidden');
    consoleForm.classList.toggle('hidden', s.state !== 'active');
    send({ type: 'games_logs', serverId: s.id, lines: 200 });
  }

  $('#games-console-close').addEventListener('click', (e) => {
    e.stopPropagation();
    consoleBox.classList.add('hidden');
    consoleServer = null;
  });

  consoleForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const command = consoleInput.value.trim();
    if (!command || !consoleServer) return;
    consoleOut.textContent += `\n> ${command}\n`;
    send({ type: 'games_command', serverId: consoleServer, command });
    consoleInput.value = '';
  });

  document.addEventListener('bridge:message', (ev) => {
    const msg = ev.detail;
    switch (msg.type) {
      case 'games_status':
        status = msg;
        btn.classList.toggle('games-any-online', (msg.servers || []).some(s => s.state === 'active'));
        if (!panel.classList.contains('hidden')) render();
        break;
      case 'games_action_result':
        toast(msg.ok ? msg.message : msg.error, !msg.ok);
        break;
      case 'games_notice':
        toast(msg.text);
        break;
      case 'games_logs':
        if (msg.serverId === consoleServer) {
          consoleOut.textContent = (msg.lines || []).join('\n');
          consoleOut.scrollTop = consoleOut.scrollHeight;
        }
        break;
      case 'games_command_result':
        if (msg.serverId === consoleServer) {
          consoleOut.textContent += (msg.ok ? (msg.output || '(sent)') : `error: ${msg.error}`) + '\n';
          consoleOut.scrollTop = consoleOut.scrollHeight;
        }
        break;
    }
  });

  document.addEventListener('bridge:auth', () => send({ type: 'games_list' }));

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = panel.classList.contains('hidden');
    document.querySelectorAll('.notif-panel').forEach(p => { if (p !== panel) p.classList.add('hidden'); });
    panel.classList.toggle('hidden');
    if (opening) { render(); send({ type: 'games_list' }); }
  });

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== btn) {
      panel.classList.add('hidden');
    }
  });
})();
