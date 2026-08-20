/**
 * Ordering for the review queue.
 *
 * Markers are shown worst-first, where "worst" is how close the marker sat to
 * belonging somewhere else. A marker with no number at all comes before any
 * marker that has one, however weakly.
 */
import type { MarkerDetection } from './types.ts';

export function reviewPriority(m: MarkerDetection): number {
  if (m.manualNumber != null || m.rejected) return Infinity;
  const base = m.finalScore ?? 0;
  const noNumber = m.finalNumber == null ? -1 : 0;
  return base + noNumber;
}
