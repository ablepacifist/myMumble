/**
 * Preload script — exposes safe IPC methods to the renderer via contextBridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mumble', {
  // ── Actions (renderer → main) ──
  connect: (config) => ipcRenderer.invoke('mumble:connect', config),
  disconnect: () => ipcRenderer.send('mumble:disconnect'),
  sendText: (data) => ipcRenderer.send('mumble:send-text', data),
  moveChannel: (channelId) => ipcRenderer.send('mumble:move-channel', channelId),
  createChannel: (data) => ipcRenderer.send('mumble:create-channel', data),
  removeChannel: (channelId) => ipcRenderer.send('mumble:remove-channel', channelId),
  setSelfMute: (muted) => ipcRenderer.send('mumble:set-self-mute', muted),
  setSelfDeaf: (deafened) => ipcRenderer.send('mumble:set-self-deaf', deafened),
  sendAudio: (pcmBuffer) => ipcRenderer.send('mumble:audio-data', pcmBuffer),
  getHistory: (data) => ipcRenderer.invoke('mumble:get-history', data),
  getConfig: () => ipcRenderer.invoke('mumble:get-config'),
  setConfig: (config) => ipcRenderer.send('mumble:set-config', config),
  getAvatar: (username) => ipcRenderer.invoke('mumble:get-avatar', username),
  getVoiceDiag: () => ipcRenderer.invoke('mumble:get-voice-diag'),

  // ── Events (main → renderer) ──
  on: (channel, callback) => {
    const validChannels = [
      'mumble:ready',
      'mumble:channel-state',
      'mumble:channel-remove',
      'mumble:user-state',
      'mumble:user-remove',
      'mumble:text-message',
      'mumble:audio-data',
      'mumble:error',
      'mumble:disconnected',
    ];
    if (!validChannels.includes(channel)) return () => {};

    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // ── Remove all listeners for a channel ──
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
