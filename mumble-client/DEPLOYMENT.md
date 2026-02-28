# MumbleChat Desktop — Deployment Guide

## Prerequisites

- **Node.js 18+** — [https://nodejs.org](https://nodejs.org)
- **npm** (comes with Node.js)

## Quick Start (Development)

```bash
cd mumble-client
npm install
npm start
```

## Running Tests

```bash
npm test
```

All 38 tests should pass (Protocol: 16, Voice: 22).

---

## Building Packages

### Windows (Portable EXE + NSIS Installer)

```bash
npm run package-win
```

Output: `dist/MumbleChat Setup *.exe` (installer) and `dist/MumbleChat *.exe` (portable).

> **Note:** Building Windows packages on Linux requires `wine` installed:
> ```bash
> sudo apt install wine64
> ```

### Linux (AppImage + .deb)

```bash
npm run package-linux
```

Output: `dist/MumbleChat-*.AppImage` and `dist/mumble-chat_*.deb`.

### Both Platforms

```bash
npm run package-all
```

---

## Distribution to Friends

### Option A: Share the AppImage / Portable EXE

1. Build the package for the target platform.
2. Send them the file:
   - **Linux:** `MumbleChat-*.AppImage` — make executable with `chmod +x`, then double-click.
   - **Windows:** `MumbleChat *.exe` (portable) — just run it, no install needed.

### Option B: Share source + build instructions

1. Give them this repo / zip of `mumble-client/`.
2. They run:
   ```bash
   npm install
   npm start
   ```

---

## Connection Settings

When the app launches, the login screen asks for:

| Field | Default | Description |
|-------|---------|-------------|
| Server | `127.0.0.1` | Mumble server IP/hostname |
| Port | `64738` | Mumble server port |
| Username | (empty) | Your display name (min 2 chars) |

### For Remote Connections

Your Mumble server is at `localhost:64738`. For friends to connect remotely, they need your **public IP** or a **domain/tunnel**.

**Option 1: PlayIt / Cloudflare Tunnel (recommended)**
- Set up a PlayIt tunnel or Cloudflare Tunnel for port `64738` (TCP).
- Give friends the tunnel address (e.g., `mumble.example.com`).

**Option 2: Port forwarding**
- Forward port `64738` TCP on your router to your server's local IP.
- Friends use your public IP (find it at [whatismyip.com](https://whatismyip.com)).

**Option 3: LAN only**
- Friends on the same network use your local IP (e.g., `192.168.1.x`).

### Lexicon API

The app connects to the Lexicon API for user registration and message persistence.

- Default URL: `http://147.185.221.24:15856` (PlayIt tunnel)
- Changeable in Settings → Connection tab.

---

## Server Requirements

- **Mumble Server (murmurd)** running on the target host.
- **Lexicon API** running and accessible (for user registration + message history).
- Mumble server should have channels pre-created (or the admin user can create them via the app).

### Admin Users

Users listed in the `superUsers` array in `main.js` (default: `['alex']`) can:
- Create channels
- Delete channels

---

## Architecture

```
┌──────────────────────────┐
│   Electron Renderer      │
│   (app.js + AudioWorklet)│
│   ┌───────────────┐      │
│   │ Mic → PCM     │──IPC─┼─┐
│   │ PCM → Speaker │←─IPC─┼─┤
│   └───────────────┘      │ │
└──────────────────────────┘ │
                              │
┌──────────────────────────┐ │
│   Electron Main Process  │ │
│   ┌────────────────────┐ │ │
│   │ Opus Encode/Decode │←┘ │
│   │ Audio Mixer (20ms) │   │
│   │ MumbleConnection   │───┼── TLS → Mumble Server :64738
│   │ LexiconClient      │───┼── HTTP → Lexicon API :15856
│   └────────────────────┘   │
└────────────────────────────┘
```

- **Audio path:** Mic → AudioWorklet → Int16 PCM → IPC → Main → Opus encode → TLS to Mumble
- **Playback:** Mumble TLS → Main → Opus decode → Mix → IPC → AudioWorklet → Speaker
- **Text:** Renderer → IPC → Main → Mumble TextMessage + Lexicon API → IPC → Renderer
- **No WebSocket layer** — direct TLS connection eliminates the bridge bottleneck.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Connection failed" | Check server IP/port. Make sure Mumble is running. |
| No microphone | Grant mic permission. Check Settings → Voice for device. |
| Choppy audio | Check network latency. Lower VAD threshold in settings. |
| "WASM crash" in logs | OpusScript issue. Restart the app. |
| Can't create channels | Only superUsers (alex) can create/delete channels. |
| No message history | Lexicon API must be running and reachable. |

---

## File Structure

```
mumble-client/
├── main.js              # Electron main process
├── preload.js           # Secure IPC bridge
├── package.json         # Dependencies & build config
├── DEPLOYMENT.md        # This file
├── proto/
│   ├── Mumble.proto     # Mumble protocol definitions
│   └── MumbleUDP.proto  # Mumble UDP definitions
├── src/
│   ├── mumble/
│   │   ├── protocol.js  # Protobuf encode/decode + TCP framing
│   │   ├── voice.js     # Opus codec + audio mixer
│   │   ├── connection.js# TLS connection to Mumble server
│   │   └── lexicon.js   # Lexicon API HTTP client
│   └── renderer/
│       ├── index.html   # Discord-like UI
│       ├── style.css    # Dark theme styles
│       ├── app.js       # Renderer JavaScript (UI logic)
│       ├── voice-processor.js  # AudioWorklet
│       └── assets/
│           └── default.jpg     # Default avatar
└── tests/
    ├── protocol.test.js # Protocol unit tests (16 tests)
    └── voice.test.js    # Voice unit tests (22 tests)
```
