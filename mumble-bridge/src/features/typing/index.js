/**
 * Typing Indicator Feature — broadcasts typing status to channel members.
 * 
 * Message types:
 *   typing_start → client is typing in a channel
 *   typing_stop  → client stopped typing (optional, auto-expires)
 * 
 * Broadcasts to other channel members:
 *   { type: 'typing', username, channelId, typing: true/false }
 * 
 * Rules:
 *   - Throttle: max 1 event per user per 3 seconds
 *   - Auto-expire: typing status expires after 8 seconds (no new events)
 *   - Don't send typing back to the typer
 */

class TypingFeature {
  constructor() {
    this.name = 'typing';
    this.messageTypes = ['typing_start', 'typing_stop'];

    // Track active typers: Map<`${username}:${channelId}` -> { timeout, lastBroadcast }>
    this.activeTypers = new Map();
    this.THROTTLE_MS = 3000;
    this.EXPIRE_MS = 8000;
    this.deps = null;
  }

  init(deps) {
    this.deps = deps;
  }

  handleMessage(ws, client, msg) {
    if (!client.authenticated) return;

    const channelId = msg.channelId ?? client.channelId ?? 0;
    const key = `${client.username}:${channelId}`;

    if (msg.type === 'typing_start') {
      this._handleTypingStart(ws, client, channelId, key);
    } else if (msg.type === 'typing_stop') {
      this._handleTypingStop(ws, client, channelId, key);
    }
  }

  _handleTypingStart(ws, client, channelId, key) {
    const now = Date.now();
    const existing = this.activeTypers.get(key);

    // Throttle: don't broadcast more than once per THROTTLE_MS
    if (existing && (now - existing.lastBroadcast) < this.THROTTLE_MS) {
      // Just reset the expiry timer
      clearTimeout(existing.timeout);
      existing.timeout = setTimeout(() => this._expire(ws, client, channelId, key), this.EXPIRE_MS);
      return;
    }

    // Clear previous timeout if exists
    if (existing) {
      clearTimeout(existing.timeout);
    }

    // Broadcast typing to channel (excluding sender)
    this.deps.broadcastToChannel(channelId, {
      type: 'typing',
      username: client.username,
      userId: client.userId,
      channelId,
      typing: true,
    }, ws);

    // Set expiry timeout
    const timeout = setTimeout(() => this._expire(ws, client, channelId, key), this.EXPIRE_MS);

    this.activeTypers.set(key, { timeout, lastBroadcast: now });
  }

  _handleTypingStop(ws, client, channelId, key) {
    const existing = this.activeTypers.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
      this.activeTypers.delete(key);
    }

    // Broadcast stop
    this.deps.broadcastToChannel(channelId, {
      type: 'typing',
      username: client.username,
      userId: client.userId,
      channelId,
      typing: false,
    }, ws);
  }

  _expire(ws, client, channelId, key) {
    this.activeTypers.delete(key);

    // Broadcast typing stopped (auto-expire)
    this.deps.broadcastToChannel(channelId, {
      type: 'typing',
      username: client.username,
      userId: client.userId,
      channelId,
      typing: false,
    }, ws);
  }

  cleanup() {
    // Clear all timers
    for (const [, entry] of this.activeTypers) {
      clearTimeout(entry.timeout);
    }
    this.activeTypers.clear();
  }
}

module.exports = new TypingFeature();
