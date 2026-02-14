# Mumble Enhanced - Features to Add

## System Architecture Overview

### Existing Infrastructure
```
┌─────────────────────────────────────────────────────────────┐
│                    alex-dyakin.com                           │
│                  (Cloudflare Tunnel)                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Frontend (React)          :3001                            │
│  Lexicon API (Spring)      :36568  ← HSQLDB (:9002)        │
│  Alchemy API (Spring)      :8080                            │
│  Mumble Server (C++)       :64738  ← SQLite (local file)   │
│                                                             │
│  Cloudflare HTTPS:                                          │
│    https://alex-dyakin.com        → :3001                   │
│    https://api.alex-dyakin.com    → :36568                  │
│    https://alchemy.alex-dyakin.com→ :8080                   │
│                                                             │
│  PlayIt Fallback:                                           │
│    147.185.221.24:15856           → :36568                  │
│    147.185.221.24:15821           → :8080                   │
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    alex-dyakin.com                           │
│                  (Cloudflare Tunnel)                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Frontend (React)          :3001                            │
│  Lexicon API (Spring)      :36568  ← HSQLDB (:9002)        │
│  Alchemy API (Spring)      :8080                            │
│  Mumble Server (C++)       :64738  ← MySQL/shared DB       │
│  ┌───────────────────────────────────────────┐              │
│  │  NEW: Mumble Bridge Service (Node/Java)   │              │
│  │  ├── WebSocket Server     :XXXXX          │              │
│  │  ├── Auth Bridge (Lexicon ↔ Mumble)       │              │
│  │  ├── Text Channel Storage (→ Lexicon API) │              │
│  │  ├── Media Bridge (→ Lexicon Media API)   │              │
│  │  └── Bot Engine                           │              │
│  └───────────────────────────────────────────┘              │
│                                                             │
│  Cloudflare HTTPS (new routes):                             │
│    https://voice.alex-dyakin.com  → Mumble Bridge WS        │
│    https://mumble.alex-dyakin.com → Mumble Web Dashboard     │
└─────────────────────────────────────────────────────────────┘
```

---

## KEY DISCOVERY: Database Compatibility

### What Mumble Supports (src/murmur/Meta.cpp)
Mumble's server **natively supports 3 backends**:
- **SQLite** (default, currently running)
- **MySQL** via `dbDriver=QMYSQL` 
- **PostgreSQL** via `dbDriver=QPSQL`

### What Lexicon Uses
- **HSQLDB** on port 9002 (Java in-memory/file DB)

### Integration Strategy
**HSQLDB and MySQL/SQLite are incompatible** — they can't share a database directly.
Instead of forcing them together, we use a **service-level bridge**:

1. **Mumble keeps its own DB** (switch from SQLite → MySQL for better concurrency)
2. **Bridge service** talks to BOTH systems via their APIs
3. **Lexicon API** is the single source of truth for users, media, playlists
4. **Mumble DB** handles voice-specific data (channels, ACLs, voice state)

This is the correct microservice pattern — each service owns its data, communication happens via APIs.

---

## Phase 0: Database & Infrastructure Prep

### Step 0.1: Install MySQL (shared DB server)
```bash
sudo apt install mysql-server
sudo mysql_secure_installation
```
Create databases:
```sql
CREATE DATABASE mumble_server;
CREATE DATABASE mumble_bridge;
CREATE USER 'mumble'@'localhost' IDENTIFIED BY '<password>';
GRANT ALL PRIVILEGES ON mumble_server.* TO 'mumble'@'localhost';
GRANT ALL PRIVILEGES ON mumble_bridge.* TO 'mumble'@'localhost';
FLUSH PRIVILEGES;
```

### Step 0.2: Switch Mumble from SQLite → MySQL
Edit `/etc/mumble/mumble-server.ini`:
```ini
database=mumble_server
dbDriver=QMYSQL
dbHost=127.0.0.1
dbPort=3306
dbUsername=mumble
dbPassword=<password>
```
Restart: `sudo systemctl restart mumble-server`

