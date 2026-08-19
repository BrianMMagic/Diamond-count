import type { ConfidenceLevel, MarkerDetection } from './types.ts';

export interface ConfidenceInputs {
  /** 0..1 from the classifier. */
  ocrConfidence: number;
  /** True when every preprocessing variant read the same digit. */
  ocrAgreement: boolean;
  /** 0..1 radial-profile quality of the detection itself. */
  detectionScore: number;
  /** Marker radius relative to the image median; 1 is typical. */
  sizeRatio: number;
}

/**
 * Blend the evidence for a marker read on its own into a single 0..1 score.
 *
 * Deliberately conservative. With several hundred markers per image it is far
 * cheaper to review a handful of flagged markers than to ship a wrong total, so
 * a lone reading never reaches the confidence a shape group can.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  let score = 0.68 * inputs.ocrConfidence + 0.24 * inputs.detectionScore;
  if (inputs.ocrAgreement) score += 0.08;

  // Markers noticeably bigger or smaller than their neighbours are suspicious.
  const sizePenalty = Math.min(0.18, Math.abs(Math.log(Math.max(0.2, inputs.sizeRatio))) * 0.35);
  score -= sizePenalty;

  return Math.max(0, Math.min(1, score));
}

export function levelFor(score: number): ConfidenceLevel {
  if (score >= 0.78) return 'high';
  if (score >= 0.55) return 'medium';
  return 'review';
}

/** Ordering for the review queue: worst first, ties broken deterministically. */
export function reviewPriority(m: MarkerDetection): number {
  if (m.manualNumber != null || m.rejected) return Infinity;
  const base = m.finalScore ?? 0;
  const noNumber = m.finalNumber == null ? -1 : 0;
  return base + noNumber;
}
