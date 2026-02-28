# Voice Diagnostics & Testing Guide

## Problem
Users report **extremely choppy audio** → voices unintele­giblegible, sounds like packets are being dropped or delayed. Local tests don't reproduce the issue.

## Solution: Comprehensive Diagnostics

### Understanding the New Logging System

The voice bridge now logs **every critical event** to persistent files in `logs/voice-YYYY-MM-DD.log`:

- **Frame drops** — when and why audio frames are being skipped
- **WebSocket buffering** — detected sender-side latency
- **Encoding/decoding errors** — opus codec issues
- **Echo detection** — when we skip our own audio (good)
- **Session events** — connections, disconnections, final stats

Each log entry is structured JSON so it's machine-parseable:
```json
{"timestamp":"2026-02-28T14:23:45.123Z","event":"frame_drop_buffering","username":"alex","bufferedAmount":11520,"maxAllowed":9600,"ratioOverThreshold":"1.20","senderSession":42}
```

### Viewing Logs

#### Option 1: Via CLI (Local Machine)
```bash
cd mumble-bridge

# Tail the last 100 lines
node diag-viewer.js tail

# See all 1000 lines
node diag-viewer.js tail 1000

# List all available log files
node diag-viewer.js list

# Search for "drop" in all logs
node diag-viewer.js grep drop

# Search for errors
node diag-viewer.js grep error

# Get summary statistics
node diag-viewer.js summary

# Export detailed JSON report
node diag-viewer.js export report.json
```

#### Option 2: Via HTTP API (From Browser or curl)
```bash
# Get last 500 lines of logs
curl http://voice.alex-dyakin.com/api/diag/logs?lines=500

# Get summary stats
curl http://voice.alex-dyakin.com/api/diag/summary | jq

# List available log files
curl http://voice.alex-dyakin.com/api/diag/files | jq
```

#### Option 3: Manual Inspection
```bash
# Read current day's log directly
tail -f /path/to/mumble-bridge/logs/voice-2026-02-28.log

# Or with jq for pretty printing
tail -f /path/to/mumble-bridge/logs/voice-2026-02-28.log | jq

# Count frame drops
grep "frame_drop_buffering" logs/voice-*.log | wc -l

# Find only encode/decode errors
grep -E '"event":"(encode|decode)_error"' logs/voice-*.log
```

---

## Testing Strategy

### Phase 1: Identify the Bottleneck

**Run a 5-minute test** with multiple users talking, then check:

```bash
node diag-viewer.js summary
```

**Key metrics to look for:**

1. **Frame Drops by Buffering?**
   - `Frame Drops (due to WebSocket buffering)` section
   - If `count > 0` → **WebSocket/network is the bottleneck**
   - If `ratioOverThreshold > 2.0` → connection is really backed up

2. **Encoding/Decoding Errors?**
   - High encoding/decoding errors → **codec configuration issue**
   - Likely means sample rate or frame size mismatch

3. **WebSocket Buffering Stats?**
   - Looking at `Max` and `P95` values:
     - `Max < 9600` → You're fine, plenty of headroom
     - `Max > 9600` → Getting close to dropping frames
     - `Max > 19200` → Definitely dropping frames

### Phase 2: Is It Cloudflare or Something Else?

**Test with PlayIt Tunnel:**

1. Update `.env`:
   ```bash
   # Current (Cloudflare)
   LEXICON_API_URL=http://147.185.221.24:15856
   # Add PlayIt option (in notes)
   # LEXICON_API_URL=http://[playit-ip]:15856
   ```

2. Restart the bridge:
   ```bash
   pkill -f "node src/index.js"
   npm start
   ```

3. Have users test for 5 minutes, then compare logs:
   ```bash
   node diag-viewer.js summary  # Compare to Cloudflare version
   ```

**What to compare:**
- Frame drop count
- Max WebSocket buffer amount
- Encoding/decoding errors

If PlayIt is significantly better → **Cloudflare tunnel = bottleneck**
If same issues → **Problem is network latency to GTW or opus config**

### Phase 3: Detailed Network Analysis

**If frames are dropping due to buffering, check:**

```bash
# Get all WebSocket buffer measurements
node diag-viewer.js grep '"event":"metric_ws_buffer_amount"'

# This will show you the buffering trend over time
# Look for spikes that exceed 9600 bytes
```

**Interpretation:**
- Steady ~2000-5000 bytes → **Normal**
- Spikes to 10000-20000 bytes → **Brief latency hiccups**
- Sustained > 9600 → **Persistent network issue**

---

## Key Diagnostic Metrics Explained

