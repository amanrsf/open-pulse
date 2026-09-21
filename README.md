# OpenPulse

> **Zero-install, 100% private, client-side Optical Heart Rate (PPG) & HRV Monitor for the web.**  
> Turn any smartphone or webcam into a real-time pulse monitor, or connect Bluetooth (BLE) chest straps directly from your browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Web%20%7C%20PWA-00e676)](https://github.com)
[![Privacy](https://img.shields.io/badge/Privacy-100%25%20In--Memory%20Local-ff3366)](https://github.com)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Vanilla%20JS)-purple)](https://github.com)

https://amanrsf.github.io/open-pulse/

---

## Highlights

- **Zero App Store Installation**: Runs directly in Safari, Chrome, Edge, and Firefox on iOS, Android, and Desktop.
- **100% Local & Private**: Video frames are processed strictly in browser RAM and discarded instantly. **No video, images, or telemetry are ever stored or sent over the network.**
- **Optical Photoplethysmography (PPG)**: Measures volumetric variations of blood circulation using your smartphone's camera and LED flashlight.
- **Heart Rate Variability (HRV)**: Computes real-time **RMSSD** (Root Mean Square of Successive Differences) in milliseconds.
- **Web Bluetooth (BLE) Support**: Directly connect Polar H10, Garmin, CooSpo, and standard Bluetooth Heart Rate monitors (`0x180D`).
- **Interactive Session Timeline**: Live pulse wave oscilloscope, statistical metrics (Min, Max, Avg, Median), and cardiovascular zone distribution.
- **Data Export**: One-click download and clipboard export in **CSV** and **JSON** formats.
- **Offline PWA**: Installable to your home screen with offline service worker support.

---

## 🔬 How Optical PPG Works

Photoplethysmography (PPG) is an optical technique used to detect volumetric blood changes in microvascular bed tissue:

```
    ┌────────────────┐
    │ Camera LED /   │ ──► [Skin Tissue & Capillaries] ──► [Camera Sensor]
    │ Ambient Light  │                 │                          │
    └────────────────┘                 ▼                          ▼
                              Blood Volume Pulses       Red-Channel Luminance
                               (Cardiac Cycles)          Variations Captured
                                                                  │
                                                                  ▼
                                                      ┌───────────────────────┐
                                                      │  Digital DC Highpass  │
                                                      │  & 2-Pole IIR Filter  │
                                                      └───────────┬───────────┘
                                                                  │
                                                                  ▼
                                                      ┌───────────────────────┐
                                                      │   Dynamic Threshold   │
                                                      │  & Peak Peak Lockout  │
                                                      └───────────┬───────────┘
                                                                  │
                                                                  ▼
                                                      ┌───────────────────────┐
                                                      │   BPM & RMSSD HRV     │
                                                      └───────────────────────┘
```

1. **Light Absorption**: Hemoglobin in arterial blood absorbs light more strongly than surrounding tissue. With each cardiac systolic contraction, capillary blood volume surges, altering light absorption.
2. **Luminance Extraction**: Each camera frame is sampled into an in-memory buffer, isolating high-SNR red-channel luminance values.
3. **Filtering**: The DC component (ambient baseline drift) is subtracted, and a 2-pole digital IIR filter removes optical sensor noise while preserving systolic wave morphology.
4. **Adaptive Detection**: Systolic peaks are identified using a dynamic amplitude threshold and an adaptive refractory lockout scaled to current Inter-Beat Intervals (IBI), preventing false positives from dicrotic notches.

---

## 🚀 Getting Started

### Option 1: Direct Web / GitHub Pages
Host on **GitHub Pages**, Cloudflare Pages, Netlify, or Vercel simply by pushing this repository. Zero build step required.

### Option 2: Local Static Server
You can run OpenPulse locally using any standard static file server:

```bash
# Using Python 3
python -m http.server 8080

# Using Node.js (npx)
npx serve .

# Using PHP
php -S localhost:8080
```

Then open `http://localhost:8080` (or `https://localhost:8080`) in your browser.

---

## Mobile Placement Instructions

1. Tap **"Start Optical Pulse Monitor"** and grant camera permissions when prompted.
2. Gently place your **index fingertip over the rear camera lens and flashlight**.
3. Hold your hand steady with light pressure:
   * **Tip**: *Pressing too hard blanches the capillaries and stops blood flow. Pressing too softly lets in ambient light fluctuations. Use gentle, consistent contact.*
4. The signal will calibrate within 3–5 seconds and display your live pulse wave, BPM, and HRV.

---

## Web Bluetooth (BLE) Guide

For precision sports telemetry, connect a standard Bluetooth chest strap (e.g., Polar H10, Wahoo, Garmin):
1. On Chrome/Edge (Desktop or Android), click **"Connect Bluetooth Monitor"**.
2. Select your device from the browser pairing prompt.
3. Live telemetry will stream directly with instant hardware-level accuracy and auto-reconnect fallback.

---

## Export Data Format

### CSV Schema
```csv
timestamp_iso,elapsed_sec,bpm,hrv_rmssd_ms,signal_quality_pct,source
2026-09-20T22:15:00.120Z,0.0,72,42,95,camera_ppg
2026-09-20T22:15:01.340Z,1.2,74,38,98,camera_ppg
```

### JSON Schema
```json
{
  "summary": {
    "startTime": "2026-09-20T22:15:00.120Z",
    "durationSec": 185,
    "minBpm": 62,
    "avgBpm": 74,
    "medianBpm": 73,
    "maxBpm": 98,
    "avgHrv": 44
  },
  "samples": [
    { "t": 0, "bpm": 72, "hrv": 42, "q": 0.95 }
  ]
}
```

---

## Privacy Guarantee

* **Zero Cloud Dependencies**: Operates 100% offline.
* **Transient RAM Execution**: Video frames are analyzed in ephemeral JavaScript variables and released during garbage collection.

---

## Medical Disclaimer

**OpenPulse is designed solely for informational, fitness, educational, and general wellness purposes.** It is not a certified medical device and is not intended for the diagnosis, cure, mitigation, treatment, or prevention of any disease, arrhythmia, or medical condition. Always consult a qualified healthcare professional for clinical health concerns.

---

## License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for details.
