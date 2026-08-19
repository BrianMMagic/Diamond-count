import type { FloatImage, GrayImage } from './image.ts';
import { createFloat, createGray } from './image.ts';
import { buildIntegral, localMeanStd, rectArea, rectSum } from './integral.ts';

/** Box blur via a summed-area table: O(1) per pixel regardless of radius. */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  if (radius < 1) return { ...img, data: new Uint8ClampedArray(img.data) };
  const itg = buildIntegral(img);
  const out = createGray(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const n = rectArea(itg, x - radius, y - radius, x + radius, y + radius);
      out.data[y * img.width + x] = rectSum(itg, x - radius, y - radius, x + radius, y + radius) / n;
    }
  }
  return out;
}

/** Two box passes approximate a Gaussian closely enough for our purposes. */
export function smooth(img: GrayImage, radius: number): GrayImage {
  return boxBlur(boxBlur(img, radius), radius);
}

/**
 * Flatten uneven lighting.
 *
 * Subtracting a heavily blurred copy removes the low-frequency component that
 * shadows, warm lamps and vignetting introduce, while leaving the marker rings
 * (a high-frequency feature) untouched. `strength` blends between the original
 * and the fully flattened version.
 */
export function normalizeIllumination(img: GrayImage, radius: number, strength = 1): GrayImage {
  const bg = smooth(img, radius);
  const out = createGray(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    const flat = img.data[i] - bg.data[i] + 128;
    out.data[i] = img.data[i] * (1 - strength) + flat * strength;
  }
  return out;
}

/**
 * Stretch contrast so that `clipPercent` of pixels saturate at each end.
 * Handles dim, bright and flat photos without touching well-exposed ones much.
 */
export function autoContrast(img: GrayImage, clipPercent = 0.5): GrayImage {
  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) hist[img.data[i]]++;
  const total = img.data.length;
  const clip = (total * clipPercent) / 100;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > clip) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > clip) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 16) return { ...img, data: new Uint8ClampedArray(img.data) };
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  const out = createGray(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = lut[img.data[i]];
  return out;
}

/** Unsharp mask — recovers a little detail from mildly blurred phone photos. */
export function unsharp(img: GrayImage, radius = 1, amount = 0.8): GrayImage {
  const blurred = smooth(img, radius);
  const out = createGray(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    out.data[i] = img.data[i] + amount * (img.data[i] - blurred.data[i]);
  }
  return out;
}

export interface Gradient {
  width: number;
  height: number;
  /** Magnitude, unnormalised (Sobel scale). */
  mag: Float32Array;
  /** Unit gradient direction. */
  gx: Float32Array;
  gy: Float32Array;
}

/** 3x3 Sobel. Border pixels get zero gradient, which keeps the loops branch-free. */
export function sobel(img: GrayImage): Gradient {
  const { width: w, height: h, data } = img;
  const mag = new Float32Array(w * h);
  const gxs = new Float32Array(w * h);
  const gys = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = data[i - w - 1];
      const t = data[i - w];
      const tr = data[i - w + 1];
      const l = data[i - 1];
      const r = data[i + 1];
      const bl = data[i + w - 1];
      const b = data[i + w];
      const br = data[i + w + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > 1e-3) {
        gxs[i] = gx / m;
        gys[i] = gy / m;
      }
    }
  }
  return { width: w, height: h, mag, gx: gxs, gy: gys };
}

/** Local contrast map: standard deviation in a window, used to reject flat areas. */
export function localContrast(img: GrayImage, radius: number): FloatImage {
  const itg = buildIntegral(img);
  const out = createFloat(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      out.data[y * img.width + x] = localMeanStd(itg, x, y, radius).std;
    }
  }
  return out;
}
