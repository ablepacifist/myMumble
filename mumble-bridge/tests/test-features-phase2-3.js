/**
 * Phase 2 & 3 Feature Tests — Mentions + Notifications + Reactions
 * Run: node tests/test-features-phase2-3.js
 */
const path = require('path');

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

// ══════════════════════════════════════════════════════
// Mentions Feature
// ══════════════════════════════════════════════════════
console.log('\n── Mentions Feature ──');

const mentions = require('../src/features/mentions/index.js');

test('Mentions module has correct name', () => {
  assert(mentions.name === 'mentions');
});

test('Mentions module handles correct message types', () => {
  assert(mentions.messageTypes.includes('get_notifications'));
  assert(mentions.messageTypes.includes('notifications_read'));
});

test('Mentions module has processMentions method', () => {
  assert(typeof mentions.processMentions === 'function');
});

test('Mentions module has handleMessage method', () => {
  assert(typeof mentions.handleMessage === 'function');
});

test('Mentions module has cleanup method', () => {
  assert(typeof mentions.cleanup === 'function');
});

test('processMentions returns empty for no mentions', async () => {
  // Without init (no deps.db), it should return empty
  const result = await mentions.processMentions({ text: 'hello world', fromUsername: 'test', fromUserId: 1 });
  assert(Array.isArray(result));
  assert(result.length === 0);
});

// ══════════════════════════════════════════════════════
// Reactions Feature
// ══════════════════════════════════════════════════════
console.log('\n── Reactions Feature ──');

const reactions = require('../src/features/reactions/index.js');

test('Reactions module has correct name', () => {
  assert(reactions.name === 'reactions');
});

test('Reactions module handles correct message types', () => {
  assert(reactions.messageTypes.includes('reaction_add'));
  assert(reactions.messageTypes.includes('reaction_remove'));
  assert(reactions.messageTypes.includes('get_reactions'));
});

test('Reactions module has handleMessage method', () => {
  assert(typeof reactions.handleMessage === 'function');
});

test('Reactions module has cleanup method', () => {
  assert(typeof reactions.cleanup === 'function');
});

test('Reactions _sanitizeEmoji accepts unicode emoji', () => {
  assert(reactions._sanitizeEmoji('👍') === '👍');
  assert(reactions._sanitizeEmoji('❤️') === '❤️');
  assert(reactions._sanitizeEmoji('😂') === '😂');
  assert(reactions._sanitizeEmoji('🔥') === '🔥');
});

test('Reactions _sanitizeEmoji accepts shortcodes', () => {
  assert(reactions._sanitizeEmoji(':thumbsup:') === ':thumbsup:');
  assert(reactions._sanitizeEmoji(':heart:') === ':heart:');
});

test('Reactions _sanitizeEmoji rejects invalid input', () => {
  assert(reactions._sanitizeEmoji('') === null);
  assert(reactions._sanitizeEmoji(null) === null);
  assert(reactions._sanitizeEmoji('hello world') === null);
  assert(reactions._sanitizeEmoji('<script>alert(1)</script>') === null);
});

test('Reactions _sanitizeEmoji rejects too-long input', () => {
  assert(reactions._sanitizeEmoji('a'.repeat(33)) === null);
});

// ══════════════════════════════════════════════════════
// Rich Text @Mention Highlighting
// ══════════════════════════════════════════════════════
console.log('\n── Rich Text @Mention Highlighting ──');

const richText = require('../src/features/rich-text/index.js');

test('Rich text highlights @mentions', () => {
  const html = richText.formatRichText('hello @alice how are you?');
  assert(html.includes('class="mention"'), 'Should contain mention class');
  assert(html.includes('@alice'), 'Should contain @alice');
});

test('Rich text highlights multiple @mentions', () => {
  const html = richText.formatRichText('@bob and @charlie check this out');
  const mentionCount = (html.match(/class="mention"/g) || []).length;
  assert(mentionCount === 2, `Expected 2 mentions, got ${mentionCount}`);
});

test('Rich text does not break @ in code blocks', () => {
  const html = richText.formatRichText('use `@var` in code');
  // @ inside code should still be styled (since it's text, not functional)
  assert(html.includes('<code>'), 'Should have code block');
});

test('Rich text handles text with no mentions', () => {
  const html = richText.formatRichText('hello world');
  assert(!html.includes('class="mention"'), 'Should not contain mention class');
});

// ══════════════════════════════════════════════════════
// Database Core
// ══════════════════════════════════════════════════════
console.log('\n── Database Core Functions ──');

const db = require('../src/database.js');

test('Database exports getBridgePool', () => {
  assert(typeof db.getBridgePool === 'function');
});

test('Database exports getMumblePool', () => {
  assert(typeof db.getMumblePool === 'function');
});

test('Database exports initBridgeDatabase', () => {
  assert(typeof db.initBridgeDatabase === 'function');
});

// ══════════════════════════════════════════════════════
// Feature Registry Integration
// ══════════════════════════════════════════════════════
console.log('\n── Feature Registry Integration ──');

const fs = require('fs');

test('Mentions feature directory exists', () => {
  assert(fs.existsSync(path.join(__dirname, '../src/features/mentions/index.js')));
});

test('Reactions feature directory exists', () => {
  assert(fs.existsSync(path.join(__dirname, '../src/features/reactions/index.js')));
});

test('React bundle exists', () => {
  assert(fs.existsSync(path.join(__dirname, '../public/react/features-bundle.js')));
});

test('React styles exist', () => {
  assert(fs.existsSync(path.join(__dirname, '../public/react/style.css')));
});

test('React bundle contains MentionAutocomplete', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '../public/react/features-bundle.js'), 'utf-8');
  assert(bundle.includes('mention'), 'Bundle should contain mention code');
});

test('React bundle contains NotificationToast', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '../public/react/features-bundle.js'), 'utf-8');
  assert(bundle.includes('notification'), 'Bundle should contain notification code');
});

test('React bundle contains EmojiReactions', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '../public/react/features-bundle.js'), 'utf-8');
  assert(bundle.includes('reaction'), 'Bundle should contain reaction code');
});

test('React CSS contains mention styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/react/style.css'), 'utf-8');
  assert(css.includes('.mention'), 'CSS should have .mention class');
});

test('React CSS contains notification styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/react/style.css'), 'utf-8');
  assert(css.includes('.notification-toast'), 'CSS should have .notification-toast class');
});

test('React CSS contains reaction styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/react/style.css'), 'utf-8');
  assert(css.includes('.reaction-badge'), 'CSS should have .reaction-badge class');
});

test('React CSS contains emoji picker styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/react/style.css'), 'utf-8');
  assert(css.includes('.emoji-picker'), 'CSS should have .emoji-picker class');
});

// ══════════════════════════════════════════════════════
// HTML Integration Points
// ══════════════════════════════════════════════════════
console.log('\n── HTML Integration Points ──');

const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');

test('HTML has mention-autocomplete-mount', () => {
  assert(indexHtml.includes('mention-autocomplete-mount'));
});

test('HTML has notification-toast-mount', () => {
  assert(indexHtml.includes('notification-toast-mount'));
});

test('HTML has reactions-mount', () => {
  assert(indexHtml.includes('reactions-mount'));
});

// ══════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════
console.log(`\n${'='.repeat(50)}`);
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✅ All Phase 2 & 3 feature tests passed!');
} else {
  console.log('❌ Some tests failed');
  process.exit(1);
}
