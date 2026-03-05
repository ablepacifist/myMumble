#!/usr/bin/env node
/**
 * WebSocket Quality Test
 *
 * Measures:
 *  - connect time
 *  - ping/pong RTT (min/avg/p50/p95/max)
 *  - jitter (std dev of RTT)
 *  - missed pongs (effective packet loss at WS control-frame level)
 *  - reconnect count / close codes
 *  - inbound message rate
 *
 * Usage examples:
 *   node tests/test-ws-quality.js --url wss://voice.alex-dyakin.com --duration 180
 *   node tests/test-ws-quality.js --url ws://localhost:3080 --duration 60 --interval 1000
 */

const WebSocket = require('ws');

function parseArgs(argv) {
  const args = {
    url: 'ws://localhost:3080',
    durationSec: 120,
    pingIntervalMs: 1000,
    pongTimeoutMs: 3000,
    reconnectDelayMs: 1500,
    insecure: false,
  };

  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === '--url' && next) {
      args.url = next;
      index++;
    } else if (token === '--duration' && next) {
      args.durationSec = Number(next);
      index++;
    } else if (token === '--interval' && next) {
      args.pingIntervalMs = Number(next);
      index++;
    } else if (token === '--timeout' && next) {
      args.pongTimeoutMs = Number(next);
      index++;
    } else if (token === '--reconnect-delay' && next) {
      args.reconnectDelayMs = Number(next);
      index++;
    } else if (token === '--insecure') {
      args.insecure = true;
    } else if (token === '--help' || token === '-h') {
      printHelpAndExit();
    }
  }

  return args;
}

function printHelpAndExit() {
  console.log(`
WebSocket Quality Test

Options:
  --url <ws(s)://host[:port]>   Target URL (default: ws://localhost:3080)
  --duration <seconds>          Test duration (default: 120)
  --interval <ms>               Ping interval ms (default: 1000)
  --timeout <ms>                Pong timeout ms (default: 3000)
  --reconnect-delay <ms>        Reconnect delay after close/error (default: 1500)
  --insecure                    Disable TLS verification (for self-signed wss)
  --help                        Show this help

Example:
  node tests/test-ws-quality.js --url wss://voice.alex-dyakin.com --duration 180
`);
  process.exit(0);
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const rank = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length)));
  return sortedValues[rank];
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function nowMs() {
  return Date.now();
}

