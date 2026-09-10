/**
 * Scan enhancement filters.
 *
 * The important one is background estimation: a phone photo of a page has
 * uneven illumination and a shadow from the hand holding the camera. Dividing
 * the image by a heavily blurred estimate of its own background flattens that
 * out, which both looks like a real scan and materially improves OCR accuracy.
 */

const MODES = ['original', 'auto', 'magic', 'gray', 'bw'];
export const FILTER_MODES = MODES;

export const FILTER_LABELS = {
  original: 'Original',
  auto: 'Auto',
  magic: 'Magic Colour',
  gray: 'Greyscale',
  bw: 'B & W',
};

/* ------------------------------------------------------------------ */
/* Integral-image box blur (O(1) per pixel regardless of radius)        */
/* ------------------------------------------------------------------ */

function integralImage(src, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}

function boxBlurFromIntegral(ii, w, h, radius) {
  const out = new Float32Array(w * h);
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        ii[(y1 + 1) * stride + (x1 + 1)] - ii[y0 * stride + (x1 + 1)] -
        ii[(y1 + 1) * stride + x0] + ii[y0 * stride + x0];
      out[y * w + x] = sum / area;
    }
  }
  return out;
}

/**
 * Estimate page background illumination.
 *
 * Text is dark and thin; paper is bright and broad. A local *maximum* filter
 * removes the text, and a wide blur of the result approximates the lighting.
 * Both run on a downscaled copy — the background varies slowly, so full
 * resolution buys nothing but time.
 */
function estimateBackground(gray, w, h) {
  const target = 160;
  const s = Math.min(1, target / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * s));
  const sh = Math.max(8, Math.round(h * s));

  // Downsample by area max — keeps the paper, discards the glyphs.
  const small = new Float32Array(sw * sh);
  const xr = w / sw, yr = h / sh;
  for (let y = 0; y < sh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.min(h, Math.ceil((y + 1) * yr));
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.min(w, Math.ceil((x + 1) * xr));
      let mx = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx++) {
          const v = gray[row + xx];
          if (v > mx) mx = v;
        }
      }
      small[y * sw + x] = mx;
    }
  }

  const blurred = boxBlurFromIntegral(
    integralImage(small, sw, sh), sw, sh, Math.max(2, Math.round(sw * 0.08)));

  // Bilinear upsample back to full size.
  const bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, (y / h) * sh);
    const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, (x / w) * sw);
      const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const v =
        blurred[y0 * sw + x0] * (1 - wx) * (1 - wy) +
        blurred[y0 * sw + x1] * wx * (1 - wy) +
        blurred[y1 * sw + x0] * (1 - wx) * wy +
        blurred[y1 * sw + x1] * wx * wy;
      bg[y * w + x] = Math.max(1, v);
    }
  }
  return bg;
}

function luma(data, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

/** Percentile-based contrast stretch, ignoring outliers. */
function percentiles(gray, loP = 0.02, hiP = 0.985) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
  }
  const total = gray.length;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * loP) { lo = v; break; }
  }
  acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * hiP) { hi = v; break; }
  }
  if (hi - lo < 24) { lo = Math.max(0, lo - 12); hi = Math.min(255, hi + 12); }
  return { lo, hi };
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/** Flatten lighting and stretch contrast, keeping colour. */
function applyAuto(data, w, h, strength = 1) {
  const gray = luma(data, w, h);
  const bg = estimateBackground(gray, w, h);
  const out = new Uint8ClampedArray(data.length);

  const corrected = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    corrected[i] = Math.min(255, (gray[i] / bg[i]) * 235);
  }
  const { lo, hi } = percentiles(corrected);
  const range = Math.max(1, hi - lo);

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const target = Math.max(0, Math.min(255,
      ((Math.min(255, (gray[i] / bg[i]) * 235) - lo) / range) * 255));
    const orig = Math.max(1, gray[i]);
    // Scale each channel by the luma change so hues survive.
    const ratio = 1 + (target / orig - 1) * strength;
    out[p] = data[p] * ratio;
    out[p + 1] = data[p + 1] * ratio;
    out[p + 2] = data[p + 2] * ratio;
    out[p + 3] = 255;
  }
  return out;
}

