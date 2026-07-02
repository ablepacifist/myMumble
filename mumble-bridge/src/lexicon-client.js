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
    this.requestTimeoutMs = 5000;
  }

  /**
   * Run a promise with a timeout so bridge auth can't hang forever.
   * @param {Promise<any>} promise
   * @param {string} label
   */
  async withTimeout(promise, label) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out after ${this.requestTimeoutMs}ms`)), this.requestTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
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
    const res = await this.withTimeout(fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }), 'Lexicon login');

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
    const res = await this.withTimeout(fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName: username }),
    }), 'Lexicon register');

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
    let player = null;
    try {
      player = await this.getPlayerByUsername(username);
    } catch (err) {
      console.error(`[Lexicon] Lookup failed for '${username}': ${err.message}`);
      console.warn('[Lexicon] Continuing with local-only user profile to avoid login hang');
      return { id: null, username, displayName: username };
    }
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
    const res = await this.withTimeout(
      fetch(`${this.baseUrl}/api/players/username/${encodeURIComponent(username)}`),
      'Lexicon player lookup'
    );
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

  // ──────────────────────────────────────
  // Chat file upload endpoints (images/GIFs)
  // ──────────────────────────────────────

  /**
   * Upload a chat image/GIF to Lexicon.
   * @param {Buffer} fileBuffer - The raw file data
   * @param {string} filename - Original filename
   * @param {string} mimeType - MIME type (image/png, image/gif, etc.)
   * @param {number} userId - Lexicon user ID
   * @param {number} channelId - Channel where file is being shared
   * @returns {object} Upload response with id, url, thumbnailUrl, dimensions
   */
  async uploadChatFile(fileBuffer, filename, mimeType, userId, channelId) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: mimeType });
    form.append('userId', String(userId));
    form.append('channelId', String(channelId));

    const res = await fetch(`${this.baseUrl}/api/chat/upload`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Chat file upload failed: ${res.status} - ${err}`);
    }
    return res.json();
  }

  /**
   * Get the full URL for a chat file.
   * @param {number} fileId
   * @returns {string}
   */
  getChatFileUrl(fileId) {
    return `${this.baseUrl}/api/chat/files/${fileId}`;
  }

  /**
   * Get the thumbnail URL for a chat file.
   * @param {number} fileId
   * @returns {string}
   */
  getChatFileThumbnailUrl(fileId) {
    return `${this.baseUrl}/api/chat/files/${fileId}/thumb`;
  }

  // ── Push Notifications ──

  /**
   * Get the VAPID public key from Lexicon.
   * @returns {Promise<string|null>}
   */
  async getVapidKey() {
    try {
      const res = await fetch(`${this.baseUrl}/api/push/vapid-key`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.publicKey || null;
    } catch (err) {
      console.error(`[Lexicon] getVapidKey failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Register a push subscription for a user.
   */
  async pushSubscribe({ userId, endpoint, keys, userAgent }) {
    try {
      const res = await fetch(`${this.baseUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, endpoint, keys, userAgent }),
      });
      return res.ok;
    } catch (err) {
      console.error(`[Lexicon] pushSubscribe failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Unregister a push subscription.
   */
  async pushUnsubscribe(endpoint) {
    try {
      const res = await fetch(`${this.baseUrl}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
      return res.ok;
    } catch (err) {
      console.error(`[Lexicon] pushUnsubscribe failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Send a push notification to a single user.
   */
  async pushSend({ userId, title, body, url, data }) {
    try {
      const res = await fetch(`${this.baseUrl}/api/push/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, title, body, url, data }),
      });
      if (!res.ok) return false;
      const result = await res.json();
      return result.success && result.sent > 0;
    } catch (err) {
      console.error(`[Lexicon] pushSend failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Send a push notification to multiple users.
   */
  async pushSendBulk({ userIds, title, body, url, data }) {
    try {
      const res = await fetch(`${this.baseUrl}/api/push/send-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds, title, body, url, data }),
      });
      if (!res.ok) return 0;
      const result = await res.json();
      return result.sent || 0;
    } catch (err) {
      console.error(`[Lexicon] pushSendBulk failed: ${err.message}`);
      return 0;
    }
  }

  // ── SSO Token Validation ──

  /**
   * Validate a one-time SSO token against Lexicon.
   * Token is consumed on validation (single-use, 60s expiry).
   * @param {string} token - The SSO token from Lexicon frontend
   * @returns {Promise<{valid: boolean, userId?: number, username?: string, displayName?: string}>}
   */
  async validateSsoToken(token) {
    try {
      const res = await this.withTimeout(fetch(`${this.baseUrl}/api/auth/sso/validate-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }), 'SSO validate-token');

      if (!res.ok) {
        const err = await res.text();
        console.warn(`[Lexicon] SSO token validation failed: ${res.status} - ${err}`);
        return { valid: false };
      }

      const data = await res.json();
      return data;
    } catch (err) {
      console.error(`[Lexicon] SSO token validation error: ${err.message}`);
      return { valid: false };
    }
  }
}

module.exports = new LexiconClient();
