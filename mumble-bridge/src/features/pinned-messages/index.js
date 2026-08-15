/**
 * Pinned Messages Feature — admin-only pin/unpin of chat messages.
 *
 * Lexicon's message API exposes an `isPinned` field on every message but
 * has no way to actually set it (confirmed empirically: its edit endpoint
 * silently ignores `isPinned`, and no dedicated pin endpoint exists). So
 * pins are tracked entirely bridge-local, as a content SNAPSHOT taken at
 * pin time — there's no Lexicon "get message by id" endpoint either, so
 * the bridge can't independently re-fetch a message to snapshot it later;
 * the pinning admin's client already has the message rendered and supplies
 * the snapshot. This is scoped safely because only an admin can pin at
 * all — the trust boundary is "an admin choosing what their own pin
 * displays," not arbitrary user input.
 *
 * A useful side effect of snapshotting: a pin keeps displaying correctly
 * even if the original message is later deleted from Lexicon — only
 * "jump to original" degrades (falls through jump_to_message's existing
 * not-found path).
 *
 * Message types:
 *   pin_message         → admin-only, pin a message (client supplies snapshot)
 *   unpin_message        → admin-only
 *   get_pinned_messages  → authenticated-only (viewing pins isn't an admin action)
 */

class PinnedMessagesFeature {
  constructor() {
    this.name = 'pinned-messages';
    this.messageTypes = ['pin_message', 'unpin_message', 'get_pinned_messages'];
    this.deps = null;
  }

  async init(deps) {
    this.deps = deps;
    await deps.db.execute(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        channel_id INT NOT NULL,
        message_id BIGINT NOT NULL,
        username VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(20) DEFAULT 'TEXT',
        attachment_json TEXT NULL,
        pinned_by VARCHAR(255) NOT NULL,
        pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_channel_message (channel_id, message_id),
        INDEX idx_channel_pinned (channel_id, pinned_at)
      )
    `);
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }
    switch (msg.type) {
      case 'pin_message':
        this._pin(ws, client, msg);
        break;
      case 'unpin_message':
        this._unpin(ws, client, msg);
        break;
      case 'get_pinned_messages':
        this._list(ws, client, msg);
        break;
    }
  }

  _requireAdmin(ws, client) {
    if (!client.isAdmin) {
      ws.send(JSON.stringify({ type: 'error', message: 'Only superusers can pin messages' }));
      return false;
    }
    return true;
  }

  _canAccess(channelId, client) {
    const accessFeature = require('../../feature-registry').features?.get('channel-access');
    return !accessFeature || accessFeature.canAccess(channelId, client.userId, client.isAdmin);
  }

  async _pin(ws, client, msg) {
    if (!this._requireAdmin(ws, client)) return;
    const { channelId, messageId, username, content, messageType, attachment } = msg;
    if (!channelId && channelId !== 0) {
      ws.send(JSON.stringify({ type: 'error', message: 'channelId is required' }));
      return;
    }
    if (!messageId || !content) {
      ws.send(JSON.stringify({ type: 'error', message: 'messageId and content are required' }));
      return;
    }
    if (!this._canAccess(channelId, client)) {
      ws.send(JSON.stringify({ type: 'error', message: 'You do not have access to this channel' }));
      return;
    }
    const safeContent = String(content).slice(0, 4000);
    try {
      await this.deps.db.execute(
        `INSERT IGNORE INTO pinned_messages (channel_id, message_id, username, content, message_type, attachment_json, pinned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [channelId, messageId, username || 'Unknown', safeContent, messageType || 'TEXT', attachment ? JSON.stringify(attachment) : null, client.username]
      );
      const [rows] = await this.deps.db.execute('SELECT * FROM pinned_messages WHERE channel_id = ? AND message_id = ?', [channelId, messageId]);
      const pin = rows[0] && this._rowToPin(rows[0]);
      if (pin) this.deps.broadcastToChannel(channelId, { type: 'pin_added', channelId, pin });
      ws.send(JSON.stringify({ type: 'pin_result', channelId, messageId, success: true }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'pin_result', channelId, messageId, success: false, error: err.message }));
    }
  }

  async _unpin(ws, client, msg) {
    if (!this._requireAdmin(ws, client)) return;
    const { channelId, messageId } = msg;
    if ((!channelId && channelId !== 0) || !messageId) {
      ws.send(JSON.stringify({ type: 'error', message: 'channelId and messageId are required' }));
      return;
    }
    try {
      await this.deps.db.execute('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?', [channelId, messageId]);
      this.deps.broadcastToChannel(channelId, { type: 'pin_removed', channelId, messageId });
      ws.send(JSON.stringify({ type: 'pin_result', channelId, messageId, success: true }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'pin_result', channelId, messageId, success: false, error: err.message }));
    }
  }

  async _list(ws, client, msg) {
    const channelId = msg.channelId || 0;
    if (!this._canAccess(channelId, client)) {
      ws.send(JSON.stringify({ type: 'pinned_messages', channelId, pins: [] }));
      return;
    }
    const [rows] = await this.deps.db.execute('SELECT * FROM pinned_messages WHERE channel_id = ? ORDER BY pinned_at DESC', [channelId]);
    ws.send(JSON.stringify({ type: 'pinned_messages', channelId, pins: rows.map((r) => this._rowToPin(r)) }));
  }

  _rowToPin(r) {
    return {
      id: r.id,
      channelId: r.channel_id,
      messageId: String(r.message_id),
      username: r.username,
      content: r.content,
      messageType: r.message_type,
      attachment: r.attachment_json ? JSON.parse(r.attachment_json) : null,
      pinnedBy: r.pinned_by,
      pinnedAt: r.pinned_at,
    };
  }

  /** Merge a real `isPinned` flag into a list of Lexicon message rows (used by get_history/jump_to_message). */
  async attachPinInfo(messages) {
    const ids = messages.map((m) => m.id).filter((id) => id != null);
    if (ids.length === 0) return messages;
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await this.deps.db.execute(
      `SELECT message_id FROM pinned_messages WHERE message_id IN (${placeholders})`,
      ids
    );
    const pinnedSet = new Set(rows.map((r) => String(r.message_id)));
    return messages.map((m) => ({ ...m, isPinned: pinnedSet.has(String(m.id)) }));
  }

  /** Purge all pins for a channel (call when the channel itself is deleted). */
  async deleteChannel(channelId) {
    await this.deps.db.execute('DELETE FROM pinned_messages WHERE channel_id = ?', [channelId]);
  }

  cleanup() {
    // nothing to clean up
  }
}

module.exports = new PinnedMessagesFeature();
