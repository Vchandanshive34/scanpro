/**
 * Automatic document edge detection.
 *
 * Pipeline: downscale → grayscale → Gaussian blur → Sobel gradients →
 * non-maximum suppression → hysteresis threshold → Hough line transform →
 * pair opposite lines into candidate quadrilaterals → score each quad by how
 * much of its perimeter is backed by real edge pixels.
 *
 * The scoring step is what separates this from a naive "largest contour"
 * approach: a quad is only accepted when its four sides actually lie on
 * detected edges, so patterned tablecloths and window frames do not win.
 */

import {
  lineIntersection, orderCorners, polygonArea, isConvex,
  minInteriorAngle, angleDiff, dist,
} from './geometry.js';

const WORK_SIZE = 480;      // long edge of the detection working image
const HOUGH_THETA_STEPS = 180;
const MAX_LINES = 14;

/* ------------------------------------------------------------------ */
/* Basic image ops                                                     */
/* ------------------------------------------------------------------ */

export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // Rec. 601 luma; good enough and cheap.
    g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return g;
}

/** Box-downscale by an integer-ish factor using area averaging. */
export function downscaleGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.min(sh, Math.ceil((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.min(sw, Math.ceil((x + 1) * xr));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * sw;
        for (let xx = x0; xx < x1; xx++) { sum += src[row + xx]; n++; }
      }
      out[y * dw + x] = n ? sum / n : 0;
    }
  }
  return out;
}

/** Separable Gaussian blur. */
export function gaussianBlur(src, w, h, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const size = radius * 2 + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < size; i++) {
        let xx = x + i - radius;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * k[i];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = 0; i < size; i++) {
        let yy = y + i - radius;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * k[i];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Sobel gradient magnitude and orientation. */
function sobel(src, w, h) {
  const mag = new Float32Array(w * h);
  const dir = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = src[i - w - 1], t = src[i - w], tr = src[i - w + 1];
      const l = src[i - 1], r = src[i + 1];
      const bl = src[i + w - 1], b = src[i + w], br = src[i + w + 1];

      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      mag[i] = Math.hypot(gx, gy);
      dir[i] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

/** Otsu threshold over a float array, used to pick the Canny high threshold. */
function otsu(values, maxVal) {
  const BINS = 64;
  const hist = new Float64Array(BINS);
  const scale = (BINS - 1) / (maxVal || 1);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v <= 0) continue;
    hist[Math.min(BINS - 1, Math.round(v * scale))]++;
    n++;
  }
  if (!n) return 0;

  let sumAll = 0;
  for (let i = 0; i < BINS; i++) sumAll += i * hist[i];

  let wB = 0, sumB = 0, best = 0, bestT = 0;
  for (let t = 0; t < BINS; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT / scale;
}

/** Canny edge map: 1 where an edge is, 0 elsewhere. */
export function canny(gray, w, h) {
  const blurred = gaussianBlur(gray, w, h, 1.4);
  const { mag, dir } = sobel(blurred, w, h);

  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];

  // Non-maximum suppression along the gradient direction.
  const thin = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;

      let a = ((dir[i] * 180) / Math.PI + 180) % 180;
      let n1, n2;
      if (a < 22.5 || a >= 157.5) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
      else if (a < 67.5) { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }
      else if (a < 112.5) { n1 = mag[i - w]; n2 = mag[i + w]; }
      else { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }

      if (m >= n1 && m >= n2) thin[i] = m;
    }
  }

  const high = Math.max(otsu(thin, maxMag), maxMag * 0.08);
  const low = high * 0.4;

  // Hysteresis: seed with strong pixels, grow through weak ones.
  const edges = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] >= high) { edges[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!edges[j] && thin[j] >= low) { edges[j] = 1; stack.push(j); }
      }
    }
  }
  return edges;
}

/* ------------------------------------------------------------------ */
/* Hough transform                                                     */
/* ------------------------------------------------------------------ */

function houghLines(edges, w, h) {
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoOffset = diag;
  const rhoBins = diag * 2 + 1;

  const cos = new Float32Array(HOUGH_THETA_STEPS);
  const sin = new Float32Array(HOUGH_THETA_STEPS);
  for (let t = 0; t < HOUGH_THETA_STEPS; t++) {
    const a = (t * Math.PI) / HOUGH_THETA_STEPS;
    cos[t] = Math.cos(a); sin[t] = Math.sin(a);
  }

  const acc = new Int32Array(HOUGH_THETA_STEPS * rhoBins);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue;
      for (let t = 0; t < HOUGH_THETA_STEPS; t++) {
        const rho = Math.round(x * cos[t] + y * sin[t]) + rhoOffset;
        acc[t * rhoBins + rho]++;
      }
    }
  }

  // Peak picking with suppression so one edge yields one line.
  const minVotes = Math.max(20, Math.round(Math.min(w, h) * 0.22));
  const peaks = [];
  for (let t = 0; t < HOUGH_THETA_STEPS; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      const v = acc[t * rhoBins + r];
      if (v < minVotes) continue;

      let isMax = true;
      for (let dt = -2; dt <= 2 && isMax; dt++) {
        const tt = (t + dt + HOUGH_THETA_STEPS) % HOUGH_THETA_STEPS;
        for (let dr = -6; dr <= 6; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rhoBins) continue;
          if (acc[tt * rhoBins + rr] > v) { isMax = false; break; }
        }
      }
      if (isMax) {
        peaks.push({
          votes: v,
          rho: r - rhoOffset,
          theta: (t * Math.PI) / HOUGH_THETA_STEPS,
        });
      }
    }
  }

  peaks.sort((a, b) => b.votes - a.votes);

  // Drop near-duplicates that survived suppression across the θ wrap.
  const kept = [];
  for (const p of peaks) {
    const dup = kept.some((q) =>
      angleDiff(p.theta, q.theta) < 0.08 && Math.abs(Math.abs(p.rho) - Math.abs(q.rho)) < 12);
    if (!dup) kept.push(p);
    if (kept.length >= MAX_LINES) break;
  }
  return kept;
}

