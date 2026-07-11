# Bridge ↔ Lexicon Integration: Push Notifications + SSO Plan

## ✅ Push Notifications (Implemented)

We've integrated with the new Lexicon push endpoints. Here's the flow:

### How It Works Now

```
User opens voice.alex-dyakin.com
  → Service Worker registered (sw.js)
  → Notification.requestPermission()
  → GET /api/push/vapid-key (proxied through bridge → Lexicon)
  → PushManager.subscribe(applicationServerKey)
  → WS: { type: 'push_subscribe', subscription: {...} }
  → Bridge calls POST https://api.alex-dyakin.com/api/push/subscribe

User goes offline (closes tab)

Someone sends them a DM or @mentions them:
  → Bridge detects recipient has no active WebSocket
  → Bridge calls POST https://api.alex-dyakin.com/api/push/send
    { userId, title: "DM from X", body: "message preview", url: "https://voice.alex-dyakin.com" }
  → Lexicon encrypts + delivers push notification
  → User's browser shows system notification
  → Click → opens voice.alex-dyakin.com
```

### Endpoints We're Using
- `GET /api/push/vapid-key` — on client load, for PushManager.subscribe()
- `POST /api/push/subscribe` — register subscription (called via bridge WS proxy)
- `POST /api/push/send` — when DM or @mention targets offline user
- `POST /api/push/unsubscribe` — if user explicitly disables notifications

### What We Send
- **DM**: `{ title: "DM from {username}", body: "{preview}", url: "https://voice.alex-dyakin.com" }`
- **Mention**: `{ title: "@{username} mentioned you", body: "{preview}", url: "https://voice.alex-dyakin.com" }`

---

## 🔜 Next: Shared Authentication / SSO

### Goal
Users should be able to log in once on Lexicon (https://alex-dyakin.com) and seamlessly navigate to voice chat (https://voice.alex-dyakin.com) without re-entering credentials. The bridge should validate passwords against Lexicon instead of accepting any username.

### Current State (Bridge)
- Bridge auth is username-only (no password validation)
- Any username connects; a Lexicon user is auto-created if not found
- Sessions are WebSocket-lifetime only (disconnect = logged out)

### Proposed Flow

**Option A: Token-based SSO (Preferred)**
1. User logs in on Lexicon frontend (https://alex-dyakin.com)
2. Lexicon issues a short-lived SSO token (new endpoint needed)
3. Lexicon frontend links to `https://voice.alex-dyakin.com?token=XXX`
4. Bridge validates token with Lexicon (new endpoint needed)
5. If valid → user is authenticated, no password prompt
6. Token is single-use, expires in 60 seconds

**Required from Lexicon:**
```
POST /api/auth/sso/generate-token
  Request: { userId } (session-authenticated)
  Response: { token: "abc123", expiresAt: "..." }

POST /api/auth/sso/validate-token
  Request: { token: "abc123" }
  Response: { valid: true, userId: 7, username: "alex", displayName: "Alex" }
  (Also invalidates the token)
```

**Option B: Password validation (Simpler)**
1. Bridge sends username + password to `POST /api/auth/login`
2. If 200 → user is authenticated
3. Bridge stores session info
4. User stays logged in (localStorage token or session cookie)

**Required from Lexicon:** Nothing new — already have `/api/auth/login`

### Persistent Sessions (Bridge-Side)

Currently users lose their session when they close the tab. We'll add:
1. On successful auth → generate a session token, store in `user_sessions` MySQL table
2. Send token to client → stored in localStorage
3. On reconnect → client sends token → bridge validates against DB
4. Token expires after 30 days of inactivity

### Link from Lexicon Frontend to Voice

The Lexicon React frontend (https://github.com/ablepacifist/Lexicon) needs a "Voice Chat" button/link that:
1. Generates an SSO token (if Option A)
2. Redirects to `https://voice.alex-dyakin.com?token=XXX`
3. OR just links to `https://voice.alex-dyakin.com` (if using Option B with shared cookies)

### Priority
1. **Password validation** — use Lexicon `/api/auth/login` for bridge auth (quick win)
2. **Persistent sessions** — localStorage token so users stay logged in
3. **SSO tokens** — seamless Lexicon → Voice navigation (needs Lexicon endpoint)
