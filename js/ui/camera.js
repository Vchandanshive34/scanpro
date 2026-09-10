/**
 * Camera screen: live viewfinder with continuous document detection.
 *
 * Detection runs on a small copy of the frame in a worker, a few times a
 * second. When the same quad holds still for a moment the shutter arms and,
 * if auto-capture is on, fires by itself — the behaviour people expect from a
 * scanner app, where holding a phone steady over paper is the whole
 * interaction.
 */

import { $, toast } from './dom.js';
import { detectEdges, imageDataFrom } from '../core/pipeline.js';

const DETECT_INTERVAL = 190;      // ms between detection passes
const DETECT_WIDTH = 480;         // frame is downscaled to this for detection
const STABLE_FRAMES = 5;          // consecutive steady detections before arming
const STABLE_TOLERANCE = 0.035;   // fraction of frame size corners may drift

export class CameraController {
  constructor({ onCapture, onClose, onOpenBatch, onModeChange }) {
    this.onCapture = onCapture;
    this.onClose = onClose;
    this.onOpenBatch = onOpenBatch;
    this.onModeChange = onModeChange;

    this.video = $('#camera-video');
    this.overlay = $('#camera-overlay');
    this.hint = $('#camera-hint');
    this.shutter = $('#btn-shutter');

    this.stream = null;
    this.track = null;
    this.running = false;
    this.detecting = false;
    this.timer = null;
    this.raf = null;

    this.corners = null;
    this.displayCorners = null;
    this.confidence = 0;
    this.stableCount = 0;
    this.lastCorners = null;
    this.autoCapture = true;
    this.mode = 'document';
    this.busyCapturing = false;

    this._bind();
  }

