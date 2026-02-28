/**
 * LexiconClient — HTTP client for the Lexicon API.
 *
 * Handles user registration/lookup, message persistence, and avatar fetching.
 * Used by the main process to interact with the Lexicon backend.
 */
const http = require('http');
const https = require('https');

class LexiconClient {
  /**
   * @param {string} baseUrl — e.g. 'http://147.185.221.24:15856'
   */
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
  }

  /**
   * Look up a user by username. Auto-registers if not found.
   * @param {string} username
   * @returns {Promise<{id: number|null, username: string, displayName: string}>}
   */
  async getOrCreateUser(username) {
    try {
      let player = await this._get(`/api/players/username/${encodeURIComponent(username)}`);
      if (player) return player;
    } catch (_) {}

    // Not found → auto-register
    try {
      const password = 'mumble_' + Math.random().toString(36).slice(2, 14);
      const regResult = await this._post('/api/auth/register', {
        username,
        password,
        displayName: username,
      });

      // Re-fetch full player object
      try {
        const player = await this._get(`/api/players/username/${encodeURIComponent(username)}`);
        if (player) return player;
      } catch (_) {}

      return { id: regResult?.playerId || null, username, displayName: username };
    } catch (err) {
      console.error(`[Lexicon] Auto-register failed for '${username}': ${err.message}`);
      return { id: null, username, displayName: username };
    }
  }

  /**
   * Store a text message.
   */
  async storeMessage({ channelId, channelName, userId, username, content }) {
    try {
      return await this._post('/api/messages', {
        channelId,
        channelName,
        userId,
        username,
        content,
        messageType: 'TEXT',
      });
    } catch (err) {
      console.error(`[Lexicon] Store message failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get message history for a channel.
   * @param {number} channelId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getChannelMessages(channelId, limit = 50) {
    try {
      const result = await this._get(
        `/api/messages/channel/${channelId}?limit=${limit}`,
      );
      return Array.isArray(result) ? result : [];
    } catch (_) {
      return [];
    }
  }

  // ── Internal HTTP helpers ──

  _get(path) {
    return this._request('GET', path);
  }

  _post(path, body) {
    return this._request('POST', path, body);
  }

  _request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + urlPath);
      const mod = url.protocol === 'https:' ? https : http;
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {},
        timeout: 8000,
      };

      if (body) {
        const json = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(json);
      }

      const req = mod.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (_) {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

module.exports = LexiconClient;
