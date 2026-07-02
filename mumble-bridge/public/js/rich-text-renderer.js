/**
 * Rich Text Renderer (Frontend)
 * 
 * If server provides pre-rendered `msg.html`, use that.
 * Otherwise, apply client-side Markdown formatting as fallback.
 * 
 * Supports: **bold**, *italic*, ~~strike~~, ||spoiler||, `code`, ```code blocks```
 * 
 * Usage in chat.js:
 *   const { renderRichText } = window.RichTextRenderer;
 *   contentHtml = renderRichText(msg.text, msg.html);
 */
(function () {
  'use strict';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Client-side fallback Markdown renderer.
   * Used when server doesn't provide pre-rendered HTML.
   */
  function formatMarkdown(text) {
    if (!text) return '';

    // Extract code blocks first
    const codeBlocks = [];
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.push({ lang, code }) - 1;
      return `\x00CB_${idx}\x00`;
    });

    // Extract inline code
    const inlineCodes = [];
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.push(code) - 1;
      return `\x00IC_${idx}\x00`;
    });

    // Bold
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // Strikethrough
    processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Spoiler
    processed = processed.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
    // Blockquote
    processed = processed.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Restore inline code
    processed = processed.replace(/\x00IC_(\d+)\x00/g, (_, idx) => {
      return '<code>' + escapeHtml(inlineCodes[parseInt(idx)]) + '</code>';
    });

    // Restore code blocks
    processed = processed.replace(/\x00CB_(\d+)\x00/g, (_, idx) => {
      const block = codeBlocks[parseInt(idx)];
      return '<pre><code class="lang-' + (block.lang || 'text') + '">' + escapeHtml(block.code.trim()) + '</code></pre>';
    });

    return processed;
  }

  /**
   * Render rich text for a message.
   * Prefers server-rendered HTML if available, falls back to client-side formatting.
   * Also highlights @mentions.
   * 
   * @param {string} rawText - The raw message text
   * @param {string|undefined} serverHtml - Pre-rendered HTML from server (optional)
   * @returns {string} Safe HTML string
   */
  function renderRichText(rawText, serverHtml) {
    let html = serverHtml || (rawText ? formatMarkdown(rawText) : '');
    // Highlight @mentions (after other formatting, but only outside HTML tags)
    html = html.replace(/@(\w{1,32})/g, '<span class="mention">@$1</span>');
    return html;
  }

  // Expose globally
  window.RichTextRenderer = { renderRichText, formatMarkdown, escapeHtml };
})();
