#!/usr/bin/env node
/**
 * Test: Voice bridge session lifecycle.
 *
 * Tests:
 *  1. VoiceBridge initializes (loads protobuf)
 *  2. startSession creates a Mumble TLS connection
 *  3. Session receives ServerSync and becomes ready
 *  4. handleAudioFromBrowser encodes and sends to Mumble
 *  5. stopSession disconnects and cleans up
 *  6. Multiple sessions can coexist
 *  7. Duplicate startSession cleans up old one
 *
 * Usage:
 *   node tests/test-voice-bridge.js
 *
 * Requires: Mumble server running on localhost:64738
 */
const path = require('path');

// Load config
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const VoiceBridge = require('../src/voice-bridge');

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

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Minimal mock WebSocket that captures sent data
class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sentData = [];
  }
  send(data, opts) {
    this.sentData.push({ data, opts });
  }
}

async function runTests() {
  console.log('\n🧪 Voice Bridge Tests\n');

  const bridge = new VoiceBridge();

  // ── Test 1: Init ──
  try {
    await bridge.init();
    assert(true, 'VoiceBridge.init() succeeds');
    assert(bridge.proto !== null, 'Protobuf loaded');
    assert(Object.keys(bridge.messageTypes).length > 0, 'Message types populated');
    assert(bridge.samplesPerFrame === 960, 'Samples per frame = 960 (20ms @ 48kHz)');
  } catch (err) {
    assert(false, `VoiceBridge.init() succeeds (${err.message})`);
    printResults();
    return;
  }

  // ── Test 2: Start session ──
  const mockWs1 = new MockWebSocket();
  let session1;
  try {
    session1 = await bridge.startSession('test_user1_1', 'test_user1', mockWs1);
    assert(true, 'startSession resolves successfully');
    assert(session1.ready === true, 'Session is ready after connect');
    assert(session1.mumbleSession !== null, 'Session has Mumble session ID');
    assert(bridge.sessions.size === 1, 'Bridge tracks 1 session');
  } catch (err) {
    assert(false, `startSession resolves successfully (${err.message})`);
    printResults();
    return;
  }

  // ── Test 3: Stats ──
  const stats = bridge.getStats();
  assert(stats.activeSessions === 1, 'getStats reports 1 active session');
  assert(stats.sessionIds.includes('test_user1_1'), 'getStats includes session ID');

  // ── Test 4: Handle audio from browser ──
  // Create 960 Int16 samples (20ms frame at 48kHz) — sine wave
  const pcmBuffer = Buffer.alloc(960 * 2); // 1920 bytes
  for (let i = 0; i < 960; i++) {
    const sample = Math.floor(Math.sin(2 * Math.PI * 440 * i / 48000) * 16000);
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  try {
    bridge.handleAudioFromBrowser('test_user1_1', pcmBuffer);
    assert(true, 'handleAudioFromBrowser does not throw');
  } catch (err) {
    assert(false, `handleAudioFromBrowser does not throw (${err.message})`);
  }

  // ── Test 5: Nonexistent session is ignored ──
  bridge.handleAudioFromBrowser('nobody', pcmBuffer); // should not throw
  assert(true, 'handleAudioFromBrowser ignores unknown peerId');

  // Brief pause to avoid Mumble rate-limiting rapid connections
  await wait(1000);

  // ── Test 6: Second session ──
  const mockWs2 = new MockWebSocket();
  try {
    await bridge.startSession('test_user2_2', 'test_user2', mockWs2);
    assert(true, 'Second session starts');
    assert(bridge.sessions.size === 2, 'Bridge tracks 2 sessions');
  } catch (err) {
    assert(false, `Second session starts (${err.message})`);
  }

  // Wait a moment for Mumble to possibly send audio between the two sessions
  await wait(1000);

  // ── Test 7: Duplicate session replaces old ──
  const mockWs3 = new MockWebSocket();
  try {
    await bridge.startSession('test_user1_1', 'test_user1', mockWs3);
    assert(bridge.sessions.size === 2, 'Duplicate peerId replaces old session (count stays 2)');
    const newSession = bridge.sessions.get('test_user1_1');
    assert(newSession.ws === mockWs3, 'New session has new WebSocket');
  } catch (err) {
    assert(false, `Duplicate session replaces old (${err.message})`);
  }

  // Allow Mumble to settle before stopping
  await wait(500);

  // ── Test 8: Stop session ──
  bridge.stopSession('test_user1_1');
  assert(bridge.sessions.size === 1, 'After stopping 1, bridge has 1 session');
  assert(!bridge.sessions.has('test_user1_1'), 'Stopped session removed from map');

  bridge.stopSession('test_user2_2');
  assert(bridge.sessions.size === 0, 'After stopping all, bridge has 0 sessions');

  // ── Test 9: Stop nonexistent session doesn't crash ──
  bridge.stopSession('nope');
  assert(true, 'stopSession on nonexistent peerId is safe');

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
