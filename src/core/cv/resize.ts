import type { GrayImage, RgbaImage } from './image.ts';
import { createGray, createRgba } from './image.ts';

/**
 * Area-average downscale.
 *
 * Plain bilinear sampling aliases badly on phone photos and can make a 6px
 * digit disappear entirely; averaging over the source footprint keeps the ring
 * and digit energy that the detector relies on.
 */
export function downscaleRgba(src: RgbaImage, scale: number): RgbaImage {
  if (scale >= 1) return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const out = createRgba(dw, dh);
  const xRatio = src.width / dw;
  const yRatio = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += src.data[idx];
          g += src.data[idx + 1];
          b += src.data[idx + 2];
          a += src.data[idx + 3];
          idx += 4;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

export function downscaleGray(src: GrayImage, scale: number): GrayImage {
  if (scale >= 1) return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const out = createGray(dw, dh);
  const xRatio = src.width / dw;
  const yRatio = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.min(src.height, Math.max(sy0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.min(src.width, Math.max(sx0 + 1, Math.floor((x + 1) * xRatio)));
      let s = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          s += src.data[sy * src.width + sx];
          n++;
        }
      }
      out.data[y * dw + x] = s / n;
    }
  }
  return out;
}

/** Bicubic-ish (Catmull-Rom) upscale — used to enlarge marker crops before OCR. */
export function upscaleGray(src: GrayImage, dw: number, dh: number): GrayImage {
  const out = createGray(dw, dh);
  const xr = src.width / dw;
  const yr = src.height / dh;
  const at = (x: number, y: number) => {
    const xi = x < 0 ? 0 : x >= src.width ? src.width - 1 : x;
    const yi = y < 0 ? 0 : y >= src.height ? src.height - 1 : y;
    return src.data[yi * src.width + xi];
  };
  const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) => {
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    return ((a * t + b) * t + c) * t + p1;
  };
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.floor(sy);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.floor(sx);
      const tx = sx - x0;
      const rows: number[] = [];
      for (let m = -1; m <= 2; m++) {
        rows.push(
          cubic(at(x0 - 1, y0 + m), at(x0, y0 + m), at(x0 + 1, y0 + m), at(x0 + 2, y0 + m), tx),
        );
      }
      out.data[y * dw + x] = cubic(rows[0], rows[1], rows[2], rows[3], ty);
    }
  }
  return out;
}
