require('dotenv').config();

module.exports = {
  ws: {
    port: parseInt(process.env.WS_PORT) || 3080,
  },
  mumble: {
    host: process.env.MUMBLE_HOST || '127.0.0.1',
    port: parseInt(process.env.MUMBLE_PORT) || 64738,
  },
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'mumble',
    password: process.env.MYSQL_PASSWORD || '',
    mumbleDb: process.env.MYSQL_DATABASE_MUMBLE || 'mumble_server',
    bridgeDb: process.env.MYSQL_DATABASE_BRIDGE || 'mumble_bridge',
  },
  lexicon: {
    apiUrl: process.env.LEXICON_API_URL || 'http://localhost:36568',
    // Login the bridge uses for its own Lexicon API calls. Set both in .env (never commit them).
    serviceUsername: process.env.LEXICON_SERVICE_USER || '',
    servicePassword: process.env.LEXICON_SERVICE_PASSWORD || '',
    // Shared secret Lexicon accepts from this bridge as "X-Service-Token". Must match LEXICON_SERVICE_TOKEN on aragorn.
    serviceToken: process.env.LEXICON_SERVICE_TOKEN || '',
  },
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    channelId: process.env.DISCORD_CHANNEL_ID || '',
    syncMumbleChannelId: parseInt(process.env.DISCORD_SYNC_MUMBLE_CHANNEL_ID) || 0,
  },
  botPrefix: process.env.BOT_COMMAND_PREFIX || '!',
  logLevel: process.env.LOG_LEVEL || 'info',
  voiceDiagEnabled: (process.env.VOICE_DIAG_ENABLED || 'false').toLowerCase() === 'true',
  // Matched against the Lexicon *login name* of a verified session, never a display name or a typed-in name.
  superUsers: (process.env.SUPERUSER_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  security: {
    // Transition switches. Safe by default: the legacy "type a name, no password" login is OFF and, if it
    // is switched on, its sessions are never admin unless NAME_ONLY_ADMIN is also true.
    allowNameOnlyLogin: (process.env.ALLOW_NAME_ONLY_LOGIN || 'false').toLowerCase() === 'true',
    nameOnlyAdmin: (process.env.NAME_ONLY_ADMIN || 'false').toLowerCase() === 'true',
    // Transition switch for the installed Android app, whose avatar and image uploads do not send a session token yet:
    // while true, those uploads without a token are accepted on the username/userId in the form (as before).
    // A request that sends a token is always held to it. Turn off once the app sends its token.
    allowLegacyAppUploads: (process.env.ALLOW_LEGACY_APP_UPLOADS || 'false').toLowerCase() === 'true',
    // Optional static secret so command-line diagnostics tools can read /api/diag/* without a browser session.
    diagToken: process.env.DIAG_TOKEN || '',
    sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS) || 24,
    wsMaxPayloadBytes: parseInt(process.env.WS_MAX_PAYLOAD_BYTES) || 2 * 1024 * 1024,
    // Content-Security-Policy for the web client: 'enforce', 'report-only' (browser console only) or 'off'.
    cspMode: (process.env.CSP_MODE || 'report-only').toLowerCase(),
  },
};
