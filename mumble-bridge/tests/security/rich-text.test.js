'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { formatRichText } = load('features/rich-text/index.js');

// Any tag in the output must be one the formatter itself produces
const ALLOWED_TAGS = new Set(['strong', 'em', 'del', 'span', 'blockquote', 'pre', 'code']);
function tagsIn(html) {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());
}
function assertSafe(html) {
  for (const tag of tagsIn(html)) assert.ok(ALLOWED_TAGS.has(tag), `unexpected <${tag}> in: ${html}`);
  // only inside a real tag does an attribute matter (escaped text such as "&lt;img onerror=" is inert)
  assert.ok(!/<[^>]*\son\w+\s*=/i.test(html), `inline handler in a tag: ${html}`);
  assert.ok(!/<[^>]*(href|src)\s*=/i.test(html), `URL attribute in a tag: ${html}`);
}

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '**<img src=x onerror=alert(1)>**',
  '*<script>alert(1)</script>*',
  '~~<svg onload=alert(1)>~~',
  '||<iframe src=javascript:alert(1)>||',
  '> <img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '`<img src=x onerror=alert(1)>`',
  '```<img src=x onerror=alert(1)>```',
  '```"><script>alert(1)</script>\ncode```',
  '@<script>alert(1)</script>',
  '\u0000INLINE_0\u0000<img src=x onerror=alert(1)>',
  '\x00CODEBLOCK_0\x00',
  '<a href="javascript:alert(1)">x</a>',
  '&lt;script&gt; &amp; already-escaped',
];

test('no payload yields a tag or handler the formatter did not produce itself', () => {
  for (const p of PAYLOADS) assertSafe(formatRichText(p));
});

test('the exact stored-XSS case that used to work is neutralised', () => {
  const html = formatRichText('**<img src=x onerror=alert(1)>**');
  assert.equal(html, '<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
});

test('formatting still works', () => {
  assert.equal(formatRichText('**b** *i* ~~s~~'), '<strong>b</strong> <em>i</em> <del>s</del>');
  assert.equal(formatRichText('`a < b`'), '<code>a &lt; b</code>');
  assert.equal(formatRichText('```js\nlet x = "<b>";\n```'), '<pre><code class="lang-js">let x = &quot;&lt;b&gt;&quot;;</code></pre>');
  assert.equal(formatRichText('> quoted'), '<blockquote>quoted</blockquote>');
  assert.equal(formatRichText('hi @alex!'), 'hi <span class="mention">@alex</span>!');
  assert.equal(formatRichText('||secret||'), '<span class="spoiler">secret</span>');
  assert.equal(formatRichText(''), '');
  assert.equal(formatRichText(null), '');
});

test('spoilers carry no inline script', () => {
  assert.ok(!formatRichText('||x||').includes('onclick'));
});

test('markdown inside code is left alone and mentions inside code are not highlighted', () => {
  assert.equal(formatRichText('`**no** @bob`'), '<code>**no** @bob</code>');
});
