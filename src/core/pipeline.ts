/**
 * The whole analysis, stage by stage.
 *
 * Each stage is a separate module so it can be tested, profiled and replaced on
 * its own; this function only sequences them and reports progress.
 *
 * The order embodies one decision. An image holds a handful of distinct markers,
 * not several hundred independent puzzles, so nothing here ever reads the digit
 * on an individual marker. Detection isolates each glyph, the glyphs are grouped
 * by shape, each group is averaged, and only the averages are read — six reads
 * for six hundred markers. A reader's error rate then lands once per distinct
 * digit instead of scattering across every marker on the card, and a correction
 * from the user lands the same way.
 */
import type { RgbaImage } from './cv/image.ts';
import { toGray } from './cv/color.ts';
import { detectGlyphs, detectMarkers, invertGray } from './glyphDetector.ts';
import type { GlyphDetection } from './glyphDetector.ts';
import { extractGlyph } from './glyphShape.ts';
import type { GlyphMask } from './glyphShape.ts';
import { clusterGlyphs, membershipMargin } from './glyphClusters.ts';
import { estimateSpacing } from './spacing.ts';
import { readPrototype } from './prototypeReader.ts';
import { matchExemplar, exemplarDigits } from './exemplars.ts';
import type { Exemplar, ExemplarMatch } from './exemplars.ts';
import { sampleRim } from './markerColor.ts';
import type {
  AnalysisResult,
  ConfidenceLevel,
  DetectorSettings,
  MarkerCandidate,
  MarkerDetection,
  PipelineStage,
  ProgressUpdate,
  ShapeGroup,
} from './types.ts';
import type { NumberClassifier } from './classifier/index.ts';

export interface PipelineOptions {
  settings: DetectorSettings;
  onProgress?: (update: ProgressUpdate) => void;
  /**
   * Kept so existing callers and tests compile unchanged.
   *
   * Nothing in the pipeline uses it any more: the digit is read from averaged
   * prototypes by the built-in stroke matcher, a few reads per image, and an
   * OCR engine fetched from a CDN cannot beat that while also making an
   * otherwise offline app depend on the network.
   */
  classifierFactory?: (
    useTesseract: boolean,
    allowedNumbers: number[] | null,
  ) => Promise<{ classifier: NumberClassifier; engine: string; warning?: string }>;
  /**
   * Markers the user has identified by hand, one per digit.
   *
   * Supplied as points; the glyph and bead colour at each point are measured
   * here so the caller does not have to know how either is done. When present
   * they replace the built-in reader entirely — a digit nobody pointed at
   * cannot be produced.
   */
  exemplars?: Array<{ digit: number; x: number; y: number }>;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  preparing: 'Preparing image',
  detecting: 'Finding markers',
  deduplicating: 'Removing duplicates',
  cropping: 'Extracting digits',
  reading: 'Reading numbers',
  clustering: 'Grouping digits',
  resolving: 'Combining evidence',
  verifying: 'Verifying detections',
  counting: 'Counting',
  done: 'Done',
};

const STAGE_RANGE: Record<PipelineStage, [number, number]> = {
  preparing: [0, 0.06],
  detecting: [0.06, 0.55],
  deduplicating: [0.55, 0.56],
  cropping: [0.56, 0.78],
  clustering: [0.78, 0.9],
  reading: [0.9, 0.96],
  resolving: [0.96, 0.97],
  verifying: [0.97, 0.98],
  counting: [0.98, 1],
  done: [1, 1],
};

/**
 * How much an averaged prototype must resemble a digit to be named without
 * being asked about. Real digits on the reference card scored 0.80 and above;
 * clusters of blurred fur that survived detection scored 0.53 and 0.67.
 */
const MIN_PROTOTYPE_SIMILARITY = 0.72;

