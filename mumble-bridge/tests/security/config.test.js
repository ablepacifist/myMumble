'use strict';
/**
 * Shared-settings behaviour of src/config.js. Each case runs the config in a fresh child process (clean environment,
 * its own working directory) so nothing leaks between cases or in from the real machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG = path.join(__dirname, '..', '..', 'src', 'config.js');

function loadConfig({ master, own, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  try {
    const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTENV_CONFIG_QUIET: 'true', ...env };
    if (master !== undefined) {
      const file = path.join(dir, 'root.env');
      fs.writeFileSync(file, master);
      clean.MASTER_ENV_FILE = file;
    } else if (clean.MASTER_ENV_FILE === undefined) {
      clean.MASTER_ENV_FILE = ''; // never pick up a real root .env from the machine running the tests
    }
    if (own !== undefined) fs.writeFileSync(path.join(dir, '.env'), own);
    const out = execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CONFIG)})))`],
      { cwd: dir, env: clean, encoding: 'utf8' });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults: loopback only, port 3080, Lexicon on the same machine', () => {
  const c = loadConfig();
  assert.equal(c.ws.host, '127.0.0.1');
  assert.equal(c.ws.port, 3080);
  assert.equal(c.lexicon.apiUrl, 'http://127.0.0.1:36568');
});

test('BRIDGE_HOST can widen the listen address, BRIDGE_PORT beats the old WS_PORT', () => {
  const c = loadConfig({ env: { BRIDGE_HOST: '0.0.0.0', BRIDGE_PORT: '3999', WS_PORT: '3081' } });
  assert.equal(c.ws.host, '0.0.0.0');
  assert.equal(c.ws.port, 3999);
  assert.equal(loadConfig({ env: { WS_PORT: '3081' } }).ws.port, 3081, 'old name still works');
});

test('the Lexicon address follows LEXICON_PORT unless LEXICON_API_URL is set', () => {
  assert.equal(loadConfig({ env: { LEXICON_PORT: '40000' } }).lexicon.apiUrl, 'http://127.0.0.1:40000');
  assert.equal(loadConfig({ env: { LEXICON_PORT: '40000', LEXICON_API_URL: 'https://api.example.test' } }).lexicon.apiUrl,
    'https://api.example.test');
});

test('the root .env is read, and it wins over the bridge\'s own .env', () => {
  const c = loadConfig({
    master: 'LEXICON_PORT=41000\nSUPERUSER_NAMES=zx\nLEXICON_SERVICE_TOKEN=from-root\n',
    own: 'SUPERUSER_NAMES=someone-else\nLOG_LEVEL=debug\nLEXICON_SERVICE_TOKEN=from-own\n',
  });
  assert.equal(c.lexicon.apiUrl, 'http://127.0.0.1:41000');
  assert.deepEqual(c.superUsers, ['zx'], 'root value wins');
  assert.equal(c.lexicon.serviceToken, 'from-root', 'one shared service token, not two copies');
  assert.equal(c.logLevel, 'debug', 'the own file still fills in what the root file lacks');
});

test('a missing root .env file is not an error', () => {
  const c = loadConfig({ env: { MASTER_ENV_FILE: path.join(os.tmpdir(), 'does-not-exist-bridge.env') }, own: 'LOG_LEVEL=warn\n' });
  assert.equal(c.logLevel, 'warn');
});

test('an empty MASTER_ENV_FILE means no root file at all', () => {
  const c = loadConfig({ env: { MASTER_ENV_FILE: '' }, own: 'SUPERUSER_NAMES=alone\n' });
  assert.deepEqual(c.superUsers, ['alone']);
});

test('ffmpeg is found on the PATH unless FFMPEG_PATH says otherwise', () => {
  assert.equal(loadConfig().ffmpegPath, 'ffmpeg');
  assert.equal(loadConfig({ env: { FFMPEG_PATH: 'D:/tools/ffmpeg.exe' } }).ffmpegPath, 'D:/tools/ffmpeg.exe');
});

test('the transition switches keep their safe defaults', () => {
  const c = loadConfig();
  assert.equal(c.security.allowNameOnlyLogin, false);
  assert.equal(c.security.nameOnlyAdmin, false);
  assert.equal(c.security.allowLegacyAppUploads, false);
  assert.equal(c.security.cspMode, 'report-only');
});
