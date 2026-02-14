# Lexicon Server API Documentation

**Version:** 1.0  
**Base URL (Frontend):** `https://alex-dyakin.com`  
**Base URL (Direct API):** `https://api.alex-dyakin.com` (production) or `http://localhost:36568` (local)  
**Last Updated:** December 22, 2026 (Cloudflare HTTPS Deployment v2)

## Environment Info
- **Frontend:** Running on https://alex-dyakin.com via Cloudflare Tunnel
- **Lexicon API:** Port 36568 (localhost) / Port 15856 (PlayIt tunnel)
- **Alchemy API:** Port 8080 (localhost) / Port 15821 (PlayIt tunnel)
- **Authentication:** HTTP session-based with JSESSIONID cookie
- **CORS:** Configured for alex-dyakin.com and PlayIt origins

## Table of Contents
1. [Authentication & Security](#authentication--security)
2. [CORS Configuration](#cors-configuration)
3. [Authentication Endpoints](#authentication-endpoints)
4. [Player Management](#player-management)
5. [Media Management](#media-management)
6. [Chunked Upload (Large Files)](#chunked-upload-large-files)
7. [Async Download Queue](#async-download-queue)
8. [Playlist Management](#playlist-management)
9. [Playback Position Tracking](#playback-position-tracking)
10. [Live Stream](#live-stream)
11. [Live Stream (Lightweight)](#live-stream-lightweight)
12. [Media Streaming](#media-streaming)
13. [Data Models](#data-models)

---

## Authentication & Security

### Session-Based Authentication
The Lexicon Server uses **HTTP session-based authentication**. Sessions are stored server-side and identified by a session cookie (`JSESSIONID`).

#### Key Points:
- **Session Cookie:** `JSESSIONID` (HttpOnly, Path=/api, SameSite=Lax)
- **Session Timeout:** 30 days of inactivity
- **Credentials Required:** Must include `credentials: 'include'` in fetch requests
- **CORS:** Proper CORS headers must be configured (see below)
- **Domain:** Works across https://alex-dyakin.com and PlayIt origins
- **Note:** Session cookies are NOT transferred between different domains - each microservice needs its own login

#### Authentication Flow:
1. Client sends POST to `/api/auth/login` with username/password
2. Server validates credentials and creates HTTP session
3. Server returns session cookie in `Set-Cookie` header
4. Client includes cookie in subsequent requests via `credentials: 'include'`
5. Server validates session on protected endpoints

#### Protected Endpoints:
- Most endpoints require authentication via session cookie
- Unauthenticated requests return **401 Unauthorized**
- Use `/api/auth/me` to check if session is valid

#### Authorization:
- **User-Based Permissions:** Users can only modify their own content
- **Public Access:** Public media/playlists are readable by all authenticated users
- **Owner Checks:** Update/delete operations verify userId matches resource owner

---

## CORS Configuration

### Required Headers
The server is configured with the following CORS origins:

**Configured Origins (as of Feb 14, 2026):**
```
http://localhost:3000
http://localhost:3001
http://192.168.4.29:3001
http://192.168.4.29:8080
http://192.168.4.29:36568
https://alex-dyakin.com
https://*.alex-dyakin.com
http://147.185.221.24:*
https://147.185.221.24:*
http://*.playit.pub:*
https://*.playit.pub:*
```

**To Add New Origins:**
Update `LexiconSecurityConfig.java` in Lexicon server and rebuild:
```bash
cd lexiconServer && ./gradlew clean build -x test
```

### Important CORS Notes:
1. **Credentials:** All CORS requests support `Access-Control-Allow-Credentials: true`
2. **Exposed Headers:** Server exposes: `Content-Range`, `Accept-Ranges`, `Content-Length`, `Content-Type`, `Cache-Control`, `X-Accel-Buffering`
3. **SSE Endpoints:** SSE (Server-Sent Events) endpoints have explicit CORS configuration
4. **Wildcard Origins:** Controllers use `@CrossOrigin(origins = "*")` but actual filtering in `LexiconSecurityConfig.java`
5. **Session Cookies:** NOT shared across different microservices - each microservice gets its own session

### For Microservice Integration:
**Steps to integrate your microservice:**
1. Add your origin to `LexiconSecurityConfig.java` originPatterns list
2. Update the `/api/auth/login` call in your microservice to use PlayIt URL:
   ```
   http://147.185.221.24:15856/api/auth/login
   ```
3. Store the JSESSIONID cookie and include it in all subsequent requests
4. Use `credentials: 'include'` in all fetch requests
5. Rebuild and restart Lexicon server

---

## Authentication Endpoints

Base Path: `/api/auth`

### POST /api/auth/login
Authenticate user and create session.

**Request:**
```json
{
  "username": "string",
  "password": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "playerId": 1,
  "id": 1,
  "username": "john_doe",
  "displayName": "John Doe",
  "email": "john@example.com",
  "level": 5
}
```

**Errors:**
- `400 Bad Request`: Missing username/password
- `401 Unauthorized`: Invalid credentials
- `500 Internal Server Error`: Server error

**Sets Cookie:** `JSESSIONID` (30 day expiration)

---

### POST /api/auth/register
Register a new user account.

**Request:**
```json
{
  "username": "string (required)",
  "password": "string (required)",
  "confirmPassword": "string (optional)",
  "email": "string (optional)",
  "displayName": "string (optional)"
}
```

**Response (200):**
```json
{
  "success": true,
  "playerId": 42,
  "username": "new_user",
  "message": "Registration successful"
}
```

**Errors:**
- `400 Bad Request`: Validation error (username exists, passwords don't match, etc.)
- `500 Internal Server Error`: Server error

**Notes:**
- Email defaults to `{username}@lexicon.local` if not provided
- Does NOT automatically log in - call `/login` separately

---

### GET /api/auth/me
Get current authenticated user from session.

**Request:** None (uses session cookie)

**Response (200):**
```json
{
  "id": 1,
  "username": "john_doe",
  "displayName": "John Doe",
  "email": "john@example.com",
  "level": 5
}
```

**Errors:**
- `401 Unauthorized`: No valid session

**Use Case:** Check if user is logged in, get user details

---

### POST /api/auth/logout
Invalidate current session.

**Request:** None (uses session cookie)

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## Player Management

Base Path: `/api/players`

### GET /api/players
Get all players.

**Response (200):**
```json
[
  {
    "id": 1,
    "username": "john_doe",
    "displayName": "John Doe",
    "email": "john@example.com",
    "level": 5,
    "registrationDate": "2026-01-15T10:30:00",
    "lastLoginDate": "2026-02-14T08:00:00"
  }
]
```

---

### GET /api/players/{id}
Get player by ID.

**Path Parameters:**
- `id` (integer): Player ID

**Response (200):**
```json
{
  "id": 1,
  "username": "john_doe",
  "displayName": "John Doe",
  "email": "john@example.com",
  "level": 5,
  "registrationDate": "2026-01-15T10:30:00",
  "lastLoginDate": "2026-02-14T08:00:00"
}
```

**Errors:**
- `404 Not Found`: Player doesn't exist

---

### GET /api/players/username/{username}
Get player by username.

**Path Parameters:**
- `username` (string): Player username

**Response:** Same as GET by ID

---

## Media Management

Base Path: `/api/media`

### POST /api/media/upload
Upload a media file (direct upload, max ~100MB).

**Request (multipart/form-data):**
- `file` (file, required): Media file
- `userId` (integer, required): Uploader user ID
- `title` (string, required): Media title
- `description` (string, optional): Description
- `isPublic` (boolean, default: false): Public visibility
- `mediaType` (string, default: "OTHER"): MUSIC, VIDEO, AUDIOBOOK, OTHER

**Response (200):**
```json
{
  "success": true,
  "message": "File uploaded successfully",
  "mediaFile": {
    "id": 123,
    "filename": "song.mp3",
    "originalFilename": "song.mp3",
    "contentType": "audio/mpeg",
    "fileSize": 5242880,
    "filePath": "music/20260214_103045_abc123_song.mp3",
    "uploadedBy": 1,
    "uploadDate": "2026-02-14T10:30:45",
    "title": "My Song",
    "description": "A great song",
    "mediaType": "MUSIC",
    "isPublic": true
  }
}
```

**Errors:**
- `400 Bad Request`: Invalid file or parameters
- `500 Internal Server Error`: Upload failed

**Note:** For files >100MB, use Chunked Upload instead.

---

### POST /api/media/upload-from-url
Download media from URL using yt-dlp (YouTube, SoundCloud, etc.).

**Request Parameters:**
- `url` (string, required): Media URL
- `userId` (integer, required): User ID
- `title` (string, required): Media title
- `description` (string, optional): Description
- `isPublic` (boolean, default: false): Public visibility
- `mediaType` (string, default: "OTHER"): Media type
- `downloadType` (string, default: "AUDIO_ONLY"): AUDIO_ONLY, VIDEO, BEST_QUALITY

**Response (200):**
```json
{
  "success": true,
  "message": "Media downloaded and uploaded successfully",
  "mediaFile": { /* MediaFile object */ }
}
```

**Errors:**
- `400 Bad Request`: Invalid URL or parameters
- `500 Internal Server Error`: Download/upload failed

**Note:** This is synchronous. For async downloads, use `/api/download-queue/start`.

---

### GET /api/media/{id}
Get media file metadata by ID.

**Path Parameters:**
- `id` (integer): Media file ID

**Response (200):**
```json
{
  "id": 123,
  "filename": "song.mp3",
  "originalFilename": "song.mp3",
  "contentType": "audio/mpeg",
  "fileSize": 5242880,
  "filePath": "music/20260214_103045_abc123_song.mp3",
  "uploadedBy": 1,
  "uploadDate": "2026-02-14T10:30:45",
  "title": "My Song",
  "description": "A great song",
  "mediaType": "MUSIC",
  "sourceUrl": "https://youtube.com/watch?v=...",
  "isPublic": true
}
```

**Errors:**
- `404 Not Found`: Media file doesn't exist

---

### GET /api/media/user/{userId}
Get all media files by user.

**Path Parameters:**
- `userId` (integer): User ID

**Response (200):**
```json
[ /* Array of MediaFile objects */ ]
```

---

### GET /api/media/public
Get all public media files.

**Response (200):**
```json
[ /* Array of public MediaFile objects */ ]
```

---

### GET /api/media/search?q=searchTerm
Search media files by title or description.

**Query Parameters:**
- `q` (string, required): Search term

**Response (200):**
```json
[ /* Array of matching MediaFile objects */ ]
```

---

### GET /api/media/recent?limit=10
Get recent media files.

**Query Parameters:**
- `limit` (integer, default: 10): Number of results

**Response (200):**
```json
[ /* Array of recent MediaFile objects */ ]
```

---

### PUT /api/media/{id}?userId={userId}
Update media file metadata.

**Path Parameters:**
- `id` (integer): Media file ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Request Body:**
```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "isPublic": true,
  "mediaType": "MUSIC"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Media file updated successfully"
}
```

**Errors:**
- `403 Forbidden`: User doesn't own media file
- `404 Not Found`: Media file doesn't exist

---

### DELETE /api/media/{id}?userId={userId}
Delete media file.

**Path Parameters:**
- `id` (integer): Media file ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Response (200):**
```json
{
  "success": true,
  "message": "Media file deleted successfully"
}
```

**Errors:**
- `403 Forbidden`: User doesn't own media file
- `404 Not Found`: Media file doesn't exist

---

### GET /api/media/{id}/access?userId={userId}
Check if user has access to media file.

**Path Parameters:**
- `id` (integer): Media file ID

**Query Parameters:**
- `userId` (integer): User ID

**Response (200):**
```json
{
  "hasAccess": true
}
```

---

### GET /api/media/{id}/download
Download media file (full file).

**Path Parameters:**
- `id` (integer): Media file ID

**Response (200):**
- Binary file data
- Headers: `Content-Type`, `Content-Disposition: attachment`

**Errors:**
- `404 Not Found`: Media file doesn't exist
- `204 No Content`: File data not available

---

### GET /api/media/stream/{id}
Stream media file with HTTP Range support (for video/audio playback).

**Path Parameters:**
- `id` (integer): Media file ID

**Request Headers:**
- `Range` (optional): e.g., `bytes=0-1023` for seeking

**Response (200 or 206):**
- Binary file data
- Status: `200 OK` (full file) or `206 Partial Content` (range request)
- Headers: `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`

**Use Case:** Video player seeking, audio streaming

---

## Chunked Upload (Large Files)

Base Path: `/api/media/chunked`

**Use Case:** Upload files >100MB by splitting into chunks (typically 10MB each).

### POST /api/media/chunked/init
Initialize a chunked upload session.

**Request Parameters:**
- `filename` (string): Original filename
- `contentType` (string): MIME type
- `totalSize` (long): Total file size in bytes
- `chunkSize` (integer): Chunk size in bytes (e.g., 10485760)
- `userId` (integer): User ID
- `title` (string): Media title
- `description` (string, optional): Description
- `isPublic` (boolean, default: false): Public visibility
- `mediaType` (string, default: "OTHER"): Media type
- `checksum` (string, optional): File checksum for verification

**Response (200):**
```json
{
  "success": true,
  "uploadId": "uuid-here",
  "totalChunks": 150,
  "chunkSize": 10485760,
  "message": "Chunked upload session initialized"
}
```

**Notes:**
- Store the `uploadId` for subsequent chunk uploads
- `totalChunks = ceil(totalSize / chunkSize)`

---

### POST /api/media/chunked/upload/{uploadId}
Upload a single chunk.

**Path Parameters:**
- `uploadId` (string): Upload session ID from init

**Request (multipart/form-data):**
- `chunkNumber` (integer): Chunk number (0-indexed)
- `chunk` (file): Chunk binary data
- `checksum` (string, optional): Chunk checksum

**Response (200):**
```json
{
  "success": true,
  "progress": 66.67,
  "uploadedChunks": 100,
  "totalChunks": 150,
  "isComplete": false,
  "message": "Chunk uploaded successfully"
}
```

**When All Chunks Uploaded:**
```json
{
  "success": true,
  "progress": 100.0,
  "uploadedChunks": 150,
  "totalChunks": 150,
  "isComplete": true,
  "assembling": true,
  "message": "All chunks uploaded, starting assembly..."
}
```

**Errors:**
- `400 Bad Request`: Invalid chunk or upload session
- `500 Internal Server Error`: Upload failed

---

### GET /api/media/chunked/status/{uploadId}
Get upload status and progress.

**Path Parameters:**
- `uploadId` (string): Upload session ID

**Response (200):**
```json
{
  "success": true,
  "uploadId": "uuid-here",
  "filename": "large-video.mp4",
  "totalSize": 1500000000,
  "totalChunks": 150,
  "uploadedChunks": 75,
  "progress": 50.0,
  "status": "UPLOADING",
  "isComplete": false,
  "lastActivity": "2026-02-14T10:45:30"
}
```

**Status Values:**
- `UPLOADING`: Chunks being uploaded
- `ASSEMBLING`: All chunks uploaded, file being assembled
- `COMPLETED`: Assembly complete, media file created
- `CANCELLED`: Upload cancelled

---

### GET /api/media/chunked/missing/{uploadId}
Get list of missing chunks (for resume functionality).

**Path Parameters:**
- `uploadId` (string): Upload session ID

**Response (200):**
```json
{
  "success": true,
  "uploadId": "uuid-here",
  "missingChunks": [10, 15, 23],
  "missingCount": 3,
  "totalChunks": 150
}
```

---

### POST /api/media/chunked/finalize/{uploadId}
Finalize upload and create MediaFile.

**Path Parameters:**
- `uploadId` (string): Upload session ID

**Response (200):**
```json
{
  "success": true,
  "message": "Large file uploaded successfully",
  "mediaFile": { /* MediaFile object */ }
}
```

**Errors:**
- `400 Bad Request`: Upload not complete or already finalized
- `500 Internal Server Error`: Finalization failed

**Notes:**
- This is called automatically when all chunks are uploaded
- Waits for assembly to complete (up to 5 minutes for large files)
- Creates the final MediaFile in database

---

### DELETE /api/media/chunked/{uploadId}
Cancel an upload session.

**Path Parameters:**
- `uploadId` (string): Upload session ID

**Response (200):**
```json
{
  "success": true,
  "message": "Upload cancelled successfully"
}
```

---

### GET /api/media/chunked/progress/{uploadId}
Get real-time progress via Server-Sent Events (SSE).

**Path Parameters:**
- `uploadId` (string): Upload session ID

**Response:** SSE stream

**Event Types:**
- `progress`: Upload progress updates
- `complete`: Upload completed
- `error`: Upload error

**Example Event:**
```
event: progress
data: {"uploadId": "uuid", "progress": 45.5, "uploadedChunks": 68, "totalChunks": 150, "status": "UPLOADING"}
```

---

## Async Download Queue

Base Path: `/api/download-queue`

**Use Case:** Download media from URLs asynchronously (queue-based).

### POST /api/download-queue/start
Queue a new download job (returns immediately).

**Request Parameters:**
- `url` (string): Media URL
- `userId` (integer): User ID
- `title` (string): Media title
- `description` (string, optional): Description
- `isPublic` (boolean, default: false): Public visibility
- `mediaType` (string, default: "OTHER"): Media type
- `downloadType` (string, default: "AUDIO_ONLY"): Download type

**Response (200):**
```json
{
  "success": true,
  "jobId": "job-uuid-here",
  "message": "Download queued successfully. Check status with /api/download-queue/status/job-uuid-here",
  "statusUrl": "/api/download-queue/status/job-uuid-here"
}
```

**Notes:**
- Returns immediately with job ID
- Download happens in background
- Poll `/status/{jobId}` to check progress

---

### GET /api/download-queue/status/{jobId}
Check status of a download job.

**Path Parameters:**
- `jobId` (string): Job ID from start response

**Response (200):**
```json
{
  "success": true,
  "jobId": "job-uuid-here",
  "url": "https://youtube.com/watch?v=...",
  "title": "My Video",
  "status": "PROCESSING",
  "queuedAt": "2026-02-14T10:00:00",
  "startedAt": "2026-02-14T10:01:00",
  "completedAt": null,
  "progress": {
    "percentage": 45.5,
    "message": "Downloading...",
    "status": "DOWNLOADING"
  }
}
```

**Status Values:**
- `QUEUED`: Waiting in queue
- `PROCESSING`: Download in progress
- `COMPLETED`: Download complete, media file created
- `FAILED`: Download failed

**When Completed:**
```json
{
  "success": true,
  "jobId": "job-uuid",
  "status": "COMPLETED",
  "completedAt": "2026-02-14T10:05:00",
  "mediaFileId": 456
}
```

**When Failed:**
```json
{
  "success": true,
  "jobId": "job-uuid",
  "status": "FAILED",
  "error": "Download failed: Invalid URL"
}
```

**Errors:**
- `404 Not Found`: Job doesn't exist

---

### GET /api/download-queue/active/{userId}
Get all active downloads for a user.

**Path Parameters:**
- `userId` (integer): User ID

**Response (200):**
```json
{
  "success": true,
  "count": 2,
  "jobs": {
    "job-uuid-1": {
      "url": "https://youtube.com/watch?v=...",
      "title": "Video 1",
      "status": "PROCESSING",
      "queuedAt": "2026-02-14T10:00:00"
    },
    "job-uuid-2": {
      "url": "https://youtube.com/watch?v=...",
      "title": "Video 2",
      "status": "QUEUED",
      "queuedAt": "2026-02-14T10:05:00"
    }
  }
}
```

---

### DELETE /api/download-queue/{jobId}
Cancel a download job.

**Path Parameters:**
- `jobId` (string): Job ID

**Response (200):**
```json
{
  "success": true,
  "message": "Download cancelled"
}
```

**Notes:**
- Can only cancel jobs that haven't started or are still queued
- Jobs in progress cannot be cancelled

---

## Playlist Management

Base Path: `/api/playlists`

### POST /api/playlists?userId={userId}
Create a new playlist.

**Query Parameters:**
- `userId` (integer, required): Creator user ID

**Request Body:**
```json
{
  "name": "My Playlist",
  "description": "A great playlist",
  "isPublic": true,
  "mediaFileIds": [1, 2, 3, 4]
}
```

**Response (200):**
```json
{
  "id": 10,
  "name": "My Playlist",
  "description": "A great playlist",
  "isPublic": true,
  "createdBy": 1,
  "createdDate": "2026-02-14T10:00:00",
  "itemCount": 4,
  "mediaFileIds": [1, 2, 3, 4]
}
```

**Errors:**
- `400 Bad Request`: Invalid playlist data
- `401 Unauthorized`: User ID required
- `500 Internal Server Error`: Creation failed

---

### GET /api/playlists?userId={userId}
Get playlists by user or get public playlists.

**Query Parameters:**
- `userId` (integer, optional): If provided, gets user's playlists. If omitted, gets public playlists.

**Response (200):**
```json
[ /* Array of Playlist objects */ ]
```

---

### GET /api/playlists/user/{userId}
Get playlists created by a specific user.

**Path Parameters:**
- `userId` (integer): User ID

**Response (200):**
```json
[ /* Array of Playlist objects */ ]
```

---

### GET /api/playlists/public
Get all public playlists.

**Response (200):**
```json
[ /* Array of public Playlist objects */ ]
```

---

### GET /api/playlists/{id}
Get a specific playlist with all items.

**Path Parameters:**
- `id` (integer): Playlist ID

**Response (200):**
```json
{
  "id": 10,
  "name": "My Playlist",
  "description": "A great playlist",
  "isPublic": true,
  "createdBy": 1,
  "createdDate": "2026-02-14T10:00:00",
  "itemCount": 4,
  "items": [
    {
      "id": 1,
      "title": "Song 1",
      "mediaType": "MUSIC",
      /* ... full MediaFile object ... */
    },
    {
      "id": 2,
      "title": "Song 2",
      "mediaType": "MUSIC",
      /* ... */
    }
  ]
}
```

**Errors:**
- `404 Not Found`: Playlist doesn't exist

---

### PUT /api/playlists/{id}?userId={userId}
Update playlist metadata.

**Path Parameters:**
- `id` (integer): Playlist ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Request Body:**
```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "isPublic": false
}
```

**Response (200):**
```json
{ /* Updated Playlist object */ }
```

**Errors:**
- `403 Forbidden`: User doesn't own playlist
- `404 Not Found`: Playlist doesn't exist

---

### DELETE /api/playlists/{id}?userId={userId}&deleteMediaFiles={boolean}
Delete a playlist.

**Path Parameters:**
- `id` (integer): Playlist ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)
- `deleteMediaFiles` (boolean, default: false): Also delete media files

**Response (200):**
```json
"Playlist deleted successfully"
```

**Errors:**
- `403 Forbidden`: User doesn't own playlist
- `404 Not Found`: Playlist doesn't exist

---

### POST /api/playlists/{id}/items?userId={userId}
Add a media file to playlist.

**Path Parameters:**
- `id` (integer): Playlist ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Request Body:**
```json
{
  "mediaFileId": 123
}
```

**Response (200):**
```json
"Item added to playlist"
```

**Errors:**
- `403 Forbidden`: User doesn't own playlist
- `404 Not Found`: Playlist or media file doesn't exist

---

### DELETE /api/playlists/{id}/items/{mediaId}?userId={userId}
Remove a media file from playlist.

**Path Parameters:**
- `id` (integer): Playlist ID
- `mediaId` (integer): Media file ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Response (200):**
```json
"Item removed from playlist"
```

---

### PUT /api/playlists/{id}/reorder?userId={userId}
Reorder playlist items.

**Path Parameters:**
- `id` (integer): Playlist ID

**Query Parameters:**
- `userId` (integer): User ID (must match owner)

**Request Body:**
```json
{
  "mediaFileIds": [3, 1, 4, 2]
}
```

**Response (200):**
```json
"Playlist reordered"
```

---

### POST /api/playlists/import-youtube
Import a YouTube playlist.

**Request Parameters:**
- `url` (string): YouTube playlist URL
- `userId` (integer): User ID
- `playlistName` (string, optional): Playlist name (defaults to YouTube playlist name)
- `isPublic` (boolean, default: true): Playlist visibility
- `mediaIsPublic` (boolean, default: false): Media files visibility
- `mediaType` (string, default: "MUSIC"): Media type for all items
- `downloadType` (string, default: "AUDIO_ONLY"): Download type

**Response (200):**
```json
{
  "status": "processing",
  "message": "Playlist import started",
  "importId": "import_1708000000000_1"
}
```

**Notes:**
- Returns immediately with import ID
- Use SSE endpoint to track progress
- Downloads all videos/songs in background

---

### GET /api/playlists/import-progress/{importId}
Get real-time import progress via SSE.

**Path Parameters:**
- `importId` (string): Import ID from import-youtube response

**Response:** SSE stream

**Event Types:**
- `connected`: Connection established
- `progress`: Import progress updates
- `completed`: Import completed
- `error`: Import error

**Example Events:**
```
event: connected
data: {"type":"connected","message":"Connected to progress stream","importId":"import_123"}

event: progress
data: {"type":"progress","message":"Downloading track 5/10","total":10,"successful":4,"failed":0,"processed":5,"percentage":50}

event: completed
data: {"type":"completed","playlistId":42,"totalTracks":10,"successfulTracks":9,"failedTracks":1,"message":"Import completed: 9/10 tracks successful"}
```

---

## Playback Position Tracking

Base Path: `/api/playback`

**Use Case:** Remember playback position for resuming media.

### POST /api/playback/position
Save or update playback position.

**Request Body:**
```json
{
  "userId": 1,
  "mediaFileId": 123,
  "position": 125.5,
  "duration": 300.0,
  "completed": false
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Playback position saved"
}
```

---

### GET /api/playback/position/{userId}/{mediaFileId}
Get playback position for a specific media file.

**Path Parameters:**
- `userId` (integer): User ID
- `mediaFileId` (integer): Media file ID

**Response (200):**
```json
{
  "found": true,
  "position": 125.5,
  "duration": 300.0,
  "completed": false,
  "progressPercentage": 41.83,
  "lastUpdated": "2026-02-14T10:30:00"
}
```

**When No Position Saved:**
```json
{
  "found": false
}
```

---

### GET /api/playback/user/{userId}
Get all playback positions for a user.

**Path Parameters:**
- `userId` (integer): User ID

**Response (200):**
```json
[
  {
    "userId": 1,
    "mediaFileId": 123,
    "position": 125.5,
    "duration": 300.0,
    "completed": false,
    "progressPercentage": 41.83,
    "lastUpdated": "2026-02-14T10:30:00"
  },
  /* ... */
]
```

---

### DELETE /api/playback/position/{userId}/{mediaFileId}
Delete playback position.

**Path Parameters:**
- `userId` (integer): User ID
- `mediaFileId` (integer): Media file ID

**Response (200):**
```json
{
  "success": true,
  "message": "Playback position deleted"
}
```

---

## Live Stream

Base Path: `/api/livestream`

**Use Case:** Synchronized video/music stream for all users.

### GET /api/livestream/state
Get current live stream state.

**Response (200):**
```json
{
  "success": true,
  "state": {
    "id": 1,
    "currentMediaId": 123,
    "currentMedia": { /* MediaFile object */ },
    "currentStartTime": "2026-02-14T10:00:00",
    "currentPositionMs": 0,
    "totalSkipVotes": 0,
    "requiredSkipVotes": 1,
    "queuedItems": []
  }
}
```

---

### GET /api/livestream/queue
Get current queue.

**Response (200):**
```json
{
  "success": true,
  "queue": [
    {
      "id": 1,
      "mediaFileId": 124,
      "mediaFile": { /* MediaFile object */ },
      "queuedBy": 1,
      "queuedAt": "2026-02-14T10:05:00",
      "position": 1,
      "status": "QUEUED"
    }
  ],
  "count": 1
}
```

**Status Values:**
- `QUEUED`: Waiting in queue
- `PLAYING`: Currently playing
- `COMPLETED`: Already played

---

### GET /api/livestream/eligible-media
Get all media eligible for livestream queue.

**Response (200):**
```json
{
  "success": true,
  "media": [ /* Array of MediaFile objects */ ],
  "count": 150
}
```

**Notes:**
- Includes public media + private media in public playlists

---

### POST /api/livestream/queue
Add media to queue.

**Request Body:**
```json
{
  "userId": 1,
  "mediaFileId": 123
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Added to queue",
  "queueItem": { /* LiveStreamQueue object */ }
}
```

---

### DELETE /api/livestream/queue/{queueId}?userId={userId}
Remove item from queue.

**Path Parameters:**
- `queueId` (integer): Queue item ID

**Query Parameters:**
- `userId` (integer): User ID (must match queuer)

**Response (200):**
```json
{
  "success": true,
  "message": "Removed from queue"
}
```

---

### POST /api/livestream/skip
Vote to skip current media.

**Request Body:**
```json
{
  "userId": 1
}
```

**Response (200):**
```json
{
  "success": true,
  "skipped": true,
  "message": "Media skipped"
}
```

**Notes:**
- If `requiredSkipVotes` reached, media is skipped immediately
- Otherwise, vote is recorded

---

### GET <mark>/api/livestream/updates</mark>
**Server-Sent Events (SSE)** endpoint for real-time updates.

**Response:** SSE stream

**Event Types:**
- `heartbeat`: Connection established
- `init`: Initial state + queue
- `state-update`: Stream state changed (media changed, etc.)
- `queue-update`: Queue changed (item added/removed)

**Example Events:**
```
event: heartbeat
data: "connected"

event: init
data: {"type":"init","state":{...},"queue":[...],"queueSize":5,"timestamp":1708000000000}

event: state-update
data: {"type":"state-update","data":{...}}

event: queue-update
data: {"type":"queue-update","data":{"items":[...],"totalCount":6}}
```

**Connection Details:**
- Timeout: 30 minutes
- Reconnect on disconnect
- Sends minimal payload on init for fast connection

---

### POST /api/livestream/media-ended
Report that current media has ended (called by frontend).

**Response (200):**
```json
{
  "success": true,
  "message": "Advanced to next media",
  "timeMs": 45
}
```

**Notes:**
- Automatically advances to next media in queue
- If queue empty, plays random media

---

### POST /api/livestream/advance
Manually advance to next media (admin/testing).

**Response (200):**
```json
{
  "success": true,
  "message": "Advanced to next media"
}
```

---

## Live Stream (Lightweight)

Base Path: `/api/livestream/light`

**Use Case:** Lightweight SSE stream for slow connections (queue operations only).

### GET /api/livestream/light/state
Get current playing media only (no queue data).

**Response (200):**
```json
{
  "success": true,
  "currentMediaId": 123,
  "currentMedia": { /* MediaFile object */ },
  "currentStartTime": "2026-02-14T10:00:00",
  "currentPositionMs": 0,
  "requiredSkipVotes": 1,
  "totalSkipVotes": 0,
  "timestamp": 1708000000000
}
```

---

### POST /api/livestream/light/queue
Add to queue (same as full version).

---

### DELETE /api/livestream/light/queue/{queueId}?userId={userId}
Remove from queue (same as full version).

---

### POST /api/livestream/light/skip
Vote to skip (same as full version).

---

### GET <mark>/api/livestream/light/updates</mark>
**SSE** stream for lightweight real-time updates.

**Event Types:**
- `heartbeat`: Connection established
- `state-update-light`: State changed (minimal payload)

**Notes:**
- Much smaller payload than full `/updates`
- Only sends state changes, no queue data
- Better for slow connections

---

## Media Streaming

Base Path: `/api/stream`

**Use Case:** Enhanced streaming with HTTP Range support.

### GET /api/stream/{mediaFileId}
Stream media file with range support.

**Path Parameters:**
- `mediaFileId` (integer): Media file ID

**Request Headers:**
- `Range` (optional): e.g., `bytes=0-1023` for seeking

**Response (200 or 206):**
- Binary file data
- Status: `200 OK` (full file) or `206 Partial Content` (range request)
- Headers: `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type`

**Notes:**
- Automatically handles file system or database storage
- Supports video seeking via range requests
- Better performance than `/api/media/stream/{id}` for large files

---

## Data Models

### Player / User
```typescript
{
  id: number;
  username: string;
  displayName: string;
  email: string;
  level: number;
  registrationDate: string; // ISO 8601
  lastLoginDate: string; // ISO 8601
}
```

### MediaFile
```typescript
{
  id: number;
  filename: string;
  originalFilename: string;
  contentType: string; // MIME type
  fileSize: number; // bytes
  filePath: string; // relative path on disk
  uploadedBy: number; // user ID
  uploadDate: string; // ISO 8601
  title: string;
  description: string;
  mediaType: "MUSIC" | "VIDEO" | "AUDIOBOOK" | "OTHER";
  sourceUrl: string | null; // original URL if downloaded
  isPublic: boolean;
}
```

### Playlist
```typescript
{
  id: number;
  name: string;
  description: string;
  isPublic: boolean;
  createdBy: number; // user ID
  createdDate: string; // ISO 8601
  itemCount: number;
  items?: MediaFile[]; // included in GET /{id}
  mediaFileIds?: number[]; // for create/update
}
```

### LiveStreamState
```typescript
{
  id: number;
  currentMediaId: number | null;
  currentMedia: MediaFile | null;
  currentStartTime: string; // ISO 8601
  currentPositionMs: number;
  totalSkipVotes: number;
  requiredSkipVotes: number;
  queuedItems: LiveStreamQueue[];
}
```

### LiveStreamQueue
```typescript
{
  id: number;
  mediaFileId: number;
  mediaFile: MediaFile;
  queuedBy: number; // user ID
  queuedAt: string; // ISO 8601
  position: number;
  status: "QUEUED" | "PLAYING" | "COMPLETED";
}
```

### PlaybackPosition
```typescript
{
  userId: number;
  mediaFileId: number;
  position: number; // seconds
  duration: number; // seconds
  completed: boolean;
  progressPercentage: number;
  lastUpdated: string; // ISO 8601
}
```

### ChunkedUpload
```typescript
{
  uploadId: string; // UUID
  originalFilename: string;
  contentType: string;
  totalSize: number; // bytes
  chunkSize: number; // bytes
  totalChunks: number;
  uploadedChunks: number;
  progress: number; // percentage
  status: "UPLOADING" | "ASSEMBLING" | "COMPLETED" | "CANCELLED";
  uploadedBy: number; // user ID
  title: string;
  description: string;
  isPublic: boolean;
  mediaType: string;
  lastActivity: string; // ISO 8601
}
```

### DownloadJob
```typescript
{
  jobId: string; // UUID
  url: string;
  userId: number;
  title: string;
  description: string;
  mediaType: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  queuedAt: string; // ISO 8601
  startedAt: string | null; // ISO 8601
  completedAt: string | null; // ISO 8601
  mediaFileId: number | null; // available when COMPLETED
  error: string | null; // available when FAILED
}
```

---

## Error Responses

All endpoints follow consistent error response format:

### 400 Bad Request
```json
{
  "success": false,
  "message": "Error description"
}
```

### 401 Unauthorized
Empty response or:
```json
{
  "success": false,
  "message": "Authentication required"
}
```

### 403 Forbidden
```json
{
  "success": false,
  "message": "Permission denied"
}
```

### 404 Not Found
Empty response or:
```json
{
  "success": false,
  "message": "Resource not found"
}
```

### 500 Internal Server Error
```json
{
  "success": false,
  "message": "Internal error: details"
}
```

---

## Integration Guidelines for Microservices

### 1. Authentication
```javascript
// Production: Use HTTPS subdomains via Cloudflare tunnel
const loginResponse = await fetch('https://api.alex-dyakin.com/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include', // CRITICAL: include cookies
  body: JSON.stringify({ username: 'user', password: 'pass' })
});

// Verify session
const meResponse = await fetch('https://api.alex-dyakin.com/api/auth/me', {
  credentials: 'include' // CRITICAL: include cookies
});

// Local development: Use localhost
const localLogin = await fetch('http://localhost:36568/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ username: 'user', password: 'pass' })
});
```

### 2. CORS Configuration
**For Production (HTTPS via Cloudflare):**
Microservices calling from external origins will be allowed if they originate from:
- `https://alex-dyakin.com` (frontend)
- `https://*.alex-dyakin.com` (any subdomain)
- `http://147.185.221.24:*` (PlayIt fallback)

**For Local Development:**
Add your microservice origin to `CORS_ALLOWED_ORIGINS` environment variable:
```bash
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://your-microservice:port
```

Pattern-based CORS can be added to `LexiconSecurityConfig.java`:
```java
allowedOriginPatterns.add("https://your-domain\.com");
```

### 3. Session Management
- Sessions are server-side only (not JWT)
- Session cookie name: `JSESSIONID`
- Include `credentials: 'include'` in all fetch requests
- Session timeout: 30 days

### 4. File Uploads
- Small files (<100MB): Use `/api/media/upload`
- Large files (>100MB): Use chunked upload `/api/media/chunked/*`
- URL downloads: Use async queue `/api/download-queue/start`

### 5. Real-Time Updates
- Use SSE endpoints for live updates:
  - `/api/livestream/updates` - Full stream updates
  - `/api/livestream/light/updates` - Lightweight stream
  - `/api/media/chunked/progress/{uploadId}` - Chunk upload progress
  - `/api/playlists/import-progress/{importId}` - Playlist import progress

### 6. Media Streaming
- Use `/api/media/stream/{id}` for basic streaming
- Use `/api/stream/{mediaFileId}` for enhanced streaming with range support
- Always check `Accept-Ranges` and `Content-Range` headers for seeking

### 7. Database Communication
- No direct database access between microservices
- All communication via HTTP REST API
- Use appropriate endpoints for CRUD operations
- Implement retry logic for network failures

### 8. Error Handling
```javascript
const response = await fetch(url, options);
if (!response.ok) {
  const error = await response.json();
  console.error(error.message);
  // Handle error
}
```

### 9. Performance Tips
- Use `/api/livestream/light/state` instead of full state when queue not needed
- Poll `/api/download-queue/status/{jobId}` at reasonable intervals (5-10 seconds)
- Cache media file metadata to reduce API calls
- Use SSE for real-time updates instead of polling

---

## Testing Endpoints

### cURL Examples

**Check API Health (verify it's running):**
```bash
# Production (HTTPS via Cloudflare Tunnel)
curl https://api.alex-dyakin.com/api/health

# Alchemy API health check
curl https://alchemy.alex-dyakin.com/

# Local development
curl http://localhost:36568/api/health
curl http://localhost:8080/  # Alchemy

# Fallback: PlayIt Tunnel (if DNS not yet updated)
curl http://147.185.221.24:15856/api/health
```

**Login (Production - HTTPS):**
```bash
curl -X POST https://api.alex-dyakin.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}' \
  -c cookies.txt
```

**Login (Local Development):**
```bash
curl -X POST http://localhost:36568/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}' \
  -c cookies.txt
```

**Get Current User:**
```bash
# Production
curl https://api.alex-dyakin.com/api/auth/me -b cookies.txt

# Local
curl http://localhost:36568/api/auth/me -b cookies.txt
```

**Upload File:**
```bash
# Production
curl -X POST https://api.alex-dyakin.com/api/media/upload \
  -F "file=@song.mp3" \
  -F "userId=1" \
  -F "title=My Song" \
  -F "mediaType=MUSIC" \
  -b cookies.txt

# Local
curl -X POST http://localhost:36568/api/media/upload \
  -F "file=@song.mp3" \
  -F "userId=1" \
  -F "title=My Song" \
  -F "mediaType=MUSIC" \
  -b cookies.txt
```

**Stream Media (with range request for seeking):**
```bash
# Production
curl https://api.alex-dyakin.com/api/media/stream/123 \
  -H "Range: bytes=0-1023" \
  -b cookies.txt

# Local
curl http://localhost:36568/api/media/stream/123 \
  -H "Range: bytes=0-1023" \
  -b cookies.txt
```

**Frontend via HTTPS (once DNS propagates):**
```bash
curl -I https://alex-dyakin.com
# Returns HTTP/2 200 with Cloudflare headers
```

---

## Deployment URLs

### Production (Public - HTTPS via Cloudflare Tunnel)
| Service | URL | Type |
|---------|-----|------|
| **Frontend** | https://alex-dyakin.com | HTTPS ✅ |
| **Lexicon API** | https://api.alex-dyakin.com | HTTPS ✅ |
| **Alchemy API** | https://alchemy.alex-dyakin.com | HTTPS ✅ |
| **Certificate** | Cloudflare CA (auto-renewed) | Valid |
| **Fallback (Legacy)** | http://147.185.221.24:15856 | HTTP |

**IMPORTANT:** Always use HTTPS URLs in production. HTTP fallback is only for systems without DNS resolution.

### Local Development
| Service | URL |
|---------|-----|
| **Frontend** | http://localhost:3001 |
| **Lexicon API** | http://localhost:36568 |
| **Alchemy API** | http://localhost:8080 |
| **Database** | localhost:9002 |

## Microservice Integration Checklist

**Primary (Recommended):**
- [ ] Use `https://api.alex-dyakin.com` for Lexicon API calls
- [ ] Use `https://alchemy.alex-dyakin.com` for Alchemy API calls
- [ ] Verify DNS resolution of alex-dyakin.com (if external)
- [ ] Add your microservice origin to `LexiconSecurityConfig.java` if not matching allowed patterns
- [ ] Implement login to `https://api.alex-dyakin.com/api/auth/login`
- [ ] Store JSESSIONID cookie
- [ ] Include `credentials: 'include'` in all fetch requests
- [ ] Handle 401 responses (session expired)
- [ ] Test CORS with `OPTIONS` preflight request
- [ ] Use `https://api.alex-dyakin.com/api/health` to verify connectivity

**Fallback (if DNS not resolved):**
- [ ] Use `http://147.185.221.24:15856` for Lexicon API (PlayIt tunnel)
- [ ] Use `http://147.185.221.24:15821` for Alchemy API (PlayIt tunnel)
- [ ] Same authentication and CORS requirements apply
- [ ] Update to HTTPS URLs once DNS propagates

## System Architecture

```
Internet (External Devices)
   ↓ HTTPS (Cloudflare SSL/TLS)
https://alex-dyakin.com → Cloudflare Edge Network
   ↓ (routed via Cloudflare Tunnel)
https://api.alex-dyakin.com → localhost:36568 (Lexicon API)
https://alchemy.alex-dyakin.com → localhost:8080 (Alchemy API)
https://alex-dyakin.com → localhost:3001 (React Frontend)
   ↓
Cloudflare Tunnel Connector (this server)
   ↓
Local Services
   ├── localhost:3001 (React Frontend)
   ├── localhost:36568 (Lexicon API, Java/Spring)
   ├── localhost:8080 (Alchemy API, Java/Spring)
   └── localhost:9002 (HSQLDB)

Fallback Path (Legacy PlayIt):
http://147.185.221.24:15856 → localhost:36568 (Lexicon)
http://147.185.221.24:15821 → localhost:8080 (Alchemy)
```

## Security Notes for Microservices

1. **Session Isolation:** Each microservice has its own session. Don't share tokens.
2. **CORS Configuration:**
   - Allowed origins: `https://alex-dyakin.com`, `https://*.alex-dyakin.com`
   - If your microservice origin doesn't match, add it to `LexiconSecurityConfig.java`
   - Use pattern format: `https://your-domain\.com` or `https://.*\.your-domain\.com`
3. **HTTPS Required:** All production API calls must use HTTPS (Cloudflare tunnel routing)
4. **Certificate Validation:** Cloudflare CA certificates are valid and auto-renewed
5. **Cookie Policy:** Cookies are sent only to same domain (Cloudflare subdomain origins)
6. **Authentication:** Always validate user session before processing requests
7. **DNS Resolution:** External devices must resolve alex-dyakin.com correctly
   - Local resolver: `8.8.8.8` (Google) or `1.1.1.1` (Cloudflare)
   - If ISP DNS is stale, manually update resolver
8. **Fallback:** If DNS fails, use PlayIt HTTP URLs as temporary workaround

## DNS Troubleshooting

If microservices can't resolve alex-dyakin.com:

**Check Local Resolution:**
```bash
dig alex-dyakin.com
dig alchemy.alex-dyakin.com
nslookup api.alex-dyakin.com
```

**Should return Cloudflare IPs (e.g., 104.21.42.152, 172.67.163.13):**
If returning old/different IP:
- ISP DNS cache is stale
- Switch to Google (8.8.8.8) or Cloudflare (1.1.1.1)
- On Linux: `sudo resolvectl dns [interface] 8.8.8.8 1.1.1.1`
- On router: Change DNS settings to 8.8.8.8
- Wait 5-10 minutes for propagation

**Temporary Fallback:**
```bash
# Use PlayIt IP directly while DNS updates
curl http://147.185.221.24:15856/api/health
```

## Contact & Support

For questions or issues with this API:
- Check logs: `tail -f /path/to/logs/lexicon.log`
- Verify CORS configuration in `LexiconSecurityConfig.java`
- Ensure session cookies are included in requests
- Check database connectivity: `curl http://localhost:9002`
- Use `/api/health` endpoint to verify API is running
- Test HTTPS tunnel: `curl https://api.alex-dyakin.com/api/health`
- Troubleshoot DNS: `dig alex-dyakin.com` (should return Cloudflare IPs)
- If DNS unresolved, use PlayIt fallback: `curl http://147.185.221.24:15856/api/health`

---

**Last Updated:** December 22, 2026 (Cloudflare HTTPS Deployment v2)  
**API Version:** 1.0  
**For Microservice Integration Team**
