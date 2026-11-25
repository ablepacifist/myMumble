/**
 * Discord Sync Feature — bidirectional text bridge between Discord channels
 * and Mumble/web channels. Supports any number of channel-to-channel links,
 * persisted in `discord_channel_links` and editable live via the
 * `set_channel_discord_link` WS message (admin-only, see handleMessage).
 *
 * Discord -> Mumble/web: bot listens for MessageCreate in any linked Discord
 * channel, relays into Mumble (sendTextMessage), broadcasts to web clients,
 * stores in Lexicon history, and fires a Lexicon "message" notification
 * (source: 'discord').
 *
 * Mumble/web -> Discord: mumble-relay.js and client-handler.js call
 * relayToDiscord() at the same point they already call notifyMessage(),
 * for messages in any linked Mumble channel. A Discord webhook posts the
 * message under the sender's real username + avatar.
 *
 * Loop safety: Discord messages are injected into Mumble as the bridge's
 * own session, and mumble-relay.js's existing `actor === ownSession` guard
 * (its very first check) prevents that injection from ever being processed
 * again — no notification, no re-broadcast, no re-relay back to Discord.
 * On the Discord side, `message.author.bot` is true for our own webhook
 * posts, so the single bot-author check both skips echoes and other bots.
 *
 * Replies: `discord_message_links` pairs each relayed message's Lexicon id with its
 * Discord message id, in both directions. A web/app reply is posted to Discord with a
 * quote of the original (and a jump link when the original is on Discord too); a Discord
 * reply becomes a real reply in Lexicon when its original is known, or carries a quote
 * of the Discord original when it is not.
 */

const { Client, GatewayIntentBits, Events, WebhookClient } = require('discord.js');
const config = require('../../config');
const { getAvatarPath } = require('../../database');
const replies = require('../../reply-preview');

