import type { GrayImage } from './image.ts';
import { createGray } from './image.ts';
import { buildIntegral, localMeanStd } from './integral.ts';

/** Classic Otsu split. Returns the threshold in 0..255. */
export function otsuThreshold(data: ArrayLike<number>): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i] | 0]++;
  const total = data.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = v;
    }
  }
  return best;
}

/** 1 where the pixel is DARKER than the Otsu threshold (ink is dark here). */
export function otsuBinary(img: GrayImage): { mask: GrayImage; threshold: number } {
  const t = otsuThreshold(img.data);
  const mask = createGray(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) mask.data[i] = img.data[i] <= t ? 255 : 0;
  return { mask, threshold: t };
}

/**
 * Sauvola adaptive threshold — the standard choice for uneven document
 * lighting. `k` around 0.2-0.35 keeps pale rings while suppressing paper noise.
 * Returns 255 for "ink" (dark) pixels.
 */
export function sauvola(img: GrayImage, radius: number, k = 0.28, R = 128): GrayImage {
  const itg = buildIntegral(img);
  const out = createGray(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const { mean, std } = localMeanStd(itg, x, y, radius);
      const t = mean * (1 + k * (std / R - 1));
      out.data[y * img.width + x] = img.data[y * img.width + x] <= t ? 255 : 0;
    }
  }
  return out;
}

/** Percentile of an array of samples (p in 0..1). Sorts a copy. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export function median(values: number[]): number {
  return percentile(values, 0.5);
}
