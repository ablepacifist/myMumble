/**
 * Mentions & Notifications Feature
 *
 * Message types:
 *   get_notifications  → client requests their unread notifications
 *   notifications_read → client marks notifications as read
 *   mention_users      → (internal) — triggered automatically when a text message contains @username
 *
 * This feature:
 *   - Parses @username mentions from outgoing chat messages
 *   - Stores notifications in MySQL
 *   - Sends real-time notification WS events to mentioned users
 *   - Provides notification history (unread count, list, mark-read)
 */

const MENTION_REGEX = /@(\w{1,32})/g;
const lexicon = require('../../lexicon-client');

class MentionsFeature {
  constructor() {
    this.name = 'mentions';
    this.messageTypes = ['get_notifications', 'notifications_read'];
    this.deps = null;
  }

  async init(deps) {
    this.deps = deps;

    // Create the notifications table if it doesn't exist
    const pool = deps.db;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT 'Recipient user ID',
        type VARCHAR(30) NOT NULL DEFAULT 'mention',
        from_username VARCHAR(255),
        channel_id INT,
        channel_name VARCHAR(255),
        message_id BIGINT NULL,
        message_preview VARCHAR(500),
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_unread (user_id, is_read, created_at),
        INDEX idx_user_time (user_id, created_at)
      )
    `);
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) return;

    switch (msg.type) {
      case 'get_notifications':
        this._getNotifications(ws, client, msg);
        break;
      case 'notifications_read':
        this._markRead(ws, client, msg);
        break;
    }
  }

  /**
   * Parse @mentions from a chat message and notify mentioned users.
   * Called externally from client-handler after a text message is broadcast.
   */
  async processMentions({ text, fromUsername, fromUserId, channelId, channelName, messageId }) {
    if (!text || !this.deps) return [];

    const mentions = [];
    let match;
    const seen = new Set();
    const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
    while ((match = regex.exec(text)) !== null) {
      const mentioned = match[1].toLowerCase();
      if (seen.has(mentioned) || mentioned === fromUsername.toLowerCase()) continue;
      seen.add(mentioned);
      mentions.push(mentioned);
    }

    if (mentions.length === 0) return [];

    // Find mentioned users (online or offline)
    const clients = this.deps.getClients();
    const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
    const pool = this.deps.db;

    for (const mentionedName of mentions) {
      // Find the connected client for this username
      let targetUserId = null;
      let targetWs = null;

      for (const [clientWs, info] of clients) {
        if (info.authenticated && info.username && info.username.toLowerCase() === mentionedName) {
          targetUserId = info.userId;
          targetWs = clientWs;
          break;
        }
      }

      // If not online, look up from DB
      if (!targetUserId) {
        try {
          const [rows] = await pool.execute(
            'SELECT lexicon_user_id FROM user_mapping WHERE LOWER(lexicon_username) = LOWER(?)',
            [mentionedName]
          );
          if (rows.length > 0) targetUserId = rows[0].lexicon_user_id;
        } catch (_) {}
      }

      // Store notification in DB (even if user is offline — they'll see it when they connect)
      if (targetUserId) {
        try {
          const [result] = await pool.execute(
            `INSERT INTO notifications (user_id, type, from_username, channel_id, channel_name, message_id, message_preview)
             VALUES (?, 'mention', ?, ?, ?, ?, ?)`,
            [targetUserId, fromUsername, channelId, channelName || null, messageId || null, preview]
          );

          // Send real-time notification to the mentioned user if online
          if (targetWs && targetWs.readyState === 1) {
            targetWs.send(JSON.stringify({
              type: 'notification',
              notification: {
                id: result.insertId,
                notifType: 'mention',
                fromUsername,
                channelId,
                channelName,
                messagePreview: preview,
                createdAt: new Date().toISOString(),
              },
            }));
          } else {
            // Push notification to offline user
            lexicon.pushSend({
              userId: targetUserId,
              title: `@${fromUsername} mentioned you`,
              body: preview,
              url: 'https://voice.alex-dyakin.com',
              data: { type: 'mention', channelId, channelName, fromUsername },
            }).catch(() => {});
          }
        } catch (err) {
          console.error(`[Mentions] Failed to store notification for ${mentionedName}: ${err.message}`);
        }
      }
    }

    return mentions;
  }

  async _getNotifications(ws, client, msg) {
    try {
      const pool = this.deps.db;
      const limit = Math.min(parseInt(msg.limit, 10) || 50, 200);
      const [rows] = await pool.execute(
        `SELECT id, type AS notifType, from_username AS fromUsername,
                channel_id AS channelId, channel_name AS channelName,
                message_id AS messageId, message_preview AS messagePreview,
                is_read AS isRead, created_at AS createdAt
         FROM notifications
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ${limit}`,
        [client.userId]
      );

      const [unreadRow] = await pool.execute(
        'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = FALSE',
        [client.userId]
      );

      ws.send(JSON.stringify({
        type: 'notifications',
        notifications: rows,
        unreadCount: unreadRow[0].cnt,
      }));
    } catch (err) {
      console.error(`[Mentions] Failed to get notifications: ${err.message}`);
      ws.send(JSON.stringify({ type: 'notifications', notifications: [], unreadCount: 0 }));
    }
  }

  async _markRead(ws, client, msg) {
    try {
      const pool = this.deps.db;
      if (msg.notificationId) {
        // Mark single notification
        await pool.execute(
          'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
          [msg.notificationId, client.userId]
        );
      } else {
        // Mark all as read
        await pool.execute(
          'UPDATE notifications SET is_read = TRUE WHERE user_id = ? AND is_read = FALSE',
          [client.userId]
        );
      }
      ws.send(JSON.stringify({ type: 'notifications_updated', success: true }));
    } catch (err) {
      console.error(`[Mentions] Failed to mark read: ${err.message}`);
    }
  }

  cleanup() {
    // nothing to clean up
  }
}

const instance = new MentionsFeature();
module.exports = instance;