const DISCORD_MAX_LEN = 2000;
const VOICE_APP_URL = 'https://voice.alex-dyakin.com';
const AVATAR_HOST = VOICE_APP_URL;
const WEBHOOK_NAME = 'MumbleBridge Sync';
const HYDRATE_STAGGER_MS = 150;
const DISCORD_ID_RE = /^\d{5,25}$/;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape Discord markdown in text we quote, so a quoted "*" or "_" stays literal. */
function escapeDiscordMarkdown(text) {
  return String(text).replace(/([\\*_~`|>\[\]()])/g, '\\$1');
}

/**
 * The content posted to Discord for a message, with a one-line quote of the original when
 * it is a reply. `jumpUrl` links back to the original when that is on Discord as well.
 */
function discordContent(text, replyTo, jumpUrl) {
  if (!replyTo) return text;
  const who = escapeDiscordMarkdown(replyTo.username || 'someone');
  const quoted = escapeDiscordMarkdown(replyTo.text || '').replace(/\s+/g, ' ');
  const link = jumpUrl ? ` ([jump](${jumpUrl}))` : '';
  return `> ↪ **${who}**: ${quoted}${link}\n${text}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DiscordSyncFeature {
  constructor() {
    this.name = 'discord-sync';
    this.messageTypes = ['set_channel_discord_link'];
    this.deps = null;
    this.client = null;
    this.linksByMumbleId = new Map();  // mumbleChannelId:number -> { discordChannelId, webhook, channel }
    this.linksByDiscordId = new Map(); // discordChannelId:string -> mumbleChannelId:number
    this._linkMutationQueue = Promise.resolve(); // serializes addLink/removeLink calls
  }

  async init(deps) {
    this.deps = deps;

    if (!config.discord.botToken) {
      console.warn('[Discord] botToken not configured — Discord sync disabled.');
      return;
    }

    await deps.db.execute(`
      CREATE TABLE IF NOT EXISTS discord_channel_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        mumble_channel_id INT NOT NULL,
        discord_channel_id VARCHAR(32) NOT NULL,
        discord_webhook_id VARCHAR(32) DEFAULT NULL,
        discord_webhook_token VARCHAR(128) DEFAULT NULL,
        created_by VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mumble_channel (mumble_channel_id),
        UNIQUE KEY uq_discord_channel (discord_channel_id)
      )
    `);

    // Pairs Lexicon message ids with Discord message ids, so replies can cross over.
    await deps.db.execute(`
      CREATE TABLE IF NOT EXISTS discord_message_links (
        lexicon_message_id BIGINT NOT NULL,
        discord_message_id VARCHAR(32) NOT NULL,
        mumble_channel_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (lexicon_message_id),
        UNIQUE KEY uq_discord_message (discord_message_id)
      )
    `);

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      this.client.once(Events.ClientReady, () => this._onReady().catch((err) => {
        console.error('[Discord] Ready handler failed:', err.message);
      }));
      this.client.on(Events.MessageCreate, (msg) => this._onMessage(msg).catch((err) => {
        console.error('[Discord] MessageCreate handler failed:', err.message);
      }));
      this.client.on(Events.Error, (err) => console.error('[Discord] Client error:', err.message));

      await this.client.login(config.discord.botToken);
    } catch (err) {
      console.error(`[Discord] Failed to start Discord sync: ${err.message}`);
      console.error('         Check DISCORD_BOT_TOKEN and that the "Message Content Intent" is enabled.');
      this.client = null;
    }
  }

  async _onReady() {
    console.log(`[Discord] Logged in as ${this.client.user.tag}`);
    await this._migrateLegacyEnvPairIfNeeded();

    const [rows] = await this.deps.db.execute('SELECT * FROM discord_channel_links');
    for (const row of rows) {
      try {
        await this._hydrateLink(row);
      } catch (err) {
        console.error(`[Discord] Failed to hydrate link (mumble ${row.mumble_channel_id} <-> discord ${row.discord_channel_id}): ${err.message}`);
      }
      await sleep(HYDRATE_STAGGER_MS);
    }
    console.log(`[Discord] ✅ Sync active for ${this.linksByMumbleId.size} channel link(s).`);
  }

  /**
   * One-time migration: seed the legacy single-pair env config as a row so
   * it flows through the same hydration path as everything else. Guarded by
   * "table is empty" — never runs again once any row exists.
   */
  async _migrateLegacyEnvPairIfNeeded() {
    const [[{ cnt }]] = await this.deps.db.execute('SELECT COUNT(*) AS cnt FROM discord_channel_links');
    if (cnt > 0) return;
    if (!config.discord.channelId || !config.discord.syncMumbleChannelId) return;

    try {
      await this.deps.db.execute(
        'INSERT INTO discord_channel_links (mumble_channel_id, discord_channel_id, created_by) VALUES (?, ?, ?)',
        [config.discord.syncMumbleChannelId, config.discord.channelId, 'env-migration']
      );
      console.log('[Discord] Migrated legacy DISCORD_CHANNEL_ID/DISCORD_SYNC_MUMBLE_CHANNEL_ID into discord_channel_links (one-time). Safe to remove those two env vars now.');
    } catch (err) {
      console.error(`[Discord] Legacy pair migration FAILED: ${err.message} — the previously-working sync may be lost until this is fixed.`);
    }
  }

  /** Fetch the Discord channel + webhook for a DB row and populate both maps + the shared channel object. */
  async _hydrateLink(row) {
    const mumbleChannelId = row.mumble_channel_id;
    const discordChannelId = row.discord_channel_id;

    const channel = await this.client.channels.fetch(discordChannelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`channel ${discordChannelId} not found or not text-based`);
    }

    let webhook;
    if (row.discord_webhook_id && row.discord_webhook_token) {
      webhook = new WebhookClient({ id: row.discord_webhook_id, token: row.discord_webhook_token });
    } else {
      webhook = await this._resolveWebhook(channel);
      await this.deps.db.execute(
        'UPDATE discord_channel_links SET discord_webhook_id = ?, discord_webhook_token = ? WHERE id = ?',
        [webhook.id, webhook.token, row.id]
      );
    }

    this.linksByMumbleId.set(mumbleChannelId, { discordChannelId, webhook, channel });
    this.linksByDiscordId.set(discordChannelId, mumbleChannelId);

    const ch = this.deps.channels.get(mumbleChannelId);
    if (ch) ch.discordChannelId = discordChannelId;

    console.log(`[Discord] Linked Mumble channel ${mumbleChannelId} <-> #${channel.name}`);
  }

  /** Find our existing webhook in a channel, or create one. */
  async _resolveWebhook(channel) {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((wh) => wh.owner?.id === this.client.user.id && wh.name === WEBHOOK_NAME);
    if (!webhook) {
      webhook = await channel.createWebhook({ name: WEBHOOK_NAME });
      console.log(`[Discord] Created webhook in #${channel.name}`);
    }
    return webhook;
  }

  async _onMessage(message) {
    const mumbleChannelId = this.linksByDiscordId.get(message.channel.id);
    if (mumbleChannelId === undefined) return;
    if (message.author.bot) return; // covers our own webhook echoes + other bots

    let text = message.content || '';
    if (!text.trim() && message.attachments.size === 0) return;

    // Resolve <@id> mentions to readable @username for parity with the
    // Mumble-side mentions feature (best-effort; skips on failure).
    for (const [, user] of message.mentions.users) {
      text = text.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${user.username}`);
    }
    if (message.attachments.size > 0) {
      const links = [...message.attachments.values()].map((a) => a.url).join(' ');
      text = text ? `${text} ${links}` : links;
    }

    const username = message.member?.displayName || message.author.username;
    const replyTo = await this._replyFromDiscord(message, mumbleChannelId);
    await this.relayToMumble({ mumbleChannelId, username, text: text.trim(), discordMessageId: message.id, replyTo });
  }

  /**
   * The reply preview for a Discord message that replies to another. A known original
   * (relayed through us) becomes a real Lexicon reply; an unknown one still shows as a
   * quote, just without a link (id null).
   */
  async _replyFromDiscord(message, mumbleChannelId) {
    const refId = message.reference?.messageId;
    if (!refId) return null;
    try {
      const lexiconId = await this._lexiconIdForDiscord(refId);
      if (lexiconId) {
        const preview = await replies.resolveReplyPreview(this.deps.lexicon, lexiconId, mumbleChannelId);
        if (preview) return preview;
      }
      const original = typeof message.fetchReference === 'function' ? await message.fetchReference() : null;
      if (!original) return null;
      const text = replies.previewText({ content: original.content || (original.attachments?.size ? '[image]' : '') });
      return { id: null, username: original.member?.displayName || original.author?.username || 'someone', text };
    } catch (err) {
      console.error(`[Discord] Could not resolve reply target ${refId}: ${err.message}`);
      return null;
    }
  }

  async _lexiconIdForDiscord(discordMessageId) {
    const [rows] = await this.deps.db.execute(
      'SELECT lexicon_message_id FROM discord_message_links WHERE discord_message_id = ?', [String(discordMessageId)]);
    return rows.length ? String(rows[0].lexicon_message_id) : null;
  }

  async _discordIdForLexicon(lexiconMessageId) {
    const [rows] = await this.deps.db.execute(
      'SELECT discord_message_id FROM discord_message_links WHERE lexicon_message_id = ?', [String(lexiconMessageId)]);
    return rows.length ? String(rows[0].discord_message_id) : null;
  }

  /** Best effort: a missing pair only means a later reply shows without a jump link. */
  async _rememberPair(lexiconMessageId, discordMessageId, mumbleChannelId) {
    if (!replies.isMessageId(lexiconMessageId) || !discordMessageId) return;
    try {
      await this.deps.db.execute(
        'INSERT IGNORE INTO discord_message_links (lexicon_message_id, discord_message_id, mumble_channel_id) VALUES (?, ?, ?)',
        [String(lexiconMessageId), String(discordMessageId), mumbleChannelId]);
    } catch (err) {
      console.error(`[Discord] Could not record message pair: ${err.message}`);
    }
  }

  /** Discord -> Mumble/web. Persists, broadcasts, and notifies like any other message. */
  async relayToMumble({ mumbleChannelId, username, text, discordMessageId = null, replyTo = null }) {
    if (!text) return;
    const channelId = mumbleChannelId;
    const channelName = this.deps.channels.get(channelId)?.name || '';

    try {
      this.deps.mumble.sendTextMessage([channelId],
        `${replies.mumbleQuoteHtml(replyTo, escapeHtml)}<b>[Discord] ${escapeHtml(username)}:</b> ${escapeHtml(text)}`);
    } catch (err) {
      console.error(`[Discord] Failed to relay into Mumble: ${err.message}`);
    }

    // Stored before the broadcast so the live copy carries Lexicon's id; clients match it
    // against history by that id instead of showing the message twice.
    const replyToId = replyTo?.id || null;
    let id = null;
    try {
      const stored = await this.deps.lexicon.storeMessage({
        channelId,
        channelName,
        userId: 0,
        username,
        content: text,
        replyToId,
      });
      id = stored?.messageId ?? null;
    } catch (_) {
      // Still deliver it live.
    }
    if (id != null) await this._rememberPair(id, discordMessageId, channelId);

    this.deps.broadcastToChannel(channelId, {
      type: 'text',
      channelId,
      id,
      username,
      text,
      source: 'discord',
      timestamp: new Date().toISOString(),
      replyToId,
      replyTo,
    });

    const notifFeature = require('../notifications');
    notifFeature.notifyMessage({
      senderName: username,
      channelId,
      channelName,
      text,
      source: 'discord',
    }).catch(() => {});
  }

  /** Mumble/web -> Discord. Posts via webhook so it shows the real username + avatar. */
  async relayToDiscord({ mumbleChannelId, username, avatarUrl, text, messageId = null, replyTo = null }) {
    const link = this.linksByMumbleId.get(mumbleChannelId);
    if (!link || !link.webhook || !text) return;

    let jumpUrl = null;
    if (replyTo?.id) {
      try {
        const original = await this._discordIdForLexicon(replyTo.id);
        const guildId = link.channel?.guildId;
        if (original && guildId) jumpUrl = `https://discord.com/channels/${guildId}/${link.discordChannelId}/${original}`;
      } catch (_) {
        // Quote without a link.
      }
    }

    const content = discordContent(text, replyTo, jumpUrl);
    const truncated = content.length > DISCORD_MAX_LEN ? content.slice(0, DISCORD_MAX_LEN - 1) + '…' : content;
    try {
      const sent = await link.webhook.send({
        username,
        avatarURL: avatarUrl || undefined,
        content: truncated,
        allowedMentions: { parse: [] }, // don't let bridge text accidentally ping Discord users/roles
      });
      if (messageId != null && sent?.id) await this._rememberPair(messageId, sent.id, mumbleChannelId);
    } catch (err) {
      console.error(`[Discord] Failed to relay to Discord: ${err.message}`);
    }
  }

  /** Best-effort avatar URL lookup for a bridge username, for relayToDiscord. */
  async getAvatarUrlFor(username) {
    try {
      const path = await getAvatarPath(username);
      return path ? `${AVATAR_HOST}${path}` : undefined;
    } catch (_) {
      return undefined;
    }
  }

  /** Cheap pre-check so call sites can skip avatar lookups for unlinked channels. */
  isLinked(mumbleChannelId) {
    return this.linksByMumbleId.has(mumbleChannelId);
  }

  /**
   * Link a Mumble channel to a Discord channel: fetches the Discord channel,
   * resolves/creates a webhook, persists the link, and updates the live
   * maps + shared channel object. Safe to call for an existing link (moves
   * it to the new Discord channel) or a brand new one. Calls are serialized
   * through _linkMutationQueue so concurrent admin edits can't interleave
   * webhook-creation calls against Discord's API.
   */
  async addLink(mumbleChannelId, discordChannelId, opts = {}) {
    if (!this.client) return { ok: false, error: 'Discord client not connected' };
    if (!DISCORD_ID_RE.test(discordChannelId)) return { ok: false, error: 'Invalid Discord channel ID' };

    const run = async () => {
      let channel;
      try {
        channel = await this.client.channels.fetch(discordChannelId);
      } catch (err) {
        return { ok: false, error: `Could not access Discord channel: ${err.message}` };
      }
      if (!channel || !channel.isTextBased()) {
        return { ok: false, error: 'Discord channel not found or not text-based' };
      }

      let webhook;
      try {
        webhook = await this._resolveWebhook(channel);
      } catch (err) {
        return { ok: false, error: `Could not create webhook: ${err.message}` };
      }

      try {
        const [existingByMumble] = await this.deps.db.execute(
          'SELECT id FROM discord_channel_links WHERE mumble_channel_id = ?',
          [mumbleChannelId]
        );
        if (existingByMumble.length > 0) {
          await this.deps.db.execute(
            'UPDATE discord_channel_links SET discord_channel_id = ?, discord_webhook_id = ?, discord_webhook_token = ?, created_by = ? WHERE mumble_channel_id = ?',
            [discordChannelId, webhook.id, webhook.token, opts.createdBy || null, mumbleChannelId]
          );
        } else {
          await this.deps.db.execute(
            'INSERT INTO discord_channel_links (mumble_channel_id, discord_channel_id, discord_webhook_id, discord_webhook_token, created_by) VALUES (?, ?, ?, ?, ?)',
            [mumbleChannelId, discordChannelId, webhook.id, webhook.token, opts.createdBy || null]
          );
        }
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return { ok: false, error: 'That Discord channel is already linked to a different Mumble channel' };
        }
        return { ok: false, error: `Database error: ${err.message}` };
      }

      // Clear any stale reverse-map entry if this mumble channel was linked elsewhere before.
      const previous = this.linksByMumbleId.get(mumbleChannelId);
      if (previous && previous.discordChannelId !== discordChannelId) {
        this.linksByDiscordId.delete(previous.discordChannelId);
      }

      this.linksByMumbleId.set(mumbleChannelId, { discordChannelId, webhook, channel });
      this.linksByDiscordId.set(discordChannelId, mumbleChannelId);

      const ch = this.deps.channels.get(mumbleChannelId);
      if (ch) {
        ch.discordChannelId = discordChannelId;
        this.deps.broadcastChannelUpdate(ch);
      }

      return { ok: true };
    };

    const result = this._linkMutationQueue.then(run, run);
    this._linkMutationQueue = result.catch(() => {});
    return result;
  }

  /** Remove a Mumble channel's Discord link. Leaves the Discord-side webhook in place (harmless if orphaned). */
  async removeLink(mumbleChannelId) {
    const run = async () => {
      const link = this.linksByMumbleId.get(mumbleChannelId);
      try {
        await this.deps.db.execute('DELETE FROM discord_channel_links WHERE mumble_channel_id = ?', [mumbleChannelId]);
      } catch (err) {
        return { ok: false, error: `Database error: ${err.message}` };
      }

      if (link) this.linksByDiscordId.delete(link.discordChannelId);
      this.linksByMumbleId.delete(mumbleChannelId);

      const ch = this.deps.channels.get(mumbleChannelId);
      if (ch) {
        delete ch.discordChannelId;
        this.deps.broadcastChannelUpdate(ch);
      }

      return { ok: true };
    };

    const result = this._linkMutationQueue.then(run, run);
    this._linkMutationQueue = result.catch(() => {});
    return result;
  }

  handleMessage(ws, client, msg) {
    if (msg.type !== 'set_channel_discord_link') return;
    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }
    if (!client.isAdmin) {
      ws.send(JSON.stringify({ type: 'error', message: 'Only superusers can link Discord channels' }));
      return;
    }

    const channelId = parseInt(msg.channelId, 10);
    if (!Number.isFinite(channelId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel id' }));
      return;
    }
    const discordChannelId = (msg.discordChannelId || '').toString().trim();

    const op = discordChannelId
      ? this.addLink(channelId, discordChannelId, { createdBy: client.username })
      : this.removeLink(channelId);

    op.then((result) => {
      ws.send(JSON.stringify({
        type: 'channel_discord_link_result',
        channelId,
        success: !!result.ok,
        error: result.error || null,
      }));
    });
  }

  cleanup() {
    if (this.client) this.client.destroy();
  }
}

module.exports = new DiscordSyncFeature();
module.exports.discordContent = discordContent;
module.exports.escapeDiscordMarkdown = escapeDiscordMarkdown;
