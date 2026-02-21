/**
 * Mumble event relay — listens to Mumble events and broadcasts to web clients.
 */

const lexicon = require('./lexicon-client');

/**
 * Set up listeners on the Mumble connection to relay events to web clients.
 * @param {MumbleConnection} mumble - The Mumble connection
 * @param {object} state - Shared server state { channels, users, ownSession }
 * @param {Function} broadcastAll - Broadcast to all web clients
 * @param {Function} broadcastToChannel - Broadcast to a specific channel
 */
function setupMumbleListeners(mumble, state, broadcastAll, broadcastToChannel) {
  mumble.on('ServerSync', (msg) => {
    state.ownSession = msg.session;
    console.log(`[Mumble] Synced. Our session: ${msg.session}`);
  });

  mumble.on('ChannelState', (msg) => {
    state.channels.set(msg.channelId, {
      id: msg.channelId,
      name: msg.name || state.channels.get(msg.channelId)?.name || '',
      parent: msg.parent,
      description: msg.description || '',
    });
    broadcastAll({ type: 'channel_update', channel: state.channels.get(msg.channelId) });
  });

  mumble.on('ChannelRemove', (msg) => {
    state.channels.delete(msg.channelId);
    broadcastAll({ type: 'channel_remove', channelId: msg.channelId });
  });

  mumble.on('UserState', (msg) => {
    const existing = state.users.get(msg.session) || {};
    const user = {
      session: msg.session,
      name: msg.name || existing.name || '',
      channelId: msg.channelId !== undefined ? msg.channelId : existing.channelId,
      mute: msg.mute !== undefined ? msg.mute : existing.mute,
      deaf: msg.deaf !== undefined ? msg.deaf : existing.deaf,
      selfMute: msg.selfMute !== undefined ? msg.selfMute : existing.selfMute,
      selfDeaf: msg.selfDeaf !== undefined ? msg.selfDeaf : existing.selfDeaf,
    };
    state.users.set(msg.session, user);
    broadcastAll({ type: 'user_update', user });
  });

  mumble.on('UserRemove', (msg) => {
    const user = state.users.get(msg.session);
    state.users.delete(msg.session);
    broadcastAll({ type: 'user_remove', session: msg.session, name: user?.name });
  });

  mumble.on('TextMessage', (msg) => {
    const sender = state.users.get(msg.actor);
    const channelIds = msg.channelId || [];
    const rawText = (msg.message || '').replace(/<[^>]+>/g, '').trim();

    // Skip messages sent by our own bridge bot (echoes of web messages)
    if (msg.actor === state.ownSession) return;

    // Skip messages from web_* voice sessions (also our bots)
    if (sender?.name && sender.name.startsWith('web_')) return;

    for (const chId of channelIds) {
      broadcastToChannel(chId, {
        type: 'text',
        channelId: chId,
        username: sender?.name || 'Unknown',
        text: rawText,
        source: 'mumble',
        timestamp: new Date().toISOString(),
      });

      if (rawText && sender?.name) {
        lexicon.storeMessage({
          channelId: chId,
          channelName: state.channels.get(chId)?.name || '',
          userId: 0,
          username: sender.name,
          content: rawText,
        }).catch(() => {});
      }
    }
  });
}

module.exports = { setupMumbleListeners };
