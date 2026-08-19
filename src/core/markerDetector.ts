import type { MarkerCandidate, RadialProfile } from './types.ts';
import type { PreparedImage } from './imagePreprocessor.ts';
import type { GrayImage } from './cv/image.ts';
import { grayBilinear } from './cv/image.ts';
import { sobel, smooth } from './cv/filters.ts';
import { toGray } from './cv/color.ts';
import { downscaleGray } from './cv/resize.ts';
import { sauvola, median, percentile } from './cv/threshold.ts';
import { connectedComponents, ellipseAxes } from './cv/connected.ts';
import { fastRadialSymmetry, findPeaks, floatPercentile } from './cv/symmetry.ts';

export interface DetectOptions {
  /** 0..1; higher keeps weaker candidates. */
  sensitivity: number;
  /** Marker diameter in ORIGINAL image pixels, or 0 to estimate automatically. */
  expectedMarkerSize: number;
  onProgress?: (fraction: number, detail: string) => void;
}

export interface DetectionOutcome {
  /** Candidates that passed every filter, in WORKING image coordinates. */
  accepted: MarkerCandidate[];
  /** Near-misses kept for the "possible missed marker" tool. */
  nearMisses: MarkerCandidate[];
  /** Estimated ring radius in working pixels. */
  radius: number;
  proposed: number;
  rejected: number;
}

const ANGLE_STEPS = 36;
const RING_SCAN_MIN = 0.6;
const RING_SCAN_MAX = 1.18;
const RING_SCAN_STEP = 0.04;

/**
 * Estimate the dominant marker radius by sweeping the radial-symmetry transform
 * over a range of scales on a small copy of the image.
 *
 * The response of the transform peaks when its radius matches the distance from
 * the ring to the marker centre, so the winning scale tells us how big the
 * markers are without the user measuring anything. Responses are divided by the
 * radius because a bigger circle simply has more edge pixels voting.
 */
export function estimateMarkerRadius(prepared: PreparedImage): { radius: number; scores: Array<{ radius: number; score: number }> } {
  const longest = Math.max(prepared.detection.width, prepared.detection.height);
  const scale = Math.min(1, 900 / longest);
  const small = scale < 1 ? downscaleGray(prepared.detection, scale) : prepared.detection;
  const grad = sobel(smooth(small, 1));
  const gradientThreshold = gradientThresholdFor(grad.mag);

  const scores: Array<{ radius: number; score: number }> = [];
  let best = { radius: 6, score: -Infinity };
  for (const n of [2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17, 20, 24, 28]) {
    if (n * 8 > Math.min(small.width, small.height)) break;
    const map = fastRadialSymmetry(grad, [n], {
      gradientThreshold,
      alpha: 2,
      magnitudeCap: gradientThreshold * 2,
    });
    const peaks = findPeaks(map, Math.max(2, n), floatPercentile(map.data, 0.995), 400);
    if (peaks.length < 4) {
      scores.push({ radius: n / scale, score: 0 });
      continue;
    }
    const top = peaks.slice(0, 200);
    const mean = top.reduce((s, p) => s + p.score, 0) / top.length;
    // Normalise for circumference so large radii do not automatically win.
    const score = mean / n;
    scores.push({ radius: n / scale, score });
    if (score > best.score) best = { radius: n, score };
  }
  // The transform's radius approximates the ring's INNER edge distance; the
  // ring itself sits a little further out.
  const ringRadius = (best.radius / scale) / 0.9;
  return { radius: ringRadius, scores };
}

function gradientThresholdFor(mag: Float32Array): number {
  // Keep a generous share of edges. A high percentile silently discards pale
  // rings (a cream marker on cream paper) because the strong dark rings own the
  // top of the distribution, so the floor does the noise rejection instead.
  const t = floatPercentile(mag, 0.8);
  return Math.max(10, Math.min(t, 45));
}