/* ------------------------------------------------------------------ */
/* Quad search                                                         */
/* ------------------------------------------------------------------ */

/** Fraction of a segment that has an edge pixel within `tol` px. */
function edgeSupport(edges, w, h, a, b, tol = 2) {
  const len = dist(a, b);
  const steps = Math.max(8, Math.round(len));
  let hits = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(a.x + (b.x - a.x) * t);
    const py = Math.round(a.y + (b.y - a.y) * t);
    let found = false;
    for (let dy = -tol; dy <= tol && !found; dy++) {
      for (let dx = -tol; dx <= tol; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (edges[ny * w + nx]) { found = true; break; }
      }
    }
    if (found) hits++;
  }
  return hits / (steps + 1);
}

function scoreQuad(quad, edges, w, h) {
  if (!isConvex(quad)) return null;
  if (minInteriorAngle(quad) < 55) return null;

  const area = polygonArea(quad);
  const frameArea = w * h;
  const areaRatio = area / frameArea;
  if (areaRatio < 0.12 || areaRatio > 1.05) return null;

  // Corners may sit slightly outside the frame (document cropped by the
  // viewfinder) but not wildly so.
  const pad = Math.max(w, h) * 0.12;
  for (const p of quad) {
    if (p.x < -pad || p.y < -pad || p.x > w + pad || p.y > h + pad) return null;
  }

  // Opposite sides of a document in perspective stay roughly comparable.
  const s = [
    dist(quad[0], quad[1]), dist(quad[1], quad[2]),
    dist(quad[2], quad[3]), dist(quad[3], quad[0]),
  ];
  if (Math.min(...s) < Math.min(w, h) * 0.15) return null;
  const ratioTB = Math.min(s[0], s[2]) / Math.max(s[0], s[2]);
  const ratioLR = Math.min(s[1], s[3]) / Math.max(s[1], s[3]);
  if (ratioTB < 0.45 || ratioLR < 0.45) return null;

  let support = 0;
  for (let i = 0; i < 4; i++) {
    support += edgeSupport(edges, w, h, quad[i], quad[(i + 1) % 4]);
  }
  support /= 4;
  if (support < 0.5) return null;

  // Favour well-supported edges first, then large area, then squareness.
  const score = support * 100
    + Math.min(areaRatio, 0.97) * 26
    + (ratioTB + ratioLR) * 7;

  return { score, support, areaRatio };
}

function buildQuads(lines, edges, w, h) {
  const results = [];
  const n = lines.length;

  // Pair lines that are near-parallel and well separated: candidate opposite
  // edges of the page.
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (angleDiff(lines[i].theta, lines[j].theta) > 0.22) continue;
      const sep = Math.abs(lines[i].rho - lines[j].rho);
      const altSep = Math.abs(Math.abs(lines[i].rho) - Math.abs(lines[j].rho));
      if (Math.max(sep, altSep) < Math.min(w, h) * 0.2) continue;
      pairs.push({ a: lines[i], b: lines[j], votes: lines[i].votes + lines[j].votes });
    }
  }
  pairs.sort((p, q) => q.votes - p.votes);
  const top = pairs.slice(0, 26);

  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const p = top[i], q = top[j];
      // The two pairs must be roughly perpendicular to bound a page.
      const cross = angleDiff(p.a.theta, q.a.theta);
      if (cross < 0.9) continue; // < ~52°

      const c = [
        lineIntersection(p.a, q.a), lineIntersection(p.a, q.b),
        lineIntersection(p.b, q.b), lineIntersection(p.b, q.a),
      ];
      if (c.some((pt) => !pt || !isFinite(pt.x) || !isFinite(pt.y))) continue;

      const quad = orderCorners(c);
      const scored = scoreQuad(quad, edges, w, h);
      if (scored) results.push({ quad, ...scored });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Detect the document quadrilateral in an RGBA frame.
 *
 * @returns {{corners: {x,y}[], confidence: number, source: string}|null}
 *          Corners are in the coordinate space of the input frame, ordered
 *          top-left, top-right, bottom-right, bottom-left.
 */
export function detectDocument(rgba, width, height) {
  const scale = Math.min(1, WORK_SIZE / Math.max(width, height));
  const w = Math.max(32, Math.round(width * scale));
  const h = Math.max(32, Math.round(height * scale));

  const grayFull = toGray(rgba, width, height);
  const gray = (w === width && h === height)
    ? grayFull
    : downscaleGray(grayFull, width, height, w, h);

  const edges = canny(gray, w, h);
  const lines = houghLines(edges, w, h);
  if (lines.length < 4) return null;

  const quads = buildQuads(lines, edges, w, h);
  if (!quads.length) return null;

  const best = quads[0];
  const inv = 1 / scale;
  const corners = best.quad.map((p) => ({
    x: Math.max(0, Math.min(width, p.x * inv)),
    y: Math.max(0, Math.min(height, p.y * inv)),
  }));

  // Confidence blends perimeter support with how much of the frame is filled.
  const confidence = Math.max(0, Math.min(1,
    best.support * 0.8 + Math.min(best.areaRatio, 0.9) * 0.25));

  return { corners, confidence, source: 'hough' };
}

/** Default corners (a 92% inset) used when nothing is detected. */
export function fallbackCorners(width, height) {
  const mx = width * 0.04, my = height * 0.04;
  return [
    { x: mx, y: my },
    { x: width - mx, y: my },
    { x: width - mx, y: height - my },
    { x: mx, y: height - my },
  ];
}
