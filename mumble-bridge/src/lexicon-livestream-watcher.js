/**
 * SSE client for Lexicon's shared Livestream state (`GET /api/livestream/updates`).
 *
 * Confirmed live and working server-side (streams `event:init` then
 * `event:heartbeat`), but was completely unconsumed by the bridge before
 * this feature — there's no EventSource in Node, so this hand-parses the
 * `event:`/`data:` line format. node-fetch v2 (already a dependency here)
 * exposes `res.body` as a real Node Readable, so no extra dependency is
 * needed for that part either.
 *
 * Dispatch is schema-tolerant: it emits 'state' for ANY parsed payload that
 * looks like the livestream state shape (has currentMediaId/currentMedia),
 * not just one hardcoded `event:` name, since the exact event name used for
 * "track advanced" wasn't confirmed against the live server ahead of time.
 */
const EventEmitter = require('events');
const fetch = require('node-fetch');

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 5000;

class LivestreamWatcher extends EventEmitter {
  constructor(baseUrl) {
    super();
    this.baseUrl = baseUrl;
    this.stopped = true;
    this.abortController = null;
    this.reconnectTimer = null;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async _connect() {
    if (this.stopped) return;
    this.abortController = new AbortController();
    let buffer = '';
    try {
      const res = await fetch(`${this.baseUrl}/api/livestream/updates`, {
        headers: { Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS; // reset backoff on a successful connect

      for await (const chunk of res.body) {
        buffer += chunk.toString('utf8');
        let sepIdx;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          this._handleBlock(block);
        }
      }
      if (!this.stopped) this._scheduleReconnect(); // stream ended naturally
    } catch (err) {
      if (this.stopped) return; // expected — our own stop()/abort()
      console.error(`[Music] Livestream SSE error: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _handleBlock(block) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;

    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch (_) {
      return;
    }

    this.emit('sse', { event: eventName, data });

    const state = data.state || (('currentMediaId' in data || 'currentMedia' in data) ? data : null);
    if (state) this.emit('state', state);
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this._connect();
    }, this.reconnectDelay);
  }
}

module.exports = LivestreamWatcher;
