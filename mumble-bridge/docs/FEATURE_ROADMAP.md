# Feature Roadmap — Making MumbleChat Better Than Discord

> What to build next across **mumble-bridge** (web client), **mumble-client** (Electron desktop), and the **Lexicon backend** to create a feature-rich communication platform.

---

## Current State Summary

### What's Already Working

| Feature | Bridge (Web) | Client (Electron) | Backend |
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
| Auth (Lexicon integration) | Partial | Partial | Lexicon /api/auth |

### What's Missing (vs Discord)

| Feature | Priority | Complexity | Category |
|---------|:---:|:---:|:---:|
| **Screen sharing** | High | Hard | Media |
| **Video calls** | High | Hard | Media |
| **Music playback in voice** | High | Medium | Media |
| **File/image sharing in chat** | High | Easy | Chat |
| **Message reactions (emoji)** | Medium | Easy | Chat |
| **Reply threads** | Medium | Easy | Chat |
| **Direct messages (DMs)** | High | Medium | Chat |
| **Friend list** | Medium | Medium | Social |
| **User online/away/DND status** | Medium | Easy | Social |
| **Typing indicators** | Low | Easy | Chat |
| **Rich embeds (link previews)** | Medium | Medium | Chat |
| **Notifications (desktop)** | High | Easy | UX |
| **Role/permission system** | Medium | Medium | Admin |
| **Voice channel user limit** | Low | Easy | Admin |
| **Server invite links** | Medium | Easy | Social |
| **Pinned messages** | Low | Easy | Chat |
| **Message search** | Medium | Easy | Chat |
| **Custom emoji** | Low | Medium | Fun |
| **Soundboard** | Low | Medium | Fun |
| **Push-to-talk (web)** | Medium | Easy | Voice |
| **Voice activity indicator** | Medium | Easy | Voice |

---

## Feature Plan — Phased

### Phase A: Chat Enhancements (1 week)
> Make text chat feel complete and modern.

#### A1: File & Image Sharing in Chat
**Effort:** 2 days | **Impact:** High

Users can drag-and-drop or click to upload files/images into chat. Uploaded files are stored via Lexicon Media API (already built!).

**Bridge changes:**
- `client-handler.js` — New message type `file_upload`, accept binary chunks or use the bridge HTTP server's multipart upload
- `chat.js` (web UI) — Drag-drop zone, file picker button, image preview in messages
- Display uploaded images inline, other files as download links

**Electron changes:**
- `app.js` — Same UI for file upload via `<input type="file">`
- `main.js` — IPC handler to upload via Lexicon API

**Backend:** Already built — `POST /api/media/upload` (Lexicon)

**Message format:**
```json
{
  "type": "text_message",
  "content": "",
  "attachments": [
    { "mediaId": 456, "filename": "screenshot.png", "contentType": "image/png", "url": "/api/media/stream/456" }
  ]
}
```

**Database:**
- `text_messages.media_file_id` column already exists
- Add `attachments` JSON column for multiple files per message

#### A2: Message Reactions (Emoji)
**Effort:** 1 day | **Impact:** Medium

Click a reaction button on any message to add an emoji reaction. Other users see reaction counts.

**New DB table:**
```sql
CREATE TABLE message_reactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  username VARCHAR(255),
  emoji VARCHAR(10) NOT NULL,  -- Unicode emoji
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reaction (message_id, user_id, emoji),
  INDEX idx_message (message_id)
);
```

**WebSocket events:**
```json
{ "type": "reaction_add", "messageId": 123, "emoji": "👍", "username": "alex" }
{ "type": "reaction_remove", "messageId": 123, "emoji": "👍", "username": "alex" }
```

**UI:** Hover over message → reaction picker (small emoji grid). Show reactions below message as pills: `👍 2  ❤️ 1`

#### A3: Reply Threads
**Effort:** 1 day | **Impact:** Medium

Click "Reply" on a message to quote it in your reply. The `reply_to_id` column already exists in `text_messages`.

**UI change:** When replying, show a small preview of the original message above the input bar. In the message list, show a "replying to [username]: [preview]" line above the reply.

**WebSocket message:**
```json
{
  "type": "text_message",
  "content": "I agree!",
  "replyToId": 123,
  "replyPreview": { "username": "alex", "content": "Should we add reactions?" }
}
```