**Why MySQL?** 
- Allows the bridge service to query Mumble's user/channel data directly
- Better concurrency than SQLite (multiple services accessing data)
- Your bridge service can read from `mumble_server` DB alongside its own `mumble_bridge` DB

### Step 0.3: Add Cloudflare Tunnel Routes
```bash
# In cloudflared config, add:
#   voice.alex-dyakin.com → localhost:<bridge_ws_port>
#   mumble.alex-dyakin.com → localhost:<bridge_http_port>
```

### Step 0.4: Register Origins in Lexicon CORS
Add to `LexiconSecurityConfig.java`:
```java
allowedOriginPatterns.add("https://voice\\.alex-dyakin\\.com");
allowedOriginPatterns.add("https://mumble\\.alex-dyakin\\.com");
```
Rebuild: `cd lexiconServer && ./gradlew clean build -x test`

---

## Phase 1: Auth Bridge (Lexicon ↔ Mumble)

### Goal
Users log in ONCE on alex-dyakin.com and are authenticated for both Lexicon AND Mumble.

### How It Works
```
User → alex-dyakin.com/login
  → POST /api/auth/login (Lexicon API)
  → Bridge receives JSESSIONID
  → Bridge creates/validates Mumble user via Mumble's Ice/gRPC API
  → User gets voice access token
```

### Implementation
- **Bridge calls Lexicon**: `POST https://api.alex-dyakin.com/api/auth/login`
- **Bridge calls Mumble**: Via Ice interface (`src/murmur/MumbleServerIce.cpp`)
  - `registerUser()`, `verifyPassword()`, `getRegisteredUsers()`
- **User mapping table** (in `mumble_bridge` DB):
  ```sql
  CREATE TABLE user_mapping (
    lexicon_user_id INT NOT NULL,
    mumble_user_id INT NOT NULL,
    mumble_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lexicon_user_id),
    UNIQUE (mumble_user_id)
  );
  ```

### Relevant Mumble Source Files
- [src/murmur/MumbleServerIce.cpp](src/murmur/MumbleServerIce.cpp) — External API
- [src/murmur/RPC.cpp](src/murmur/RPC.cpp) — RPC handlers
- [src/murmur/Server.h](src/murmur/Server.h) — Server class with user management
- [src/murmur/database/UserTable.cpp](src/murmur/database/UserTable.cpp) — User DB operations

---

## Phase 2: WebSocket Server Integration

### Goal
Web browsers connect to `wss://voice.alex-dyakin.com` and get voice + text.

### Architecture
```
Browser (WebSocket client)
  ↓ wss://voice.alex-dyakin.com
Cloudflare Tunnel
  ↓
Mumble Bridge Service (WebSocket Server)
  ↓ TCP connection (Mumble protocol)
Mumble Server (:64738)
```

### Implementation Options

