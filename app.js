/**
 * OpenPulse - Standalone Optical Heart Rate (PPG) & HRV Monitor
 * 100% Client-Side • Pure In-Memory Frame Analysis • Zero Cloud Telemetry
 * License: MIT
 */

'use strict';

// ─── AUDIO FEEDBACK SYNTHESIZER ──────────────────────────────────────────────
class AudioFeedback {
    constructor() {
        this.ctx = null;
        this.enabled = false;
    }

    init() {
        if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioCtx();
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    toggle() {
        this.enabled = !this.enabled;
        if (this.enabled) this.init();
        return this.enabled;
    }

    playHeartbeatBeep() {
        if (!this.enabled || !this.ctx) return;
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, this.ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(220, this.ctx.currentTime + 0.08);

            gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start();
            osc.stop(this.ctx.currentTime + 0.09);
        } catch (_) {}
    }
}

// ─── OPTICAL PPG SIGNAL PROCESSING ENGINE ────────────────────────────────────
class PPGEngine {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.isTracking = false;
        this.mediaStream = null;
        this.animFrameId = null;
        this.wakeLock = null;

        // Hidden processing elements
        this.video = document.getElementById('hiddenVideo');
        this.canvas = document.getElementById('procCanvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        // Signal buffers
        this.rawBuffer = [];
        this.filteredBuffer = [];
        this.ibiHistory = [];
        this.BUFFER_SIZE = 180; // ~6 seconds at 30fps

        // Filter state
        this.filterPrevOut = 0;
        this.prevRedAvg = 0;
        this.motionCooldown = 0;
        this.lastPeakTimestamp = 0;
        this.lastDetectedIbi = 800; // ~75 BPM default

        // Metrics
        this.currentBpm = 0;
        this.currentHrv = 0;
        this.currentConfidence = 0;
    }

    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (_) {}
    }

    releaseWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    async start() {
        this.callbacks.onStatusChange('Requesting camera permission...', 'pulsing');

        const getUserMediaFn = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) ||
            navigator.webkitGetUserMedia?.bind(navigator) ||
            navigator.getUserMedia?.bind(navigator);

        if (!getUserMediaFn) {
            throw new Error('Camera API not accessible in this browser context.');
        }

        let stream = null;
        try {
            stream = await getUserMediaFn({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
        } catch (err) {
            console.warn('Environment camera constraint failed; falling back to generic video stream.', err);
            stream = await getUserMediaFn({ video: true, audio: false });
        }

        this.mediaStream = stream;
        this.video.srcObject = this.mediaStream;
        this.video.setAttribute('playsinline', 'true');
        this.video.setAttribute('webkit-playsinline', 'true');
        await this.video.play();

        // Attempt torch activation
        try {
            const track = this.mediaStream.getVideoTracks()[0];
            if (track) {
                const capabilities = track.getCapabilities?.() || {};
                if (capabilities.torch) {
                    await track.applyConstraints({ advanced: [{ torch: true }] });
                }
            }
        } catch (torchErr) {
            console.log('Torch activation notice:', torchErr.message);
        }

        await this.requestWakeLock();

        this.isTracking = true;
        this.rawBuffer.length = 0;
        this.filteredBuffer.length = 0;
        this.ibiHistory.length = 0;
        this.lastPeakTimestamp = 0;
        this.currentBpm = 0;
        this.currentHrv = 0;
        this.currentConfidence = 0;

        this.callbacks.onStatusChange('Cover camera & flash gently', 'pulsing');
        this.processLoop();
    }

    stop() {
        this.isTracking = false;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        this.releaseWakeLock();
        this.currentBpm = 0;
        this.currentHrv = 0;
        this.currentConfidence = 0;

        this.callbacks.onStatusChange('Tracking stopped', '');
        this.callbacks.onTelemetry({ bpm: 0, hrv: 0, confidence: 0, rawWave: 0, isFingerCovering: false });
    }

    processLoop() {
        if (!this.isTracking) return;

        if (this.video.readyState >= 2) {
            // 1. Draw downscaled frame to in-memory 32x32 canvas
            this.ctx.drawImage(this.video, 0, 0, 32, 32);
            const imgData = this.ctx.getImageData(0, 0, 32, 32);
            const data = imgData.data;

            let redSum = 0;
            let greenSum = 0;
            const totalPixels = data.length / 4;

            for (let i = 0; i < data.length; i += 4) {
                redSum += data[i];
                greenSum += data[i + 1];
            }

            const redAvg = redSum / totalPixels;
            const greenAvg = greenSum / totalPixels;

            // Fingertip coverage check (red dominance + brightness threshold)
            const isFingerCovering = redAvg > 55 && (redAvg > greenAvg * 1.18);

            let filteredVal = 0;

            if (isFingerCovering) {
                // Inter-frame motion artifact detection
                const frameDelta = this.prevRedAvg > 0 ? Math.abs(redAvg - this.prevRedAvg) : 0;
                this.prevRedAvg = redAvg;

                if (frameDelta > 13.0) {
                    this.motionCooldown = 12; // ~400ms suppression
                }

                // High-SNR Red PPG buffer
                this.rawBuffer.push(redAvg);
                if (this.rawBuffer.length > this.BUFFER_SIZE) this.rawBuffer.shift();

                // DC Baseline Subtraction (Highpass)
                const localMean = this.rawBuffer.reduce((a, b) => a + b, 0) / this.rawBuffer.length;
                const acSignal = redAvg - localMean;

                // 2-Pole IIR Lowpass Smoothing Filter
                filteredVal = 0.80 * this.filterPrevOut + 0.20 * acSignal;
                this.filterPrevOut = filteredVal;

                this.filteredBuffer.push(filteredVal);
                if (this.filteredBuffer.length > this.BUFFER_SIZE) this.filteredBuffer.shift();

                if (this.motionCooldown > 0) {
                    this.motionCooldown--;
                    this.callbacks.onStatusChange('Hold still... (motion detected)', 'active');
                } else if (this.filteredBuffer.length < 60) {
                    const warmupPct = Math.round((this.filteredBuffer.length / 60) * 100);
                    this.callbacks.onStatusChange(`Calibrating sensor... ${warmupPct}%`, 'active');
                    this.detectPeaks();
                } else {
                    this.callbacks.onStatusChange('Reading optical pulse...', 'active');
                    this.detectPeaks();
                }
            } else {
                this.prevRedAvg = 0;
                this.motionCooldown = 0;
                this.callbacks.onStatusChange('Place fingertip over camera & flash', 'pulsing');
            }

            this.callbacks.onTelemetry({
                bpm: this.currentBpm,
                hrv: this.currentHrv,
                confidence: this.currentConfidence,
                rawWave: filteredVal,
                isFingerCovering: isFingerCovering
            });
        }

        this.animFrameId = requestAnimationFrame(() => this.processLoop());
    }

    detectPeaks() {
        if (this.filteredBuffer.length < 30) return;

        const now = performance.now();
        const len = this.filteredBuffer.length;
        const current = this.filteredBuffer[len - 2];
        const prev = this.filteredBuffer[len - 3];
        const next = this.filteredBuffer[len - 1];

        // Amplitude window
        const windowSlice = this.filteredBuffer.slice(-60);
        let minVal = windowSlice[0];
        let maxVal = windowSlice[0];
        for (let i = 1; i < windowSlice.length; i++) {
            if (windowSlice[i] < minVal) minVal = windowSlice[i];
            if (windowSlice[i] > maxVal) maxVal = windowSlice[i];
        }
        const peakToPeak = maxVal - minVal;

        if (peakToPeak < 0.01) return;

        const threshold = minVal + (peakToPeak * 0.56);

        // Peak inflection check
        if (current > prev && current >= next && current > threshold) {
            // Adaptive refractory lockout based on previous IBI
            const minRefractory = Math.max(280, Math.min(500, this.lastDetectedIbi * 0.50));
            const timeSinceLastPeak = now - this.lastPeakTimestamp;

            if (timeSinceLastPeak >= minRefractory) {
                if (this.lastPeakTimestamp > 0) {
                    const ibi = timeSinceLastPeak;

                    // Plausible physiological interval: 40 to 195 BPM (307ms to 1500ms)
                    if (ibi >= 307 && ibi <= 1500) {
                        this.lastDetectedIbi = ibi;
                        this.ibiHistory.push(ibi);
                        if (this.ibiHistory.length > 7) this.ibiHistory.shift();

                        this.callbacks.onBeatTrigger();

                        if (this.ibiHistory.length >= 3) {
                            const sortedIbis = [...this.ibiHistory].sort((a, b) => a - b);
                            const medianIbi = sortedIbis[Math.floor(sortedIbis.length / 2)];
                            const validIbis = this.ibiHistory.filter(val => Math.abs(val - medianIbi) <= (medianIbi * 0.28));

                            const avgIbi = validIbis.length > 0
                                ? validIbis.reduce((a, b) => a + b, 0) / validIbis.length
                                : medianIbi;

                            const calculatedBpm = Math.round(60000 / avgIbi);

                            if (calculatedBpm >= 40 && calculatedBpm <= 195) {
                                this.currentBpm = this.currentBpm === 0
                                    ? calculatedBpm
                                    : Math.round(this.currentBpm * 0.72 + calculatedBpm * 0.28);

                                // Robust RMSSD HRV Computation with Artifact Filtering
                                if (validIbis.length >= 3) {
                                    let sumSquaredDiffs = 0;
                                    let validDiffCount = 0;
                                    for (let j = 1; j < validIbis.length; j++) {
                                        const diff = validIbis[j] - validIbis[j - 1];
                                        // Reject physiologically impossible single-beat shifts (>250ms) to prevent artifact distortion
                                        if (Math.abs(diff) < 250) {
                                            sumSquaredDiffs += diff * diff;
                                            validDiffCount++;
                                        }
                                    }
                                    if (validDiffCount > 0) {
                                        this.currentHrv = Math.round(Math.sqrt(sumSquaredDiffs / validDiffCount));
                                    }
                                }

                                // Compute genuine Mathematical Signal Quality Index (SQI)
                                // Derived from: IBI Coefficient of Variation (CV) + Peak SNR Amplitude
                                const meanIbi = validIbis.reduce((a, b) => a + b, 0) / validIbis.length;
                                const variance = validIbis.reduce((sum, val) => sum + Math.pow(val - meanIbi, 2), 0) / validIbis.length;
                                const stdDev = Math.sqrt(variance);
                                const cv = stdDev / meanIbi; // Coefficient of Variation (lower is more stable)

                                // Quality score scales from 0.40 to 0.98 based on rhythm consistency and optical amplitude
                                const rhythmStability = Math.max(0.4, Math.min(0.99, 1.0 - (cv * 2.2)));
                                const amplitudeConfidence = Math.min(1.0, peakToPeak / 0.06);
                                this.currentConfidence = Number((rhythmStability * amplitudeConfidence).toFixed(2));
                            }
                        }
                    }
                }
                this.lastPeakTimestamp = now;
            }
        }
    }
}

