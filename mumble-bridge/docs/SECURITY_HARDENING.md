# Bridge security (Phase 3)

How the bridge decides who someone is, what each HTTP route needs, and the switches used while moving over.
Run the offline tests with `npm run test:security` (no Mumble, MySQL, Lexicon or internet needed).

## Signing in (WebSocket)

| Message | What it is | Result |
|---|---|---|
| `{type:'auth', username, password}` | Lexicon username + password, checked against Lexicon | verified session |
| `{type:'sso_auth', token}` | single-use token minted by Lexicon for a signed-in user (website and Android app use this) | verified session |
| `{type:'resume', sessionToken}` | pick a session back up after a reconnect, page reload or bridge restart | same session as before |
| `{type:'auth', username}` (no password) | the old "type a name" login | **refused**, unless `ALLOW_NAME_ONLY_LOGIN=true` (then an unverified session) |
| `{type:'logout'}` | ends the session token | |

`auth_ok` now also carries `sessionToken` and `verified`. Nothing else is accepted before signing in, and a socket cannot sign in
a second time. Nothing about Mumble users or channels is sent before sign-in.

Session tokens are random, stored only as a SHA-256 in the bridge database (`bridge_sessions`), and expire after
`SESSION_TTL_HOURS` (24). A restart does not sign anyone out.

Password sign-ins are limited per address and per address+username (five free wrong passwords, then 5 s doubling to 5 min),
and Lexicon applies its own slowdown on top.

## Admin

Admin means: a **verified** session whose **Lexicon login name** is in `SUPERUSER_NAMES`. A display name (which users can edit) or
a typed name never makes anyone admin. `NAME_ONLY_ADMIN=true` restores the old name matching for unverified sessions only
(transition use; avoid).

## HTTP routes

| Route | Needs |
|---|---|
| static files, `GET /api/avatar/:name`, `GET /api/chat/files/:id`, `GET /api/push/vapid-key` | nothing (images are loaded by `<img>` tags, which cannot send a token) |
| `POST /api/avatar/upload`, `/api/avatar/remove`, `/api/chat/upload` | `Authorization: Bearer <sessionToken>`; acts as that user, ignoring any username/userId in the form |
| the same two avatar routes, from Lexicon | `X-Service-Token` (the shared `LEXICON_SERVICE_TOKEN`). Lexicon's avatar proxy has already checked the player is who they say, so it names them in the form. Accepted on the avatar routes only, never on chat upload or diagnostics; a wrong token is refused outright |
| `GET /api/diag/*` | admin session, or `DIAG_TOKEN` (for `real-time-monitor.js`) |

Uploads are checked by their real bytes (JPEG/PNG/GIF/WebP only), size-limited and rate-limited. Files proxied from Lexicon are only
ever served as images (anything else becomes a sandboxed download).

## Transition switches (all default to the safe setting)

| Setting | When `true` | Turn off when |
|---|---|---|
| `ALLOW_NAME_ONLY_LOGIN` | the old username-only login still works (unverified, never admin) | everyone signs in via the website (SSO) or with a password, and the Android app is updated |
| `NAME_ONLY_ADMIN` | unverified sessions can be admin by name | always, as soon as the admin signs in verified |
| `ALLOW_LEGACY_APP_UPLOADS` | uploads with no token at all are accepted on the form's username/userId (older Android app builds send chat images this way; older Lexicon builds proxied avatars this way) | the Android app sends its session token on chat uploads **and** Lexicon's avatar proxy sends the service token |

## Other hardening

* Chat, image and bot output is escaped everywhere it is shown: the server's rich-text formatter, the web client (including its fallback
  renderer), the HTML sent to native Mumble clients, and the bot's replies. No inline `onclick`/`onerror` remain.
* Image messages are rebuilt from validated values; avatar URLs must be one of our own files; ids from clients must be plain integers.
* `voice_start` / `voice_join_channel` need access to the channel; `text` needs it as before.
* WebSocket: `maxPayload` (2 MB), per-connection message rate limit, connection cap per address, Origin check (this site, the app, and
  clients that send no Origin).
* Content-Security-Policy on the web client, controlled by `CSP_MODE` (`report-only` default: violations are only logged in the browser
  console; set `enforce` after checking the console is clean).
* Unexpected errors are logged with a full stack and counted; ten in a minute exits the process so systemd starts a fresh one.