/**
 * Measure the radial profile of a candidate: light centre, dark ring, and a
 * surround that differs from the ring. This — not the peak strength — is what
 * actually separates markers from printed artwork underneath them.
 */
export function measureProfile(
  gray: GrayImage,
  cx: number,
  cy: number,
  radius: number,
): { profile: RadialProfile; refinedRadius: number; refinedX: number; refinedY: number; score: number } {
  const inner: number[] = [];
  const innerR = radius * 0.5;
  const step = Math.max(1, Math.round(innerR / 6));
  for (let dy = -innerR; dy <= innerR; dy += step) {
    for (let dx = -innerR; dx <= innerR; dx += step) {
      if (dx * dx + dy * dy > innerR * innerR) continue;
      inner.push(grayBilinear(gray, cx + dx, cy + dy));
    }
  }
  const centerBright = percentile(inner, 0.85);
  const centerDark = percentile(inner, 0.12);

  // Threshold for "this angle has a ring": scale with how much contrast the
  // marker itself shows, so pale rings are not written off in bright images.
  const devThreshold = Math.max(9, (centerBright - centerDark) * 0.35, 14);

  const hitRadii: number[] = [];
  const hitPts: Array<[number, number]> = [];
  const ringLevels: number[] = [];
  let hits = 0;
  for (let a = 0; a < ANGLE_STEPS; a++) {
    const th = (a / ANGLE_STEPS) * Math.PI * 2;
    const ca = Math.cos(th);
    const sa = Math.sin(th);
    let bestDev = 0;
    let bestT = 0;
    let bestVal = centerBright;
    for (let t = RING_SCAN_MIN; t <= RING_SCAN_MAX; t += RING_SCAN_STEP) {
      const v = grayBilinear(gray, cx + ca * radius * t, cy + sa * radius * t);
      const dev = Math.abs(v - centerBright);
      if (dev > bestDev) {
        bestDev = dev;
        bestT = t;
        bestVal = v;
      }
    }
    if (bestDev >= devThreshold) {
      hits++;
      hitRadii.push(bestT * radius);
      hitPts.push([ca * bestT * radius, sa * bestT * radius]);
      ringLevels.push(bestVal);
    }
  }
  const ringClosure = hits / ANGLE_STEPS;
  const refinedRadius = hitRadii.length >= 6 ? median(hitRadii) : radius;
  const ringLevel = ringLevels.length ? median(ringLevels) : centerBright;

  // Re-centre on the ring so the crop is well framed even if the peak was off.
  let ox = 0;
  let oy = 0;
  if (hitPts.length >= ANGLE_STEPS * 0.5) {
    for (const [px, py] of hitPts) {
      ox += px;
      oy += py;
    }
    ox /= hitPts.length;
    oy /= hitPts.length;
    // Only trust a modest correction; a large one usually means a bad candidate.
    const maxShift = radius * 0.3;
    const d = Math.hypot(ox, oy);
    if (d > maxShift) {
      ox = (ox / d) * maxShift;
      oy = (oy / d) * maxShift;
    }
  }

  // Ellipse fit over the ring hits gives the aspect ratio, which stays near 1
  // for genuine markers even under mild perspective.
  let aspect = 1;
  let circularity = 0;
  if (hitRadii.length >= 8) {
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const [px, py] of hitPts) {
      const dx = px - ox;
      const dy = py - oy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const n = hitPts.length;
    sxx /= n;
    syy /= n;
    sxy /= n;
    const common = Math.sqrt(Math.max(0, (sxx - syy) ** 2 + 4 * sxy * sxy));
    const major = Math.sqrt(Math.max(1e-9, sxx + syy + common));
    const minor = Math.sqrt(Math.max(1e-9, sxx + syy - common));
    aspect = major / minor;
    const spread = medianAbsDeviation(hitRadii, refinedRadius);
    circularity = Math.max(0, 1 - (spread / Math.max(1, refinedRadius)) * 3);
  }

  const surround = sampleCircle(gray, cx + ox, cy + oy, refinedRadius * 1.45, 24);
  const surroundMean = surround.reduce((s, v) => s + v, 0) / surround.length;

  const profile: RadialProfile = {
    centerBright,
    centerDark,
    ring: ringLevel,
    surround: surroundMean,
    ringClosure,
    circularity,
    aspect,
  };

  const ringContrast = Math.min(1, Math.abs(centerBright - ringLevel) / 70);
  const digitPresence = Math.min(1, (centerBright - centerDark) / 70);
  const ringVsSurround = Math.min(1, Math.abs(ringLevel - surroundMean) / 45);
  const aspectScore = Math.max(0, 1 - (aspect - 1) / 1.1);

  const score =
    0.4 * ringClosure +
    0.18 * ringContrast +
    0.14 * digitPresence +
    0.12 * ringVsSurround +
    0.1 * circularity +
    0.06 * aspectScore;

  return {
    profile,
    refinedRadius,
    refinedX: cx + ox,
    refinedY: cy + oy,
    score: Math.max(0, Math.min(1, score)),
  };
}