// ─── WEB BLUETOOTH (BLE) ENGINE ──────────────────────────────────────────────
class WebBluetoothEngine {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.device = null;
        this.characteristic = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
    }

    async connect() {
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge over HTTPS/localhost.');
        }

        this.callbacks.onStatusChange('Scanning for Bluetooth heart rate devices...', 'pulsing');

        this.device = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['heart_rate'] }]
        });

        await this.connectGatt();
        this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    }

    async connectGatt() {
        this.reconnectAttempts = 0;
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService('heart_rate');
        this.characteristic = await service.getCharacteristic('heart_rate_measurement');

        this.characteristic.addEventListener('characteristicvaluechanged', (event) => {
            const val = event.target.value;
            const flags = val.getUint8(0);
            const rate16Bits = flags & 0x01;
            const bpm = rate16Bits ? val.getUint16(1, true) : val.getUint8(1);

            // Optional RR-Intervals extraction if provided by device
            let hrv = 0;
            let offset = rate16Bits ? 3 : 2;
            if (flags & 0x08) offset += 2; // Energy Expended present
            if ((flags & 0x10) && offset + 1 < val.byteLength) {
                const rr = val.getUint16(offset, true) * (1000 / 1024);
                hrv = Math.round(rr);
            }

            this.callbacks.onBeatTrigger();
            this.callbacks.onTelemetry({
                bpm: bpm,
                hrv: hrv,
                confidence: 1.0,
                rawWave: 0,
                isFingerCovering: true
            });
        });

        await this.characteristic.startNotifications();
        this.callbacks.onStatusChange(`Connected: ${this.device.name || 'BLE Monitor'}`, 'active');
    }

    handleDisconnect() {
        if (!this.device) return;

        const maxAttempts = 5;
        if (this.reconnectAttempts >= maxAttempts) {
            this.callbacks.onStatusChange('Bluetooth device disconnected', '');
            this.device = null;
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 16000);
        this.reconnectAttempts++;
        this.callbacks.onStatusChange(`Bluetooth dropped. Reconnecting (${this.reconnectAttempts})...`, 'pulsing');

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connectGatt();
            } catch (_) {
                this.handleDisconnect();
            }
        }, delay);
    }

    disconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.device = null;
        this.characteristic = null;
    }
}

