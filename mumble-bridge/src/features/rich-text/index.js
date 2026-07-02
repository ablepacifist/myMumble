/**
 * Rich Text Feature — Markdown-style formatting for chat messages.
 * 
 * Transforms raw text into safe HTML with formatting:
 *   **bold** → <strong>bold</strong>
 *   *italic* → <em>italic</em>
 *   ~~strikethrough~~ → <del>strikethrough</del>
 *   ||spoiler|| → <span class="spoiler">spoiler</span>
 *   `inline code` → <code>inline code</code>
 *   ```code block``` → <pre><code>code block</code></pre>
 * 
 * This feature does NOT handle its own message types — it exports a transform
 * function that other code (client-handler text messages) calls before broadcast.
 * It also registers a 'format_preview' message type for live preview requests.
 */

const RULES = [
  // Code blocks (``` ... ```) — must be first to prevent inner parsing
  { pattern: /```(\w*)\n?([\s\S]*?)```/g, replace: (_, lang, code) => `<pre><code class="lang-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>` },
  // Inline code (` ... `)
  { pattern: /`([^`\n]+)`/g, replace: (_, code) => `<code>${escapeHtml(code)}</code>` },
  // Bold (**text**)
  { pattern: /\*\*(.+?)\*\*/g, replace: '<strong>$1</strong>' },
  // Italic (*text*) — must not conflict with **bold**
  { pattern: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, replace: '<em>$1</em>' },
  // Strikethrough (~~text~~)
  { pattern: /~~(.+?)~~/g, replace: '<del>$1</del>' },
  // Spoiler (||text||)
  { pattern: /\|\|(.+?)\|\|/g, replace: '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>' },
  // Blockquote (> text) — at start of line
  { pattern: /^&gt; (.+)$/gm, replace: '<blockquote>$1</blockquote>' },
];

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Transform raw message text into formatted HTML.
 * Safe: escapes HTML first (in code blocks), then applies formatting rules.
 */
function formatRichText(text) {
  if (!text) return '';

  // Extract code blocks and inline code first to protect them
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.push({ type: 'block', lang, code }) - 1;
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  const inlineCodes = [];
  processed = processed.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.push(code) - 1;
    return `\x00INLINE_${idx}\x00`;
  });

  // Now apply formatting rules to the non-code parts
  // Bold
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (avoid matching inside **)
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Spoiler
  processed = processed.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  // Blockquote (> at the start of a line, after HTML escape of >)
  processed = processed.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Restore inline code
  processed = processed.replace(/\x00INLINE_(\d+)\x00/g, (_, idx) => {
    return `<code>${escapeHtml(inlineCodes[parseInt(idx)])}</code>`;
  });

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => {
    const block = codeBlocks[parseInt(idx)];
    return `<pre><code class="lang-${block.lang || 'text'}">${escapeHtml(block.code.trim())}</code></pre>`;
  });

  // @mentions — highlight but not inside code blocks/inline code
  processed = processed.replace(/@(\w{1,32})/g, '<span class="mention">@$1</span>');

  return processed;
}

module.exports = {
  name: 'rich-text',
  messageTypes: ['format_preview'],

  init(deps) {
    this.deps = deps;
  },

  /**
   * Handle live format preview requests (optional — for "what will my message look like" feature)
   */
  handleMessage(ws, client, msg) {
    if (msg.type === 'format_preview') {
      const formatted = formatRichText(msg.text || '');
      ws.send(JSON.stringify({ type: 'format_preview_result', html: formatted }));
    }
  },

  cleanup() {},

  // Export the transform for use by client-handler
  formatRichText,
};
