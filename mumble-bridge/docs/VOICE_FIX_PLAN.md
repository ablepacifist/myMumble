# Voice Quality Fix Plan — Diagnosis & Repair

> The original Mumble C++ code is **untouched**. The choppy/garbled voice is exclusively in the **JavaScript audio pipeline** (mumble-bridge + mumble-client), which reimplements Opus encode/decode, Mumble packet framing, mixing, and jitter buffering from scratch.

---

## Root Cause Analysis

After auditing `voice-bridge.js`, `voice.js`, both `voice-processor.js` files, and `main.js`, here are the **10 identified issues** ranked by likely impact on audio quality:

### Critical (Likely causes of "choppy/barely understandable")

| # | Issue | Where | Impact |
|---|-------|-------|--------|
| **1** | **No Packet Loss Concealment (PLC)** | Both systems | When a frame is lost or late, silence is inserted. Real Mumble uses `opus_decode(NULL)` to generate interpolated audio. Lost frames = hard clicks/gaps. |
| **2** | **Electron client has no dry threshold** | `mumble-client/src/renderer/voice-processor.js` L91-103 | Sets `_playing = false` instantly when buffer empties — any momentary gap causes full re-buffering (60ms silence), producing choppy playback every time. |
| **3** | **`setInterval(20ms)` mixer jitter (Electron only)** | `mumble-client/main.js` L349 | Node.js `setInterval` has 1–4ms jitter. Frames arrive at 16-24ms instead of exactly 20ms, causing uneven delivery → audio stutters. The bridge fixed this by sending per-sender frames directly; the Electron client still uses the old accumulator mixer. |
| **4** | **No Opus bitrate configuration** | All OpusScript instantiations | Default VOIP bitrate (~24kbps) is used. Original Mumble defaults to ~40kbps. Lower bitrate = more compression artifacts, especially noticeable at 48kHz mono. |
| **5** | **TCP head-of-line blocking** | Both systems (TCP-only audio) | A single lost TCP segment delays ALL subsequent audio. UDP with FEC would be ideal, but TCP is required for the WebSocket path. The Electron client could use UDP. |

### Moderate (Contribute to quality degradation)

| # | Issue | Where | Impact |
|---|-------|-------|--------|
| **6** | **No jitter buffer on receive side (server-receive path)** | Both voice-bridge.js and main.js | Frames from Mumble arrive with network jitter. They're decoded and forwarded immediately. Out-of-order or bursty delivery goes straight to the mixer. |
| **7** | **WS backpressure drops frames silently** | `voice-bridge.js` L448-461 | When `ws.bufferedAmount > 19200` (~200ms), frames are dropped entirely. During any network slowdown = silence gaps. |
| **8** | **No volume normalization / AGC on receive** | Both systems | Different users at different mic levels are mixed raw. Loud user + quiet user = quiet user inaudible. |
| **9** | **Accumulator mixer timing misalignment** | `main.js` mixer | If two senders' frames straddle a 20ms tick boundary, they're heard in different output frames despite being simultaneous. |
| **10** | **Decoder recreation garbles first frames** | Previously 10s, now 60s timeout | Fixed partially (60s timeout), but still no PLC for the first frame after decoder creation. |

---

## Fix Plan — Prioritized

### Phase V1: Critical Fixes (1-2 days) — biggest bang for the buck

#### Fix 1: Add dry threshold to Electron client AudioWorklet
**File:** `mumble-client/src/renderer/voice-processor.js`

The bridge's `voice-processor.js` already has this fix. Port it to the Electron client:
```javascript
// BEFORE (current — breaks on ANY momentary gap):
if (this._playing && this._buffered === 0) {
  this._playing = false;
}

// AFTER (tolerate brief gaps up to 100ms):
// Add to constructor:
this._drySamples = 0;
this._dryThreshold = 960 * 5; // 100ms (5 Opus frames)

// In process(), when buffered === 0:
this._drySamples += needed;
if (this._drySamples >= this._dryThreshold) {
  this._playing = false;
  this._drySamples = 0;
}
// Reset _drySamples in _writeToRing when new data arrives
```

**Why:** This is the single most impactful fix for the Electron client. Every brief network hiccup currently causes a full 60ms re-buffer silence gap.