// ─── WAVEFORM OSCILLOSCOPE RENDERER ──────────────────────────────────────────
class WaveformOscilloscope {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.history = new Array(160).fill(0);
    }

    push(val) {
        this.history.shift();
        this.history.push(val);
        this.render();
    }

    render() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.ctx.clearRect(0, 0, width, height);

        const step = width / this.history.length;
        const midY = height / 2;

        let maxAbs = 0.08;
        for (let i = 0; i < this.history.length; i++) {
            const abs = Math.abs(this.history[i]);
            if (abs > maxAbs) maxAbs = abs;
        }
        const scale = (height * 0.42) / maxAbs;

        // Draw center baseline grid
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, midY);
        this.ctx.lineTo(width, midY);
        this.ctx.stroke();

        // Draw waveform line
        this.ctx.strokeStyle = '#00e676';
        this.ctx.shadowColor = '#00e676';
        this.ctx.shadowBlur = 8;
        this.ctx.lineWidth = 2.2;
        this.ctx.beginPath();

        for (let i = 0; i < this.history.length; i++) {
            const x = i * step;
            const y = Math.max(4, Math.min(height - 4, midY - (this.history[i] * scale)));
            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
    }
}

// ─── SESSION TRACKER & TIMELINE ANALYZER ─────────────────────────────────────
class SessionTracker {
    constructor(canvasId, tooltipId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.tooltip = document.getElementById(tooltipId);
        this.history = [];
        this.startTime = null;
        this.isPaused = false;
        this.hoverIdx = -1;
        this.lastSampleTime = 0;

        this.setupInteraction();
    }

