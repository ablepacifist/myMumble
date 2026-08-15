/**
 * Channel Access Feature Tests — unit-level, no live server or DB needed.
 * Run: node tests/test-channel-access.js
 */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

console.log('\n── Channel Access Feature ──');

const channelAccess = require('../src/features/channel-access/index.js');

test('Module has correct name', () => {
  assert(channelAccess.name === 'channel-access');
});

test('Module handles correct message types', () => {
  assert(channelAccess.messageTypes.includes('set_channel_access'));
  assert(channelAccess.messageTypes.includes('get_channel_access'));
  assert(channelAccess.messageTypes.includes('get_known_users'));
});

test('Module has canAccess/isRestricted/handleMessage/cleanup methods', () => {
  assert(typeof channelAccess.canAccess === 'function');
  assert(typeof channelAccess.isRestricted === 'function');
  assert(typeof channelAccess.handleMessage === 'function');
  assert(typeof channelAccess.cleanup === 'function');
});

// Seed in-memory state directly (bypassing init()/DB) to exercise the
// canAccess truth table in isolation.
channelAccess.restrictedChannelIds.add(42);
channelAccess.grantsByChannel.set(42, new Set([1, 2]));

test('Unrestricted channel is open to everyone', () => {
  assert(channelAccess.canAccess(99, null, false) === true);
  assert(channelAccess.canAccess(99, 5, false) === true);
});

test('Admin can access a restricted channel with no grant', () => {
  assert(channelAccess.canAccess(42, 999, true) === true);
});

test('Granted user can access a restricted channel', () => {
  assert(channelAccess.canAccess(42, 1, false) === true);
  assert(channelAccess.canAccess(42, 2, false) === true);
});

test('Non-granted user cannot access a restricted channel', () => {
  assert(channelAccess.canAccess(42, 3, false) === false);
});

test('Unauthenticated (userId null) cannot access a restricted channel', () => {
  assert(channelAccess.canAccess(42, null, false) === false);
});

test('isRestricted reflects the restricted set', () => {
  assert(channelAccess.isRestricted(42) === true);
  assert(channelAccess.isRestricted(99) === false);
});

test('filterVisibleChannels drops inaccessible channels', () => {
  const list = [{ id: 42 }, { id: 99 }];
  const visibleToStranger = channelAccess.filterVisibleChannels(list, 3, false);
  assert(visibleToStranger.length === 1 && visibleToStranger[0].id === 99);
  const visibleToGranted = channelAccess.filterVisibleChannels(list, 1, false);
  assert(visibleToGranted.length === 2);
  const visibleToAdmin = channelAccess.filterVisibleChannels(list, 999, true);
  assert(visibleToAdmin.length === 2);
});

// Reset seeded state so this module has no side effects on other test files.
channelAccess.restrictedChannelIds.delete(42);
channelAccess.grantsByChannel.delete(42);

console.log(`\n${'='.repeat(50)}`);
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✅ All channel-access feature tests passed!');
} else {
  console.log('❌ Some tests failed');
  process.exit(1);
}
