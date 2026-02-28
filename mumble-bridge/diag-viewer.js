#!/usr/bin/env node

/**
 * Diagnostic Log Viewer & Analyzer
 * 
 * Usage:
 *   node diag-viewer.js tail [lines]     — Show tail of current day's logs
 *   node diag-viewer.js list             — List all available log files
 *   node diag-viewer.js read <file>      — Read a specific log file
 *   node diag-viewer.js summary          — Show summary/statistics
 *   node diag-viewer.js grep <pattern>   — Search logs for pattern
 *   node diag-viewer.js export <file>    — Export summary to JSON
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const logsDir = path.join(__dirname, 'logs');

function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    console.log(`Logs directory not found: ${logsDir}`);
    return false;
  }
  return true;
}

function getTodayLogFile() {
  const today = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `voice-${today}.log`);
}

function getLogFiles() {
  if (!ensureLogsDir()) return [];
  return fs.readdirSync(logsDir)
    .filter(f => f.startsWith('voice-') && f.endsWith('.log'))
    .sort()
    .reverse();
}

async function tailLogs(lines = 100) {
  const file = getTodayLogFile();
  if (!fs.existsSync(file)) {
    console.log('No logs yet.');
    return;
  }

  const content = fs.readFileSync(file, 'utf8');
  const allLines = content.split('\n').filter(l => l.trim());
  const lastLines = allLines.slice(-lines);

  lastLines.forEach(line => {
    try {
      const entry = JSON.parse(line);
      console.log(`[${entry.timestamp}] ${entry.event}`, entry);
    } catch {
      console.log(line);
    }
  });

  console.log(`\n✅ Showing last ${lastLines.length} of ${allLines.length} lines`);
}

function listFiles() {
  const files = getLogFiles();
  if (files.length === 0) {
    console.log('No log files found.');
    return;
  }
  console.log('Available log files:');
  files.forEach((f, i) => {
    const filePath = path.join(logsDir, f);
    const size = fs.statSync(filePath).size;
    const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${(size / 1024).toFixed(1)}KB`;
    console.log(`  ${i + 1}. ${f} (${sizeStr})`);
  });
}

function readFile(filename) {
  const filePath = path.join(logsDir, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filename}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  console.log(content);
}

async function grepLogs(pattern) {
  const files = getLogFiles();
  if (files.length === 0) {
    console.log('No log files found.');
    return;
  }

  const regex = new RegExp(pattern, 'i');
  let matchCount = 0;

  for (const file of files) {
    const filePath = path.join(logsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);
        const str = JSON.stringify(entry);
        if (regex.test(str)) {
          matchCount++;
          console.log(`[${file}] [${entry.timestamp}] ${entry.event}`, entry);
        }
      } catch {
        if (regex.test(line)) {
          matchCount++;
          console.log(`[${file}] ${line}`);
        }
      }
    });
  }

  console.log(`\n✅ Found ${matchCount} matches`);
}

function analyzeAndSummarize() {
  const file = getTodayLogFile();
  if (!fs.existsSync(file)) {
    console.log('No logs yet.');
    return;
  }

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').map(l => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const summary = {
    totalEvents: lines.length,
    eventsByType: {},
    errorCount: 0,
    frameDrops: {},
    wsBuffering: [],
    encodingErrors: 0,
    decodingErrors: 0,
  };

  lines.forEach(entry => {
    // Count event types
    if (!summary.eventsByType[entry.event]) {
      summary.eventsByType[entry.event] = 0;
    }
    summary.eventsByType[entry.event]++;

    // Track errors
    if (entry.event.includes('error')) {
      summary.errorCount++;
    }
    if (entry.event === 'encode_error') {
      summary.encodingErrors++;
    }
    if (entry.event === 'decode_error') {
      summary.decodingErrors++;
    }

    // Track frame drops
    if (entry.event === 'frame_drop_buffering') {
      const username = entry.username || 'unknown';
      if (!summary.frameDrops[username]) {
        summary.frameDrops[username] = { count: 0, stats: { maxRatio: 0, avgRatio: 0 } };
      }
      summary.frameDrops[username].count++;
      const ratio = parseFloat(entry.ratioOverThreshold) || 0;
      summary.frameDrops[username].stats.maxRatio = Math.max(summary.frameDrops[username].stats.maxRatio, ratio);
    }

    // Track WebSocket buffering
    if (entry.event === 'metric_ws_buffer_amount') {
      summary.wsBuffering.push({
        timestamp: entry.timestamp,
        username: entry.username,
        value: entry.value,
      });
    }
  });

  // Calculate WebSocket buffer stats
  const wsStats = { min: Infinity, max: 0, avg: 0, p95: 0 };
  if (summary.wsBuffering.length > 0) {
    const values = summary.wsBuffering.map(w => w.value).sort((a, b) => a - b);
    wsStats.min = values[0];
    wsStats.max = values[values.length - 1];
    wsStats.avg = values.reduce((a, b) => a + b) / values.length;
    wsStats.p95 = values[Math.floor(values.length * 0.95)];
  }

  console.log('\n═══════════════════════════ DIAGNOSTIC SUMMARY ═══════════════════════════');
  console.log(`Total Events: ${summary.totalEvents}`);
  console.log(`\nEvent Types:`);
  Object.entries(summary.eventsByType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([event, count]) => {
      console.log(`  ${event}: ${count}`);
    });

  console.log(`\n⚠️  Errors: ${summary.errorCount}`);
  console.log(`   - Encoding errors: ${summary.encodingErrors}`);
  console.log(`   - Decoding errors: ${summary.decodingErrors}`);

  if (Object.keys(summary.frameDrops).length > 0) {
    console.log(`\n📉 Frame Drops (due to WebSocket buffering):`);
    Object.entries(summary.frameDrops).forEach(([user, data]) => {
      console.log(`   ${user}: ${data.count} drops (max ratio: ${data.stats.maxRatio.toFixed(2)}x)`);
    });
  }

  console.log(`\n🌐 WebSocket Buffering (bytes):`);
  console.log(`   Min: ${wsStats.min === Infinity ? 'N/A' : wsStats.min}`);
  console.log(`   Max: ${wsStats.max}`);
  console.log(`   Avg: ${wsStats.avg.toFixed(0)}`);
  console.log(`   P95: ${wsStats.p95.toFixed(0)}`);

  console.log('\n═══════════════════════════════════════════════════════════════════════════\n');
}

function exportSummary(outputFile) {
  const file = getTodayLogFile();
  if (!fs.existsSync(file)) {
    console.log('No logs yet.');
    return;
  }

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').map(l => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const summary = {
    timestamp: new Date().toISOString(),
    logsFile: path.basename(file),
    totalEvents: lines.length,
    eventsByType: {},
    errors: [],
    frameDrops: [],
    wsBuffering: [],
  };

  lines.forEach(entry => {
    if (!summary.eventsByType[entry.event]) {
      summary.eventsByType[entry.event] = 0;
    }
    summary.eventsByType[entry.event]++;

    if (entry.event.includes('error')) {
      summary.errors.push(entry);
    }
    if (entry.event === 'frame_drop_buffering') {
      summary.frameDrops.push(entry);
    }
    if (entry.event === 'metric_ws_buffer_amount') {
      summary.wsBuffering.push(entry);
    }
  });

  const jsonFile = outputFile || 'voice-diag-summary.json';
  fs.writeFileSync(jsonFile, JSON.stringify(summary, null, 2));
  console.log(`✅ Exported to ${jsonFile}`);
}

// Main
const cmd = process.argv[2] || 'tail';
const arg = process.argv[3];

switch (cmd) {
  case 'tail':
    tailLogs(parseInt(arg) || 100);
    break;
  case 'list':
    listFiles();
    break;
  case 'read':
    if (!arg) {
      console.error('Usage: node diag-viewer.js read <filename>');
      process.exit(1);
    }
    readFile(arg);
    break;
  case 'grep':
    if (!arg) {
      console.error('Usage: node diag-viewer.js grep <pattern>');
      process.exit(1);
    }
    grepLogs(arg);
    break;
  case 'summary':
    analyzeAndSummarize();
    break;
  case 'export':
    exportSummary(arg);
    break;
  default:
    console.log(`Unknown command: ${cmd}`);
    console.log('Available commands: tail, list, read, grep, summary, export');
    process.exit(1);
}