    start() {
        if (!this.startTime) {
            this.startTime = Date.now();
        }
    }

    addSample(bpm, hrv, quality = 0.95, source = 'camera_ppg') {
        if (this.isPaused || bpm <= 0) return;

        const now = Date.now();
        if (now - this.lastSampleTime < 1000) return;
        this.lastSampleTime = now;

        if (!this.startTime) this.startTime = now;

        this.history.push({
            time: now,
            elapsedSec: Math.floor((now - this.startTime) / 1000),
            bpm: bpm,
            hrv: hrv || 0,
            quality: Math.round(quality * 100),
            source: source
        });

        if (this.history.length > 3600) this.history.shift();

        this.updateStats();
        this.renderTimeline();
    }

    updateStats() {
        if (this.history.length === 0) {
            document.getElementById('statMinBpm').textContent = '--';
            document.getElementById('statAvgBpm').textContent = '--';
            document.getElementById('statMedianBpm').textContent = '--';
            document.getElementById('statMaxBpm').textContent = '--';
            document.getElementById('statDuration').textContent = '0s';
            return;
        }

        const bpms = this.history.map(s => s.bpm);
        const min = Math.min(...bpms);
        const max = Math.max(...bpms);
        const avg = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);

        const sorted = [...bpms].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

        const durationSec = this.history[this.history.length - 1].elapsedSec;

