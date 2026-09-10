/**
 * Capture pipeline for the Lens screen.
 *
 * Reading a sign through a viewfinder fails differently from scanning a page
 * on a desk. Measured across the scenes in tools/test/lens — angled, distant,
 * dim, glared, noisy, motion-blurred — the dominant cause of failure by a
 * wide margin is motion blur: a smeared frame scores 42% token recall where
 * the same sign held still scores 100%.
 *
 * So the one thing this does is refuse to read a bad frame. It takes a short
 * burst, scores each frame for focus, and recognises only the sharpest.
 *
 * Things deliberately NOT done here, each because measurement said so rather
 * than intuition (tools/test/lens-ablate.mjs):
 *
 *   perspective rectification   91.7% -> 87.9%   the detected quad clips the
 *                                                outer line of a sign, and
 *                                                warping softens the glyphs
 *   upscaling to 1100px         91.7% -> 90.2%   Tesseract reads native
 *                                                resolution better than an
 *                                                interpolated enlargement
 *   upscaling to 1600px         91.7% -> 85.6%
 *   both together               91.7% -> 84.8%
 *   cropping to the reticle     no change        the recogniser's own layout
 *                                                analysis already ignores
 *                                                unrelated text in frame
 *
 * The illumination flattening in enhance.js is what carries the dim and
 * unevenly lit cases, and it is shared with the scanner.
 */

import { detectDocument } from './detect.js';
import { warpPerspective, estimateOutputSize } from './warp.js';
import { prepareForOCR } from './enhance.js';

const MAX_DIMENSION = 2600;
const MIN_UPSCALE = 1;
const MAX_UPSCALE = 3.2;

/* ------------------------------------------------------------------ */
/* Sharpness                                                           */
/* ------------------------------------------------------------------ */

/**
 * Variance of the Laplacian: the standard cheap focus measure. A blurred
 * frame has little high-frequency energy, so its Laplacian is flat and its
 * variance small.
 */
