# Avatar / Profile Picture API — Integration Guide

> For Alchemy, Lexicon, and other services that want to use profile pictures from the Mumble Bridge.

## Overview

User profile pictures (avatars) are stored in the **`mumble_bridge`** MySQL database, table **`user_profiles`**. The avatar files themselves are served as static files from the bridge's HTTP server.

Any service that can query MySQL and/or make HTTP requests can use these avatars.

---

## Database Schema

```sql
-- Database: mumble_bridge
-- Table: user_profiles

CREATE TABLE user_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,          -- matches Alchemy/Lexicon username
  lexicon_user_id INT,                     -- Lexicon Player ID (nullable)
  avatar_path VARCHAR(500) DEFAULT NULL,   -- e.g. '/uploads/avatars/alex_1771696681570.gif'
  display_name VARCHAR(255) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_username (username)
);
```

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `username` | VARCHAR(255) | The user's login name (same as Alchemy/Lexicon username). **Primary lookup key.** |
| `lexicon_user_id` | INT | The user's Lexicon Player ID. Can be used to cross-reference with `user_mapping` table. |
| `avatar_path` | VARCHAR(500) | Relative URL path to the avatar file. `NULL` means user has no custom avatar (use default). |

---

## How to Get a User's Avatar

### Option 1: Direct MySQL Query (Recommended for backend services)

```sql
SELECT avatar_path FROM mumble_bridge.user_profiles WHERE username = 'alex';
```

- Returns `avatar_path` like `/uploads/avatars/alex_1771696681570.gif`
- Returns `NULL` if no custom avatar → use default: `/uploads/avatars/default.jpg`

**By Lexicon User ID:**
```sql
SELECT avatar_path FROM mumble_bridge.user_profiles WHERE lexicon_user_id = 206;
```

### Option 2: HTTP API (For frontends / external services)

```
GET https://voice.alex-dyakin.com/api/avatar/{username}
```

**Response:**
```json
{
  "avatarUrl": "/uploads/avatars/alex_1771696681570.gif"
}
```

If no custom avatar:
```json
{
  "avatarUrl": "/uploads/avatars/default.jpg"
}
```

### Option 3: Direct File URL

Once you have the `avatar_path`, the full URL is:

```
https://voice.alex-dyakin.com{avatar_path}
```

Example:
```
https://voice.alex-dyakin.com/uploads/avatars/alex_1771696681570.gif
```

---

## Setting / Uploading an Avatar

### HTTP API (multipart upload)

```
POST https://voice.alex-dyakin.com/api/avatar/upload
Content-Type: multipart/form-data

Fields:
  - username: (string) The username
  - userId:   (int, optional) Lexicon Player ID
  - avatar:   (file) The image file
```

**Allowed types:** JPEG, PNG, GIF, WebP  
**Max size:** 2 MB

**Response:**
```json
{
  "avatarUrl": "/uploads/avatars/alex_1771696681570.gif"
}
```

### Removing an Avatar

```
POST https://voice.alex-dyakin.com/api/avatar/remove
Content-Type: application/json

{
  "username": "alex",
  "userId": 206
}
```

---

## Integration with Alchemy Login

The recommended flow for Alchemy/Lexicon to use Mumble Bridge avatars:

1. **User logs in via Alchemy** → gets their username and Lexicon Player ID
2. **Frontend fetches avatar** → `GET /api/avatar/{username}` from the bridge
3. **Display the avatar** → Use the returned URL as `<img src="...">`

### Example (JavaScript frontend)

```javascript
async function getUserAvatar(username) {
  const res = await fetch(`https://voice.alex-dyakin.com/api/avatar/${encodeURIComponent(username)}`);
  const data = await res.json();
  return `https://voice.alex-dyakin.com${data.avatarUrl}`;
}

// Usage
const avatarUrl = await getUserAvatar('alex');
document.querySelector('#profile-pic').src = avatarUrl;
```

### Example (Java/Kotlin backend — Lexicon)

```java
// Direct MySQL query from Lexicon's backend
String sql = "SELECT avatar_path FROM mumble_bridge.user_profiles WHERE lexicon_user_id = ?";
PreparedStatement stmt = bridgeConnection.prepareStatement(sql);
stmt.setInt(1, playerId);
ResultSet rs = stmt.executeQuery();

String avatarPath = "/uploads/avatars/default.jpg"; // default
if (rs.next() && rs.getString("avatar_path") != null) {
    avatarPath = rs.getString("avatar_path");
}
String fullUrl = "https://voice.alex-dyakin.com" + avatarPath;
```

---

## MySQL Connection Details

The `mumble_bridge` database is on the same MySQL server as Mumble:

| Setting | Value |
|---------|-------|
| Host | `127.0.0.1` (same server) |
| Port | `3306` |
| Database | `mumble_bridge` |
| User | `mumble` (or create a read-only user for other services) |

### Cross-Database Joins

Since `mumble_bridge` and `mumble_server` are on the same MySQL instance, you can join across them:

```sql
-- Get avatar for a Mumble user
SELECT u.username, p.avatar_path
FROM mumble_bridge.user_mapping u
LEFT JOIN mumble_bridge.user_profiles p ON p.username = u.lexicon_username
WHERE u.lexicon_user_id = 206;
```

---

## File Storage

- **Location on disk:** `/home/alex/Documents/mumble/mumble-bridge/public/uploads/avatars/`
- **Served via HTTP at:** `https://voice.alex-dyakin.com/uploads/avatars/`
- **Naming convention:** `{username}_{timestamp}.{ext}` (e.g. `alex_1771696681570.gif`)
- **Default avatar:** `default.jpg` (always present)

### CORS

The bridge server does NOT currently set CORS headers. If Alchemy's frontend is on a different domain and needs to fetch avatars via JavaScript, you may need to:

1. Add CORS headers to the bridge's HTTP server, OR
2. Use `<img>` tags directly (images don't need CORS), OR  
3. Proxy through Alchemy's own backend

---

## Table Relationships

```
mumble_bridge.user_profiles
  ├── username ←→ user_mapping.lexicon_username
  └── lexicon_user_id ←→ user_mapping.lexicon_user_id

mumble_bridge.user_mapping
  └── lexicon_user_id ←→ Lexicon/Alchemy Player.id
```

---

## Summary

| What | How |
|------|-----|
| Get avatar URL for a user | `SELECT avatar_path FROM mumble_bridge.user_profiles WHERE username = ?` |
| Get avatar via HTTP | `GET /api/avatar/{username}` |
| Default avatar | `/uploads/avatars/default.jpg` |
| Upload avatar | `POST /api/avatar/upload` (multipart) |
| Remove avatar | `POST /api/avatar/remove` (JSON) |
| Full image URL | `https://voice.alex-dyakin.com` + `avatar_path` |