#### A4: Message Search
**Effort:** 0.5 day | **Impact:** Medium

Search bar in channel header. Query `text_messages` with `LIKE` or full-text search.

```sql
SELECT * FROM text_messages 
WHERE channel_id = ? AND content LIKE CONCAT('%', ?, '%')
ORDER BY created_at DESC LIMIT 50;
```

**UI:** Search icon in header → dropdown with results → click to scroll to message.

#### A5: Pinned Messages
**Effort:** 0.5 day | **Impact:** Low

The `is_pinned` column already exists. Add pin/unpin button for admins, and a "Pinned Messages" panel.

---

### Phase B: Social Features (1 week)
> Make users feel connected even outside voice.

#### B1: User Presence / Status
**Effort:** 1 day | **Impact:** Medium

Users can set their status: Online, Away, Do Not Disturb, Invisible.

**Implementation:**
- Add `status` field to WebSocket client state: `'online' | 'away' | 'dnd' | 'invisible'`
- Broadcast status changes to all connected clients
- Show colored dot next to username: 🟢 Online, 🟡 Away, 🔴 DND, ⚫ Offline
- Auto-set to "Away" after 5min idle (mouse/keyboard inactivity)

**New DB column:**
```sql
ALTER TABLE user_profiles ADD COLUMN status VARCHAR(20) DEFAULT 'online';
ALTER TABLE user_profiles ADD COLUMN custom_status TEXT DEFAULT NULL;
```

Custom status text: "Playing Valorant" / "Listening to Spotify" etc.

#### B2: Direct Messages (DMs)
**Effort:** 3 days | **Impact:** High

Private 1-on-1 messaging outside of channels. This is the #1 missing social feature.

**Architecture:**
- DM "channels" are stored in MySQL, not in Mumble (Mumble channels are voice-focused)
- Each DM conversation gets a virtual channel ID (negative IDs or separate table)
- Messages stored in `text_messages` with a special `channel_type = 'DM'`

**New DB table:**
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

**UI:** Left sidebar gets a "Direct Messages" section above channels. Click a user's name → open DM. Show unread badge count.

**WebSocket flow:**
```
Client → { type: 'dm_send', toUsername: 'bob', content: 'hey!' }
Server → stores in text_messages with channel_type='DM', dm_conversation_id
Server → forwards to bob's WebSocket if online
Server → { type: 'dm_receive', from: 'alex', content: 'hey!', conversationId: 5 }
```

#### B3: Friend List
**Effort:** 2 days | **Impact:** Medium

Send/accept friend requests. See online friends, quick-DM them.

**New DB table:**
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

#### B4: Typing Indicators
**Effort:** 0.5 day | **Impact:** Low

Show "alex is typing..." below the message input when someone is typing.

```json
// Client sends every 3s while typing:
{ "type": "typing_start", "channelId": 1 }
// Server broadcasts to channel (excluding sender):
{ "type": "user_typing", "username": "alex", "channelId": 1 }
// Auto-expires after 5s of no typing_start
```

---

### Phase C: Media Integration — Music & Video (1-2 weeks)
> Leverage Lexicon's existing media infrastructure for rich experiences.

#### C1: Music Bot Audio in Voice Channel
**Effort:** 3-4 days | **Impact:** High

Play music from the Lexicon media library into the Mumble voice channel so everyone hears it.

**How it works:**
1. User types `!play <song>` → Bridge searches Lexicon → Queues to Livestream API
2. Bridge fetches audio stream: `GET /api/media/stream/{id}` or `GET /api/stream/{id}`
3. Bridge decodes audio (MP3/Opus/etc.) to PCM using ffmpeg or a Node.js decoder
4. Bridge encodes PCM to Opus frames (same as voice)
5. Bridge sends Opus frames to Mumble as UDPTunnel packets (as the MumbleBridge bot user)
6. All connected Mumble users hear the music

**Dependencies:**
- `fluent-ffmpeg` or `prism-media` (Node.js) for decoding various audio formats to PCM
- Resampling to 48kHz mono if source isn't already

**Volume control:** Music plays at 50% volume by default, adjustable via `!volume 75`

