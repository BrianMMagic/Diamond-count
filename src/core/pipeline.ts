import type { RgbaImage } from './cv/image.ts';
import { median } from './cv/threshold.ts';
import { prepareImage } from './imagePreprocessor.ts';
import { detectMarkers, filterBySizeConsistency } from './markerDetector.ts';
import { deduplicate } from './markerDeduplicator.ts';
import { cropMarker } from './markerCropper.ts';
import type { MarkerCrop } from './markerCropper.ts';
import { createClassifier } from './classifier/index.ts';
import type { NumberClassifier } from './classifier/index.ts';
import { analyzeColors, learnColorModel } from './colorAnalyzer.ts';
import { assignClusterNumbers, clusterRingColors } from './colorClusterer.ts';
import { resolveMarker } from './classificationResolver.ts';
import {
  DEFAULT_INFER,
  activeNumbersFromShapes,
  enforceGlobalConsistency,
  inferActiveNumbers,
  rejectIsolatedDetections,
} from './globalConsistency.ts';
import type { ClassificationOutput } from './classifier/index.ts';
import { clusterGlyphs, prototypeAsCrop } from './glyphClusterer.ts';
import type { ShapeGroup } from './types.ts';
import type { ResolveContext } from './classificationResolver.ts';
import { findPossibleMissed } from './missedMarkerFinder.ts';
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
  colors: 'Analysing marker colours',
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
  colors: [0.8, 0.87],
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
  const detection = detectMarkers(prepared, {
    sensitivity: settings.markerSensitivity,
    expectedMarkerSize: settings.expectedMarkerSize,
    onProgress: (f, detail) => report('detecting', f, detail),
  });
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

  // ---- Stage 5: colour measurement -----------------------------------------
  // Colours depend only on geometry, so measuring them before recognition means
  // the colour groups are already available when a reading needs checking.
  report('colors', 0);
  t = now();
  analyzeColors(original, markers);
  timings.colors = now() - t;
  report('colors', 1);
  await tick();

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

  // Colour is measured for display and for the debug view, but it does not get
  // a vote: one mislabelled colour group is hundreds of wrong markers at once,
  // and the shape of the digit is the thing actually being counted.
  const colorModel = settings.useColorAssist ? learnColorModel(markers) : { entries: [], minSeparation: Infinity, trained: false };
  const clusters = clusterRingColors(markers);
  markers.forEach((m, i) => {
    m.colorCluster = clusters.assignment[i];
  });
  if (settings.useColorAssist) assignClusterNumbers(markers, clusters);

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
    m.classificationMethod = 'ocr';
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
  const ctx: ResolveContext = { model: colorModel, clusters, settings, medianRadius };
  for (const i of shapes.unreadable) resolveMarker(markers[i], ctx);
  timings.resolving = now() - t;
  report('resolving', 1);
  await tick();

  // ---- Stage 9: global consistency -----------------------------------------
  report('verifying', 0);
  t = now();
  const disagreements = markers.filter(
    (m) =>
      m.ocrPrediction != null &&
      m.colorPrediction != null &&
      m.ocrPrediction !== m.colorPrediction &&
      (m.colorConfidence ?? 0) > 0.5,
  ).length;
  // Colour may not overturn a shape group, so every colour group counts as
  // ambiguous here; this pass now only prunes values the image does not use.
  const consistency = enforceGlobalConsistency(
    markers,
    active,
    clusters,
    new Set(clusters.clusters.map((c) => c.index)),
  );
  const colorRescued = markers.filter((m) => m.classificationMethod === 'color').length;
  const possibleMissed = findPossibleMissed(detection.nearMisses, markers);
  timings.verifying = now() - t;
  report('verifying', 1);
  await tick();

  report('counting', 1);
  report('done', 1);

  return {
    markers,
    possibleMissed,
    colorModel,
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
      colorClusters: clusters.clusters,
      ocrColorDisagreements: disagreements,
      colorRescued,
      activeNumbers: active.numbers,
      activeNumbersSource: active.source,
      outOfVocabularyReadings: consistency.outOfVocabulary,
      clusterCorrected: consistency.clusterCorrected,
      isolatedRejected: isolation.dropped.length,
      markersRead,
      shapeGroups,
      groupAssigned,
      unmatchedMarkers: shapes.unreadable.length,
      durationMs: now() - started,
      stageTimings: timings,
    },
  };
}

/**
 * Re-learn colours and re-resolve using the corrections the user has made.
 *
 * Cheap (no pixels are touched) and surprisingly effective: a few manual fixes
 * sharpen the learned colour model, which in turn settles other uncertain
 * markers that share those colours.
 */
export function refineWithCorrections(result: AnalysisResult): AnalysisResult {
  const markers = result.markers;
  const teaching = markers.map((m) => ({
    ...m,
    ocrPrediction: m.manualNumber ?? m.ocrPrediction ?? null,
    ocrConfidence: m.manualNumber != null ? 1 : (m.ocrConfidence ?? 0),
  }));
  const colorModel = learnColorModel(teaching);
  const clusters = clusterRingColors(markers);
  markers.forEach((m, i) => {
    m.colorCluster = clusters.assignment[i];
  });
  assignClusterNumbers(teaching, clusters);
  const medianRadius = markers.length ? median(markers.map((m) => m.radius)) : 0;
  const ctx: ResolveContext = { model: colorModel, clusters, settings: result.settings, medianRadius };
  for (const m of markers) resolveMarker(m, ctx);
  const active = inferActiveNumbers(teaching, clusters, {
    ...DEFAULT_INFER,
    userSet: result.settings.allowedNumbers,
  });
  const consistency = enforceGlobalConsistency(markers, active, clusters);
  return {
    ...result,
    colorModel,
    stats: {
      ...result.stats,
      colorClusters: clusters.clusters,
      activeNumbers: active.numbers,
      activeNumbersSource: active.source,
      outOfVocabularyReadings: consistency.outOfVocabulary,
      clusterCorrected: consistency.clusterCorrected,
    },
  };
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
