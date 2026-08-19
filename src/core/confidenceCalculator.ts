import type { ConfidenceLevel, MarkerDetection } from './types.ts';

export interface ConfidenceInputs {
  /** 0..1 from the classifier ensemble. */
  ocrConfidence: number;
  /** True when every preprocessing variant read the same digit. */
  ocrAgreement: boolean;
  /** 0..1 from the learned colour model. */
  colorConfidence: number;
  /** True when OCR and colour point at the same number. */
  numberColorAgreement: boolean;
  /** True when OCR and colour point at DIFFERENT numbers. */
  numberColorConflict: boolean;
  /** 0..1 radial-profile quality of the detection itself. */
  detectionScore: number;
  /** 0..1 purity of the colour cluster this marker sits in. */
  clusterPurity: number;
  /** Marker radius relative to the image median; 1 is typical. */
  sizeRatio: number;
}

/**
 * Blend the evidence into a single 0..1 score.
 *
 * The weights are deliberately conservative: a strong reading that conflicts
 * with a well-established colour is pushed below the review line rather than
 * being reported as certain. With several hundred markers per image it is far
 * cheaper to review a handful of flagged markers than to ship a wrong total.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  let score =
    0.5 * inputs.ocrConfidence +
    0.22 * inputs.colorConfidence +
    0.16 * inputs.detectionScore +
    0.12 * inputs.clusterPurity;

  if (inputs.numberColorAgreement) score += 0.16;
  if (inputs.ocrAgreement) score += 0.06;
  if (inputs.numberColorConflict) score -= 0.32;

  // Markers noticeably bigger or smaller than their neighbours are suspicious.
  const sizePenalty = Math.min(0.18, Math.abs(Math.log(Math.max(0.2, inputs.sizeRatio))) * 0.35);
  score -= sizePenalty;

  return Math.max(0, Math.min(1, score));
}

export function levelFor(score: number, conflicted: boolean): ConfidenceLevel {
  if (conflicted) return score >= 0.86 ? 'medium' : 'review';
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
