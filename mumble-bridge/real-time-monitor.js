#!/usr/bin/env node

/**
 * Real-time Voice Diagnostics Monitor
 * 
 * Usage:
 *   node real-time-monitor.js [--http voice.alex-dyakin.com]
 * 
 * Shows live metrics while voice session is active.
 * Helps identify when/why audio gets choppy.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const USE_HTTP = process.argv.includes('--http');
const HTTP_URL = process.argv[process.argv.indexOf('--http') + 1] || 'voice.alex-dyakin.com';

// Metrics tracking
const metrics = {
  frameDrops: 0,
  encodeErrors: 0,
  decodeErrors: 0,
  wsBufferSamples: [],
  maxWsBuffer: 0,
  minWsBuffer: Infinity,
  activeSessions: new Map(),
};

const REFRESH_INTERVAL = 1000; // Update display every 1 second
let lastLogSize = 0;
let lastCheckTime = 0;

async function fetchViaHttp(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `http://${HTTP_URL}/api/diag/${endpoint}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (endpoint === 'logs') {
            resolve(data.split('\n').map(l => {
              try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function readLogsLocal() {
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(__dirname, 'logs', `voice-${today}.log`);

  if (!fs.existsSync(logFile)) return [];

  try {
    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n')
      .map(l => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .slice(-1000); // Last 1000 entries
  } catch {
    return [];
  }
}

async function getLogs() {
  if (USE_HTTP) {
    return await fetchViaHttp('logs?lines=500');
  } else {
    return await readLogsLocal();
  }
}

function clearScreen() {
  console.clear();
  console.log('\n📊 VOICE DIAGNOSTICS MONITOR\n');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function updateMetrics() {
  try {
    const logs = await getLogs();

    // Reset metrics
    metrics.frameDrops = 0;
    metrics.encodeErrors = 0;
    metrics.decodeErrors = 0;
    metrics.wsBufferSamples = [];
    metrics.maxWsBuffer = 0;
    metrics.minWsBuffer = Infinity;
    metrics.activeSessions.clear();

    // Process logs
    logs.forEach(entry => {
      if (entry.event === 'frame_drop_buffering') {
        metrics.frameDrops++;
        const username = entry.username || 'unknown';
        if (!metrics.activeSessions.has(username)) {
          metrics.activeSessions.set(username, { drops: 0, errors: 0, bufferMax: 0 });
        }
        const sess = metrics.activeSessions.get(username);
        sess.drops++;
        sess.bufferMax = Math.max(sess.bufferMax, entry.bufferedAmount || 0);
      }

      if (entry.event === 'encode_error') {
        metrics.encodeErrors++;
        const username = entry.username || 'unknown';
        if (!metrics.activeSessions.has(username)) {
          metrics.activeSessions.set(username, { drops: 0, errors: 0, bufferMax: 0 });
        }
        metrics.activeSessions.get(username).errors++;
      }

      if (entry.event === 'decode_error') {
        metrics.decodeErrors++;
      }

      if (entry.event === 'metric_ws_buffer_amount') {
        metrics.wsBufferSamples.push(entry.value || 0);
        metrics.maxWsBuffer = Math.max(metrics.maxWsBuffer, entry.value || 0);
        metrics.minWsBuffer = Math.min(metrics.minWsBuffer, entry.value || 0);
      }
    });

    // Keep only last 60 samples (1 minute)
    if (metrics.wsBufferSamples.length > 60) {
      metrics.wsBufferSamples = metrics.wsBufferSamples.slice(-60);
    }

    return true;
  } catch (err) {
    console.error('Error fetching metrics:', err.message);
    return false;
  }
}

function drawGraph(values, width = 40, height = 8, maxValue = 9600) {
  if (values.length === 0) return '(no data)';

  const graph = [];
  const step = Math.ceil(values.length / width);
  const sampledValues = [];

  for (let i = 0; i < values.length; i += step) {
    sampledValues.push(values[i]);
  }

  // Normalize to height
  for (let row = height; row > 0; row--) {
    let line = '';
    const threshold = (row / height) * maxValue;

    for (const val of sampledValues) {
      if (val >= threshold) {
        line += '█';
      } else {
        line += ' ';
      }
    }
    graph.push(line);
  }

  // Add threshold line
  const thresholdRow = Math.ceil((9600 / maxValue) * height);
  if (thresholdRow >= 1 && thresholdRow <= height) {
    const idx = height - thresholdRow;
    if (graph[idx]) {
      const parts = graph[idx].split('');
      parts[0] = '→'; // Mark threshold
      graph[idx] = parts.join('');
    }
  }

  return graph.join('\n');
}

async function displayMetrics() {
  clearScreen();

  // Status indicator
  const status = metrics.frameDrops > 10 ? '⚠️  CHOPPY' :
                 metrics.frameDrops > 0 ? '⚡ SOME DROPS' :
                 '✅ OK';

  console.log(`Status: ${status}\n`);

  // Frame drops
  console.log('📉 Frame Drops (by buffering):');
  console.log(`   Total: ${metrics.frameDrops}`);
  if (metrics.frameDrops > 0) {
    console.log(`   ⚠️  This means WebSocket buffer got too full\n`);
  }

  // Per-user breakdown
  if (metrics.activeSessions.size > 0) {
    console.log('   By user:');
    for (const [user, stats] of metrics.activeSessions) {
      if (stats.drops > 0) {
        console.log(`     - ${user}: ${stats.drops} drops (max buffer: ${formatBytes(stats.bufferMax)})`);
      }
      if (stats.errors > 0) {
        console.log(`     - ${user}: ${stats.errors} encoding errors`);
      }
    }
    console.log('');
  }

  // Encoding/Decoding errors
  if (metrics.encodeErrors > 0 || metrics.decodeErrors > 0) {
    console.log('❌ Codec Errors:');
    if (metrics.encodeErrors > 0) console.log(`   Encode: ${metrics.encodeErrors}`);
    if (metrics.decodeErrors > 0) console.log(`   Decode: ${metrics.decodeErrors}`);
    console.log('   ⚠️  Check sample rate and frame size\n');
  }

  // WebSocket buffering graph
  console.log('🌐 WebSocket Buffering (bytes) — Last 60s:');
  if (metrics.wsBufferSamples.length > 0) {
    const maxForGraph = Math.max(metrics.maxWsBuffer, 14400); // 1.5x threshold
    console.log(drawGraph(metrics.wsBufferSamples, 50, 6, maxForGraph));
    console.log(`   Range: ${formatBytes(metrics.minWsBuffer)} — ${formatBytes(metrics.maxWsBuffer)}`);
    console.log(`   Threshold: ${formatBytes(9600)} (→ mark above)\n`);

    if (metrics.maxWsBuffer > 9600) {
      console.log('   ⚠️  Buffer exceeded threshold! Frames were dropped.\n');
    }
  } else {
    console.log('   (waiting for data...)\n');
  }

  // Interpretation
  console.log('📋 Interpretation:');
  if (metrics.frameDrops === 0 && metrics.maxWsBuffer < 5000) {
    console.log('   ✅ Network is healthy, no issues detected');
  } else if (metrics.frameDrops > 0) {
    console.log('   ⚠️  Network can\'t keep up — frames were dropped');
    console.log('   Possible causes:');
    console.log('   1. Cloudflare tunnel latency');
    console.log('   2. PlayIt tunnel overloaded');
    console.log('   3. GTW network congestion');
    console.log('   Solutions:');
    console.log('   • Try PlayIt instead of Cloudflare');
    console.log('   • Increase MAX_BUFFERED threshold (accept more latency)');
    console.log('   • Check GTW CPU/network usage');
  } else if (metrics.maxWsBuffer > 7000) {
    console.log('   ⚡ Network has high latency but recovering');
    console.log('   Monitor closely for frame drops');
  }

  console.log('\n[Press Ctrl+C to exit | Refreshing every 1 second]\n');
}

async function main() {
  console.log('🚀 Starting Real-Time Monitor...');

  if (USE_HTTP) {
    console.log(`📡 Connecting to ${HTTP_URL}/api/diag/...\n`);
  } else {
    console.log('📂 Reading local logs...\n');
  }

  // Initial update
  await updateMetrics().catch(() => {
    console.log('⚠️  Could not fetch initial metrics. Is the bridge running?');
  });

  // Display loop
  const displayLoop = setInterval(async () => {
    await updateMetrics().catch(() => {});
    await displayMetrics();
  }, REFRESH_INTERVAL);

  process.on('SIGINT', () => {
    clearInterval(displayLoop);
    console.log('\n📊 Monitor stopped.\n');
    process.exit(0);
  });
}

main();
