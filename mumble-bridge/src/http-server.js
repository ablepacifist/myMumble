/**
 * HTTP static file server + Avatar API + Diagnostics API.
 * Serves the public/ directory with cache busting.
 *
 * Who may do what:
 *   open      static files, GET /api/avatar/:name, GET /api/chat/files/:id (images are loaded by <img> tags,
 *             which cannot send a token), GET /api/push/vapid-key (a public key)
 *   signed in avatar upload/remove and chat image upload, always as the signed-in user
 *             (identity comes from the session token, never from the form)
 *   admin     /api/diag/*  (admin session, or the optional DIAG_TOKEN for command-line tools)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const sec = require('./security');
const { getAvatarPath, setAvatarPath, removeAvatarPath } = require('./database');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const BUILD_VERSION = Date.now().toString(36);

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_CHAT_FILE_SIZE = 8 * 1024 * 1024; // 8MB
const MULTIPART_OVERHEAD = 16 * 1024; // form fields and boundaries around the file
const AVATAR_DIR_NAME = 'uploads/avatars';
const EXT_FOR_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

// Image uploads are small and rare for a person; this stops a stolen session from filling the disk.
const uploadLimiter = new sec.RateLimiter(20, 60 * 1000);

/** Content-Security-Policy for the web client (see CSP_MODE). Scripts only from this server. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const mode = config.security.cspMode;
  if (mode === 'enforce') res.setHeader('Content-Security-Policy', CSP);
  else if (mode !== 'off') res.setHeader('Content-Security-Policy-Report-Only', CSP);
  // HTTPS-only hint, sent when the request really came over HTTPS (through the Cloudflare tunnel)
  if (sec.isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read a request body, giving up (413) as soon as it grows past maxBytes. Resolves to a Buffer, or null if too big. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The plain text fields of a parsed multipart body (everything that is not a file). */
function formFields(parts) {
  const fields = {};
  for (const p of parts) if (p.name && !p.filename && p.data) fields[p.name] = p.data.toString('utf8').trim();
  return fields;
}

/** Multipart parts of a request, or null after answering 4xx. */
async function readMultipart(req, res, maxFileBytes) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/);
  if (!contentType.includes('multipart/form-data') || !boundaryMatch) {
    sendJson(res, 400, { error: 'Expected multipart/form-data' });
    return null;
  }
  const body = await readBody(req, maxFileBytes + MULTIPART_OVERHEAD);
  if (!body) {
    sendJson(res, 413, { error: 'File too large' });
    return null;
  }
  return parseMultipart(body, '--' + boundaryMatch[1].replace(/^"|"$/g, ''));
}

/**
 * Create an HTTP server that serves static files from publicDir.
 * Also handles /api/avatar/* routes for profile pictures.
 * @param {string} publicDir - Absolute path to the public/ directory
 * @param {{sessions: import('./security').SessionStore}} deps
 * @returns {http.Server}
 */
