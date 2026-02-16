# IDIOTS PLAY GAMES — Server Guide

## What Is All This?

You have a **web-based voice + text chat** at `https://voice.alex-dyakin.com`.
Under the hood, there are 3 services working together:

### The Services

| Service | What It Does | Port |
|---------|-------------|------|
| **Mumble Server** | The actual voice/text chat server. Stores channels, users, permissions. Handles audio mixing between all connected clients. | 64738 |
| **Mumble Bridge** | Node.js app that bridges web users into Mumble. Runs an HTTP server (serves the website), a WebSocket server (real-time chat), and creates per-user Mumble connections for voice. | 3080 |
| **Cloudflare Tunnel** | Makes your local port 3080 accessible at `voice.alex-dyakin.com` without opening any ports on your router. | — |

> **No third-party voice services.** No WebRTC, no STUN, no TURN. Voice audio goes:
> Browser → WebSocket → Bridge → Mumble → Bridge → WebSocket → Browser.
> The only external connection is Cloudflare Tunnel for HTTPS access.

### How Voice Works

```
Browser A (mic)
    → AudioWorklet captures PCM
    → WebSocket binary (Int16 samples)
    → Bridge encodes to Opus
    → Mumble server (via TLS, as user "web_alice")

Mumble mixes all audio and sends to each connected user:

    → Bridge receives Opus from Mumble
    → Decodes to PCM
    → WebSocket binary
    → AudioWorklet plays to speaker
    → Browser B hears Alice
```