/**
 * How unlike every marked example a detection may be and still be a marker.
 *
 * Some of what survives detection is not a marker at all — fur texture that
 * happened to read as dark ink on a bright face. Given examples to compare
 * against, those are not merely uncertain, they are plainly different: across
 * the reference card 99% of real markers sat within 0.56 of an example, while
 * the ones a person could see were not numbers sat at 1.78.
 *
 * Anything past this is set aside rather than counted, because "we do not know
 * which number this is" and "this is not a number" deserve different answers.
 * Queuing them asks the user to name fur, and counting them inflates the total.
 *
 * It is a floor, not the whole rule. How far a real marker sits from an example
 * depends on the card: sharp digits on one photograph put 99% of real markers
 * inside 0.56, while smaller, blurrier digits on another put the MEDIAN at 1.09,
 * and a fixed cut applied there discarded a third of the card. So the working
 * threshold is whichever is more forgiving — this floor, or an outlier fence
 * drawn from the card's own spread.
 */
const MAX_EXEMPLAR_DISTANCE = 1.4;

/** Distance past which a marker is unlike this card's markers generally. */
function rejectionDistance(distances: number[]): number {
  if (distances.length < 20) return MAX_EXEMPLAR_DISTANCE;
  const sorted = [...distances].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  const q1 = at(0.25);
  const q3 = at(0.75);
  return Math.max(MAX_EXEMPLAR_DISTANCE, q3 + 3 * (q3 - q1));
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  //
  // Detection runs at full resolution. The digit is the thing being detected and
  // it is only around 30 pixels tall to begin with; the old working copy capped
  // the longest edge at 2000px, which on a phone photograph shrank it to 16 and
  // threw away the signal the whole pipeline depends on.
  report('preparing', 0);
  let t = now();
  const gray = toGray(original);
  timings.preparing = now() - t;
  report('preparing', 1, `${original.width} x ${original.height}`);
  await tick();

  // ---- Stage 2: marker spacing ----------------------------------------------
  //
  // Spacing sets the size of every window downstream, so a wrong value here is
  // not recoverable later. A calibrated value from the user is used as given;
  // otherwise it is measured from the image's own periodicity.
  const declaredPitch = settings.expectedMarkerSize > 0 ? settings.expectedMarkerSize / 0.92 : 0;
  const spacing = declaredPitch > 0
    ? { pitch: declaredPitch, source: 'declared' as const, found: 0 }
    : estimateSpacing(gray);
  const pitch = spacing.pitch;
  if (!(pitch > 4)) {
    return emptyResult(original, settings, started, timings, pitch);
  }

  // ---- Stage 3: detection ---------------------------------------------------
  report('detecting', 0);
  t = now();
  // Look for the ordinary kind of marker first: a dark digit on a light face.
  //
  // The other kind — a light digit on a dark face — is found by inverting the
  // image, but that is not done speculatively. Inverting an ordinary card turns
  // every marker's own face into something that reads as a glyph, so the
  // inverted pass always returns plenty, and merging those impostors displaces
  // real markers. What makes it safe to look is the user marking an example on
  // a marker this pass cannot see: that is proof the card has a second polarity,
  // and it needs no threshold to interpret.
  let detections = detectGlyphs(gray, { pitch });
  if (opts.exemplars?.some((e) => !nearestDetection(detections, e.x, e.y, pitch))) {
    detections = detectMarkers(gray, { pitch });
  }
  // Markers found on the inverted copy must be read from it too.
  const grayInverted = detections.some((d) => d.inverted) ? invertGray(gray) : gray;
  timings.detecting = now() - t;
  report('detecting', 1, `${detections.length} markers`);
  await tick();

  // ---- Stage 4: isolate each digit ------------------------------------------
  report('cropping', 0);
  t = now();
  const glyphs: GlyphMask[] = [];
  const withGlyph: GlyphDetection[] = [];
  const withoutGlyph: GlyphDetection[] = [];
  detections.forEach((d, i) => {
    const g = extractGlyph(d.inverted ? grayInverted : gray, d, pitch);
    if (g) {
      glyphs.push(g);
      withGlyph.push(d);
    } else {
      withoutGlyph.push(d);
    }
    if (i % 128 === 0) report('cropping', i / Math.max(1, detections.length));
  });
  timings.cropping = now() - t;
  report('cropping', 1, `${glyphs.length} digits isolated`);
  await tick();

  // ---- Stage 4b: measure the markers the user identified ---------------------
  const exemplars: Exemplar[] = [];
  for (const e of opts.exemplars ?? []) {
    const near = nearestDetection(detections, e.x, e.y, pitch);
    if (!near) continue;
    const glyph = extractGlyph(near.inverted ? grayInverted : gray, near, pitch);
    if (!glyph) continue;
    exemplars.push({
      digit: e.digit,
      x: near.x,
      y: near.y,
      glyph,
      rim: sampleRim(original, near.x, near.y, pitch),
    });
  }

  // ---- Stage 5: group by shape ----------------------------------------------
  report('clustering', 0);
  t = now();
  const clusters = clusterGlyphs(glyphs);
  timings.clustering = now() - t;
  report('clustering', 1, `${clusters.length} distinct digits`);
  await tick();

  // ---- Stage 6: read one averaged picture per group -------------------------
  report('reading', 0);
  t = now();
  const declared = exemplars.length > 0 ? exemplarDigits(exemplars) : settings.allowedNumbers;
  const allowed = declared && declared.length > 0 ? new Set(declared) : null;
  const prototypes = clusters.map((c) => c.prototype);
  const groups: ShapeGroup[] = clusters.map((c, index) => {
    const reading = readPrototype(c.prototype, allowed);
    // A shape that is not a digit still has a best match, so refusing to name
    // it has to be decided on how well it matches, not on which digit won.
    // Named wrongly, a group of things that are not markers is counted in
    // silence; left unnamed it arrives on the results screen as a picture the
    // user can see is not a number, and reject in one tap.
    const identified = reading.similarity >= MIN_PROTOTYPE_SIMILARITY;
    // The group's own name comes from shape alone; individual markers in it are
    // then named with their colour as well, so a group can legitimately hold
    // markers of more than one digit once exemplars are in play.
    const byExample = exemplars.length > 0
      ? matchExemplar(c.prototype, averageRim(original, c.members.map((i) => withGlyph[i]), pitch), exemplars)
      : null;
    return {
      index,
      number: byExample ? byExample.digit : identified ? reading.value : null,
      confidence: byExample ? byExample.margin : reading.confidence,
      count: c.members.length,
      // A tight group is a sharp average. Spread is already a 0-1 shape
      // distance, so sharpness is simply its complement.
      sharpness: Math.max(0, Math.min(1, 1 - c.spread * 2.5)),
      spread: c.spread,
      glyphCount: 1,
      prototype: Array.from(c.prototype.data, (v) => Math.round(v * 255)),
    };
  });
  timings.reading = now() - t;
  report('reading', 1, `${groups.length} digits read`);
  await tick();

  // ---- Stage 7: build the markers -------------------------------------------
  report('counting', 0);
  const radius = pitch * 0.46;
  // How far from an example is too far has to be judged against this card, so
  // every marker is measured before any is rejected.
  const rejectAbove = exemplars.length > 0
    ? rejectionDistance(
        clusters.flatMap((c) =>
          c.members.map(
            (i) =>
              matchExemplar(c.prototype, sampleRim(original, withGlyph[i].x, withGlyph[i].y, pitch), exemplars)
                .distance,
          ),
        ),
      )
    : MAX_EXEMPLAR_DISTANCE;
  const markers: MarkerDetection[] = [];
  /** Detections that turned out not to resemble any number the user marked. */
  const notMarkers: MarkerCandidate[] = [];
  clusters.forEach((cluster, groupIndex) => {
    const group = groups[groupIndex];
    for (const memberIndex of cluster.members) {
      const d = withGlyph[memberIndex];
      const margin = membershipMargin(glyphs[memberIndex], prototypes);

      // With examples to go on, each marker is named individually: the shape of
      // the group it belongs to, which is sharp, plus the colour of this marker,
      // which is what tells it apart from its neighbours in that group. Shape
      // alone had grouped seven plain `1`s, `2`s and `3`s in with the `4`s on the
      // reference card, and no amount of naming the group could have saved them.
      const match = exemplars.length > 0
        ? matchExemplar(cluster.prototype, sampleRim(original, d.x, d.y, pitch), exemplars)
        : null;
      if (match && match.distance > rejectAbove) {
        notMarkers.push(baseCandidate(d, radius, `x${notMarkers.length}`));
        continue;
      }
      const number = match ? match.digit : group.number;
      const score = match ? match.margin : margin;
      const level = match ? confidenceOfMatch(match) : confidenceOf(group, margin);

      markers.push({
        ...baseCandidate(d, radius, `m${markers.length}`),
        shapeGroup: groupIndex,
        finalNumber: number,
        finalScore: score,
        finalConfidence: level,
        classificationMethod: number == null ? 'unknown' : 'group',
        needsReview: number == null || level === 'review',
        reason:
          number == null
            ? `Digit shape group ${groupIndex} has not been named yet`
            : match
              ? `Matched the example you marked as ${number}, on shape and bead colour`
              : `Matched digit shape group ${groupIndex}, read as ${number} from the average of ${cluster.members.length} markers`,
      });
    }
  });

  // The groups were named before any marker was, so where colour has since moved
  // markers out of a group, say so rather than reporting the group's size as a
  // count of its number.
  for (const g of groups) {
    g.assignedCount = markers.filter((m) => m.shapeGroup === g.index && m.finalNumber === g.number).length;
  }

  // Detections whose digit could not be isolated are not counted and not queued
  // as work. They are reported as what they are: things that turned out not to
  // carry a number.
  const discarded: MarkerCandidate[] = [
    ...withoutGlyph.map((d, i) => baseCandidate(d, radius, `d${i}`)),
    ...notMarkers,
  ];

  const durationMs = now() - started;
  report('done', 1);

  return {
    markers,
    possibleMissed: [],
    discarded,
    settings,
    stats: {
      candidatesProposed: detections.length,
      candidatesRejected: withoutGlyph.length + notMarkers.length,
      duplicatesMerged: 0,
      finalMarkers: markers.length,
      estimatedRadius: radius,
      workingScale: 1,
      imageWidth: original.width,
      imageHeight: original.height,
      ocrEngine: 'template',
      ocrConfidenceHistogram: histogram(groups),
      activeNumbers: [...new Set(groups.map((g) => g.number).filter((n): n is number => n != null))].sort(
        (a, b) => a - b,
      ),
      activeNumbersSource: allowed ? 'user' : 'inferred',
      outOfVocabularyReadings: 0,
      clusterCorrected: 0,
      markersRead: groups.length,
      shapeGroups: groups,
      groupAssigned: markers.length,
      unmatchedMarkers: 0,
      discardedWithoutDigit: withoutGlyph.length + notMarkers.length,
      detectionYield: detections.length > 0 ? glyphs.length / detections.length : 0,
      detectionSensitivity: 0.5,
      isolatedRejected: 0,
      durationMs,
      stageTimings: timings,
    },
  };
}

