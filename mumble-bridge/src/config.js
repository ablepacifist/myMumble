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
  },
  botPrefix: process.env.BOT_COMMAND_PREFIX || '!',
  logLevel: process.env.LOG_LEVEL || 'info',
};