        document.getElementById('statMinBpm').textContent = `${min}`;
        document.getElementById('statAvgBpm').textContent = `${avg}`;
        document.getElementById('statMedianBpm').textContent = `${median}`;
        document.getElementById('statMaxBpm').textContent = `${max}`;
        document.getElementById('statDuration').textContent = this.formatDuration(durationSec);

        this.updateZones(bpms);
    }

    updateZones(bpms) {
        let restCount = 0;
        let lightCount = 0;
        let aerobicCount = 0;
        let anaerobicCount = 0;
        let peakCount = 0;

        for (const bpm of bpms) {
            if (bpm < 70) restCount++;
            else if (bpm < 100) lightCount++;
            else if (bpm < 130) aerobicCount++;
            else if (bpm < 160) anaerobicCount++;
            else peakCount++;
        }

        const total = bpms.length || 1;
        document.getElementById('zoneRestBar').style.width = `${(restCount / total) * 100}%`;
        document.getElementById('zoneLightBar').style.width = `${(lightCount / total) * 100}%`;
        document.getElementById('zoneAerobicBar').style.width = `${(aerobicCount / total) * 100}%`;
        document.getElementById('zoneAnaerobicBar').style.width = `${(anaerobicCount / total) * 100}%`;
        document.getElementById('zonePeakBar').style.width = `${(peakCount / total) * 100}%`;

        // Dominant zone text
        const counts = [
            { name: 'Resting (<70 BPM)', count: restCount },
            { name: 'Light (70-99 BPM)', count: lightCount },
            { name: 'Aerobic (100-129 BPM)', count: aerobicCount },
            { name: 'Anaerobic (130-159 BPM)', count: anaerobicCount },
            { name: 'Peak (>160 BPM)', count: peakCount }
        ];
        counts.sort((a, b) => b.count - a.count);
        document.getElementById('zoneDominantText').textContent = counts[0].name;
    }

    renderTimeline() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        this.ctx.clearRect(0, 0, width, height);

        if (this.history.length < 2) {
            this.ctx.fillStyle = '#64748b';
            this.ctx.font = '12px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('Recording session timeline in real time...', width / 2, height / 2);
            return;
        }

        const padLeft = 32;
        const padRight = 12;
        const padTop = 16;
        const padBottom = 20;
        const chartW = width - padLeft - padRight;
        const chartH = height - padTop - padBottom;

        const bpms = this.history.map(s => s.bpm);
        const minVal = Math.max(35, Math.min(50, Math.min(...bpms) - 5));
        const maxVal = Math.max(130, Math.max(...bpms) + 10);

        const getY = (bpm) => padTop + chartH - ((bpm - minVal) / (maxVal - minVal)) * chartH;
        const getX = (idx) => padLeft + (idx / (this.history.length - 1)) * chartW;

        // Grid lines
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        this.ctx.lineWidth = 1;
        this.ctx.fillStyle = '#64748b';
        this.ctx.font = '9px sans-serif';
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';

        const step = 20;
        const firstGrid = Math.ceil(minVal / step) * step;
        for (let g = firstGrid; g <= maxVal; g += step) {
            const y = getY(g);
            this.ctx.beginPath();
            this.ctx.moveTo(padLeft, y);
            this.ctx.lineTo(width - padRight, y);
            this.ctx.stroke();
            this.ctx.fillText(g.toString(), padLeft - 4, y);
        }

        // Fill area gradient under curve
        const areaGrad = this.ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
        areaGrad.addColorStop(0, 'rgba(255, 51, 102, 0.35)');
        areaGrad.addColorStop(0.5, 'rgba(168, 85, 247, 0.20)');
        areaGrad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');

        this.ctx.beginPath();
        this.ctx.moveTo(getX(0), getY(this.history[0].bpm));
        for (let i = 1; i < this.history.length; i++) {
            this.ctx.lineTo(getX(i), getY(this.history[i].bpm));
        }
        this.ctx.lineTo(getX(this.history.length - 1), padTop + chartH);
        this.ctx.lineTo(getX(0), padTop + chartH);
        this.ctx.closePath();
        this.ctx.fillStyle = areaGrad;
        this.ctx.fill();

        // Stroke line
        const lineGrad = this.ctx.createLinearGradient(padLeft, 0, width - padRight, 0);
        lineGrad.addColorStop(0, '#38bdf8');
        lineGrad.addColorStop(0.5, '#a855f7');
        lineGrad.addColorStop(1, '#ff3366');

        this.ctx.beginPath();
        this.ctx.strokeStyle = lineGrad;
        this.ctx.lineWidth = 2.2;
        this.ctx.moveTo(getX(0), getY(this.history[0].bpm));
        for (let i = 1; i < this.history.length; i++) {
            this.ctx.lineTo(getX(i), getY(this.history[i].bpm));
        }
        this.ctx.stroke();

        // Latest indicator dot
        const lastIdx = this.history.length - 1;
        const lx = getX(lastIdx);
        const ly = getY(this.history[lastIdx].bpm);
        this.ctx.beginPath();
        this.ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        this.ctx.fillStyle = '#00e676';
        this.ctx.shadowColor = '#00e676';
        this.ctx.shadowBlur = 8;
        this.ctx.fill();
        this.ctx.shadowBlur = 0;

        // Hover cursor
        if (this.hoverIdx >= 0 && this.hoverIdx < this.history.length) {
            const hx = getX(this.hoverIdx);
            const hy = getY(this.history[this.hoverIdx].bpm);

            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            this.ctx.setLineDash([2, 2]);
            this.ctx.beginPath();
            this.ctx.moveTo(hx, padTop);
            this.ctx.lineTo(hx, padTop + chartH);
            this.ctx.stroke();
            this.ctx.setLineDash([]);

            this.ctx.beginPath();
            this.ctx.arc(hx, hy, 5, 0, Math.PI * 2);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fill();
        }

        if (this.isPaused) {
            this.ctx.fillStyle = '#facc15';
            this.ctx.font = 'bold 10px sans-serif';
            this.ctx.textAlign = 'right';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText('⏸ PAUSED', width - padRight - 4, padTop + 2);
        }
    }

    setupInteraction() {
        this.canvas.addEventListener('mousemove', (e) => {
            if (this.history.length < 2) return;
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const padLeft = 32;
            const padRight = 12;
            const chartW = (rect.width || 600) - padLeft - padRight;

            const clampedX = Math.max(0, Math.min(chartW, mouseX - padLeft));
            const idx = Math.round((clampedX / chartW) * (this.history.length - 1));

            this.hoverIdx = idx;
            const pt = this.history[idx];

            if (pt) {
                this.tooltip.innerHTML = `
                    <strong>${pt.bpm} BPM</strong> • HRV: ${pt.hrv ? pt.hrv + 'ms' : '--'}<br/>
                    <span style="opacity: 0.7;">Time: +${this.formatDuration(pt.elapsedSec)}</span>
                `;
                this.tooltip.style.display = 'block';
                const tipW = this.tooltip.offsetWidth;
                let leftPos = mouseX + 12;
                if (leftPos + tipW > rect.width) leftPos = mouseX - tipW - 12;
                this.tooltip.style.left = `${leftPos}px`;
                this.tooltip.style.top = '15px';
            }

            this.renderTimeline();
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.hoverIdx = -1;
            this.tooltip.style.display = 'none';
            this.renderTimeline();
        });
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        this.renderTimeline();
        return this.isPaused;
    }

    clear() {
        this.history = [];
        this.startTime = null;
        this.updateStats();
        this.renderTimeline();
    }

    formatDuration(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (m === 0) return `${s}s`;
        return `${m}m ${s}s`;
    }
}

