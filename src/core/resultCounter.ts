import type { CountSummary, MarkerDetection } from './types.ts';
import { SUPPORTED_NUMBERS } from './types.ts';

/**
 * Turn the marker list into the numbers shown on the results screen.
 *
 * Markers still awaiting review are counted under their current best guess but
 * also reported separately, so the total is never presented as settled while
 * unresolved markers remain.
 */
export function countMarkers(markers: MarkerDetection[]): CountSummary {
  const counts = new Map<number, number>();
  let total = 0;
  let high = 0;
  let medium = 0;
  let review = 0;
  let rejected = 0;

  for (const m of markers) {
    if (m.rejected) {
      rejected++;
      continue;
    }
    const value = m.manualNumber ?? m.finalNumber ?? null;
    if (value != null) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      total++;
    }
    if (m.manualNumber != null) high++;
    else if (m.finalConfidence === 'high') high++;
    else if (m.finalConfidence === 'medium') medium++;
    else review++;
  }

  return { total, counts, highConfidence: high, mediumConfidence: medium, needsReview: review, rejected };
}

/** Rows for the results table; `showAll` includes zero-count numbers 1..10. */
export function countRows(summary: CountSummary, showAll: boolean): Array<{ number: number; count: number }> {
  if (showAll) {
    return SUPPORTED_NUMBERS.map((n) => ({ number: n, count: summary.counts.get(n) ?? 0 }));
  }
  return [...summary.counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([number, count]) => ({ number, count }));
}

/** "1: 163, 2: 284, 3: 177" — the Copy Counts payload. */
export function formatCounts(summary: CountSummary, showAll: boolean): string {
  return countRows(summary, showAll)
    .map((r) => `${r.number}: ${r.count}`)
    .join(', ');
}
