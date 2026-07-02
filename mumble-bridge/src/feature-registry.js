/**
 * Feature Registry — loads and routes messages to feature modules.
 * 
 * Each feature in src/features/<name>/index.js exports:
 *   { name, messageTypes[], init(deps), handleMessage(ws, client, msg), cleanup() }
 * 
 * This registry:
 *   1. Scans src/features/ for modules on init
 *   2. Routes unrecognized WS message types to the appropriate feature
 *   3. Keeps voice/core message handling completely untouched
 */
const fs = require('fs');
const path = require('path');

class FeatureRegistry {
  constructor() {
    this.features = new Map();       // name -> feature module
    this.typeMap = new Map();        // messageType -> feature module
    this.initialized = false;
  }

  /**
   * Load all feature modules from src/features/
   * @param {object} deps - Shared dependencies { db, lexicon, broadcast, broadcastToChannel, getClients, getWebClients, channels }
   */
  async init(deps) {
    const featuresDir = path.join(__dirname, 'features');

    if (!fs.existsSync(featuresDir)) {
      fs.mkdirSync(featuresDir, { recursive: true });
      console.log('[Features] Created src/features/ directory');
    }

    const entries = fs.readdirSync(featuresDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const modulePath = path.join(featuresDir, entry.name, 'index.js');
      if (!fs.existsSync(modulePath)) continue;

      try {
        const feature = require(modulePath);

        if (!feature.name || !feature.messageTypes || !feature.handleMessage) {
          console.warn(`[Features] Skipping ${entry.name}: missing required exports (name, messageTypes, handleMessage)`);
          continue;
        }

        // Initialize the feature with shared deps
        if (feature.init) {
          await feature.init(deps);
        }

        this.features.set(feature.name, feature);

        // Map each message type to this feature
        for (const type of feature.messageTypes) {
          if (this.typeMap.has(type)) {
            console.warn(`[Features] Message type "${type}" already registered by "${this.typeMap.get(type).name}", skipping for "${feature.name}"`);
            continue;
          }
          this.typeMap.set(type, feature);
        }

        console.log(`[Features] ✅ Loaded: ${feature.name} (${feature.messageTypes.join(', ')})`);
      } catch (err) {
        console.error(`[Features] ❌ Failed to load ${entry.name}:`, err.message);
      }
    }

    this.initialized = true;
    console.log(`[Features] Registry ready — ${this.features.size} feature(s) loaded, ${this.typeMap.size} message type(s) registered`);
  }

  /**
   * Route a message to the appropriate feature handler.
   * Returns true if handled, false if no feature claims this message type.
   */
  route(ws, client, msg) {
    const feature = this.typeMap.get(msg.type);
    if (!feature) return false;

    try {
      feature.handleMessage(ws, client, msg);
    } catch (err) {
      console.error(`[Features] Error in ${feature.name} handling "${msg.type}":`, err.message);
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Feature error: ' + err.message }));
      } catch (_) {}
    }
    return true;
  }

  /**
   * Clean up all features on shutdown.
   */
  async cleanup() {
    for (const [name, feature] of this.features) {
      if (feature.cleanup) {
        try {
          await feature.cleanup();
        } catch (err) {
          console.error(`[Features] Cleanup error for ${name}:`, err.message);
        }
      }
    }
  }
}

module.exports = new FeatureRegistry();
