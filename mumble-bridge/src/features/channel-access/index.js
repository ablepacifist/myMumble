/**
 * Channel Access Feature — lets an admin restrict which WEB APP users can
 * see and use certain text channels. Most channels stay open to everyone;
 * a channel becomes restricted only once it has a row in
 * `restricted_channels`, and only the users listed in
 * `channel_access_grants` for it (plus admins, always) can see/use it.
 *
 * IMPORTANT SCOPE LIMIT: this only governs traffic that goes through this
 * bridge's WebSocket server (i.e. the web app). Native Mumble desktop
 * clients connect directly to the Mumble server and never touch this
 * code — they cannot be restricted by this feature. Mumble's own native
 * ACL/group system can't be used here either: web users all share one
 * bridge-bot Mumble session (Mumble itself can't tell them apart), and a
 * raw DB write into Mumble's acl/groups tables sits inert until
 * mumble-server restarts (murmurd only loads them once at boot). This is
 * an accepted, permanent limitation, not a bug to fix later.
 *
 * Message types:
 *   get_known_users     → admin-only, list of users for the access picker
 *   get_channel_access   → admin-only, current restricted/grant state for a channel
 *   set_channel_access   → admin-only, replace a channel's restricted/grant state
 */

const WebSocket = require('ws');

const DEFAULT_CHANNEL_ID = 0;

class ChannelAccessFeature {
  constructor() {
    this.name = 'channel-access';
    this.messageTypes = ['get_known_users', 'get_channel_access', 'set_channel_access'];
    this.deps = null;
    this.restrictedChannelIds = new Set();   // Set<number>
    this.grantsByChannel = new Map();        // Map<number, Set<number>>  channelId -> Set<lexiconUserId>
    this._mutationQueue = Promise.resolve(); // serializes set_channel_access calls
  }