**Integration with Lexicon Livestream API:**
- `GET /api/livestream/updates` (SSE) for real-time state changes
- When livestream advances to next song, bridge automatically starts streaming the new song
- `!skip`, `!queue`, `!np` already implemented — just need the audio pipeline

#### C2: Media Player UI (Web + Electron)
**Effort:** 2 days | **Impact:** Medium

Embedded media player in the chat interface for playing music/video from Lexicon.

**UI Components:**
- "Now Playing" bar at bottom of main content (like Spotify's bottom bar)
- Album art / video thumbnail, title, progress bar, play/pause/skip buttons
- Queue viewer panel (slide-out from right side)
- Search media from within the chat app (not just via bot commands)

**Data source:** Lexicon Livestream SSE (`GET /api/livestream/updates`) for real-time state sync across all connected clients.

**For video:** Use `<video>` element with Lexicon's streaming endpoint:
```html
<video src="https://api.alex-dyakin.com/api/stream/123" controls></video>
```
Lexicon already supports HTTP Range requests for seeking.

#### C3: Screen Sharing
**Effort:** 5-7 days | **Impact:** Very High

Share your screen with everyone in a voice channel — the #1 requested feature for gaming communities.

**Architecture Options:**

**Option 1: WebRTC-based (Recommended for web)**
```
Screen capture → MediaStream → WebRTC PeerConnection → SFU → Other clients
```
- Use `navigator.mediaDevices.getDisplayMedia()` for capture
- Need a Selective Forwarding Unit (SFU) — options:
  - **mediasoup** (Node.js SFU library, production-grade)
  - **Janus** (standalone SFU server)
  - **LiveKit** (open-source, Discord-like)
- Each viewer receives the stream via WebRTC
- Audio from screen share can be mixed into Mumble voice

**Option 2: MJPEG/JPEG stream (Simpler, lower quality)**
```
Screen capture → Canvas → JPEG encode → WebSocket binary → Display as <img>
```
- Works without WebRTC
- Higher latency (~200-500ms), lower frame rate (~5-15fps)
- Sufficient for showing game screens, presentations
- Much simpler to implement

**Recommendation:** Start with Option 2 for quick results, then upgrade to WebRTC for real-time screen sharing.

**For Electron client:**
- Use Electron's `desktopCapturer` API for screen/window selection
- Already has access to system screens

#### C4: Video Calls
**Effort:** 7-10 days | **Impact:** High

Webcam video alongside voice — turn voice channels into video channels.

**Architecture:** Same as screen sharing (WebRTC SFU). The video stream is from getUserMedia instead of getDisplayMedia.

**Implementation:**
- Toggle camera button next to mute/deafen
- Video grid layout (like Discord's voice channel video)
- WebRTC SFU handles all video routing
- Audio stays on Mumble protocol (already working), video uses WebRTC

**UI Layout:**
```
┌──────────────────────────────────────┐
│ Channel Header                  👥 📹 │
├──────────┬───────────────────────────┤
│ Channels │   Video Grid              │
│          │  ┌─────┐ ┌─────┐         │
│ #general │  │Alex │ │Bob  │         │
│ 🔊voice  │  │ 📹  │ │ 📹  │         │
│          │  └─────┘ └─────┘         │
│          │  ┌─────┐                  │
│          │  │Carol│                  │
│ DMs      │  │ 📹  │                  │
│          │  └─────┘                  │
│          ├───────────────────────────┤
│          │   Chat / Text Messages    │
├──────────┴───────────────────────────┤
│ User Panel       [🎤] [🔊] [📹] [⚙️] │
└──────────────────────────────────────┘
```

#### C5: Watch Together / Synced Video Playback
**Effort:** 2 days (already mostly built!) | **Impact:** Medium

Watch videos together with synced playback — Lexicon Livestream API already does this!

**What exists:**
- `GET /api/livestream/state` — current video + position
- `GET /api/livestream/updates` (SSE) — real-time state sync
- `POST /api/livestream/queue` — add to queue
- `POST /api/livestream/skip` — vote to skip
- `GET /api/stream/{id}` — HTTP range-based video streaming

**What to build:**
- Embed a `<video>` player in the chat UI
- Connect to Livestream SSE for sync
- When server says "playing media X at position Y", seek the video player to match
- Queue management UI (add from media library, reorder, remove)

This is essentially a **watch party** feature — everyone sees the same video at the same time, and can chat about it. Discord has this as "Watch Together" and it's very popular.

---

### Phase D: UX Polish & Power Features (1-2 weeks)
> The details that make it feel professional.

#### D1: Desktop Notifications
**Effort:** 0.5 day | **Impact:** High

**Electron:** Use Electron's `Notification` API
```javascript
new Notification({ title: 'MumbleChat', body: 'alex: hey everyone!', icon: 'icon.png' }).show();
```

**Web:** Use the Web Notifications API
```javascript
Notification.requestPermission().then(perm => {
  if (perm === 'granted') new Notification('MumbleChat', { body: 'New message in #general' });
});
```

Trigger on: new DM, mention (@username), message in current channel when tab is unfocused.

#### D2: Rich Embeds / Link Previews
**Effort:** 2 days | **Impact:** Medium

When a URL is posted in chat, fetch its Open Graph metadata and display a preview card.

**Bridge-side:**
```javascript
// When a message contains a URL:
const url = extractUrl(message.content);
if (url) {
  const meta = await fetchOpenGraph(url); // title, description, image, siteName
  message.embed = {
    title: meta.title,
    description: meta.description,
    thumbnail: meta.image,
    url: url,
    siteName: meta.siteName,
  };
}
```

**Libraries:** `open-graph-scraper` (Node.js)

**UI:** Show embed card below the message (title, description, thumbnail image, site favicon).

#### D3: Role & Permission System
**Effort:** 3 days | **Impact:** Medium

Colored roles, channel-specific permissions, moderation tools.

**DB tables:**
```sql
CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#99AAB5',  -- hex color
  position INT DEFAULT 0,              -- higher = more authority
  permissions BIGINT DEFAULT 0,        -- bitmask
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
  MANAGE_MESSAGES:  1 << 1,  // delete/pin others' messages
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

**UI:** Member list shows role colors. Settings → Roles tab for management.

#### D4: Voice Activity Indicator
**Effort:** 0.5 day | **Impact:** Medium

Show a green ring around a user's avatar when they're speaking (like Discord).

**Bridge:** Already tracks which sessions are sending audio. Add a WebSocket event:
```json
{ "type": "voice_state", "username": "alex", "speaking": true }
```

Sent when audio starts/stops from a user (debounced by 200ms to avoid flicker).

**UI:** CSS animation: green glow/ring around avatar → fades when silent.

#### D5: Push-to-Talk (Web + Electron)
**Effort:** 1 day | **Impact:** Medium

Instead of voice activity detection, hold a key to transmit.

**Implementation:**
- Settings → Voice → Activation Mode: "Voice Activity" / "Push to Talk"
- PTT key binding (default: space or configured key)
- `keydown` → start sending mic audio, `keyup` → stop
- Web: `document.addEventListener('keydown', ...)`
- Electron: Global keyboard hook via `globalShortcut` API (works even when window is unfocused)

#### D6: Server Invite Links
**Effort:** 1 day | **Impact:** Medium

Generate shareable invite links: `https://voice.alex-dyakin.com/invite/abc123`

**DB table:**
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

**Flow:** User clicks "Create Invite" → gets a link → shares it → recipient opens link → auto-connects to server.

#### D7: Unread Indicators & Mention Badges
**Effort:** 1 day | **Impact:** High

Show unread message counts on channels and DMs.

- Track last-read message ID per user per channel (in MySQL)
- Channel name in sidebar shows bold + badge: **#general** `3`
- DM shows badge count
- `@username` mentions trigger notifications + badge

---

### Phase E: Advanced Platform Features (2-4 weeks)
> What makes this BETTER than Discord.

#### E1: Integrated Media Library Browser
**Effort:** 3 days | **Impact:** High

Full media library browsing inside the chat app — not just bot commands.

**UI:** A panel/tab that shows:
- Recently uploaded media (from Lexicon)
- Search bar for media
- Album art grid view
- Click to play / queue to voice channel
- Upload button (drag-drop files → Lexicon upload)
- YouTube import (paste URL → auto-download via Lexicon)

This leverages ALL the existing Lexicon endpoints without writing new backend code.

#### E2: Alchemy Game Integration
**Effort:** 2 days | **Impact:** Medium

Since Alchemy is already running on `alchemy.alex-dyakin.com`, integrate game status:

- Show "Playing Alchemy" status when a user is in the Alchemy app
- Link Alchemy profiles to MumbleChat profiles (same Lexicon user ID)
- "Join Game" button in user profile that opens Alchemy
- Game activity in chat: "alex started playing Alchemy"

#### E3: Synchronized Listening Parties
**Effort:** 1 day (mostly built!) | **Impact:** High

This is the Lexicon Livestream + MumbleChat combo at its best:

1. Someone queues a song via `!play` or the media browser
2. Bridge streams the audio into the voice channel (Phase C1)
3. The "Now Playing" bar shows the current song for everyone
4. Everyone hears the same music at the same time
5. They can chat/react in text while listening
6. Skip voting is already implemented

**This is literally Spotify's Group Session / Discord's Spotify integration — but with YOUR own music library, not a subscription service.**

#### E4: Customizable Soundboard
**Effort:** 2 days | **Impact:** Fun

Upload short audio clips, trigger them via buttons or hotkeys.

- Upload sounds (< 10s, < 1MB) to Lexicon
- Personal soundboard grid (drag to reorder)
- Click → encode to Opus → send to Mumble voice channel
- Hotkey bindings (Electron client)
- Volume control (plays at 50% default, adjustable)

#### E5: Text-to-Speech (TTS)
**Effort:** 1 day | **Impact:** Fun

Type `!tts Hello everyone` → message is spoken aloud in the voice channel.

- Use Web Speech API (`SpeechSynthesis`) on client side, or
- Use a TTS library server-side (`espeak-ng`, Google Cloud TTS)
- Encode TTS output → Opus → Mumble

---

## Recommended Build Order

```
WEEK 1:  Phase A (Chat: file sharing, reactions, replies, search)
WEEK 2:  Phase B1-B2 (Status indicators + DMs)
WEEK 3:  Phase C1-C2 (Music bot audio in voice + media player UI)
WEEK 4:  Phase D1,D4,D5,D7 (Notifications, voice indicator, PTT, unread badges)
WEEK 5:  Phase C5 + E1 (Watch together + media library browser)
WEEK 6:  Phase C3 (Screen sharing — Option 2 MJPEG first)
WEEK 7:  Phase B3-B4 + D2-D3 (Friends, typing, embeds, roles)
WEEK 8:  Phase D6 + E2-E4 (Invites, Alchemy integration, soundboard)
LATER:   Phase C3 upgrade (WebRTC screen share), C4 (Video calls)
```

---

## Technology Additions Needed

| What | Package / Tech | Purpose |
|------|----------------|---------|
| Audio decode (for music bot) | `prism-media` or `fluent-ffmpeg` | Decode MP3/FLAC/etc to PCM for Opus encoding |
| Link previews | `open-graph-scraper` | Fetch OG metadata for URL embeds |
| WebRTC SFU | `mediasoup` | Screen sharing + video calls |
| TTS | `espeak-ng` or Web Speech API | Text-to-Speech in voice |
| File type icons | — (CSS) | Icon per file extension in chat |
| Emoji picker | Custom or `emoji-mart` (web) | Reaction picker component |

---

## Architecture Notes

### Why This Architecture Beats Discord

1. **Self-hosted** — Your data, your rules, no subscription fees
2. **Integrated media library** — Built-in music/video hosting (Lexicon), not dependent on Spotify/YouTube
3. **Custom game integration** — Direct link to Alchemy and any future games
4. **Open protocol** — Mumble is open-source, extensible, no vendor lock-in
5. **Unified auth** — One account across voice, chat, media, games (Lexicon)
6. **No Nitro paywall** — All features available to all users

### What Discord Does Better (and how to match)

1. **Voice quality** — Fix plan in `VOICE_FIX_PLAN.md` addresses this
2. **Mobile app** — Future: React Native or PWA
3. **Scale** — Discord handles millions; this is designed for a community/friend group (which is fine!)
4. **Video/screen share reliability** — WebRTC SFU (mediasoup) closes this gap
5. **Bot ecosystem** — The bot engine is extensible; add plugins as needed
