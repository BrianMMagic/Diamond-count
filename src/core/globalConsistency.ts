import { median } from './cv/threshold.ts';
import type { MarkerDetection, ShapeGroup } from './types.ts';

export interface ActiveNumbers {
  numbers: number[];
  source: 'user' | 'inferred';
}

export interface InferOptions {
  /** Numbers the user declared. When present, nothing is inferred. */
  userSet: number[] | null;
  /** A number must reach this share of confident readings to count as real. */
  minShare: number;
  /** ...and at least this many, so small images are not over-pruned. */
  minCount: number;
  /** Readings below this confidence do not get a vote. */
  minConfidence: number;
}

export const DEFAULT_INFER: InferOptions = {
  userSet: null,
  minShare: 0.015,
  minCount: 4,
  minConfidence: 0.6,
};

/**
 * Work out which numbers the image actually contains.
 *
 * A kit uses a handful of numbers, not all ten. Left unconstrained, every
 * marker is decided against all ten digits independently, and on several
 * hundred tiny printed digits that reliably manufactures a scattering of
 * numbers that are not in the image at all. Two lines of evidence make a number
 * real: many confident readings agreeing on it, or it owning a substantial
 * colour group. Anything that clears neither bar is noise, however confident any
 * individual reading looked.
 */
export function inferActiveNumbers(
  markers: MarkerDetection[],
  opts: InferOptions = DEFAULT_INFER,
): ActiveNumbers {
  if (opts.userSet && opts.userSet.length > 0) {
    return { numbers: [...new Set(opts.userSet)].sort((a, b) => a - b), source: 'user' };
  }

  const votes = new Map<number, number>();
  let total = 0;
  for (const m of markers) {
    if (m.ocrPrediction == null) continue;
    if ((m.ocrConfidence ?? 0) < opts.minConfidence) continue;
    votes.set(m.ocrPrediction, (votes.get(m.ocrPrediction) ?? 0) + 1);
    total++;
  }

  const threshold = Math.max(opts.minCount, Math.round(total * opts.minShare));
  const active = new Set<number>();
  for (const [number, count] of votes) {
    if (count >= threshold) active.add(number);
  }

  // Never return nothing: fall back to whatever was most often read.
  if (active.size === 0 && votes.size > 0) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    active.add(best[0]);
  }

  return { numbers: [...active].sort((a, b) => a - b), source: 'inferred' };
}

/**
 * The numbers an image uses, taken from the digit-shape groups.
 *
 * When shapes are the authority, the group is the right unit of evidence: a
 * group of 40 markers that all share one printed shape is strong proof that the
 * number exists, regardless of how confident reading its averaged picture
 * happened to look. Judging by per-marker confidence instead throws away whole
 * legitimate groups whose digit is simply harder to read than its neighbours.
 */
export function activeNumbersFromShapes(
  groups: ShapeGroup[],
  totalMarkers: number,
  userSet: number[] | null,
  minShare = 0.01,
  minCount = 3,
): ActiveNumbers {
  if (userSet && userSet.length > 0) {
    return { numbers: [...new Set(userSet)].sort((a, b) => a - b), source: 'user' };
  }
  const threshold = Math.max(minCount, Math.round(totalMarkers * minShare));
  const active = new Set<number>();
  for (const g of groups) {
    if (g.number === null) continue;
    if (g.count >= threshold) active.add(g.number);
  }
  if (active.size === 0) {
    const best = groups.filter((g) => g.number !== null).sort((a, b) => b.count - a.count)[0];
    if (best?.number != null) active.add(best.number);
  }
  return { numbers: [...active].sort((a, b) => a - b), source: 'inferred' };
}

export interface ConsistencyResult {
  /** Readings thrown out for naming a number the image does not contain. */
  outOfVocabulary: number;
  /** Retained for the stats shape; nothing corrects by colour any more. */
  clusterCorrected: number;
}

