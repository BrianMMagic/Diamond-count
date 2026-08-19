import type { CountSummary } from '../core/types.ts';

export interface GroundTruth {
  /** File name of the sample image this describes. */
  image: string;
  /** number -> expected count, e.g. { "1": 163, "2": 284 }. */
  counts: Record<string, number>;
  /** Optional; derived from `counts` when absent. */
  total?: number;
  notes?: string;
}

export interface PerNumberAccuracy {
  number: number;
  expected: number;
  detected: number;
  difference: number;
  /** 1 - |difference| / expected, floored at 0. */
  accuracy: number;
}

export interface Evaluation {
  image: string;
  expectedTotal: number;
  detectedTotal: number;
  /** Detected minus expected; positive means extra markers. */
  totalDifference: number;
  totalAccuracy: number;
  perNumber: PerNumberAccuracy[];
  /** Markers the detector appears to have missed, summed over numbers. */
  missed: number;
  /** Markers the detector appears to have invented, summed over numbers. */
  extra: number;
  /**
   * Lower bound on misclassifications: the count that moved between numbers
   * while the total stayed the same.
   */
  misclassifiedAtLeast: number;
  needsReview: number;
}

export function expectedTotal(truth: GroundTruth): number {
  return truth.total ?? Object.values(truth.counts).reduce((s, v) => s + v, 0);
}

/**
 * Compare a run against hand-verified counts.
 *
 * Counts alone cannot distinguish "missed a 3" from "read a 3 as a 4", so the
 * report separates what it can prove: the net total error tells you about
 * missed or invented markers, while the surplus that cancels out across numbers
 * is a floor on how many were misclassified.
 */
export function evaluate(truth: GroundTruth, summary: CountSummary): Evaluation {
  const numbers = new Set<number>();
  for (const key of Object.keys(truth.counts)) numbers.add(Number(key));
  for (const key of summary.counts.keys()) numbers.add(key);

  const perNumber: PerNumberAccuracy[] = [...numbers]
    .sort((a, b) => a - b)
    .map((number) => {
      const expected = truth.counts[String(number)] ?? 0;
      const detected = summary.counts.get(number) ?? 0;
      const difference = detected - expected;
      return {
        number,
        expected,
        detected,
        difference,
        accuracy: expected === 0 ? (detected === 0 ? 1 : 0) : Math.max(0, 1 - Math.abs(difference) / expected),
      };
    });

  const expTotal = expectedTotal(truth);
  const totalDifference = summary.total - expTotal;
  const positive = perNumber.reduce((s, p) => s + Math.max(0, p.difference), 0);
  const negative = perNumber.reduce((s, p) => s + Math.max(0, -p.difference), 0);

  return {
    image: truth.image,
    expectedTotal: expTotal,
    detectedTotal: summary.total,
    totalDifference,
    totalAccuracy: expTotal === 0 ? (summary.total === 0 ? 1 : 0) : Math.max(0, 1 - Math.abs(totalDifference) / expTotal),
    perNumber,
    missed: Math.max(0, -totalDifference),
    extra: Math.max(0, totalDifference),
    misclassifiedAtLeast: Math.min(positive, negative),
    needsReview: summary.needsReview,
  };
}

export function formatEvaluation(evaluation: Evaluation): string {
  const lines: string[] = [];
  lines.push(`${evaluation.image}`);
  lines.push(
    `  total: expected ${evaluation.expectedTotal}, detected ${evaluation.detectedTotal} ` +
      `(${evaluation.totalDifference >= 0 ? '+' : ''}${evaluation.totalDifference}, ` +
      `${(evaluation.totalAccuracy * 100).toFixed(1)}% accurate)`,
  );
  for (const p of evaluation.perNumber) {
    lines.push(
      `    ${String(p.number).padStart(2)}: expected ${String(p.expected).padStart(4)} ` +
        `detected ${String(p.detected).padStart(4)} ` +
        `(${p.difference >= 0 ? '+' : ''}${p.difference}, ${(p.accuracy * 100).toFixed(1)}%)`,
    );
  }
  lines.push(
    `  missed >= ${evaluation.missed}, extra >= ${evaluation.extra}, ` +
      `misclassified >= ${evaluation.misclassifiedAtLeast}, needs review ${evaluation.needsReview}`,
  );
  return lines.join('\n');
}