### `ws_buffer_amount` (WebSocket backpressure)
- **What it is**: Bytes waiting to be sent over WebSocket
- **Why it matters**: If too high, packets drop to prevent latency buildup
- **Normal**: < 5000 bytes (20-30 frames)
- **Warning**: > 10000 bytes
- **Critical**: > 20000 bytes (frames will be discarded)

### `frame_drop_buffering`
- **What it is**: Audio frame dropped because WebSocket send buffer was full
- **Why it matters**: **Direct indicator that connection can't keep up**
- **Fix options**:
  1. Increase `MAX_BUFFERED` threshold in `voice-bridge.js` (allow more latency tolerance)
  2. Fix the underlying network (use PlayIt instead of Cloudflare?)
  3. Reduce audio quality (lower bitrate)

### `frame_drop_error`
- **What it is**: Frame dropped due to encoding/decoding error
- **Why it matters**: Suggests codec or audio format mismatch
- **Fix**: Check sample rate, frame size, Opus version

### `echo_skip`
- **What it is**: We received our own audio and discarded it (prevents echo)
- **Why it's good**: This SHOULD happen, shows echo cancellation working
- **Why it's bad**: If count is high with choppy audio → maybe VAD threshold wrong?

---

## Quick Fixes to Try

### 1. Increase Tolerance for Network Jitter
**If:** Frame drops due to buffering
**File:** `src/voice-bridge.js` line ~395

Change:
```javascript
const MAX_BUFFERED = 1920 * 5;  // 100ms
```

To:
```javascript
const MAX_BUFFERED = 1920 * 15; // 300ms (more tolerant)
```

This allows the connection to buffer up to 300ms of audio before dropping frames.

**Trade-off:** Higher latency (but audio quality improves)

### 2. Switch from Cloudflare to PlayIt
If diagnostics show consistent frame drops that improve on PlayIt:
- Update `.env` to use PlayIt endpoint
- Restart service
- Monitor next 5-minute session

### 3. Check VAD (Voice Activity Detection) Threshold
**If:** Cutting off beginning/end of words
**File:** `public/js/chat.js` line ~1170

Current:
```javascript
const VAD_HOLD_FRAMES = 15; // 300ms
```

Try increasing to 20-25 for more tail audio.

---

## Testing on GTW (Deployed Instance)

### Option A: SSH to GTW and Monitor

```bash
ssh user@gtw-ip

# SSH into the production machine
cd /path/to/mumble-bridge

# Watch logs in real-time
node diag-viewer.js tail 50 && node diag-viewer.js tail 50 # Repeat or use watch

# Or continuous tail
tail -f logs/voice-*.log | jq 'select(.event | contains("drop"))'
```

### Option B: Use HTTP API

From your local machine:
```bash
# Get current stats
curl -s http://voice.alex-dyakin.com/api/diag/summary | jq

# Watch for frame drops
while true; do
  curl -s http://voice.alex-dyakin.com/api/diag/summary | jq '.topErrors[] | select(.event | contains("frame"))'
  sleep 5
done
```

### Option C: Have Users Test, Export Report Later

1. Users test for 10 minutes
2. After they're done, download the summary:
   ```bash
   curl -s http://voice.alex-dyakin.com/api/diag/summary > voice-diag-report.json
   atom voice-diag-report.json  # or VS Code, etc.
   ```

---

## Example Diagnostic Output

Running `node diag-viewer.js summary` might show:

```
═══════════════════════════ DIAGNOSTIC SUMMARY ═══════════════════════════
Total Events: 2847

Event Types:
  metric_ws_buffer_amount: 1423
  metric_opus_frame_size: 612
  session_started: 3
  session_stopping: 3
  session_final_stats: 3
  decoder_created: 8
  voice_start: 3

⚠️  Errors: 5
   - Encoding errors: 0
   - Decoding errors: 5

📉 Frame Drops (due to WebSocket buffering):
   alex: 23 drops (max ratio: 1.85x)
   bob: 0 drops (max ratio: 0.00x)

🌐 WebSocket Buffering (bytes):
   Min: 145
   Max: 18720
   Avg: 4821
   P95: 9456

═══════════════════════════════════════════════════════════════════════════
```

**Interpretation:**
- Alex had **23 frame drops** because buffer reached 1.85x threshold
- Max buffer hit **18.7KB** (2x the limit!) — significant latency spikes
- P95 is **9,456 bytes** (very close to 9,600 threshold)
- **Recommendation**: Increase `MAX_BUFFERED` or fix network

---

## Next Steps

1. **Restart the bridge** (new code deploys logging)
2. **Run a 5-10 minute test** with your users
3. **Export the summary**: `node diag-viewer.js summary`
4. **Share the results** so we can pinpoint the exact issue
5. **Try PlayIt tunnel** if Cloudflare shows buffering issues

Let me know what the diagnostics show and we'll fix it! 🎤
