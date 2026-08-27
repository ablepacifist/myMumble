/**
 * HTTP static file server + Avatar API + Diagnostics API.
 * Serves the public/ directory with cache busting.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const AVATAR_DIR_NAME = 'uploads/avatars';

// Origins allowed to call this API cross-origin. The localhost entries are the
// Android (Capacitor) shell, which serves the bundled client from its own local
// origin; the rest is the normal site.
const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^capacitor:\/\/localhost$/,
  /^https:\/\/([a-z0-9-]+\.)?alex-dyakin\.com$/,
];
const ALLOWED_AVATAR_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Create an HTTP server that serves static files from publicDir.
 * Also handles /api/avatar/* routes for profile pictures.
 * @param {string} publicDir - Absolute path to the public/ directory
 * @returns {http.Server}
 */
function createHttpServer(publicDir) {
  const avatarDir = path.join(publicDir, AVATAR_DIR_NAME);
  // Ensure avatar dir exists
  fs.mkdirSync(avatarDir, { recursive: true });

  return http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    // ── CORS ───────────────────────────────────
    // The Android app bundles this client and serves it from the WebView's own
    // local origin, so its calls here are cross-origin. Browsers hitting the
    // real site are same-origin and unaffected by any of this.
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.some((allowed) => allowed.test(origin))) {
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
      const username = decodeURIComponent(urlPath.slice('/api/avatar/'.length));
      try {
        const avatarPath = await getAvatarPath(username);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ avatarUrl: avatarPath || '/uploads/avatars/default.jpg' }));
      } catch (e) {
        console.error('[Avatar] GET error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
      return;
    }

    // POST /api/avatar/upload  (multipart/form-data)
    if (req.method === 'POST' && urlPath === '/api/avatar/upload') {
      handleAvatarUpload(req, res, avatarDir);
      return;
    }

    // POST /api/avatar/remove
    if (req.method === 'POST' && urlPath === '/api/avatar/remove') {
      handleAvatarRemove(req, res);
      return;
    }

    // ── Chat File Upload (proxy to Lexicon) ───────────────
    // POST /api/chat/upload — Upload an image/GIF for chat
    if (req.method === 'POST' && urlPath === '/api/chat/upload') {
      handleChatFileUpload(req, res);
      return;
    }

    // GET /api/chat/files/:id — Proxy file from Lexicon
    if (req.method === 'GET' && urlPath.match(/^\/api\/chat\/files\/\d+(\/thumb)?$/)) {
      proxyChatFile(req, res, urlPath);
      return;
    }

    // ── Diagnostics API (admin only, for testing) ─────────
    // GET /api/diag/logs — Get latest voice diagnostics
    if (req.method === 'GET' && urlPath.startsWith('/api/diag/logs')) {
      const lines = parseInt(req.url.split('lines=')[1] || '500');
      try {
        const VoiceBridge = require('./voice-bridge');
        const voiceDiag = VoiceBridge.voiceBridgeInstance?.diag;
        if (!voiceDiag) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Voice bridge not initialized' }));
          return;
        }
        const logContent = voiceDiag.getTailLogs(Math.min(lines, 5000));
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(logContent);
      } catch (e) {
        console.error('[Diag API] Error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // GET /api/diag/summary — Get diagnostic summary/stats
    if (req.method === 'GET' && urlPath === '/api/diag/summary') {
      try {
        const VoiceBridge = require('./voice-bridge');
        const voiceDiag = VoiceBridge.voiceBridgeInstance?.diag;
        if (!voiceDiag) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Voice bridge not initialized' }));
          return;
        }
        const summary = voiceDiag.exportSummary();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary, null, 2));
      } catch (e) {
        console.error('[Diag API] Error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // GET /api/diag/files — List available log files
    if (req.method === 'GET' && urlPath === '/api/diag/files') {
      try {
        const VoiceBridge = require('./voice-bridge');
        const voiceDiag = VoiceBridge.voiceBridgeInstance?.diag;
        if (!voiceDiag) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Voice bridge not initialized' }));
          return;
        }
        const files = voiceDiag.listLogFiles();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      } catch (e) {
        console.error('[Diag API] Error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // GET /api/push/vapid-key — proxy to Lexicon
    if (req.method === 'GET' && urlPath === '/api/push/vapid-key') {
      try {
        const lexicon = require('./lexicon-client');
        const key = await lexicon.getVapidKey();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ publicKey: key }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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

    const safePath = path.normalize(staticPath).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(publicDir, safePath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
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
  });
}

module.exports = { createHttpServer };

// ── Avatar Upload Handler (simple multipart parser) ────────
function handleAvatarUpload(req, res, avatarDir) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
    return;
  }

  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No boundary found' }));
    return;
  }

  const chunks = [];
  let totalSize = 0;

  req.on('data', (chunk) => {
    totalSize += chunk.length;
    if (totalSize > MAX_AVATAR_SIZE + 4096) { // slight overhead for form fields
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const boundary = '--' + boundaryMatch[1];
      const parts = parseMultipart(buffer, boundary);

      const usernamePart = parts.find(p => p.name === 'username');
      const userIdPart = parts.find(p => p.name === 'userId');
      const filePart = parts.find(p => p.name === 'avatar' && p.filename);

      if (!usernamePart || !filePart) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing username or file' }));
        return;
      }

      const username = usernamePart.data.toString('utf8').trim();
      const userId = userIdPart ? parseInt(userIdPart.data.toString('utf8').trim()) : null;
      const fileType = filePart.contentType || 'image/jpeg';
      const ext = ALLOWED_AVATAR_TYPES[fileType];

      if (!ext) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported image type: ' + fileType }));
        return;
      }

      if (filePart.data.length > MAX_AVATAR_SIZE) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large. Max 2MB.' }));
        return;
      }

      // Save file: username_timestamp.ext
      const safeName = username.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${safeName}_${Date.now()}${ext}`;
      const filePath = path.join(avatarDir, fileName);
      const avatarUrl = `/${AVATAR_DIR_NAME}/${fileName}`;

      fs.writeFileSync(filePath, filePart.data);
      await setAvatarPath(username, avatarUrl, userId);

      console.log(`[Avatar] Saved ${fileName} for user ${username}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ avatarUrl }));
    } catch (e) {
      console.error('[Avatar] Upload error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed' }));
    }
  });
}