/** Auto, plus saturation lift and a light unsharp mask. */
function applyMagic(data, w, h) {
  const base = applyAuto(data, w, h, 1);
  const out = new Uint8ClampedArray(base.length);

  const SAT = 1.22;
  for (let p = 0; p < base.length; p += 4) {
    const r = base[p], g = base[p + 1], b = base[p + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    out[p] = l + (r - l) * SAT;
    out[p + 1] = l + (g - l) * SAT;
    out[p + 2] = l + (b - l) * SAT;
    out[p + 3] = 255;
  }
  return unsharp(out, w, h, 0.55);
}

function applyGray(data, w, h) {
  const base = applyAuto(data, w, h, 1);
  const out = new Uint8ClampedArray(base.length);
  for (let p = 0; p < base.length; p += 4) {
    const l = 0.299 * base[p] + 0.587 * base[p + 1] + 0.114 * base[p + 2];
    out[p] = out[p + 1] = out[p + 2] = l;
    out[p + 3] = 255;
  }
  return out;
}

/**
 * Sauvola adaptive threshold — the right choice for documents, because it
 * adapts to local contrast and so survives shadows and yellowed paper where a
 * global threshold would black out half the page.
 */
function applyBW(data, w, h) {
  const gray = luma(data, w, h);

  const sq = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) sq[i] = gray[i] * gray[i];

  const iiMean = integralImage(gray, w, h);
  const iiSq = integralImage(sq, w, h);

  const radius = Math.max(6, Math.round(Math.min(w, h) / 28));
  const stride = w + 1;
  const K = 0.22, R = 128;

  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      const s1 =
        iiMean[(y1 + 1) * stride + (x1 + 1)] - iiMean[y0 * stride + (x1 + 1)] -
        iiMean[(y1 + 1) * stride + x0] + iiMean[y0 * stride + x0];
      const s2 =
        iiSq[(y1 + 1) * stride + (x1 + 1)] - iiSq[y0 * stride + (x1 + 1)] -
        iiSq[(y1 + 1) * stride + x0] + iiSq[y0 * stride + x0];

      const mean = s1 / area;
      const variance = Math.max(0, s2 / area - mean * mean);
      const std = Math.sqrt(variance);
      const threshold = mean * (1 + K * (std / R - 1));

      const i = y * w + x;
      const v = gray[i] > threshold ? 255 : 0;
      const p = i * 4;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

/** Unsharp mask via a 3×3 blur — enough to crisp up text edges. */
function unsharp(data, w, h, amount) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += data[(yy * w + xx) * 4 + c];
            n++;
          }
        }
        const blur = sum / n;
        out[i + c] = data[i + c] + (data[i + c] - blur) * amount;
      }
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Apply a named filter to RGBA pixels.
 * @returns {Uint8ClampedArray} new pixel buffer
 */
export function enhance(data, w, h, mode) {
  switch (mode) {
    case 'auto': return applyAuto(data, w, h, 1);
    case 'magic': return applyMagic(data, w, h);
    case 'gray': return applyGray(data, w, h);
    case 'bw': return applyBW(data, w, h);
    case 'original':
    default: return new Uint8ClampedArray(data);
  }
}

/**
 * Prepare pixels for OCR: greyscale, background-flattened and contrast
 * stretched. Tesseract does its own binarisation, so we hand it clean
 * greyscale rather than a hard threshold — that preserves the thin matras and
 * conjunct strokes that Indic scripts depend on.
 */
export function prepareForOCR(data, w, h) {
  const gray = luma(data, w, h);
  const bg = estimateBackground(gray, w, h);

  const corrected = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    corrected[i] = Math.min(255, (gray[i] / bg[i]) * 235);
  }
  const { lo, hi } = percentiles(corrected, 0.01, 0.99);
  const range = Math.max(1, hi - lo);

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = Math.max(0, Math.min(255, ((corrected[i] - lo) / range) * 255));
    out[p] = out[p + 1] = out[p + 2] = v;
    out[p + 3] = 255;
  }
  return out;
}