// ─── DATA EXPORT MANAGER ─────────────────────────────────────────────────────
class ExportManager {
    static generateCsv(sessionHistory) {
        const header = 'timestamp_iso,elapsed_sec,bpm,hrv_rmssd_ms,signal_quality_pct,source';
        const rows = sessionHistory.map(s =>
            `${new Date(s.time).toISOString()},${s.elapsedSec},${s.bpm},${s.hrv || 0},${s.quality},${s.source}`
        );
        return [header, ...rows].join('\n');
    }

    static generateJson(sessionHistory) {
        const bpms = sessionHistory.map(s => s.bpm);
        const min = bpms.length ? Math.min(...bpms) : 0;
        const max = bpms.length ? Math.max(...bpms) : 0;
        const avg = bpms.length ? Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length) : 0;

        const payload = {
            summary: {
                startTime: sessionHistory.length ? new Date(sessionHistory[0].time).toISOString() : null,
                durationSec: sessionHistory.length ? sessionHistory[sessionHistory.length - 1].elapsedSec : 0,
                totalSamples: sessionHistory.length,
                minBpm: min,
                avgBpm: avg,
                maxBpm: max
            },
            samples: sessionHistory.map(s => ({
                t: s.elapsedSec,
                bpm: s.bpm,
                hrv: s.hrv,
                q: s.quality,
                src: s.source
            }))
        };