async function handleAvatarRemove(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing username' }));
        return;
      }
      await removeAvatarPath(body.username);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[Avatar] Remove error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Remove failed' }));
    }
  });
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
const MAX_CHAT_FILE_SIZE = 8 * 1024 * 1024; // 8MB
const ALLOWED_CHAT_FILE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function handleChatFileUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
    return;
  }

  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No boundary found' }));
    return;
  }

  const chunks = [];
  let totalSize = 0;

  req.on('data', (chunk) => {
    totalSize += chunk.length;
    if (totalSize > MAX_CHAT_FILE_SIZE + 8192) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    try {
      const buffer = Buffer.concat(chunks);
      const boundary = '--' + boundaryMatch[1];
      const parts = parseMultipart(buffer, boundary);

      const usernamePart = parts.find(p => p.name === 'username');
      const userIdPart = parts.find(p => p.name === 'userId');
      const channelIdPart = parts.find(p => p.name === 'channelId');
      const filePart = parts.find(p => p.name === 'file' && p.filename);

      if (!filePart || !userIdPart) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields (file, userId)' }));
        return;
      }

      const fileType = filePart.contentType || 'application/octet-stream';
      if (!ALLOWED_CHAT_FILE_TYPES.includes(fileType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type: ' + fileType + '. Allowed: JPEG, PNG, GIF, WebP' }));
        return;
      }

      if (filePart.data.length > MAX_CHAT_FILE_SIZE) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large. Max 8MB.' }));
        return;
      }

      const userId = parseInt(userIdPart.data.toString('utf8').trim());
      const channelId = channelIdPart ? parseInt(channelIdPart.data.toString('utf8').trim()) : 0;

      // Forward to Lexicon API
      const lexicon = require('./lexicon-client');
      const result = await lexicon.uploadChatFile(
        filePart.data,
        filePart.filename,
        fileType,
        userId,
        channelId
      );

      console.log(`[Chat Upload] ${usernamePart ? usernamePart.data.toString('utf8').trim() : 'user_' + userId} uploaded ${filePart.filename} (${fileType}, ${filePart.data.length} bytes) → file ID ${result.id}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Chat Upload] Error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upload failed: ' + e.message }));
    }
  });
}

// ── Chat File Proxy (serve Lexicon files through bridge) ───
async function proxyChatFile(req, res, urlPath) {
  try {
    const lexicon = require('./lexicon-client');
    const config = require('./config');
    const targetUrl = config.lexicon.apiUrl + urlPath;

    const proxyRes = await require('node-fetch')(targetUrl);

    if (!proxyRes.ok) {
      res.writeHead(proxyRes.status, { 'Content-Type': 'text/plain' });
      res.end(proxyRes.status === 404 ? 'Not Found' : 'Error');
      return;
    }

    const ct = proxyRes.headers.get('content-type') || 'application/octet-stream';
    const buffer = await proxyRes.buffer();

    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  } catch (e) {
    console.error('[Chat File Proxy] Error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not fetch file from Lexicon' }));
  }
}
