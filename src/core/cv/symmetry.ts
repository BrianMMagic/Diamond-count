import type { FloatImage } from './image.ts';
import { createFloat } from './image.ts';
import type { Gradient } from './filters.ts';

/** Separable box blur for float maps (two passes ~= Gaussian). */
export function boxBlurFloat(img: FloatImage, radius: number, passes = 2): FloatImage {
  if (radius < 1) return { ...img, data: new Float32Array(img.data) };
  const { width: w, height: h } = img;
  let src = new Float32Array(img.data);
  let dst = new Float32Array(w * h);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = acc / win;
        const out = Math.min(w - 1, Math.max(0, x - radius));
        const inn = Math.min(w - 1, Math.max(0, x + radius + 1));
        acc += src[row + inn] - src[row + out];
      }
    }
    [src, dst] = [dst, src];
    // Vertical.
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc / win;
        const out = Math.min(h - 1, Math.max(0, y - radius));
        const inn = Math.min(h - 1, Math.max(0, y + radius + 1));
        acc += src[inn * w + x] - src[out * w + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return { width: w, height: h, data: src };
}

export interface SymmetryOptions {
  /** Gradient magnitude below this contributes no vote. */
  gradientThreshold: number;
  /** Radial strictness exponent (Loy & Zelinsky's alpha). 2 is the usual value. */
  alpha: number;
  /**
   * Cap on a single edge pixel's magnitude contribution.
   *
   * Without a cap a black ring on white paper outvotes a cream ring on cream
   * paper by an order of magnitude, and a single response threshold cannot
   * accept both. Clamping makes the transform care about how COMPLETE a ring is
   * rather than how dark it is, which is the property we actually want.
   */
  magnitudeCap?: number;
}

/**
 * Fast Radial Symmetry Transform, "bright centre" variant.
 *
 * Only positively-affected pixels vote, i.e. each edge pixel votes for a point
 * `n` pixels along its gradient (towards the brighter side). Our markers have a
 * light centre inside a darker ring, so the ring's INNER edge points straight at
 * the marker centre and every point around the ring votes for the same spot.
 * Using both signs (the textbook form) would let the ring's outer edge cancel
 * those votes out, which is why this variant is the right one here.
 *
 * Radii are the expected distances from ring-edge to centre, so they should be
 * close to the inner radius of the ring.
 */
export function fastRadialSymmetry(
  grad: Gradient,
  radii: number[],
  opts: SymmetryOptions,
): FloatImage {
  const { width: w, height: h, mag, gx, gy } = grad;
  const n = w * h;
  const total = createFloat(w, h);
  const orient = new Int32Array(n);
  const magnitude = new Float32Array(n);
  const frame = createFloat(w, h);

  for (const radius of radii) {
    orient.fill(0);
    magnitude.fill(0);
    const kn = radius === 1 ? 8 : 9.9;
    const cap = opts.magnitudeCap ?? 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m < opts.gradientThreshold) continue;
        const px = (x + gx[i] * radius + 0.5) | 0;
        const py = (y + gy[i] * radius + 0.5) | 0;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const j = py * w + px;
        orient[j]++;
        magnitude[j] += cap > 0 && m > cap ? cap : m;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = Math.min(orient[i], kn) / kn;
      frame.data[i] = Math.pow(o, opts.alpha) * (magnitude[i] / kn);
    }
    const blurred = boxBlurFloat(frame, Math.max(1, Math.round(radius * 0.35)));
    for (let i = 0; i < n; i++) total.data[i] += blurred.data[i];
  }
  if (radii.length > 1) {
    for (let i = 0; i < n; i++) total.data[i] /= radii.length;
  }
  return total;
}

export interface Peak {
  x: number;
  y: number;
  score: number;
}

/**
 * Non-maximum suppression over a response map.
 *
 * Sorting candidates by score and greedily claiming a disc of `minDistance`
 * around each guarantees one peak per marker, which is the first half of the
 * "never count a marker twice" requirement.
 */
export function findPeaks(
  map: FloatImage,
  minDistance: number,
  threshold: number,
  maxCount = 20000,
): Peak[] {
  const { width: w, height: h, data } = map;
  const r = Math.max(1, Math.round(minDistance));
  const candidates: Peak[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i];
      if (v < threshold) continue;
      // Cheap 8-neighbour maximum test first; the disc test is done later.
      if (
        v < data[i - 1] || v < data[i + 1] || v < data[i - w] || v < data[i + w] ||
        v < data[i - w - 1] || v < data[i - w + 1] || v < data[i + w - 1] || v < data[i + w + 1]
      ) continue;
      candidates.push({ x, y, score: v });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const claimed = new Uint8Array(w * h);
  const peaks: Peak[] = [];
  for (const c of candidates) {
    if (peaks.length >= maxCount) break;
    if (claimed[c.y * w + c.x]) continue;
    peaks.push(c);
    const y0 = Math.max(0, c.y - r);
    const y1 = Math.min(h - 1, c.y + r);
    const x0 = Math.max(0, c.x - r);
    const x1 = Math.min(w - 1, c.x + r);
    for (let y = y0; y <= y1; y++) {
      const dy = y - c.y;
      for (let x = x0; x <= x1; x++) {
        const dx = x - c.x;
        if (dx * dx + dy * dy <= r * r) claimed[y * w + x] = 1;
      }
    }
  }
  return peaks;
}

/** Percentile of a Float32Array without allocating a full sorted copy of huge maps. */
export function floatPercentile(data: Float32Array, p: number, bins = 2048): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  if (max <= 0) return 0;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < data.length; i++) {
    const b = Math.min(bins - 1, ((data[i] / max) * (bins - 1)) | 0);
    hist[b]++;
  }
  const target = data.length * p;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return (b / (bins - 1)) * max;
  }
  return max;
}
