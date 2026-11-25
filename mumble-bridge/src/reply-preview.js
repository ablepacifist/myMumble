/**
 * Reply previews: the small "replying to Alice: …" card shown above a reply.
 *
 * The bridge builds it from Lexicon's stored copy of the original message and sends it
 * with every reply (live and in history), so no client has to find the original itself.
 * Before this, a reply carried only `replyToId`: the web client could draw it only when
 * the original happened to be on screen, and the Android app not at all.
 *
 * A reply may only point at a message in the same channel. Anything else is dropped, so
 * a crafted `replyToMessageId` can never pull text out of a channel the sender can't see.
 */

const PREVIEW_MAX = 140;
const MAX_LOOKUPS_PER_BATCH = 25;

/** One line of plain text from a stored message, for the preview. */
function previewText(message) {
  if (!message) return '';
  if (message.deletedAt) return 'Original message was deleted';
  const raw = typeof message.content === 'string' ? message.content : '';
  let text = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!text) {
    const type = String(message.messageType || '').toUpperCase();
    text = type === 'IMAGE' || type === 'GIF' ? '[image]' : '';
  }
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX - 1) + '…' : text;
}

/** The preview card for a stored message, or null if it is not in `channelId`. */
function previewOf(message, channelId) {
  if (!message || message.id == null) return null;
  if (Number(message.channelId) !== Number(channelId)) return null;
  return {
    id: String(message.id),
    username: message.username || message.senderName || 'Unknown',
    text: previewText(message),
  };
}

function isMessageId(value) {
  return value != null && /^[0-9]{1,18}$/.test(String(value));
}

/**
 * Looks up the message a new reply points at. Returns null (and the caller should drop the
 * reply link) when the id is malformed, the message does not exist, or it is in another channel.
 */
async function resolveReplyPreview(lexicon, replyToId, channelId) {
  if (!isMessageId(replyToId)) return null;
  try {
    const original = await lexicon.getMessage(String(replyToId));
    return previewOf(original, channelId);
  } catch (err) {
    console.error(`[Reply] Lookup of message ${replyToId} failed: ${err.message}`);
    return null;
  }
}

/**
 * Adds `replyTo` to every reply in a history batch. Originals inside the batch are used
 * directly; the rest are fetched (capped, so one huge thread can't fan out unbounded).
 * Mutates and returns `messages`.
 */
async function attachReplyPreviews(lexicon, messages, channelId) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const byId = new Map(messages.filter((m) => m && m.id != null).map((m) => [String(m.id), m]));
  const missing = new Set();
  for (const m of messages) {
    if (m && isMessageId(m.replyToId) && !byId.has(String(m.replyToId))) missing.add(String(m.replyToId));
  }

  const fetched = new Map();
  for (const id of [...missing].slice(0, MAX_LOOKUPS_PER_BATCH)) {
    try {
      fetched.set(id, await lexicon.getMessage(id));
    } catch (_) {
      // Leave it out; the client still shows that it was a reply.
    }
  }

  for (const m of messages) {
    if (!m || !isMessageId(m.replyToId)) continue;
    const id = String(m.replyToId);
    const preview = previewOf(byId.get(id) || fetched.get(id), channelId);
    m.replyTo = preview || { id, username: null, text: '' };
  }
  return messages;
}

/** Plain-text quote line for native Mumble clients, which have no reply concept. */
function mumbleQuoteHtml(replyTo, escapeHtml) {
  if (!replyTo) return '';
  const who = escapeHtml(replyTo.username || 'someone');
  const text = escapeHtml(replyTo.text || '');
  return `<i>↪ ${who}: ${text}</i><br>`;
}

module.exports = {
  PREVIEW_MAX,
  previewText,
  previewOf,
  isMessageId,
  resolveReplyPreview,
  attachReplyPreviews,
  mumbleQuoteHtml,
};
