/**
 * Perspective correction.
 *
 * Given four corners of a document in a photo, produce a flat rectangular
 * image as if the page had been shot straight-on. Works by computing the
 * homography from the *destination* rectangle back to the source quad, then
 * inverse-mapping every output pixel with bilinear sampling — which avoids
 * the holes a forward map would leave.
 */

import { homography, dist } from './geometry.js';

/**
 * Estimate the output size for a warped quad.
 *
 * Uses the longest opposing edges, which is stable and is what most scanner
 * apps do. A full focal-length recovery gives a truer aspect ratio but is
 * numerically fragile on near-frontal shots, where it matters least.
 */
export function estimateOutputSize(corners, maxDim = 2400) {
  const [tl, tr, br, bl] = corners;

  const widthTop = dist(tl, tr);
  const widthBottom = dist(bl, br);
  const heightLeft = dist(tl, bl);
  const heightRight = dist(tr, br);

  let w = Math.round(Math.max(widthTop, widthBottom));
  let h = Math.round(Math.max(heightLeft, heightRight));

  w = Math.max(16, w);
  h = Math.max(16, h);

  const longest = Math.max(w, h);
  if (longest > maxDim) {
    const s = maxDim / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { width: w, height: h };
}

/**
 * Warp the quad defined by `corners` out of `src` into a flat w×h image.
 *
 * @param {Uint8ClampedArray} src   RGBA source pixels
 * @param {number} sw, sh           source dimensions
 * @param {{x,y}[]} corners         TL, TR, BR, BL in source coordinates
 * @param {number} dw, dh           output dimensions
 * @returns {ImageData-like} {data, width, height}
 */
export function warpPerspective(src, sw, sh, corners, dw, dh) {
  const dstPts = [
    { x: 0, y: 0 },
    { x: dw - 1, y: 0 },
    { x: dw - 1, y: dh - 1 },
    { x: 0, y: dh - 1 },
  ];

  // Destination → source, so we can pull pixels.
  const H = homography(dstPts, corners);
  if (!H) throw new Error('Corners are degenerate — cannot compute a homography.');

  const out = new Uint8ClampedArray(dw * dh * 4);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;

  for (let y = 0; y < dh; y++) {
    // Incremental evaluation across the row: one multiply-add per pixel.
    let nx = h1 * y + h2;
    let ny = h4 * y + h5;
    let nw = h7 * y + h8;

    let o = y * dw * 4;
    for (let x = 0; x < dw; x++, o += 4) {
      const iw = nw === 0 ? 0 : 1 / nw;
      const sxf = nx * iw;
      const syf = ny * iw;

      nx += h0; ny += h3; nw += h6;

      if (sxf < 0 || syf < 0 || sxf > sw - 1 || syf > sh - 1) {
        out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
        continue;
      }

      const x0 = sxf | 0, y0 = syf | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = sxf - x0, fy = syf - y0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c++) {
        out[o + c] =
          src[i00 + c] * w00 + src[i10 + c] * w10 +
          src[i01 + c] * w01 + src[i11 + c] * w11;
      }
      out[o + 3] = 255;
    }
  }

  return { data: out, width: dw, height: dh };
}

/** Rotate RGBA pixels by 90/180/270 degrees clockwise. */
export function rotateRGBA(src, w, h, degrees) {
  const deg = ((degrees % 360) + 360) % 360;
  if (deg === 0) return { data: src, width: w, height: h };

  const swap = deg === 90 || deg === 270;
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  const out = new Uint8ClampedArray(dw * dh * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy;
      if (deg === 90) { dx = h - 1 - y; dy = x; }
      else if (deg === 180) { dx = w - 1 - x; dy = h - 1 - y; }
      else { dx = y; dy = w - 1 - x; }

      const si = (y * w + x) * 4;
      const di = (dy * dw + dx) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return { data: out, width: dw, height: dh };
}
