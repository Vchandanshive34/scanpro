/**
 * Crop and enhance screen.
 *
 * Shows the captured frame with the detected quad as draggable handles. A
 * magnifier follows the finger while dragging, because on a phone the corner
 * you are adjusting is exactly the part your thumb is covering.
 */

import { $, toast } from './dom.js';
import { warp, applyFilter, canvasToBlob, canvasFromPixels, prepareForOcr } from '../core/pipeline.js';
import { FILTER_MODES, FILTER_LABELS } from '../core/enhance.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLE_R = 13;
const PREVIEW_MAX = 210;

export class EditorController {
  constructor({ onDone, onCancel, onDiscard }) {
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.onDiscard = onDiscard;

    this.stage = $('#crop-stage');
    this.canvas = $('#crop-canvas');
    this.svg = $('#crop-svg');
    this.poly = $('#crop-poly');
    this.loupe = $('#loupe');
    this.loupeCanvas = $('#loupe-canvas');

    this.imageData = null;       // full-resolution source
    this.sourceCanvas = null;
    this.corners = null;         // in source pixel coordinates
    this.fallbackCorners = null;
    this.rotation = 0;
    this.filter = 'auto';
    this.dragIndex = -1;
    this.handles = [];
    this.previewCache = new Map();

    this._bind();
  }

  _bind() {
    $('#btn-editor-back').addEventListener('click', () => this.onCancel && this.onCancel());
    $('#btn-editor-done').addEventListener('click', () => this._finish());

    $('#btn-rotate-left').addEventListener('click', () => {
      this.rotation = (this.rotation + 90) % 360;
      toast(`Rotated ${this.rotation}°`);
    });

    $('#btn-reset-corners').addEventListener('click', () => {
      if (!this.detected) { toast('No edges were detected in this photo.'); return; }
      this.corners = this.detected.map((p) => ({ ...p }));
      this._render();
    });

    $('#btn-select-all').addEventListener('click', () => {
      const { width, height } = this.imageData;
      this.corners = [
        { x: 0, y: 0 }, { x: width, y: 0 },
        { x: width, y: height }, { x: 0, y: height },
      ];
      this._render();
    });

    $('#btn-editor-delete').addEventListener('click', () => this.onDiscard && this.onDiscard());

    this.svg.addEventListener('pointerdown', (e) => this._onDown(e));
    this.svg.addEventListener('pointermove', (e) => this._onMove(e));
    this.svg.addEventListener('pointerup', (e) => this._onUp(e));
    this.svg.addEventListener('pointercancel', (e) => this._onUp(e));

    window.addEventListener('resize', () => { if (this.imageData) this._render(); });
  }

  /**
   * @param {ImageData} imageData full-resolution capture
   * @param {Array|null} corners  detected quad, or null
   * @param {string} defaultFilter
   */
  async load(imageData, corners, defaultFilter = 'auto') {
    this.imageData = imageData;
    this.rotation = 0;
    this.filter = defaultFilter;
    this.previewCache.clear();

    this.sourceCanvas = canvasFromPixels(
      imageData.data.buffer.slice(0), imageData.width, imageData.height);

    const { width, height } = imageData;
    this.detected = corners ? corners.map((p) => ({ ...p })) : null;

    this.corners = corners
      ? corners.map((p) => ({ ...p }))
      : [
          { x: width * 0.06, y: height * 0.06 },
          { x: width * 0.94, y: height * 0.06 },
          { x: width * 0.94, y: height * 0.94 },
          { x: width * 0.06, y: height * 0.94 },
        ];

    $('#editor-title').textContent = corners ? 'Check the edges' : 'Set the edges';
    this._render();
    this._buildFilterStrip();
  }

  /* ---------------------------- Rendering ------------------------------- */

  _layout() {
    const stageRect = this.stage.getBoundingClientRect();
    const { width, height } = this.imageData;
    const scale = Math.min(stageRect.width / width, stageRect.height / height) * 0.94;

    const dw = width * scale;
    const dh = height * scale;

    return {
      scale,
      offX: (stageRect.width - dw) / 2,
      offY: (stageRect.height - dh) / 2,
      dw, dh,
      stageRect,
    };
  }

  _render() {
    const layout = this._layout();
    this.layout = layout;

    // Draw the source into the display canvas at CSS size.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(layout.dw * dpr);
    this.canvas.height = Math.round(layout.dh * dpr);
    this.canvas.style.width = `${layout.dw}px`;
    this.canvas.style.height = `${layout.dh}px`;

    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.sourceCanvas, 0, 0, layout.dw, layout.dh);

    this.svg.setAttribute('viewBox',
      `0 0 ${layout.stageRect.width} ${layout.stageRect.height}`);

