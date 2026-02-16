# Voice Chat Integration — Directions for Lexicon Frontend Team

## Overview

A web-based voice + text chat system is now live at **https://voice.alex-dyakin.com**. It connects directly to the Mumble voice server and integrates with the Lexicon API for user authentication. Users who visit this page can text chat and voice chat with anyone on the Mumble server (desktop app users, ARK players, etc).

The Lexicon React frontend needs links/buttons added so users can easily find and access the voice page.

---

## What to Add

### 1. Voice Chat Link/Button

Add a visible link or button in the Lexicon frontend that opens the voice chat page. Suggested placements:

- **Navigation bar** — A "🎤 Voice" or "Voice Chat" item in the main nav
- **Sidebar** — A voice channel section in the sidebar
- **Dashboard/Home** — A card or banner linking to voice chat

**Target URL:** `https://voice.alex-dyakin.com`

**Recommended approach:** Open in a new tab so users don't lose their Lexicon session:

```jsx
<a href="https://voice.alex-dyakin.com" target="_blank" rel="noopener noreferrer">
  🎤 Voice Chat
</a>
```

Or as a React component:

```jsx
function VoiceChatButton() {
  return (
    <button
      onClick={() => window.open('https://voice.alex-dyakin.com', '_blank')}
      className="voice-chat-btn"
    >
      🎤 Voice Chat
    </button>
  );
}
```

### 2. Optional: Embed in an iframe

If you prefer an embedded experience instead of opening a new tab:

```jsx
<iframe
  src="https://voice.alex-dyakin.com"
  title="Voice Chat"
  width="100%"
  height="600"
  style={{ border: 'none', borderRadius: '8px' }}
  allow="microphone"
/>
```

> **Important:** The `allow="microphone"` attribute is required for voice to work inside an iframe.

### 3. Optional: Pass Username via URL

The voice chat page supports pre-filling the username via a URL parameter. This lets Lexicon users skip the login screen:

```
https://voice.alex-dyakin.com?username=PlayerName
```

React example with current user:

```jsx
function VoiceChatButton({ currentUser }) {
  const voiceUrl = `https://voice.alex-dyakin.com?username=${encodeURIComponent(currentUser.username)}`;
  return (
    <button onClick={() => window.open(voiceUrl, '_blank')}>
      🎤 Voice Chat
    </button>
  );
}
```

> **Note:** The voice page currently requires the user to click "Join" manually even with a pre-filled username. This is for security so users confirm before connecting.

---

## How It Works

| Component | Details |
|-----------|---------|
| **URL** | https://voice.alex-dyakin.com |
| **Protocol** | WSS (WebSocket Secure) via Cloudflare tunnel |
| **Auth** | Passwordless — enter any username, auto-registers with Lexicon if new |
| **Text Chat** | Full text chat synced with Mumble channels, stored in Lexicon API |
| **Voice Chat** | WebRTC audio — hear Mumble users and talk to them from the browser |
| **Bot Commands** | `!help`, `!play`, `!queue`, `!search`, `!users`, `!channels`, `!np`, `!status` |
| **Theme** | Dark themed UI (Inter + JetBrains Mono fonts) |
| **Mobile** | Responsive — works on phones with collapsible sidebar |

---

## Architecture

```
Browser (React frontend)
    ↓ opens new tab or iframe
voice.alex-dyakin.com (Cloudflare tunnel)
    ↓ WSS
Node.js Bridge (port 3080)
    ├── Text: WebSocket ↔ Mumble TCP (protobuf)
    ├── Voice: WebRTC ↔ Mumble UDPTunnel (Opus codec)
    ├── Auth: Lexicon API (http://147.185.221.24:15856)
    └── Storage: MySQL (mumble_bridge DB)
```

---

## User Authentication Flow

1. User enters username on voice page (or it's pre-filled via URL param)
2. Bridge checks Lexicon API for existing user (`GET /api/auth/user-info/{username}`)
3. If not found, auto-registers via Lexicon API (`POST /api/auth/register`)
4. User is assigned their Lexicon user ID and connected to Mumble
5. All messages are stored via Lexicon API with the correct user attribution

---

## Styling Suggestion

To match Lexicon's look, you could style the link/button with:

```css
.voice-chat-btn {
  background: linear-gradient(135deg, #4fc3f7, #29b6f6);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: opacity 0.2s;
}

.voice-chat-btn:hover {
  opacity: 0.9;
}
```

---

## Questions?

The bridge service runs on the Mumble server machine (GTW). Contact Alex for any questions about the integration or if you need API changes.