#### Option A: Standalone Bridge (Recommended)
A separate Node.js or Java service that:
1. Accepts WebSocket connections
2. Authenticates via Lexicon API session
3. Opens a TCP connection to Mumble server as a proxy
4. Translates Mumble protobuf messages ↔ JSON over WebSocket
5. Handles WebRTC for audio (browser can't do raw UDP)

**Tech stack**: Node.js + `ws` library + `protobufjs`

#### Option B: Embed WebSocket in Mumble (Advanced)
Modify `src/murmur/Server.cpp` to add a WebSocket listener alongside TCP/UDP.
- More performant but much harder
- Requires deep C++ changes to Mumble's networking layer
- Files to modify:
  - [src/murmur/Server.h](src/murmur/Server.h) — Add WebSocket server member
  - [src/murmur/Server.cpp](src/murmur/Server.cpp) — WebSocket accept/handler
  - [src/murmur/Messages.cpp](src/murmur/Messages.cpp) — Message routing
  - [src/murmur/CMakeLists.txt](src/murmur/CMakeLists.txt) — Add libwebsocket dependency

### Protocol Translation
```
Mumble Protocol (protobuf)         WebSocket (JSON)
─────────────────────────         ─────────────────
MumbleProto::TextMessage    ↔     { type: "text", channel: 1, text: "hello" }
MumbleProto::UserState      ↔     { type: "user_state", user_id: 5, ... }
MumbleProto::ChannelState   ↔     { type: "channel", id: 1, name: "General" }
MumbleProto::Authenticate   ↔     { type: "auth", token: "..." }
Audio (UDP/TCP)             ↔     WebRTC MediaStream
```

### Reference: Mumble Protocol Definition
- [src/Mumble.proto](src/Mumble.proto) — All message types
- [src/MumbleUDP.proto](src/MumbleUDP.proto) — UDP audio protocol
- [src/MumbleProtocol.h](src/MumbleProtocol.h) — Protocol handler

---

## Phase 3: Text Channels & Message Storage

### Goal
Persistent text channels with message history, stored via Lexicon API.

### Why Lexicon API (not Mumble DB)?
- Lexicon already has media management, user management, search
- Text messages can reference media files (attachments)
- Accessible from web frontend without Mumble connection
- Lexicon's HSQLDB already handles this pattern

### New Lexicon API Endpoints Needed
Add to Lexicon server:
```
POST   /api/messages                    — Send message
GET    /api/messages/channel/{id}       — Get channel history
PUT    /api/messages/{id}               — Edit message
DELETE /api/messages/{id}               — Delete message
GET    /api/messages/search?q=term      — Search messages
POST   /api/messages/{id}/pin           — Pin message
GET    /api/messages/channel/{id}/pins  — Get pinned messages
```

### Message Data Model (Lexicon HSQLDB)
```sql
CREATE TABLE text_messages (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  channel_id INT NOT NULL,              -- Mumble channel ID
  user_id INT NOT NULL,                 -- Lexicon user ID  
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'TEXT', -- TEXT, MEDIA, SYSTEM
  media_file_id BIGINT NULL,            -- FK to existing media_files table
  reply_to_id BIGINT NULL,              -- FK to self (reply threads)
  is_pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  edited_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL              -- soft delete
);

CREATE INDEX idx_messages_channel ON text_messages(channel_id, created_at);
CREATE INDEX idx_messages_user ON text_messages(user_id);
```

### Flow
```
User types message in web client
  → WebSocket → Bridge Service
  → Bridge stores via POST /api/messages (Lexicon API)
  → Bridge broadcasts to all WebSocket clients in channel
  → Bridge also sends to Mumble server (native text message)
  → Desktop Mumble clients see it too
```

---

## Phase 4: Media Integration (Using Existing Lexicon API)

### Already Available — No New Code Needed!
Your Lexicon API already provides everything:

| Feature | Lexicon Endpoint | Status |
|---------|-----------------|--------|
| Upload media | `POST /api/media/upload` | ✅ Ready |
| Upload from URL | `POST /api/media/upload-from-url` | ✅ Ready |
| Stream media | `GET /api/media/stream/{id}` | ✅ Ready |
| Large file upload | `POST /api/media/chunked/*` | ✅ Ready |
| Download from YouTube | `POST /api/download-queue/start` | ✅ Ready |
| Playlists | `POST /api/playlists` | ✅ Ready |
| Search | `GET /api/media/search?q=` | ✅ Ready |
| Public media | `GET /api/media/public` | ✅ Ready |

### Bridge Just Needs To
1. Expose media commands in chat: `!upload`, `!share`, `!search`
2. Call Lexicon API with user's JSESSIONID
3. Return media URLs to chat

### Sharing Media in Chat
```
User: !share 123
Bridge: GET https://api.alex-dyakin.com/api/media/123
Bridge: → Chat: "🎵 Song Title - https://alex-dyakin.com/stream/123"
```

---

## Phase 5: Music Bot (Using Existing Livestream API)

### Already Available!
Lexicon's Livestream API is a **synchronized music player** — exactly what a music bot needs:

| Feature | Lexicon Endpoint | Status |
|---------|-----------------|--------|
| Get current playing | `GET /api/livestream/state` | ✅ Ready |
| Queue song | `POST /api/livestream/queue` | ✅ Ready |
| Skip song | `POST /api/livestream/skip` | ✅ Ready |
| View queue | `GET /api/livestream/queue` | ✅ Ready |
| Real-time updates | `GET /api/livestream/updates` (SSE) | ✅ Ready |
| Eligible media | `GET /api/livestream/eligible-media` | ✅ Ready |
| Import YouTube playlist | `POST /api/playlists/import-youtube` | ✅ Ready |

### Bot Commands (bridge handles these)
```
!play <search term>     → Search media → Queue to livestream
!skip                   → POST /api/livestream/skip
!queue                  → GET /api/livestream/queue  
!np (now playing)       → GET /api/livestream/state
!playlist <name>        → GET /api/playlists/search
!import <youtube url>   → POST /api/playlists/import-youtube
```

### Audio Streaming to Mumble
```
Livestream API → Stream URL → Bridge fetches audio
  → Bridge encodes to Opus (Mumble codec)
  → Bridge sends as Mumble audio packet to server
  → All connected users hear the music
```

---

## Phase 6: Status & Admin Bots

### Server Status Bot
Queries both Mumble (via Ice) and Lexicon APIs:
```
!status         → Mumble users online, channels, uptime
!media-stats    → GET /api/media/recent + counts
!stream-status  → GET /api/livestream/state
!users          → GET /api/players (Lexicon) + Mumble online list
```

### Admin Bot
```
!kick <user>    → Mumble Ice: kickUser()
!ban <user>     → Mumble Ice: setBan()
!mute <user>    → Mumble Ice: setState() 
!move <user> <channel> → Mumble Ice: setState()
```

---

## Implementation Phases (Revised)

### Phase 0: Infrastructure (Week 1)
- [ ] Install MySQL server
- [ ] Switch Mumble from SQLite → MySQL
- [ ] Add Cloudflare tunnel routes (voice.alex-dyakin.com)
- [ ] Add CORS origins to Lexicon
- [ ] Verify Mumble server works with MySQL

### Phase 1: Auth Bridge (Week 2)
- [ ] Create bridge service project (Node.js or Java Spring Boot)
- [ ] Implement Lexicon auth integration
- [ ] Implement Mumble Ice/gRPC connection
- [ ] User mapping table (Lexicon ID ↔ Mumble ID)
- [ ] Login flow: web → Lexicon → Mumble token

### Phase 2: WebSocket Server (Weeks 3-4)
- [ ] WebSocket server in bridge service
- [ ] Mumble protocol parser (protobuf)
- [ ] Protocol translation (protobuf ↔ JSON)
- [ ] Channel list, user list via WebSocket
- [ ] Text message relay (WebSocket ↔ Mumble)
- [ ] WebRTC audio bridge (complex — may defer)

### Phase 3: Text Channels (Week 5)
- [ ] Add message endpoints to Lexicon API
- [ ] Message storage (HSQLDB)
- [ ] Bridge relays text between WebSocket and Mumble
- [ ] Message history retrieval
- [ ] Media attachments in messages

### Phase 4: Bots (Week 6)
- [ ] Bot command parser in bridge
- [ ] Music bot (calls Livestream API)
- [ ] Status bot (queries Mumble Ice + Lexicon)
- [ ] Admin bot (Mumble Ice control)

### Phase 5: Web Dashboard (Week 7-8)
- [ ] React components for voice (on alex-dyakin.com)
- [ ] Channel browser
- [ ] Text chat interface
- [ ] Music player with queue
- [ ] User presence indicators

---

## Technology Stack

| Component | Tech | Reason |
|-----------|------|--------|
| Bridge Service | Node.js or Java Spring Boot | Matches existing stack |
| WebSocket | `ws` (Node) or Spring WebSocket | Native support |
| Mumble Protocol | `protobufjs` or Java protobuf | Parse Mumble messages |
| Mumble Control | Ice or gRPC | Mumble's external API |
| Auth | Lexicon JSESSIONID passthrough | Unified login |
| Media | Lexicon API (existing) | Already built |
| Music | Lexicon Livestream API (existing) | Already built |
| Text Storage | Lexicon HSQLDB (new tables) | Centralized |
| Voice DB | MySQL (Mumble native) | Better than SQLite for multi-access |
| Audio Codec | Opus | Mumble standard |
| Frontend | React (existing) | On alex-dyakin.com |

---

## File Structure: Bridge Service (New Project)

```
mumble-bridge/
├── package.json (or build.gradle)
├── src/
│   ├── index.js                    — Entry point
│   ├── config.js                   — Configuration
│   ├── auth/
│   │   ├── LexiconAuth.js          — Lexicon API auth client
│   │   └── MumbleAuth.js           — Mumble user mapping
│   ├── websocket/
│   │   ├── WebSocketServer.js      — WS server
│   │   ├── ClientConnection.js     — Per-client handler
│   │   └── ProtocolTranslator.js   — Protobuf ↔ JSON
│   ├── mumble/
│   │   ├── MumbleConnection.js     — TCP connection to Mumble
│   │   ├── MumbleProtocol.js       — Protobuf parser
│   │   └── IceClient.js            — Mumble Ice API client
│   ├── bots/
│   │   ├── BotEngine.js            — Command parser
│   │   ├── MusicBot.js             — Livestream API integration
│   │   ├── StatusBot.js            — Server status
│   │   └── AdminBot.js             — Moderation
│   ├── media/
│   │   └── LexiconMedia.js         — Lexicon media API client
│   └── database/
│       ├── migrations/
│       └── models/
│           ├── UserMapping.js
│           └── TextMessage.js
└── proto/
    ├── Mumble.proto                — Copied from Mumble source
    └── MumbleUDP.proto             — Copied from Mumble source
```

---

## Mumble Source Files to Modify (if doing Option B embedded WebSocket)

```
src/murmur/
├── Server.cpp/h          — Add WebSocket listener
├── Messages.cpp          — Route messages to WebSocket clients
├── ServerUser.cpp/h      — Add WebSocket user type
├── Meta.cpp/h            — Add WebSocket config options
├── CMakeLists.txt        — Add libwebsocket dependency
└── main.cpp              — Initialize WebSocket on startup
```

---

## API Endpoints: Lexicon Integration Reference

### Auth (existing)
- `POST /api/auth/login` → Authenticate user
- `GET /api/auth/me` → Check session
- `POST /api/auth/register` → Create account

### Media (existing)
- `POST /api/media/upload` → Upload file
- `GET /api/media/stream/{id}` → Stream media
- `GET /api/media/search?q=` → Search
- `GET /api/media/public` → Public media

### Livestream/Music (existing)
- `GET /api/livestream/state` → Now playing
- `POST /api/livestream/queue` → Queue song
- `POST /api/livestream/skip` → Skip
- `GET /api/livestream/updates` → SSE real-time

### Playlists (existing)
- `GET /api/playlists/public` → List playlists
- `POST /api/playlists/import-youtube` → Import from YouTube

### Messages (NEW — add to Lexicon)
- `POST /api/messages` → Send message
- `GET /api/messages/channel/{id}` → Channel history
- `PUT /api/messages/{id}` → Edit
- `DELETE /api/messages/{id}` → Delete

---

## Notes
- **Don't merge databases** — use API-level integration (microservice pattern)
- **Lexicon API is the hub** — auth, media, playlists, text all go through it
- **Mumble stays focused** — voice, channels, ACLs, permissions
- **Bridge service is the glue** — translates between web clients and both backends
- Start with Phase 0 (MySQL switch) — it's quick and unblocks everything
- WebSocket bridge is the hardest part — consider mumble-web as reference
- Audio in browser requires WebRTC — significant complexity
