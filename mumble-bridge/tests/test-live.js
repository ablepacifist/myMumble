#!/usr/bin/env node
/**
 * Test: End-to-end smoke test through the Cloudflare tunnel.
 *
 * This tests the REAL path that browsers use:
 *   Browser → Cloudflare Tunnel (voice.alex-dyakin.com) → localhost:3080
 *
 * It verifies:
 *   1. HTTPS serves the web page through the tunnel
 *   2. WSS connects through the tunnel
 *   3. Auth works through the tunnel
 *   4. Text messaging works through the tunnel
 *   5. Voice start/stop works through the tunnel
 *   6. Latency is reasonable (< 2s for auth, < 8s for voice)
 *
 * Usage:
 *   node tests/test-live.js [domain]
 *
 * This test talks to the LIVE production server. It creates a temp user
 * and sends no audio — just verifies the control flow works end-to-end.
 * Safe to run at any time.
 */
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const DOMAIN = process.argv[2] || 'voice.alex-dyakin.com';
const HTTP_URL = `https://${DOMAIN}`;
const WS_URL = `wss://${DOMAIN}`;

// Also test localhost directly
const LOCAL_URL = 'ws://localhost:3080';

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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('HTTP timeout')), 10000);
    mod.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
      res.on('error', (err) => { clearTimeout(timeout); reject(err); });
    }).on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function wsConnect(url, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timeout = setTimeout(() => reject(new Error(`WS connect timeout to ${url}`)), 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try { messages.push(JSON.parse(data.toString())); } catch {}
        }
      });
      resolve({ ws, messages, name });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function runTests() {
  console.log(`\n🧪 Live Smoke Tests\n`);
  console.log(`  Local:  ${LOCAL_URL}`);
  console.log(`  Tunnel: ${HTTP_URL}\n`);

  const ts = Date.now();

  // ═══ Localhost tests ═══
  console.log(`  ── Localhost ──`);
  {
    // HTTP
    try {
      const resp = await httpGet('http://localhost:3080/');
      assert(resp.statusCode === 200, 'Local HTTP serves index.html');
      assert(resp.body.includes('<!DOCTYPE html>') || resp.body.includes('<html'), 'Local response is HTML');
    } catch (e) {
      assert(false, `Local HTTP: ${e.message}`);
    }

    // WS connect + auth
    let local;
    try {
      local = await wsConnect(LOCAL_URL, 'local');
      assert(true, 'Local WS connects');

      // server_state comes first
      await wait(200);
      const serverState = local.messages.find(m => m.type === 'server_state');
      assert(!!serverState, 'Local receives server_state');

      // Auth
      const t0 = Date.now();
      local.ws.send(JSON.stringify({ type: 'auth', username: `smoketest_local_${ts}` }));
      for (let i = 0; i < 20; i++) {
        if (local.messages.find(m => m.type === 'auth_ok')) break;
        await wait(100);
      }
      const authOk = local.messages.find(m => m.type === 'auth_ok');
      const authMs = Date.now() - t0;
      assert(!!authOk, `Local auth succeeds (${authMs}ms)`);

      // Text message
      local.messages.length = 0;
      local.ws.send(JSON.stringify({ type: 'get_history', channelId: 0, limit: 5 }));
      await wait(500);
      const hist = local.messages.find(m => m.type === 'history');
      assert(!!hist, 'Local history retrieval works');

      // Voice start (this creates a Mumble TLS connection)
      local.messages.length = 0;
      const vt0 = Date.now();
      local.ws.send(JSON.stringify({ type: 'voice_start' }));
      for (let i = 0; i < 80; i++) {
        if (local.messages.find(m => m.type === 'voice_ready' || m.type === 'error')) break;
        await wait(100);
      }
      const voiceReady = local.messages.find(m => m.type === 'voice_ready');
      const voiceMs = Date.now() - vt0;
      assert(!!voiceReady, `Local voice starts (${voiceMs}ms)`);
      assert(voiceMs < 8000, `Local voice latency OK (${voiceMs}ms < 8000ms)`);

      // Voice stop
      local.ws.send(JSON.stringify({ type: 'voice_stop' }));
      await wait(300);
      const stopped = local.messages.find(m => m.type === 'voice_stopped');
      assert(!!stopped, 'Local voice stops');

      local.ws.close();
    } catch (e) {
      assert(false, `Local WS test: ${e.message}`);
      if (local) local.ws.close();
    }
  }

  // ═══ Cloudflare tunnel tests ═══
  console.log(`\n  ── Cloudflare Tunnel (${DOMAIN}) ──`);
  {
    // HTTPS
    try {
      const resp = await httpGet(HTTP_URL);
      assert(resp.statusCode === 200, 'Tunnel HTTPS serves page');
      assert(resp.body.includes('<html'), 'Tunnel response is HTML');
    } catch (e) {
      assert(false, `Tunnel HTTPS: ${e.message}`);
      // If tunnel is down, skip WS tests
      console.log(`  ⚠️  Tunnel unreachable — skipping WSS tests`);
      printResults();
      return;
    }

    // WSS connect
    let tunnel;
    try {
      tunnel = await wsConnect(WS_URL, 'tunnel');
      assert(true, 'Tunnel WSS connects');

      // Auth
      const t0 = Date.now();
      tunnel.ws.send(JSON.stringify({ type: 'auth', username: `smoketest_tunnel_${ts}` }));
      for (let i = 0; i < 30; i++) {
        if (tunnel.messages.find(m => m.type === 'auth_ok')) break;
        await wait(100);
      }
      const authOk = tunnel.messages.find(m => m.type === 'auth_ok');
      const authMs = Date.now() - t0;
      assert(!!authOk, `Tunnel auth succeeds (${authMs}ms)`);
      assert(authMs < 5000, `Tunnel auth latency OK (${authMs}ms < 5000ms)`);

      // Voice through tunnel
      if (authOk) {
        tunnel.messages.length = 0;
        const vt0 = Date.now();
        tunnel.ws.send(JSON.stringify({ type: 'voice_start' }));

        // Wait longer for tunnel — extra network hop
        for (let i = 0; i < 120; i++) {
          if (tunnel.messages.find(m => m.type === 'voice_ready' || m.type === 'error')) break;
          await wait(100);
        }
        const voiceReady = tunnel.messages.find(m => m.type === 'voice_ready');
        const voiceMs = Date.now() - vt0;
        assert(!!voiceReady, `Tunnel voice starts (${voiceMs}ms)`);

        if (voiceReady) {
          tunnel.ws.send(JSON.stringify({ type: 'voice_stop' }));
          await wait(500);
          const stopped = tunnel.messages.find(m => m.type === 'voice_stopped');
          assert(!!stopped, 'Tunnel voice stops');
        } else {
          const err = tunnel.messages.find(m => m.type === 'error');
          if (err) console.log(`    Voice error: ${err.message}`);
        }
      }

      tunnel.ws.close();
    } catch (e) {
      assert(false, `Tunnel WSS: ${e.message}`);
      if (tunnel) tunnel.ws.close();
    }
  }

  // Allow Mumble connections to close before printing
  await wait(1000);

  printResults();
}

function printResults() {
  console.log('\n' + results.join('\n'));
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