    const pts = this.corners.map((p) => this._toScreen(p));
    this.poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));

    // Rebuild handles: 4 corners plus 4 edge midpoints.
    this.svg.querySelectorAll('.crop-handle, .crop-edge-handle').forEach((n) => n.remove());
    this.handles = [];

    pts.forEach((p, i) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'crop-handle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', HANDLE_R);
      this.svg.append(c);
      this.handles.push({ node: c, type: 'corner', index: i, x: p.x, y: p.y });
    });

    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'crop-edge-handle');
      c.setAttribute('cx', mx);
      c.setAttribute('cy', my);
      c.setAttribute('r', HANDLE_R - 4);
      this.svg.append(c);
      this.handles.push({ node: c, type: 'edge', index: i, x: mx, y: my });
    }
  }

  _toScreen(p) {
    const { scale, offX, offY } = this.layout || this._layout();
    return { x: p.x * scale + offX, y: p.y * scale + offY };
  }

  _toSource(x, y) {
    const { scale, offX, offY } = this.layout;
    return {
      x: Math.max(0, Math.min(this.imageData.width, (x - offX) / scale)),
      y: Math.max(0, Math.min(this.imageData.height, (y - offY) / scale)),
    };
  }

  /* ---------------------------- Dragging -------------------------------- */

  _pointer(e) {
    const rect = this.svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onDown(e) {
    const p = this._pointer(e);

    let best = -1, bestDist = 40;
    this.handles.forEach((h, i) => {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < bestDist) { bestDist = d; best = i; }
    });

    if (best === -1) return;

    this.dragIndex = best;
    this.svg.setPointerCapture(e.pointerId);
    this._showLoupe(p);
    e.preventDefault();
  }

  _onMove(e) {
    if (this.dragIndex === -1) return;
    const p = this._pointer(e);
    const handle = this.handles[this.dragIndex];
    const src = this._toSource(p.x, p.y);

    if (handle.type === 'corner') {
      this.corners[handle.index] = src;
    } else {
      // Dragging an edge moves both of its corners along the edge normal.
      const i = handle.index;
      const j = (i + 1) % 4;
      const a = this.corners[i], b = this.corners[j];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dx = src.x - mid.x, dy = src.y - mid.y;

      this.corners[i] = {
        x: Math.max(0, Math.min(this.imageData.width, a.x + dx)),
        y: Math.max(0, Math.min(this.imageData.height, a.y + dy)),
      };
      this.corners[j] = {
        x: Math.max(0, Math.min(this.imageData.width, b.x + dx)),
        y: Math.max(0, Math.min(this.imageData.height, b.y + dy)),
      };
    }

    this._render();
    this._showLoupe(p);
    e.preventDefault();
  }

  _onUp(e) {
    if (this.dragIndex === -1) return;
    this.dragIndex = -1;
    this.loupe.hidden = true;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  _showLoupe(screenPoint) {
    const size = 150;
    const zoom = 2.6;
    const src = this._toSource(screenPoint.x, screenPoint.y);

    const ctx = this.loupeCanvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;

    const half = size / (2 * zoom);
    ctx.drawImage(
      this.sourceCanvas,
      src.x - half, src.y - half, half * 2, half * 2,
      0, 0, size, size);

    // Crosshair marking the exact point under the finger.
    ctx.strokeStyle = '#ff9f43';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size / 2 - 12, size / 2); ctx.lineTo(size / 2 + 12, size / 2);
    ctx.moveTo(size / 2, size / 2 - 12); ctx.lineTo(size / 2, size / 2 + 12);
    ctx.stroke();

    // Keep the loupe away from the finger.
    const stageRect = this.stage.getBoundingClientRect();
    const showLeft = screenPoint.x > stageRect.width / 2;
    this.loupe.style.left = showLeft ? '16px' : `${stageRect.width - size - 16}px`;
    this.loupe.style.top = '16px';
    this.loupe.hidden = false;
  }

  /* ---------------------------- Filters --------------------------------- */

  async _buildFilterStrip() {
    const strip = $('#filter-strip');
    strip.innerHTML = '';

    // Preview from a small warped crop so every chip is a true preview of
    // what the filter will do to *this* page.
    let preview;
    try {
      preview = await warp(this.imageData, this.corners, { maxDim: PREVIEW_MAX, rotation: 0 });
    } catch {
      preview = canvasFromPixels(
        this.imageData.data.buffer.slice(0), this.imageData.width, this.imageData.height);
    }

    for (const mode of FILTER_MODES) {
      const chip = document.createElement('button');
      chip.className = `filter-chip ${mode === this.filter ? 'active' : ''}`;
      chip.dataset.mode = mode;

      const thumb = document.createElement('div');
      thumb.className = 'filter-thumb';
      chip.append(thumb);

      const label = document.createElement('span');
      label.textContent = FILTER_LABELS[mode];
      chip.append(label);

      chip.addEventListener('click', () => {
        this.filter = mode;
        [...strip.children].forEach((c) => c.classList.toggle('active', c === chip));
      });

      strip.append(chip);

      // Render each preview as it becomes available, so the strip fills in
      // rather than blocking on all five.
      applyFilter(preview, mode)
        .then((canvas) => { thumb.innerHTML = ''; thumb.append(canvas); })
        .catch(() => { /* leave the placeholder */ });
    }
  }

  /* ---------------------------- Finish ---------------------------------- */

  async _finish() {
    $('#editor-spinner').hidden = false;
    try {
      const maxDim = this.maxDimension || 2400;
      const flat = await warp(this.imageData, this.corners, {
        maxDim, rotation: this.rotation,
      });

      // Keep a separate greyscale master for OCR, made from the *unfiltered*
      // page. The display filters are tuned to look like a clean scan, and
      // measured against this test set they cost recognition accuracy —
      // "Magic Colour" and B&W both lose words that the flat page keeps.
      const ocrCanvas = await prepareForOcr(flat);
      const ocrBlob = await canvasToBlob(ocrCanvas, 'image/jpeg', 0.85);

      const canvas = this.filter !== 'original'
        ? await applyFilter(flat, this.filter)
        : flat;

      const blob = await canvasToBlob(canvas, 'image/jpeg', this.jpegQuality || 0.86);

      if (this.onDone) {
        await this.onDone({
          canvas, blob, ocrBlob,
          width: canvas.width, height: canvas.height,
          filter: this.filter,
        });
      }
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not process this scan.', 'error');
    } finally {
      $('#editor-spinner').hidden = true;
    }
  }
}
