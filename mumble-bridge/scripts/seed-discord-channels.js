#!/usr/bin/env node
/**
 * One-off rollout script: creates the Mumble channels that don't exist yet
 * and links all 14 Mumble<->Discord channel pairs via discord-sync's
 * addLink(). Safe to re-run — channel creation is skip-if-exists by
 * name+parent, and addLink() upserts.
 *
 * Run from mumble-bridge/: node scripts/seed-discord-channels.js
 *
 * After this completes, restart the bridge (sudo systemctl restart
 * mumble-bridge) so the live process picks up the new links, and restart
 * mumble-server so native Mumble clients see the new channels (channel
 * creation here is a raw DB insert, same as the existing create_channel
 * WS handler — murmurd won't see it until it restarts).
 */

const { getMumblePool, getBridgePool } = require('../src/database');
const config = require('../src/config');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const discordFeature = require('../src/features/discord-sync');

const NEW_CHANNELS = [
  { name: 'pal-world', parentName: 'Servers' },
  { name: 'bot-commands', parentName: 'communications' },
  { name: 'suggestion-box', parentName: 'communications' },
  { name: 'game-requests', parentName: 'communications' },
  { name: 'game_night', parentName: 'communications' },
  { name: 'politics', parentName: null },
  { name: 'Ramscoop exp', parentName: null },
  { name: 'forgotten gnome', parentName: null },
  { name: 'camping trip', parentName: null },
];

// Mumble channel name -> Discord channel ID, for all 14 target links
// (5 pre-existing channels by name + the 9 being created above).
const LINKS = {
  memes: '1348317904944369665',
  politics: '1264712659765559296',
  game_night: '1494077018252247262',
  announcements: '1521654567752826990',
  'bot-commands': '1391144321499271259',
  minecraft: '1259562941410312414',
  ark: '1414264329993191466',
  Ksp: '1492297143531208714',
  'pal-world': '1527759936811962428',
  'Ramscoop exp': '1259638872590123091',
  'forgotten gnome': '1391125860853223434',
  'suggestion-box': '1259638474840080506',
  'game-requests': '1391125273394811031',
  'camping trip': '1068552257899089992',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureChannel(mumbleDb, name, parentName) {
  const parentId = parentName
    ? (await mumbleDb.execute('SELECT channel_id FROM channels WHERE server_id = 1 AND name = ?', [parentName]))[0][0]?.channel_id ?? 0
    : 0;

  const [existing] = await mumbleDb.execute(
    'SELECT channel_id FROM channels WHERE server_id = 1 AND name = ? AND parent_id = ?',
    [name, parentId]
  );
  if (existing.length > 0) {
    console.log(`[Channels] "${name}" already exists (id=${existing[0].channel_id}) — skipping create.`);
    return existing[0].channel_id;
  }

  const [maxRow] = await mumbleDb.execute('SELECT MAX(channel_id) AS maxId FROM channels WHERE server_id = 1');
  const newId = (maxRow[0].maxId || 0) + 1;
  await mumbleDb.execute(
    'INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl) VALUES (1, ?, ?, ?, 1)',
    [newId, parentId, name]
  );
  console.log(`[Channels] Created "${name}" (id=${newId}, parent=${parentId}).`);
  return newId;
}

async function main() {
  const mumbleDb = getMumblePool();
  const bridgeDb = getBridgePool();

  console.log('=== Step 1: create missing Mumble channels ===');
  for (const { name, parentName } of NEW_CHANNELS) {
    await ensureChannel(mumbleDb, name, parentName);
  }

  console.log('\n=== Step 2: log in to Discord ===');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await new Promise((resolve, reject) => {
    client.once(Events.ClientReady, resolve);
    client.once(Events.Error, reject);
    client.login(config.discord.botToken).catch(reject);
  });
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  // Reuse discord-sync's addLink() logic directly instead of duplicating it —
  // wire this script's own client/db into the singleton feature instance.
  discordFeature.client = client;
  discordFeature.deps = { db: bridgeDb, channels: new Map(), broadcast: () => {} };

  console.log('\n=== Step 3: link all channel pairs ===');
  const results = [];
  for (const [mumbleName, discordChannelId] of Object.entries(LINKS)) {
    const [rows] = await mumbleDb.execute('SELECT channel_id FROM channels WHERE server_id = 1 AND name = ?', [mumbleName]);
    if (rows.length === 0) {
      results.push({ mumbleName, discordChannelId, ok: false, error: 'Mumble channel not found' });
      continue;
    }
    const mumbleChannelId = rows[0].channel_id;
    const result = await discordFeature.addLink(mumbleChannelId, discordChannelId, { createdBy: 'seed-script' });
    results.push({ mumbleName, mumbleChannelId, discordChannelId, ok: result.ok, error: result.error });
    await sleep(500); // stay clear of Discord's webhook-management rate limit
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.mumbleName} (${r.mumbleChannelId ?? '?'}) <-> ${r.discordChannelId}${r.error ? '  — ' + r.error : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} links ok.`);

  client.destroy();
  await bridgeDb.end();
  await mumbleDb.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[Seed] Fatal error:', err);
  process.exit(1);
});
