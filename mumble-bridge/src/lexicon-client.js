const fetch = require('node-fetch');
const config = require('./config');

/**
 * Client for the Lexicon API.
 * Handles auth, media, playlists, and livestream endpoints.
 */
class LexiconClient {
  constructor() {
    this.baseUrl = config.lexicon.apiUrl;
    this.sessions = new Map(); // userId -> JSESSIONID cookie
  }

  /**
   * Login as the bridge service account (used for all API calls).
   * Called once on startup.
   */
  async loginAsService() {
    try {
      const result = await this.login('mumble-bridge', 'bridge-service-2026');
      this.serviceUserId = result.id || result.playerId;
      console.log(`[Lexicon] Bridge service logged in as user ID ${this.serviceUserId}`);
      return result;
    } catch (err) {
      console.error(`[Lexicon] Bridge service login failed: ${err.message}`);
      console.error('         Make sure the mumble-bridge user exists in Lexicon.');
      return null;
    }
  }

  /**
   * Authenticate a user against Lexicon and store their session.
   * @param {string} username
   * @param {string} password
   * @returns {object} Login response with user info
   */
  async login(username, password) {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Lexicon login failed: ${res.status} - ${err}`);
    }

    // Extract JSESSIONID from Set-Cookie header
    const cookies = res.headers.raw()['set-cookie'] || [];
    let sessionId = null;
    for (const cookie of cookies) {
      const match = cookie.match(/JSESSIONID=([^;]+)/);
      if (match) {
        sessionId = match[1];
        break;
      }
    }

    const data = await res.json();
    if (sessionId && data.id) {
      this.sessions.set(data.id, sessionId);
    }

    return data;
  }

  /**
   * Register a new user in Lexicon. No password needed for Mumble users —
   * we generate a random one since they auth via Mumble, not Lexicon directly.
   * @param {string} username
   * @returns {object} Registration response
   */
  async register(username) {
    const password = 'mumble_' + Math.random().toString(36).slice(2, 14);
    const res = await fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName: username }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Registration failed: ${res.status} - ${err}`);
    }

    return res.json();
  }

  /**
   * Look up a user by username. If they don't exist in Lexicon, auto-register them.
   * @param {string} username
   * @returns {object} Player object with id, username, displayName, etc.
   */
  async getOrCreateUser(username) {
    // Try to find existing user
    let player = await this.getPlayerByUsername(username);
    if (player) {
      console.log(`[Lexicon] Found existing user: ${username} (ID: ${player.id})`);
      return player;
    }

    // Not found — auto-register
    console.log(`[Lexicon] User '${username}' not in Lexicon, auto-registering...`);
    try {
      const regResult = await this.register(username);
      console.log(`[Lexicon] Registered new user: ${username} (ID: ${regResult.playerId})`);

      // Fetch the full player object
      player = await this.getPlayerByUsername(username);
      return player || { id: regResult.playerId, username, displayName: username };
    } catch (err) {
      console.error(`[Lexicon] Auto-register failed for '${username}': ${err.message}`);
      // Return a stub so the connection still works
      return { id: null, username, displayName: username };
    }
  }

  /**
   * Check if a session is still valid.
   * @param {number} userId
   * @returns {object|null} User info or null
   */
  async checkSession(userId) {
    const cookie = this.sessions.get(userId);
    if (!cookie) return null;

    try {
      const res = await fetch(`${this.baseUrl}/api/auth/me`, {
        headers: { Cookie: `JSESSIONID=${cookie}` },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────
  // Media endpoints (existing Lexicon API)
  // ──────────────────────────────────────

  async searchMedia(query) {
    const res = await fetch(`${this.baseUrl}/api/media/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return res.json();
  }

  async getMedia(mediaId) {
    const res = await fetch(`${this.baseUrl}/api/media/${mediaId}`);
    if (!res.ok) return null;
    return res.json();
  }

  async getPublicMedia() {
    const res = await fetch(`${this.baseUrl}/api/media/public`);
    if (!res.ok) return [];
    return res.json();
  }

  async getRecentMedia(limit = 10) {
    const res = await fetch(`${this.baseUrl}/api/media/recent?limit=${limit}`);
    if (!res.ok) return [];
    return res.json();
  }

  getStreamUrl(mediaId) {
    return `${this.baseUrl}/api/media/stream/${mediaId}`;
  }

  // ──────────────────────────────────────
  // Livestream / Music endpoints
  // ──────────────────────────────────────

  async getLivestreamState() {
    const res = await fetch(`${this.baseUrl}/api/livestream/state`);
    if (!res.ok) return null;
    return res.json();
  }

  async getLivestreamQueue() {
    const res = await fetch(`${this.baseUrl}/api/livestream/queue`);
    if (!res.ok) return null;
    return res.json();
  }

  async queueToLivestream(userId, mediaFileId) {
    const cookie = this.sessions.get(userId);
    const res = await fetch(`${this.baseUrl}/api/livestream/queue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: `JSESSIONID=${cookie}` } : {}),
      },
      body: JSON.stringify({ userId, mediaFileId }),
    });
    if (!res.ok) throw new Error('Failed to queue');
    return res.json();
  }

  async skipLivestream(userId) {
    const cookie = this.sessions.get(userId);
    const res = await fetch(`${this.baseUrl}/api/livestream/skip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: `JSESSIONID=${cookie}` } : {}),
      },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error('Failed to skip');
    return res.json();
  }

  // ──────────────────────────────────────
  // Playlist endpoints
  // ──────────────────────────────────────

  async getPublicPlaylists() {
    const res = await fetch(`${this.baseUrl}/api/playlists/public`);
    if (!res.ok) return [];
    return res.json();
  }

  async getPlaylist(playlistId) {
    const res = await fetch(`${this.baseUrl}/api/playlists/${playlistId}`);
    if (!res.ok) return null;
    return res.json();
  }

  // ──────────────────────────────────────
  // Player endpoints
  // ──────────────────────────────────────

  async getPlayers() {
    const res = await fetch(`${this.baseUrl}/api/players`);
    if (!res.ok) return [];
    return res.json();
  }

  async getPlayerByUsername(username) {
    const res = await fetch(`${this.baseUrl}/api/players/username/${encodeURIComponent(username)}`);
    if (!res.ok) return null;
    return res.json();
  }

  // ──────────────────────────────────────
  // Message endpoints (NEW — from Lexicon team)
  // ──────────────────────────────────────

  /**
   * Store a text message in Lexicon's HSQLDB.
   */
  async storeMessage({ channelId, channelName, userId, username, content, messageType = 'TEXT', mediaFileId = null }) {
    const res = await fetch(`${this.baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, channelName, userId, username, content, messageType, mediaFileId }),
    });
    if (!res.ok) {
      console.error(`[Lexicon] Failed to store message: ${res.status}`);
      return null;
    }
    return res.json();
  }

  /**
   * Get message history for a channel.
   */
  async getChannelMessages(channelId, limit = 50, before = null) {
    let url = `${this.baseUrl}/api/messages/channel/${channelId}?limit=${limit}`;
    if (before) url += `&before=${encodeURIComponent(before)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  }

  /**
   * Edit a message.
   */
  async editMessage(messageId, userId, newContent) {
    const res = await fetch(`${this.baseUrl}/api/messages/${messageId}?userId=${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Soft-delete a message.
   */
  async deleteMessage(messageId, userId) {
    const res = await fetch(`${this.baseUrl}/api/messages/${messageId}?userId=${userId}`, {
      method: 'DELETE',
    });
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Search messages.
   */
  async searchMessages(query, channelId = -1) {
    const res = await fetch(`${this.baseUrl}/api/messages/search?q=${encodeURIComponent(query)}&channelId=${channelId}`);
    if (!res.ok) return [];
    return res.json();
  }
}

module.exports = new LexiconClient();
