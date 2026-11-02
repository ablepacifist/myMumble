/**
 * Shared security helpers for the bridge: HTML escaping, value validators, session tokens,
 * rate limits and the login throttle. Pure functions and small classes so they can be tested
 * without a database, a Mumble server or the network.
 */
'use strict';

const crypto = require('crypto');

// ── Escaping / validation ──────────────────────────────────

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const DEFAULT_AVATAR = '/uploads/avatars/default.jpg';
const AVATAR_URL = /^\/uploads\/avatars\/[A-Za-z0-9._-]{1,150}$/;
const CHAT_FILE_URL = /^\/api\/chat\/files\/\d{1,12}(\/thumb)?$/;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** An avatar URL we served ourselves, or the default. Anything else (javascript:, http://evil) is dropped. */
function safeAvatarUrl(url, fallback = DEFAULT_AVATAR) {
  return typeof url === 'string' && AVATAR_URL.test(url) && !url.includes('..') ? url : fallback;
}

/** A chat attachment URL on this server, or null. */
function safeChatFileUrl(url) {
  return typeof url === 'string' && CHAT_FILE_URL.test(url) ? url : null;
}

function safeImageType(type) {
  return typeof type === 'string' && IMAGE_TYPES.has(type.toLowerCase()) ? type.toLowerCase() : null;
}

/** File name for display: no path parts, no markup characters, no control characters, bounded length. */
function safeFilename(name) {
  const base = String(name == null ? '' : name).split(/[\\/]/).pop();
  return base.replace(/[\u0000-\u001f\u007f<>"'&`]/g, '').trim().slice(0, 120);
}

/** Positive integer or null (rejects floats, negatives, junk, 1e999). */
function toId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) return parseInt(value, 10);
  return null;
}

function clampInt(value, min, max, fallback) {
  const n = toId(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** What an image really is, from its first bytes (a client-declared Content-Type proves nothing). */
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const head = buf.slice(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Admin rule shared by the socket and HTTP sides. A *verified* login (Lexicon password or SSO) is admin when its
 * Lexicon login name is listed. The display name is user-editable and a typed name is unproven, so they do not
 * count, except for legacy name-only sessions while the NAME_ONLY_ADMIN transition switch is on.
 */
function isAdminIdentity({ loginName, displayName, strong }, { superUsers, nameOnlyAdmin }) {
  if (strong) return superUsers.includes(String(loginName || '').toLowerCase());
  return !!nameOnlyAdmin && superUsers.includes(String(displayName || '').toLowerCase());
}

// ── Secrets / headers ──────────────────────────────────────

function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

function bearerToken(req) {
  const header = (req.headers && req.headers.authorization) || '';
  const m = /^Bearer\s+([A-Za-z0-9_\-]{20,200})$/.exec(header);
  return m ? m[1] : null;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Real client address. The Cloudflare tunnel connects from loopback and passes the visitor in
 * CF-Connecting-IP / X-Forwarded-For; those headers are believed only when the TCP peer is loopback,
 * otherwise anyone could send them to dodge the limits.
 */
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (isLoopback(peer)) {
    const h = req.headers || {};
    const forwarded = h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return String(forwarded).slice(0, 64);
  }
  return peer || 'unknown';
}

// ── Origin policy ──────────────────────────────────────────

const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^capacitor:\/\/localhost$/,
  /^https:\/\/([a-z0-9-]+\.)?alex-dyakin\.com$/,
];

/**
 * An origin is acceptable if it is the site itself (Origin host equals the Host header, which is what a
 * browser sends for the normal page) or one of the known app/site origins. A request with no Origin
 * (non-browser clients) is allowed: browsers always send one, so this only blocks other websites.
 */
function originAllowed(origin, host) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.some((re) => re.test(origin))) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch (_) {
    return false;
  }
}

// ── Rate limiting ──────────────────────────────────────────

/** Sliding-window counter: at most `max` events per `windowMs` per key. */
class RateLimiter {
  constructor(max, windowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** @returns {{ok:boolean, retryAfterMs:number}} and records the event when allowed. */
  take(key) {
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true, retryAfterMs: 0 };
  }

  sweep() {
    const t = this.now();
    for (const [k, v] of this.hits) {
      if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/**
 * Failed-password throttle: the first few wrong passwords are free, then each further failure doubles the
 * wait (capped), so a real user who mistypes is never locked out but guessing is hopeless. Keyed by
 * address+username. A success clears the entry.
 */
class LoginThrottle {
  constructor({ freeAttempts = 5, baseMs = 5000, maxMs = 5 * 60 * 1000, forgetMs = 30 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { freeAttempts, baseMs, maxMs, forgetMs, now });
    this.entries = new Map();
  }

  /** @returns {{ok:boolean, retryAfterMs:number}} */
  check(key) {
    const e = this.entries.get(key);
    if (!e) return { ok: true, retryAfterMs: 0 };
    const t = this.now();
    if (t - e.last > this.forgetMs) {
      this.entries.delete(key);
      return { ok: true, retryAfterMs: 0 };
    }
    return t < e.blockedUntil ? { ok: false, retryAfterMs: e.blockedUntil - t } : { ok: true, retryAfterMs: 0 };
  }

  failure(key) {
    const t = this.now();
    const e = this.entries.get(key) || { fails: 0, blockedUntil: 0, last: t };
    e.fails += 1;
    e.last = t;
    if (e.fails > this.freeAttempts) {
      e.blockedUntil = t + Math.min(this.maxMs, this.baseMs * 2 ** (e.fails - this.freeAttempts - 1));
    }
    this.entries.set(key, e);
  }

  success(key) {
    this.entries.delete(key);
  }

  sweep() {
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.last > this.forgetMs) this.entries.delete(k);
  }
}

// ── Session tokens ─────────────────────────────────────────

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Opaque, random session tokens issued after a verified login. The browser keeps one and sends it on
 * HTTP calls (avatar, upload) and to resume after a reconnect. Only a SHA-256 of the token is stored
 * (in memory and, if a persistence adapter is given, in MySQL), so a database leak does not yield tokens.
 *
 * A record is { userId, loginName, displayName, strong, expiresAt }. `strong` is true when the identity
 * was proven (Lexicon password or SSO token), false for the legacy name-only login.
 */
class SessionStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxSessions = 20000, persistence = null, now = Date.now } = {}) {
    Object.assign(this, { ttlMs, maxSessions, persistence, now });
    this.sessions = new Map(); // hash -> record
  }

  async create(info) {
    const token = crypto.randomBytes(32).toString('base64url');
    const record = { ...info, expiresAt: this.now() + this.ttlMs };
    if (this.sessions.size >= this.maxSessions) this.sweep(true);
    this.sessions.set(sha256(token), record);
    if (this.persistence) {
      try { await this.persistence.save(sha256(token), record); } catch (_) { /* memory copy still works */ }
    }
    return token;
  }

  async get(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const hash = sha256(token);
    let record = this.sessions.get(hash);
    if (!record && this.persistence) {
      try { record = await this.persistence.load(hash); } catch (_) { record = null; }
      if (record) this.sessions.set(hash, record);
    }
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      await this.revokeHash(hash);
      return null;
    }
    return record;
  }

  async revoke(token) {
    if (typeof token === 'string') await this.revokeHash(sha256(token));
  }

  async revokeHash(hash) {
    this.sessions.delete(hash);
    if (this.persistence) {
      try { await this.persistence.remove(hash); } catch (_) { /* ignore */ }
    }
  }

  sweep(evictOldest = false) {
    const t = this.now();
    for (const [h, r] of this.sessions) if (r.expiresAt <= t) this.sessions.delete(h);
    if (evictOldest && this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
  }
}

module.exports = {
  escapeHtml,
  safeAvatarUrl,
  safeChatFileUrl,
  safeImageType,
  safeFilename,
  sniffImageType,
  isAdminIdentity,
  toId,
  clampInt,
  safeEqual,
  bearerToken,
  clientIp,
  isLoopback,
  originAllowed,
  ALLOWED_ORIGINS,
  DEFAULT_AVATAR,
  RateLimiter,
  LoginThrottle,
  SessionStore,
};
