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
  enforceGlobalConsistency,
  inferActiveNumbers,
  rejectIsolatedDetections,
} from './globalConsistency.ts';
import type { ClassificationOutput } from './classifier/index.ts';
import {
  applyGroups,
  assignGroupNumbers,
  groupSeparation,
  selectRepresentatives,
} from './groupClassifier.ts';
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

  // ---- Stage 6: group the markers, then read a sample of each group -------
  //
  // The digits are 10-15 pixels tall, which is below the height any OCR engine
  // reads dependably. An image contains a handful of DISTINCT markers though,
  // so instead of asking "what is this marker?" several hundred times and
  // accumulating the error rate, we ask "what is this group?" a few times and
  // answer it from the members that photographed most clearly.
  report('clustering', 0);
  t = now();
  let clusters = clusterRingColors(markers);
  markers.forEach((m, i) => {
    m.colorCluster = clusters.assignment[i];
  });
  timings.clustering = now() - t;
  report('clustering', 1, `${clusters.clusters.length} marker groups`);
  await tick();

  report('reading', 0);
  t = now();
  const factory = opts.classifierFactory ?? createClassifier;
  const choice = await factory(settings.useTesseract, settings.allowedNumbers);

  const representatives = selectRepresentatives(markers, clusters);
  const sampledIds = new Set(representatives.map((i) => markers[i].id));
  const readings = await choice.classifier.classify(
    representatives.map((i) => crops[i]),
    (done, total) => report('reading', done / Math.max(1, total), `${done}/${total} sampled markers read`),
  );
  representatives.forEach((markerIndex, k) => applyReading(markers[markerIndex], readings[k]));

  let groups = assignGroupNumbers(markers, clusters, sampledIds);
  assignClusterNumbers(markers, clusters);

  // Groups whose samples disagreed are not colour-separable — some kits reuse a
  // colour across two numbers — so their members get read individually after
  // all. This guard is what stops the group shortcut being a worse answer.
  //
  // These reads are deliberately UNCONSTRAINED by anything inferred so far: the
  // sample for this group is precisely the evidence that turned out to be
  // unreliable, so narrowing the engine to what it suggested would lock in its
  // mistake. Only a number set the user declared may constrain them.
  const provisional = applyGroups(markers, clusters, groups);
  let markersRead = representatives.length;
  const stragglers = provisional.needIndividualReading.filter((i) => !sampledIds.has(markers[i].id));
  if (stragglers.length > 0) {
    report('reading', 0.9, `reading ${stragglers.length} markers individually`);
    const extra = await choice.classifier.classify(stragglers.map((i) => crops[i]));
    stragglers.forEach((markerIndex, k) => applyReading(markers[markerIndex], extra[k]));
    markersRead += stragglers.length;
    for (const i of stragglers) sampledIds.add(markers[i].id);
  }
  await choice.classifier.dispose();
  timings.reading = now() - t;
  await tick();

  // Only now, with every reading that is going to happen already in hand, is it
  // safe to ask which numbers the image uses. Inferring it from the first
  // sample and then constraining later reads to that guess makes an early bias
  // self-fulfilling.
  const active = inferActiveNumbers(markers, clusters, {
    ...DEFAULT_INFER,
    userSet: settings.allowedNumbers,
  });
  const allowedSet = new Set(active.numbers);

  const colorModel = learnColorModel(markers);
  assignClusterNumbers(markers, clusters);
  groups = assignGroupNumbers(markers, clusters, sampledIds);
  for (const g of groups) {
    if (g.number !== null && !allowedSet.has(g.number)) {
      g.number = null;
      g.ambiguous = true;
      g.source = 'unresolved';
    }
  }
  const applied = applyGroups(markers, clusters, groups);

  const histogram = new Array(10).fill(0);
  for (const m of markers) histogram[Math.min(9, Math.floor((m.ocrConfidence ?? 0) * 10))]++;

  // ---- Stage 7: resolve whatever the groups could not settle ---------------
  // Only markers in ambiguous groups reach the per-marker evidence combiner;
  // for everything else the group has already answered.
  report('resolving', 0);
  t = now();
  const medianRadius = markers.length ? median(markers.map((m) => m.radius)) : 0;
  const ctx: ResolveContext = { model: colorModel, clusters, settings, medianRadius };
  for (const i of applied.needIndividualReading) resolveMarker(markers[i], ctx);
  for (const m of markers) {
    if (m.finalNumber == null && !m.rejected && m.manualNumber == null) resolveMarker(m, ctx);
  }
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
  const ambiguousGroups = new Set(groups.filter((g) => g.ambiguous).map((g) => g.index));
  const consistency = enforceGlobalConsistency(markers, active, clusters, ambiguousGroups);
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
      groups: groups.map((g) => ({
        index: g.index,
        number: g.number,
        count: g.count,
        rgb: g.rgb,
        purity: g.purity,
        sampled: g.sampled,
        ambiguous: g.ambiguous,
      })),
      groupSeparation: groupSeparation(clusters),
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
