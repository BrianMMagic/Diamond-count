import type { RgbaImage } from './cv/image.ts';
import { median } from './cv/threshold.ts';
import { prepareImage } from './imagePreprocessor.ts';
import { detectMarkers, filterBySizeConsistency } from './markerDetector.ts';
import { deduplicate } from './markerDeduplicator.ts';
import { cropMarker } from './markerCropper.ts';
import type { MarkerCrop } from './markerCropper.ts';
import { createClassifier } from './classifier/index.ts';
import type { NumberClassifier } from './classifier/index.ts';
import { resolveMarker } from './classificationResolver.ts';
import {
  activeNumbersFromShapes,
  enforceGlobalConsistency,
  rejectIsolatedDetections,
} from './globalConsistency.ts';
import type { ClassificationOutput } from './classifier/index.ts';
import { clusterGlyphs, prototypeAsCrop } from './glyphClusterer.ts';
import type { ShapeGroup } from './types.ts';
import type { ResolveContext } from './classificationResolver.ts';
import { findPossibleMissed } from './missedMarkerFinder.ts';
import type { MarkerCandidate } from './types.ts';
import type {
  AnalysisResult,
  DetectorSettings,
  MarkerDetection,
  PipelineStage,
  ProgressUpdate,
} from './types.ts';

export interface PipelineOptions {
  settings: DetectorSettings;
  onProgress?: (update: ProgressUpdate) => void;
  /** Injected in tests to avoid loading a real OCR engine. */
  classifierFactory?: (
    useTesseract: boolean,
    allowedNumbers: number[] | null,
  ) => Promise<{ classifier: NumberClassifier; engine: string; warning?: string }>;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  preparing: 'Preparing image',
  detecting: 'Detecting markers',
  deduplicating: 'Removing duplicates',
  cropping: 'Extracting markers',
  reading: 'Reading numbers',
  clustering: 'Grouping marker colours',
  resolving: 'Combining evidence',
  verifying: 'Verifying detections',
  counting: 'Counting',
  done: 'Done',
};

