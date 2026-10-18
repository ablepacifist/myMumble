/**
 * Music bot — renders Lexicon's shared Livestream state into Mumble voice.
 *
 * Architecture: a music source is architecturally indistinguishable from
 * "one more person talking" — Mumble fans out each talker's Opus stream
 * separately and mixing happens client-side, so this just needs to be one
 * more connection sending Opus frames into a channel. It's a dedicated
 * pseudo-user connection ("web_MusicBot"), modeled on src/voice-bridge.js's
 * VoiceSession but send-only (no mic, no inbound-audio decoding) and fed by
 * an ffmpeg-decoded audio stream instead of a browser mic.
 *
 * The bridge never owns the queue — Lexicon's Livestream is a shared,
 * platform-wide state (docs/FEATURE_ROADMAP.md's "Synchronized Listening
 * Parties"). This module only ever RENDERS whatever Lexicon reports as
 * currently playing; it never calls skipLivestream/queueToLivestream on its
 * own initiative, including on decode failure.
 */
const tls = require('tls');
const { spawn } = require('child_process');
const OpusScript = require('opusscript');
const config = require('./config');
const lexicon = require('./lexicon-client');
const LivestreamWatcher = require('./lexicon-livestream-watcher');
const { buildTcpFrame, buildLegacyOpusPacket } = require('./mumble-wire');

const MSG_TYPE = { Version: 0, UDPTunnel: 1, Authenticate: 2, Ping: 3, ServerSync: 5, UserState: 9 };

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 1920 (Int16)
const HIGH_WATER_BYTES = BYTES_PER_FRAME * 250; // ~5s — pause ffmpeg stdout above this
const LOW_WATER_BYTES = BYTES_PER_FRAME * 50;   // ~1s — resume below this
const EMPTY_CHANNEL_GRACE_MS = 15000;
const QUEUE_EMPTY_GRACE_MS = 3000;
const BOT_USERNAME = 'web_MusicBot'; // web_ prefix: invisible to mumble-relay's existing web_* skip-checks

/** A single send-only Mumble connection that streams decoded audio into whatever channel it's moved to. */
class MusicBotSession {
  constructor(bot) {
    this.bot = bot;
    this.socket = null;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    this.sequenceNumber = 0;
    this.mumbleSession = null;
    this.currentChannelId = null;
    this.pingInterval = null;
    this._onSyncResolve = null;

    this.opusEncoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    this.opusEncoder.setBitrate(64000);

    this.ffmpeg = null;
    this.pcmQueue = [];
    this.pcmQueueBytes = 0;
    this.pcmLeftover = Buffer.alloc(0);
    this.paused = false;
    this.currentMediaId = null;
    this.frameTimer = null;
    this.frameStartTime = 0;
    this.frameCount = 0;
  }

