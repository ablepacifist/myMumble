#!/usr/bin/env node
/**
 * Test: per-channel access control, end-to-end against a live bridge.
 *
 * Tests:
 *  1. Admin can create + restrict a channel with no grants
 *  2. A non-admin never sees the restricted channel in server_state/channel_update,
 *     and join_channel/text/get_history on it are all rejected
 *  3. Granting access updates the already-connected non-admin socket live
 *     (no reconnect) and the three actions then succeed
 *  4. Revoking access removes it live and the three actions are rejected again
 *  5. Removing the channel cleans up its restriction/grant rows
 *
 * Requires SUPERUSER_NAMES to include the ADMIN_USERNAME below (defaults to
 * the same "alex" used elsewhere in this repo's config/tests).
 *
 * Usage:
 *   node tests/test-channel-access-live.js [host] [port]
 *
 * Defaults to localhost:3080. Safe to run against the live/production
 * instance — additive only, creates and deletes its own scratch channel.
 */
const WebSocket = require('ws');
const path = require('path');

const HOST = process.argv[2] || 'localhost';
const PORT = process.argv[3] || 3080;
const URL = `ws://${HOST}:${PORT}`;
const ADMIN_USERNAME = 'alex';

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${name}`);
  } else {
    failed++;
    results.push(`  ❌ ${name}`);
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    const messages = [];
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch (_) {}
    });
    ws.on('open', () => { clearTimeout(timeout); resolve({ ws, messages }); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function auth(conn, username) {
  conn.messages.length = 0;
  conn.ws.send(JSON.stringify({ type: 'auth', username }));
  return wait(2500).then(() => conn.messages.find((m) => m.type === 'auth_ok'));
}

function send(conn, msg) {
  conn.ws.send(JSON.stringify(msg));
}

async function runTests() {
  console.log(`\n🧪 Channel Access Live Tests — ${URL}\n`);

  let admin, user;
  try {
    admin = await connect();
    user = await connect();
    assert(true, 'Admin + non-admin sockets connect');
  } catch (err) {
    assert(false, `Admin + non-admin sockets connect (${err.message})`);
    printResults();
    return;
  }

  const adminAuthOk = await auth(admin, ADMIN_USERNAME);
  assert(!!adminAuthOk?.isAdmin, `Admin auth_ok has isAdmin=true (is "${ADMIN_USERNAME}" in SUPERUSER_NAMES?)`);

  const testUsername = 'test_user_' + Date.now();
  const userAuthOk = await auth(user, testUsername);
  assert(!!userAuthOk && userAuthOk.isAdmin === false, 'Non-admin auth_ok has isAdmin=false');
  const userId = userAuthOk?.userId;

  // ── Step 1: admin creates a throwaway channel ──
  admin.messages.length = 0;
  send(admin, { type: 'create_channel', name: 'access-test-temp-' + Date.now(), parentId: 0 });
  await wait(1000);
  const created = admin.messages.find((m) => m.type === 'channel_created');
  assert(!!created, 'Admin can create a throwaway channel');
  const channelId = created?.channel?.id;

  // ── Step 2: admin restricts it with no grants ──
  admin.messages.length = 0;
  send(admin, { type: 'set_channel_access', channelId, restricted: true, userIds: [] });
  await wait(500);
  const restrictResult = admin.messages.find((m) => m.type === 'channel_access_result');
  assert(!!restrictResult && restrictResult.success, 'Admin can restrict the channel with no grants');

  // ── Step 3: non-admin never sees it ──
  user.messages.length = 0;
  send(user, { type: 'join_channel', channelId });
  send(user, { type: 'text', channelId, text: 'should not be delivered' });
  send(user, { type: 'get_history', channelId, limit: 5 });
  await wait(500);
  const sawChannel = user.messages.some((m) =>
    (m.type === 'channel_update' && m.channel?.id === channelId) ||
    (m.type === 'server_state' && m.channels?.some((c) => c.id === channelId))
  );
  assert(!sawChannel, 'Non-admin never receives the restricted channel');
  const errors = user.messages.filter((m) => m.type === 'error');
  assert(errors.length === 3, `join_channel/text/get_history all rejected (got ${errors.length}/3 errors)`);
  const historyOk = user.messages.find((m) => m.type === 'history');
  assert(!historyOk, 'get_history does not leak history for a restricted channel');

  // ── Step 4: admin grants access — already-connected socket updates live ──
  user.messages.length = 0;
  admin.messages.length = 0;
  send(admin, { type: 'set_channel_access', channelId, restricted: true, userIds: [userId] });
  await wait(500);
  const grantResult = admin.messages.find((m) => m.type === 'channel_access_result');
  assert(!!grantResult && grantResult.success, 'Admin can grant the non-admin access');
  const gotUpdate = user.messages.find((m) => m.type === 'channel_update' && m.channel?.id === channelId);
  assert(!!gotUpdate, 'Non-admin receives channel_update live after being granted (no reconnect)');

  user.messages.length = 0;
  send(user, { type: 'join_channel', channelId });
  await wait(300);
  const joined = user.messages.find((m) => m.type === 'joined_channel' && m.channelId === channelId);
  assert(!!joined, 'Non-admin can now join_channel after being granted');

  user.messages.length = 0;
  send(user, { type: 'get_history', channelId, limit: 5 });
  await wait(500);
  const historyAfterGrant = user.messages.find((m) => m.type === 'history');
  assert(!!historyAfterGrant, 'Non-admin can now get_history after being granted');

  // ── Step 5: admin revokes — live removal, actions rejected again ──
  user.messages.length = 0;
  admin.messages.length = 0;
  send(admin, { type: 'set_channel_access', channelId, restricted: true, userIds: [] });
  await wait(500);
  const revokeResult = admin.messages.find((m) => m.type === 'channel_access_result');
  assert(!!revokeResult && revokeResult.success, 'Admin can revoke access');
  const gotRemove = user.messages.find((m) => m.type === 'channel_remove' && m.channelId === channelId);
  assert(!!gotRemove, 'Non-admin receives channel_remove live after being revoked');

  user.messages.length = 0;
  send(user, { type: 'get_history', channelId, limit: 5 });
  await wait(500);
  const rejectedAfterRevoke = user.messages.find((m) => m.type === 'error');
  assert(!!rejectedAfterRevoke, 'get_history is rejected again immediately after revocation');

  // ── Step 6: cleanup — remove the channel, confirm access rows are purged ──
  admin.messages.length = 0;
  send(admin, { type: 'remove_channel', channelId });
  await wait(500);
  const removed = admin.messages.some((m) => m.type === 'channel_remove' && m.channelId === channelId);
  assert(removed, 'Admin can remove the throwaway channel');

  try {
    const { getBridgePool } = require(path.join(__dirname, '..', 'src', 'database.js'));
    const pool = getBridgePool();
    const [restrictedRows] = await pool.execute('SELECT 1 FROM restricted_channels WHERE channel_id = ?', [channelId]);
    const [grantRows] = await pool.execute('SELECT 1 FROM channel_access_grants WHERE channel_id = ?', [channelId]);
    assert(restrictedRows.length === 0 && grantRows.length === 0, 'Restriction/grant rows are cleaned up on delete');
    await pool.end();
  } catch (err) {
    assert(false, `Restriction/grant rows are cleaned up on delete (${err.message})`);
  }

  admin.ws.close();
  user.ws.close();
  await wait(300);
  printResults();
}

function printResults() {
  console.log(results.join('\n'));
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