export function sharpness(canvas) {
  const w = Math.min(canvas.width, 480);
  const scale = w / canvas.width;
  const h = Math.max(1, Math.round(canvas.height * scale));

  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  small.getContext('2d').drawImage(canvas, 0, 0, w, h);

  const { data } = small.getContext('2d').getImageData(0, 0, w, h);

  const grey = new Float32Array(w * h);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    grey[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Choose the crispest frame of a burst. */
export function pickSharpest(frames) {
  let best = frames[0];
  let bestScore = -1;

  for (const frame of frames) {
    const score = sharpness(frame);
    if (score > bestScore) { bestScore = score; best = frame; }
  }
  return { canvas: best, score: bestScore };
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function cropCanvas(canvas, rect) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(canvas.width - x, Math.round(rect.width));
  const h = Math.min(canvas.height - y, Math.round(rect.height));
  if (w <= 0 || h <= 0) return canvas;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

function scaleCanvas(canvas, factor) {
  if (Math.abs(factor - 1) < 0.02) return canvas;

  const w = Math.max(1, Math.round(canvas.width * factor));
  const h = Math.max(1, Math.round(canvas.height * factor));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;

  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

function imageDataOf(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height);
}

function canvasOf(buffer, width, height) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
  return out;
}

/**
 * Find the subject and flatten it.
 *
 * Only accepts a quad that is confident and reasonably central — at a
 * viewfinder's typical framing a spurious quad is worse than none, because it
 * crops away the very text the reader wanted.
 */
function rectify(canvas, minConfidence = 0.55) {
  const data = imageDataOf(canvas);
  const found = detectDocument(data.data, data.width, data.height);
  if (!found || found.confidence < minConfidence) return null;

  const size = estimateOutputSize(found.corners, MAX_DIMENSION);

  // A sliver or a near-frame-sized quad is not a subject worth trusting.
  const area = size.width * size.height;
  const frameArea = canvas.width * canvas.height;
  if (area < frameArea * 0.06) return null;

  const warped = warpPerspective(
    data.data, data.width, data.height, found.corners, size.width, size.height);

  return {
    canvas: canvasOf(warped.data.buffer, warped.width, warped.height),
    confidence: found.confidence,
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Turn one or more raw frames into the image the recogniser should read.
 *
 * @param {HTMLCanvasElement[]} frames  burst, newest last; one is fine
 * @param {Object} options
 *   reticle  {x, y, width, height} in frame pixels, or null for the whole frame
 *   rectify  set false to skip perspective correction
 * @returns {{canvas, sharpness, rectified, scale, source}}
 */
/**
 * Turn one or more raw frames into the image the recogniser should read.
 *
 * @param {HTMLCanvasElement[]} frames  burst, newest last; one is fine
 * @param {Object} options
 *   reticle  {x, y, width, height} to crop to. Off by default: measured no
 *            benefit, and a loosely aimed guide can clip the very text wanted.
 *   rectify  perspective-correct a detected subject. Off by default: measured
 *            a 3.8 point loss.
 *   scaleTo  target height in pixels. Off by default: measured a loss at every
 *            size tried.
 * @returns {{canvas, sharpness, frames, rectified, source}}
 */
export async function captureForLens(frames, options = {}) {
  const {
    reticle = null,
    rectify: allowRectify = false,
    scaleTo = 0,
  } = options;

  const list = [].concat(frames).filter(Boolean);
  if (!list.length) throw new Error('No frame to read.');

  // The whole point: read the crispest frame, not the most recent one.
  const picked = pickSharpest(list);
  let working = picked.canvas;
  let source = list.length > 1 ? 'sharpest of burst' : 'single frame';

  if (reticle) {
    const margin = 0.12;
    working = cropCanvas(working, {
      x: reticle.x - reticle.width * margin,
      y: reticle.y - reticle.height * margin,
      width: reticle.width * (1 + margin * 2),
      height: reticle.height * (1 + margin * 2),
    });
    source += ' + reticle';
  }

  let rectified = false;
  if (allowRectify) {
    const flat = rectify(working);
    if (flat) { working = flat.canvas; rectified = true; source += ' + rectified'; }
  }

  if (scaleTo > 0) {
    let scale = scaleTo / working.height;
    scale = Math.max(MIN_UPSCALE, Math.min(MAX_UPSCALE, scale));
    if (working.height * scale > MAX_DIMENSION) scale = MAX_DIMENSION / working.height;
    working = scaleCanvas(working, scale);
  }

  // Flatten lighting and stretch contrast — shared with the scanner, and what
  // carries the dim and unevenly lit frames.
  const prepped = prepareForOCR(
    imageDataOf(working).data, working.width, working.height);

  return {
    canvas: canvasOf(prepped.buffer, working.width, working.height),
    sharpness: picked.score,
    frames: list.length,
    rectified,
    source,
  };
}

/**
 * Grab a short burst from a video element.
 *
 * Frames are taken a little apart so hand tremor moves between them, giving
 * the sharpness picker something to choose from.
 */
export async function grabBurst(video, { count = 4, gapMs = 70, maxDim = 0 } = {}) {
  const frames = [];

  for (let i = 0; i < count; i++) {
    if (!video.videoWidth) break;

    let w = video.videoWidth;
    let h = video.videoHeight;
    if (maxDim && Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    frames.push(c);

    if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
  }

  return frames;
}


/** Test hook: run individual steps so the benchmark can ablate them. */
export async function __ablate(canvas, { rectify: doRectify, target }) {
  let working = canvas;
  if (doRectify) {
    const flat = rectify(working);
    if (flat) working = flat.canvas;
  }
  if (target > 0) {
    let scale = target / working.height;
    scale = Math.max(1, Math.min(MAX_UPSCALE, scale));
    working = scaleCanvas(working, scale);
  } else if (target < 0) {
    const cap = -target;
    const longest = Math.max(working.width, working.height);
    if (longest > cap) working = scaleCanvas(working, cap / longest);
  }
  const prepped = prepareForOCR(imageDataOf(working).data, working.width, working.height);
  return canvasOf(prepped.buffer, working.width, working.height);
}
