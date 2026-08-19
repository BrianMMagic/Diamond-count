import type { RgbaImage } from './cv/image.ts';
import { clampInt } from './cv/image.ts';
import { deltaE94, labToRgb, rgbToHsv, rgbToLab } from './cv/color.ts';
import { median } from './cv/threshold.ts';
import type { ColorModel, ColorModelEntry, MarkerDetection, RingColor } from './types.ts';

const ANGLES = 48;
const SCAN_MIN = 0.62;
const SCAN_MAX = 1.18;
const SCAN_STEP = 0.03;

function rgbaBilinear(img: RgbaImage, x: number, y: number): [number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const px = (xi: number, yi: number, c: number) =>
    img.data[(clampInt(yi, 0, img.height - 1) * img.width + clampInt(xi, 0, img.width - 1)) * 4 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      px(x0, y0, c) * (1 - fx) * (1 - fy) +
      px(x0 + 1, y0, c) * fx * (1 - fy) +
      px(x0, y0 + 1, c) * (1 - fx) * fy +
      px(x0 + 1, y0 + 1, c) * fx * fy;
  }
  return out;
}

function luma(rgb: [number, number, number]): number {
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
}

/**
 * Sample the marker's coloured ring.
 *
 * Rather than averaging a fixed annulus — which mixes in the white centre when
 * the radius is slightly off and the artwork underneath when it is slightly
 * long — this walks outwards along 48 spokes and locks onto the point where the
 * ring actually is, then takes the median across all spokes. Median, not mean,
 * because a single spoke crossing the printed digit or a glare highlight would
 * otherwise drag the whole reading.
 */
export function sampleRingColor(original: RgbaImage, x: number, y: number, radius: number): RingColor {
  // Reference brightness of the marker's light centre.
  const centerSamples: number[] = [];
  const innerR = radius * 0.35;
  const step = Math.max(1, innerR / 4);
  for (let dy = -innerR; dy <= innerR; dy += step) {
    for (let dx = -innerR; dx <= innerR; dx += step) {
      if (dx * dx + dy * dy > innerR * innerR) continue;
      centerSamples.push(luma(rgbaBilinear(original, x + dx, y + dy)));
    }
  }
  centerSamples.sort((a, b) => a - b);
  const centerLevel = centerSamples.length
    ? centerSamples[Math.floor(centerSamples.length * 0.8)]
    : 200;

  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const labs: Array<[number, number, number]> = [];

  for (let a = 0; a < ANGLES; a++) {
    const th = (a / ANGLES) * Math.PI * 2;
    const ca = Math.cos(th);
    const sa = Math.sin(th);
    let bestDev = -1;
    let bestT = 0;
    for (let t = SCAN_MIN; t <= SCAN_MAX; t += SCAN_STEP) {
      const dev = Math.abs(luma(rgbaBilinear(original, x + ca * radius * t, y + sa * radius * t)) - centerLevel);
      if (dev > bestDev) {
        bestDev = dev;
        bestT = t;
      }
    }
    // Three samples straddling the ring's centre line thicken the sample set
    // without risking the neighbouring white or the artwork behind the marker.
    for (const dt of [-0.035, 0, 0.035]) {
      const t = bestT + dt;
      if (t < SCAN_MIN || t > SCAN_MAX) continue;
      const rgb = rgbaBilinear(original, x + ca * radius * t, y + sa * radius * t);
      rs.push(rgb[0]);
      gs.push(rgb[1]);
      bs.push(rgb[2]);
      labs.push(rgbToLab(rgb[0], rgb[1], rgb[2]));
    }
  }

  const r = median(rs);
  const g = median(gs);
  const b = median(bs);
  const lab = rgbToLab(r, g, b);
  const [h, s, v] = rgbToHsv(r, g, b);
  const spread = labs.length ? median(labs.map((l) => deltaE94(l, lab))) : 0;
  return { r, g, b, h, s, v, lab, spread, samples: labs.length };
}

export function analyzeColors(original: RgbaImage, markers: MarkerDetection[]): void {
  for (const m of markers) {
    m.ringColor = sampleRingColor(original, m.x, m.y, m.radius);
  }
}

export interface LearnOptions {
  /** OCR confidence a marker must reach before it may teach a colour. */
  minConfidence: number;
  /** Minimum samples before a number's colour is trusted. */
  minSamples: number;
}

