#!/usr/bin/env node
/**
 * Test Runner — runs all test files and reports results.
 *
 * Usage:
 *   node tests/run-all.js [host] [port]
 *
 * Requires: mumble-bridge service running.
 */
const { execSync } = require('child_process');
const path = require('path');

const HOST = process.argv[2] || 'localhost';
const PORT = process.argv[3] || '3080';

const tests = [
  { name: 'HTTP Server', file: 'test-http-server.js' },
  { name: 'WebSocket Connection', file: 'test-ws-connect.js' },
  { name: 'Voice Bridge', file: 'test-voice-bridge.js' },
  { name: 'Two-Client Voice Flow', file: 'test-two-clients.js' },
  { name: 'Three-Client Realistic Voice', file: 'test-three-clients.js', timeout: 120000 },
  { name: 'Stability & Crash Resistance', file: 'test-stability.js', timeout: 120000 },
  { name: 'Live Smoke (local + tunnel)', file: 'test-live.js', timeout: 120000, noHostPort: true },
];

// NOTE: Mumble autobans IPs that make >10 connections in 120s.
// autobanSuccessfulConnections=false in mumble-server.ini so only
// failed/aborted connections count. Tests stagger voice_start calls
// by 2s+ to stay under the limit.

console.log('╔════════════════════════════════════════╗');
console.log('║     Mumble Bridge — Test Suite         ║');
console.log('╚════════════════════════════════════════╝');
console.log(`  Server: ${HOST}:${PORT}\n`);

let allPassed = true;

for (const test of tests) {
  const filePath = path.join(__dirname, test.file);
  console.log(`━━━ ${test.name} ━━━`);
  try {
    const args = test.noHostPort ? '' : `${HOST} ${PORT}`;
    const output = execSync(`node "${filePath}" ${args}`, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: test.timeout || 60000,
      env: { ...process.env },
    });
    process.stdout.write(output);
    // Check if output contains any ❌
    if (output.includes('❌')) {
      allPassed = false;
    }
  } catch (err) {
    allPassed = false;
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    console.log(`\n  ⚠️  ${test.name} exited with code ${err.status}\n`);
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (allPassed) {
  console.log('  ✅ ALL TESTS PASSED');
} else {
  console.log('  ❌ SOME TESTS FAILED');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exit(allPassed ? 0 : 1);