Each web user gets their **own dedicated Mumble connection**. Mumble natively handles:
- Audio mixing (multiple speakers at once)
- Audio routing (you don't hear yourself)
- Codec negotiation (Opus)

Native Mumble clients and web clients can all talk to each other.

### How Text Works

```
Browser sends JSON over WebSocket → Bridge relays to Mumble as TextMessage
Mumble TextMessage → Bridge relays to all web clients
Messages stored in Lexicon API (primary) + MySQL (backup)
```

---

## How to Restart Things

### Restart the Mumble Bridge (most common)
```bash
sudo systemctl restart mumble-bridge
```

### Restart the Mumble Server
```bash
sudo systemctl restart mumble-server
```

### Restart the Cloudflare Tunnel
```bash
sudo systemctl restart cloudflared
```

### Restart Everything
```bash
sudo systemctl restart mumble-server mumble-bridge cloudflared
```

### Check Status of Everything
```bash
sudo systemctl status mumble-bridge --no-pager
sudo systemctl status mumble-server --no-pager
sudo systemctl status cloudflared --no-pager
```

---

## Viewing Logs

### Bridge logs (most useful for debugging)
```bash
# Live tail
sudo journalctl -u mumble-bridge -f

# Last 100 lines
sudo journalctl -u mumble-bridge -n 100 --no-pager

# Last 5 minutes
sudo journalctl -u mumble-bridge --since "5 min ago" --no-pager
```

### Mumble server logs
```bash
sudo journalctl -u mumble-server -n 50 --no-pager
```

### Tunnel logs
```bash
sudo journalctl -u cloudflared -n 50 --no-pager
```

---

## Running Tests

The project includes automated tests in the `tests/` folder.

### Run all tests
```bash
cd /home/alex/Documents/mumble/mumble-bridge
npm test
```

### Run individual tests
```bash
npm run test:http     # HTTP server + static files
npm run test:ws       # WebSocket connection + auth flow
npm run test:voice    # Voice bridge session lifecycle
npm run test:e2e      # Two-client voice end-to-end
```

### What the tests verify
- **test-http-server.js** — HTML/CSS/JS served correctly, cache busting works, 404s returned, no directory traversal
- **test-ws-connect.js** — WebSocket connects, JSON auth works, binary not misrouted, history retrieval, clean disconnect
- **test-voice-bridge.js** — VoiceBridge initializes, sessions start/stop, audio encoding works, Mumble connections established
- **test-two-clients.js** — Two users connect, authenticate, start voice, send audio, receive voice state broadcasts, stop voice, disconnect

### When to run tests
- After any code change
- After restarting the bridge
- When debugging connection issues

---

## Important Files

| File | Purpose |
|------|---------|
| `src/index.js` | Main entry point — boots all services |
| `src/ws-server.js` | HTTP + WebSocket server, serves the website, routes messages |
| `src/voice-bridge.js` | Per-user Mumble TLS connections for voice (Opus encode/decode) |
| `src/mumble-connection.js` | Main bridge's Mumble connection (text chat, channel sync) |
| `src/config.js` | All configuration (ports, credentials from .env) |
| `src/lexicon-client.js` | Lexicon API client (user auth, message storage) |
| `src/database.js` | MySQL connection pools and schema |
| `src/bot-engine.js` | Chat bot commands (!help, etc.) |
| `public/index.html` | Web UI HTML |
| `public/css/style.css` | Web UI styles |
| `public/js/chat.js` | Web UI logic — chat, voice, channels |
| `public/js/voice-processor.js` | AudioWorklet — mic capture + playback on audio thread |
| `tests/` | Automated test suite |
| `.env` | Environment variables (MySQL creds, ports, etc.) |
| `proto/Mumble.proto` | Mumble protocol buffer definitions |

---

## Credentials & Config

| Thing | Value |
|-------|-------|
| **Website URL** | `https://voice.alex-dyakin.com` |
| **Server LAN IP** | `192.168.4.87` |
| **Server Public IP** | `46.110.37.62` |
| **Mumble port** | `64738` |
| **Bridge port** | `3080` |
| **MySQL database** | `mumble_bridge` (user: `mumble`, pass: `mumble_pass_2026`) |
| **Lexicon API** | `http://147.185.221.24:15856` |
| **Bridge Lexicon account** | `mumble-bridge` / `bridge-service-2026` |

---

## Common Problems

### "Can't connect / nothing happens when clicking Connect"
- Check bridge is running: `sudo systemctl status mumble-bridge`
- Check logs for errors: `sudo journalctl -u mumble-bridge -n 30 --no-pager`
- Run the tests: `npm test`
- Hard refresh the page: Ctrl+Shift+R (or Cmd+Shift+R on Mac)
- Restart: `sudo systemctl restart mumble-bridge`

### "Can't hear other person in voice"
- Both users must click "Join Voice" and allow microphone
- Check bridge logs for `[Voice] Session started` messages
- Run `npm run test:e2e` to verify two-client voice flow
- Restart: `sudo systemctl restart mumble-bridge`

### "Website not loading / shows old version"
- Restart the bridge: `sudo systemctl restart mumble-bridge`
- The bridge generates a new cache-bust version on each restart
- Check tunnel: `sudo systemctl status cloudflared`
- Hard refresh: Ctrl+Shift+R

### "Online list shows nobody / only MumbleBridge"
- Web users appear after they connect and authenticate
- Native Mumble users show as their Mumble username
- Restart bridge if the list is stuck

### "Voice worked then stopped"
- Check if Mumble server is still running: `sudo systemctl status mumble-server`
- Check bridge logs for connection errors
- Restart both: `sudo systemctl restart mumble-server mumble-bridge`

---

## Architecture Diagram

```
                    Internet Users
                         │
                   Cloudflare CDN
                         │
                  Cloudflare Tunnel
                         │
                    localhost:3080
                         │
              ┌──────────┴──────────┐
              │   Mumble Bridge     │
              │   (Node.js app)     │
              │                     │
              │  HTTP Server ───────┤── Serves website (HTML/CSS/JS)
              │  WebSocket Server ──┤── Real-time chat (JSON) + voice (binary PCM)
              │  Voice Bridge ──────┤── Per-user Mumble TLS connections
              │                     │       Each web user = separate Mumble client
              │                     │       Opus encode/decode per session
              └──────────┬──────────┘
                         │
                  TLS connections
                (one per web user + one for bridge bot)
                         │
              ┌──────────┴──────────┐
              │   Mumble Server     │
              │   (murmurd)         │
              │   port 64738        │
              │                     │
              │  Audio mixing       │
              │  Channels, Users    │
              │  Permissions, Text  │
              └──────────┬──────────┘
                         │
                    MySQL 8.0
              (user data, messages)
```

All services start automatically on boot (systemd enabled).

## Systemd Service Files

| Service | File |
|---------|------|
| mumble-bridge | `/etc/systemd/system/mumble-bridge.service` |
| mumble-server | `/etc/systemd/system/mumble-server.service` |
| cloudflared | Managed by `cloudflared service install` |