  /** Connect to Mumble, with retry on ECONNRESET (Mumble's autoban) — same policy as VoiceSession.connect(). */
  async connect() {
    const maxRetries = 3;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        await this._connectOnce();
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'ECONNRESET' && err.message !== 'read ECONNRESET') throw err;
        if (this.socket) {
          try { this.socket.destroy(); } catch (_) {}
          this.socket = null;
        }
      }
    }
    throw lastErr;
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Mumble connection timeout')), 10000);
      this.socket = tls.connect(
        { host: config.mumble.host, port: config.mumble.port, rejectUnauthorized: false },
        () => {
          this.socket.setNoDelay(true);
          this._sendProto('Version', {
            versionV1: (1 << 16) | (2 << 8) | 4,
            release: 'MusicBot 1.0',
            os: 'Web',
            osVersion: 'Browser',
          });
          this._sendProto('Authenticate', { username: BOT_USERNAME, opus: true });
        }
      );
      this.socket.on('data', (data) => this._onData(data));
      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.ready = false;
        reject(err);
      });
      this.socket.on('close', () => {
        this.ready = false;
        this._stopPing();
      });
      this._onSyncResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  _onData(data) {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    let offset = 0;
    while (offset + 6 <= this.buffer.length) {
      const typeId = this.buffer.readUInt16BE(offset);
      const length = this.buffer.readUInt32BE(offset + 2);
      if (offset + 6 + length > this.buffer.length) break;
      const payload = this.buffer.subarray(offset + 6, offset + 6 + length);
      offset += 6 + length;
      this._handleMessage(typeId, payload);
    }
    if (offset > 0) {
      this.buffer = offset < this.buffer.length ? Buffer.from(this.buffer.subarray(offset)) : Buffer.alloc(0);
    }
  }

  /** Send-only session — the only inbound message it cares about is ServerSync. */
  _handleMessage(typeId, payload) {
    if (typeId !== MSG_TYPE.ServerSync) return;
    try {
      const msg = this.bot.messageTypes.ServerSync.decode(payload);
      this.mumbleSession = msg.session;
      this.ready = true;
      this._startPing();
      if (this._onSyncResolve) {
        this._onSyncResolve();
        this._onSyncResolve = null;
      }
    } catch (err) {
      console.error(`[Music] ServerSync decode error: ${err.message}`);
    }
  }

  moveToChannel(channelId) {
    if (this.ready && this.mumbleSession !== null && this.currentChannelId !== channelId) {
      this._sendProto('UserState', { session: this.mumbleSession, channelId });
      this.currentChannelId = channelId;
    }
  }

  _sendProto(typeName, data) {
    const MessageType = this.bot.messageTypes[typeName];
    if (!MessageType || !this.socket) return;
    const message = MessageType.create(data);
    const payload = MessageType.encode(message).finish();
    this.socket.write(buildTcpFrame(MSG_TYPE[typeName], payload));
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.ready) this._sendProto('Ping', { timestamp: Date.now() });
    }, 15000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /** Start decoding+streaming a track, killing whatever was playing before. */
  async playTrack(media, elapsedSeconds) {
    this._stopTrack();
    this.currentMediaId = media.id;

    const url = lexicon.getStreamUrl(media.id);
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_at_eof', '0', '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5',
    ];
    if (elapsedSeconds > 1.5) args.push('-ss', String(elapsedSeconds));
    args.push('-i', url, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ff;

    let stderrTail = [];
    ff.stderr.on('data', (d) => {
      stderrTail.push(...d.toString().split('\n').filter(Boolean));
      if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
    });
    ff.stdout.on('data', (chunk) => {
      this.pcmQueue.push(chunk);
      this.pcmQueueBytes += chunk.length;
      if (this.pcmQueueBytes > HIGH_WATER_BYTES && !this.paused) {
        this.paused = true;
        ff.stdout.pause();
      }
    });
    ff.on('error', (err) => console.error(`[Music] ffmpeg spawn error: ${err.message}`));
    ff.on('close', (code) => {
      if (ff !== this.ffmpeg) return; // superseded by a newer track already
      if (code !== 0 && this.frameCount === 0 && this.pcmQueueBytes === 0) {
        console.error(`[Music] ffmpeg failed for media ${media.id}: ${stderrTail.join(' | ') || `exit code ${code}`}`);
      }
    });

    this._startFramePump();
  }

  _stopTrack() {
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGTERM'); } catch (_) {}
      this.ffmpeg = null;
    }
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.pcmQueue = [];
    this.pcmQueueBytes = 0;
    this.pcmLeftover = Buffer.alloc(0);
    this.paused = false;
    this.currentMediaId = null;
  }

  /** Pull the next 1920-byte (20ms) PCM frame out of the queue, or null if not enough buffered yet. */
  _nextFrame() {
    while (this.pcmLeftover.length < BYTES_PER_FRAME && this.pcmQueue.length > 0) {
      const next = this.pcmQueue.shift();
      this.pcmQueueBytes -= next.length;
      this.pcmLeftover = this.pcmLeftover.length === 0 ? next : Buffer.concat([this.pcmLeftover, next]);
    }
    if (this.pcmLeftover.length < BYTES_PER_FRAME) return null;
    const frame = this.pcmLeftover.subarray(0, BYTES_PER_FRAME);
    this.pcmLeftover = Buffer.from(this.pcmLeftover.subarray(BYTES_PER_FRAME));
    return frame;
  }

  /**
   * Drift-corrected recursive setTimeout, not setInterval — reuses the
   * *principle* voice-bridge.js's own documented timing lesson learned
   * (docs/VOICE_FIX_PLAN.md issue #3: naive setInterval drifts/jitters).
   * There's no browser hardware clock available server-side for a synthetic
   * source, so pacing has to be actively computed each tick instead.
   */
  _startFramePump() {
    this.frameStartTime = Date.now();
    this.frameCount = 0;
    const tick = () => {
      if (!this.ffmpeg) return; // stopped/replaced mid-tick

      const frame = this._nextFrame();
      if (frame) {
        this._encodeAndSend(frame);
      } else if (this.ffmpeg.exitCode !== null && this.pcmQueueBytes === 0 && this.pcmLeftover.length === 0) {
        // ffmpeg exited and every buffered byte has been drained — track genuinely finished
        this._stopTrack();
        this.bot._onTrackEnded(this);
        return;
      }
      // else: still buffering — just wait for the next tick without sending silence

      if (this.paused && this.pcmQueueBytes < LOW_WATER_BYTES && this.ffmpeg) {
        this.paused = false;
        this.ffmpeg.stdout.resume();
      }

      this.frameCount++;
      const idealNext = this.frameStartTime + this.frameCount * FRAME_DURATION_MS;
      const delay = Math.max(0, idealNext - Date.now());
      this.frameTimer = setTimeout(tick, delay);
    };
    this.frameTimer = setTimeout(tick, 0);
  }

  _encodeAndSend(frame) {
    const volume = this.bot.volume;
    let toEncode = frame;
    if (volume !== 1) {
      // Defensive aligned copy — a Buffer.subarray's byteOffset isn't guaranteed
      // 2-byte aligned, which crashes Int16Array with a RangeError (same fix
      // voice-bridge.js already applies for the same reason on the mic path).
      const aligned = Buffer.from(frame);
      const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
      for (let i = 0; i < int16.length; i++) {
        let s = int16[i] * volume;
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        int16[i] = s;
      }
      toEncode = aligned;
    }
    try {
      const opusFrame = this.opusEncoder.encode(toEncode, SAMPLES_PER_FRAME);
      if (opusFrame && opusFrame.length > 0 && this.socket) {
        this.socket.write(buildLegacyOpusPacket({ sequenceNumber: this.sequenceNumber++, opusFrame, target: 0 }));
      }
    } catch (err) {
      console.error(`[Music] Opus encode error: ${err.message}`);
    }
  }

  disconnect() {
    this.ready = false;
    this._stopPing();
    this._stopTrack();
    if (this.opusEncoder) {
      try { this.opusEncoder.delete(); } catch (_) {}
      this.opusEncoder = null;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

/** Singleton — owns the single global MusicBotSession, the SSE watcher, and lifecycle policy. */
class MusicBot {
  constructor() {
    this.wsServer = null;
    this.messageTypes = null;
    this.session = null;
    this.watcher = null;
    this.volume = 0.5; // default 50%, sticky on this singleton across idle disconnects
    this._currentChannelId = null;
    this._emptyChannelTimer = null;
    this._queueEmptyTimer = null;
    this._userStateHandler = null;
  }

  init(wsServer) {
    this.wsServer = wsServer;
    this.messageTypes = wsServer.voiceBridge.messageTypes; // reuse already-loaded proto types, don't reparse
    this._userStateHandler = () => this._onOccupancyChanged();
    wsServer.mumble.on('UserState', this._userStateHandler);
    wsServer.mumble.on('UserRemove', this._userStateHandler);
  }

  /**
   * Ensure the bot is connected and present in `channelId`. Safe/cheap to call
   * on every single !play, not just the first — no-ops if already there.
   */
  async playInChannel(channelId) {
    if (channelId === null || channelId === undefined) {
      return { ok: false, error: 'not in a voice channel' };
    }

    if (!this.session) {
      const session = new MusicBotSession(this);
      try {
        await session.connect();
      } catch (err) {
        return { ok: false, error: err.message };
      }
      this.session = session;
      this._startWatcher();
    }

    const moved = this._currentChannelId !== null && this._currentChannelId !== channelId;
    this.session.moveToChannel(channelId);
    this._currentChannelId = channelId;
    this._clearEmptyChannelTimer();

    this._syncToCurrentState().catch((err) => console.error(`[Music] Initial state sync failed: ${err.message}`));
    return { ok: true, moved };
  }

  async _syncToCurrentState() {
    const stateResp = await lexicon.getLivestreamState();
    this._applyState(stateResp?.state);
  }

  _startWatcher() {
    if (this.watcher) return;
    this.watcher = new LivestreamWatcher(lexicon.baseUrl);
    this.watcher.on('state', (state) => this._applyState(state));
    this.watcher.start();
  }

  _applyState(state) {
    if (!this.session) return;
    const media = state?.currentMedia;
    const mediaId = state?.currentMediaId ?? media?.id ?? null;

    if (!media || mediaId == null) {
      this._scheduleQueueEmptyStop();
      return;
    }
    this._clearQueueEmptyTimer();
    if (this.session.currentMediaId === mediaId) return; // already rendering this track

    const startRaw = state.currentStartTime;
    const startMs = typeof startRaw === 'number' ? startRaw : Date.parse(startRaw);
    const elapsedSeconds = Number.isFinite(startMs) ? Math.max(0, (Date.now() - startMs) / 1000) : 0;

    this.session.playTrack(media, elapsedSeconds).catch((err) => {
      console.error(`[Music] playTrack failed: ${err.message}`);
    });
  }

  /** Called by a session when ffmpeg + queue both genuinely drain. We never advance Lexicon's queue ourselves — just wait. */
  _onTrackEnded(session) {
    if (session !== this.session) return;
  }

  setVolume(percent) {
    const clamped = Math.max(0, Math.min(150, percent));
    this.volume = clamped / 100;
    return clamped;
  }

  getVolumePercent() {
    return Math.round(this.volume * 100);
  }

  async stop() {
    this._clearEmptyChannelTimer();
    this._clearQueueEmptyTimer();
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    if (this.session) {
      this.session.disconnect();
      this.session = null;
    }
    this._currentChannelId = null;
  }

  _onOccupancyChanged() {
    if (!this.session || this._currentChannelId === null) return;
    if (this._countRealListeners(this._currentChannelId) === 0) {
      this._scheduleEmptyChannelStop();
    } else {
      this._clearEmptyChannelTimer();
    }
  }

  /** Real listeners = anyone actually voice-connected to the channel, excluding the two bot identities. */
  _countRealListeners(channelId) {
    let count = 0;
    for (const u of this.wsServer.users.values()) {
      if (u.channelId !== channelId) continue;
      if (!u.name || u.name === 'MumbleBridge' || u.name === BOT_USERNAME) continue;
      count++;
    }
    return count;
  }

  _scheduleEmptyChannelStop() {
    if (this._emptyChannelTimer) return;
    this._emptyChannelTimer = setTimeout(() => {
      this._emptyChannelTimer = null;
      if (this._currentChannelId !== null && this._countRealListeners(this._currentChannelId) === 0) {
        this.stop();
      }
    }, EMPTY_CHANNEL_GRACE_MS);
  }

  _clearEmptyChannelTimer() {
    if (this._emptyChannelTimer) {
      clearTimeout(this._emptyChannelTimer);
      this._emptyChannelTimer = null;
    }
  }

  _scheduleQueueEmptyStop() {
    if (this._queueEmptyTimer) return;
    this._queueEmptyTimer = setTimeout(() => {
      this._queueEmptyTimer = null;
      this.stop();
    }, QUEUE_EMPTY_GRACE_MS);
  }

  _clearQueueEmptyTimer() {
    if (this._queueEmptyTimer) {
      clearTimeout(this._queueEmptyTimer);
      this._queueEmptyTimer = null;
    }
  }

  /** Explicit teardown on process shutdown — unlike sockets, an orphaned ffmpeg child isn't reaped automatically. */
  cleanup() {
    this._clearEmptyChannelTimer();
    this._clearQueueEmptyTimer();
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    if (this.session) {
      this.session.disconnect();
      this.session = null;
    }
  }
}

module.exports = new MusicBot();