  _bind() {
    this.shutter.addEventListener('click', () => this.capture());
    $('#btn-camera-close').addEventListener('click', () => this.onClose && this.onClose());
    $('#btn-batch').addEventListener('click', () => this.onOpenBatch && this.onOpenBatch());
    $('#btn-flash').addEventListener('click', () => this.toggleTorch());

    $('#auto-capture').addEventListener('change', (e) => {
      this.autoCapture = e.target.checked;
      this.stableCount = 0;
    });

    $('#camera-modes').addEventListener('click', (e) => {
      const chip = e.target.closest('.mode-chip');
      if (!chip) return;
      [...$('#camera-modes').children].forEach((c) => c.classList.toggle('active', c === chip));
      this.mode = chip.dataset.mode;
      this.stableCount = 0;
      if (this.onModeChange) this.onModeChange(this.mode);
    });

    $('#btn-import').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length && this.onCapture) this.onCapture({ files });
    });
  }

  async start() {
    if (this.running) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (err) {
      this._showError(err);
      return;
    }

    this.video.srcObject = this.stream;
    this.track = this.stream.getVideoTracks()[0];

    try { await this.video.play(); } catch { /* autoplay attribute covers it */ }

    // Continuous autofocus where the device exposes it.
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch { /* not supported; the default focus is fine */ }

    this.running = true;
    this.autoCapture = $('#auto-capture').checked;
    this.stableCount = 0;
    this._loopDetect();
    this._loopDraw();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.track = null;
    }
    this.video.srcObject = null;
    this.corners = null;
    this.displayCorners = null;
  }

  _showError(err) {
    const name = err && err.name;
    let message = 'Could not open the camera.';

    if (name === 'NotAllowedError') {
      message = 'Camera permission was refused. Allow it in your browser settings, or import a photo instead.';
    } else if (name === 'NotFoundError') {
      message = 'No camera found on this device. You can still import photos.';
    } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      message = 'The camera needs a secure connection (https).';
    }

    this.hint.textContent = message;
    this.hint.classList.add('error');
    toast(message, 'error', 5000);
  }

  async toggleTorch() {
    if (!this.track) return;
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (!caps.torch) { toast('This camera has no torch.'); return; }
      this.torchOn = !this.torchOn;
      await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
    } catch {
      toast('Could not switch the torch.');
    }
  }

  /* ---------------------------- Detection ------------------------------ */

  _loopDetect() {
    if (!this.running) return;

    this.timer = setTimeout(async () => {
      await this._detectOnce();
      this._loopDetect();
    }, DETECT_INTERVAL);
  }

  async _detectOnce() {
    if (this.detecting || this.busyCapturing) return;
    if (!this.video.videoWidth) return;
    if (this.mode === 'lens') return;

    this.detecting = true;
    try {
      const frame = imageDataFrom(this.video, DETECT_WIDTH);
      const result = await detectEdges(frame);

      const sx = this.video.videoWidth / frame.width;
      const sy = this.video.videoHeight / frame.height;

      if (result.corners) {
        const scaled = result.corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
        this._updateStability(scaled, frame.width * sx);
        this.corners = scaled;
        this.confidence = result.confidence;
      } else {
        this.corners = null;
        this.confidence = 0;
        this.stableCount = 0;
        this.lastCorners = null;
      }

      this._updateHint();
    } catch (err) {
      console.warn('Detection pass failed', err);
    } finally {
      this.detecting = false;
    }
  }

  _updateStability(corners, frameWidth) {
    if (!this.lastCorners) {
      this.lastCorners = corners;
      this.stableCount = 1;
      return;
    }

    const tolerance = frameWidth * STABLE_TOLERANCE;
    const steady = corners.every((p, i) =>
      Math.hypot(p.x - this.lastCorners[i].x, p.y - this.lastCorners[i].y) < tolerance);

    this.stableCount = steady ? this.stableCount + 1 : 0;
    this.lastCorners = corners;

    if (steady && this.stableCount >= STABLE_FRAMES && this.confidence > 0.62) {
      this.shutter.classList.add('armed');
      if (this.autoCapture && !this.busyCapturing) this.capture(true);
    } else if (!steady) {
      this.shutter.classList.remove('armed');
    }
  }

  _updateHint() {
    const h = this.hint;
    h.classList.remove('error');

    if (this.mode === 'lens') {
      h.textContent = 'Point at text or a code';
      h.classList.remove('locked');
      return;
    }
    if (!this.corners) {
      h.textContent = 'Point at a document';
      h.classList.remove('locked');
      return;
    }
    if (this.stableCount >= STABLE_FRAMES && this.confidence > 0.62) {
      h.textContent = this.autoCapture ? 'Hold still — capturing' : 'Ready — tap to capture';
      h.classList.add('locked');
      return;
    }
    h.textContent = this.confidence > 0.62 ? 'Hold steady' : 'Move closer / improve light';
    h.classList.remove('locked');
  }

  /* ---------------------------- Overlay -------------------------------- */

  _loopDraw() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this._loopDraw());

    const canvas = this.overlay;
    const rect = this.video.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (!this.corners || !this.video.videoWidth) { this.displayCorners = null; return; }

    // Map video coordinates onto the element, which uses object-fit: cover.
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const offX = (rect.width - vw * scale) / 2;
    const offY = (rect.height - vh * scale) / 2;

    const target = this.corners.map((p) => ({ x: p.x * scale + offX, y: p.y * scale + offY }));

    // Ease toward the new quad so the outline glides instead of snapping.
    if (!this.displayCorners || this.displayCorners.length !== 4) {
      this.displayCorners = target;
    } else {
      this.displayCorners = this.displayCorners.map((p, i) => ({
        x: p.x + (target[i].x - p.x) * 0.35,
        y: p.y + (target[i].y - p.y) * 0.35,
      }));
    }

    const pts = this.displayCorners;
    const locked = this.stableCount >= STABLE_FRAMES && this.confidence > 0.62;
    const stroke = locked ? '#34d399' : '#ff9f43';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();

    ctx.fillStyle = locked ? 'rgba(52,211,153,.16)' : 'rgba(255,159,67,.13)';
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Corner ticks, which read as "locked on" better than plain dots.
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      const prev = pts[(i + 3) % 4];
      const next = pts[(i + 1) % 4];
      for (const other of [prev, next]) {
        const dx = other.x - p.x, dy = other.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const t = Math.min(26, len * 0.28);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (dx / len) * t, p.y + (dy / len) * t);
        ctx.stroke();
      }
    }
  }

  /* ---------------------------- Capture -------------------------------- */

  async capture(automatic = false) {
    if (this.busyCapturing || !this.video.videoWidth) return;
    this.busyCapturing = true;
    this.shutter.classList.remove('armed');

    try {
      // Full-resolution frame — detection ran on a small copy, but the scan
      // itself should keep every pixel the sensor gave us.
      const full = imageDataFrom(this.video, 0);

      // Corners are in video space already, which is what `full` uses.
      const corners = this.corners ? this.corners.map((p) => ({ ...p })) : null;

      if (navigator.vibrate) navigator.vibrate(automatic ? 18 : 12);

      if (this.onCapture) {
        await this.onCapture({ imageData: full, corners, mode: this.mode, automatic });
      }
    } catch (err) {
      console.error(err);
      toast('Capture failed. Try again.', 'error');
    } finally {
      this.stableCount = 0;
      this.lastCorners = null;
      this.busyCapturing = false;
    }
  }

  setBatchCount(n, thumbBlob) {
    const btn = $('#btn-batch');
    const count = $('#batch-count');
    count.textContent = String(n);
    btn.classList.toggle('has-pages', n > 0);

    const old = btn.querySelector('img');
    if (old) old.remove();
    if (thumbBlob) {
      const img = new Image();
      img.src = URL.createObjectURL(thumbBlob);
      img.onload = () => URL.revokeObjectURL(img.src);
      btn.prepend(img);
    }
  }
}
