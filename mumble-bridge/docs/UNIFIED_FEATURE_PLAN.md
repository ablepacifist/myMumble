# Unified Feature Plan — Building the MumbleChat Platform

> Consolidated roadmap for developing MumbleChat from current state to a Discord-like communication platform. Combines infrastructure requirements, backend services, and frontend features into a phased implementation strategy.

---

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Current State](#current-state)
3. [Infrastructure Prerequisites](#infrastructure-prerequisites)
4. [Feature Phases](#feature-phases)
5. [Implementation Timeline](#implementation-timeline)
6. [Technology Stack](#technology-stack)

---

## System Architecture

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
│    https://api.alex-dyakin.com    → :36568                 │
│    https://alchemy.alex-dyakin.com→ :8080                   │
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    alex-dyakin.com                           │
│                   (Cloudflare Tunnel)                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Frontend (React + Electron)       :3001 / Electron app     │
│  Lexicon API (Spring)      :36568  ← HSQLDB (:9002)        │
│  Alchemy API (Spring)      :8080                            │
│  Mumble Server (C++)       :64738  ← MySQL (shared)         │
│                                                             │
│  ┌───────────────────────────────────────────────────┐     │
│  │   Mumble Bridge Service (Node.js)    :3080        │     │
│  │   ├── WebSocket Server (voice + text)             │     │
│  │   ├── Auth Bridge (Lexicon ↔ Mumble)              │     │
│  │   ├── Text Channel Storage → Lexicon              │     │
│  │   ├── Media Bridge → Lexicon Media API            │     │
│  │   ├── Bot Engine (music, admin, status)           │     │
│  │   └── Audio Streaming (music → Mumble voice)      │     │
│  └───────────────────────────────────────────────────┘     │
│                                                             │
│  Cloudflare HTTPS Routes:                                   │
│    https://voice.alex-dyakin.com   → Bridge WS (:3080)     │
│    https://mumble.alex-dyakin.com  → Web Dashboard         │
│    https://api.alex-dyakin.com     → Lexicon API           │
└─────────────────────────────────────────────────────────────┘
```

### Key Principle: Microservice Integration
**DO NOT merge databases.** Each service owns its data:
- **Mumble Server** — handles voice, channels, ACLs, permissions
- **Lexicon API** — handles users, auth, media, playlists
- **Bridge Service** — translates between them via APIs, stores text + mappings

---

## Current State

### What's Already Working

| Feature | Bridge/Web | Client/Electron | Backend |
|---------|:---:|:---:|:---:|
| Voice chat (Opus/Mumble) | ✅ | ✅ | Mumble Server |
| Text chat (real-time) | ✅ | ✅ | MySQL + Mumble |
| Message history | ✅ | ✅ | MySQL `text_messages` |
| Channel tree (voice + text) | ✅ | ✅ | Mumble |
| Channel create/delete | ✅ | ✅ | Mumble |
| User avatars | ✅ | ✅ | MySQL + bridge HTTP |
| User profiles (display name) | ✅ | ✅ | MySQL `user_profiles` |
| Settings UI (audio, appearance) | ✅ | ✅ | — |
| Mute/Deafen | ✅ | ✅ | Mumble |
| Bot commands (!help, !status, etc.) | ✅ | ✅ | Bridge bot engine |
| Music bot (!play, !skip, !queue, !np) | ✅ | ✅ | Lexicon Livestream API |
| Media search (!search) | ✅ | ✅ | Lexicon Media API |
| Member list | ✅ | ✅ | Mumble |
| Connection status indicator | ✅ | ✅ | — |
| Cross-platform builds | Web | Win + Linux AppImage | — |

### What's Missing (vs Discord)

| Feature | Priority | Complexity | Approx. Effort |
|---------|:---:|:---:|:---:|
| **File/image sharing in chat** | High | Easy | 2 days |
| **Message reactions (emoji)** | Medium | Easy | 1 day |
| **Reply threads** | Medium | Easy | 1 day |
| **Message search** | Medium | Easy | 0.5 days |
| **Pinned messages** | Low | Easy | 0.5 days |
| **User online/away/DND status** | Medium | Easy | 1 day |
| **Direct messages (DMs)** | High | Medium | 3 days |
| **Friend list** | Medium | Medium | 2 days |
| **Typing indicators** | Low | Easy | 0.5 days |
| **Desktop notifications** | High | Easy | 0.5 days |
| **Rich embeds (link previews)** | Medium | Medium | 2 days |
| **Role/permission system** | Medium | Medium | 3 days |
| **Voice activity indicator** | Medium | Easy | 0.5 days |
| **Push-to-talk (web)** | Medium | Easy | 1 day |
| **Server invite links** | Medium | Easy | 1 day |
| **Unread indicators** | High | Easy | 1 day |
| **Music playback in voice** | High | Medium | 3-4 days |
| **Screen sharing** | High | Hard | 5-7 days |
| **Video calls** | High | Hard | 7-10 days |
| **Watch together / synced video** | Medium | Medium | 2 days |
| **Alchemy game integration** | Medium | Easy | 2 days |
| **Media library browser** | High | Easy | 3 days |
| **Soundboard** | Low | Medium | 2 days |
| **Custom emoji** | Low | Medium | — |
| **Text-to-speech** | Low | Easy | 1 day |

---

## Infrastructure Prerequisites

### Phase 0: Database & Infrastructure Setup
**Timeline: 1 week | Impact: Unblocks all other features**

This foundation work must be done before any feature development.

#### 0.1: Install MySQL (Shared Database)
**Why:** Mumble will switch from SQLite to MySQL for better concurrency and API-level querying.

```bash
sudo apt install mysql-server
sudo mysql_secure_installation
```

Create databases and user:
```sql
CREATE DATABASE mumble_server;
CREATE DATABASE mumble_bridge;
CREATE USER 'mumble'@'localhost' IDENTIFIED BY 'secure_password';
GRANT ALL PRIVILEGES ON mumble_server.* TO 'mumble'@'localhost';
GRANT ALL PRIVILEGES ON mumble_bridge.* TO 'mumble'@'localhost';
FLUSH PRIVILEGES;
```

#### 0.2: Switch Mumble from SQLite → MySQL
Edit `/etc/mumble/mumble-server.ini`:
```ini
[database]
database=mumble_server
dbDriver=QMYSQL
dbHost=127.0.0.1
dbPort=3306
dbUsername=mumble
dbPassword=secure_password
```

Restart: `sudo systemctl restart mumble-server`

**Why MySQL?** The Bridge service can query both Mumble's user/channel data and its own application data. Better concurrency than SQLite.

#### 0.3: Add Cloudflare Tunnel Routes
Add to your `cloudflared` config:
```yaml
ingress:
  - hostname: voice.alex-dyakin.com
    service: http://localhost:3080    # Bridge WebSocket server
  - hostname: mumble.alex-dyakin.com
    service: http://localhost:3081    # Bridge web dashboard
  - hostname: api.alex-dyakin.com
    service: http://localhost:36568   # Lexicon
  - hostname: alchemy.alex-dyakin.com
    service: http://localhost:8080    # Alchemy
  - hostname: alex-dyakin.com
    service: http://localhost:3001    # React frontend
  - service: http_status:404
```

#### 0.4: Register Origins in Lexicon CORS
Edit `lexiconServer/src/main/java/dev/alex/config/LexiconSecurityConfig.java`:
```java
allowedOriginPatterns.add("https://voice\\.alex-dyakin\\.com");
allowedOriginPatterns.add("https://mumble\\.alex-dyakin\\.com");
allowedOriginPatterns.add("http://localhost:3080");  // dev
allowedOriginPatterns.add("http://localhost:3081");  // dev
```

Rebuild: `cd lexiconServer && ./gradlew clean build -x test`

#### 0.5: Initialize Bridge Database Tables
In the Mumble Bridge service (Node.js):
```sql
-- Bridge Service Tables
CREATE TABLE user_mapping (
  lexicon_user_id INT NOT NULL,
  mumble_user_id INT NOT NULL,
  mumble_token VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (lexicon_user_id),
  UNIQUE (mumble_user_id)
);

CREATE TABLE text_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  channel_id INT NOT NULL,
  user_id INT NOT NULL,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'TEXT',
  media_file_id BIGINT NULL,
  reply_to_id BIGINT NULL,
  is_pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  edited_at TIMESTAMP NULL,
  deleted_at TIMESTAMP NULL,
  INDEX idx_channel (channel_id, created_at),
  INDEX idx_user (user_id)
);

CREATE TABLE bot_commands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  command_name VARCHAR(50) NOT NULL,
  usage_count INT DEFAULT 0,
  last_used TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_profiles (
  user_id INT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'online',
  custom_status TEXT NULL,
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## Feature Phases

### Phase 1: Backend Infrastructure & Auth (Week 1-2)

#### 1A: Mumble Bridge Service Scaffold
**Effort:** 3 days | **Impact:** Enables all subsequent features

Set up Node.js project:
- WebSocket server (ws library)
- Mumble protocol handler (protobufjs)
- Lexicon API client
- Database layer (mysql2 / sequelize)
- Bot engine framework

**Deliverable:** Basic bridge that accepts WebSocket connections, authenticates via Lexicon, and talks to Mumble.

**Files to create:**
```
mumble-bridge/
├── src/
│   ├── index.js              — Entry point
│   ├── config.js             — Configuration
│   ├── ws-server.js          — WebSocket server
│   ├── mumble-connection.js  — Mumble TCP connection
│   ├── client-handler.js     — Per-client logic
│   ├── auth/
│   │   ├── LexiconAuth.js   — Login via Lexicon
│   │   └── MumbleAuth.js    — User mapping
│   ├── bots/
│   │   └── BotEngine.js     — Command parser
│   ├── protocol/
│   │   └── ProtocolTranslator.js — Protobuf ↔ JSON
│   └── database/
│       └── migrations.js
└── proto/
    ├── Mumble.proto
    └── MumbleUDP.proto
```

#### 1B: Auth Bridge (Lexicon ↔ Mumble)
**Effort:** 2 days | **Impact:** User authentication

When a user connects:
1. Bridge authenticates via Lexicon API (JSESSIONID)
2. Bridge queries/creates corresponding Mumble user
3. Bridge stores mapping: Lexicon User ID ↔ Mumble User ID
4. User is now authenticated to both systems

**Lexicon API calls:**
- `GET /api/auth/me` — Get current user info from JSESSIONID

**Mumble Ice API calls:**
- `getRegisteredUsers()` — List users in Mumble
- `registerUser()` — Create user with Mumble if not exists
- `verifyPassword()` — Validate password (optional for Mumble auth)

**Database:** `user_mapping` table (created in Phase 0.5)

#### 1C: WebSocket Server Integration
**Effort:** 2 days | **Impact:** Users can connect from web

Basic WebSocket server:
- Accept connections from `wss://voice.alex-dyakin.com`
- Authenticate via JSESSIONID header
- Establish Mumble TCP connection for the user
- Forward text messages and channel info
- Handle disconnection cleanup

**Message protocol:**
```json
// Client → Server
{ "type": "authenticate", "sessionId": "..." }
{ "type": "text_message", "channelId": 1, "content": "hello" }
{ "type": "move_channel", "channelId": 2 }

// Server → Client
{ "type": "authenticated", "userId": 5, "username": "alex" }
{ "type": "channel_list", "channels": [...] }
{ "type": "user_list", "users": [...] }
{ "type": "text_message", "username": "bob", "content": "hi", "timestamp": "2026-03-05..." }
{ "type": "voice_state", "username": "alex", "speaking": true }
```

---

### Phase 2: Chat Enhancements (Week 2-3)

#### 2A: File & Image Sharing
**Effort:** 2 days | **Impact:** High

Users can upload files/images into chat. Uses existing Lexicon Media API.

**Frontend (both web & Electron):**
- Drag-drop zone in chat input area
- Click "attach" button → file picker
- Preview images inline

**Bridge:**
- Intercept multipart file upload
- POST to Lexicon Media API (`POST /api/media/upload`)
- Get back media ID
- Store `media_file_id` in `text_messages.media_file_id`
- Include media URL in message JSON

**Database schema:**
- `text_messages.media_file_id` (already exists)

#### 2B: Message Reactions (Emoji)
**Effort:** 1 day | **Impact:** Medium

Click emoji button below message to react. Shows reaction count.

**New table:**
```sql
CREATE TABLE message_reactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  username VARCHAR(255),
  emoji VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reaction (message_id, user_id, emoji),
  INDEX idx_message (message_id)
);
```

**WebSocket events:**
```json
{ "type": "reaction_add", "messageId": 123, "emoji": "👍" }
{ "type": "reaction_remove", "messageId": 123, "emoji": "👍" }
{ "type": "reactions_list", "messageId": 123, "reactions": [{ "emoji": "👍", "count": 2, "users": ["alex", "bob"] }] }
```

**UI:** Emoji picker on hover, reaction pills below message.

#### 2C: Reply Threads
**Effort:** 1 day | **Impact:** Medium

Quote a message and reply to it. `reply_to_id` column already exists.

**WebSocket message:**
```json
{
  "type": "text_message",
  "content": "I agree!",
  "replyToId": 123,
  "replyPreview": { "username": "alex", "content": "Should we add reactions?" }
}
```

**UI:** Show quoted message preview above reply. Collapse reply threads for readability.

#### 2D: Message Search
**Effort:** 0.5 days | **Impact:** Medium

Search bar in channel header for full-text search.

**SQL:**
```sql
SELECT * FROM text_messages 
WHERE channel_id = ? AND content LIKE CONCAT('%', ?, '%')
ORDER BY created_at DESC LIMIT 50;
```

**UI:** Search icon in header → dropdown with results → click to jump to message.

#### 2E: Pinned Messages
**Effort:** 0.5 days | **Impact:** Low

The `is_pinned` column already exists. Add pin/unpin UI and a "Pinned" panel.

**UI:** Right-click message → "Pin" option. Show "📌 5 pinned messages" button in header → show panel.

---

### Phase 3: Social Features (Week 4)

#### 3A: User Presence / Status
**Effort:** 1 day | **Impact:** Medium

Users set status: Online, Away, Do Not Disturb, Invisible.

**New columns:**
```sql
ALTER TABLE user_profiles ADD COLUMN status VARCHAR(20) DEFAULT 'online';
ALTER TABLE user_profiles ADD COLUMN custom_status TEXT DEFAULT NULL;
```

**WebSocket:**
```json
{ "type": "user_status_change", "username": "alex", "status": "away", "customStatus": "In a meeting" }
```

**UI:** Colored dot next to username (🟢 Online, 🟡 Away, 🔴 DND, ⚫ Offline). Click to set status.

Auto-set to "Away" after 5 minutes of inactivity.

#### 3B: Direct Messages (DMs)
**Effort:** 3 days | **Impact:** Very High

Private 1-on-1 messaging. This is the #1 social feature missing.

**New table:**
```sql
CREATE TABLE dm_conversations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user1_id INT NOT NULL,
  user2_id INT NOT NULL,
  user1_username VARCHAR(255),
  user2_username VARCHAR(255),
  last_message_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pair (user1_id, user2_id),
  INDEX idx_user1 (user1_id),
  INDEX idx_user2 (user2_id)
);
```

Messages stored in `text_messages` with `message_type = 'DM'` and `dm_conversation_id`.

**WebSocket flow:**
```json
// Client sends
{ "type": "dm_send", "toUsername": "bob", "content": "hey!" }

// Server broadcasts to recipient (if online)
{ "type": "dm_receive", "from": "alex", "content": "hey!", "conversationId": 5, "timestamp": "..." }

// Both users get message history on request
{ "type": "dm_history", "conversationId": 5, "messages": [...] }
```

**UI:** Left sidebar gets "Direct Messages" section. Click user → open DM thread. Show unread badge count.

#### 3C: Friend List
**Effort:** 2 days | **Impact:** Medium

Send/accept friend requests. See online friends.

**New table:**
```sql
CREATE TABLE friendships (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  requester_id INT NOT NULL,
  receiver_id INT NOT NULL,
  status ENUM('pending', 'accepted', 'blocked') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_friendship (requester_id, receiver_id)
);
```

**UI:** Friends tab in sidebar. Sections: "Online", "All", "Pending". Right-click user → Add Friend.

#### 3D: Typing Indicators
**Effort:** 0.5 days | **Impact:** Low

Show "alex is typing..." in real-time.

```json
// Client sends every 3s while typing
{ "type": "typing_start", "channelId": 1 }

// Server broadcasts to channel
{ "type": "user_typing", "username": "alex", "channelId": 1 }
```

Auto-expires after 5 seconds of no `typing_start` events.

---

### Phase 4: Media & Music Integration (Weeks 5-6)

#### 4A: Music Bot Audio in Voice Channel
**Effort:** 3-4 days | **Impact:** Very High

Play music from Lexicon into the Mumble voice channel.

**How it works:**
1. User types `!play <song>` → Bridge searches Lexicon
2. Bridge queues to Lexicon Livestream API (`POST /api/livestream/queue`)
3. Bridge fetches audio stream (`GET /api/media/stream/{id}`)
4. Bridge decodes audio to PCM (using `ffmpeg` or `prism-media`)
5. Bridge encodes PCM to Opus frames
6. Bridge sends Opus frames to Mumble as audio packets
7. All Mumble users hear the music

**Dependencies:**
- `fluent-ffmpeg` or `prism-media` (Node.js) for audio decoding/resampling
- Already have: Lexicon Livestream API for queue management

**Bridge code:**
```javascript
// In bot-engine.js
async function playMusic(searchTerm, channel) {
  const media = await lexiconAPI.searchMedia(searchTerm);
  await lexiconAPI.queueToLivestream(media[0].id);
  const audioStream = await lexiconAPI.getStreamUrl(media[0].id);
  const pcmStream = decodeAudioToPCM(audioStream, 48000); // 48kHz mono
  streamPCMToMumble(pcmStream, channel);
}
```

**Commands:**
- `!play <search>` → Queue to voice channel
- `!skip` → POST `/api/livestream/skip`
- `!queue` → GET `/api/livestream/queue`
- `!np` → GET `/api/livestream/state`
- `!volume <0-100>` → Set music volume (50% default)

#### 4B: Media Player UI
**Effort:** 2 days | **Impact:** Medium

Embedded music player in chat interface.

**Components:**
- "Now Playing" bar at bottom of main content
- Album art, title, progress bar, play/pause/skip buttons
- Queue viewer (slide-out panel)
- Search media from within chat (not just commands)

**Data source:** Lexicon Livestream SSE (`GET /api/livestream/updates`) for real-time state.

**UI: Web & Electron**
```
┌────────────────────────────────────┐
│ 🎵 Song Title - Artist             │
│ [═══════════════] 1:30 / 3:45      │
│ [⏮] [⏯] [⏭] [🔀] [🔁] [📋]      │
└────────────────────────────────────┘
```

#### 4C: Watch Together / Synced Video
**Effort:** 2 days | **Impact:** Medium

Watch videos with synced playback (like Discord Watch Together or Spotify Group Sessions).

**What exists (Lexicon Livestream API):**
- `GET /api/livestream/state` → current video + position
- `GET /api/livestream/updates` (SSE) → real-time state
- `POST /api/livestream/queue` → queue video
- `GET /api/stream/{id}` → HTTP Range-based streaming

**What to build:**
- Embed `<video>` player in chat UI
- Connect to SSE for sync: when server says "playing X at position Y", seek player to match
- Queue management UI (add from media library, reorder, remove)

**This is a "watch party" feature** — everyone sees the same video at the same time and can chat about it.

#### 4D: Screen Sharing (MJPEG — Phase 1, WebRTC — Phase 2)
**Effort (Phase 1): 5-7 days | Impact: Very High**

**Option 1: MJPEG Stream (Fast, Simple)**
```
Screen capture → Canvas → JPEG encode → WebSocket binary → Display as <img>
```
- Works without WebRTC
- ~200-500ms latency, ~5-15fps
- Sufficient for game screens, presentations
- Much simpler code (100 lines vs 1000s for WebRTC)

**Recommendation: Start with MJPEG for quick results, then upgrade to WebRTC later.**

**Web implementation:**
```javascript
// Capture screen
const canvas = await navigator.mediaDevices.getDisplayMedia();
const ctx = canvas.getContext('2d');

// Encode frames to JPEG every 100ms
setInterval(() => {
  canvas.toBlob(blob => {
    ws.send(blob);  // Send binary JPEG to server
  }, 'image/jpeg', 0.8);
}, 100);
```

**Electron implementation:**
```javascript
// Use Electron's desktopCapturer
const sources = await desktopCapturer.getSources({ types: ['screen'] });
// ... capture screen → JPEG encode → send to bridge
```

**Server (Bridge):**
```javascript
// Receive JPEG frames from screen sharer
ws.on('message', (jpeg) => {
  // Broadcast to all users in channel except sender
  for (const client of channelUsers) {
    if (client !== sender) client.send(jpeg);
  }
});
```

**Option 2: WebRTC (Phase 2)**
Later: Replace with WebRTC SFU (e.g., `mediasoup`) for real-time screen + video.

#### 4E: Video Calls
**Effort:** 7-10 days | **Impact:** High**

Turn voice channels into video channels. Same architecture as screen sharing (WebRTC SFU) but from `getUserMedia` instead of `getDisplayMedia`.

**UI Layout:**
```
┌──────────────────────────────────┐
│ Channel Header          [👥] [📹] │
├────────────────────────────────┤
│     Video Grid                 │
│     ┌─────┐ ┌─────┐           │
│     │Alex │ │ Bob │           │
│     └─────┘ └─────┘           │
│     ┌─────┐                    │
│     │Carol│                    │
│     └─────┘                    │
├────────────────────────────────┤
│ [🎤] [🔊] [📹] [⚙️]           │
└──────────────────────────────────┘
```

**Implementation:**
- WebRTC SFU (mediasoup) on bridge
- Toggle camera button in UI
- Video grid layout (responsive)
- Audio stays on Mumble, video on WebRTC

---

### Phase 5: UX Polish (Week 7)

#### 5A: Desktop Notifications
**Effort:** 0.5 days | **Impact:** High

Pop notifications for messages, mentions, DMs.

**Electron:**
```javascript
new Notification({
  title: 'MumbleChat',
  body: 'alex: hey everyone!',
  icon: 'icon.png'
}).show();
```

**Web:**
```javascript
Notification.requestPermission().then(perm => {
  if (perm === 'granted') {
    new Notification('MumbleChat', { body: 'New message in #general' });
  }
});
```

Trigger on: new DM, @mention, message in channel when tab is unfocused.

#### 5B: Voice Activity Indicator
**Effort:** 0.5 days | **Impact:** Medium

Show green ring around avatar when speaking (like Discord).

**Bridge sends:** `{ "type": "voice_state", "username": "alex", "speaking": true }`
**UI:** Green glow animation around avatar when `speaking: true`. Fades when silent.

#### 5C: Push-to-Talk
**Effort:** 1 day | **Impact:** Medium

Hold a key to transmit (instead of voice activity detection).

**Settings:** Voice → Activation Mode: "Voice Activity" / "Push to Talk"
**Default key:** Space (configurable)

**Web:** `document.addEventListener('keydown', ...)` with PTT logic
**Electron:** Global keyboard hook via `globalShortcut` API

#### 5D: Unread Indicators & Mention Badges
**Effort:** 1 day | **Impact:** High

Show unread message counts on channels and DMs.

**Database:**
```sql
CREATE TABLE user_read_state (
  user_id INT NOT NULL,
  channel_id INT NOT NULL,
  last_read_message_id BIGINT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, channel_id)
);
```

**UI:** Channel name in sidebar shows bold + badge: **#general** `3`
DM shows unread count.
@mention notifications are separate (always badge).

#### 5E: Rich Embeds (Link Previews)
**Effort:** 2 days | **Impact:** Medium

When a URL is posted, fetch its Open Graph metadata and show a preview card.

**Bridge-side:**
```javascript
const meta = await fetchOpenGraph(url);
message.embed = {
  title: meta.title,
  description: meta.description,
  thumbnail: meta.image,
  url: url,
  siteName: meta.siteName,
};
```

**Library:** `open-graph-scraper` (Node.js)

**UI:** Show embed card below message (title, desc, thumbnail, favicon).

#### 5F: Role & Permission System
**Effort:** 3 days | **Impact:** Medium

Colored roles, channel-specific permissions, moderation tools.

**New tables:**
```sql
CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#99AAB5',
  position INT DEFAULT 0,
  permissions BIGINT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_roles (
  user_id INT NOT NULL,
  role_id INT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
```

**Permissions bitmask:**
```javascript
const Permissions = {
  SEND_MESSAGES:    1 << 0,
  MANAGE_MESSAGES:  1 << 1,  // delete/edit/pin others' messages
  MANAGE_CHANNELS:  1 << 2,
  KICK_USERS:       1 << 3,
  BAN_USERS:        1 << 4,
  MANAGE_ROLES:     1 << 5,
  MUTE_OTHERS:      1 << 6,
  DEAFEN_OTHERS:    1 << 7,
  MOVE_USERS:       1 << 8,
  ADMINISTRATOR:    1 << 9,  // all permissions
};
```

**UI:** Member list shows role colors. Settings → Roles tab for admin management.

#### 5G: Server Invite Links
**Effort:** 1 day | **Impact:** Medium

Generate shareable invite links.

**New table:**
```sql
CREATE TABLE invite_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  max_uses INT DEFAULT NULL,
  uses INT DEFAULT 0,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Flow:** Click "Create Invite" → get link → share it → recipient opens link → auto-connects.

---

### Phase 6: Advanced Features (Weeks 8-10)

#### 6A: Integrated Media Library Browser
**Effort:** 3 days | **Impact:** Very High**

Full media library UI inside the chat app.

**UI panel shows:**
- Recently uploaded media (Lexicon API)
- Search bar for media
- Album art grid view
- Click to play / queue to voice
- Upload button (drag-drop → Lexicon)
- YouTube import (paste URL → Lexicon download)

**Leverages existing Lexicon endpoints** — no new backend code needed for API.

#### 6B: Alchemy Game Integration
**Effort:** 2 days | **Impact:** Medium

Since Alchemy is already running, integrate game status into MumbleChat.

**Features:**
- Show "Playing Alchemy" status when user is in Alchemy
- Link Alchemy profiles to MumbleChat profiles (same Lexicon user ID)
- "Join Game" button in user profile
- Game activity feed: "alex started playing Alchemy"

#### 6C: Custom Soundboard
**Effort:** 2 days | **Impact:** Fun

Upload short audio clips, trigger via buttons or hotkeys.

- Upload sounds (< 10s, < 1MB) to Lexicon
- Personal soundboard grid (drag to reorder)
- Click → encode to Opus → send to Mumble voice
- Hotkey bindings (Electron)
- Volume control

#### 6D: Text-to-Speech
**Effort:** 1 day | **Impact:** Fun

Type `!tts Hello everyone` → message spoken aloud in voice channel.

**Options:**
- Web Speech API (`SpeechSynthesis`) on client, encode output to Opus
- Server-side TTS library (`espeak-ng`, Google Cloud TTS)

---

## Implementation Timeline

### Recommended Build Order

```
Week 1:   Infrastructure (Phase 0 - 0.5 days), Bridge Scaffold (1A - 3 days)
Week 2:   Auth Bridge (1B - 2 days), WebSocket Server (1C - 2 days), File Sharing (2A - 2 days)
Week 3:   Reactions (2B - 1 day), Replies (2C - 1 day), Search (2D - 0.5 days), Pinned (2E - 0.5 days)
          User Status (3A - 1 day)
Week 4:   DirectMessages (3B - 3 days), Friend List (3C - 2 days), Typing (3D - 0.5 days)
Week 5:   Music Bot Audio (4A - 3-4 days), Media Player UI (4B - 2 days)
Week 6:   Watch Together (4C - 2 days), Screen Sharing MJPEG (4D - 5-7 days) — *start early*
Week 7:   Desktop Notifications (5A - 0.5 days), Voice Indicator (5B - 0.5 days), PTT (5C - 1 day),
          Unread (5D - 1 day), Rich Embeds (5E - 2 days)
Week 8:   Roles (5F - 3 days), Invites (5G - 1 day), Media Library (6A - 3 days)
Week 9:   Alchemy Integration (6B - 2 days), Soundboard (6C - 2 days), TTS (6D - 1 day)
Week 10+: Polish, bug fixes, WebRTC upgrades (screen + video)
```

**Critical Path:** Phase 0 (infrastructure) → 1A/1B/1C (bridge) → 2A/2B/2C (chat) → 3B (DMs) → 4A (music)

**Can be parallelized:**
- Week 5-6: Start 4D (screen sharing MJPEG) early while other features finish
- Multiple small features in same week (2B, 2C, 2D can be done in parallel)

---

## Technology Stack

### Backend
| Component | Tech | Reason |
|-----------|------|--------|
| Bridge Service | Node.js + Express | Fast, event-driven, protobuf support |
| WebSocket | `ws` library | Native, lightweight, battle-tested |
| Database | MySQL | Mumble-compatible, better than SQLite for concurrency |
| ORM | Sequelize or Knex | Query builder, migrations |
| Mumble Protocol | `protobufjs` | Parse Mumble's binary protocol |
| Audio Decoding | `prism-media` or `fluent-ffmpeg` | Decode MP3/FLAC to PCM for music bot |
| Opus Encoding | `opusscript` (existing) | Mumble's native codec |

### Frontend
| Component | Tech | Reason |
|-----------|------|--------|
| Web UI | React (existing) | Already in use at :3001 |
| Desktop | Electron (existing) | Cross-platform, same codebase |
| WebSocket Client | Native / `socket.io` | Browser via ws/wss |
| Video/Screen | WebRTC (`mediasoup` later) | Real-time media |
| Emoji Picker | Custom or `emoji-mart` | Reaction UI |
| File Icons | CSS/SVG | Per-file-type icons in chat |
| Notifications | Electron API / Web Notification API | Native desktop + browser |

### Infrastructure
| Component | Tech | Reasoned |
|-----------|------|--------|
| Reverse Proxy | Cloudflare Tunnel | Already in use |
| DNS | Cloudflare | alex-dyakin.com routes |
| Voice | Mumble Server (C++) | Already running, staying unchanged |
| Auth | Lexicon API (Spring Boot) | Centralized user accounts |
| Media | Lexicon Media API | Upload, streaming, search |
| Music | Lexicon Livestream API | Queue management, real-time sync |

---

## Key Architectural Decisions

### 1. Why NOT Merge Databases?
- **Mumble** uses its own DB schema (C++-specific, ACLs, voice state)
- **Lexicon** uses HSQLDB (Java, users, media, playlists)
- **Bridge** has its own DB (text, mappings, settings)

Each owns its data; communication happens via APIs (microservice pattern).

### 2. Why Bridge Service?
- Decouples web clients from Mumble's limited protocol
- Handles protocol translation (protobuf ↔ JSON)
- Extends functionality (text storage, media integration, bots)
- Can scale horizontally (multiple bridge instances)

### 3. Why Lexicon for Text Storage?
- Already has media, user, playlist management
- Accessible from web frontend without Mumble connection
- Can attach media files to messages
- Single source of truth for user data

### 4. Why Mumble Stays Unchanged?
- Voice quality is proven, highly optimized
- ACL/permission system is robust
- No need to rewrite native audio codec
- Just relay its messages through the bridge

---

## Success Metrics

### Phase 1 (Auth & Bridge)
- Users can connect via `wss://voice.alex-dyakin.com`
- Authentication works (Lexicon → Mumble)
- Text messages sync between web and Mumble desktop clients

### Phase 2 (Chat)
- File upload works
- Message reactions, replies, search all work
- Users can't tell they're using a bridge

### Phase 3 (Social)
- DMs are the primary way users interact offline
- Friend list shows online status
- Community feels more connected

### Phase 4 (Media)
- Music bot plays in voice channel
- Multiple users can queue songs
- "Now playing" display syncs across web + Electron

### Phase 5+ (UX)
- App feels as polished as Discord
- All expected features present
- Performance is smooth (< 100ms message latency)

---

## Notes & Gotchas

### Important
1. **Don't skip Phase 0** — Infrastructure setup is the foundation
2. **Test early with real users** — Get feedback after Phase 1B (auth works)
3. **Audio is tricky** — Test music bot audio thoroughly (encoding, resampling, mixing)
4. **WebRTC is complex** — Plan 2+ weeks for screen sharing + video (after simpler MJPEG version)

### Potential Blockers
- **Mumble Ice API documentation** is sparse — read source code
- **WebRTC SFU setup** requires careful configuration (mediasoup is complex)
- **Audio resampling** edge cases (different sample rates, codecs)
- **Browser security** — getUserMedia/getDisplayMedia require HTTPS + user permission

### Future (Beyond Week 10)
- Mobile app (React Native)
- Offline support (service worker + IndexedDB)
- Video call recording
- Bot marketplace
- Third-party integrations (Spotify API, Twitch integration)
- Self-hosted alternative to Cloudflare Tunnel

