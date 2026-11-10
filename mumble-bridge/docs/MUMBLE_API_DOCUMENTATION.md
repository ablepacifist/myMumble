# Mumble Bridge API Documentation

**Version:** 1.0  
**Base URL (Frontend + API):** `https://voice.alex-dyakin.com`  
**WebSocket URL:** `wss://voice.alex-dyakin.com` (production) or `ws://localhost:3080` (local)  
**Native Mumble server:** `<host>:64738` (TCP + UDP, not proxied — see [Service Map](#service-map))  
**Last Updated:** September 20, 2026 (initial full audit of every port, route, WebSocket message, and CORS rule on this host)

> **How to read this document.** Everything here was derived from the source at commit `b2b29e31d` (`mumble-bridge/src/**`) and cross-checked against the *running* service on this PC. Statements tagged **(verified live)** were confirmed by sending real requests to `localhost:3080` and/or `https://voice.alex-dyakin.com` on 2026-09-20 (read-only `GET`/`OPTIONS` and an unauthenticated WebSocket connection — nothing that writes data). Untagged behaviour comes from reading the code. Where I could not verify something, it says so.

## Environment Info
- **Bridge service:** Node.js app (`mumble-bridge`, `src/index.js`), systemd unit `mumble-bridge.service`, runs as user `alex`, `NODE_ENV=production`, `Restart=on-failure`. Listens on **port 3080** (all interfaces) serving HTTP **and** WebSocket on the same port.
- **Mumble server:** `mumble-server` 1.5.517, systemd unit `mumble-server.service`, port **64738** TCP + UDP. Data in MySQL database `mumble_server`.
- **Public exposure:** Cloudflare Tunnel (`cloudflared.service`, config `/etc/cloudflared/config.yml`). Only the bridge is published: `voice.alex-dyakin.com` → `http://localhost:3080`.
- **Database:** MySQL 8 on `127.0.0.1:3306` — databases `mumble_server` (Mumble's own) and `mumble_bridge` (the bridge's tables).
- **Upstream dependency:** Lexicon API at `https://api.alex-dyakin.com` (**not** on this PC — nothing is listening on 36568/8080/3001 here). Message history, users, media, push and notifications all live there.
- **Optional integration:** Discord bot (channel sync) — enabled on this host.
- **Authentication:** None at the HTTP level. WebSocket login is **username-only** (or a Lexicon SSO token). See [Security Notes](#security-notes--known-issues) — this matters.
- **CORS:** HTTP routes only. Allow-list of `localhost`, `capacitor://localhost`, and `https://alex-dyakin.com` + one-level subdomains. WebSockets are **not** origin-checked.
- **Log level / diagnostics:** `LOG_LEVEL=debug`, `VOICE_DIAG_ENABLED=true` (voice diagnostics log to `mumble-bridge/logs/`).

## Table of Contents
1. [Service Map](#service-map)
2. [Authentication & Security Model](#authentication--security-model)
3. [CORS Configuration](#cors-configuration)
4. [HTTP Endpoints](#http-endpoints)
   - [Route Summary](#route-summary)
   - [Static Files & Web UI](#static-files--web-ui)
   - [Avatars](#avatars)
   - [Chat File Upload & Proxy](#chat-file-upload--proxy)
   - [Push](#push)
   - [Diagnostics](#diagnostics)
   - [Fallback Responses](#fallback-responses)
5. [WebSocket API](#websocket-api)
   - [Connection & Framing](#connection--framing)
   - [Auth Flow](#auth-flow)
   - [Channel Routing Rules](#channel-routing-rules)
   - [Access Matrix](#access-matrix)
   - [Client → Server Messages](#client--server-messages)
   - [Server → Client Events](#server--client-events)
6. [Voice Audio Protocol (Binary)](#voice-audio-protocol-binary)
7. [Bot Commands & Music Bot](#bot-commands--music-bot)
8. [Mumble ↔ Web Relay Behaviour](#mumble--web-relay-behaviour)
9. [Outbound Integrations](#outbound-integrations)
10. [Data Models](#data-models)
11. [Error Responses](#error-responses)
12. [Integration Guidelines](#integration-guidelines)
13. [Testing Endpoints](#testing-endpoints)
14. [Deployment & Operations](#deployment--operations)
15. [System Architecture](#system-architecture)
16. [Security Notes & Known Issues](#security-notes--known-issues)

---

## Service Map

### Everything Mumble-related that listens on this PC

| Port | Proto | Bound to | Process | What it is | Reachable from internet? |
|---|---|---|---|---|---|
| **3080** | TCP | `*` (all interfaces) | `node src/index.js` (`mumble-bridge.service`) | Bridge: HTTP + WebSocket (web UI, JSON API, voice audio) | **Yes**, via Cloudflare Tunnel at `voice.alex-dyakin.com` (and on the LAN directly by IP) |
| **64738** | TCP | `*` | `mumble-server` | Mumble protocol (TLS control channel) | Only via router port-forward — **not** through Cloudflare |
| **64738** | UDP | `*` | `mumble-server` | Mumble voice (native clients) | Only via router port-forward — **not** through Cloudflare |
| 3306 | TCP | `127.0.0.1` | `mysqld` | MySQL (`mumble_server`, `mumble_bridge`) | No (loopback only) |
| 33060 | TCP | `127.0.0.1` | `mysqld` | MySQL X protocol | No (loopback only) |

**Not present (checked):** no Mumble ICE (6502), gRPC (50051), or Mumble-hosted HTTP/WebSocket endpoint is listening. The bridge is the only HTTP/WS surface for Mumble. **(verified live)**

### Cloudflare Tunnel ingress (`/etc/cloudflared/config.yml`, the file the running service uses)

| Hostname | Origin | Belongs to |
|---|---|---|
| `voice.alex-dyakin.com` | `http://localhost:3080` (`noTLSVerify: true`, irrelevant for plain http) | **Mumble bridge** — documented here |
| `ksp.alex-dyakin.com` | `http://localhost:8800` | Luna Multiplayer KSP server (`lmp-server.service`, a .NET process) — **not Mumble; out of scope** |
| *(anything else)* | `http_status:404` | — |

> The tunnel is shared with a non-Mumble service. Note also that `/home/alex/.cloudflared/config.yml` is an **older copy that lacks the `ksp` entry** — `cloudflared.service` reads `/etc/cloudflared/config.yml`, so edit that one.

### Other listeners on this host (not Mumble, not documented here)
`8800` (KSP/LMP, above), `27008` (ARK RCON), `37833` (PalServer, loopback), `22` (SSH), `2049`/`111` (NFS/rpcbind), `631` (CUPS, loopback), `9993` (ZeroTier), `3478` (many sockets, owner not visible without root), plus VS Code helper ports. Listed only so you can tell they are not part of the Mumble stack.

---

## Authentication & Security Model

The bridge has **no HTTP sessions, cookies, or API keys.** Every HTTP route is anonymous. Identity exists only on the WebSocket, and it is asserted by the client.

### WebSocket identity
| Method | Message | What the server checks |
|---|---|---|
| Username-only | `{ "type": "auth", "username": "alice" }` | **Nothing.** No password. The name is looked up in Lexicon; if absent, a Lexicon account is auto-registered with a random password. |
| SSO token | `{ "type": "sso_auth", "token": "..." }` | Token is validated against Lexicon (`POST /api/auth/sso/validate-token`). Tokens are single-use, 60 s expiry, generated by Lexicon's `POST /api/auth/sso/generate-token`. |

Both paths set the same session state on the socket (`authenticated`, `username`, `userId`, `isAdmin`) which lives only as long as the socket. A socket can re-send `auth` at any time to change identity (there is no "already authenticated" guard).

### Roles
- **User:** any authenticated socket.
- **Admin ("superuser"):** `isAdmin = true` iff the resolved display name (case-insensitive) appears in the `SUPERUSER_NAMES` env var (currently 1 name configured). This is a **name match only** — it is granted by *whichever* auth path yields that name, including the password-less `auth`. See [Security Notes](#security-notes--known-issues).
- Admin-only operations: `create_channel`, `remove_channel`, `get_known_users`, `get_channel_access`, `set_channel_access`, `set_channel_discord_link`, `pin_message`, `unpin_message`.

### Channel access control (web app only)
An admin can *restrict* a text channel to a set of Lexicon user IDs (`set_channel_access`). Restricted channels are hidden from `server_state`/`channel_update`, refuse `text`/`get_history`/etc., and only admins plus granted users can use them. **This applies only to traffic through the bridge WebSocket.** Native Mumble desktop clients connect straight to port 64738 and are unaffected — this is a documented, permanent limitation of the design.

### `userId` semantics
`userId` is the Lexicon player ID. `0` is a **valid** ID. If Lexicon is unreachable during `auth`, the server falls back to a stub with `userId: null` and still reports success (see Known Issues).

---

## CORS Configuration

CORS is implemented by hand in `src/http-server.js` and applies to **HTTP requests only**. It is *not* applied to the WebSocket upgrade.

### Allowed origins (exact regexes)
```
/^https?:\/\/localhost(:\d+)?$/            → http://localhost, http://localhost:3000, https://localhost:8443, …
/^capacitor:\/\/localhost$/                → the Android (Capacitor) app shell
/^https:\/\/([a-z0-9-]+\.)?alex-dyakin\.com$/ → https://alex-dyakin.com and ONE-level subdomains (voice., api., app., …)
```
**Not allowed:** `http://alex-dyakin.com` (plain http), two-level subdomains like `a.b.alex-dyakin.com`, `http://127.0.0.1:*`, LAN IPs (`http://192.168.x.x`), PlayIt origins, `ionic://localhost`. This is a much shorter list than Lexicon's — do not assume the two share an allow-list.

### Behaviour (verified live, both on `localhost:3080` and through Cloudflare)

| Request `Origin` | `Access-Control-Allow-Origin` | `Allow-Credentials` | Result in a browser |
|---|---|---|---|
| `https://voice.alex-dyakin.com` | echoed back | `true` | ✅ allowed |
| `https://app.alex-dyakin.com` | echoed back | `true` | ✅ allowed |
| `capacitor://localhost` | echoed back | `true` | ✅ allowed |
| `https://evil.example` | *(absent)* | *(absent)* | ❌ blocked |
| `https://alex-dyakin.com.evil.com` | *(absent)* | *(absent)* | ❌ blocked (regex is anchored) |
| `http://alex-dyakin.com` | *(absent)* | *(absent)* | ❌ blocked (https only) |
| *(no Origin header)* | *(absent)* | *(absent)* | n/a — non-browser clients are unaffected |

### Header details
On any response (200, 404, 405, static file, …) to a request with an allowed `Origin`:
```
Access-Control-Allow-Origin: <the request's Origin, echoed — never "*">
Access-Control-Allow-Credentials: true
Vary: Origin
```
On **any** `OPTIONS` request, to **any** path, regardless of origin — status `204 No Content`:
```
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```
(The `Allow-Origin` header is added only when the origin matched; a disallowed origin still gets a 204 preflight but without it, so the browser rejects the request.)

### Important CORS notes
1. **No `Access-Control-Expose-Headers`.** Cross-origin JS can read only CORS-safelisted response headers (`Content-Type`, `Cache-Control`, …), not `Content-Length` etc.
2. **Any request header other than `Content-Type` / `Authorization` fails preflight** from a browser (e.g. `X-Requested-With`, `Range`).
3. **`Allow-Credentials: true` is effectively unused** — the bridge never sets or reads cookies.
4. **Same-origin traffic is unaffected.** The bundled web UI at `voice.alex-dyakin.com` calls its own origin, so it never triggers CORS. Only the Android shell and other-origin sites do.
5. **WebSockets bypass all of this.** Browsers do not apply CORS to WebSocket handshakes, and the server does not inspect `Origin` on upgrade — **(verified live)** a connection with `Origin: https://evil.example` was accepted and served. Any web page anywhere can open a socket to `wss://voice.alex-dyakin.com`.

### To add a new origin
Edit `ALLOWED_ORIGINS` in `mumble-bridge/src/http-server.js` and restart:
```bash
sudo systemctl restart mumble-bridge
```

---

## HTTP Endpoints

All HTTP is served by one handler in `src/http-server.js`. Request order: **CORS headers → `OPTIONS` shortcut → API routes → 405 for any other non-GET → static files.**

### Route Summary

| Method | Path | Purpose | Auth | Notes |
|---|---|---|---|---|
| `OPTIONS` | *any path* | CORS preflight | none | Always `204` |
| `GET` | `/` , `/{file}` | Web UI + static assets from `public/` | none | HTML gets cache-busting `?v=`; `no-store` |
| `GET` | `/api/avatar/{username}` | Look up a user's avatar URL | none | |
| `POST` | `/api/avatar/upload` | Upload/replace an avatar (multipart) | **none** | ≤ 2 MB image |
| `POST` | `/api/avatar/remove` | Clear a user's avatar (JSON) | **none** | |
| `POST` | `/api/chat/upload` | Upload a chat image/GIF (multipart → Lexicon) | **none** | ≤ 8 MB |
| `GET` | `/api/chat/files/{id}` | Proxy a chat file from Lexicon | none | |
| `GET` | `/api/chat/files/{id}/thumb` | Proxy a chat thumbnail from Lexicon | none | |
| `GET` | `/api/push/vapid-key` | Web-Push VAPID public key (from Lexicon) | none | |
| `GET` | `/api/diag/logs` | Tail voice diagnostic logs | **none** | Publicly reachable |
| `GET` | `/api/diag/summary` | Voice diagnostic summary stats | **none** | Publicly reachable |
| `GET` | `/api/diag/files` | List diagnostic log files | **none** | Publicly reachable |
| `WS` | `/` (upgrade on port 3080) | Real-time chat + voice | see [Auth Flow](#auth-flow) | |

There is **no** `/api/health`, `/api/info`, or version endpoint. To check liveness, `GET /` (expect `200 text/html`) or open the WebSocket and wait for `server_state`.

---

### Static Files & Web UI

#### `GET /` and `GET /{path}`
Serves files from `mumble-bridge/public/`. `/` maps to `/index.html`.

- **Content types:** `.html .css .js .json .png .jpg/.jpeg .gif .webp .svg .ico .woff .woff2` mapped; anything else → `application/octet-stream`.
- **Caching:** every static response carries `Cache-Control: no-cache, no-store, must-revalidate`. For `.html`, any `*.css` / `*.js` reference is rewritten to `…?v=<BUILD_VERSION>` where `BUILD_VERSION` is generated **at process start** (so each restart busts client caches).
- **Path safety:** path is normalized and must stay inside `public/`; escapes return `403`/`404`. `GET /../../etc/passwd` → `404`. **(verified live)**
- **`HEAD`, `PUT`, `DELETE`, `POST` to non-API paths** → `405`.
- **Everything under `public/` is served**, including `public/react-src/` (build sources and `package.json`) and `public/uploads/`. **(verified live)** `GET /react-src/package.json` → `200`, also via the public hostname.

Notable static assets:
| Path | Purpose |
|---|---|
| `/index.html` | Single-page web client |
| `/js/chat.js`, `/js/voice-processor.js`, `/js/rich-text-renderer.js` | Client logic; AudioWorklet mic/playback; message rendering |
| `/react/features-bundle.js`, `/react/style.css`, `/css/style.css` | Built feature UI (reactions, typing, mentions, toasts) |
| `/sw.js` | Service Worker for Web Push (`push` + `notificationclick` handlers) |
| `/uploads/avatars/{file}` | Stored avatar images (`default.jpg` is the fallback) |
| `/assets/icon-192.png` | Push notification icon |

---

### Avatars

Avatars are files in `public/uploads/avatars/` with paths recorded in MySQL `mumble_bridge.user_profiles`. Other services (Lexicon, Alchemy) read these — see `docs/AVATAR_API_INTEGRATION.md`.

#### `GET /api/avatar/{username}`
**Path:** `username` — URL-encoded, case-sensitive match against `user_profiles.username`.

**Response (200):**
```json
{ "avatarUrl": "/uploads/avatars/alex_1771710676768.webp" }
```
Unknown user or user with no avatar → `{ "avatarUrl": "/uploads/avatars/default.jpg" }` (still `200`). **(verified live)** The URL is **relative** — prefix it with the bridge origin (`https://voice.alex-dyakin.com`) to fetch the image.

**Errors:**
- `500` `{ "error": "Internal error" }` — database failure.
- **Malformed percent-encoding** (e.g. `/api/avatar/%E0%A4%A`) → **no response at all**; the request hangs until the client times out, and an unhandled-rejection line is logged. The process survives. **(verified live)** See Known Issues.

---

#### `POST /api/avatar/upload`
Upload or replace an avatar.

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | text | yes | Whose avatar to set. **Not verified against any session.** |
| `userId` | text (int) | no | Lexicon user id; stored in `user_profiles.lexicon_user_id` (kept if omitted) |
| `avatar` | file | yes | Image. Must have a `filename`. |

**Constraints:** part `Content-Type` must be `image/jpeg`, `image/png`, `image/gif`, or `image/webp`; file ≤ **2 MB** (2 097 152 bytes). The type is taken from the multipart part header, **not sniffed from file contents**.

**Behaviour:** saved as `{safeUsername}_{epochMs}.{ext}` (username sanitized to `[A-Za-z0-9_-]`, others → `_`); `user_profiles` upserted. Older avatar files for that user are **not** deleted.

**Response (200):**
```json
{ "avatarUrl": "/uploads/avatars/alex_1771710676768.webp" }
```
**Errors:**
- `400` `{ "error": "Expected multipart/form-data" }` / `{ "error": "No boundary found" }` / `{ "error": "Missing username or file" }` / `{ "error": "Unsupported image type: <type>" }` / `{ "error": "File too large. Max 2MB." }`
- `500` `{ "error": "Upload failed" }`
- **Oversized bodies:** if the raw body exceeds 2 MB + 4 KB, the server destroys the connection **without sending any HTTP response** — clients see a connection reset, not the `400` above.

After a successful upload the client is expected to tell others over the WebSocket with `avatar_changed` (see below); the HTTP call alone does not broadcast.

---

#### `POST /api/avatar/remove`
Clear a user's avatar (sets `avatar_path = NULL`; does not delete the file).

**Request (`application/json`):**
```json
{ "username": "alex" }
```
**Response (200):** `{ "ok": true }` (returned even if the user has no profile row)  
**Errors:** `400` `{ "error": "Missing username" }`; `500` `{ "error": "Remove failed" }` (also returned for invalid JSON).

---

### Chat File Upload & Proxy

Chat images are **stored in Lexicon**, not on this PC. The bridge is a thin pass-through so browsers only talk to one origin.

#### `POST /api/chat/upload`
**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | file | yes | Image (needs a `filename`) |
| `userId` | text (int) | yes | Uploader's Lexicon id (**client-asserted**) |
| `channelId` | text (int) | no | Channel the file is shared in (default `0`) |
| `username` | text | no | Logging only |

**Constraints:** `image/jpeg`, `image/png`, `image/gif`, `image/webp` only; ≤ **8 MB**. Oversized bodies (> 8 MB + 8 KB) → connection destroyed with no response (same as avatars).

**Response (200):** Lexicon's upload response, passed through unchanged:
```json
{
  "id": 12345,
  "url": "/api/chat/files/12345",
  "thumbnailUrl": "/api/chat/files/12345/thumb",
  "originalFilename": "screenshot.png",
  "mimeType": "image/png",
  "width": 1920,
  "height": 1080,
  "fileSize": 245760,
  "uploadedBy": 7,
  "createdAt": "2026-04-03T12:00:00"
}
```
**Errors:** `400` `{ "error": "Expected multipart/form-data" | "No boundary found" | "Missing required fields (file, userId)" | "Unsupported file type: <t>. Allowed: JPEG, PNG, GIF, WebP" | "File too large. Max 8MB." }`; `500` `{ "error": "Upload failed: <message>" }` (Lexicon error or unreachable).

To *post* the uploaded image into chat, follow up with the WebSocket `image` message using the returned `id`/`url`/`thumbnailUrl`.

---

#### `GET /api/chat/files/{id}` and `GET /api/chat/files/{id}/thumb`
`{id}` must be digits only (regex `^/api/chat/files/\d+(/thumb)?$`; anything else falls through to static → `404`).

Fetches `https://api.alex-dyakin.com/api/chat/files/{id}[/thumb]` server-side and returns the bytes.

**Response (200):** raw image; `Content-Type` copied from Lexicon; `Content-Length` set; **`Cache-Control: public, max-age=31536000, immutable`** (1 year).  
**Errors:** Lexicon non-2xx status is forwarded with body `Not Found` (if 404) or `Error` (`text/plain`) — **(verified live)** unknown id → `404 text/plain`. Lexicon unreachable → `502` `{ "error": "Could not fetch file from Lexicon" }`.

> Because responses are marked immutable/public, a file that is later deleted or replaced in Lexicon may keep being served from browser/Cloudflare caches for up to a year.

---

### Push

#### `GET /api/push/vapid-key`
Returns the Web-Push VAPID **public** key, fetched from Lexicon (`GET /api/push/vapid-key`).

**Response (200):** `{ "publicKey": "B…" }` **(verified live, 87-char key)**. If Lexicon returns no key: `{ "publicKey": null }` (still `200`).  
**Errors:** `500` `{ "error": "<message>" }`.

Subscribing/unsubscribing is done over the WebSocket (`push_subscribe` / `push_unsubscribe`), not HTTP.

---

### Diagnostics

Voice-pipeline diagnostics, backed by `mumble-bridge/logs/voice-YYYY-MM-DD.log` (50 MB rotation). Comment in source says "admin only, for testing" — **there is no authentication**, and **(verified live) all three are reachable through `https://voice.alex-dyakin.com`.**

If the voice bridge is not yet initialised each returns `503` `{ "error": "Voice bridge not initialized" }`; unexpected failures return `500` `{ "error": "<message>" }`.

#### `GET /api/diag/logs?lines={n}`
Tail of today's diagnostic log. `lines` default 500, capped at 5000. (`startsWith` matching: `/api/diag/logsANYTHING` also matches.)  
**Response (200):** `text/plain; charset=utf-8` — one JSON object per line. Empty log → tiny body **(verified live)**.

#### `GET /api/diag/summary`
**Response (200):** `application/json` with keys `totalEvents`, `eventsByType`, `metrics`, `errors`, `metricStats`, `ErrorCount`, `topErrors`. **(verified live)**

#### `GET /api/diag/files`
**Response (200):** `{ "files": ["voice-2026-09-20.log", …] }` — array of filename strings. **(verified live, 16 files)**

---

### Fallback Responses

| Situation | Status | Body |
|---|---|---|
| Unknown `GET` path (not in `public/`, not a file) | `404` | `Not Found` (`text/plain`) — **(verified live)** |
| Path escapes `public/` | `403` `Forbidden` / `404` | `text/plain` |
| Any non-`GET`/`OPTIONS` method on a non-API path, incl. `POST /api/nope` | `405` | `Method Not Allowed` (`text/plain`) — **(verified live)** |
| File read error | `500` | `Internal Server Error` |

---

## WebSocket API

### Connection & Framing
- **URL:** `wss://voice.alex-dyakin.com/` (any path upgrades; there is no dedicated `/ws` route). Local: `ws://localhost:3080/`.
- **Text frames:** UTF-8 JSON, one object per frame, always with a `type` string.
- **Binary frames:** raw voice audio — see [Voice Audio Protocol](#voice-audio-protocol-binary). A binary frame from a socket with no active voice session is silently dropped.
- **Handshake:** no subprotocol, no `Origin` check, no token. **(verified live)**
- **Keep-alive:** the server sends **no** WebSocket pings and has no idle timeout of its own. Clients should send their own periodic traffic; intermediaries (Cloudflare) may close idle sockets.
- **Reconnect:** the client must re-send `auth`/`sso_auth` after every reconnect; nothing is remembered.
- **Bad frames:** invalid JSON → `{ "type": "error", "message": "Invalid JSON" }`; unhandled handler exception → `{ "type": "error", "message": "Internal server error" }`.

On connect the server immediately sends (before any auth):
```json
{
  "type": "server_state",
  "channels": [ { "id": 0, "name": "Root", "parentId": 0, "description": "" } ],
  "users":    [ { "session": 3, "name": "someone", "channelId": 0, "mute": false, "deaf": false, "selfMute": false, "selfDeaf": false } ]
}
```
Restricted channels are omitted from this pre-auth snapshot. **(verified live: 28 channels, 1 user; field names as shown)**

### Auth Flow
1. Client opens the socket → receives `server_state`.
2. Client sends `auth` (username) **or** `sso_auth` (token).
3. On success the server sends `auth_ok`, then `web_users`, possibly a second `server_state` (restricted channels this user may see, with `users: []`), and `dm_unread_counts` if any DMs are unread; it also broadcasts `web_user_join` to everyone.
4. Client sends `join_channel` to choose which channel's traffic it receives (see [Channel Routing Rules](#channel-routing-rules)).

#### `auth`
```json
{ "type": "auth", "username": "alice" }
```
**Success → `auth_ok`:**
```json
{ "type": "auth_ok", "username": "alice", "userId": 42, "isAdmin": false }
```
`username` in the reply is Lexicon's display name if one exists, which can differ from what was sent. `userId` can be `null` if Lexicon was unreachable.  
**Errors:** `{ "type": "error", "message": "Username is required" }` **(verified live)**.

#### `sso_auth`
```json
{ "type": "sso_auth", "token": "<one-time token from Lexicon>" }
```
**Success:** same as `auth_ok` plus `"sso": true`.  
**Errors:** `{ "type": "error", "message": "SSO token is required" }` **(verified live)**; `{ "type": "auth_error", "message": "Invalid or expired SSO token" }`.

**Side effects of a successful login (both methods):** upserts `mumble_bridge.user_mapping`; registers presence as `web_{userId}`; looks up the user's avatar.

### Channel Routing Rules
Channel-scoped broadcasts (`text`, `image`, `typing`, `reaction_update`, `pin_added`, `pin_removed`) are delivered by `_broadcastToChannel`:

| Channel is… | Delivered to |
|---|---|
| **Unrestricted** | every socket whose current `channelId` equals the channel **or is `null`** |
| **Restricted** | only sockets currently joined (`join_channel`) to that channel **and** permitted (admin or granted) |

A socket's `channelId` starts as `null` and is set only by `join_channel`. Consequently a socket that has **not joined any channel** — including an **unauthenticated** one — receives all channel-scoped traffic for every *unrestricted* channel. (Derived from `ws-server.js:190-204`; not exercised live because that requires another user to post.) Server-wide events (`user_update`, `web_user_join`, `voice_state`, `avatar_updated`, …) go to **all** sockets, authenticated or not.

### Access Matrix

| Message | Unauthenticated | Authenticated | Admin only | Channel-access enforced |
|---|---|---|---|---|
| `auth`, `sso_auth` | ✅ | — | | |
| `format_preview` | ✅ | ✅ | | |
| `media_search`, `now_playing`, `music_queue` | ✅ | ✅ | | |
| `voice_stop` | ✅ (no-op) | ✅ | | |
| `text`, `image`, `get_history`, `jump_to_message`, `search_messages` | `error: Not authenticated` | ✅ | | ✅ |
| `join_channel` | ignored silently | ✅ | | ✅ |
| `voice_start`, `voice_join_channel` | `error` | ✅ | | |
| `create_channel`, `remove_channel` | `error: Not authenticated` | `error: Only superusers…` | ✅ | |
| `get_known_users`, `get_channel_access`, `set_channel_access` | `error: Not authenticated` | `error: Only superusers…` | ✅ | |
| `pin_message`, `unpin_message` | `error: Not authenticated` | `error: Only superusers…` | ✅ | ✅ |
| `get_pinned_messages` | `error: Not authenticated` | ✅ | | ✅ |
| `set_channel_discord_link` | `error: Not authenticated` | `error: Only superusers…` | ✅ | |
| `reaction_add`, `reaction_remove` | ignored silently | ✅ | | ✅ |
| `get_reactions`, `get_reactions_batch` | ignored silently | ✅ | | ❌ (no check) |
| `typing_start`, `typing_stop` | ignored silently | ✅ | | ✅ |
| `dm_*` (5 types) | ignored silently | ✅ | | n/a (participant check) |
| `get_notifications`, `notifications_read` | ignored silently | ✅ | | |
| `get_notification_prefs`, `set_notification_prefs` | ignored silently | ✅ (needs non-null `userId`) | | |
| `push_subscribe`, `push_unsubscribe`, `avatar_changed`, `command` | ignored silently | ✅ | | |
| `music_queue_add`, `music_skip` | ignored silently | ✅ (needs truthy `userId` — `0` is ignored) | | |

"Ignored silently" = no response frame at all. The unauthenticated column for the top three read-only groups was **(verified live)**.

---

### Client → Server Messages

Field defaults are noted where the server applies them. Every message below can also produce the generic errors in [Error Responses](#error-responses).

#### Chat

##### `text` — send a chat message
```json
{ "type": "text", "channelId": 2, "text": "hello @bob **world**", "replyToMessageId": "501" }
```
| Field | Type | Notes |
|---|---|---|
| `channelId` | int | Default `0`. Must be accessible. |
| `text` | string | No length limit enforced. Raw text — **not escaped** server-side. |
| `replyToMessageId` | string/int | Optional; accepted only if it matches `^[0-9]+$`, otherwise treated as `null`. |

**Effects:** (1) relayed into Mumble as `<b>{username}:</b> {text}`; (2) stored in Lexicon (`POST /api/messages`); (3) broadcast as a `text` event **to the channel including the sender** (this is how the sender learns the Lexicon message `id`); (4) `@mention` processing; (5) Lexicon in-app notification; (6) relayed to Discord if that channel is linked.  
**Errors:** `Not authenticated`; `You do not have access to this channel`.

##### `image` — post an already-uploaded image
Upload first via `POST /api/chat/upload`, then:
```json
{
  "type": "image", "channelId": 2,
  "fileId": 12345, "fileUrl": "/api/chat/files/12345", "thumbnailUrl": "/api/chat/files/12345/thumb",
  "originalFilename": "screenshot.png", "mimeType": "image/png", "width": 1920, "height": 1080,
  "caption": "look", "isGif": false
}
```
Stored in Lexicon as `IMAGE` (or `GIF` if `isGif`) with `mediaFileId = fileId`; broadcast as an `image` event to the channel (sender included); Mumble receives a text fallback (`<b>user:</b> caption [image: name]`). `fileUrl`/`thumbnailUrl`/dimensions are **echoed from the client as-is**.

##### `get_history` — page through history
```json
{ "type": "get_history", "channelId": 2, "limit": 50, "before": "2026-09-20T12:00:00", "_isRefresh": false }
```
`limit` default 50 (Lexicon clamps to 1–200); `before` is an ISO-8601 cursor (returns older messages). **Reply:**
```json
{ "type": "history", "channelId": 2, "messages": [ /* Lexicon TextMessage rows, newest first, each with isPinned overlaid */ ], "_isRefresh": false }
```

##### `jump_to_message` — locate a message by id
```json
{ "type": "jump_to_message", "channelId": 2, "messageId": "501" }
```
Pages backward through history (50 per page, at most 10 pages ≈ 500 messages / 10 Lexicon calls) until the target is found. **Reply:**
```json
{ "type": "jump_to_message_result", "channelId": 2, "messageId": "501", "found": true, "messages": [ … ] }
```
or `"found": false` with `"reason": "no_access" | "not_found"`. Missing `messageId` → `error: messageId is required`.

##### `search_messages`
```json
{ "type": "search_messages", "query": "pizza", "channelId": 2 }
```
Omit `channelId` to search all channels. Empty/whitespace query → empty results. Lexicon results are capped at 200, filtered to channels the caller may access, then truncated to **50**. **Reply:** `{ "type": "search_results", "query": "pizza", "results": [ … ] }`.

##### `join_channel`
```json
{ "type": "join_channel", "channelId": 2 }
```
**Reply:** `{ "type": "joined_channel", "channelId": 2 }`. Sets the socket's routing scope. Error if no access.

##### `format_preview`
```json
{ "type": "format_preview", "text": "**hi** `c`" }
```
**Reply:** `{ "type": "format_preview_result", "html": "<strong>hi</strong> <code>c</code>" }` **(verified live)**. No auth required.

Supported markup: `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||`, `` `inline code` ``, ```` ```lang code blocks``` ````, `> quote` (line start), `@mention` (highlighted). Code is HTML-escaped; **other HTML is passed through unescaped** (see Known Issues).

#### Channels (admin)

##### `create_channel`
```json
{ "type": "create_channel", "name": "Game Night", "parentId": 0 }
```
`name` trimmed, 1–50 chars. **Reply:** `{ "type": "channel_created", "channel": { "id": 31, "name": "Game Night", "parentId": 0 } }`, plus a `channel_update` broadcast. **Implementation note:** the channel is `INSERT`ed directly into Mumble's MySQL table `channels` (id = `MAX(channel_id)+1`), *not* created through the Mumble protocol. Web clients see it immediately; native Mumble clients presumably only after `mumble-server` reloads its database (inferred — not tested).

##### `remove_channel`
```json
{ "type": "remove_channel", "channelId": 31 }
```
Refuses `0` (`Cannot remove the root channel`). Deletes the channel row **and its direct children only** from `mumble_server.channels`, clears its access rules and pins, then broadcasts `channel_remove`. There is no success reply frame other than that broadcast.

##### `get_known_users`
`{ "type": "get_known_users" }` → `{ "type": "known_users", "users": [ { "userId": 7, "username": "alex", "displayName": "Alex" } ] }` (from `user_mapping`, sorted by display name).

##### `get_channel_access`
`{ "type": "get_channel_access", "channelId": 5 }` → `{ "type": "channel_access_state", "channelId": 5, "restricted": true, "userIds": [7, 9] }`.

##### `set_channel_access`
```json
{ "type": "set_channel_access", "channelId": 5, "restricted": true, "userIds": [7, 9] }
```
Replaces the channel's restriction flag and grant list atomically (serialized through a queue). Channel `0` cannot be restricted. **Reply:** `{ "type": "channel_access_result", "channelId": 5, "success": true, "error": null }`. Every connected client is also sent a targeted `channel_update` (now visible) or `channel_remove` (just lost access) so changes apply without reconnecting.

##### `set_channel_discord_link`
```json
{ "type": "set_channel_discord_link", "channelId": 5, "discordChannelId": "123456789012345678" }
```
Empty/omitted `discordChannelId` **removes** the link. `discordChannelId` must match `^\d{5,25}$`. The bridge fetches the Discord channel, creates/reuses a webhook named `MumbleBridge Sync`, and persists the link. **Reply:** `{ "type": "channel_discord_link_result", "channelId": 5, "success": true, "error": null }`. Error strings: `Discord client not connected`, `Invalid Discord channel ID`, `Could not access Discord channel: …`, `Discord channel not found or not text-based`, `Could not create webhook: …`, `That Discord channel is already linked to a different Mumble channel`, `Database error: …`. On change a `channel_update` is broadcast with `discordChannelId` set/removed on the channel object.

#### Reactions

| Message | Fields | Reply / broadcast |
|---|---|---|
| `reaction_add` | `messageId`, `emoji`, `channelId` | Broadcast `reaction_update` to channel |
| `reaction_remove` | `messageId`, `emoji`, `channelId` | Broadcast `reaction_update` to channel |
| `get_reactions` | `messageId` | `reaction_update` to requester only |
| `get_reactions_batch` | `messageIds` (array, first **100** used) | One `reaction_update` per message that *has* reactions; none for those without |

```json
{ "type": "reaction_update", "messageId": "501", "channelId": 2,
  "reactions": [ { "emoji": "👍", "count": 2, "users": ["alice", "bob"] } ] }
```
`emoji` must be a Unicode emoji sequence (≤ 32 chars) or a `:shortcode:` (`[A-Za-z0-9_+-]+`). One reaction per (message, user, emoji). Errors: `messageId and emoji are required`, `Invalid emoji`, `You do not have access to this channel`. Reply frames from `get_*` carry no `channelId`.

#### Pins (admin to change; any authenticated user to read)

```json
{ "type": "pin_message", "channelId": 2, "messageId": "501", "content": "the text", "username": "bob", "messageType": "TEXT", "attachment": null }
```
Pins are **bridge-local snapshots** (Lexicon has no pin API): `content` (max 4000 chars), `username`, `messageType`, `attachment` are supplied by the pinning admin's client and stored as-is. A pin survives deletion of the original message. **Replies:** `{ "type": "pin_result", "channelId": 2, "messageId": "501", "success": true }` (or `success: false, error`), plus broadcast `{ "type": "pin_added", "channelId": 2, "pin": {…} }`.

`{ "type": "unpin_message", "channelId": 2, "messageId": "501" }` → `pin_result` + broadcast `{ "type": "pin_removed", "channelId": 2, "messageId": "501" }`.

`{ "type": "get_pinned_messages", "channelId": 2 }` → `{ "type": "pinned_messages", "channelId": 2, "pins": [ Pin, … ] }` (newest first; empty if no access).

#### Typing
`{ "type": "typing_start", "channelId": 2 }` / `{ "type": "typing_stop", "channelId": 2 }` (`channelId` defaults to the socket's joined channel, else `0`). Broadcast to the channel **excluding the sender**:
```json
{ "type": "typing", "username": "alice", "userId": 42, "channelId": 2, "typing": true }
```
Server throttles repeat `typing_start`s to one broadcast per **3 s** and auto-sends `typing: false` **8 s** after the last one.

#### Direct messages
DMs are stored in Lexicon under a synthetic channel id `-100000 - conversationId` (channel name `dm_{id}`), so they never collide with real Mumble channels.

| Message | Fields | Reply |
|---|---|---|
| `dm_send` | `toUsername`, `content` (trimmed, truncated to **4000**) | `dm_message` to sender (and recipient if online); `dm_unread_update` to online recipient |
| `dm_open` | `username` | `dm_opened` |
| `dm_conversations` | — | `dm_conversations_list` |
| `dm_history` | `conversationId`, `limit=50`, `before?` | `dm_history` (also clears that conversation's unread count) |
| `dm_mark_read` | `conversationId` | `dm_mark_read_ok` |

```json
{ "type": "dm_message", "conversationId": 9, "id": 777, "fromUserId": 42, "fromUsername": "alice",
  "toUsername": "bob", "content": "hi", "timestamp": "2026-09-20T20:00:00.000Z" }

{ "type": "dm_opened", "conversationId": 9, "otherUsername": "bob", "otherUserId": 7 }

{ "type": "dm_conversations_list", "conversations": [
  { "id": 9, "otherUsername": "bob", "otherUserId": 7, "lastMessageAt": "…", "createdAt": "…" } ] }

{ "type": "dm_history", "conversationId": 9, "messages": [
  { "id": 777, "fromUsername": "alice", "fromUserId": 42, "content": "hi", "timestamp": "…", "messageType": "TEXT", "attachment": null } ] }

{ "type": "dm_unread_update", "conversationId": 9, "fromUsername": "alice", "unreadCount": 3 }
{ "type": "dm_mark_read_ok", "conversationId": 9 }
{ "type": "dm_unread_counts", "unreads": [ { "conversationId": 9, "unreadCount": 3 } ] }   // sent once after login
```
The recipient is resolved by username among connected sockets, then `user_profiles`, then `user_mapping`; not found → `error: Could not find user` (`dm_send`) / `User not found` (`dm_open`). `dm_open` to yourself → `Cannot DM yourself`. `dm_history` on a conversation you are not part of → `error: Conversation not found`. An **offline** recipient gets a stored notification row and a Web-Push (`DM from {username}`).

#### Mentions & notifications
`@name` (regex `@(\w{1,32})`) in any `text` (web, Mumble, or Discord origin) creates a notification for that user (self-mentions ignored), pushes a live `notification` frame if they're online, or a Web-Push if not, and posts a directed notification to Lexicon.

| Message | Fields | Reply |
|---|---|---|
| `get_notifications` | `limit` (default 50, max 200) | `notifications` |
| `notifications_read` | `notificationId?` (omit = mark **all** read) | `notifications_updated { success: true }` |
| `get_notification_prefs` | — | `notification_prefs { prefs }` (`prefs: null` on failure) |
| `set_notification_prefs` | `prefs` (object, passed to Lexicon) | `notification_prefs_saved { success }` |

```json
{ "type": "notifications", "unreadCount": 2, "notifications": [
  { "id": 55, "notifType": "mention", "fromUsername": "bob", "channelId": 2, "channelName": "general",
    "messageId": 501, "messagePreview": "hey @alice", "isRead": 0, "createdAt": "2026-09-20T20:00:00.000Z" } ] }

{ "type": "notification", "notification": {
  "id": 55, "notifType": "mention", "fromUsername": "bob", "channelId": 2, "channelName": "general",
  "messagePreview": "hey @alice", "createdAt": "…" } }
```
`notifType` is `mention` or `dm`. Previews are cut to 200 chars (`…` appended).

#### Web Push
```json
{ "type": "push_subscribe", "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } }, "userAgent": "…" }
```
→ `{ "type": "push_subscribe_ok", "success": true }` (proxied to Lexicon `POST /api/push/subscribe`).  
`{ "type": "push_unsubscribe", "endpoint": "https://…" }` → `{ "type": "push_unsubscribe_ok", "success": true }` (**always `true`**, even if Lexicon failed).  
The public key for `PushManager.subscribe` comes from `GET /api/push/vapid-key`.

#### Profile
`{ "type": "avatar_changed", "avatarUrl": "/uploads/avatars/alex_….webp" }` → broadcast `{ "type": "avatar_updated", "username": "alex", "avatarUrl": "…" }` to **all** sockets and updates presence. The URL is **whatever the client sends** (default `/uploads/avatars/default.jpg`); it is not checked against the upload API.

#### Voice control
| Message | Fields | Reply / effects |
|---|---|---|
| `voice_start` | `voiceChannelId?` | Opens a dedicated Mumble connection as `web_{username}`; moves it to `voiceChannelId` if given; replies `{ "type": "voice_ready" }`; broadcasts `voice_state`; posts a Lexicon "voice join" notification. Error: `Voice connection failed: <msg>`. Replaces any existing session for the socket. |
| `voice_join_channel` | `channelId` | Moves the voice session; broadcasts `voice_state`. Error `Not in voice` if no session. No direct reply. |
| `voice_stop` | — | Closes the session; replies `{ "type": "voice_stopped" }`; broadcasts `voice_state` (`inVoice: false`). |

Audio itself flows as binary frames — see [Voice Audio Protocol](#voice-audio-protocol-binary).

#### Bot & music
| Message | Fields | Reply |
|---|---|---|
| `command` | `command` (no prefix), `args` (string array) | none directly — the bot's answer arrives as a `text` event (`source: "bot"`). Ignored if unauthenticated. |
| `media_search` | `query` | `{ "type": "media_results", "results": [ …Lexicon MediaFile ] }` (no auth) |
| `now_playing` | — | `{ "type": "now_playing", "state": { "success": true, "state": { …LiveStreamState } } }` (no auth) **(verified live)** |
| `music_queue` | — | `{ "type": "music_queue", "queue": { "success": true, "count": n, "queue": [ … ] } }` (no auth) **(verified live)** |
| `music_queue_add` | `mediaFileId` | `{ "type": "music_queued", "result": {…} }` |
| `music_skip` | — | `{ "type": "music_skipped", "result": {…} }` |

If Lexicon rejects a queue/skip call the handler throws and the client receives `error: Internal server error`.

---

### Server → Client Events

Unsolicited (or broadcast) frames. Solicited replies are shown with their requests above.

| `type` | Payload | Sent to | Trigger |
|---|---|---|---|
| `server_state` | `{ channels[], users[] }` | that socket | On connect; again (restricted channels only, `users: []`) after login |
| `user_update` | `{ user: MumbleUser }` | all | A Mumble user connects/moves/mutes |
| `user_remove` | `{ session, name }` | all | A Mumble user disconnects |
| `channel_update` | `{ channel: Channel }` | all who may see it | Mumble channel changed, created, restricted, or Discord-linked |
| `channel_remove` | `{ channelId }` | all who may see it | Channel deleted or access revoked |
| `web_user_join` | `{ webClient: { id, username, channelId, inVoice, avatarUrl } }` | all | A web user authenticates |
| `web_user_leave` | `{ id, username }` | all | A web user's socket closes (only if the presence entry still belongs to that socket) |
| `web_users` | `{ webClients: [ { id, username, channelId, inVoice, voiceChannelId, avatarUrl } ] }` | the new user | After login |
| `voice_state` | `{ id, username, inVoice, voiceChannelId }` | all | `voice_start` / `voice_join_channel` / `voice_stop` |
| `avatar_updated` | `{ username, avatarUrl }` | all | `avatar_changed` |
| `text` | see [Data Models](#data-models) | channel | Web, Mumble, Discord, or bot message |
| `image` | `{ channelId, userId, username, fileId, fileUrl, thumbnailUrl, originalFilename, mimeType, width, height, caption, timestamp, id }` | channel | `image` message |
| `typing` | `{ username, userId, channelId, typing }` | channel, excl. sender | `typing_*` |
| `reaction_update` | `{ messageId, channelId?, reactions[] }` | channel / requester | Reactions |
| `pin_added` / `pin_removed` | `{ channelId, pin }` / `{ channelId, messageId }` | channel | Pins |
| `notification` | `{ notification }` | mentioned user | `@mention` |
| `dm_message` / `dm_unread_update` / `dm_unread_counts` | see DMs | participants | DMs |
| `error` | `{ message }` | that socket | Any failure |

---

## Voice Audio Protocol (Binary)

Voice uses **no WebRTC/STUN/TURN** — audio rides the same WebSocket as binary frames and the bridge terminates Opus.

**Signalling:** `voice_start` → `voice_ready` (JSON). Only after `voice_ready` are binary frames accepted.

**Browser → server (uplink):**
- Raw **PCM, signed 16-bit little-endian, mono, 48 000 Hz**.
- One frame = **960 samples = 1 920 bytes = 20 ms**. Larger buffers are split into 960-sample chunks; a trailing partial chunk is discarded.
- Server Opus-encodes (VOIP mode, **48 kbps**) and forwards to Mumble over that user's own TLS connection.

**Server → browser (downlink):**
```
[ 4 bytes: sender Mumble session id, UInt32 little-endian ][ 1920 bytes: PCM Int16LE mono 48 kHz ]
```
The prefix identifies who is speaking (match to `user_update.user.session`). Each Mumble talker's Opus stream is decoded separately; mixing is done client-side. Lost packets are concealed with Opus PLC.

**Back-pressure:** if a socket's `bufferedAmount` exceeds **19 200 bytes (≈ 200 ms)**, downlink frames are **dropped** rather than queued.

**Mumble identity:** each voice session appears in Mumble as user **`web_{username}`**. Connections retry (up to 3×, exponential backoff ≤ 5 s) on `ECONNRESET`. `web_*` users and the bridge's own session are excluded from text relay and join-notifications.

---

## Bot Commands & Music Bot

**Prefix:** `!` (env `BOT_COMMAND_PREFIX`). Triggered by (a) a native Mumble text message starting with the prefix, or (b) the WebSocket `command` message. Replies are sent to the Mumble channel **and** broadcast to web clients as a `text` event with `username: "Bot"`, `source: "bot"`, and an `html` field. Every invocation is logged to `mumble_bridge.bot_commands`.

| Command | Description |
|---|---|
| `!help` | List commands |
| `!status` | Mumble users / channels / web clients counts |
| `!users` | Online Mumble users and their channels |
| `!channels` | Channels with user counts |
| `!np` / `!nowplaying` | Currently playing (Lexicon Livestream) |
| `!queue` | First 10 queued items |
| `!play <query>` | Search Lexicon media, queue the first hit, and start/move the music bot to **your voice channel** |
| `!skip` | Vote-skip current track |
| `!volume [0-150]` | Show or set music volume (default 50, clamped 0–150) |
| `!stop` | Stop music and leave voice |
| `!search <query>` | First 5 media matches with IDs |

Unknown → `Unknown command: <b>x</b>. Type <b>!help</b> for a list.` Commands from native Mumble users run with `userId = 0`.

**Music bot:** a single send-only Mumble connection named **`web_MusicBot`**. It never owns the queue — it renders whatever Lexicon's shared Livestream reports (subscribed to Lexicon SSE `GET /api/livestream/updates`, reconnect backoff 1→5 s), decoding the media stream (`/api/media/stream/{id}`) with **ffmpeg** to 48 kHz mono PCM and Opus-encoding at **64 kbps** (AUDIO mode). It leaves ~15 s after its channel has no real listeners and ~3 s after the queue drains. Requires `ffmpeg` on the host `PATH`.

---

## Mumble ↔ Web Relay Behaviour

The bridge keeps one always-on Mumble connection as user **`MumbleBridge`** (no password; auto-reconnects 15 s after a drop; pings every 15 s) and mirrors state to web clients.

- **State sync:** `ChannelState`/`ChannelRemove`/`UserState`/`UserRemove` events become `channel_update`/`channel_remove`/`user_update`/`user_remove`.
- **Mumble → web text:** a native Mumble text message addressed to channel(s) is HTML-stripped and broadcast as `{ "type": "text", "channelId", "username", "text", "source": "mumble", "timestamp" }` — **no `userId`, `id`, or `html`**. Messages from the bridge itself or any `web_*` user are skipped (they're echoes). Each is stored in Lexicon with `userId: 0`. Once per message it also triggers the Lexicon notification, `@mention` processing, and Discord relay.
- **Web → Mumble text:** sent as the `MumbleBridge` user, formatted `<b>{username}:</b> {text}`.
- **Voice-join notifications:** a genuine channel entry by a non-`web_` Mumble user (after initial sync) posts a `voice_join` notification to Lexicon.
- **Discord (linked channels only):** Discord → Mumble/web appears as `<b>[Discord] name:</b> …` with `source: "discord"`; Mumble/web → Discord is posted via webhook with the sender's name and avatar (truncated to 2000 chars, mentions disabled). Loop-safe (bot-authored Discord messages and the bridge's own Mumble echoes are ignored).

---

## Outbound Integrations

What the bridge itself calls (useful when something "on the bridge" is broken but the fault is upstream).

### Lexicon API — `https://api.alex-dyakin.com` (`LEXICON_API_URL`)
Bridge logs in at startup as a service account (5 s timeout; continues without it). Most calls are unauthenticated.

| Call | Used for |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/register` | Service login; auto-registering web users |
| `GET /api/players/username/{u}` | Resolve username → id/displayName |
| `POST /api/auth/sso/validate-token` | `sso_auth` |
| `POST /api/messages`, `GET /api/messages/channel/{id}`, `GET /api/messages/search` | Store / history / search |
| `POST /api/chat/upload`, `GET /api/chat/files/{id}[/thumb]` | Chat images (proxied above) |
| `GET /api/media/search`, `GET /api/media/stream/{id}` | `media_search`, `!play`/`!search`, music bot audio |
| `GET /api/livestream/state`, `GET /api/livestream/queue`, `POST /api/livestream/queue`, `POST /api/livestream/skip`, `GET /api/livestream/updates` (SSE) | Music |
| `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/send` | Web Push |
| `POST /api/notifications`, `GET`/`PUT /api/notifications/prefs?userId=` | Lexicon in-app notifications & preferences |

Methods present in `lexicon-client.js` but with **no caller anywhere** in the bridge: `getPublicPlaylists`, `getPlaylist`, `getPlayers`, `getPublicMedia`, `getRecentMedia`, `getMedia`, `editMessage`, `deleteMessage`, `pushSendBulk`, `checkSession`, `getChatFileUrl`, `getChatFileThumbnailUrl`. (So the bridge exposes **no** message edit/delete.)

### Mumble server — `127.0.0.1:64738` (TLS, `rejectUnauthorized: false` — self-signed)
`MumbleBridge` control connection + one connection per active web voice session + `web_MusicBot`. Text, channel/user state, and Opus audio all use the native Mumble protocol (`proto/Mumble.proto`). `create_channel`/`remove_channel` additionally write to `mumble_server.channels` **directly via SQL**.

### MySQL — `127.0.0.1:3306`
Tables in `mumble_bridge` (auto-created at startup):

| Table | Purpose |
|---|---|
| `user_mapping` | Lexicon user ↔ display name; upserted on every login |
| `user_profiles` | Avatar path per username (also read by Lexicon/Alchemy) |
| `bot_commands` | Bot command audit log |
| `notifications` | Mentions + DM notifications (per recipient) |
| `dm_conversations`, `dm_unread` | Direct-message index and unread counters |
| `message_reactions` | Emoji reactions |
| `pinned_messages` | Pin snapshots |
| `restricted_channels`, `channel_access_grants` | Channel access control |
| `discord_channel_links` | Mumble ↔ Discord links (incl. webhook id/token) |
| `text_messages` | **Created but never read or written** — vestigial (messages live in Lexicon) |

### Discord — Gateway + Webhooks
Bot token from `DISCORD_BOT_TOKEN`; needs the "Message Content Intent". Disabled automatically if no token.

---

## Data Models

### Channel
```typescript
{
  id: number;                 // Mumble channel id; 0 = root
  name: string;
  parentId: number;
  description: string;
  restricted?: true;          // present only on restricted channels
  discordChannelId?: string;  // present only when linked to Discord
}
```

### MumbleUser
```typescript
{ session: number; name: string; channelId: number;
  mute?: boolean; deaf?: boolean; selfMute?: boolean; selfDeaf?: boolean }
```

### WebClient (presence)
```typescript
{ id: string /* "web_{userId}" */; username: string; channelId: number;
  inVoice: boolean; voiceChannelId: number | null; avatarUrl: string }
```

### `text` event
```typescript
{
  type: "text";
  channelId: number;
  username: string;
  text: string;
  timestamp: string;           // ISO 8601
  // web-origin messages only:
  userId?: number | null;
  html?: string;               // server-rendered rich text — see Known Issues
  id?: number | null;          // Lexicon message id (null if Lexicon store failed)
  replyToId?: string | null;
  // non-web messages only:
  source?: "mumble" | "discord" | "bot";
}
```

### Message (history rows)
Lexicon `TextMessage` objects with one bridge addition:
```typescript
{
  id: number; channelId: number; channelName: string; userId: number; username: string;
  content: string;
  messageType: "TEXT" | "IMAGE" | "GIF" | "MIXED" | "MEDIA_SHARE" | "SYSTEM" | "BOT_COMMAND";
  mediaFileId: number | null; replyToId: number | null;
  attachment: { id: number; url: string; thumbnailUrl: string; originalFilename: string;
                mimeType: string; width: number | null; height: number | null; fileSize: number } | null;
  createdAt: string; editedAt: string | null; deletedAt: string | null;
  isPinned: boolean;   // overwritten by the bridge from pinned_messages
}
```

### Pin
```typescript
{ id: number; channelId: number; messageId: string; username: string; content: string;
  messageType: string; attachment: object | null; pinnedBy: string; pinnedAt: string }
```

### Reaction
```typescript
{ emoji: string; count: number; users: string[] }
```

---

## Error Responses

### HTTP
Errors are plain JSON `{ "error": "<message>" }` for API routes and plain text for static/fallbacks. **No error envelope, no error codes.** See each endpoint above and [Fallback Responses](#fallback-responses). Two failure modes send **no response**: oversized uploads (connection destroyed) and malformed percent-encoding on `/api/avatar/`.

### WebSocket
All errors are `{ "type": "error", "message": "<text>" }`:

| Message | Meaning |
|---|---|
| `Invalid JSON` | Frame wasn't valid JSON |
| `Internal server error` | Handler threw (e.g. Lexicon call failed) |
| `Feature error: <msg>` | A feature module threw |
| `Unknown message type: <type>` | No handler for that `type` **(verified live)** |
| `Not authenticated` | Login required |
| `Username is required` / `SSO token is required` | Missing field **(verified live)** |
| `You do not have access to this channel` | Channel restricted |
| `Only superusers can …` | Admin-only |
| `Invalid channel name` / `Invalid channel id` / `Cannot remove the root channel` | Channel admin validation |
| `messageId is required`, `channelId is required`, `messageId and content are required`, `channelId and messageId are required` | Missing fields |
| `messageId and emoji are required`, `Invalid emoji` | Reactions |
| `toUsername and content are required`, `Could not find user`, `User not found`, `Cannot DM yourself`, `Conversation not found`, `Failed to send DM`, `Failed to open DM` | DMs |
| `Not in voice`, `Voice connection failed: <msg>` | Voice |
| `Failed to create channel: <msg>` / `Failed to remove channel: <msg>` | DB write failed |

Some results are reported in a result frame rather than an `error`: `pin_result`, `channel_access_result`, `channel_discord_link_result`, `jump_to_message_result` (each carries `success`/`found` + `error`/`reason`). `auth`-related failure of an SSO token uses `{ "type": "auth_error" }`.

---

## Integration Guidelines

### Browser / Android app
1. Serve or bundle the client from an allowed origin (see [CORS](#cors-configuration)); for a Capacitor app the origin is `capacitor://localhost`.
2. `fetch('https://voice.alex-dyakin.com/api/avatar/alex')` works cross-origin from allowed origins; **no `credentials: 'include'` needed** (no cookies), though it is harmless.
3. Open `new WebSocket('wss://voice.alex-dyakin.com')`, set `binaryType = 'arraybuffer'`, send `auth`/`sso_auth` on `open`.
4. Re-authenticate and re-`join_channel` after every reconnect.

### Coming from Lexicon (SSO)
1. User is logged into Lexicon (`https://alex-dyakin.com`). Frontend calls Lexicon `POST /api/auth/sso/generate-token` (needs the user's Lexicon session) → single-use token, 60 s.
2. Frontend opens the bridge WebSocket and sends `{ "type": "sso_auth", "token": "…" }` immediately.
3. Bridge validates the token with Lexicon and replies `auth_ok` (with `sso: true`) or `auth_error`.

### Reading avatars from another service
Either query `mumble_bridge.user_profiles` directly or `GET /api/avatar/{username}` and prefix the relative URL with `https://voice.alex-dyakin.com`. Details in `mumble-bridge/docs/AVATAR_API_INTEGRATION.md`.

### Web Push
`GET /api/push/vapid-key` → `PushManager.subscribe({ applicationServerKey })` → WebSocket `push_subscribe`. `sw.js` handles `push` and `notificationclick`. Pushes are only sent to users with **no live socket**.

---

## Testing Endpoints

### HTTP (safe, read-only)
```bash
B=https://voice.alex-dyakin.com        # or http://localhost:3080

curl -s -o /dev/null -w '%{http_code}\n' $B/                     # 200
curl -s $B/api/avatar/alex                                       # {"avatarUrl":"/uploads/avatars/..."}
curl -s $B/api/push/vapid-key                                    # {"publicKey":"B..."}
curl -s -o /dev/null -w '%{http_code}\n' $B/api/chat/files/1     # 200 or 404
```

### CORS
```bash
# Allowed origin → echoes ACAO
curl -si -X OPTIONS $B/api/avatar/upload \
  -H 'Origin: https://voice.alex-dyakin.com' -H 'Access-Control-Request-Method: POST' | head -8

# Android shell
curl -si -X OPTIONS $B/api/chat/upload -H 'Origin: capacitor://localhost' | grep -i access-control

# Disallowed → 204 but NO Access-Control-Allow-Origin
curl -si -X OPTIONS $B/api/avatar/upload -H 'Origin: https://evil.example' | grep -ci 'allow-origin'   # 0
```

### WebSocket (Node, using the bridge's own `ws` dependency)
```js
// run from mumble-bridge/
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3080');
ws.on('message', (m) => console.log(m.toString().slice(0, 200)));   // first frame = server_state
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'format_preview', text: '**hi**' }));   // works without auth
  ws.send(JSON.stringify({ type: 'now_playing' }));                      // works without auth
});
```
> Sending `auth` with a name that doesn't exist **auto-creates a Lexicon account and `user_mapping` row**. Use a throwaway name and clean up, or use the test suite.

### Automated tests
```bash
cd /home/alex/Documents/mumble/mumble-bridge
npm test                       # tests/run-all.js
npm run test:http | test:ws | test:voice | test:e2e | test:3way | test:features | test:channel-access
```

---

## Deployment & Operations

| Thing | Value |
|---|---|
| Public site + API + WS | `https://voice.alex-dyakin.com` |
| Local | `http://localhost:3080` |
| Native Mumble | `<public IP or DNS>:64738` (TCP+UDP; port-forward required) |
| Bridge unit | `/etc/systemd/system/mumble-bridge.service` (`After=network mysql mumble-server`) |
| Mumble unit | `mumble-server.service` (`-ini /etc/mumble/mumble-server.ini`, not readable without root) |
| Tunnel unit | `cloudflared.service` (`--config /etc/cloudflared/config.yml`) |

```bash
sudo systemctl restart mumble-bridge                 # most common; also busts client caches
sudo systemctl restart mumble-server mumble-bridge cloudflared
sudo journalctl -u mumble-bridge -f
```
Configuration is env-driven from `mumble-bridge/.env` (git-ignored): `WS_PORT`, `MUMBLE_HOST/PORT`, `MYSQL_*`, `LEXICON_API_URL`, `LOG_LEVEL`, `BOT_COMMAND_PREFIX`, `VOICE_DIAG_ENABLED`, `SUPERUSER_NAMES`, `VAPID_*`, `DISCORD_*`. **Changing it requires a restart.** Startup order: MySQL tables → Lexicon service login (5 s, non-fatal) → Mumble connect (**fatal** — process exits if Mumble is down; systemd restarts it after 5 s) → WebSocket/HTTP → bot → feature modules.

Uncaught exceptions and unhandled rejections are logged (`[FATAL] … server kept running`) and do **not** stop the process.

---

## System Architecture

```
                     Internet / Android app
                              │
                        Cloudflare edge
                              │
     voice.alex-dyakin.com ───┤─── ksp.alex-dyakin.com  (→ :8800, KSP server — not Mumble)
                              │
                    cloudflared (tunnel)
                              │
                     http://localhost:3080
        ┌─────────────────────┴──────────────────────┐
        │              Mumble Bridge (Node)          │
        │  HTTP: static UI · /api/avatar · /api/chat │
        │        /api/push/vapid-key · /api/diag     │
        │  WS:   JSON chat/DM/admin + binary voice   │
        │  Bots: !commands · web_MusicBot (ffmpeg)   │
        │  Features: reactions · pins · typing · DMs │
        │            mentions · channel-access ·     │
        │            Discord sync · notifications    │
        └───┬───────────┬──────────────┬─────────────┘
            │           │              │
     TLS :64738    MySQL :3306    HTTPS (outbound)
            │       (loopback)          │
   ┌────────┴───────┐  ┌───────┴───┐  ┌─┴──────────────────────┐
   │ mumble-server  │  │ mumble_   │  │ Lexicon api.alex-      │
   │ TCP+UDP :64738 │  │ server /  │  │ dyakin.com (other PC)  │
   │ (native clients│  │ mumble_   │  │ msgs · users · media · │
   │  connect here  │  │ bridge DBs│  │ push · notifications   │
   │  directly)     │  └───────────┘  └────────────────────────┘
   └────────────────┘         Discord Gateway + webhooks ↗
```

---

## Security Notes & Known Issues

These are documented so integrators aren't surprised; none were changed as part of writing this doc. Ordered roughly by impact.

1. **WebSocket login has no password, and admin is granted by name.** `auth` accepts any username; `isAdmin` is true if the resulting display name is in `SUPERUSER_NAMES`. Anyone who knows (or guesses) the admin's name can send `{"type":"auth","username":"<that name>"}` and gain `create_channel`, `remove_channel`, access-control, pin, and Discord-link powers. Only `sso_auth` is backed by a real credential, but nothing forces its use. *(From source; deliberately not exercised live because `auth` auto-creates a Lexicon account.)*
2. **Unsanitised `html` on live chat messages.** `formatRichText` HTML-escapes only code spans; all other markup in `text` is passed through into the broadcast `html` field (e.g. `<img src=x onerror=…>` is returned intact **(verified by calling the function)**). The shipped client passes `msg.html` to `renderRichText` and inserts the result via `innerHTML` (`chat.js:1086-1088`) whenever the plain text is non-empty after tag-stripping. That is a stored/reflected XSS path to every socket routed that channel. *(Server output verified; the browser sink identified by reading the client — not exploited.)* History loaded via `get_history` has no `html` field and goes through the client's `stripHtml` fallback. Third-party consumers must not trust `html`. The Mumble relay also sends `text` unescaped inside `<b>{username}:</b> {text}` to native clients.
3. **`/api/diag/*` is unauthenticated and public.** **(verified live via `voice.alex-dyakin.com`)** Exposes voice-session log tails, usernames, and error stats to anyone.
4. **HTTP write endpoints are unauthenticated.** Anyone can overwrite or clear **any** user's avatar (`/api/avatar/upload`, `/api/avatar/remove` trust the `username` field) and upload chat images as any `userId` (`/api/chat/upload`). Avatar content type is trusted from the request header, not sniffed. `avatar_changed` over WS broadcasts an arbitrary `avatarUrl`.
5. **WebSocket has no `Origin` check** **(verified live)**, and unauthenticated sockets receive `server_state`, all server-wide broadcasts, and (per the routing rule) unrestricted-channel chat until they join a channel.
6. **`public/` is served wholesale**, including `react-src/` sources/`package.json` and `uploads/` **(verified live, also public)**. `.env` and source are outside `public/` and return `404`.
7. **Hard-coded credentials.** The Lexicon service-account password is a literal in `src/lexicon-client.js`, and `SERVER_GUIDE.md` records the MySQL password in plain text. (Values intentionally not reproduced here.) Both are committed to git.
8. **`userId` is client-asserted on HTTP** (`/api/chat/upload`) and is passed to Lexicon unverified. Over WS it comes from the (unauthenticated-name) login.
9. **Login when Lexicon is down:** `auth` still succeeds with `userId: null`, so presence id becomes `web_null` (shared by every such user) and userId-dependent features silently do nothing or misattribute.
10. **Malformed percent-encoding on `GET /api/avatar/…` hangs the request** **(verified live)** — `decodeURIComponent` runs outside the `try`. Harmless to the process (global handler) but ties up the connection and logs `[FATAL] Unhandled rejection`.
11. **Silent connection drop on oversized uploads** instead of a `413`/`400`.
12. **No rate limiting, message length limit (`text`), or per-connection quotas** on any route or WS message; no WS keep-alive.
13. **Channel access control is bridge-only** (native Mumble clients bypass it) and **`get_reactions`/`get_reactions_batch` skip the channel-access check**.
14. **Admin channel create/remove bypass the Mumble protocol** (raw SQL on `mumble_server.channels`), can race on `MAX(channel_id)+1`, and delete only direct children.
15. **Immutable 1-year caching** of `/api/chat/files/*` (see above) — deleted files can linger in caches.
16. **The tunnel also publishes `ksp.alex-dyakin.com`** (KSP server on :8800), and port 3080 is bound on all interfaces so the LAN can reach the bridge directly, bypassing Cloudflare.

---

**Last Updated:** September 20, 2026  
**Service Version:** `mumble-bridge` 1.0.0 (package.json) · Mumble server 1.5.517  
**Source of truth:** `mumble-bridge/src/http-server.js`, `ws-server.js`, `client-handler.js`, `features/*/index.js`, `bot-engine.js`, `voice-bridge.js`
