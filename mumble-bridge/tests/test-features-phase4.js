/**
 * Phase 4 Feature Tests — Pinned Messages + jump-to-message window paging.
 * Unit-level, no live server or DB needed (mocked deps).
 * Run: node tests/test-features-phase4.js
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

async function testAsync(name, fn) {
  try {
    await fn();
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

// ══════════════════════════════════════════════════════
// Pinned Messages Feature
// ══════════════════════════════════════════════════════
console.log('\n── Pinned Messages Feature ──');

const pinnedMessages = require('../src/features/pinned-messages/index.js');

test('Module has correct name', () => {
  assert(pinnedMessages.name === 'pinned-messages');
});

test('Module handles correct message types', () => {
  assert(pinnedMessages.messageTypes.includes('pin_message'));
  assert(pinnedMessages.messageTypes.includes('unpin_message'));
  assert(pinnedMessages.messageTypes.includes('get_pinned_messages'));
});

test('Module has attachPinInfo/handleMessage/cleanup methods', () => {
  assert(typeof pinnedMessages.attachPinInfo === 'function');
  assert(typeof pinnedMessages.handleMessage === 'function');
  assert(typeof pinnedMessages.cleanup === 'function');
});

async function run() {
  // Mock deps.db so attachPinInfo can run without a real MySQL connection.
  const pinnedIds = new Set(['10']);
  pinnedMessages.deps = {
    db: {
      execute: async (sql, params) => {
        if (sql.includes('SELECT message_id FROM pinned_messages WHERE message_id IN')) {
          const rows = params.filter((id) => pinnedIds.has(String(id))).map((id) => ({ message_id: id }));
          return [rows];
        }
        return [[]];
      },
    },
  };

  await testAsync('attachPinInfo marks pinned messages', async () => {
    const messages = [{ id: 10, content: 'a' }, { id: 11, content: 'b' }];
    const result = await pinnedMessages.attachPinInfo(messages);
    assert(result[0].isPinned === true, 'message 10 should be pinned');
    assert(result[1].isPinned === false, 'message 11 should not be pinned');
  });

  await testAsync('attachPinInfo is a no-op for an empty list', async () => {
    const result = await pinnedMessages.attachPinInfo([]);
    assert(Array.isArray(result) && result.length === 0);
  });

  await testAsync('_rowToPin parses attachment_json and stringifies messageId', () => {
    const pin = pinnedMessages._rowToPin({
      id: 1, channel_id: 5, message_id: 42, username: 'alex', content: 'hi',
      message_type: 'TEXT', attachment_json: '{"fileUrl":"x"}', pinned_by: 'alex', pinned_at: new Date(),
    });
    assert(pin.messageId === '42', 'messageId should be stringified');
    assert(pin.attachment.fileUrl === 'x', 'attachment_json should be parsed');
  });

  pinnedMessages.deps = null; // reset so this module has no side effects on other test files

  // ══════════════════════════════════════════════════════
  // message-window.js — findMessageWindow
  // ══════════════════════════════════════════════════════
  console.log('\n── Jump-to-message window paging ──');

  const { findMessageWindow } = require('../src/message-window.js');

  await testAsync('finds the target on the first page', async () => {
    const mockLexicon = {
      getChannelMessages: async () => [
        { id: 3, createdAt: '2026-01-01T00:03:00' },
        { id: 2, createdAt: '2026-01-01T00:02:00' },
        { id: 1, createdAt: '2026-01-01T00:01:00' },
      ],
    };
    const result = await findMessageWindow(mockLexicon, 1, 2);
    assert(result.found === true);
    assert(result.messages.some((m) => m.id === 2));
  });

  await testAsync('pages backward using a shrinking `before` cursor until found', async () => {
    const pages = [
      [{ id: 5, createdAt: '2026-01-01T00:05:00' }, { id: 4, createdAt: '2026-01-01T00:04:00' }],
      [{ id: 3, createdAt: '2026-01-01T00:03:00' }, { id: 2, createdAt: '2026-01-01T00:02:00' }],
      [{ id: 1, createdAt: '2026-01-01T00:01:00' }],
    ];
    let calls = 0;
    const mockLexicon = {
      getChannelMessages: async (channelId, limit, before) => {
        const page = pages[calls];
        calls++;
        return page || [];
      },
    };
    const result = await findMessageWindow(mockLexicon, 1, 1, { pageSize: 2, maxPages: 5 });
    assert(result.found === true, 'should eventually find id=1');
    assert(calls === 3, `should take exactly 3 pages, took ${calls}`);
  });

  await testAsync('gives up cleanly when the target does not exist', async () => {
    const mockLexicon = {
      getChannelMessages: async () => [{ id: 1, createdAt: '2026-01-01T00:01:00' }], // < pageSize, so "start of history"
    };
    const result = await findMessageWindow(mockLexicon, 1, 999, { pageSize: 50 });
    assert(result.found === false);
  });

  await testAsync('does not loop forever if `before` never advances', async () => {
    const mockLexicon = {
      getChannelMessages: async () => [{ id: 1, createdAt: '2026-01-01T00:01:00' }, { id: 2, createdAt: '2026-01-01T00:01:00' }],
    };
    let calls = 0;
    const wrapped = { getChannelMessages: async (...args) => { calls++; return mockLexicon.getChannelMessages(...args); } };
    const result = await findMessageWindow(wrapped, 1, 999, { pageSize: 2, maxPages: 10 });
    assert(result.found === false);
    assert(calls <= 2, `should bail out quickly, not loop maxPages times (calls=${calls})`);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('✅ All Phase 4 feature tests passed!');
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

run();
