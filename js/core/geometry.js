/**
 * Geometry primitives for document detection and perspective correction.
 * Pure functions, no DOM — safe to import inside a Web Worker.
 */

/** Solve A·x = b for a small dense system using Gaussian elimination with
 *  partial pivoting. `A` is n×n row-major, `b` has length n. */
export function solveLinear(A, b, n) {
  const M = new Float64Array(n * (n + 1));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) M[r * (n + 1) + c] = A[r * n + c];
    M[r * (n + 1) + n] = b[r];
  }

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(M[col * (n + 1) + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * (n + 1) + col]);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < 1e-12) return null; // singular

    if (pivot !== col) {
      for (let c = col; c <= n; c++) {
        const t = M[col * (n + 1) + c];
        M[col * (n + 1) + c] = M[pivot * (n + 1) + c];
        M[pivot * (n + 1) + c] = t;
      }
    }

    const d = M[col * (n + 1) + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * (n + 1) + col] / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r * (n + 1) + c] -= f * M[col * (n + 1) + c];
    }
  }

  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r * (n + 1) + n];
    for (let c = r + 1; c < n; c++) s -= M[r * (n + 1) + c] * x[c];
    x[r] = s / M[r * (n + 1) + r];
  }
  return x;
}

/**
 * Homography mapping four source points to four destination points.
 * Returns a 9-element row-major matrix (h8 fixed at 1).
 */
export function homography(src, dst) {
  const A = new Float64Array(64);
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    const r1 = i * 2, r2 = i * 2 + 1;

    A[r1 * 8 + 0] = x; A[r1 * 8 + 1] = y; A[r1 * 8 + 2] = 1;
    A[r1 * 8 + 6] = -x * u; A[r1 * 8 + 7] = -y * u;
    b[r1] = u;

    A[r2 * 8 + 3] = x; A[r2 * 8 + 4] = y; A[r2 * 8 + 5] = 1;
    A[r2 * 8 + 6] = -x * v; A[r2 * 8 + 7] = -y * v;
    b[r2] = v;
  }

  const h = solveLinear(A, b, 8);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  const iw = w === 0 ? 0 : 1 / w;
  return {
    x: (H[0] * x + H[1] * y + H[2]) * iw,
    y: (H[3] * x + H[4] * y + H[5]) * iw,
  };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Order four unsorted corners as [top-left, top-right, bottom-right,
 * bottom-left] by sorting around the centroid. Robust to rotation up to ~45°.
 */
export function orderCorners(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

  const sorted = pts
    .map((p) => ({ ...p, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((p, q) => p.a - q.a);

  // Rotate so the corner closest to the top-left of the bounding box is first.
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < best) { best = s; start = i; }
  }

  const out = [];
  for (let i = 0; i < 4; i++) out.push(sorted[(start + i) % 4]);
  return out.map(({ x, y }) => ({ x, y }));
}

/** Shoelace area of a polygon. */
export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True when every interior angle turns the same way. */
export function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Smallest interior angle of a quad, in degrees. Rejects slivers. */
export function minInteriorAngle(pts) {
  let min = 180;
  for (let i = 0; i < 4; i++) {
    const prev = pts[(i + 3) % 4];
    const cur = pts[i];
    const next = pts[(i + 1) % 4];
    const v1x = prev.x - cur.x, v1y = prev.y - cur.y;
    const v2x = next.x - cur.x, v2y = next.y - cur.y;
    const n1 = Math.hypot(v1x, v1y) || 1e-9;
    const n2 = Math.hypot(v2x, v2y) || 1e-9;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
    min = Math.min(min, (Math.acos(cos) * 180) / Math.PI);
  }
  return min;
}

/** Intersection of two lines given in normal form (rho, theta). */
export function lineIntersection(l1, l2) {
  const c1 = Math.cos(l1.theta), s1 = Math.sin(l1.theta);
  const c2 = Math.cos(l2.theta), s2 = Math.sin(l2.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-9) return null; // parallel
  return {
    x: (l1.rho * s2 - l2.rho * s1) / det,
    y: (l2.rho * c1 - l1.rho * c2) / det,
  };
}

/** Smallest absolute difference between two angles, in radians (mod π). */
export function angleDiff(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** Expand/contract a quad about its centroid. */
export function scaleQuad(pts, factor) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * factor,
    y: cy + (p.y - cy) * factor,
  }));
}
