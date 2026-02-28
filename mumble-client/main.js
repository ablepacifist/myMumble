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
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const MumbleConnection = require('./src/mumble/connection');
const LexiconClient = require('./src/mumble/lexicon');

const store = new Store();

let mainWindow = null;
let mumble = null;
let lexicon = null;
let currentUser = null; // { id, username, displayName }

// ── Audio Mixer State ──
const senderQueues = new Map(); // senderSession → Int16Array[]
let mixerInterval = null;

// ── Default Config ──
const DEFAULT_CONFIG = {
  mumbleHost: '127.0.0.1',
  mumblePort: 64738,
  lexiconUrl: 'http://147.185.221.24:15856',
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

  // Audio from Mumble → queue for mixer
  mumble.on('audio', ({ senderSession, pcm }) => {
    if (!senderQueues.has(senderSession)) {
      senderQueues.set(senderSession, []);
    }
    const queue = senderQueues.get(senderSession);
    queue.push(pcm);
    // Cap at 10 frames (200ms) to prevent memory buildup
    while (queue.length > 10) queue.shift();
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

// ── IPC: Settings ──

ipcMain.handle('mumble:get-config', () => ({
  mumbleHost: store.get('mumbleHost', DEFAULT_CONFIG.mumbleHost),
  mumblePort: store.get('mumblePort', DEFAULT_CONFIG.mumblePort),
  lexiconUrl: store.get('lexiconUrl', DEFAULT_CONFIG.lexiconUrl),
}));

ipcMain.on('mumble:set-config', (_event, config) => {
  if (config.mumbleHost) store.set('mumbleHost', config.mumbleHost);
  if (config.mumblePort) store.set('mumblePort', config.mumblePort);
  if (config.lexiconUrl) store.set('lexiconUrl', config.lexiconUrl);
});

// ── Audio Mixer ──

function startMixer() {
  stopMixer();
  mixerInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const frames = [];
    for (const [session, queue] of senderQueues) {
      if (queue.length > 0) {
        frames.push(queue.shift());
      }
    }

    // Remove stale senders (no frames for 5+ ticks = 100ms+)
    // Actually, just leave them — they cost nothing when empty

    if (frames.length === 0) return;

    // Mix all frames into one
    const mixed = new Int16Array(960);
    for (let i = 0; i < 960; i++) {
      let sum = 0;
      for (const frame of frames) {
        if (i < frame.length) sum += frame[i];
      }
      mixed[i] = Math.max(-32768, Math.min(32767, sum));
    }

    // Send mixed PCM to renderer
    send('mumble:audio-data', Buffer.from(mixed.buffer));
  }, 20); // 20ms = one Opus frame duration
}

function stopMixer() {
  if (mixerInterval) {
    clearInterval(mixerInterval);
    mixerInterval = null;
  }
  senderQueues.clear();
}

// ── Helpers ──

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
