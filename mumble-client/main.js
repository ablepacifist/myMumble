/**
 * MumbleChat — Electron main process.
 *
 * Manages the Mumble TLS connection, audio mixer, Lexicon API,
 * and IPC with the renderer process.
 *
 * Architecture:
 *   Renderer mic → IPC → Opus encode → Mumble UDPTunnel
 *   Mumble UDPTunnel → Opus decode → mixer → IPC → Renderer speakers
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

// Linux sandbox workaround — avoids needing SUID chrome-sandbox
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const Store = require('electron-store');
const MumbleConnection = require('./src/mumble/connection');
const LexiconClient = require('./src/mumble/lexicon');

const store = new Store();

let mainWindow = null;
let mumble = null;
let lexicon = null;
let currentUser = null; // { id, username, displayName }

// ── Audio Mixer State ──
// Accumulator-based mixer (matches the bridge's proven approach).
// All decoded PCM is additively mixed into a single 960-sample buffer.
// Every 20ms the buffer is flushed to the renderer and reset to zero.
const MIX_FRAME = 960;
let mixBuf = new Int16Array(MIX_FRAME);
let mixDirty = false;
let mixerInterval = null;
let decoderCleanupInterval = null;

// ── Default Config ──
const DEFAULT_CONFIG = {
  mumbleHost: 'group-wildness.gl.at.ply.gg',
  mumblePort: 58938,
  lexiconUrl: 'http://147.185.221.24:15856',
  bridgeUrl: 'https://voice.alex-dyakin.com',
  superUsers: ['alex'],
};

// ── Window ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: store.get('windowWidth', 1200),
    height: store.get('windowHeight', 800),
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    titleBarStyle: 'default',
    backgroundColor: '#1e1f22',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Process gone:', details);
    dialog.showErrorBox('MumbleChat', `Renderer crashed (${details.reason || 'unknown'}). Restarting window...`);
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else {
      mainWindow.reload();
    }
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowWidth', w);
    store.set('windowHeight', h);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (mumble) {
      mumble.disconnect();
      mumble = null;
    }
    stopMixer();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err);
  dialog.showErrorBox('MumbleChat', `Main process error:\n${err?.stack || err?.message || String(err)}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: Connection ──

ipcMain.handle('mumble:connect', async (_event, { host, port, username }) => {
  // Disconnect existing
  if (mumble) {
    mumble.disconnect();
    mumble = null;
  }
  stopMixer();

  // Set up Lexicon
  const lexiconUrl = store.get('lexiconUrl', DEFAULT_CONFIG.lexiconUrl);
  lexicon = new LexiconClient(lexiconUrl);

  // Register / look up user
  try {
    currentUser = await lexicon.getOrCreateUser(username);
  } catch (_) {
    currentUser = { id: null, username, displayName: username };
  }

  const isSuperUser = DEFAULT_CONFIG.superUsers.includes(username.toLowerCase());

  // Connect to Mumble
  mumble = new MumbleConnection({
    host: host || store.get('mumbleHost', DEFAULT_CONFIG.mumbleHost),
    port: port || store.get('mumblePort', DEFAULT_CONFIG.mumblePort),
    username,
  });

  // Forward Mumble events → renderer
  mumble.on('ready', (data) => {
    send('mumble:ready', {
      ...data,
      userId: currentUser.id,
      username: currentUser.displayName || username,
      isAdmin: isSuperUser,
    });
    // Send all channels and users accumulated during handshake
    for (const [, ch] of mumble.channels) {
      send('mumble:channel-state', ch);
    }
    for (const [, user] of mumble.users) {
      send('mumble:user-state', user);
    }
  });

  mumble.on('channelState', (ch) => send('mumble:channel-state', ch));
  mumble.on('channelRemove', (id) => send('mumble:channel-remove', id));
  mumble.on('userState', (user) => send('mumble:user-state', user));
  mumble.on('userRemove', (data) => send('mumble:user-remove', data));

  mumble.on('textMessage', (msg) => {
    send('mumble:text-message', msg);
  });

  mumble.on('error', (err) => send('mumble:error', err.message || String(err)));
  mumble.on('disconnected', () => {
    send('mumble:disconnected');
    stopMixer();
  });

  // Audio from Mumble → mix into accumulator buffer immediately.
  // This is the critical fix from the bridge: instead of queuing frames
  // per-sender and popping one per tick (which falls behind on bursts),
  // we additively mix ALL incoming PCM into a single buffer that gets
  // flushed every 20ms.
  mumble.on('audio', ({ senderSession, pcm }) => {
    voiceDiag.audioIn++;
    const len = Math.min(pcm.length, MIX_FRAME);
    for (let i = 0; i < len; i++) {
      const sum = mixBuf[i] + pcm[i];
      mixBuf[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
    }
    mixDirty = true;
  });

  try {
    await mumble.connect();
    startMixer();
    return { success: true, session: mumble.session };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('mumble:disconnect', () => {
  if (mumble) {
    mumble.disconnect();
    mumble = null;
  }
  stopMixer();
  currentUser = null;
});

// ── IPC: Text ──

ipcMain.on('mumble:send-text', (_event, { channelIds, message }) => {
  if (!mumble || !mumble.ready) return;

  // Send via Mumble protocol
  mumble.sendTextMessage(channelIds, `<b>${currentUser?.displayName || currentUser?.username || 'Unknown'}:</b> ${message}`);

  // Persist via Lexicon API
  if (lexicon && currentUser) {
    const chName = mumble.channels.get(channelIds[0])?.name || '';
    lexicon.storeMessage({
      channelId: channelIds[0],
      channelName: chName,
      userId: currentUser.id || 0,
      username: currentUser.displayName || currentUser.username,
      content: message,
    }).catch(() => {});
  }
});

// ── IPC: Channels ──

ipcMain.on('mumble:move-channel', (_event, channelId) => {
  if (mumble && mumble.ready) mumble.moveToChannel(channelId);
});

ipcMain.on('mumble:create-channel', (_event, { parentId, name }) => {
  if (mumble && mumble.ready) mumble.createChannel(parentId, name);
});

ipcMain.on('mumble:remove-channel', (_event, channelId) => {
  if (mumble && mumble.ready) mumble.removeChannel(channelId);
});

// ── IPC: Voice state ──

ipcMain.on('mumble:set-self-mute', (_event, muted) => {
  if (mumble && mumble.ready) mumble.setSelfMute(muted);
});

ipcMain.on('mumble:set-self-deaf', (_event, deafened) => {
  if (mumble && mumble.ready) mumble.setSelfDeaf(deafened);
});

// ── IPC: Audio from renderer ──

ipcMain.on('mumble:audio-data', (_event, pcmBuffer) => {
  if (!mumble || !mumble.ready) return;
  const int16 = new Int16Array(pcmBuffer);
  // Send in 960-sample frames
  for (let offset = 0; offset + 960 <= int16.length; offset += 960) {
    mumble.sendAudio(int16.slice(offset, offset + 960));
  }
});

// ── IPC: Message History ──

ipcMain.handle('mumble:get-history', async (_event, { channelId, limit }) => {
  if (!lexicon) return [];
  try {
    return await lexicon.getChannelMessages(channelId, limit || 50);
  } catch (_) {
    return [];
  }
});

// ── IPC: Avatar ──

const avatarCache = new Map(); // username → { url, fetchedAt }
const AVATAR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

ipcMain.handle('mumble:get-avatar', async (_event, username) => {
  // Check cache
  const cached = avatarCache.get(username);
  if (cached && Date.now() - cached.fetchedAt < AVATAR_CACHE_TTL) {
    return cached.url;
  }

  if (!lexicon) return null;
  try {
    const bridgeUrl = store.get('bridgeUrl', DEFAULT_CONFIG.bridgeUrl);
    const avatarPath = await lexicon.getAvatar(username, bridgeUrl);
    if (avatarPath) {
      const fullUrl = `${bridgeUrl}${avatarPath}`;
      avatarCache.set(username, { url: fullUrl, fetchedAt: Date.now() });
      return fullUrl;
    }
  } catch (_) {}
  return null;
});

// ── IPC: Voice Diagnostics ──

const voiceDiag = {
  mixFlush: 0,
  mixDrop: 0,
  audioIn: 0,
  audioOut: 0,
  startTime: Date.now(),
};

ipcMain.handle('mumble:get-voice-diag', () => {
  const uptime = Math.round((Date.now() - voiceDiag.startTime) / 1000);
  return {
    ...voiceDiag,
    uptime,
    activeDecoders: mumble?.voice?.decoderCount || 0,
    connected: mumble?.ready || false,
  };
});

// ── IPC: Settings ──

ipcMain.handle('mumble:get-config', () => ({
  mumbleHost: store.get('mumbleHost', DEFAULT_CONFIG.mumbleHost),
  mumblePort: store.get('mumblePort', DEFAULT_CONFIG.mumblePort),
  lexiconUrl: store.get('lexiconUrl', DEFAULT_CONFIG.lexiconUrl),
  bridgeUrl: store.get('bridgeUrl', DEFAULT_CONFIG.bridgeUrl),
}));

ipcMain.on('mumble:set-config', (_event, config) => {
  if (config.mumbleHost) store.set('mumbleHost', config.mumbleHost);
  if (config.mumblePort) store.set('mumblePort', config.mumblePort);
  if (config.lexiconUrl) store.set('lexiconUrl', config.lexiconUrl);
});

// ── Audio Mixer ──

function startMixer() {
  stopMixer();

  // Flush the mix buffer every 20ms (one Opus frame duration).
  // Only sends if at least one sender contributed audio this window.
  mixerInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mixDirty) return;

    // Copy the buffer before sending (it gets cleared immediately)
    const out = Buffer.from(mixBuf.buffer, mixBuf.byteOffset, mixBuf.byteLength);
    send('mumble:audio-data', Buffer.from(out));
    voiceDiag.mixFlush++;

    // Reset for next 20ms window
    mixBuf.fill(0);
    mixDirty = false;
  }, 20);

  // Clean up idle Opus decoders every 30s (60s idle timeout)
  decoderCleanupInterval = setInterval(() => {
    if (mumble && mumble.voice) mumble.voice.cleanupIdleDecoders(60000);
  }, 30000);
}

function stopMixer() {
  if (mixerInterval) {
    clearInterval(mixerInterval);
    mixerInterval = null;
  }
  if (decoderCleanupInterval) {
    clearInterval(decoderCleanupInterval);
    decoderCleanupInterval = null;
  }
  mixBuf.fill(0);
  mixDirty = false;
  voiceDiag.startTime = Date.now();
  voiceDiag.mixFlush = 0;
  voiceDiag.mixDrop = 0;
  voiceDiag.audioIn = 0;
  voiceDiag.audioOut = 0;
}

// ── Helpers ──

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