#### Fix 2: Set explicit Opus bitrate
**Files:** `mumble-client/src/mumble/voice.js`, `mumble-bridge/src/voice-bridge.js`

```javascript
// After creating OpusScript encoder:
this.encoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
this.encoder.setBitrate(48000); // 48 kbps — clear voice quality

// Also set for decoders when created (optional but helps):
// decoder.setBitrate(48000);
```

OpusScript exposes `setBitrate()`. 48kbps is a good balance — Discord uses 64kbps for "high quality" voice channels. The default ~24kbps is noticeably worse.

#### Fix 3: Implement Opus PLC (Packet Loss Concealment)
**Files:** `mumble-bridge/src/voice-bridge.js`, `mumble-client/src/mumble/voice.js`

When a frame is expected but not received, decode `null` to generate interpolated audio:
```javascript
// In the bridge: after detecting a gap in sequence numbers
// or when the mixer tick fires with no new frames from an active sender:
const plcFrame = entry.decoder.decode(null); // Opus PLC — generates interpolated audio
```

OpusScript's `decode(null)` triggers Opus's built-in packet loss concealment. This generates a smoothly interpolated frame instead of hard silence. This is what the original Mumble C++ does in `AudioOutputSpeech.cpp`.

**Challenge:** Requires tracking sequence numbers per sender to detect gaps. Currently sequence numbers are parsed but not used for gap detection.

#### Fix 4: Switch Electron client to per-sender mixing (match bridge architecture)
**File:** `mumble-client/main.js`

The bridge already fixed this — it sends per-sender PCM frames to the browser, and the AudioWorklet mixes them with per-sender jitter buffers at hardware clock precision. The Electron client still uses the old `setInterval(20ms)` accumulator mixer.

Port the bridge's approach:
1. Instead of mixing in `main.js`, forward each decoded frame with its `senderSession` to the renderer
2. The renderer's AudioWorklet maintains per-sender ring buffers (same as bridge's `voice-processor.js`)
3. Mixing happens at hardware audio clock precision — no `setInterval` jitter

```javascript
// main.js — BEFORE:
mumble.on('audio', ({ senderSession, pcm }) => {
  // additive mix into accumulator
  for (let i = 0; i < len; i++) {
    mixBuf[i] = clamp(mixBuf[i] + pcm[i]);
  }
  mixDirty = true;
});

// main.js — AFTER:
mumble.on('audio', ({ senderSession, pcm }) => {
  // Convert Int16 to Float32 and send per-sender
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    float32[i] = pcm[i] / 32768;
  }
  send('mumble:audio-frame', { senderSession, samples: float32 });
});
// Remove the setInterval mixer entirely
```

