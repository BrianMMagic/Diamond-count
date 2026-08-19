import { median } from './cv/threshold.ts';
import type { MarkerCandidate, MarkerDetection } from './types.ts';

/**
 * Surface candidates that only just failed the detector.
 *
 * Counting accuracy depends on finding every marker, and the cheapest way to
 * recover the last few is to keep the near-misses rather than discard them: the
 * user confirms or dismisses them in one tap each. Anything overlapping an
 * accepted marker is dropped so this list never re-offers something already
 * counted.
 */
export function findPossibleMissed(
  nearMisses: MarkerCandidate[],
  accepted: MarkerDetection[],
  limit = 200,
): MarkerCandidate[] {
  if (nearMisses.length === 0) return [];
  const radii = accepted.map((m) => m.radius);
  const med = radii.length >= 5 ? median(radii) : median(nearMisses.map((m) => m.radius));
  const lo = med * 0.65;
  const hi = med * 1.5;

  const cell = Math.max(4, med * 2);
  const grid = new Map<string, MarkerDetection[]>();
  for (const m of accepted) {
    const key = `${Math.floor(m.x / cell)},${Math.floor(m.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(m);
    else grid.set(key, [m]);
  }

  const out: MarkerCandidate[] = [];
  for (const cand of nearMisses) {
    if (cand.radius < lo || cand.radius > hi) continue;
    if ((cand.profile?.aspect ?? 1) > 1.8) continue;
    const gx = Math.floor(cand.x / cell);
    const gy = Math.floor(cand.y / cell);
    let overlaps = false;
    for (let dy = -1; dy <= 1 && !overlaps; dy++) {
      for (let dx = -1; dx <= 1 && !overlaps; dx++) {
        for (const m of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(m.x - cand.x, m.y - cand.y) < (m.radius + cand.radius) * 0.6) {
            overlaps = true;
            break;
          }
        }
      }
    }
    if (!overlaps) out.push(cand);
  }

  out.sort((a, b) => b.detectionScore - a.detectionScore);
  return out.slice(0, limit);
}

/**
 * Median spacing between a marker and its nearest neighbour.
 * Reported in the debug panel as a sanity check on the detection density.
 */
export function medianNeighbourSpacing(markers: MarkerCandidate[]): number {
  if (markers.length < 3) return 0;
  const cell = Math.max(4, median(markers.map((m) => m.radius)) * 4);
  const grid = new Map<string, MarkerCandidate[]>();
  for (const m of markers) {
    const key = `${Math.floor(m.x / cell)},${Math.floor(m.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(m);
    else grid.set(key, [m]);
  }
  const distances: number[] = [];
  for (const m of markers) {
    let best = Infinity;
    const gx = Math.floor(m.x / cell);
    const gy = Math.floor(m.y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (other === m) continue;
          best = Math.min(best, Math.hypot(other.x - m.x, other.y - m.y));
        }
      }
    }
    if (Number.isFinite(best)) distances.push(best);
  }
  return distances.length ? median(distances) : 0;
}