const STAGE_RANGE: Record<PipelineStage, [number, number]> = {
  preparing: [0, 0.08],
  detecting: [0.08, 0.36],
  deduplicating: [0.36, 0.39],
  cropping: [0.39, 0.5],
  reading: [0.5, 0.8],
  clustering: [0.87, 0.9],
  resolving: [0.9, 0.95],
  verifying: [0.95, 0.98],
  counting: [0.98, 1],
  done: [1, 1],
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The whole analysis, stage by stage.
 *
 * Each stage is a separate module so it can be tested, profiled and replaced on
 * its own; this function only sequences them and reports progress. The order is
 * deliberate — colours are learned from OCR results, then fed back into the
 * uncertain markers in a later pass, so classification improves with the number
 * of markers in the image rather than degrading.
 */
export async function runPipeline(original: RgbaImage, opts: PipelineOptions): Promise<AnalysisResult> {
  const started = now();
  const timings: Record<string, number> = {};
  const settings = opts.settings;
  const report = (stage: PipelineStage, fraction: number, detail?: string) => {
    const [lo, hi] = STAGE_RANGE[stage];
    opts.onProgress?.({
      stage,
      label: STAGE_LABELS[stage],
      progress: lo + (hi - lo) * Math.max(0, Math.min(1, fraction)),
      detail,
    });
  };

  // ---- Stage 1: preparation -------------------------------------------------
  report('preparing', 0);
  let t = now();
  const prepared = prepareImage(original, { workingResolution: settings.workingResolution });
  timings.preparing = now() - t;
  report('preparing', 1, `${prepared.working.width} x ${prepared.working.height} working copy`);
  await tick();

  // ---- Stage 2: detection ---------------------------------------------------
  t = now();

  // Detection strictness is CALIBRATED against the image rather than assumed.
  //
  // The one thing that reliably separates a marker from a shape in the artwork
  // underneath is that a marker has a digit printed in it. So each candidate
  // strictness is scored by how many of its detections actually contain a
  // readable digit, measured on a sample, and the strictness that finds the most
  // real markers wins. A loose setting that doubles the count while halving the
  // hit rate loses; so does a strict one that throws away genuine markers.
  const attempts: Array<{ sensitivity: number; outcome: ReturnType<typeof detectMarkers>; yield: number; estimated: number }> = [];
  const tryDetect = async (sensitivity: number, step: number, steps: number) => {
    const outcome = detectMarkers(prepared, {
      sensitivity,
      expectedMarkerSize: settings.expectedMarkerSize,
      onProgress: (f, detail) => report('detecting', (step + f) / steps, detail),
    });
    const candidates = filterBySizeConsistency(deduplicate(outcome.accepted).markers).kept;
    const hitRate = glyphYield(original, candidates);
    // Detections that carry a digit: a direct estimate of real markers found.
    const estimated = candidates.length * hitRate;
    attempts.push({ sensitivity, outcome, yield: hitRate, estimated });
    report(
      'detecting',
      (step + 1) / steps,
      `${candidates.length} candidates, ${Math.round(hitRate * 100)}% carry a number`,
    );
    await tick();
    return estimated;
  };

  // Climb towards whichever strictness finds the most markers that actually
  // carry a digit, rather than assuming a setting. Loosening is explored first
  // because the digit requirement now cleans up the extra candidates, so the
  // real risk is a pale ring missed for good rather than a phantom counted.
  const MAX_PASSES = 4;
  let best = await tryDetect(settings.markerSensitivity, 0, 2);
  {
    // Always try at least one looser setting. A high hit rate says the
    // detections we have are good; it says nothing about the markers we never
    // detected, and stopping on it leaves whole categories of subtle marker
    // undetected while reporting a clean 97%.
    let sensitivity = settings.markerSensitivity;
    let improving = true;
    while (improving && attempts.length < MAX_PASSES && sensitivity < 1) {
      sensitivity = Math.min(1, sensitivity + 0.25);
      const estimated = await tryDetect(sensitivity, attempts.length, attempts.length + 1);
      improving = estimated > best;
      if (improving) best = estimated;
    }
    // Only bother going stricter if loosening never helped.
    if (attempts.length < MAX_PASSES && attempts[0].estimated >= best) {
      await tryDetect(Math.max(0, settings.markerSensitivity - 0.25), attempts.length, attempts.length + 1);
    }
  }
  const chosen = attempts.reduce((best, cur) => (cur.estimated > best.estimated ? cur : best));
  const detection = chosen.outcome;
  timings.detecting = now() - t;
  await tick();

  // ---- Stage 3: deduplication ----------------------------------------------
  report('deduplicating', 0);
  t = now();
  const deduped = deduplicate(detection.accepted);
  const sized = filterBySizeConsistency(deduped.markers);
  timings.deduplicating = now() - t;
  report('deduplicating', 1, `${sized.kept.length} unique markers`);
  await tick();

  const allMarkers: MarkerDetection[] = sized.kept.map((c) => ({
    ...c,
    finalConfidence: 'review',
    classificationMethod: 'unknown',
  }));
  // Shapes in the artwork underneath can pass the ring test; ones that are also
  // stranded far from every other marker are dropped before we spend any
  // recognition effort on them.
  const isolation = rejectIsolatedDetections(allMarkers);
  const markers = isolation.kept;

  // ---- Stage 4: crop extraction --------------------------------------------
  report('cropping', 0);
  t = now();
  const crops: MarkerCrop[] = [];
  for (let i = 0; i < markers.length; i++) {
    crops.push(cropMarker(original, markers[i]));
    if (i % 50 === 0) {
      report('cropping', i / Math.max(1, markers.length), `${i}/${markers.length}`);
      await tick();
    }
  }
  timings.cropping = now() - t;
  report('cropping', 1);

  // Detections with no digit in them are not markers.
  //
  // Previously these were counted and flagged "needs review", which on a real
  // photograph buried the user under a thousand items and made the totals
  // meaningless. They are set aside as possible-missed instead: not counted,
  // still visible, restorable in one tap if any of them turn out to be real.
  const withDigit: MarkerDetection[] = [];
  const withDigitCrops: MarkerCrop[] = [];
  const discarded: MarkerDetection[] = [];
  markers.forEach((m, i) => {
    if (crops[i].glyphs.length > 0) {
      withDigit.push(m);
      withDigitCrops.push(crops[i]);
    } else {
      discarded.push(m);
    }
  });
  markers.length = 0;
  markers.push(...withDigit);
  crops.length = 0;
  crops.push(...withDigitCrops);
  report('cropping', 1, `${markers.length} markers carry a number, ${discarded.length} set aside`);

  // ---- Stage 6: group by digit SHAPE, then read the average of each group --
  //
  // The digits are 10-15 pixels tall, below what any OCR engine reads
  // dependably. But the noise on one marker is independent of the noise on the
  // next while the digit itself is not, so the AVERAGE of a few hundred
  // instances is sharp where every individual one is mush. Markers are matched
  // against each other rather than against a typeface, which also means nothing
  // here depends on a kit using the ink colours we happened to expect.
  report('clustering', 0);
  t = now();
  const shapes = clusterGlyphs(crops);
  markers.forEach((m, i) => {
    m.shapeGroup = shapes.assignment[i];
  });
  timings.clustering = now() - t;
  report('clustering', 1, `${shapes.clusters.length} distinct digits found`);
  await tick();

  report('reading', 0);
  t = now();
  const factory = opts.classifierFactory ?? createClassifier;
  const choice = await factory(settings.useTesseract, settings.allowedNumbers);

  // One read per DISTINCT DIGIT, on a clean averaged picture — typically half a
  // dozen calls for an image holding several hundred markers.
  const prototypeCrops = shapes.clusters.map((c) => prototypeAsCrop(c, crops[c.members[0]]));
  const prototypeReadings = prototypeCrops.length
    ? await choice.classifier.classify(prototypeCrops, (done, total) =>
        report('reading', done / Math.max(1, total), `${done}/${total} distinct digits read`),
      )
    : [];
  let markersRead = prototypeCrops.length;

  const shapeGroups: ShapeGroup[] = shapes.clusters.map((c, i) => ({
    index: c.index,
    number: prototypeReadings[i]?.value ?? null,
    confidence: prototypeReadings[i]?.confidence ?? 0,
    count: c.members.length,
    sharpness: c.sharpness,
    spread: c.spread,
    glyphCount: c.glyphCount,
    prototype: Array.from(c.prototype),
  }));

  // Markers whose digit could not be isolated have nothing to match, so they
  // are read on their own rather than being guessed at.
  if (shapes.unreadable.length > 0) {
    report('reading', 0.9, `reading ${shapes.unreadable.length} unmatched markers`);
    const extra = await choice.classifier.classify(shapes.unreadable.map((i) => crops[i]));
    shapes.unreadable.forEach((markerIndex, k) => applyReading(markers[markerIndex], extra[k]));
    markersRead += shapes.unreadable.length;
  }
  await choice.classifier.dispose();
  timings.reading = now() - t;
  await tick();

  // Every member of a shape group inherits its group's reading.
  markers.forEach((m, i) => {
    const g = shapes.assignment[i];
    if (g < 0) return;
    const group = shapeGroups[g];
    m.ocrPrediction = group.number;
    m.ocrConfidence = group.confidence;
    m.glyphCount = crops[i].glyphs.length;
  });

  const active = activeNumbersFromShapes(shapeGroups, markers.length, settings.allowedNumbers);
  const allowedSet = new Set(active.numbers);

  const histogram = new Array(10).fill(0);
  for (const m of markers) histogram[Math.min(9, Math.floor((m.ocrConfidence ?? 0) * 10))]++;

  // Assign from the shape groups.
  let groupAssigned = 0;
  markers.forEach((m, i) => {
    const g = shapes.assignment[i];
    if (g < 0) return;
    const group = shapeGroups[g];
    if (group.number === null || !allowedSet.has(group.number)) {
      m.finalNumber = null;
      m.finalConfidence = 'review';
      m.finalScore = 0.2;
      m.classificationMethod = 'unknown';
      m.needsReview = true;
      m.reason = `Its digit matches a group of ${group.count} markers that could not be identified.`;
      return;
    }
    groupAssigned++;
    m.finalNumber = group.number;
    m.classificationMethod = 'group';
    m.needsReview = false;
    // A big, sharp group read confidently is strong evidence; a small or fuzzy
    // one is not, and says so rather than pretending.
    const strength = Math.min(1, group.count / 20) * group.sharpness * Math.max(0.4, group.confidence);
    m.finalScore = Math.max(0.5, Math.min(1, 0.5 + 0.5 * strength));
    m.finalConfidence = strength >= 0.45 ? 'high' : 'medium';
    m.reason =
      `Its digit matches ${group.count} markers whose averaged shape reads as ${group.number} ` +
      `(${Math.round(group.confidence * 100)}% on the averaged picture).`;
  });

  // ---- Stage 7: resolve the markers no shape group claimed -----------------
  report('resolving', 0);
  t = now();
  const medianRadius = markers.length ? median(markers.map((m) => m.radius)) : 0;
  const ctx: ResolveContext = { settings, medianRadius };
  for (const i of shapes.unreadable) resolveMarker(markers[i], ctx);
  timings.resolving = now() - t;
  report('resolving', 1);
  await tick();

  // ---- Stage 9: global consistency -----------------------------------------
  report('verifying', 0);
  t = now();
  const consistency = enforceGlobalConsistency(markers, active);
  const possibleMissed = findPossibleMissed(detection.nearMisses, markers);
  timings.verifying = now() - t;
  report('verifying', 1);
  await tick();

  report('counting', 1);
  report('done', 1);

  return {
    markers,
    possibleMissed,
    discarded,
    settings,
    stats: {
      candidatesProposed: detection.proposed,
      candidatesRejected: detection.rejected + sized.dropped.length + isolation.dropped.length,
      duplicatesMerged: deduped.merged,
      finalMarkers: markers.length,
      estimatedRadius: detection.radius / prepared.scale,
      workingScale: prepared.scale,
      imageWidth: original.width,
      imageHeight: original.height,
      ocrEngine: choice.warning ? `${choice.engine} (fallback)` : choice.engine,
      ocrConfidenceHistogram: histogram,
      activeNumbers: active.numbers,
      activeNumbersSource: active.source,
      outOfVocabularyReadings: consistency.outOfVocabulary,
      clusterCorrected: consistency.clusterCorrected,
      isolatedRejected: isolation.dropped.length,
      markersRead,
      shapeGroups,
      groupAssigned,
      unmatchedMarkers: shapes.unreadable.length,
      discardedWithoutDigit: discarded.length,
      detectionYield: chosen.yield,
      detectionSensitivity: chosen.sensitivity,
      durationMs: now() - started,
      stageTimings: timings,
    },
  };
}

/**
 * Re-apply the user's corrections across the image.
 *
 * With classification driven by digit shape, a correction is worth propagating:
 * relabelling one marker tells us what its whole shape group is. This re-derives
 * the number set from the corrected labels and re-decides anything still
 * unresolved. No pixels are touched, so it is instant.
 */
export function refineWithCorrections(result: AnalysisResult): AnalysisResult {
  const markers = result.markers.map((m) => ({ ...m }));

  // A manual correction speaks for its whole shape group.
  const corrected = new Map<number, number>();
  for (const m of markers) {
    if (m.manualNumber == null || m.shapeGroup == null || m.shapeGroup < 0) continue;
    corrected.set(m.shapeGroup, m.manualNumber);
  }
  const shapeGroups = result.stats.shapeGroups.map((g) =>
    corrected.has(g.index) ? { ...g, number: corrected.get(g.index)!, confidence: 1 } : g,
  );
  for (const m of markers) {
    if (m.manualNumber != null || m.rejected) continue;
    if (m.shapeGroup == null || m.shapeGroup < 0) continue;
    const group = shapeGroups.find((g) => g.index === m.shapeGroup);
    if (!group || group.number === null) continue;
    if (m.finalNumber === group.number) continue;
    m.finalNumber = group.number;
    m.classificationMethod = 'group';
    m.needsReview = false;
    m.finalConfidence = 'high';
    m.finalScore = 1;
    m.reason = `Counted as ${group.number} from your correction to this digit group.`;
  }

  const active = activeNumbersFromShapes(shapeGroups, markers.length, result.settings.allowedNumbers);
  const medianRadius = markers.length ? median(markers.map((m) => m.radius)) : 0;
  const ctx: ResolveContext = { settings: result.settings, medianRadius };
  for (const m of markers) {
    if (m.finalNumber == null && !m.rejected && m.manualNumber == null) resolveMarker(m, ctx);
  }
  const consistency = enforceGlobalConsistency(markers, active);

  return {
    ...result,
    markers,
    stats: {
      ...result.stats,
      shapeGroups,
      activeNumbers: active.numbers,
      activeNumbersSource: active.source,
      outOfVocabularyReadings: consistency.outOfVocabulary,
      clusterCorrected: consistency.clusterCorrected,
    },
  };
}

/**
 * Fraction of a sample of candidates that contain an isolatable digit.
 *
 * Sampled rather than exhaustive: cropping every candidate at several strictness
 * settings would cost more than the rest of the pipeline, and a couple of
 * hundred is plenty to tell a good setting from a bad one.
 */
function glyphYield(original: RgbaImage, candidates: MarkerCandidate[], sample = 160): number {
  if (candidates.length === 0) return 0;
  const step = Math.max(1, Math.floor(candidates.length / sample));
  let seen = 0;
  let hits = 0;
  for (let i = 0; i < candidates.length; i += step) {
    seen++;
    if (cropMarker(original, candidates[i]).glyphs.length > 0) hits++;
  }
  return seen === 0 ? 0 : hits / seen;
}

/** Copy one classifier result onto a marker. */
function applyReading(marker: MarkerDetection, reading: ClassificationOutput | undefined): void {
  if (!reading) return;
  marker.ocrPrediction = reading.value;
  marker.ocrConfidence = reading.confidence;
  marker.ocrAttempts = reading.attempts;
  marker.glyphCount = reading.glyphCount;
  marker.ocrRanked = reading.ranked;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
