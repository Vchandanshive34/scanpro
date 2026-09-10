/**
 * Client side of the image worker, plus the canvas plumbing that turns camera
 * frames and picked files into processed scans.
 */

const WORKER_URL = new URL('../workers/cv.worker.js', import.meta.url);

class WorkerClient {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }

  _ensure() {
    if (this.worker) return this.worker;
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (e) => {
      const { id, ok, error, ...rest } = e.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      ok ? entry.resolve(rest) : entry.reject(new Error(error));
    };
    this.worker.onerror = (e) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(e.message || 'Image worker failed'));
      }
      this.pending.clear();
    };
    return this.worker;
  }

  call(type, payload, transfer = []) {
    const worker = this._ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload }, transfer);
    });
  }
}

const client = new WorkerClient();

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

export function imageDataFrom(source, maxDim = 0) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;

  let w = sw, h = sh;
  if (maxDim && Math.max(sw, sh) > maxDim) {
    const s = maxDim / Math.max(sw, sh);
    w = Math.round(sw * s);
    h = Math.round(sh * s);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export function canvasFromPixels(buffer, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.86) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.src = url;
    });
    // Keep the object URL alive until the caller has drawn the image.
    img._revoke = () => URL.revokeObjectURL(url);
    return img;
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

export async function makeThumbnail(canvas, size = 320) {
  const scale = size / Math.max(canvas.width, canvas.height);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  const thumb = document.createElement('canvas');
  thumb.width = w;
  thumb.height = h;
  thumb.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return canvasToBlob(thumb, 'image/jpeg', 0.72);
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

/** Find the page in a frame. Returns corners in frame coordinates. */
export async function detectEdges(imageData) {
  const copy = imageData.data.slice();
  const res = await client.call('detect', {
    buffer: copy.buffer,
    width: imageData.width,
    height: imageData.height,
  }, [copy.buffer]);
  return res;
}

/** Flatten the quad into a rectangular page. */
export async function warp(imageData, corners, { maxDim = 2400, rotation = 0 } = {}) {
  const copy = imageData.data.slice();
  const res = await client.call('warp', {
    buffer: copy.buffer,
    width: imageData.width,
    height: imageData.height,
    corners, maxDim, rotation,
  }, [copy.buffer]);
  return canvasFromPixels(res.buffer, res.width, res.height);
}

/** Apply a named enhancement filter to a canvas. */
export async function applyFilter(canvas, mode) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const copy = data.data.slice();

  const res = await client.call('enhance', {
    buffer: copy.buffer,
    width: canvas.width,
    height: canvas.height,
    mode,
  }, [copy.buffer]);

  return canvasFromPixels(res.buffer, res.width, res.height);
}

/** Greyscale + illumination-flattened copy that OCR reads best. */
export async function prepareForOcr(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const copy = data.data.slice();

  const res = await client.call('ocrPrep', {
    buffer: copy.buffer,
    width: canvas.width,
    height: canvas.height,
  }, [copy.buffer]);

  return canvasFromPixels(res.buffer, res.width, res.height);
}

export async function rotate(canvas, degrees) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const copy = data.data.slice();

  const res = await client.call('rotate', {
    buffer: copy.buffer,
    width: canvas.width,
    height: canvas.height,
    degrees,
  }, [copy.buffer]);

  return canvasFromPixels(res.buffer, res.width, res.height);
}
