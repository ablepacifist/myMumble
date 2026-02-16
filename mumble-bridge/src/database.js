const mysql = require('mysql2/promise');
const config = require('./config');

let mumblePool = null;
let bridgePool = null;

/**
 * Get a connection pool to Mumble's MySQL database (read-only queries).
 */
function getMumblePool() {
  if (!mumblePool) {
    mumblePool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.mumbleDb,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return mumblePool;
}

/**
 * Get a connection pool to the bridge's own MySQL database.
 */
function getBridgePool() {
  if (!bridgePool) {
    bridgePool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.bridgeDb,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return bridgePool;
}

/**
 * Initialize bridge database tables.
 */
async function initBridgeDatabase() {
  const pool = getBridgePool();

  // User mapping: links Lexicon users to Mumble users
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_mapping (
      id INT AUTO_INCREMENT PRIMARY KEY,
      lexicon_user_id INT NOT NULL,
      lexicon_username VARCHAR(255) NOT NULL,
      mumble_username VARCHAR(255),
      display_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP NULL,
      UNIQUE KEY uq_lexicon_user (lexicon_user_id),
      UNIQUE KEY uq_lexicon_username (lexicon_username)
    )
  `);

  // Text messages stored in MySQL (alternative to adding to Lexicon's HSQLDB)
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS text_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      channel_id INT NOT NULL,
      channel_name VARCHAR(255),
      user_id INT NOT NULL,
      username VARCHAR(255),
      content TEXT NOT NULL,
      message_type VARCHAR(20) DEFAULT 'TEXT',
      media_file_id BIGINT NULL,
      reply_to_id BIGINT NULL,
      is_pinned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_at TIMESTAMP NULL,
      deleted_at TIMESTAMP NULL,
      INDEX idx_channel_time (channel_id, created_at),
      INDEX idx_user (user_id)
    )
  `);

  // Bot command log
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS bot_commands (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(255),
      command VARCHAR(100) NOT NULL,
      args TEXT,
      response TEXT,
      channel_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[DB] Bridge database tables initialized');
}

module.exports = { getMumblePool, getBridgePool, initBridgeDatabase };
