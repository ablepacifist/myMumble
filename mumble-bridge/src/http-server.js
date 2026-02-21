/**
 * HTTP static file server.
 * Serves the public/ directory with cache busting.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const BUILD_VERSION = Date.now().toString(36);

/**
 * Create an HTTP server that serves static files from publicDir.
 * @param {string} publicDir - Absolute path to the public/ directory
 * @returns {http.Server}
 */
function createHttpServer(publicDir) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
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
