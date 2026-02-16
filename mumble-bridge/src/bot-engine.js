const config = require('./config');
const lexicon = require('./lexicon-client');
const { getBridgePool } = require('./database');

/**
 * Bot engine — parses ! commands from text messages.
 * Handles music, status, and admin commands.
 */
class BotEngine {
  /**
   * @param {MumbleConnection} mumbleConn
   * @param {BridgeWebSocketServer} wsServer
   */
  constructor(mumbleConn, wsServer) {
    this.mumble = mumbleConn;
    this.wsServer = wsServer;
    this.prefix = config.botPrefix;
  }

  /**
   * Initialize the bot — listen for text messages from Mumble.
   */
  init() {
    this.mumble.on('TextMessage', (msg) => {
      const text = (msg.message || '').replace(/<[^>]+>/g, '').trim(); // Strip HTML
      if (text.startsWith(this.prefix)) {
        const sender = this.wsServer.users.get(msg.actor);
        const channelIds = msg.channelId || [];
        this._handleCommand(text, sender?.name || 'Unknown', 0, channelIds[0] || 0);
      }
    });

    console.log(`[Bot] Bot engine initialized. Command prefix: ${this.prefix}`);
  }

  /**
   * Parse and execute a bot command.
   * @param {string} raw - Raw text including prefix (e.g., "!play song name")
   * @param {string} username
   * @param {number} userId
   * @param {number} channelId
   */
  async _handleCommand(raw, username, userId, channelId) {
    const parts = raw.slice(this.prefix.length).trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    console.log(`[Bot] Command: ${command} | Args: ${args.join(' ')} | From: ${username}`);

    let response;
    try {
      switch (command) {
        case 'help':
          response = this._helpText();
          break;

        case 'np':
        case 'nowplaying':
          response = await this._nowPlaying();
          break;

        case 'queue':
          response = await this._showQueue();
          break;

        case 'play':
          response = await this._play(args, userId);
          break;

        case 'skip':
          response = await this._skip(userId);
          break;

        case 'search':
          response = await this._searchMedia(args);
          break;

        case 'status':
          response = this._serverStatus();
          break;

        case 'users':
          response = this._listUsers();
          break;

        case 'channels':
          response = this._listChannels();
          break;

        default:
          response = `Unknown command: <b>${command}</b>. Type <b>${this.prefix}help</b> for a list.`;
      }
    } catch (err) {
      response = `Error: ${err.message}`;
    }

    // Log the command
    try {
      const pool = getBridgePool();
      await pool.execute(
        'INSERT INTO bot_commands (user_id, username, command, args, response, channel_id) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, username, command, args.join(' '), response?.substring(0, 500), channelId]
      );
    } catch { /* ignore logging errors */ }

    // Send response back to Mumble channel
    if (response) {
      this.mumble.sendTextMessage([channelId], response);
    }
  }

  _helpText() {
    return `<b>🤖 Mumble Bridge Bot</b><br/>
<b>${this.prefix}help</b> — Show this help<br/>
<b>${this.prefix}status</b> — Server status<br/>
<b>${this.prefix}users</b> — List online users<br/>
<b>${this.prefix}channels</b> — List channels<br/>
<b>${this.prefix}np</b> — Now playing (music)<br/>
<b>${this.prefix}queue</b> — Show music queue<br/>
<b>${this.prefix}play &lt;search&gt;</b> — Search and queue a song<br/>
<b>${this.prefix}skip</b> — Vote to skip current song<br/>
<b>${this.prefix}search &lt;query&gt;</b> — Search media library`;
  }

  async _nowPlaying() {
    const state = await lexicon.getLivestreamState();
    if (!state?.state?.currentMedia) {
      return '🎵 Nothing is currently playing.';
    }
    const media = state.state.currentMedia;
    return `🎵 <b>Now Playing:</b> ${media.title || media.filename}<br/>Type: ${media.mediaType || 'Unknown'}`;
  }

  async _showQueue() {
    const data = await lexicon.getLivestreamQueue();
    if (!data?.queue?.length) {
      return '📋 The queue is empty.';
    }
    let text = `<b>📋 Music Queue (${data.queue.length} items):</b><br/>`;
    for (const [i, item] of data.queue.slice(0, 10).entries()) {
      const title = item.mediaFile?.title || item.mediaFile?.filename || `Media #${item.mediaFileId}`;
      text += `${i + 1}. ${title}<br/>`;
    }
    if (data.queue.length > 10) text += `... and ${data.queue.length - 10} more.`;
    return text;
  }

  async _play(args, userId) {
    if (args.length === 0) return `Usage: <b>${this.prefix}play &lt;search term&gt;</b>`;

    const query = args.join(' ');
    const results = await lexicon.searchMedia(query);

    if (!results.length) return `❌ No results for: <b>${query}</b>`;

    // Queue the first result
    const media = results[0];
    try {
      await lexicon.queueToLivestream(userId, media.id);
      return `✅ Queued: <b>${media.title || media.filename}</b>`;
    } catch (err) {
      return `❌ Failed to queue: ${err.message}`;
    }
  }

  async _skip(userId) {
    try {
      const result = await lexicon.skipLivestream(userId);
      return result.skipped ? '⏭️ Song skipped!' : `⏭️ Skip vote recorded (${result.totalVotes || '?'} votes).`;
    } catch (err) {
      return `❌ Skip failed: ${err.message}`;
    }
  }

  async _searchMedia(args) {
    if (args.length === 0) return `Usage: <b>${this.prefix}search &lt;query&gt;</b>`;
    const query = args.join(' ');
    const results = await lexicon.searchMedia(query);

    if (!results.length) return `❌ No results for: <b>${query}</b>`;

    let text = `<b>🔍 Search results for "${query}":</b><br/>`;
    for (const [i, media] of results.slice(0, 5).entries()) {
      text += `${i + 1}. <b>${media.title || media.filename}</b> (${media.mediaType}) [ID: ${media.id}]<br/>`;
    }
    return text;
  }

  _serverStatus() {
    const userCount = this.wsServer.users.size;
    const channelCount = this.wsServer.channels.size;
    const wsClientCount = this.wsServer.clients.size;
    return `<b>📊 Server Status</b><br/>
Mumble Users: ${userCount}<br/>
Channels: ${channelCount}<br/>
Web Clients: ${wsClientCount}<br/>
Uptime: Running`;
  }

  _listUsers() {
    const users = Array.from(this.wsServer.users.values());
    if (users.length === 0) return 'No users online.';

    let text = `<b>👥 Online Users (${users.length}):</b><br/>`;
    for (const u of users) {
      const ch = this.wsServer.channels.get(u.channelId);
      text += `• ${u.name} (in ${ch?.name || 'Root'})<br/>`;
    }
    return text;
  }

  _listChannels() {
    const channels = Array.from(this.wsServer.channels.values());
    if (channels.length === 0) return 'No channels.';

    let text = `<b>📢 Channels (${channels.length}):</b><br/>`;
    for (const ch of channels) {
      const userCount = Array.from(this.wsServer.users.values()).filter(u => u.channelId === ch.id).length;
      text += `• ${ch.name} (${userCount} users)<br/>`;
    }
    return text;
  }
}

module.exports = BotEngine;
