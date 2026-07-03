/**
 * Discord Sync Feature — bidirectional text bridge between a Discord channel
 * and a Mumble/web channel.
 *
 * Discord -> Mumble/web: bot listens for MessageCreate in the configured
 * Discord channel, relays into Mumble (sendTextMessage), broadcasts to web
 * clients, stores in Lexicon history, and fires a Lexicon "message"
 * notification (source: 'discord').
 *
 * Mumble/web -> Discord: mumble-relay.js and client-handler.js call
 * relayToDiscord() at the same point they already call notifyMessage(),
 * for messages in the configured Mumble sync channel. A Discord webhook
 * posts the message under the sender's real username + avatar.
 *
 * Loop safety: Discord messages are injected into Mumble as the bridge's
 * own session, and mumble-relay.js's existing `actor === ownSession` guard
 * (its very first check) prevents that injection from ever being processed
 * again — no notification, no re-broadcast, no re-relay back to Discord.
 * On the Discord side, `message.author.bot` is true for our own webhook
 * posts, so the single bot-author check both skips echoes and other bots.
 */

const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('../../config');
const { getAvatarPath } = require('../../database');

const DISCORD_MAX_LEN = 2000;
const VOICE_APP_URL = 'https://voice.alex-dyakin.com';
const AVATAR_HOST = VOICE_APP_URL;
const WEBHOOK_NAME = 'MumbleBridge Sync';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class DiscordSyncFeature {
  constructor() {
    this.name = 'discord-sync';
    this.messageTypes = []; // no client-originated WS types
    this.deps = null;
    this.client = null;
    this.webhook = null;
  }

  async init(deps) {
    this.deps = deps;

    if (!config.discord.botToken || !config.discord.channelId) {
      console.warn('[Discord] botToken/channelId not configured — Discord sync disabled.');
      return;
    }

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
    const channel = await this.client.channels.fetch(config.discord.channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`[Discord] Configured channel ${config.discord.channelId} not found or not text-based.`);
      return;
    }
    this.channel = channel;

    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((wh) => wh.owner?.id === this.client.user.id && wh.name === WEBHOOK_NAME);
    if (!webhook) {
      webhook = await channel.createWebhook({ name: WEBHOOK_NAME });
      console.log(`[Discord] Created webhook in #${channel.name}`);
    }
    this.webhook = webhook;
    console.log(`[Discord] ✅ Webhook ready in #${channel.name} — sync active with Mumble channel ${config.discord.syncMumbleChannelId}`);
  }

  async _onMessage(message) {
    if (!this.channel || message.channel.id !== config.discord.channelId) return;
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
    await this.relayToMumble({ username, text: text.trim() });
  }

  /** Discord -> Mumble/web. Persists, broadcasts, and notifies like any other message. */
  async relayToMumble({ username, text }) {
    if (!text) return;
    const channelId = config.discord.syncMumbleChannelId;
    const channelName = this.deps.channels.get(channelId)?.name || '';

    try {
      this.deps.mumble.sendTextMessage([channelId], `<b>[Discord] ${escapeHtml(username)}:</b> ${escapeHtml(text)}`);
    } catch (err) {
      console.error(`[Discord] Failed to relay into Mumble: ${err.message}`);
    }

    this.deps.broadcastToChannel(channelId, {
      type: 'text',
      channelId,
      username,
      text,
      source: 'discord',
      timestamp: new Date().toISOString(),
    });

    this.deps.lexicon.storeMessage({
      channelId,
      channelName,
      userId: 0,
      username,
      content: text,
    }).catch(() => {});

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
  async relayToDiscord({ username, avatarUrl, text }) {
    if (!this.webhook || !text) return;
    const truncated = text.length > DISCORD_MAX_LEN ? text.slice(0, DISCORD_MAX_LEN - 1) + '…' : text;
    try {
      await this.webhook.send({
        username,
        avatarURL: avatarUrl || undefined,
        content: truncated,
        allowedMentions: { parse: [] }, // don't let bridge text accidentally ping Discord users/roles
      });
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

  handleMessage() {
    // No client-originated message types.
  }

  cleanup() {
    if (this.client) this.client.destroy();
  }
}

module.exports = new DiscordSyncFeature();