function createHttpServer(publicDir, { sessions } = {}) {
  const root = path.resolve(publicDir);
  const avatarDir = path.join(root, AVATAR_DIR_NAME);
  fs.mkdirSync(avatarDir, { recursive: true });

  /**
   * Who is calling. Returns { record } for a valid session token, { service: true } for Lexicon (see below),
   * { legacy: true } for a request with no token while ALLOW_LEGACY_APP_UPLOADS is on (the caller then names itself in
   * the form, as the old Android app does), or null after answering 401. A request that does send a token is always
   * held to it.
   *
   * Lexicon's avatar proxy has already checked who the player is, so on the avatar routes (allowService) it may prove
   * itself with the shared X-Service-Token and name the player in the form. The token is the same secret the bridge
   * sends to Lexicon; it is never accepted on the chat-upload or diagnostics routes.
   */
  async function authorise(req, res, { allowService = false } = {}) {
    const offered = req.headers['x-service-token'];
    if (offered !== undefined) {
      const expected = config.lexicon.serviceToken;
      if (allowService && expected && typeof offered === 'string' && sec.safeEqual(offered, expected)) {
        return { service: true };
      }
      sendJson(res, 401, { error: 'Sign in required' });
      return null;
    }
    if (req.headers.authorization) {
      const token = sec.bearerToken(req);
      const record = token && sessions ? await sessions.get(token) : null;
      if (record) return { record };
    } else if (config.security.allowLegacyAppUploads) {
      return { legacy: true };
    }
    sendJson(res, 401, { error: 'Sign in required' });
    return null;
  }

  /** The identity to act as: the session, or (Lexicon proxy / legacy app) the name and id in the form. Answers 401 if neither. */
  function identity(auth, fields, res) {
    if (auth.record) return auth.record;
    const name = typeof fields.username === 'string' ? fields.username.trim() : '';
    if (!name || name.length > 64) {
      sendJson(res, 401, { error: 'Sign in required' });
      return null;
    }
    return { userId: sec.toId(fields.userId), loginName: name, displayName: name, strong: false, legacy: true };
  }

  /** Admin session or the DIAG_TOKEN; answers 401/403 and returns false otherwise. */
  async function requireDiagAccess(req, res) {
    const token = sec.bearerToken(req);
    if (!token) { sendJson(res, 401, { error: 'Sign in required' }); return false; }
    if (config.security.diagToken && sec.safeEqual(token, config.security.diagToken)) return true;
    const record = sessions ? await sessions.get(token) : null;
    if (!record) { sendJson(res, 401, { error: 'Sign in required' }); return false; }
    if (!sec.isAdminIdentity(record, { superUsers: config.superUsers, nameOnlyAdmin: config.security.nameOnlyAdmin })) {
      sendJson(res, 403, { error: 'Admin only' });
      return false;
    }
    return true;
  }

  async function handle(req, res) {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    securityHeaders(req, res);

    // ── CORS ───────────────────────────────────
    // The Android app bundles this client and serves it from the WebView's own
    // local origin, so its calls here are cross-origin. Browsers hitting the
    // real site are same-origin and unaffected by any of this.
    const origin = req.headers.origin;
    if (origin && sec.ALLOWED_ORIGINS.some((allowed) => allowed.test(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // ── API Routes ─────────────────────────────
    // GET /api/avatar/:username
    if (req.method === 'GET' && urlPath.startsWith('/api/avatar/')) {
      const username = urlPath.slice('/api/avatar/'.length);
      try {
        const avatarPath = await getAvatarPath(username);
        sendJson(res, 200, { avatarUrl: sec.safeAvatarUrl(avatarPath) });
      } catch (e) {
        console.error('[Avatar] GET error:', e.message);
        sendJson(res, 500, { error: 'Internal error' });
      }
      return;
    }

    // POST /api/avatar/upload  (multipart/form-data) — always for the signed-in user
    if (req.method === 'POST' && urlPath === '/api/avatar/upload') {
      const auth = await authorise(req, res, { allowService: true });
      if (!auth) return;
      await handleAvatarUpload(req, res, auth, identity, avatarDir);
      return;
    }

    // POST /api/avatar/remove — always for the signed-in user
    if (req.method === 'POST' && urlPath === '/api/avatar/remove') {
      const auth = await authorise(req, res, { allowService: true });
      if (!auth) return;
      try {
        let fields = {};
        if (!auth.record) {
          const body = await readBody(req, 4096);
          try { fields = JSON.parse((body || Buffer.alloc(0)).toString('utf8') || '{}') || {}; } catch (_) { fields = {}; }
        }
        const who = identity(auth, fields, res);
        if (!who) return;
        await removeAvatarPath(who.displayName);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        console.error('[Avatar] Remove error:', e.message);
        sendJson(res, 500, { error: 'Remove failed' });
      }
      return;
    }

    // ── Chat File Upload (proxy to Lexicon) ───────────────
    // POST /api/chat/upload — Upload an image/GIF for chat, as the signed-in user
    if (req.method === 'POST' && urlPath === '/api/chat/upload') {
      const auth = await authorise(req, res);
      if (!auth) return;
      await handleChatFileUpload(req, res, auth, identity);
      return;
    }

    // GET /api/chat/files/:id — Proxy file from Lexicon
    if (req.method === 'GET' && urlPath.match(/^\/api\/chat\/files\/\d+(\/thumb)?$/)) {
      await proxyChatFile(req, res, urlPath);
      return;
    }

    // ── Diagnostics API (admin only) ─────────
    if (req.method === 'GET' && (urlPath.startsWith('/api/diag/logs') || urlPath === '/api/diag/summary' || urlPath === '/api/diag/files')) {
      if (!(await requireDiagAccess(req, res))) return;
      try {
        const VoiceBridge = require('./voice-bridge');
        const voiceDiag = VoiceBridge.voiceBridgeInstance?.diag;
        if (!voiceDiag) {
          sendJson(res, 503, { error: 'Voice bridge not initialized' });
          return;
        }
        if (urlPath.startsWith('/api/diag/logs')) {
          const lines = sec.clampInt(new URL(req.url, 'http://x').searchParams.get('lines'), 1, 5000, 500);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(voiceDiag.getTailLogs(lines));
        } else if (urlPath === '/api/diag/summary') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(voiceDiag.exportSummary(), null, 2));
        } else {
          sendJson(res, 200, { files: voiceDiag.listLogFiles() });
        }
      } catch (e) {
        console.error('[Diag API] Error:', e.message);
        sendJson(res, 500, { error: 'Internal error' });
      }
      return;
    }

    // GET /api/push/vapid-key — proxy to Lexicon
    if (req.method === 'GET' && urlPath === '/api/push/vapid-key') {
      try {
        const lexicon = require('./lexicon-client');
        const key = await lexicon.getVapidKey();
        sendJson(res, 200, { publicKey: key });
      } catch (e) {
        console.error('[Push] vapid-key error:', e.message);
        sendJson(res, 500, { error: 'Internal error' });
      }
      return;
    }

    // ── Static file serving ───────────────────
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let staticPath = urlPath;
    if (staticPath === '/') staticPath = '/index.html';

    // Resolve inside the public folder (compared by relative path, so a sibling like "public-old" cannot match),
    // and never serve dot-files such as .env or .git
    const filePath = path.resolve(root, '.' + path.normalize('/' + staticPath));
    const rel = path.relative(root, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
          return;
        }

        if (ext === '.html') {
          const html = data.toString('utf8').replace(/\.(css|js)(\?v=[^"']*)?"/g, `.$1?v=${BUILD_VERSION}"`);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(html);
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          res.end(data);
        }
      });
    });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[HTTP] Unhandled error:', e && e.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    });
  });
}

