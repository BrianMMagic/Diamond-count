import type { MarkerCandidate } from './types.ts';

export interface DedupOptions {
  /** Merge when centres are closer than this fraction of the mean radius. */
  centerDistanceFactor: number;
  /** Merge when bounding boxes overlap by at least this IoU. */
  iouThreshold: number;
}

export const DEFAULT_DEDUP: DedupOptions = {
  centerDistanceFactor: 0.85,
  iouThreshold: 0.45,
};

export interface DedupResult {
  markers: MarkerCandidate[];
  merged: number;
}

function iou(a: MarkerCandidate, b: MarkerCandidate): number {
  const ax0 = a.x - a.width / 2;
  const ay0 = a.y - a.height / 2;
  const ax1 = a.x + a.width / 2;
  const ay1 = a.y + a.height / 2;
  const bx0 = b.x - b.width / 2;
  const by0 = b.y - b.height / 2;
  const bx1 = b.x + b.width / 2;
  const by1 = b.y + b.height / 2;
  const ix = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const iy = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy non-maximum suppression with a uniform spatial grid.
 *
 * Two independent generators plus a symmetry map that can peak twice on one
 * marker mean duplicates are guaranteed; this is the stage that makes "one
 * physical marker == one detection id" true. Strongest candidate wins and
 * absorbs the others, nudging its centre towards the score-weighted mean so the
 * merged position is better than either input.
 */
export function deduplicate(
  candidates: MarkerCandidate[],
  opts: DedupOptions = DEFAULT_DEDUP,
): DedupResult {
  if (candidates.length === 0) return { markers: [], merged: 0 };
  const sorted = candidates.slice().sort((a, b) => b.detectionScore - a.detectionScore);
  const cell = Math.max(4, meanRadius(candidates) * 2);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  const kept: MarkerCandidate[] = [];
  let merged = 0;

  for (const cand of sorted) {
    let absorbedBy = -1;
    const gx = Math.floor(cand.x / cell);
    const gy = Math.floor(cand.y / cell);
    outer: for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          const other = kept[idx];
          const meanR = (cand.radius + other.radius) / 2;
          const dist = Math.hypot(cand.x - other.x, cand.y - other.y);
          if (dist < meanR * opts.centerDistanceFactor || iou(cand, other) >= opts.iouThreshold) {
            absorbedBy = idx;
            break outer;
          }
        }
      }
    }
    if (absorbedBy >= 0) {
      merged++;
      const winner = kept[absorbedBy];
      const wa = winner.detectionScore + 1e-6;
      const wb = cand.detectionScore + 1e-6;
      const total = wa + wb;
      winner.x = (winner.x * wa + cand.x * wb) / total;
      winner.y = (winner.y * wa + cand.y * wb) / total;
      winner.radius = (winner.radius * wa + cand.radius * wb) / total;
      winner.width = winner.radius * 2;
      winner.height = winner.radius * 2;
      // Agreement between two independent generators is genuine evidence.
      if (winner.source !== cand.source) {
        winner.detectionScore = Math.min(1, winner.detectionScore + 0.06);
      }
      continue;
    }
    const idx = kept.push(cand) - 1;
    const k = key(cand.x, cand.y);
    const bucket = grid.get(k);
    if (bucket) bucket.push(idx);
    else grid.set(k, [idx]);
  }

  return { markers: kept, merged };
}

function meanRadius(candidates: MarkerCandidate[]): number {
  let s = 0;
  for (const c of candidates) s += c.radius;
  return s / candidates.length;
}

/** Distance from a point to the nearest existing marker; used by "add marker". */
export function nearestMarker<T extends MarkerCandidate>(
  markers: T[],
  x: number,
  y: number,
): { marker: T | null; distance: number } {
  let best: T | null = null;
  let bestD = Infinity;
  for (const m of markers) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return { marker: best, distance: bestD };
}
