/**
 * Direct Messages Feature
 *
 * Message types:
 *   dm_send              → send a DM to another user
 *   dm_history           → get message history for a DM conversation
 *   dm_conversations     → get list of all DM conversations for current user
 *   dm_open              → open/create a DM conversation with a user
 *
 * Broadcasts (to participants only):
 *   { type: 'dm_message', conversationId, ... }
 *   { type: 'dm_conversations_list', conversations: [...] }
 */

const lexicon = require('../../lexicon-client');

// DM channel IDs use negative numbers to avoid collision with Mumble channels
const DM_CHANNEL_OFFSET = -100000;

class DMsFeature {
  constructor() {
    this.name = 'dms';
    this.messageTypes = ['dm_send', 'dm_history', 'dm_conversations', 'dm_open', 'dm_mark_read'];
    this.deps = null;
  }

  async init(deps) {
    this.deps = deps;
    const pool = deps.db;

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS dm_conversations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user1_id INT NOT NULL,
        user2_id INT NOT NULL,
        user1_username VARCHAR(255) NOT NULL,
        user2_username VARCHAR(255) NOT NULL,
        last_message_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_pair (user1_id, user2_id),
        INDEX idx_user1 (user1_id),
        INDEX idx_user2 (user2_id)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS dm_unread (
        user_id INT NOT NULL,
        conversation_id BIGINT NOT NULL,
        unread_count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, conversation_id)
      )
    `);
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) return;

    switch (msg.type) {
      case 'dm_send':
        this._sendDM(ws, client, msg);
        break;
      case 'dm_history':
        this._getHistory(ws, client, msg);
        break;
      case 'dm_conversations':
        this._getConversations(ws, client, msg);
        break;
      case 'dm_open':
        this._openConversation(ws, client, msg);
        break;
      case 'dm_mark_read':
        this._markRead(ws, client, msg);
        break;
    }
  }

  /**
   * Send a DM. Creates conversation if it doesn't exist.
   */
  async _sendDM(ws, client, msg) {
    const { toUsername, content } = msg;
    if (!toUsername || !content || !content.trim()) {
      ws.send(JSON.stringify({ type: 'error', message: 'toUsername and content are required' }));
      return;
    }

    const text = content.trim().slice(0, 4000);

    try {
      // Find or create conversation
      const conv = await this._getOrCreateConversation(client.userId, client.username, toUsername);
      if (!conv) {
        ws.send(JSON.stringify({ type: 'error', message: 'Could not find user' }));
        return;
      }

      // Store message in Lexicon using a DM-specific channel ID
      const dmChannelId = DM_CHANNEL_OFFSET - conv.id;
      let msgId = null;
      try {
        const result = await lexicon.storeMessage({
          channelId: dmChannelId,
          channelName: `dm_${conv.id}`,
          userId: client.userId,
          username: client.username,
          content: text,
        });
        msgId = result?.messageId || null;
      } catch (err) {
        console.error(`[DMs] Lexicon store failed: ${err.message}`);
      }

      // Update last_message_at
      const pool = this.deps.db;
      await pool.execute(
        'UPDATE dm_conversations SET last_message_at = NOW() WHERE id = ?',
        [conv.id]
      );

      // Build message payload
      const dmMsg = {
        type: 'dm_message',
        conversationId: conv.id,
        id: msgId,
        fromUserId: client.userId,
        fromUsername: client.username,
        toUsername: conv.otherUsername,
        content: text,
        timestamp: new Date().toISOString(),
      };

      // Send to sender
      ws.send(JSON.stringify(dmMsg));

      // Send to recipient if online
      const recipientWs = this._findUserWs(conv.otherUsername);
      if (recipientWs) {
        recipientWs.send(JSON.stringify(dmMsg));
      }

      // Increment unread count for recipient
      try {
        await pool.execute(
          `INSERT INTO dm_unread (user_id, conversation_id, unread_count)
           VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE unread_count = unread_count + 1`,
          [conv.otherUserId, conv.id]
        );

        // Store a notification for the recipient (shows even if offline)
        await pool.execute(
          `INSERT INTO notifications (user_id, type, from_username, channel_id, channel_name, message_id, message_preview)
           VALUES (?, 'dm', ?, ?, ?, ?, ?)`,
          [conv.otherUserId, client.username, null, `DM`, msgId, text.length > 200 ? text.slice(0, 200) + '...' : text]
        );

        // Send unread update to recipient if online
        if (recipientWs && recipientWs.readyState === 1) {
          recipientWs.send(JSON.stringify({
            type: 'dm_unread_update',
            conversationId: conv.id,
            fromUsername: client.username,
            unreadCount: await this._getUnreadCount(conv.otherUserId, conv.id),
          }));
        }

        // Push notification to offline recipient
        if (!recipientWs) {
          lexicon.pushSend({
            userId: conv.otherUserId,
            title: `DM from ${client.username}`,
            body: text.length > 100 ? text.slice(0, 100) + '...' : text,
            url: 'https://voice.alex-dyakin.com',
            data: { type: 'dm', conversationId: conv.id, fromUsername: client.username },
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[DMs] Unread tracking failed: ${err.message}`);
      }
    } catch (err) {
      console.error(`[DMs] Send failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to send DM' }));
    }
  }

  /**
   * Get DM history for a conversation.
   */
  async _getHistory(ws, client, msg) {
    const { conversationId, limit, before } = msg;
    if (!conversationId) return;

    try {
      // Verify user is part of this conversation
      const pool = this.deps.db;
      const [convRows] = await pool.execute(
        'SELECT * FROM dm_conversations WHERE id = ? AND (user1_id = ? OR user2_id = ?)',
        [conversationId, client.userId, client.userId]
      );
      if (convRows.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Conversation not found' }));
        return;
      }

      // Fetch from Lexicon using the DM channel ID
      const dmChannelId = DM_CHANNEL_OFFSET - conversationId;
      const messages = await lexicon.getChannelMessages(dmChannelId, limit || 50, before || null);

      ws.send(JSON.stringify({
        type: 'dm_history',
        conversationId,
        messages: messages.map(m => ({
          id: m.id,
          fromUsername: m.username,
          fromUserId: m.userId,
          content: m.content,
          timestamp: m.createdAt,
          messageType: m.messageType,
          attachment: m.attachment || null,
        })),
      }));

      // Auto-clear unread when user loads history (they're reading the conversation)
      await pool.execute(
        'DELETE FROM dm_unread WHERE user_id = ? AND conversation_id = ?',
        [client.userId, conversationId]
      ).catch(() => {});
    } catch (err) {
      console.error(`[DMs] History failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'dm_history', conversationId, messages: [] }));
    }
  }

  /**
   * Get all DM conversations for the current user.
   */
  async _getConversations(ws, client, msg) {
    try {
      const pool = this.deps.db;
      const [rows] = await pool.execute(
        `SELECT id, user1_id, user2_id, user1_username, user2_username, last_message_at, created_at
         FROM dm_conversations
         WHERE user1_id = ? OR user2_id = ?
         ORDER BY COALESCE(last_message_at, created_at) DESC`,
        [client.userId, client.userId]
      );

      const conversations = rows.map(r => ({
        id: r.id,
        otherUsername: r.user1_id === client.userId ? r.user2_username : r.user1_username,
        otherUserId: r.user1_id === client.userId ? r.user2_id : r.user1_id,
        lastMessageAt: r.last_message_at,
        createdAt: r.created_at,
      }));

      ws.send(JSON.stringify({
        type: 'dm_conversations_list',
        conversations,
      }));
    } catch (err) {
      console.error(`[DMs] Get conversations failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'dm_conversations_list', conversations: [] }));
    }
  }

  /**
   * Open/create a DM conversation with a user.
   */
  async _openConversation(ws, client, msg) {
    const { username: targetUsername } = msg;
    if (!targetUsername) {
      ws.send(JSON.stringify({ type: 'error', message: 'username is required' }));
      return;
    }

    if (targetUsername.toLowerCase() === client.username.toLowerCase()) {
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot DM yourself' }));
      return;
    }

    try {
      const conv = await this._getOrCreateConversation(client.userId, client.username, targetUsername);
      if (!conv) {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
        return;
      }

      ws.send(JSON.stringify({
        type: 'dm_opened',
        conversationId: conv.id,
        otherUsername: conv.otherUsername,
        otherUserId: conv.otherUserId,
      }));
    } catch (err) {
      console.error(`[DMs] Open conversation failed: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to open DM' }));
    }
  }

  /**
   * Find or create a DM conversation between two users.
   * Always stores user1 as the lower ID for consistency.
   */
  async _getOrCreateConversation(fromUserId, fromUsername, toUsername) {
    const pool = this.deps.db;

    // Look up the target user's ID from connected clients or user_profiles
    let toUserId = null;

    // Check connected clients first
    const clients = this.deps.getClients();
    for (const [, info] of clients) {
      if (info.authenticated && info.username && info.username.toLowerCase() === toUsername.toLowerCase()) {
        toUserId = info.userId;
        break;
      }
    }

    // Fallback: check user_profiles table
    if (!toUserId) {
      const [profileRows] = await pool.execute(
        'SELECT lexicon_user_id FROM user_profiles WHERE LOWER(username) = LOWER(?)',
        [toUsername]
      );
      if (profileRows.length > 0 && profileRows[0].lexicon_user_id) {
        toUserId = profileRows[0].lexicon_user_id;
      }
    }

    // Fallback: check user_mapping table
    if (!toUserId) {
      const [mapRows] = await pool.execute(
        'SELECT lexicon_user_id FROM user_mapping WHERE LOWER(lexicon_username) = LOWER(?)',
        [toUsername]
      );
      if (mapRows.length > 0) {
        toUserId = mapRows[0].lexicon_user_id;
      }
    }

    if (!toUserId) return null;

    // Normalize: lower ID is always user1
    const [u1Id, u2Id] = fromUserId < toUserId ? [fromUserId, toUserId] : [toUserId, fromUserId];
    const [u1Name, u2Name] = fromUserId < toUserId ? [fromUsername, toUsername] : [toUsername, fromUsername];

    // Try to find existing conversation
    const [existing] = await pool.execute(
      'SELECT * FROM dm_conversations WHERE user1_id = ? AND user2_id = ?',
      [u1Id, u2Id]
    );

    if (existing.length > 0) {
      const conv = existing[0];
      return {
        id: conv.id,
        otherUsername: conv.user1_id === fromUserId ? conv.user2_username : conv.user1_username,
        otherUserId: conv.user1_id === fromUserId ? conv.user2_id : conv.user1_id,
      };
    }

    // Create new conversation
    const [result] = await pool.execute(
      'INSERT INTO dm_conversations (user1_id, user2_id, user1_username, user2_username) VALUES (?, ?, ?, ?)',
      [u1Id, u2Id, u1Name, u2Name]
    );

    return {
      id: result.insertId,
      otherUsername: toUsername,
      otherUserId: toUserId,
    };
  }

  /**
   * Find a connected user's WebSocket by username.
   */
  _findUserWs(username) {
    const clients = this.deps.getClients();
    for (const [ws, info] of clients) {
      if (info.authenticated && info.username && info.username.toLowerCase() === username.toLowerCase()) {
        if (ws.readyState === 1) return ws;
      }
    }
    return null;
  }

  async _getUnreadCount(userId, conversationId) {
    try {
      const pool = this.deps.db;
      const [rows] = await pool.execute(
        'SELECT unread_count FROM dm_unread WHERE user_id = ? AND conversation_id = ?',
        [userId, conversationId]
      );
      return rows.length > 0 ? rows[0].unread_count : 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Mark a DM conversation as read — resets unread count.
   */
  async _markRead(ws, client, msg) {
    const { conversationId } = msg;
    if (!conversationId) return;
    try {
      const pool = this.deps.db;
      await pool.execute(
        'DELETE FROM dm_unread WHERE user_id = ? AND conversation_id = ?',
        [client.userId, conversationId]
      );
      ws.send(JSON.stringify({ type: 'dm_mark_read_ok', conversationId }));
    } catch (err) {
      console.error(`[DMs] Mark read failed: ${err.message}`);
    }
  }

  /**
   * Get all unread DM counts for a user (sent on connect).
   */
  async getUnreadCounts(userId) {
    try {
      const pool = this.deps.db;
      const [rows] = await pool.execute(
        'SELECT conversation_id AS conversationId, unread_count AS unreadCount FROM dm_unread WHERE user_id = ? AND unread_count > 0',
        [userId]
      );
      return rows;
    } catch (_) {
      return [];
    }
  }

  cleanup() {}
}

// Export as singleton instance
const instance = new DMsFeature();
module.exports = instance;