module.exports = { createHttpServer, parseMultipart, CSP };

// ── Avatar Upload Handler ────────
async function handleAvatarUpload(req, res, auth, identity, avatarDir) {
  const parts = await readMultipart(req, res, MAX_AVATAR_SIZE);
  if (!parts) return;
  try {
    const session = identity(auth, formFields(parts), res);
    if (!session) return;
    if (!uploadLimiter.take(`avatar:${session.loginName}`).ok) {
      sendJson(res, 429, { error: 'Too many uploads. Try again in a minute.' });
      return;
    }
    const filePart = parts.find((p) => p.name === 'avatar' && p.filename);
    if (!filePart) {
      sendJson(res, 400, { error: 'Missing file' });
      return;
    }
    if (filePart.data.length > MAX_AVATAR_SIZE) {
      sendJson(res, 400, { error: 'File too large. Max 2MB.' });
      return;
    }
    // What the bytes are decides the type and the extension, not what the client claimed
    const realType = sec.sniffImageType(filePart.data);
    if (!realType) {
      sendJson(res, 400, { error: 'Unsupported image type' });
      return;
    }

    // Save file: username_timestamp.ext — username comes from the session, not the form
    const safeName = session.displayName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'user';
    const fileName = `${safeName}_${Date.now()}${EXT_FOR_TYPE[realType]}`;
    const avatarUrl = `/${AVATAR_DIR_NAME}/${fileName}`;
    await fs.promises.writeFile(path.join(avatarDir, fileName), filePart.data);
    await setAvatarPath(session.displayName, avatarUrl, session.userId);

    console.log(`[Avatar] Saved ${fileName} for user ${session.displayName}`);
    sendJson(res, 200, { avatarUrl });
  } catch (e) {
    console.error('[Avatar] Upload error:', e.message);
    sendJson(res, 500, { error: 'Upload failed' });
  }
}