/**
 * Re-apply the user's corrections.
 *
 * Naming or rejecting a group settles every marker in it at once, so this walks
 * the groups rather than the markers. There is nothing to re-learn and no pixels
 * to touch: the grouping is what the analysis produced, and the user is
 * supplying the one thing it could not work out for itself.
 */
export function refineWithCorrections(result: AnalysisResult): AnalysisResult {
  const groups = result.stats.shapeGroups;
  const markers = result.markers.map((marker) => {
    if (marker.manualNumber != null || marker.rejected) return marker;
    const group = groups[marker.shapeGroup ?? -1];
    if (!group) return marker;
    const margin = marker.finalScore ?? 1;
    return {
      ...marker,
      finalNumber: group.number,
      finalConfidence: confidenceOf(group, margin),
      classificationMethod: group.number == null ? ('unknown' as const) : ('group' as const),
      needsReview: group.number == null || confidenceOf(group, margin) === 'review',
    };
  });
  return { ...result, markers };
}

/**
 * How much a marker's own membership can be trusted.
 *
 * Two independent things can go wrong: the group may be incoherent, or this
 * marker may sit between two groups. Both have to be good for a marker to pass
 * without being looked at.
 */
/**
 * How far a marker sat from the example it was matched to.
 *
 * Distance decides first: a marker unlike every example the user gave is worth
 * looking at however clearly it beat the runner-up. The margin then catches the
 * marker that sits between two examples.
 */