        return JSON.stringify(payload, null, 2);
    }

    static downloadFile(content, fileName, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// ─── APP CONTROLLER & EVENT WIRING ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const bpmValue = document.getElementById('bpmValue');
    const hrvValue = document.getElementById('hrvValue');
    const qualityValue = document.getElementById('qualityValue');
    const confidenceValue = document.getElementById('confidenceValue');
    const statusText = document.getElementById('statusText');
    const statusDot = document.getElementById('statusDot');
    const statePill = document.getElementById('statePill');
    const stateText = document.getElementById('stateText');
    const headerHeartIcon = document.getElementById('headerHeartIcon');
    const recDot = document.getElementById('recDot');
    const recStatusText = document.getElementById('recStatusText');
    const toastEl = document.getElementById('toastNotification');

    const startPpgBtn = document.getElementById('startPpgBtn');
    const stopPpgBtn = document.getElementById('stopPpgBtn');
    const connectBleBtn = document.getElementById('connectBleBtn');
    const pauseChartBtn = document.getElementById('pauseChartBtn');
    const clearSessionBtn = document.getElementById('clearSessionBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const exportJsonBtn = document.getElementById('exportJsonBtn');
    const copyClipboardBtn = document.getElementById('copyClipboardBtn');
    const audioToggleBtn = document.getElementById('audioToggleBtn');
    const audioIcon = document.getElementById('audioIcon');

    const audio = new AudioFeedback();
    const oscilloscope = new WaveformOscilloscope('oscilloscopeCanvas');
    const session = new SessionTracker('sessionTimelineCanvas', 'chartTooltip');

    function showToast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        setTimeout(() => toastEl.classList.remove('show'), 3500);
    }

    function triggerHeartbeatAnimation() {
        headerHeartIcon.style.transform = 'scale(1.35)';
        setTimeout(() => { headerHeartIcon.style.transform = 'scale(1.0)'; }, 110);
        audio.playHeartbeatBeep();
    }

    function updateStateTier(bpm) {
        if (!bpm || bpm <= 0) {
            statePill.className = 'state-pill';
            stateText.textContent = 'Awaiting Signal';
            return;
        }
        if (bpm < 70) {
            statePill.className = 'state-pill calm';
            stateText.textContent = 'Resting / Calm';
        } else if (bpm < 100) {
            statePill.className = 'state-pill elevated';
            stateText.textContent = 'Light / Elevated';
        } else if (bpm < 130) {
            statePill.className = 'state-pill aerobic';
            stateText.textContent = 'Aerobic / Cardio';
        } else {
            statePill.className = 'state-pill peak';
            stateText.textContent = 'Peak / Intense';
        }
    }

    // Engine Callbacks
    const engineCallbacks = {
        onStatusChange: (text, dotClass) => {
            statusText.textContent = text;
            statusDot.className = `status-dot ${dotClass}`;
        },
        onBeatTrigger: () => {
            triggerHeartbeatAnimation();
        },
        onTelemetry: (data) => {
            if (data.bpm > 0) {
                bpmValue.textContent = data.bpm;
                hrvValue.textContent = data.hrv ? `${data.hrv} ms` : '-- ms';
                qualityValue.textContent = data.isFingerCovering ? 'Good' : 'Low';
                confidenceValue.textContent = `${Math.round(data.confidence * 100)}%`;
                updateStateTier(data.bpm);

                session.start();
                session.addSample(data.bpm, data.hrv, data.confidence);

                recDot.className = 'rec-dot recording';
                recStatusText.textContent = 'RECORDING';
            } else {
                bpmValue.textContent = '--';
                hrvValue.textContent = '-- ms';
                qualityValue.textContent = '--';
                confidenceValue.textContent = '--%';
                updateStateTier(0);
                recDot.className = 'rec-dot';
                recStatusText.textContent = 'IDLE';
            }

            if (data.rawWave !== undefined) {
                oscilloscope.push(data.rawWave);
            }
        }
    };

    const ppgEngine = new PPGEngine(engineCallbacks);
    const bleEngine = new WebBluetoothEngine(engineCallbacks);

    // Audio Toggle
    audioToggleBtn.addEventListener('click', () => {
        const isMuted = !audio.toggle();
        audioIcon.textContent = isMuted ? '🔇' : '🔊';
        showToast(isMuted ? 'Pulse Audio Muted' : 'Pulse Audio Enabled');
    });

    // Start Optical PPG
    startPpgBtn.addEventListener('click', async () => {
        try {
            await ppgEngine.start();
            startPpgBtn.style.display = 'none';
            stopPpgBtn.style.display = 'inline-flex';
            showToast('Camera active. Rest fingertip over camera lens & flash.');
        } catch (err) {
            alert('Camera Error: ' + err.message);
            engineCallbacks.onStatusChange('Camera permission denied or unavailable', '');
        }
    });

    // Stop Optical PPG
    stopPpgBtn.addEventListener('click', () => {
        ppgEngine.stop();
        startPpgBtn.style.display = 'inline-flex';
        stopPpgBtn.style.display = 'none';
        showToast('Camera monitor stopped.');
    });

    // Connect Bluetooth
    connectBleBtn.addEventListener('click', async () => {
        try {
            if (ppgEngine.isTracking) ppgEngine.stop();
            await bleEngine.connect();
            showToast('Connected to Bluetooth Heart Rate Monitor!');
        } catch (err) {
            if (err.name !== 'NotFoundError') {
                showToast('Bluetooth: ' + err.message);
            }
        }
    });

    // Session Controls
    pauseChartBtn.addEventListener('click', () => {
        const isPaused = session.togglePause();
        pauseChartBtn.innerHTML = isPaused
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Resume'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Pause';
        showToast(isPaused ? 'Session timeline paused' : 'Session timeline resumed');
    });

    clearSessionBtn.addEventListener('click', () => {
        session.clear();
        showToast('Session timeline cleared');
    });

    exportCsvBtn.addEventListener('click', () => {
        if (session.history.length === 0) {
            showToast('No session data to export');
            return;
        }
        const csv = ExportManager.generateCsv(session.history);
        ExportManager.downloadFile(csv, `openpulse_session_${Date.now()}.csv`, 'text/csv');
        showToast('CSV export downloaded');
    });

    exportJsonBtn.addEventListener('click', () => {
        if (session.history.length === 0) {
            showToast('No session data to export');
            return;
        }
        const json = ExportManager.generateJson(session.history);
        ExportManager.downloadFile(json, `openpulse_session_${Date.now()}.json`, 'application/json');
        showToast('JSON export downloaded');
    });

    copyClipboardBtn.addEventListener('click', () => {
        if (session.history.length === 0) {
            showToast('No session data to copy');
            return;
        }
        const csv = ExportManager.generateCsv(session.history);
        navigator.clipboard.writeText(csv).then(() => {
            showToast('Session CSV copied to clipboard!');
        }).catch(() => {
            showToast('Failed to write to clipboard');
        });
    });

    // Cleanup on window unload
    window.addEventListener('beforeunload', () => {
        if (ppgEngine.isTracking) ppgEngine.stop();
        bleEngine.disconnect();
    });
});
