/**
 * Jump-to-message support: Lexicon's message API only offers "give me N
 * messages before timestamp X" (no "around X" or "after X" primitive), so
 * finding a specific message means paging backward with a shrinking
 * `before` cursor until the target id shows up in a page.
 */

const PAGE_SIZE = 50;
const MAX_PAGES = 10; // caps worst case at ~500 messages / ~10 Lexicon round trips

function messageTimestamp(m) {
  return m.createdAt || m.sentAt || m.timestamp || null;
}

/**
 * Page backward through a channel's history until `targetMessageId` is
 * found. Returns { found: true, messages } (the full window collected up
 * to and including the page containing the target) or { found: false }.
 */
async function findMessageWindow(lexicon, channelId, targetMessageId, opts = {}) {
  const pageSize = opts.pageSize || PAGE_SIZE;
  const maxPages = opts.maxPages || MAX_PAGES;
  const targetKey = String(targetMessageId);
  let before = null;
  const seenIds = new Set();
  const collected = [];

  for (let page = 0; page < maxPages; page++) {
    const batch = await lexicon.getChannelMessages(channelId, pageSize, before);
    if (!batch || batch.length === 0) break;

    let newCount = 0;
    let oldestTs = null;
    for (const m of batch) {
      const key = String(m.id);
      if (!seenIds.has(key)) {
        seenIds.add(key);
        collected.push(m);
        newCount++;
      }
      const ts = messageTimestamp(m);
      if (ts && (oldestTs === null || new Date(ts) < new Date(oldestTs))) oldestTs = ts;
    }

    if (batch.some((m) => String(m.id) === targetKey)) {
      return { found: true, messages: collected };
    }
    if (newCount === 0) break;         // `before` isn't advancing — bail out rather than loop forever
    if (batch.length < pageSize) break; // hit the start of channel history
    if (!oldestTs) break;               // can't form a next cursor
    before = oldestTs;
  }

  return { found: false, messages: [] };
}

module.exports = { findMessageWindow };