function confidenceOfMatch(match: ExemplarMatch): ConfidenceLevel {
  if (match.digit == null) return 'review';
  if (match.distance > 1.4 || match.margin < 0.05) return 'review';
  if (match.distance > 0.9 || match.margin < 0.15) return 'medium';
  return 'high';
}

/** Mean rim colour across a group, for naming the group as a whole. */
function averageRim(image: RgbaImage, members: GlyphDetection[], pitch: number) {
  const sums = [0, 0, 0];
  for (const d of members) {
    const c = sampleRim(image, d.x, d.y, pitch);
    sums[0] += c[0] / members.length;
    sums[1] += c[1] / members.length;
    sums[2] += c[2] / members.length;
  }
  return sums as [number, number, number];
}

/** The detection closest to where the user tapped, within one marker. */
function nearestDetection(
  detections: GlyphDetection[],
  x: number,
  y: number,
  pitch: number,
): GlyphDetection | null {
  let best: GlyphDetection | null = null;
  let bestD = pitch * 0.75;
  for (const d of detections) {
    const dist = Math.hypot(d.x - x, d.y - y);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

function confidenceOf(group: ShapeGroup, margin: number): ConfidenceLevel {
  if (group.number == null) return 'review';
  if (group.sharpness < 0.35 || margin < 0.08) return 'review';
  if (group.sharpness < 0.6 || margin < 0.2 || group.count < 3) return 'medium';
  return 'high';
}

function baseCandidate(d: GlyphDetection, radius: number, id: string): MarkerCandidate & {
  finalConfidence: ConfidenceLevel;
  classificationMethod: 'unknown';
} {
  return {
    id,
    x: d.x,
    y: d.y,
    width: radius * 2,
    height: radius * 2,
    radius,
    detectionScore: Math.max(0, Math.min(1, d.score / 200)),
    source: 'contour',
    finalConfidence: 'review',
    classificationMethod: 'unknown',
  };
}

function histogram(groups: ShapeGroup[]): number[] {
  const bins = new Array(10).fill(0);
  for (const g of groups) {
    const b = Math.min(9, Math.max(0, Math.floor(g.confidence * 10)));
    bins[b] += g.count;
  }
  return bins;
}

function emptyResult(
  original: RgbaImage,
  settings: DetectorSettings,
  started: number,
  timings: Record<string, number>,
  pitch: number,
): AnalysisResult {
  return {
    markers: [],
    possibleMissed: [],
    discarded: [],
    settings,
    stats: {
      candidatesProposed: 0,
      candidatesRejected: 0,
      duplicatesMerged: 0,
      finalMarkers: 0,
      estimatedRadius: Math.max(0, pitch * 0.46),
      workingScale: 1,
      imageWidth: original.width,
      imageHeight: original.height,
      ocrEngine: 'template',
      ocrConfidenceHistogram: new Array(10).fill(0),
      activeNumbers: [],
      activeNumbersSource: 'inferred',
      outOfVocabularyReadings: 0,
      clusterCorrected: 0,
      markersRead: 0,
      shapeGroups: [],
      groupAssigned: 0,
      unmatchedMarkers: 0,
      discardedWithoutDigit: 0,
      detectionYield: 0,
      detectionSensitivity: 0.5,
      isolatedRejected: 0,
      durationMs: now() - started,
      stageTimings: timings,
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
