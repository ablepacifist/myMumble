/**
 * Notifications Feature — Lexicon app integration
 *
 * Forwards chat/voice events to the Lexicon notification system
 * (POST /api/notifications) so they surface in the Lexicon web app:
 * navbar bell + unread badge, live toasts (SSE), and browser/OS push.
 * Per-user category preferences and actor self-exclusion are enforced
 * by Lexicon's logic layer — this module is a pure producer.
 *
 * Producer-only: registers no client WS message types. Other code calls
 * it via featureRegistry.features.get('notifications'):
 *   notifyMessage({ senderName, fromUserId, channelId, channelName, text })
 *   notifyVoiceJoin({ name, fromUserId, channelId, channelName })
 *   notifyMention({ targetUserId, fromUsername, fromUserId, channelId, preview })
 *
 * Note: the mentions feature owns voice-app mention UX (MySQL + WS + push);
 * mention events forwarded here use deliverPush=false so users never get
 * double OS pushes.
 */

const lexicon = require('../../lexicon-client');

const LEXICON_APP_URL = 'https://voice.alex-dyakin.com';
const MAX_BODY = 140;

class NotificationsFeature {
  constructor() {
    this.name = 'notifications';
    this.messageTypes = []; // producer-only — no client-originated WS messages
    this.deps = null;
    this.userIdCache = new Map(); // username(lower) -> lexicon user id
  }

  async init(deps) {
    this.deps = deps;
  }

  handleMessage() {
    // No client-originated message types.
  }

  _truncate(text) {
    if (!text) return text;
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY - 1) + '…' : text;
  }

  /**
   * Resolve a username to a Lexicon user id (used so Lexicon can exclude the
   * actor from their own broadcast). Checks online clients, then the bridge's
   * user_mapping table, then the Lexicon API. Hits are cached.
   */
  async resolveUserId(username) {
    if (!username) return null;
    const key = username.toLowerCase();
    if (this.userIdCache.has(key)) return this.userIdCache.get(key);

    // NOTE: userId 0 is a valid Lexicon id — use explicit null checks, never truthiness.

    // 1. Online web clients (no I/O)
    try {
      const clients = this.deps?.getClients?.();
      if (clients) {
        for (const [, info] of clients) {
          if (info.authenticated && info.userId != null && info.username?.toLowerCase() === key) {
            this.userIdCache.set(key, info.userId);
            return info.userId;
          }
        }
      }
    } catch (_) {}

    // 2. Bridge user_mapping table
    try {
      const [rows] = await this.deps.db.execute(
        'SELECT lexicon_user_id FROM user_mapping WHERE LOWER(lexicon_username) = LOWER(?)',
        [username]
      );
      if (rows.length > 0 && rows[0].lexicon_user_id != null) {
        this.userIdCache.set(key, rows[0].lexicon_user_id);
        return rows[0].lexicon_user_id;
      }
    } catch (_) {}

    // 3. Lexicon API
    try {
      const player = await lexicon.getPlayerByUsername(username);
      if (player && player.id != null) {
        this.userIdCache.set(key, player.id);
        return player.id;
      }
    } catch (_) {}

    return null;
  }

  /** Broadcast "new message" notification. Fire-and-forget safe. */
  async notifyMessage({ senderName, fromUserId = null, channelId, channelName, text }) {
    if (!senderName || !text) return;
    const resolvedFrom = fromUserId != null ? fromUserId : await this.resolveUserId(senderName);
    await lexicon.postNotification({
      type: 'message',
      title: `#${channelName || 'chat'}`,
      body: `${senderName}: ${this._truncate(text)}`,
      fromUsername: senderName,
      fromUserId: resolvedFrom,
      channelId,
      link: LEXICON_APP_URL,
    });
  }

  /** Broadcast "user joined voice" notification. Fire-and-forget safe. */
  async notifyVoiceJoin({ name, fromUserId = null, channelId, channelName }) {
    if (!name) return;
    const resolvedFrom = fromUserId != null ? fromUserId : await this.resolveUserId(name);
    await lexicon.postNotification({
      type: 'voice_join',
      title: '🔊 Voice chat',
      body: `${name} joined ${channelName || 'a channel'}`,
      fromUsername: name,
      fromUserId: resolvedFrom,
      channelId,
      link: LEXICON_APP_URL,
    });
  }

  /**
   * Directed "you were mentioned" notification for the Lexicon app.
   * deliverPush=false — the mentions feature already routes OS push.
   */
  async notifyMention({ targetUserId, fromUsername, fromUserId = null, channelId, preview }) {
    if (targetUserId == null || !fromUsername) return;
    await lexicon.postNotification({
      targetUserId,
      type: 'mention',
      title: `${fromUsername} mentioned you`,
      body: this._truncate(preview),
      fromUsername,
      fromUserId,
      channelId,
      link: LEXICON_APP_URL,
      deliverPush: false,
    });
  }

  cleanup() {
    // nothing to clean up
  }
}

module.exports = new NotificationsFeature();