async function run() {
  const cfg = parseArgs(process.argv);
  const startedAt = nowMs();
  const endsAt = startedAt + (cfg.durationSec * 1000);

  const stats = {
    attempts: 0,
    connectedCount: 0,
    reconnects: 0,
    connectTimesMs: [],
    closeEvents: [],

    pingsSent: 0,
    pongsReceived: 0,
    pongsMissed: 0,
    rttsMs: [],

    messagesReceived: 0,
    binaryMessages: 0,
    textMessages: 0,
    bytesReceived: 0,
  };

  let ws = null;
  let pingTimer = null;
  let reportTimer = null;

  let sequence = 0;
  const inFlight = new Map(); // seq -> sentTs
  let stopping = false;

  function markMissedPongs() {
    const cutoff = nowMs() - cfg.pongTimeoutMs;
    for (const [seq, sentTs] of inFlight) {
      if (sentTs <= cutoff) {
        inFlight.delete(seq);
        stats.pongsMissed++;
      }
    }
  }

  function sendPingFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    markMissedPongs();

    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt32BE(sequence, 0);
    payload.writeUInt32BE(nowMs() >>> 0, 4);

    inFlight.set(sequence, nowMs());
    sequence++;
    stats.pingsSent++;

    try {
      ws.ping(payload);
    } catch (_) {
      // connection may have closed between checks
    }
  }

  function printProgress() {
    const elapsed = Math.max(1, Math.round((nowMs() - startedAt) / 1000));
    const latestRtt = stats.rttsMs.length ? stats.rttsMs[stats.rttsMs.length - 1] : 0;
    const lossPct = stats.pingsSent ? ((stats.pongsMissed / stats.pingsSent) * 100) : 0;
    process.stdout.write(`\r[t+${elapsed}s] conn=${stats.connectedCount} ping=${stats.pingsSent} pong=${stats.pongsReceived} missed=${stats.pongsMissed} loss=${lossPct.toFixed(2)}% rtt_last=${latestRtt.toFixed(1)}ms    `);
  }

  function cleanupConnection() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopping || nowMs() >= endsAt) return;
    setTimeout(connect, cfg.reconnectDelayMs);
  }

  function connect() {
    if (stopping || nowMs() >= endsAt) return;

    stats.attempts++;
    const connectStart = nowMs();

    const options = cfg.insecure ? { rejectUnauthorized: false } : undefined;
    ws = new WebSocket(cfg.url, options);

    ws.on('open', () => {
      const connectMs = nowMs() - connectStart;
      stats.connectTimesMs.push(connectMs);
      stats.connectedCount++;
      if (stats.connectedCount > 1) stats.reconnects++;

      pingTimer = setInterval(sendPingFrame, cfg.pingIntervalMs);
    });

    ws.on('pong', (data) => {
      stats.pongsReceived++;

      if (Buffer.isBuffer(data) && data.length >= 4) {
        const seq = data.readUInt32BE(0);
        const sentTs = inFlight.get(seq);
        if (sentTs) {
          const rtt = nowMs() - sentTs;
          stats.rttsMs.push(rtt);
          inFlight.delete(seq);
        }
      }
    });

    ws.on('message', (data, isBinary) => {
      stats.messagesReceived++;
      const len = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString());
      stats.bytesReceived += len;
      if (isBinary) stats.binaryMessages++;
      else stats.textMessages++;
    });

    ws.on('close', (code, reasonBuffer) => {
      cleanupConnection();
      const reason = reasonBuffer ? reasonBuffer.toString() : '';
      stats.closeEvents.push({ code, reason, at: new Date().toISOString() });
      scheduleReconnect();
    });

    ws.on('error', () => {
      cleanupConnection();
      scheduleReconnect();
    });
  }

  function stopAndReport(exitCode) {
    if (stopping) return;
    stopping = true;

    cleanupConnection();
    if (reportTimer) clearInterval(reportTimer);
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();

    markMissedPongs();

    const rtts = [...stats.rttsMs].sort((a, b) => a - b);
    const rttMin = rtts.length ? rtts[0] : 0;
    const rttAvg = rtts.length ? (rtts.reduce((sum, value) => sum + value, 0) / rtts.length) : 0;
    const rttP50 = percentile(rtts, 50);
    const rttP95 = percentile(rtts, 95);
    const rttMax = rtts.length ? rtts[rtts.length - 1] : 0;
    const jitter = stddev(stats.rttsMs);

    const lossPct = stats.pingsSent ? ((stats.pongsMissed / stats.pingsSent) * 100) : 0;

    console.log('\n\n=== WebSocket Quality Report ===');
    console.log(`Target URL:         ${cfg.url}`);
    console.log(`Duration:           ${cfg.durationSec}s`);
    console.log(`Attempts:           ${stats.attempts}`);
    console.log(`Connected:          ${stats.connectedCount}`);
    console.log(`Reconnects:         ${stats.reconnects}`);

    if (stats.connectTimesMs.length) {
      const minConnect = Math.min(...stats.connectTimesMs);
      const maxConnect = Math.max(...stats.connectTimesMs);
      const avgConnect = stats.connectTimesMs.reduce((sum, value) => sum + value, 0) / stats.connectTimesMs.length;
      console.log(`Connect time (ms):  min=${minConnect.toFixed(1)} avg=${avgConnect.toFixed(1)} max=${maxConnect.toFixed(1)}`);
    }

    console.log(`Pings sent:         ${stats.pingsSent}`);
    console.log(`Pongs received:     ${stats.pongsReceived}`);
    console.log(`Missed pongs:       ${stats.pongsMissed}`);
    console.log(`Loss estimate:      ${lossPct.toFixed(2)}%`);

    console.log(`RTT (ms):           min=${rttMin.toFixed(1)} avg=${rttAvg.toFixed(1)} p50=${rttP50.toFixed(1)} p95=${rttP95.toFixed(1)} max=${rttMax.toFixed(1)}`);
    console.log(`Jitter (stddev ms): ${jitter.toFixed(2)}`);

    console.log(`Messages received:  total=${stats.messagesReceived} text=${stats.textMessages} binary=${stats.binaryMessages} bytes=${stats.bytesReceived}`);

    if (stats.closeEvents.length) {
      console.log('Close events:');
      for (const closeEvent of stats.closeEvents.slice(-10)) {
        console.log(`  - code=${closeEvent.code} reason="${closeEvent.reason}" at=${closeEvent.at}`);
      }
    }

    const unhealthy = lossPct > 2 || rttP95 > 250 || stats.reconnects > 0;
    console.log(`Result:             ${unhealthy ? 'UNHEALTHY' : 'HEALTHY'}`);

    process.exit(exitCode);
  }

  reportTimer = setInterval(printProgress, 1000);
  connect();

  setTimeout(() => stopAndReport(0), cfg.durationSec * 1000);

  process.on('SIGINT', () => stopAndReport(0));
  process.on('SIGTERM', () => stopAndReport(0));
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
