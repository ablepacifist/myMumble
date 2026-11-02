/**
 * Helpers for the offline security tests. Nothing here touches MySQL, Mumble, Lexicon or the internet:
 * modules that would are replaced by in-memory stand-ins before the code under test is loaded.
 *
 * Run: node --test tests/security
 */
'use strict';

const path = require('path');

// Never read a real .env, and keep dotenv quiet
process.env.DOTENV_CONFIG_QUIET = 'true';

const SRC = path.join(__dirname, '..', '..', 'src');

/** Replace a src module with a stand-in (must be called before anything requires it). */
function stub(name, exports) {
  const file = require.resolve(path.join(SRC, name));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  return exports;
}

/** Load a src module fresh (after stubs are in place). */
function load(name) {
  return require(path.join(SRC, name));
}

/** A fake WebSocket that records everything sent to it. */
function fakeWs() {
  const sent = [];
  return {
    sent,
    readyState: 1,
    send(data) { sent.push(typeof data === 'string' ? JSON.parse(data) : data); },
    close() { this.closed = true; },
    last() { return sent[sent.length - 1]; },
    ofType(type) { return sent.filter((m) => m.type === type); },
  };
}

/** A minimal database stand-in. */
function fakeDatabase(overrides = {}) {
  const mappings = [];
  return {
    mappings,
    getBridgePool: () => ({ execute: async (sql, params) => { mappings.push(params); return [[], []]; } }),
    getMumblePool: () => ({ execute: async () => [[], []] }),
    getAvatarPath: async () => null,
    setAvatarPath: async () => {},
    removeAvatarPath: async () => {},
    createSessionPersistence: () => null,
    initBridgeDatabase: async () => {},
    ...overrides,
  };
}

module.exports = { stub, load, fakeWs, fakeDatabase, SRC };