Then update `voice-processor.js` in the Electron client to use per-sender ring buffers (copy from bridge's version).

### Phase V2: Quality Improvements (2-3 days)

#### Fix 5: Sequence-based gap detection + PLC
Track per-sender sequence numbers to detect missing frames:
```javascript
// In _onMumbleAudio or _parseLegacyAudio:
const expectedSeq = lastSeq[senderSession] + 1;
if (parsed.sequenceNumber > expectedSeq) {
  const gaps = parsed.sequenceNumber - expectedSeq;
  for (let i = 0; i < Math.min(gaps, 3); i++) {
    const plcPcm = decoder.decode(null); // PLC frame
    // Send PLC frame to output
  }
}
lastSeq[senderSession] = parsed.sequenceNumber;
```

#### Fix 6: Adaptive jitter buffer
Instead of a fixed 60ms jitter buffer, adapt based on observed network jitter:
```javascript
// Track inter-frame arrival times per sender
const now = performance.now();
const delta = now - lastArrival[senderId];
const jitter = Math.abs(delta - 20); // deviation from expected 20ms

// Exponential moving average of jitter
avgJitter = avgJitter * 0.95 + jitter * 0.05;

// Set jitter buffer to 2-3× average jitter, minimum 40ms
const targetBuffer = Math.max(40, Math.min(200, avgJitter * 3));
```

#### Fix 7: Simple AGC (Automatic Gain Control) on receive
Normalize volume levels across senders:
```javascript
// Per-sender RMS tracking
let rms = 0;
for (let i = 0; i < pcm.length; i++) rms += pcm[i] * pcm[i];
rms = Math.sqrt(rms / pcm.length);

const targetRMS = 3000; // Target loudness (0-32767 scale)
const gain = Math.min(4.0, targetRMS / Math.max(rms, 100)); // Max 4x gain

for (let i = 0; i < pcm.length; i++) {
  pcm[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
}
```

#### Fix 8: Smarter WS backpressure (bridge)
Instead of dropping frames when buffered, reduce quality:
```javascript
if (ws.bufferedAmount > MAX_BUFFERED) {
  // Instead of dropping, send every other frame (reduce to 50fps = still intelligible)
  this._skipNext = !this._skipNext;
  if (this._skipNext) return;
}
```

### Phase V3: Advanced (Optional, 1 week+)

#### Fix 9: UDP audio for Electron client
The Electron client connects via TCP only. Adding UDP support would eliminate TCP head-of-line blocking:
- Parse `CryptSetup` message from server (AES-128 key exchange)
- Open UDP socket on same port
- Send/receive Opus frames over encrypted UDP
- Fall back to TCP UDPTunnel if UDP fails (NAT issues)
- Reference: `src/mumble/ServerHandler.cpp` for the original implementation

#### Fix 10: WebRTC for bridge (browser clients)
Replace raw WebSocket binary audio with WebRTC:
- Eliminates TCP HOL blocking for browser users
- Browser-native DTLS/SRTP encryption
- Built-in jitter buffer, PLC, echo cancellation, AGC
- Requires a TURN server for NAT traversal
- Significantly more complex than current approach

---

## Diagnostic Improvements

### Already built (use them!)
The bridge has a diagnostic system (`VOICE_DIAG_ENABLED=true` in `.env`) and `diag-viewer.js` / `real-time-monitor.js`. Turn these on to measure the impact of fixes.

### Add these metrics:
```javascript
// Frame timing jitter (measures setInterval accuracy)
const frameTimes = [];
let lastFlush = Date.now();
// In mixer flush:
const now = Date.now();
frameTimes.push(now - lastFlush);
lastFlush = now;
// Report: stddev of frameTimes (should be <2ms, currently 1-4ms)

// PLC usage counter
plcFramesGenerated: 0

// Jitter buffer depth over time
bufferDepthSamples: [] // track per-sender ring buffer depth

// Round-trip latency (Mumble ping)
// Already parsed in Ping handler — log the RTT
```

### Quick Test Procedure
1. Enable diagnostics: `VOICE_DIAG_ENABLED=true` in `.env`
2. Connect two users (one bridge web, one Electron)
3. Have one speak continuously for 30 seconds
4. Check diagnostic output for:
   - `encErr` / `decErr` (should be 0)
   - `wsErr` (dropped frames — should be 0)
   - `echoSkip` (should match number of your own frames)
   - Frame timing distribution (bridge's real-time-monitor.js)

---

## Implementation Order (Recommended)

```
Day 1: Fix 1 (dry threshold) + Fix 2 (bitrate) + Fix 4 (per-sender mixing in Electron)
        → Test: voice should be noticeably less choppy
Day 2: Fix 3 (PLC) + Fix 5 (gap detection)
        → Test: gaps should sound like brief fades instead of hard clicks
Day 3: Fix 6 (adaptive jitter) + Fix 7 (AGC)
        → Test: consistent volume levels, adapts to network conditions
Later:  Fix 8 (smarter backpressure), Fix 9 (UDP), Fix 10 (WebRTC)
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `mumble-client/src/renderer/voice-processor.js` | Add dry threshold, per-sender ring buffers (port from bridge) |
| `mumble-client/main.js` | Remove accumulator mixer, forward per-sender frames to renderer |
| `mumble-client/src/mumble/voice.js` | Add `setBitrate(48000)`, PLC support, sequence tracking |
| `mumble-bridge/src/voice-bridge.js` | Add `setBitrate(48000)`, PLC support, smarter backpressure |
| `mumble-bridge/public/js/voice-processor.js` | Adaptive jitter buffer |