  async init(deps) {
    this.deps = deps;

    await deps.db.execute(`
      CREATE TABLE IF NOT EXISTS restricted_channels (
        channel_id INT NOT NULL PRIMARY KEY,
        created_by VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await deps.db.execute(`
      CREATE TABLE IF NOT EXISTS channel_access_grants (
        channel_id INT NOT NULL,
        lexicon_user_id INT NOT NULL,
        granted_by VARCHAR(255) DEFAULT NULL,
        granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, lexicon_user_id),
        INDEX idx_user (lexicon_user_id)
      )
    `);

    const [restrictedRows] = await deps.db.execute('SELECT channel_id FROM restricted_channels');
    for (const row of restrictedRows) this.restrictedChannelIds.add(row.channel_id);

    const [grantRows] = await deps.db.execute('SELECT channel_id, lexicon_user_id FROM channel_access_grants');
    for (const row of grantRows) {
      if (!this.grantsByChannel.has(row.channel_id)) this.grantsByChannel.set(row.channel_id, new Set());
      this.grantsByChannel.get(row.channel_id).add(row.lexicon_user_id);
    }

    for (const channelId of this.restrictedChannelIds) {
      const ch = deps.channels.get(channelId);
      if (ch) ch.restricted = true;
    }

    console.log(`[ChannelAccess] Loaded ${this.restrictedChannelIds.size} restricted channel(s), ${grantRows.length} grant(s).`);
  }

  isRestricted(channelId) {
    return this.restrictedChannelIds.has(Number(channelId));
  }

  canAccess(channelId, userId, isAdmin) {
    if (isAdmin) return true;
    const id = Number(channelId);
    if (!this.restrictedChannelIds.has(id)) return true;
    if (userId == null) return false;
    return this.grantsByChannel.get(id)?.has(userId) || false;
  }

  filterVisibleChannels(channelList, userId, isAdmin) {
    return channelList.filter((ch) => this.canAccess(ch.id, userId, isAdmin));
  }

  /** Purge all restriction/grant state for a channel id (call on channel deletion). */
  async clearChannelAccess(channelId) {
    const id = Number(channelId);
    try {
      await this.deps.db.execute('DELETE FROM restricted_channels WHERE channel_id = ?', [id]);
      await this.deps.db.execute('DELETE FROM channel_access_grants WHERE channel_id = ?', [id]);
    } catch (err) {
      console.error(`[ChannelAccess] Cleanup failed for channel ${id}: ${err.message}`);
    }
    this.restrictedChannelIds.delete(id);
    this.grantsByChannel.delete(id);
  }

  handleMessage(ws, client, msg) {
    switch (msg.type) {
      case 'get_known_users':
        this._getKnownUsers(ws, client);
        break;
      case 'get_channel_access':
        this._getChannelAccess(ws, client, msg);
        break;
      case 'set_channel_access':
        this._setChannelAccess(ws, client, msg);
        break;
    }
  }

  _requireAdmin(ws, client) {
    if (!client.authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return false;
    }
    if (!client.isAdmin) {
      ws.send(JSON.stringify({ type: 'error', message: 'Only superusers can manage channel access' }));
      return false;
    }
    return true;
  }

  async _getKnownUsers(ws, client) {
    if (!this._requireAdmin(ws, client)) return;
    try {
      const [rows] = await this.deps.db.execute(
        'SELECT lexicon_user_id AS userId, lexicon_username AS username, display_name AS displayName FROM user_mapping ORDER BY display_name, lexicon_username'
      );
      ws.send(JSON.stringify({ type: 'known_users', users: rows }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'known_users', users: [], error: err.message }));
    }
  }

  _getChannelAccess(ws, client, msg) {
    if (!this._requireAdmin(ws, client)) return;
    const channelId = parseInt(msg.channelId, 10);
    if (!Number.isFinite(channelId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel id' }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'channel_access_state',
      channelId,
      restricted: this.isRestricted(channelId),
      userIds: Array.from(this.grantsByChannel.get(channelId) || []),
    }));
  }

  async _setChannelAccess(ws, client, msg) {
    if (!this._requireAdmin(ws, client)) return;

    const channelId = parseInt(msg.channelId, 10);
    if (!Number.isFinite(channelId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel id' }));
      return;
    }
    if (channelId === DEFAULT_CHANNEL_ID) {
      ws.send(JSON.stringify({ type: 'channel_access_result', channelId, success: false, error: 'Cannot restrict the default channel' }));
      return;
    }

    const restricted = !!msg.restricted;
    const userIds = Array.isArray(msg.userIds) ? msg.userIds.map((id) => parseInt(id, 10)).filter(Number.isFinite) : [];

    const run = async () => {
      const previouslyRestricted = this.isRestricted(channelId);
      const previousGrants = new Set(this.grantsByChannel.get(channelId) || []);

      try {
        if (restricted) {
          await this.deps.db.execute(
            'INSERT IGNORE INTO restricted_channels (channel_id, created_by) VALUES (?, ?)',
            [channelId, client.username || null]
          );
        } else {
          await this.deps.db.execute('DELETE FROM restricted_channels WHERE channel_id = ?', [channelId]);
        }

        await this.deps.db.execute('DELETE FROM channel_access_grants WHERE channel_id = ?', [channelId]);
        if (restricted && userIds.length > 0) {
          const values = userIds.map(() => '(?, ?, ?)').join(', ');
          const params = userIds.flatMap((uid) => [channelId, uid, client.username || null]);
          await this.deps.db.execute(
            `INSERT INTO channel_access_grants (channel_id, lexicon_user_id, granted_by) VALUES ${values}`,
            params
          );
        }
      } catch (err) {
        return { ok: false, error: `Database error: ${err.message}` };
      }

      if (restricted) {
        this.restrictedChannelIds.add(channelId);
        this.grantsByChannel.set(channelId, new Set(userIds));
      } else {
        this.restrictedChannelIds.delete(channelId);
        this.grantsByChannel.delete(channelId);
      }

      const ch = this.deps.channels.get(channelId);
      if (ch) {
        if (restricted) ch.restricted = true;
        else delete ch.restricted;
      }

      // Diff-broadcast: tell every connected client whether this channel just
      // became visible or hidden *for them specifically*, so grants/revokes
      // take effect immediately without a reconnect.
      if (ch) {
        for (const [cws, info] of this.deps.getClients()) {
          if (cws.readyState !== WebSocket.OPEN) continue;
          const hadAccess = info.isAdmin || !previouslyRestricted || (info.userId != null && previousGrants.has(info.userId));
          const hasAccess = this.canAccess(channelId, info.userId, info.isAdmin);
          if (hasAccess) {
            cws.send(JSON.stringify({ type: 'channel_update', channel: ch }));
          } else if (hadAccess) {
            cws.send(JSON.stringify({ type: 'channel_remove', channelId }));
          }
        }
      }

      return { ok: true };
    };

    const result = this._mutationQueue.then(run, run);
    this._mutationQueue = result.catch(() => {});
    const { ok, error } = await result;
    ws.send(JSON.stringify({ type: 'channel_access_result', channelId, success: ok, error: error || null }));
  }

  cleanup() {
    // nothing to clean up
  }
}

module.exports = new ChannelAccessFeature();
