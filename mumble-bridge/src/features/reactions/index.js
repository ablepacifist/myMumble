/**
 * Emoji Reactions Feature
 *
 * Message types:
 *   reaction_add    → user adds a reaction to a message
 *   reaction_remove → user removes their reaction
 *   get_reactions   → get all reactions for a message
 *
 * Broadcasts:
 *   { type: 'reaction_update', messageId, reactions: [ { emoji, users: [...] } ] }
 *
 * Stores reactions in MySQL, broadcasts updates in real-time.
 */

const featureRegistry = require('../../feature-registry');

class ReactionsFeature {
  constructor() {
    this.name = 'reactions';
    this.messageTypes = ['reaction_add', 'reaction_remove', 'get_reactions', 'get_reactions_batch'];
    this.deps = null;
  }

  async init(deps) {
    this.deps = deps;

    const pool = deps.db;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        channel_id INT NOT NULL,
        user_id INT NOT NULL,
        username VARCHAR(255) NOT NULL,
        emoji VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_reaction (message_id, user_id, emoji),
        INDEX idx_message (message_id),
        INDEX idx_channel (channel_id)
      )
    `);
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) return;

    switch (msg.type) {
      case 'reaction_add':
        this._addReaction(ws, client, msg);
        break;
      case 'reaction_remove':
        this._removeReaction(ws, client, msg);
        break;
      case 'get_reactions':
        this._getReactions(ws, client, msg);
        break;
      case 'get_reactions_batch':
        this._getReactionsBatch(ws, client, msg);
        break;
    }
  }

  async _addReaction(ws, client, msg) {
    const { messageId, emoji, channelId } = msg;
    if (!messageId || !emoji) {
      ws.send(JSON.stringify({ type: 'error', message: 'messageId and emoji are required' }));
      return;
    }

    const accessFeature = featureRegistry.features?.get('channel-access');
    if (accessFeature && !accessFeature.canAccess(channelId || 0, client.userId, client.isAdmin)) {
      ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
      return;
    }

    // Sanitize emoji — allow unicode emoji or short codes like :thumbsup:
    const cleanEmoji = this._sanitizeEmoji(emoji);
    if (!cleanEmoji) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid emoji' }));
      return;
    }

    try {
      const pool = this.deps.db;
      await pool.execute(
        `INSERT IGNORE INTO message_reactions (message_id, channel_id, user_id, username, emoji)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, channelId || 0, client.userId, client.username, cleanEmoji]
      );

      // Fetch updated reactions and broadcast
      const reactions = await this._fetchReactions(messageId);
      const chId = channelId || 0;
      this.deps.broadcastToChannel(chId, {
        type: 'reaction_update',
        messageId,
        channelId: chId,
        reactions,
      });
    } catch (err) {
      console.error(`[Reactions] Add failed: ${err.message}`);
    }
  }

  async _removeReaction(ws, client, msg) {
    const { messageId, emoji, channelId } = msg;
    if (!messageId || !emoji) return;

    const accessFeature = featureRegistry.features?.get('channel-access');
    if (accessFeature && !accessFeature.canAccess(channelId || 0, client.userId, client.isAdmin)) {
      ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
      return;
    }

    const cleanEmoji = this._sanitizeEmoji(emoji);
    if (!cleanEmoji) return;

    try {
      const pool = this.deps.db;
      await pool.execute(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [messageId, client.userId, cleanEmoji]
      );

      const reactions = await this._fetchReactions(messageId);
      const chId = channelId || 0;
      this.deps.broadcastToChannel(chId, {
        type: 'reaction_update',
        messageId,
        channelId: chId,
        reactions,
      });
    } catch (err) {
      console.error(`[Reactions] Remove failed: ${err.message}`);
    }
  }

  async _getReactions(ws, client, msg) {
    const { messageId } = msg;
    if (!messageId) return;

    try {
      const reactions = await this._fetchReactions(messageId);
      ws.send(JSON.stringify({
        type: 'reaction_update',
        messageId,
        reactions,
      }));
    } catch (err) {
      console.error(`[Reactions] Get failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'reaction_update', messageId, reactions: [] }));
    }
  }

  async _getReactionsBatch(ws, client, msg) {
    const { messageIds } = msg;
    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) return;

    try {
      const pool = this.deps.db;
      // Only process up to 100 IDs to prevent abuse
      const ids = messageIds.slice(0, 100).filter(id => Number.isInteger(Number(id)));
      if (ids.length === 0) return;

      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT message_id, emoji, GROUP_CONCAT(username ORDER BY created_at SEPARATOR ',') AS usernames, COUNT(*) AS cnt
         FROM message_reactions
         WHERE message_id IN (${placeholders})
         GROUP BY message_id, emoji
         ORDER BY message_id, MIN(created_at)`,
        ids
      );

      // Group by messageId
      const byMessage = {};
      for (const r of rows) {
        const mid = String(r.message_id);
        if (!byMessage[mid]) byMessage[mid] = [];
        byMessage[mid].push({ emoji: r.emoji, count: r.cnt, users: r.usernames.split(',') });
      }

      // Send reaction_update for each message that has reactions
      for (const [mid, reactions] of Object.entries(byMessage)) {
        ws.send(JSON.stringify({ type: 'reaction_update', messageId: mid, reactions }));
      }
    } catch (err) {
      console.error(`[Reactions] Batch get failed: ${err.message}`);
    }
  }

  /**
   * Fetch grouped reactions for a message.
   * Returns: [ { emoji: '👍', count: 3, users: ['alice', 'bob', 'charlie'] }, ... ]
   */
  async _fetchReactions(messageId) {
    const pool = this.deps.db;
    const [rows] = await pool.execute(
      `SELECT emoji, GROUP_CONCAT(username ORDER BY created_at SEPARATOR ',') AS usernames, COUNT(*) AS cnt
       FROM message_reactions
       WHERE message_id = ?
       GROUP BY emoji
       ORDER BY MIN(created_at)`,
      [messageId]
    );
    return rows.map(r => ({
      emoji: r.emoji,
      count: r.cnt,
      users: r.usernames.split(','),
    }));
  }

  /**
   * Sanitize an emoji string. Allow unicode emoji or shortcodes.
   */
  _sanitizeEmoji(emoji) {
    if (!emoji || typeof emoji !== 'string') return null;
    const trimmed = emoji.trim();
    if (trimmed.length === 0 || trimmed.length > 32) return null;
    // Allow unicode emoji (emoji are multi-byte) or shortcode like :thumbsup:
    if (/^[\p{Emoji}\u200d\ufe0f]+$/u.test(trimmed)) return trimmed;
    if (/^:[a-zA-Z0-9_+-]+:$/.test(trimmed)) return trimmed;
    return null;
  }

  cleanup() {
    // nothing to clean up
  }
}

const instance = new ReactionsFeature();
module.exports = instance;
