'use strict';
/**
 * Relayed messages (native Mumble and Discord) and replies across the Discord link.
 * Offline: Lexicon, MySQL, Mumble and Discord are all in-memory stand-ins. Nothing is
 * ever posted to a real Discord channel; the webhook below only records what it was given.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stub, load, fakeDatabase } = require('./helpers');

stub('database', fakeDatabase());

let nextId = 100;
const stored = [];
const lexiconMessages = {
  10: { id: 10, channelId: 3, username: 'alex', content: 'dinner at 8?', messageType: 'TEXT' },
  11: { id: 11, channelId: 9, username: 'alex', content: 'other channel', messageType: 'TEXT' },
};
const lexiconFake = {
  async storeMessage(m) { stored.push(m); const id = nextId++; lexiconMessages[id] = { id, ...m }; return { messageId: id }; },
  async getMessage(id) { return lexiconMessages[String(id)] || null; },
  async sendNotification() { return true; },
  async createNotification() { return true; },
};
stub('lexicon-client', lexiconFake);

const replies = load('reply-preview');
const { setupMumbleListeners } = load('mumble-relay');
const discord = load('features/discord-sync');

test.beforeEach(() => { stored.length = 0; });

// ── reply previews ────────────────────────────────────────

test('preview text is plain, short and marks deleted originals', () => {
  assert.equal(replies.previewText({ content: '<i>hi</i>\n\n there' }), 'hi there');
  assert.equal(replies.previewText({ content: '', messageType: 'IMAGE' }), '[image]');
  assert.equal(replies.previewText({ content: 'x', deletedAt: '2026-01-01' }), 'Original message was deleted');
  assert.equal(replies.previewOf({ id: 1, channelId: 2, username: 'a', content: 'b' }, 3), null, 'other channel');
});

// ── native Mumble relay ───────────────────────────────────

test('a native Mumble message is stored first and broadcast with its Lexicon id', async () => {
  const mumble = new EventEmitter();
  const state = { channels: new Map([[3, { id: 3, name: 'General' }]]), users: new Map([[7, { name: 'dave' }]]), ownSession: 1 };
  const broadcasts = [];
  setupMumbleListeners(mumble, state, () => {}, (ch, m) => broadcasts.push({ ch, m }), () => {}, () => {});

  mumble.emit('TextMessage', { actor: 7, channelId: [3], message: '<p>hello</p>' });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(stored.length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].m.id, nextId - 1, 'same id the history copy will have, so clients do not show it twice');
  assert.equal(broadcasts[0].m.text, 'hello');
});

test('the bridge never relays its own Mumble echo', async () => {
  const mumble = new EventEmitter();
  const broadcasts = [];
  const state = { channels: new Map(), users: new Map([[1, { name: 'bridge' }]]), ownSession: 1 };
  setupMumbleListeners(mumble, state, () => {}, (ch, m) => broadcasts.push(m), () => {}, () => {});
  mumble.emit('TextMessage', { actor: 1, channelId: [3], message: 'echo' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(broadcasts.length + stored.length, 0);
});

// ── Discord ───────────────────────────────────────────────

function discordHarness() {
  const pairs = []; // { lexicon, discord }
  const db = {
    async execute(sql, params = []) {
      if (/^\s*SELECT lexicon_message_id/.test(sql)) return [pairs.filter((p) => p.discord === params[0]).map((p) => ({ lexicon_message_id: p.lexicon })), []];
      if (/^\s*SELECT discord_message_id/.test(sql)) return [pairs.filter((p) => p.lexicon === params[0]).map((p) => ({ discord_message_id: p.discord })), []];
      if (/^\s*INSERT IGNORE INTO discord_message_links/.test(sql)) { pairs.push({ lexicon: params[0], discord: params[1] }); return [{}, []]; }
      return [[], []];
    },
  };
  const broadcasts = [];
  const mumbleOut = [];
  discord.deps = {
    db,
    lexicon: lexiconFake,
    channels: new Map([[3, { id: 3, name: 'General' }]]),
    mumble: { sendTextMessage: (chs, html) => mumbleOut.push(html) },
    broadcastToChannel: (ch, m) => broadcasts.push(m),
  };
  const posted = [];
  let discordId = 900;
  discord.linksByMumbleId = new Map([[3, {
    discordChannelId: 'C1',
    channel: { guildId: 'G1' },
    webhook: { send: async (opts) => { posted.push(opts); return { id: `D${discordId++}` }; } },
  }]]);
  discord.linksByDiscordId = new Map([['C1', 3]]);
  return { pairs, broadcasts, mumbleOut, posted };
}

test('a web/app reply is posted to Discord with a quote of the original', async () => {
  const h = discordHarness();
  await discord.relayToDiscord({
    mumbleChannelId: 3, username: 'bob', text: 'yes!', messageId: 55,
    replyTo: { id: '10', username: 'al_ice', text: 'dinner *at* 8?' },
  });
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].content, '> ↪ **al\\_ice**: dinner \\*at\\* 8?\nyes!', 'markdown in the quote stays literal');
  assert.deepEqual(h.posted[0].allowedMentions, { parse: [] });
  assert.deepEqual(h.pairs, [{ lexicon: '55', discord: 'D900' }], 'remembered for later replies');
});

test('replying to a message that came from Discord adds a jump link to it', async () => {
  const h = discordHarness();
  h.pairs.push({ lexicon: '10', discord: 'D123' });
  await discord.relayToDiscord({ mumbleChannelId: 3, username: 'bob', text: 'ok', messageId: 56, replyTo: { id: '10', username: 'alex', text: 'dinner at 8?' } });
  assert.match(h.posted[0].content, /\(\[jump\]\(https:\/\/discord\.com\/channels\/G1\/C1\/D123\)\)/);
});

test('a Discord reply to a relayed message becomes a real reply for app and web users', async () => {
  const h = discordHarness();
  h.pairs.push({ lexicon: '10', discord: 'D123' });
  await discord._onMessage({
    id: 'D777', channel: { id: 'C1' }, author: { bot: false, username: 'erin' }, member: { displayName: 'Erin' },
    content: 'count me in', attachments: new Map(), mentions: { users: new Map() },
    reference: { messageId: 'D123' },
  });
  const m = h.broadcasts.at(-1);
  assert.equal(m.replyToId, '10');
  assert.deepEqual(m.replyTo, { id: '10', username: 'alex', text: 'dinner at 8?' });
  assert.equal(stored.at(-1).replyToId, '10');
  assert.equal(m.id, nextId - 1, 'broadcast carries the stored id');
  assert.ok(h.pairs.some((p) => p.discord === 'D777' && p.lexicon === String(m.id)), 'so a reply to it can link back');
  assert.match(h.mumbleOut.at(-1), /^<i>↪ alex: dinner at 8\?<\/i><br><b>\[Discord\] Erin:<\/b> count me in$/);
});

test('a Discord reply to an unknown message still shows the quote, without a link', async () => {
  const h = discordHarness();
  await discord._onMessage({
    id: 'D778', channel: { id: 'C1' }, author: { bot: false, username: 'erin' }, member: { displayName: 'Erin' },
    content: 'agreed', attachments: new Map(), mentions: { users: new Map() },
    reference: { messageId: 'D001' },
    fetchReference: async () => ({ content: 'from before the link', author: { username: 'old' }, member: null }),
  });
  const m = h.broadcasts.at(-1);
  assert.equal(m.replyToId, null);
  assert.deepEqual(m.replyTo, { id: null, username: 'old', text: 'from before the link' });
});

test('Discord bot and webhook posts (our own echoes) are ignored', async () => {
  const h = discordHarness();
  await discord._onMessage({ id: 'D1', channel: { id: 'C1' }, author: { bot: true }, content: 'echo', attachments: new Map() });
  assert.equal(h.broadcasts.length + stored.length, 0);
});
