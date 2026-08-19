import { computeConfidence, levelFor } from './confidenceCalculator.ts';
import type { DetectorSettings, MarkerDetection } from './types.ts';

export interface ResolveContext {
  settings: DetectorSettings;
  /** Median marker radius, for the size-consistency term. */
  medianRadius: number;
}

/**
 * Decide the value of a marker that no digit-shape group claimed.
 *
 * Almost every marker is settled by its shape group; this handles the leftovers
 * — the ones whose digit could not be isolated or matched. There is deliberately
 * no colour evidence here. Ring colour was tried as a second opinion and removed:
 * its failure mode is catastrophic rather than gradual, because one mislabelled
 * colour group is hundreds of wrong markers at once. A marker that cannot be
 * read is reported as unknown instead of being guessed from what colour it is.
 */
export function resolveMarker(marker: MarkerDetection, ctx: ResolveContext): void {
  if (marker.rejected) {
    marker.finalNumber = null;
    marker.finalConfidence = 'high';
    marker.classificationMethod = 'manual';
    marker.reason = 'Marked as "not a marker" by you.';
    marker.needsReview = false;
    return;
  }
  if (marker.manualNumber != null) {
    marker.finalNumber = marker.manualNumber;
    marker.finalConfidence = 'high';
    marker.finalScore = 1;
    marker.classificationMethod = 'manual';
    marker.reason = 'Set by you.';
    marker.needsReview = false;
    return;
  }

  const value = marker.ocrPrediction ?? null;
  const confidence = marker.ocrConfidence ?? 0;
  const attempts = marker.ocrAttempts ?? [];
  const valued = attempts.filter((a) => a.value !== null);
  const agreement = valued.length > 1 && valued.every((a) => a.value === value);

  const score = computeConfidence({
    ocrConfidence: confidence,
    ocrAgreement: agreement,
    detectionScore: marker.detectionScore,
    sizeRatio: ctx.medianRadius > 0 ? marker.radius / ctx.medianRadius : 1,
  });

  marker.finalNumber = value;
  marker.finalScore = value === null ? Math.min(score, 0.3) : score;
  marker.finalConfidence = value === null ? 'review' : levelFor(score);
  marker.classificationMethod = value === null ? 'unknown' : 'ocr';
  marker.needsReview = marker.finalConfidence === 'review';
  marker.reason =
    value === null
      ? 'The digit on this marker could not be read, and it matched no other marker in the image.'
      : `Read on its own as ${value} (${Math.round(confidence * 100)}%); it matched no other marker in the image.`;
}
