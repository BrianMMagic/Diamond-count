import { median } from './cv/threshold.ts';
import type { ClusterResult } from './colorClusterer.ts';
import type { MarkerDetection } from './types.ts';

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
  clusters: ClusterResult,
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

  // A number that owns a real colour group is real even if the digits are hard
  // to read — that is the whole point of having a second source of evidence.
  for (const cluster of clusters.clusters) {
    if (cluster.assignedNumber === null) continue;
    if (cluster.size >= threshold && cluster.purity >= 0.6) active.add(cluster.assignedNumber);
  }

  // Never return nothing: fall back to whatever was most often read.
  if (active.size === 0 && votes.size > 0) {
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    active.add(best[0]);
  }

  return { numbers: [...active].sort((a, b) => a - b), source: 'inferred' };
}

export interface ConsistencyResult {
  /** Readings thrown out for naming a number the image does not contain. */
  outOfVocabulary: number;
  /** Markers whose value was CHANGED by their colour group. */
  clusterCorrected: number;
}

/**
 * Force every marker into the active number set, and let strong colour groups
 * correct — not merely flag — the markers that disagree with them.
 *
 * The earlier version only demoted a disagreeing marker to "needs review". With
 * a handful of markers that is reasonable; with seven hundred it just moves the
 * work onto the user. When a colour group is large, pure, and the marker sits
 * squarely inside it, the group is better evidence than one blurry digit, so it
 * wins outright. A confident, well-formed reading still survives — it is flagged
 * for review instead, which is the case the spec singles out.
 */
export function enforceGlobalConsistency(
  markers: MarkerDetection[],
  active: ActiveNumbers,
  clusters: ClusterResult,
): ConsistencyResult {
  const allowed = new Set(active.numbers);
  let outOfVocabulary = 0;
  let clusterCorrected = 0;

  for (const marker of markers) {
    if (marker.manualNumber != null || marker.rejected) continue;

    const cluster = marker.colorCluster != null && marker.colorCluster >= 0
      ? clusters.clusters[marker.colorCluster]
      : undefined;
    const clusterNumber =
      cluster && cluster.assignedNumber !== null && allowed.has(cluster.assignedNumber)
        ? cluster.assignedNumber
        : null;
    const clusterTrusted =
      clusterNumber !== null && cluster !== undefined && cluster.size >= 10 && cluster.purity >= 0.85;

    // 1. A value the image does not contain cannot stand.
    if (marker.finalNumber != null && !allowed.has(marker.finalNumber)) {
      outOfVocabulary++;
      const fallback = pickFallback(marker, allowed, clusterNumber);
      if (fallback != null) {
        marker.finalNumber = fallback;
        marker.classificationMethod = fallback === clusterNumber ? 'color' : 'ocr';
        marker.reason =
          `Read as ${marker.ocrPrediction}, which this image does not use; ` +
          `re-read as ${fallback} from the remaining candidates.`;
        marker.finalConfidence = clusterTrusted && fallback === clusterNumber ? 'medium' : 'review';
        marker.finalScore = Math.min(marker.finalScore ?? 0.5, clusterTrusted ? 0.6 : 0.45);
        marker.needsReview = marker.finalConfidence === 'review';
      } else {
        marker.finalNumber = null;
        marker.classificationMethod = 'unknown';
        marker.finalConfidence = 'review';
        marker.finalScore = 0;
        marker.needsReview = true;
        marker.reason = `Read as ${marker.ocrPrediction}, which this image does not use, and nothing else fitted.`;
      }
      continue;
    }

    // 2. A large, pure colour group outvotes an unconvincing digit.
    if (!clusterTrusted || clusterNumber === null) continue;
    if (marker.finalNumber === clusterNumber) continue;

    const ocrConfidence = marker.ocrConfidence ?? 0;
    const wellRead = ocrConfidence >= 0.85 && marker.finalConfidence === 'high';
    if (wellRead) {
      // Case D from the spec: never silently overrule a confident reading.
      marker.finalConfidence = 'review';
      marker.needsReview = true;
      marker.finalScore = Math.min(marker.finalScore ?? 0.5, 0.5);
      marker.reason =
        `${marker.reason ?? ''} Its ring colour matches ${cluster.size} markers counted as ${clusterNumber}.`.trim();
      continue;
    }

    marker.finalNumber = clusterNumber;
    marker.classificationMethod = 'color';
    marker.finalScore = Math.max(marker.finalScore ?? 0, 0.7);
    marker.finalConfidence = 'medium';
    marker.needsReview = false;
    marker.reason =
      `The digit was unconvincing (${Math.round(ocrConfidence * 100)}%); its ring colour matches ` +
      `${cluster.size} markers counted as ${clusterNumber}, so it was counted as ${clusterNumber}.`;
    clusterCorrected++;
  }

  return { outOfVocabulary, clusterCorrected };
}

/** Best remaining hypothesis for a marker whose reading was out of vocabulary. */
function pickFallback(
  marker: MarkerDetection,
  allowed: Set<number>,
  clusterNumber: number | null,
): number | null {
  const ranked = marker.ocrRanked ?? [];
  const best = ranked.find((r) => allowed.has(r.value));
  // Prefer a colour group over a weak runner-up digit.
  if (clusterNumber !== null && (!best || best.score < 0.45)) return clusterNumber;
  if (best) return best.value;
  return clusterNumber;
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
