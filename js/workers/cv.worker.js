/**
 * Image-processing worker.
 *
 * Everything expensive — edge detection, perspective warping, filters —
 * happens here so the camera preview and UI never stutter. Pixel buffers are
 * transferred rather than copied.
 */

import { detectDocument, fallbackCorners } from '../core/detect.js';
import { warpPerspective, estimateOutputSize, rotateRGBA } from '../core/warp.js';
import { enhance, prepareForOCR } from '../core/enhance.js';

function reply(id, payload, transfer = []) {
  self.postMessage({ id, ok: true, ...payload }, transfer);
}

function fail(id, error) {
  self.postMessage({ id, ok: false, error: String(error && error.message || error) });
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'detect': {
        const { buffer, width, height } = payload;
        const px = new Uint8ClampedArray(buffer);
        const found = detectDocument(px, width, height);
        reply(id, {
          corners: found ? found.corners : null,
          confidence: found ? found.confidence : 0,
          fallback: fallbackCorners(width, height),
        });
        break;
      }

      case 'warp': {
        const { buffer, width, height, corners, maxDim, rotation } = payload;
        const px = new Uint8ClampedArray(buffer);
        const size = estimateOutputSize(corners, maxDim || 2400);
        const warped = warpPerspective(px, width, height, corners, size.width, size.height);
        const rotated = rotateRGBA(warped.data, warped.width, warped.height, rotation || 0);
        reply(id, {
          buffer: rotated.data.buffer,
          width: rotated.width,
          height: rotated.height,
        }, [rotated.data.buffer]);
        break;
      }

      case 'enhance': {
        const { buffer, width, height, mode } = payload;
        const px = new Uint8ClampedArray(buffer);
        const out = enhance(px, width, height, mode);
        reply(id, { buffer: out.buffer, width, height }, [out.buffer]);
        break;
      }

      case 'ocrPrep': {
        const { buffer, width, height } = payload;
        const px = new Uint8ClampedArray(buffer);
        const out = prepareForOCR(px, width, height);
        reply(id, { buffer: out.buffer, width, height }, [out.buffer]);
        break;
      }

      case 'rotate': {
        const { buffer, width, height, degrees } = payload;
        const px = new Uint8ClampedArray(buffer);
        const out = rotateRGBA(px, width, height, degrees);
        reply(id, {
          buffer: out.data.buffer, width: out.width, height: out.height,
        }, [out.data.buffer]);
        break;
      }

      default:
        fail(id, `Unknown worker command: ${type}`);
    }
  } catch (err) {
    fail(id, err);
  }
};
