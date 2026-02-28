# Voice Diagnostics Update Summary

## What Was Added

### 1. **New Diagnostics Module** (`src/diagnostics.js`)
- Persistent JSON-based logging to `logs/voice-YYYY-MM-DD.log` (auto-rotates daily)
- Automatic log flushing every 1 second
- File size rotation at 50MB
- Methods to retrieve/summarize logs

### 2. **Enhanced Logging in voice-bridge.js**
Added detailed metrics at critical checkpoints:
- **Session lifecycle**: Started, stopped, final statistics
- **Frame drops**: Logged with reason (buffering, errors) and WebSocket buffer state
- **Encoding/Decoding**: Errors logged with context
- **WebSocket metrics**: Buffering amount tracked every frame
- **Echo detection**: Logged when own audio skipped

Key new metric fields:
```javascript
- ws_buffer_amount        // WebSocket buffer in bytes
- frame_drop_buffering    // Frame dropped due to backpressure + ratio
- encode_error            // Opus encoder failures
- decode_error            // Opus decoder failures
- opus_frame_size         // Size of encoded frames
- echo_skip               // When I skip playing my own audio
- session_final_stats     // Full stats on disconnect
```

### 3. **Diagnostic API Endpoints** (in http-server.js)
```
GET /api/diag/logs?lines=500      → Last N lines of logs (plain text)
GET /api/diag/summary              → Aggregated statistics (JSON)
GET /api/diag/files                → List all available log files
```

### 4. **CLI Log Viewer** (`diag-viewer.js`)
```bash
node diag-viewer.js tail [lines]   # Show last N lines
node diag-viewer.js list           # List all log files
node diag-viewer.js read <file>    # Read specific file
node diag-viewer.js grep <pattern> # Search logs
node diag-viewer.js summary        # Generate statistics
node diag-viewer.js export <file>  # Export JSON report
```

### 5. **Documentation** (`DIAGNOSTICS.md`)
Complete guide covering:
- How to view logs (CLI, HTTP, manual fs)
- Testing strategy (identify bottleneck, Cloudflare vs PlayIt)
- Understanding key metrics
- Quick fixes
- GTW testing procedures

---

## Key Metrics You'll See

### WebSocket Buffering
```json
{"event":"metric_ws_buffer_amount","username":"alex","value":4521}
```
- **Normal**: < 5000 bytes
- **Warning**: 5000-10000 bytes
- **Critical**: > 10000 bytes (frames may drop)

### Frame Drops (by buffering)
```json
{"event":"frame_drop_buffering","username":"alex","bufferedAmount":11520,"maxAllowed":9600,"ratioOverThreshold":"1.20"}
```
- `ratioOverThreshold = 1.20` → Buffer was 20% over limit
- First sign of network congestion

### Encode/Decode Errors
```json
{"event":"encode_error","username":"alex","error":"Encode failed"}
{"event":"decode_error","username":"alex","error":"Opus decode error"}
```
- Should be 0 or very low
- Indicates codec configuration issue

### Session Final Stats
```json
{
  "event":"session_final_stats",
  "username":"alex",
  "totalFramesProcessed":{"pcmIn":1200,"opusOut":1200,"mumbleIn":480,"pcmOut":470},
  "frameDrops":{"totalDropped":23,"droppedByBuffering":23,"droppedByError":0}
}
```
- Shows complete session statistics
- How many frames were dropped and why

---

## Quick Start

### 1. Deploy to GTW
```bash
cd mumble-bridge
git pull  # Get the new code
npm install  # (no new dependencies)
npm start
```

### 2. Run a Test
Have users talk for 5-10 minutes, capture the issue.

### 3. Check Logs

**Option A - On GTW directly:**
```bash
node diag-viewer.js tail 100
node diag-viewer.js summary
```

**Option B - Via HTTP from anywhere:**
```bash
curl http://voice.alex-dyakin.com/api/diag/summary | jq
curl "http://voice.alex-dyakin.com/api/diag/logs?lines=200" | head -50
```

**Option C - In real-time from your local machine:**
```bash
# SSH to GTW and stream logs
ssh user@gtw-ip "tail -f mumble-bridge/logs/voice-*.log" | jq
```

### 4. Interpret Results
- Search for `"frame_drop_buffering"` → How many packets dropped?
- Check `ratioOverThreshold` → How badly buffered?
- Look at WebSocket `Max` buffer → Did it exceed 9600 bytes?
- Count `"encode_error"` and `"decode_error"` → Should be 0

### 5. Try PlayIt vs Cloudflare
If lots of frame drops due to buffering:
1. Switch to PlayIt tunnel
2. Re-run test
3. Compare frame drop statistics

---

## File Changes

### New Files
- `src/diagnostics.js` — DiagnosticsLogger class
- `diag-viewer.js` — CLI for analyzing logs
- `DIAGNOSTICS.md` — Complete guide
- `logs/` directory (auto-created on first run)

### Modified Files
- `src/voice-bridge.js` — Added logging at key points
- `src/http-server.js` — Added `/api/diag/*` endpoints
- `src/index.js` — Export voice bridge instance for API

### No Breaking Changes
- All existing functionality preserved
- No new npm dependencies
- Backward compatible with existing clients

---

## Next Steps

1. **Deploy** the updated code to GTW
2. **Run a test** with users experiencing choppy audio
3. **Export the summary**: `curl http://voice.alex-dyakin.com/api/diag/summary > report.json`
4. **Share the metrics** (frame drops, buffer stats, errors)
5. **Try PlayIt** if buffering is the issue
6. **Adjust `MAX_BUFFERED` threshold** if needed

The diagnostics will tell us **exactly** where the problem is! 🎤
