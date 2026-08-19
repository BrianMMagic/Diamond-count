import type { GrayImage } from './image.ts';

/**
 * Summed-area tables for a grayscale image.
 *
 * Both the sum and sum-of-squares tables are (w+1) x (h+1) so that a rectangle
 * query never needs bounds checks. Local mean/variance in O(1) per pixel is what
 * makes Sauvola thresholding and the illumination normaliser fast enough to run
 * over a 2000px working copy without blocking the worker for long.
 */
export interface Integral {
  width: number;
  height: number;
  sum: Float64Array;
  sqSum: Float64Array;
}

export function buildIntegral(img: GrayImage): Integral {
  const { width: w, height: h, data } = img;
  const sw = w + 1;
  const sum = new Float64Array(sw * (h + 1));
  const sqSum = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const src = y * w;
    const cur = (y + 1) * sw;
    const prev = y * sw;
    for (let x = 0; x < w; x++) {
      const v = data[src + x];
      rowSum += v;
      rowSq += v * v;
      sum[cur + x + 1] = sum[prev + x + 1] + rowSum;
      sqSum[cur + x + 1] = sqSum[prev + x + 1] + rowSq;
    }
  }
  return { width: w, height: h, sum, sqSum };
}

/** Inclusive rectangle [x0,x1] x [y0,y1], clamped to the image. */
export function rectSum(itg: Integral, x0: number, y0: number, x1: number, y1: number): number {
  const w = itg.width;
  const h = itg.height;
  const sw = w + 1;
  const a = Math.max(0, x0);
  const b = Math.max(0, y0);
  const c = Math.min(w - 1, x1);
  const d = Math.min(h - 1, y1);
  if (c < a || d < b) return 0;
  const s = itg.sum;
  return s[(d + 1) * sw + c + 1] - s[b * sw + c + 1] - s[(d + 1) * sw + a] + s[b * sw + a];
}

export function rectSqSum(itg: Integral, x0: number, y0: number, x1: number, y1: number): number {
  const w = itg.width;
  const h = itg.height;
  const sw = w + 1;
  const a = Math.max(0, x0);
  const b = Math.max(0, y0);
  const c = Math.min(w - 1, x1);
  const d = Math.min(h - 1, y1);
  if (c < a || d < b) return 0;
  const s = itg.sqSum;
  return s[(d + 1) * sw + c + 1] - s[b * sw + c + 1] - s[(d + 1) * sw + a] + s[b * sw + a];
}

export function rectArea(itg: Integral, x0: number, y0: number, x1: number, y1: number): number {
  const a = Math.max(0, x0);
  const b = Math.max(0, y0);
  const c = Math.min(itg.width - 1, x1);
  const d = Math.min(itg.height - 1, y1);
  if (c < a || d < b) return 0;
  return (c - a + 1) * (d - b + 1);
}

export function localMeanStd(
  itg: Integral,
  x: number,
  y: number,
  radius: number,
): { mean: number; std: number } {
  const x0 = x - radius;
  const y0 = y - radius;
  const x1 = x + radius;
  const y1 = y + radius;
  const n = rectArea(itg, x0, y0, x1, y1);
  if (n === 0) return { mean: 0, std: 0 };
  const s = rectSum(itg, x0, y0, x1, y1);
  const sq = rectSqSum(itg, x0, y0, x1, y1);
  const mean = s / n;
  const variance = Math.max(0, sq / n - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}