function medianAbsDeviation(values: number[], center: number): number {
  return median(values.map((v) => Math.abs(v - center)));
}

function sampleCircle(gray: GrayImage, cx: number, cy: number, r: number, steps: number): number[] {
  const out: number[] = [];
  for (let a = 0; a < steps; a++) {
    const th = (a / steps) * Math.PI * 2;
    out.push(grayBilinear(gray, cx + Math.cos(th) * r, cy + Math.sin(th) * r));
  }
  return out;
}

/** Candidate generator 1: radial symmetry peaks. */
function symmetryCandidates(prepared: PreparedImage, radius: number): Array<{ x: number; y: number; score: number }> {
  const gradientThreshold = gradientThresholdFor(prepared.gradient.mag);
  const radii = [0.78, 0.9, 1.0].map((f) => Math.max(2, Math.round(radius * f)));
  const unique = [...new Set(radii)];
  const map = fastRadialSymmetry(prepared.gradient, unique, {
    gradientThreshold,
    alpha: 2,
    magnitudeCap: gradientThreshold * 2,
  });
  const threshold = floatPercentile(map.data, 0.9);
  return findPeaks(map, Math.max(2, radius * 1.2), threshold, 30000);
}

/**
 * Candidate generator 2: dark connected components that enclose a hole.
 *
 * This catches markers whose ring is strong but whose centre is too small or
 * too textured for the symmetry vote to land cleanly, and it is completely
 * independent of the gradient statistics, so the two generators fail in
 * different ways.
 */
function contourCandidates(prepared: PreparedImage, radius: number): Array<{ x: number; y: number; radius: number }> {
  const mask = sauvola(prepared.detection, Math.max(3, Math.round(radius * 1.4)), 0.22);
  const { components } = connectedComponents(mask, true);
  const out: Array<{ x: number; y: number; radius: number }> = [];
  for (const c of components) {
    if (c.holeCount === 0) continue;
    const w = c.maxX - c.minX + 1;
    const h = c.maxY - c.minY + 1;
    const size = (w + h) / 4;
    if (size < radius * 0.55 || size > radius * 2.1) continue;
    const ar = w / h;
    if (ar < 0.55 || ar > 1.8) continue;
    const bboxArea = w * h;
    if (c.holeArea < bboxArea * 0.05 || c.holeArea > bboxArea * 0.8) continue;
    const axes = ellipseAxes(c);
    if (axes.minor <= 0 || axes.major / axes.minor > 2.2) continue;
    out.push({ x: c.minX + w / 2, y: c.minY + h / 2, radius: size });
  }
  return out;
}

let candidateSeq = 0;

/**
 * Full detection stage: estimate scale, propose candidates from two independent
 * generators, verify each with the radial profile test, then repeat once with
 * the measured radius so the second pass runs at exactly the right scale.
 */