/**
 * Simple multipart/form-data parser.
 * Returns array of { name, filename, contentType, data (Buffer) }.
 */
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(boundary);
  let pos = 0;

  // Find first boundary
  pos = buffer.indexOf(boundaryBuf, pos);
  if (pos < 0) return parts;
  pos += boundaryBuf.length;

  while (pos < buffer.length) {
    // Check for ending boundary (--boundary--)
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;

    // Skip \r\n after boundary
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    // Parse headers until \r\n\r\n
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;

    const headerStr = buffer.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;

    // Parse Content-Disposition
    const part = { name: null, filename: null, contentType: null, data: null };
    const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (dispMatch) {
      part.name = dispMatch[1];
      part.filename = dispMatch[2] || null;
    }
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
    if (ctMatch) part.contentType = ctMatch[1].trim();

    // Find next boundary
    const nextBoundary = buffer.indexOf(boundaryBuf, pos);
    if (nextBoundary < 0) break;

    // Data is between pos and nextBoundary (minus \r\n before boundary)
    let dataEnd = nextBoundary - 2; // skip \r\n before boundary
    if (dataEnd < pos) dataEnd = pos;
    part.data = buffer.slice(pos, dataEnd);
    parts.push(part);

    pos = nextBoundary + boundaryBuf.length;
  }

  return parts;
}

// ── Chat File Upload Handler (proxy to Lexicon) ────────────
async function handleChatFileUpload(req, res, auth, identity) {
  const parts = await readMultipart(req, res, MAX_CHAT_FILE_SIZE);
  if (!parts) return;
  try {
    const session = identity(auth, formFields(parts), res);
    if (!session) return;
    if (session.userId == null) {
      sendJson(res, 403, { error: 'This account cannot upload files' });
      return;
    }
    if (!uploadLimiter.take(`chat:${session.loginName}`).ok) {
      sendJson(res, 429, { error: 'Too many uploads. Try again in a minute.' });
      return;
    }
    const channelIdPart = parts.find((p) => p.name === 'channelId');
    const filePart = parts.find((p) => p.name === 'file' && p.filename);
    if (!filePart) {
      sendJson(res, 400, { error: 'Missing required field: file' });
      return;
    }
    if (filePart.data.length > MAX_CHAT_FILE_SIZE) {
      sendJson(res, 400, { error: 'File too large. Max 8MB.' });
      return;
    }
    const realType = sec.sniffImageType(filePart.data);
    if (!realType) {
      sendJson(res, 400, { error: 'Unsupported file type. Allowed: JPEG, PNG, GIF, WebP' });
      return;
    }
    const channelId = channelIdPart ? (sec.toId(channelIdPart.data.toString('utf8').trim()) ?? 0) : 0;
    const filename = sec.safeFilename(filePart.filename) || `image${EXT_FOR_TYPE[realType]}`;

    // Forward to Lexicon API, as the signed-in user
    const lexicon = require('./lexicon-client');
    const result = await lexicon.uploadChatFile(filePart.data, filename, realType, session.userId, channelId);

    console.log(`[Chat Upload] ${session.displayName} uploaded ${filename} (${realType}, ${filePart.data.length} bytes) → file ID ${result.id}`);
    sendJson(res, 200, result);
  } catch (e) {
    console.error('[Chat Upload] Error:', e.message);
    sendJson(res, 500, { error: 'Upload failed' });
  }
}

// ── Chat File Proxy (serve Lexicon files through bridge) ───
async function proxyChatFile(req, res, urlPath) {
  try {
    const targetUrl = config.lexicon.apiUrl + urlPath;

    const proxyRes = await require('node-fetch')(targetUrl);

    if (!proxyRes.ok) {
      res.writeHead(proxyRes.status, { 'Content-Type': 'text/plain' });
      res.end(proxyRes.status === 404 ? 'Not Found' : 'Error');
      return;
    }

    // Only ever serve these as images. Anything else is forced to a download inside a sandbox, so an uploaded
    // HTML/SVG file can never run script on this site's origin.
    const upstreamType = (proxyRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const imageType = sec.safeImageType(upstreamType);
    const buffer = await proxyRes.buffer();

    res.writeHead(200, {
      'Content-Type': imageType || 'application/octet-stream',
      ...(imageType ? {} : { 'Content-Disposition': 'attachment' }),
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  } catch (e) {
    console.error('[Chat File Proxy] Error:', e.message);
    sendJson(res, 502, { error: 'Could not fetch file from Lexicon' });
  }
}
