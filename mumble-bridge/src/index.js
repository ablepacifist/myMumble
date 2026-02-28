const MumbleConnection = require('./mumble-connection');
const BridgeWebSocketServer = require('./ws-server');
const BotEngine = require('./bot-engine');
const { initBridgeDatabase } = require('./database');
const lexicon = require('./lexicon-client');
const config = require('./config');

// Prevent crashes from killing the server — log and keep running
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (server kept running):', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection (server kept running):', reason);
});

async function main() {
  console.log('========================================');
  console.log('  Mumble Bridge Service v1.0');
  console.log('========================================');
  console.log(`  WebSocket port : ${config.ws.port}`);
  console.log(`  Mumble server  : ${config.mumble.host}:${config.mumble.port}`);
  console.log(`  Lexicon API    : ${config.lexicon.apiUrl}`);
  console.log(`  MySQL          : ${config.mysql.host}:${config.mysql.port}`);
  console.log('========================================');

  // 1. Initialize bridge database tables
  console.log('\n[Boot] Initializing database...');
  await initBridgeDatabase();

  // 2. Login to Lexicon as bridge service user
  console.log('[Boot] Logging into Lexicon API as bridge service...');
  await lexicon.loginAsService();

  // 3. Load Mumble protocol definitions and connect
  // 3. Load Mumble protocol definitions and connect
  console.log('[Boot] Connecting to Mumble server...');
  const mumble = new MumbleConnection();
  await mumble.loadProto();

  try {
    await mumble.connect('MumbleBridge', ''); // Bridge bot user, no password
  } catch (err) {
    console.error('[Boot] Failed to connect to Mumble:', err.message);
    console.error('       Is the Mumble server running on', `${config.mumble.host}:${config.mumble.port}?`);
    process.exit(1);
  }

  // Keep alive with pings every 15 seconds
  const pingInterval = setInterval(() => {
    if (mumble.connected) {
      mumble.ping();
    }
  }, 15000);

  // Reconnect on disconnect
  mumble.on('disconnected', () => {
    console.log('[Mumble] Disconnected. Reconnecting in 5 seconds...');
    setTimeout(async () => {
      try {
        await mumble.connect('MumbleBridge', '');
        console.log('[Mumble] Reconnected.');
      } catch (err) {
        console.error('[Mumble] Reconnect failed:', err.message);
      }
    }, 5000);
  });

  // 3. Start WebSocket server
  console.log('[Boot] Starting WebSocket server...');
  const wsServer = new BridgeWebSocketServer(mumble);
  await wsServer.start();

  // Make voice bridge instance globally accessible for diagnostics API
  const VoiceBridge = require('./voice-bridge');
  VoiceBridge.voiceBridgeInstance = wsServer.voiceBridge;

  // 4. Start Bot engine
  console.log('[Boot] Starting bot engine...');
  const bot = new BotEngine(mumble, wsServer);
  bot.init();

  // 5. Log when Mumble syncs (fully connected)
  mumble.on('ServerSync', (msg) => {
    console.log(`[Boot] ✅ Mumble sync complete. Welcome message: ${msg.welcomeText || '(none)'}`);
    console.log('[Boot] ✅ Bridge is fully operational!');
    console.log(`[Boot] ✅ Web clients can connect at ws://localhost:${config.ws.port}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Shutdown] Shutting down...');
    clearInterval(pingInterval);
    mumble.disconnect();
    if (wsServer.wss) wsServer.wss.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
