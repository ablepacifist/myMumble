#!/usr/bin/env node
/**
 * Test: Feature Registry + Rich Text + Typing
 * 
 * Tests Phase 1 features offline (no running server needed):
 *   1. Feature registry loads modules from src/features/
 *   2. Rich-text Markdown formatting works correctly
 *   3. Typing module has correct interface
 */

const path = require('path');
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

// ── Test 1: Feature Registry ────────────────────────────
console.log('\n=== Feature Registry ===');

const registry = require(path.join(__dirname, '..', 'src', 'feature-registry'));

assert(registry.features instanceof Map, 'features is a Map');
assert(registry.typeMap instanceof Map, 'typeMap is a Map');
assert(typeof registry.init === 'function', 'init is a function');
assert(typeof registry.route === 'function', 'route is a function');
assert(typeof registry.cleanup === 'function', 'cleanup is a function');

// ── Test 2: Rich Text Module ────────────────────────────
console.log('\n=== Rich Text Feature ===');

const richText = require(path.join(__dirname, '..', 'src', 'features', 'rich-text'));

assert(richText.name === 'rich-text', 'module name is "rich-text"');
assert(Array.isArray(richText.messageTypes), 'messageTypes is an array');
assert(richText.messageTypes.includes('format_preview'), 'handles format_preview');
assert(typeof richText.formatRichText === 'function', 'exports formatRichText function');
assert(typeof richText.handleMessage === 'function', 'exports handleMessage function');

// Formatting tests
const fmt = richText.formatRichText;

assert(fmt('**bold**').includes('<strong>bold</strong>'), '**bold** → <strong>');
assert(fmt('*italic*').includes('<em>italic</em>'), '*italic* → <em>');
assert(fmt('~~strike~~').includes('<del>strike</del>'), '~~strike~~ → <del>');
assert(fmt('||spoiler||').includes('class="spoiler"'), '||spoiler|| → .spoiler');
assert(fmt('`code`').includes('<code>'), '`code` → <code>');
assert(fmt('```\nblock\n```').includes('<pre>'), '```block``` → <pre>');

// Mixed formatting
const mixed = fmt('Hello **world** and *italic*');
assert(mixed.includes('<strong>world</strong>'), 'mixed: bold works');
assert(mixed.includes('<em>italic</em>'), 'mixed: italic works');

// Code blocks should NOT have inner formatting
const codeBlock = fmt('```\n**not bold**\n```');
assert(!codeBlock.includes('<strong>'), 'code block protects inner content');

// Empty/null safety
assert(fmt('') === '', 'empty string returns empty');
assert(fmt(null) === '', 'null returns empty');

// ── Test 3: Typing Module ───────────────────────────────
console.log('\n=== Typing Feature ===');

const typing = require(path.join(__dirname, '..', 'src', 'features', 'typing'));

assert(typing.name === 'typing', 'module name is "typing"');
assert(Array.isArray(typing.messageTypes), 'messageTypes is an array');
assert(typing.messageTypes.includes('typing_start'), 'handles typing_start');
assert(typing.messageTypes.includes('typing_stop'), 'handles typing_stop');
assert(typeof typing.handleMessage === 'function', 'exports handleMessage function');
assert(typeof typing.init === 'function', 'exports init function');
assert(typeof typing.cleanup === 'function', 'exports cleanup function');

// ── Results ─────────────────────────────────────────────
console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);
if (failed > 0) {
  console.log(`❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('✅ All Phase 1 feature tests passed!');
}
