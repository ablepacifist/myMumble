#!/usr/bin/env node
/**
 * Test: HTTP static file serving and cache busting.
 *
 * Tests:
 *  1. GET / returns HTML with status 200
 *  2. HTML contains cache-bust query params on .css and .js
 *  3. GET /js/chat.js returns JavaScript
 *  4. GET /js/voice-processor.js returns JavaScript (AudioWorklet)
 *  5. GET /css/style.css returns CSS
 *  6. GET /nonexistent returns 404
 *  7. Correct Content-Type headers
 *
 * Usage:
 *   node tests/test-http-server.js [host] [port]
 */
const http = require('http');

const HOST = process.argv[2] || 'localhost';
const PORT = process.argv[3] || 3080;
const BASE = `http://${HOST}:${PORT}`;

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${name}`);
  } else {
    failed++;
    results.push(`  ❌ ${name}`);
  }
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${urlPath}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function runTests() {
  console.log(`\n🧪 HTTP Server Tests — ${BASE}\n`);

  // ── Test 1: Root returns HTML ──
  try {
    const res = await get('/');
    assert(res.status === 200, 'GET / returns 200');
    assert(res.headers['content-type'].includes('text/html'), 'GET / Content-Type is text/html');
    assert(res.body.includes('<!DOCTYPE html>'), 'GET / body is HTML');

    // ── Test 2: Cache busting ──
    const cssMatch = res.body.match(/style\.css\?v=([a-z0-9]+)/);
    const jsMatch = res.body.match(/chat\.js\?v=([a-z0-9]+)/);
    assert(!!cssMatch, 'HTML has cache-bust param on style.css');
    assert(!!jsMatch, 'HTML has cache-bust param on chat.js');
    if (cssMatch && jsMatch) {
      assert(cssMatch[1] === jsMatch[1], 'CSS and JS share same build version');
    }
  } catch (err) {
    assert(false, `GET / (${err.message})`);
  }

  // ── Test 3: chat.js ──
  try {
    const res = await get('/js/chat.js');
    assert(res.status === 200, 'GET /js/chat.js returns 200');
    assert(res.headers['content-type'].includes('javascript'), 'chat.js Content-Type is javascript');
    assert(res.body.includes('voice_start'), 'chat.js contains voice_start (new architecture)');
    assert(!res.body.includes('RTCPeerConnection'), 'chat.js does NOT contain RTCPeerConnection (old WebRTC)');
  } catch (err) {
    assert(false, `GET /js/chat.js (${err.message})`);
  }

  // ── Test 4: voice-processor.js ──
  try {
    const res = await get('/js/voice-processor.js');
    assert(res.status === 200, 'GET /js/voice-processor.js returns 200');
    assert(res.headers['content-type'].includes('javascript'), 'voice-processor.js Content-Type is javascript');
    assert(res.body.includes('AudioWorkletProcessor'), 'voice-processor.js contains AudioWorkletProcessor');
    assert(res.body.includes('registerProcessor'), 'voice-processor.js calls registerProcessor');
  } catch (err) {
    assert(false, `GET /js/voice-processor.js (${err.message})`);
  }

  // ── Test 5: style.css ──
  try {
    const res = await get('/css/style.css');
    assert(res.status === 200, 'GET /css/style.css returns 200');
    assert(res.headers['content-type'].includes('text/css'), 'style.css Content-Type is text/css');
  } catch (err) {
    assert(false, `GET /css/style.css (${err.message})`);
  }

  // ── Test 6: 404 ──
  try {
    const res = await get('/totally-does-not-exist.xyz');
    assert(res.status === 404, 'GET /nonexistent returns 404');
  } catch (err) {
    assert(false, `GET /nonexistent (${err.message})`);
  }

  // ── Test 7: No directory traversal ──
  try {
    const res = await get('/../.env');
    assert(res.status === 403 || res.status === 404, 'Directory traversal blocked');
  } catch (err) {
    assert(false, `Directory traversal test (${err.message})`);
  }

  printResults();
}

function printResults() {
  console.log(results.join('\n'));
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
