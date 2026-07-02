/**
 * Mumble event relay — listens to Mumble events and broadcasts to web clients.
 */

const lexicon = require('./lexicon-client');
const featureRegistry = require('./feature-registry');

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
    // Initial sync done — the server replays existing users right after we
    // connect; only UserState changes after this point count as real joins.
    state.synced = true;
    console.log(`[Mumble] Synced. Our session: ${msg.session}`);
  });

  mumble.on('ChannelState', (msg) => {
    const existing = state.channels.get(msg.channelId);
    const ch = {
      id: msg.channelId,
      name: msg.name || (existing ? existing.name : ''),
      parentId: msg.parent !== undefined ? msg.parent : (existing ? existing.parentId : 0),
      description: msg.description || '',
    };
    state.channels.set(msg.channelId, ch);
    broadcastAll({ type: 'channel_update', channel: ch });
  });

  mumble.on('ChannelRemove', (msg) => {
    state.channels.delete(msg.channelId);
    broadcastAll({ type: 'channel_remove', channelId: msg.channelId });
  });

  mumble.on('UserState', (msg) => {
    const existing = state.users.get(msg.session) || {};
    const prevChannelId = existing.channelId;
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

    // Lexicon app notification on a genuine channel entry (connect or move)
    // after initial sync. Web users are handled via voice_start; skip their
    // web_* voice sessions and our own bridge session here.
    const changedChannel = user.channelId !== undefined && user.channelId !== prevChannelId;
    if (state.synced && changedChannel && msg.session !== state.ownSession
        && user.name && !user.name.startsWith('web_')) {
      const notifFeature = featureRegistry.features?.get('notifications');
      if (notifFeature) {
        notifFeature.notifyVoiceJoin({
          name: user.name,
          channelId: user.channelId,
          channelName: state.channels.get(user.channelId)?.name,
        }).catch(() => {});
      }
    }
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

    // Once per message (not per delivery channel): Lexicon app notification
    // + @mention processing for native Mumble senders (parity with web).
    if (rawText && sender?.name && channelIds.length > 0) {
      const chId = channelIds[0];
      const channelName = state.channels.get(chId)?.name || '';

      const notifFeature = featureRegistry.features?.get('notifications');
      if (notifFeature) {
        notifFeature.notifyMessage({
          senderName: sender.name,
          channelId: chId,
          channelName,
          text: rawText,
        }).catch(() => {});
      }

      const mentionsFeature = featureRegistry.features?.get('mentions');
      if (mentionsFeature && mentionsFeature.processMentions) {
        mentionsFeature.processMentions({
          text: rawText,
          fromUsername: sender.name,
          fromUserId: null,
          channelId: chId,
          channelName,
          messageId: null,
        }).catch(() => {});
      }
    }
  });
}

module.exports = { setupMumbleListeners };
