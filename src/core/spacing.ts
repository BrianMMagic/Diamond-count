/**
 * How far apart the markers are — the number every later stage is sized from.
 *
 * Two ways of measuring it, because they fail in different places.
 *
 * Periodicity (`estimatePitch`) reads the spacing off the image's own
 * autocorrelation. It is accurate to well under a percent when the markers are
 * laid out on a grid, and it needs no detector to run first. It also assumes
 * that grid exists: on a card whose beads follow the contours of the picture in
 * flowing curved lines, there is no repeating lattice to find, the correlation
 * has no peak, and it returns nothing at all. That is not a degraded answer, it
 * is a dead stop — the pipeline has no size to work with and reports zero
 * markers on a card covered in them.
 *
 * Measuring the markers themselves has no such assumption. Detect at some
 * spacing, take the median distance from each detection to its nearest
 * neighbour, and that distance *is* the spacing — however the markers are
 * arranged. It needs a starting guess, which is the awkward part, so it is run
 * as a loop: detect, measure, detect again at what was measured, until the two
 * agree. It converges from a long way off, on all three real cards tested, from
 * seeds spanning a factor of three.
 *
 * So periodicity is used as the opening guess where it is confident, and the
 * loop refines it or replaces it. The loop runs on a downscaled copy because
 * spacing is a ratio: measuring it at a third of the size costs a ninth of the
 * work and gives the same answer.
 */
import type { GrayImage } from './cv/image.ts';
import { downscaleGray } from './cv/resize.ts';
import { median } from './cv/threshold.ts';
import { estimatePitch } from './calibrate.ts';
import { detectGlyphs } from './glyphDetector.ts';

export interface SpacingEstimate {
  /** Centre-to-centre spacing in original-image pixels, or 0 if nothing fit. */
  pitch: number;
  /** How it was arrived at, for the debug panel. */
  source: 'declared' | 'periodicity' | 'neighbours' | 'none';
  /** Detections the winning spacing produced, on the downscaled copy. */
  found: number;
}

/** Longest edge the search runs at. Spacing is a ratio, so this costs nothing. */
const WORK_EDGE = 1000;
/** Stop once a round agrees with the previous one this closely. */
const SETTLED = 0.06;
const MAX_ROUNDS = 4;

export function estimateSpacing(gray: GrayImage): SpacingEstimate {
  const scale = Math.min(1, WORK_EDGE / Math.max(gray.width, gray.height));
  const small = scale < 1 ? downscaleGray(gray, scale) : gray;

  const seeds: number[] = [];
  const periodic = estimatePitch(small);
  if (periodic.pitch > 4) seeds.push(periodic.pitch);
  // Fallbacks spanning the range of marker sizes a photograph can plausibly
  // hold, used when there is no grid to read and to check the periodic guess
  // was not a harmonic.
  const edge = Math.min(small.width, small.height);
  for (const divisor of [20, 40, 70]) seeds.push(edge / divisor);

  let best: { pitch: number; found: number } | null = null;
  for (const seed of seeds) {
    const settled = settle(small, seed);
    if (settled.found === 0) continue;
    if (!best || settled.found > best.found) best = settled;
  }
  if (!best) return { pitch: 0, source: 'none', found: 0 };

  const fromPeriodicity =
    periodic.pitch > 4 && Math.abs(best.pitch - periodic.pitch) / periodic.pitch < 0.15;
  return {
    pitch: best.pitch / scale,
    source: fromPeriodicity ? 'periodicity' : 'neighbours',
    found: best.found,
  };
}

/** Detect, measure the spacing that produced, and repeat until the two agree. */
function settle(gray: GrayImage, seed: number): { pitch: number; found: number } {
  let pitch = seed;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!(pitch > 3) || pitch > Math.min(gray.width, gray.height) / 3) break;
    const found = detectGlyphs(gray, { pitch });
    if (found.length < 8) break;
    const measured = nearestNeighbourSpacing(found);
    if (!(measured > 3)) break;
    if (Math.abs(measured - pitch) / pitch < SETTLED) return { pitch: measured, found: found.length };
    pitch = measured;
  }
  return { pitch: 0, found: 0 };
}

/**
 * Median distance from a detection to its closest neighbour.
 *
 * The median rather than the mean: markers at the edge of the artwork have no
 * neighbour on one side and a handful of stray detections have none nearby at
 * all, and either would drag an average upwards without saying anything about
 * how the card is laid out.
 */
function nearestNeighbourSpacing(points: Array<{ x: number; y: number }>): number {
  const cell = Math.max(8, estimateCell(points));
  const grid = new Map<string, Array<{ x: number; y: number }>>();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(p);
    else grid.set(key, [p]);
  }

  const distances: number[] = [];
  for (const p of points) {
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    let best = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const q of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (q === p) continue;
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < best) best = d;
        }
      }
    }
    if (Number.isFinite(best)) distances.push(best);
  }
  return distances.length >= 8 ? median(distances) : 0;
}

/** A first-pass cell size for the neighbour lookup, from the overall density. */
function estimateCell(points: Array<{ x: number; y: number }>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  return Math.sqrt(area / Math.max(1, points.length)) * 2;
}