export function detectMarkers(prepared: PreparedImage, opts: DetectOptions): DetectionOutcome {
  const report = opts.onProgress ?? (() => {});
  let radius: number;
  if (opts.expectedMarkerSize > 0) {
    radius = (opts.expectedMarkerSize / 2) * prepared.scale;
  } else {
    report(0.05, 'Estimating marker size');
    radius = estimateMarkerRadius(prepared).radius;
  }
  radius = Math.max(3, Math.min(radius, Math.min(prepared.working.width, prepared.working.height) / 6));

  let pass = runPass(prepared, radius, opts);
  report(0.6, `${pass.accepted.length} markers found`);

  // Second pass at the measured radius, when the estimate was materially off.
  if (pass.accepted.length >= 8) {
    const measured = median(pass.accepted.map((c) => c.radius * prepared.scale));
    if (measured > 1 && Math.abs(measured - radius) / radius > 0.15) {
      report(0.65, 'Re-running detection at the measured marker size');
      const second = runPass(prepared, measured, opts);
      if (second.accepted.length >= pass.accepted.length * 0.9) {
        pass = second;
        radius = measured;
      }
    }
  }
  report(0.95, `${pass.accepted.length} markers found`);
  return { ...pass, radius };
}

function runPass(
  prepared: PreparedImage,
  radius: number,
  opts: DetectOptions,
): Omit<DetectionOutcome, 'radius'> {
  const peaks = symmetryCandidates(prepared, radius);
  const contours = contourCandidates(prepared, radius);
  const proposals: Array<{ x: number; y: number; radius: number; source: MarkerCandidate['source'] }> = [
    ...peaks.map((p) => ({ x: p.x, y: p.y, radius, source: 'radial-symmetry' as const })),
    ...contours.map((c) => ({ x: c.x, y: c.y, radius: c.radius, source: 'contour' as const })),
  ];

  const accepted: MarkerCandidate[] = [];
  const nearMisses: MarkerCandidate[] = [];
  // sensitivity 0 -> 0.62 (strict), 1 -> 0.32 (permissive)
  const acceptScore = 0.62 - 0.3 * clamp01(opts.sensitivity);
  const nearMissScore = acceptScore - 0.1;

  for (const p of proposals) {
    const m = measureProfile(prepared.detection, p.x, p.y, p.radius);
    if (m.refinedRadius < radius * 0.45 || m.refinedRadius > radius * 2.0) continue;
    if (m.profile.aspect > 2.4) continue;
    const inv = 1 / prepared.scale;
    const cand: MarkerCandidate = {
      id: `c${candidateSeq++}`,
      x: m.refinedX * inv,
      y: m.refinedY * inv,
      radius: m.refinedRadius * inv,
      width: m.refinedRadius * 2 * inv,
      height: m.refinedRadius * 2 * inv,
      detectionScore: m.score,
      source: p.source,
      profile: m.profile,
    };
    if (m.score >= acceptScore) accepted.push(cand);
    else if (m.score >= nearMissScore) nearMisses.push(cand);
  }

  return {
    accepted,
    nearMisses,
    proposed: proposals.length,
    rejected: proposals.length - accepted.length,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reject markers whose size is wildly out of step with the rest of the image. */
export function filterBySizeConsistency(markers: MarkerCandidate[]): {
  kept: MarkerCandidate[];
  dropped: MarkerCandidate[];
} {
  if (markers.length < 10) return { kept: markers, dropped: [] };
  const radii = markers.map((m) => m.radius);
  const med = median(radii);
  const mad = median(radii.map((r) => Math.abs(r - med))) || med * 0.1;
  const lo = Math.max(med - 4 * mad, med * 0.55);
  const hi = Math.min(med + 4 * mad, med * 1.75);
  const kept: MarkerCandidate[] = [];
  const dropped: MarkerCandidate[] = [];
  for (const m of markers) (m.radius >= lo && m.radius <= hi ? kept : dropped).push(m);
  return { kept, dropped };
}

/** Exported for the debug page so the scale sweep can be plotted. */
export { gradientThresholdFor, toGray };