export const DEFAULT_LEARN: LearnOptions = { minConfidence: 0.8, minSamples: 4 };

/**
 * Learn "number -> ring colour" from THIS image.
 *
 * Nothing is hard-coded: a kit where 3 is orange and one where 3 is teal both
 * work, because the mapping is rebuilt from the markers the OCR was surest
 * about. Outliers are trimmed before the centroid is taken so that a handful of
 * misread markers cannot poison a colour that hundreds of others agree on.
 */
export function learnColorModel(
  markers: MarkerDetection[],
  opts: LearnOptions = DEFAULT_LEARN,
): ColorModel {
  const groups = new Map<number, Array<[number, number, number]>>();
  for (const m of markers) {
    if (!m.ringColor || m.ocrPrediction == null) continue;
    if ((m.ocrConfidence ?? 0) < opts.minConfidence) continue;
    if (m.ringColor.spread > 26) continue; // noisy sample, do not teach from it
    const list = groups.get(m.ocrPrediction) ?? [];
    list.push(m.ringColor.lab);
    groups.set(m.ocrPrediction, list);
  }

  const entries: ColorModelEntry[] = [];
  for (const [number, labs] of groups) {
    if (labs.length < opts.minSamples) continue;
    let centroid = medianLab(labs);
    // One trimming round: drop the worst 20% and recompute.
    const dists = labs.map((l) => deltaE94(l, centroid));
    const cutoff = [...dists].sort((a, b) => a - b)[Math.floor(labs.length * 0.8)] ?? Infinity;
    const trimmed = labs.filter((_, i) => dists[i] <= cutoff);
    if (trimmed.length >= opts.minSamples) centroid = medianLab(trimmed);
    const spread = median(trimmed.map((l) => deltaE94(l, centroid)));
    entries.push({
      number,
      lab: centroid,
      rgb: labToRgb(centroid),
      spread: Math.max(1.5, spread),
      samples: labs.length,
    });
  }
  entries.sort((a, b) => a.number - b.number);

  let minSeparation = Infinity;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      minSeparation = Math.min(minSeparation, deltaE94(entries[i].lab, entries[j].lab));
    }
  }
  return {
    entries,
    minSeparation: entries.length > 1 ? minSeparation : Infinity,
    trained: entries.length > 0,
  };
}

function medianLab(labs: Array<[number, number, number]>): [number, number, number] {
  return [
    median(labs.map((l) => l[0])),
    median(labs.map((l) => l[1])),
    median(labs.map((l) => l[2])),
  ];
}

export interface ColorPrediction {
  number: number | null;
  distance: number;
  /** 0..1 */
  confidence: number;
  /** Distance to the runner-up, for the debug view. */
  runnerUpDistance: number;
}

/**
 * Score a ring colour against the learned model.
 *
 * Confidence blends "is it close in absolute terms" with "is it clearly closer
 * than the next colour". A kit whose 3 and 4 rings are nearly the same orange
 * will produce low colour confidence for both, which is honest — that is
 * exactly the case where the digit has to decide.
 */
export function predictFromColor(model: ColorModel, color: RingColor | undefined): ColorPrediction {
  if (!color || !model.trained || model.entries.length === 0) {
    return { number: null, distance: Infinity, confidence: 0, runnerUpDistance: Infinity };
  }
  const scored = model.entries
    .map((e) => ({ e, d: deltaE94(color.lab, e.lab) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  const second = scored[1];
  // "Within about two typical deviations" -> full marks, decaying after that.
  const tolerance = Math.max(3, best.e.spread * 2.2);
  const closeness = Math.max(0, 1 - best.d / (tolerance * 2));
  const separation = second
    ? Math.max(0, Math.min(1, (second.d - best.d) / Math.max(4, best.e.spread * 2)))
    : 1;
  const sampleWeight = Math.min(1, best.e.samples / 12);
  const noise = Math.max(0.4, 1 - color.spread / 40);
  const confidence = Math.max(0, Math.min(1, closeness * (0.35 + 0.65 * separation) * sampleWeight * noise));
  return {
    number: best.e.number,
    distance: best.d,
    confidence,
    runnerUpDistance: second ? second.d : Infinity,
  };
}