/**
 * Force every marker into the active number set.
 *
 * A value the image does not contain cannot stand, however confident the
 * reading looked. Markers naming one fall back to the best remaining candidate
 * from the same reading, or are reported as unknown — never guessed from
 * anything else about the marker.
 */
export function enforceGlobalConsistency(
  markers: MarkerDetection[],
  active: ActiveNumbers,
): ConsistencyResult {
  const allowed = new Set(active.numbers);
  let outOfVocabulary = 0;

  for (const marker of markers) {
    if (marker.manualNumber != null || marker.rejected) continue;
    if (marker.finalNumber == null || allowed.has(marker.finalNumber)) continue;

    outOfVocabulary++;
    const fallback = pickFallback(marker, allowed);
    if (fallback != null) {
      marker.finalNumber = fallback;
      marker.classificationMethod = 'ocr';
      marker.reason =
        `Read as ${marker.ocrPrediction}, which this image does not use; ` +
        `re-read as ${fallback} from the remaining candidates.`;
      marker.finalConfidence = 'review';
      marker.finalScore = Math.min(marker.finalScore ?? 0.5, 0.45);
      marker.needsReview = true;
    } else {
      marker.finalNumber = null;
      marker.classificationMethod = 'unknown';
      marker.finalConfidence = 'review';
      marker.finalScore = 0;
      marker.needsReview = true;
      marker.reason = `Read as ${marker.ocrPrediction}, which this image does not use, and nothing else fitted.`;
    }
  }

  return { outOfVocabulary, clusterCorrected: 0 };
}

/** Best remaining hypothesis for a marker whose reading was out of vocabulary. */
function pickFallback(marker: MarkerDetection, allowed: Set<number>): number | null {
  return (marker.ocrRanked ?? []).find((r) => allowed.has(r.value))?.value ?? null;
}

/**
 * Drop detections that are stranded away from every other marker.
 *
 * Markers on these sheets sit in a dense field with a characteristic spacing.
 * A "marker" alone in the middle of the artwork, far from any neighbour, is
 * almost always a shape in the picture underneath rather than a real one. Only
 * detections that are BOTH isolated and unconvincing are removed, so a genuinely
 * lone marker with a clean ring survives.
 */
export function rejectIsolatedDetections(
  markers: MarkerDetection[],
  scoreCeiling = 0.72,
  spacingMultiple = 2.6,
): { kept: MarkerDetection[]; dropped: MarkerDetection[] } {
  if (markers.length < 12) return { kept: markers, dropped: [] };

  // Nearest-neighbour search over a uniform grid; the quadratic version costs
  // millions of comparisons once an image holds a few thousand markers.
  const cell = Math.max(4, median(markers.map((m) => m.radius)) * 6);
  const grid = new Map<string, MarkerDetection[]>();
  for (const m of markers) {
    const key = `${Math.floor(m.x / cell)},${Math.floor(m.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(m);
    else grid.set(key, [m]);
  }
  const neighbourDistance = markers.map((m) => {
    let best = Infinity;
    const gx = Math.floor(m.x / cell);
    const gy = Math.floor(m.y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (other === m) continue;
          const d = Math.hypot(other.x - m.x, other.y - m.y);
          if (d < best) best = d;
        }
      }
    }
    // Nothing within a cell of us is already isolation enough.
    return Number.isFinite(best) ? best : cell * 3;
  });
  const typical = median(neighbourDistance.filter((d) => Number.isFinite(d)));
  if (!Number.isFinite(typical) || typical <= 0) return { kept: markers, dropped: [] };

  const limit = typical * spacingMultiple;
  const kept: MarkerDetection[] = [];
  const dropped: MarkerDetection[] = [];
  markers.forEach((m, i) => {
    const isolated = neighbourDistance[i] > limit;
    if (isolated && m.detectionScore < scoreCeiling && m.source !== 'manual') dropped.push(m);
    else kept.push(m);
  });
  return { kept, dropped };
}
