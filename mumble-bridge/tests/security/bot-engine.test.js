'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stub, load, fakeDatabase } = require('./helpers');

const EVIL = '<img src=x onerror=alert(1)>';

stub('database', fakeDatabase());
stub('music-bot', { getVolumePercent: () => 80, setVolume: (n) => n, stop: async () => {}, playInChannel: async () => ({ ok: false, error: EVIL }) });
stub('lexicon-client', {
  searchMedia: async (q) => (q === 'nothing' ? [] : [{ id: 9, title: EVIL, filename: 'f.mp3', mediaType: EVIL }]),
  queueToLivestream: async () => ({}),
  skipLivestream: async () => { throw new Error(EVIL); },
  getLivestreamState: async () => ({ state: { currentMedia: { title: EVIL, mediaType: EVIL } } }),
  getLivestreamQueue: async () => ({ queue: [{ mediaFile: { title: EVIL } }] }),
});
const BotEngine = load('bot-engine');

function makeBot() {
  const mumbleMessages = [];
  const webMessages = [];
  const wsServer = {
    users: new Map([[1, { name: EVIL, channelId: 0 }]]),
    channels: new Map([[0, { id: 0, name: EVIL }]]),
    clients: new Map(),
    _broadcastToChannel: (ch, msg) => webMessages.push(msg),
  };
  const bot = new BotEngine({ sendTextMessage: (c, m) => mumbleMessages.push(m), on() {} }, wsServer);
  return { bot, mumbleMessages, webMessages };
}

// Whatever the bot says is HTML shown to everyone, so nothing a user typed may add a tag
function assertNoInjectedTags(html) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
  for (const t of tags) assert.ok(['b', 'br'].includes(t), `unexpected <${t}> in: ${html}`);
  assert.ok(!/<[^>]*\son\w+\s*=/i.test(html), `handler in tag: ${html}`);
}

test('bot replies never carry markup that came from a user, a title or an error', async () => {
  const cases = [
    `!${EVIL}`, '!play x', '!search x', '!search nothing', '!play nothing', '!skip', '!np', '!queue', '!users', '!channels', '!status', '!help', '!volume 50',
  ];
  for (const raw of cases) {
    const { bot, mumbleMessages, webMessages } = makeBot();
    await bot._handleCommand(raw, 'someone', 5, 0, 0);
    assert.ok(mumbleMessages.length >= 1, `no reply for ${raw}`);
    for (const html of [...mumbleMessages, ...webMessages.map((m) => m.html)]) assertNoInjectedTags(html);
  }
});

test('the bot still answers normally', async () => {
  const { bot, mumbleMessages } = makeBot();
  await bot._handleCommand('!volume 50', 'x', 1, 0, 0);
  assert.match(mumbleMessages[0], /Volume set to <b>50%<\/b>/);
  await bot._handleCommand('!search nothing', 'x', 1, 0, 0);
  assert.match(mumbleMessages[1], /No results for: <b>nothing<\/b>/);
});

test('an unknown command is echoed escaped', async () => {
  const { bot, mumbleMessages } = makeBot();
  await bot._handleCommand(`!<script>alert(1)</script>`, 'x', 1, 0, 0);
  assert.match(mumbleMessages[0], /Unknown command: <b>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/b>/);
});
