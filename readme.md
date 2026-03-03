# Adaptive Audio Limiter — Chrome Extension

A sample-accurate audio limiter for web pages, built on the AudioWorklet API. Processes all page audio in real-time with adaptive spectral-aware recovery.

![Screenshot](screenshot.png)

## Architecture

```
source -> inputAnalyser -> AudioWorkletNode -> destination
           (spectral,       (per-sample: envelope,
            main thread)     lookahead, gain, metering)
```

- **AudioWorkletProcessor** (`limiter-worklet.js`): runs on the audio thread — ring buffer lookahead delay, per-sample envelope follower (instant attack, adaptive hold, exponential decay), hard/soft knee gain reduction, output gain, and stereo level metering.
- **Processor** (`processor.js`): injected into the page (MAIN world) — creates AudioWorkletNode chains, routes media elements and Web Audio contexts through the limiter, runs a rAF spectral analysis loop (FFT centroid, low-energy ratio, RMS) and sends results to the worklet for adaptive hold/recovery.
- **Interceptor** (`interceptor.js`): patches `AudioContext` constructors and `AudioNode.connect` at `document_start` to track all page Web Audio contexts and destination connections.
- **Bridge** (`bridge.js`): content script in ISOLATED world, relays `chrome.runtime` messages to the MAIN world processor via `postMessage`, and exposes the worklet URL via a DOM data attribute.
- **Popup** (`popup.html`, `popup.js`): UI with meters, transfer curve plot, sliders, and normalize output toggle. No processing logic.

## Files

| File | World | Role |
|------|-------|------|
| `webext.js` | MAIN + ISOLATED (content script) | Cross-browser API shim (`ext` alias for `chrome`/`browser`) |
| `interceptor.js` | MAIN (content script) | Patches AudioContext/connect to track page audio graphs |
| `bridge.js` | ISOLATED (content script) | Message relay between extension and page |
| `processor.js` | MAIN (injected) | Creates AudioWorkletNode chains, routes audio, spectral analysis loop |
| `limiter-worklet.js` | AudioWorklet thread | Sample-accurate limiter DSP |
| `popup.html` / `popup.js` | Extension popup | UI, meters, parameter control |
| `manifest.json` | — | Extension manifest (MV3) |

## Installation

1. Clone this repo
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder

## Usage

1. Open a page with audio (YouTube, SoundCloud, any HTML5 player)
2. Click the extension icon
3. Click **Activate**
4. Adjust sliders — changes apply in real-time
5. Close the popup — the limiter keeps running

## Parameters

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| **Saturation Level** | -30 to 0 dB | -8 dB | Threshold where limiting begins |
| **Knee** | 0 to 6 dB | 6 dB | Soft knee width (0 = hard knee) |
| **Output Gain** | 0 to +30 dB | +8 dB | Makeup gain after limiting |
| **Lookahead** | 0 to 20 ms | 1.5 ms | Ring buffer delay for transient anticipation |
| **Min Recovery** | 1 to 1000 ms | 150 ms | Base envelope decay time (extended by spectral analysis) |
| **Normalize Output** | on/off | on | Locks output gain to |saturation level| |

## How It Works

- The envelope follower uses instant attack with adaptive hold (minimum = lookahead time) to prevent overshooting.
- Hold and recovery times are modulated by spectral content: low frequencies and dense peaks extend hold; high-frequency transients allow faster recovery.
- The worklet posts stereo peak levels to the main thread at ~60fps for the popup meters.
- Worklet loading uses a two-strategy approach (direct extension URL, then blob URL fallback) to handle pages with strict CSP.
- Web Audio API contexts are intercepted and rerouted through the limiter chain; media elements use `createMediaElementSource` with a source node cache for clean deactivate/reactivate cycles.
- Slider settings are persisted to `chrome.storage.local` and restored when the popup reopens.

## Supported Sites

Works on any page with `<audio>`/`<video>` elements or Web Audio API usage, including pages with iframes (`all_frames: true`).
DRM-protected content (Netflix, Disney+) cannot be processed.

## Privacy

- All processing is local — no audio is recorded or transmitted
- No data collection
- Slider settings are stored locally to restore your preferred parameters between sessions

## License

Free to use and modify.
