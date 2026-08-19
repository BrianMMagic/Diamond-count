import { predictFromColor } from './colorAnalyzer.ts';
import type { ClusterResult } from './colorClusterer.ts';
import { computeConfidence, levelFor } from './confidenceCalculator.ts';
import type {
  ClassificationMethod,
  ColorModel,
  DetectorSettings,
  MarkerDetection,
} from './types.ts';

export interface ResolveContext {
  model: ColorModel;
  clusters: ClusterResult;
  settings: DetectorSettings;
  /** Median marker radius, for the size-consistency term. */
  medianRadius: number;
}

interface Thresholds {
  strongOcr: number;
  weakOcr: number;
  strongColor: number;
}

function thresholds(settings: DetectorSettings): Thresholds {
  const s = clamp01(settings.ocrSensitivity);
  const c = clamp01(settings.colorAssistStrength);
  return {
    // Higher OCR sensitivity => accept weaker readings as "strong".
    strongOcr: 0.85 - 0.2 * s,
    weakOcr: 0.45 - 0.2 * s,
    // Higher colour assistance => colour is allowed to speak up sooner.
    strongColor: 0.75 - 0.3 * c,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Decide a marker's number from every source of evidence available.
 *
 * The rules follow the spec's cases: agreement is rewarded, weak OCR may be
 * rescued by a well-established colour, strong OCR is never silently overruled
 * by colour (it is flagged instead), and when nothing is convincing the marker
 * is sent to review rather than guessed.
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

  const t = thresholds(ctx.settings);
  const ocrValue = marker.ocrPrediction ?? null;
  const ocrConf = marker.ocrConfidence ?? 0;

  const colorPred = predictFromColor(ctx.model, marker.ringColor);
  marker.colorPrediction = colorPred.number;
  marker.colorConfidence = colorPred.confidence;
  marker.colorDistance = colorPred.distance;

  // The colour cluster is a second, independent colour opinion. When it agrees
  // with the learned model the colour evidence is materially stronger.
  const clusterIndex = marker.colorCluster ?? -1;
  const cluster = clusterIndex >= 0 ? ctx.clusters.clusters[clusterIndex] : undefined;
  const clusterNumber = cluster?.assignedNumber ?? null;
  const clusterPurity = cluster && cluster.assignedNumber !== null ? cluster.purity : 0;

  let colorNumber = colorPred.number;
  let colorConf = colorPred.confidence;
  if (clusterNumber !== null && cluster && cluster.size >= 6) {
    if (clusterNumber === colorNumber) {
      colorConf = Math.min(1, colorConf * (1 + 0.35 * clusterPurity));
    } else if (colorNumber === null || colorConf < 0.35) {
      colorNumber = clusterNumber;
      colorConf = Math.max(colorConf, 0.5 * clusterPurity * Math.min(1, cluster.size / 12));
    } else {
      // The two colour views disagree; trust neither much.
      colorConf *= 0.5;
    }
  }
  marker.colorPrediction = colorNumber;
  marker.colorConfidence = colorConf;

  const attempts = marker.ocrAttempts ?? [];
  const valued = attempts.filter((a) => a.value !== null);
  const ocrAgreement = valued.length > 1 && valued.every((a) => a.value === ocrValue);

  const agree = ocrValue !== null && colorNumber !== null && ocrValue === colorNumber;
  const conflict =
    ocrValue !== null && colorNumber !== null && ocrValue !== colorNumber && colorConf >= t.strongColor;

  let value: number | null;
  let method: ClassificationMethod;
  let reason: string;

  if (ocrValue !== null && ocrConf >= t.strongOcr && agree) {
    value = ocrValue;
    method = 'ocr+color';
    reason = `Digit read as ${ocrValue} (${pct(ocrConf)}) and the ring colour matches ${ocrValue}.`;
  } else if (ocrValue !== null && ocrConf >= t.weakOcr && agree) {
    value = ocrValue;
    method = 'ocr+color';
    reason = `Digit read as ${ocrValue} with moderate confidence (${pct(ocrConf)}); the ring colour agrees.`;
  } else if (ocrValue !== null && ocrConf >= t.strongOcr && conflict) {
    // Case D: never let colour silently overrule a strong reading.
    value = ocrValue;
    method = 'ocr';
    reason = `Digit read as ${ocrValue} (${pct(ocrConf)}) but the ring colour looks like ${colorNumber}. Flagged for review.`;
  } else if (ocrValue !== null && ocrConf < t.weakOcr && colorNumber !== null && colorConf >= t.strongColor) {
    // Case C: weak reading, strong colour evidence.
    value = colorNumber;
    method = 'color';
    reason = `Digit was unclear (read ${ocrValue} at ${pct(ocrConf)}); the ring colour matches ${colorNumber} across ${cluster?.size ?? 0} similar markers.`;
  } else if (ocrValue === null && colorNumber !== null && colorConf >= t.strongColor) {
    // Case E: OCR failed outright.
    value = colorNumber;
    method = 'color';
    reason = `No digit could be read; classified as ${colorNumber} from the learned ring colour.`;
  } else if (ocrValue !== null && ocrConf >= t.strongOcr) {
    value = ocrValue;
    method = 'ocr';
    reason = `Digit read as ${ocrValue} (${pct(ocrConf)}); no colour evidence available.`;
  } else if (ocrValue !== null && (colorNumber === null || colorConf < 0.25)) {
    value = ocrValue;
    method = 'ocr';
    reason = `Digit read as ${ocrValue} (${pct(ocrConf)}) with little supporting evidence.`;
  } else if (ocrValue !== null) {
    value = ocrValue;
    method = 'ocr';
    reason = `Digit read as ${ocrValue} (${pct(ocrConf)}); the ring colour is inconclusive.`;
  } else if (colorNumber !== null && colorConf > 0.2) {
    value = colorNumber;
    method = 'color';
    reason = `No digit could be read; the ring colour weakly suggests ${colorNumber}.`;
  } else {
    // Case F: say "I do not know" instead of guessing.
    value = null;
    method = 'unknown';
    reason = 'Neither the digit nor the ring colour was conclusive.';
  }

  const score = computeConfidence({
    ocrConfidence: ocrConf,
    ocrAgreement,
    colorConfidence: colorConf,
    numberColorAgreement: agree,
    numberColorConflict: conflict,
    detectionScore: marker.detectionScore,
    clusterPurity,
    sizeRatio: ctx.medianRadius > 0 ? marker.radius / ctx.medianRadius : 1,
  });

  marker.finalNumber = value;
  marker.finalScore = value === null ? Math.min(score, 0.4) : score;
  marker.finalConfidence = value === null ? 'review' : levelFor(score, conflict);
  marker.classificationMethod = method;
  marker.reason = reason;
  marker.needsReview = marker.finalConfidence === 'review';
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Consistency sweep over the finished set.
 *
 * Once most markers are settled, a few that were decided in isolation can be
 * checked against the population: a marker whose colour sits squarely inside a
 * large, pure cluster but which was labelled something else is worth a second
 * look even if its own numbers looked acceptable.
 */
export function flagInconsistencies(markers: MarkerDetection[], ctx: ResolveContext): number {
  let flagged = 0;
  for (const marker of markers) {
    if (marker.manualNumber != null || marker.rejected) continue;
    const idx = marker.colorCluster ?? -1;
    if (idx < 0) continue;
    const cluster = ctx.clusters.clusters[idx];
    if (!cluster || cluster.assignedNumber === null) continue;
    if (cluster.size < 10 || cluster.purity < 0.9) continue;
    if (marker.finalNumber === cluster.assignedNumber) continue;
    if (marker.classificationMethod === 'manual') continue;
    // Strong, agreeing readings survive; everything else is demoted.
    if (marker.finalConfidence === 'high' && (marker.ocrConfidence ?? 0) >= 0.9) continue;
    marker.finalConfidence = 'review';
    marker.needsReview = true;
    marker.finalScore = Math.min(marker.finalScore ?? 0.5, 0.5);
    marker.reason = `${marker.reason ?? ''} Its ring colour matches ${cluster.size} markers counted as ${cluster.assignedNumber}.`.trim();
    flagged++;
  }
  return flagged;
}
