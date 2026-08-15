#!/usr/bin/env node
/**
 * Test: reply threads, pinned messages, search, and jump-to-message,
 * end-to-end against a live bridge.
 *
 * Tests:
 *  1. Reply: replyToMessageId round-trips through the live broadcast and get_history
 *  2. Pin: admin-only (non-admin rejected), viewing pins works for anyone,
 *     isPinned round-trips through get_history, unpin removes it live
 *  3. Search: finds a known message, filtered by channel-access
 *  4. Jump: jump_to_message finds a known message and returns it
 *  5. Cleanup: removing the channel purges its pinned_messages rows
 *
 * Requires SUPERUSER_NAMES to include the ADMIN_USERNAME below.
 *
 * Usage:
 *   node tests/test-message-features-live.js [host] [port]
 *
 * Safe to run against the live/production instance — creates and deletes
 * its own scratch channel, same pattern as test-channel-access-live.js.
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
  console.log(`\n🧪 Message Features Live Tests — ${URL}\n`);

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

  const userAuthOk = await auth(user, 'test_user_' + Date.now());
  assert(!!userAuthOk && userAuthOk.isAdmin === false, 'Non-admin auth_ok has isAdmin=false');

  // ── Setup: admin creates a throwaway channel ──
  admin.messages.length = 0;
  send(admin, { type: 'create_channel', name: 'msg-test-temp-' + Date.now(), parentId: 0 });
  await wait(1000);
  const created = admin.messages.find((m) => m.type === 'channel_created');
  assert(!!created, 'Admin can create a throwaway channel');
  const channelId = created?.channel?.id;

  // ── Reply threads ──
  const uniqueToken = 'probe' + Date.now();
  admin.messages.length = 0;
  send(admin, { type: 'text', channelId, text: `original message ${uniqueToken}` });
  await wait(800);
  const original = admin.messages.find((m) => m.type === 'text');
  assert(!!original?.id, 'Original message stores and broadcasts with a real id');
  const originalId = original?.id;

  admin.messages.length = 0;
  send(admin, { type: 'text', channelId, text: 'a reply', replyToMessageId: originalId });
  await wait(800);
  const replyBroadcast = admin.messages.find((m) => m.type === 'text' && m.text === 'a reply');
  assert(String(replyBroadcast?.replyToId) === String(originalId), 'Reply broadcast carries replyToId');

  admin.messages.length = 0;
  send(admin, { type: 'get_history', channelId, limit: 10 });
  await wait(800);
  const history1 = admin.messages.find((m) => m.type === 'history');
  const replyInHistory = history1?.messages?.find((m) => m.content === 'a reply' || m.text === 'a reply');
  assert(String(replyInHistory?.replyToId) === String(originalId), 'replyToId survives a fresh get_history (Lexicon-native)');

  // ── Pinned messages ──
  admin.messages.length = 0;
  send(admin, { type: 'pin_message', channelId, messageId: originalId, username: 'alex', content: 'original', messageType: 'TEXT' });
  await wait(500);
  const pinResult = admin.messages.find((m) => m.type === 'pin_result');
  assert(!!pinResult?.success, 'Admin can pin a message');
  const pinAdded = admin.messages.find((m) => m.type === 'pin_added');
  assert(!!pinAdded, 'pin_added is broadcast');

  user.messages.length = 0;
  send(user, { type: 'pin_message', channelId, messageId: originalId, username: 'user', content: 'x', messageType: 'TEXT' });
  await wait(500);
  const nonAdminPinRejected = user.messages.find((m) => m.type === 'error');
  assert(!!nonAdminPinRejected, 'Non-admin cannot pin a message');

  user.messages.length = 0;
  send(user, { type: 'get_pinned_messages', channelId });
  await wait(500);
  const pinsForUser = user.messages.find((m) => m.type === 'pinned_messages');
  assert(!!pinsForUser && pinsForUser.pins.some((p) => String(p.messageId) === String(originalId)), 'Non-admin can still view pinned messages');

  admin.messages.length = 0;
  send(admin, { type: 'get_history', channelId, limit: 10 });
  await wait(800);
  const history2 = admin.messages.find((m) => m.type === 'history');
  const pinnedInHistory = history2?.messages?.find((m) => String(m.id) === String(originalId));
  assert(pinnedInHistory?.isPinned === true, 'isPinned round-trips through get_history');

  admin.messages.length = 0;
  send(admin, { type: 'unpin_message', channelId, messageId: originalId });
  await wait(500);
  const unpinResult = admin.messages.find((m) => m.type === 'pin_result');
  const pinRemoved = admin.messages.find((m) => m.type === 'pin_removed');
  assert(!!unpinResult?.success && !!pinRemoved, 'Admin can unpin, pin_removed is broadcast');

  // ── Search ──
  admin.messages.length = 0;
  send(admin, { type: 'search_messages', query: uniqueToken });
  await wait(1000);
  const searchResults = admin.messages.find((m) => m.type === 'search_results');
  assert(!!searchResults?.results?.some((r) => String(r.id) === String(originalId)), 'Search finds the known message by unique token');

  // ── Jump to message ──
  admin.messages.length = 0;
  send(admin, { type: 'jump_to_message', channelId, messageId: originalId });
  await wait(1000);
  const jumpResult = admin.messages.find((m) => m.type === 'jump_to_message_result');
  assert(!!jumpResult?.found && jumpResult.messages.some((m) => String(m.id) === String(originalId)), 'jump_to_message finds the known message');

  // ── Cleanup ──
  admin.messages.length = 0;
  send(admin, { type: 'remove_channel', channelId });
  await wait(500);
  const removed = admin.messages.some((m) => m.type === 'channel_remove' && m.channelId === channelId);
  assert(removed, 'Admin can remove the throwaway channel');

  try {
    const { getBridgePool } = require(path.join(__dirname, '..', 'src', 'database.js'));
    const pool = getBridgePool();
    const [pinRows] = await pool.execute('SELECT 1 FROM pinned_messages WHERE channel_id = ?', [channelId]);
    assert(pinRows.length === 0, 'Pinned-message rows are cleaned up on channel delete');
    await pool.end();
  } catch (err) {
    assert(false, `Pinned-message rows are cleaned up on channel delete (${err.message})`);
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
