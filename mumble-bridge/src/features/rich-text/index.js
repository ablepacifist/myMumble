/**
 * Rich Text Feature — Markdown-style formatting for chat messages.
 *
 * Transforms raw text into safe HTML with formatting:
 *   **bold** → <strong>bold</strong>
 *   *italic* → <em>italic</em>
 *   ~~strikethrough~~ → <del>strikethrough</del>
 *   ||spoiler|| → <span class="spoiler">spoiler</span>   (the page toggles it with a click handler; no inline script)
 *   `inline code` → <code>inline code</code>
 *   ```code block``` → <pre><code>code block</code></pre>
 *
 * The output is safe to insert as HTML: every character of the user's text is escaped first, and the only tags
 * in the result are the ones produced above.
 *
 * This feature does NOT handle its own message types — it exports a transform
 * function that other code (client-handler text messages) calls before broadcast.
 * It also registers a 'format_preview' message type for live preview requests.
 */

const { escapeHtml } = require('../../security');

/**
 * Transform raw message text into formatted HTML.
 * Code is pulled out first (so markdown inside it is left alone), everything else is escaped as plain text,
 * then the formatting rules run on the escaped text, and finally the code is put back (escaped).
 */
function formatRichText(text) {
  if (!text) return '';

  // NUL is used for the placeholders below, so it must not be present in the input
  let processed = String(text).replace(/\u0000/g, '');

  const codeBlocks = [];
  processed = processed.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.push({ lang, code }) - 1;
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  const inlineCodes = [];
  processed = processed.replace(/`([^`\n]+)`/g, (match, code) => {
    const idx = inlineCodes.push(code) - 1;
    return `\x00INLINE_${idx}\x00`;
  });

  // Everything that is not code becomes inert text; from here on the only markup is what the rules add
  processed = escapeHtml(processed);

  // Bold
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic (avoid matching inside **)
  processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Spoiler (revealed by the page's click handler)
  processed = processed.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');
  // Blockquote ("> " at the start of a line; the > has already been escaped)
  processed = processed.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // @mentions — highlight, before the code is restored so code is left untouched
  processed = processed.replace(/@(\w{1,32})/g, '<span class="mention">@$1</span>');

  // Restore inline code
  processed = processed.replace(/\x00INLINE_(\d+)\x00/g, (_, idx) => {
    return `<code>${escapeHtml(inlineCodes[parseInt(idx)])}</code>`;
  });

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => {
    const block = codeBlocks[parseInt(idx)];
    if (!block) return '';
    return `<pre><code class="lang-${block.lang || 'text'}">${escapeHtml(block.code.trim())}</code></pre>`;
  });

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
      const formatted = formatRichText(typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '');
      ws.send(JSON.stringify({ type: 'format_preview_result', html: formatted }));
    }
  },

  cleanup() {},

  // Export the transform for use by client-handler
  formatRichText,
};
