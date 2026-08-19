/**
 * Shared vocabulary for the whole marker-counting pipeline.
 *
 * Every stage (detection -> dedup -> crop -> OCR -> colour -> resolve) reads and
 * writes the same `MarkerDetection` record, adding fields as it goes. Keeping
 * one record type means any stage can be swapped out or inspected on its own.
 */

/** The numbers a marker may contain. */
export const SUPPORTED_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type MarkerNumber = (typeof SUPPORTED_NUMBERS)[number];

export type ConfidenceLevel = 'high' | 'medium' | 'review';

export type ClassificationMethod =
  | 'ocr'
  | 'ocr+color'
  | 'color'
  | 'manual'
  | 'unknown';

export interface RingColor {
  r: number;
  g: number;
  b: number;
  h: number;
  s: number;
  v: number;
  lab: [number, number, number];
  /** Spread of the sampled ring pixels in Lab units; high means a noisy sample. */
  spread: number;
  /** Number of pixels that contributed to the median. */
  samples: number;
}

/** One attempt at reading the digit, from one preprocessing variant. */
export interface OcrAttempt {
  variant: string;
  engine: string;
  value: number | null;
  confidence: number;
  raw: string;
}

/** Geometry + quality produced by the detector, before any classification. */
export interface MarkerCandidate {
  id: string;
  /** Centre in ORIGINAL image pixel coordinates. */
  x: number;
  y: number;
  /** Bounding box in ORIGINAL image pixel coordinates. */
  width: number;
  height: number;
  /** Estimated marker radius in original-image pixels. */
  radius: number;
  /** 0..1 — how much this looks like a ringed marker (radial profile match). */
  detectionScore: number;
  /** Which generator proposed it. Useful when tuning the detector. */
  source: 'radial-symmetry' | 'contour' | 'manual' | 'recovered';
  /** Diagnostics from the radial profile test. */
  profile?: RadialProfile;
}

export interface RadialProfile {
  /** Bright-percentile intensity of the marker's light centre. */
  centerBright: number;
  /** Dark-percentile intensity inside the centre — the printed digit. */
  centerDark: number;
  /** Mean intensity of the ring annulus. */
  ring: number;
  /** Mean intensity just outside the marker. */
  surround: number;
  /** Fraction of ring samples that differ from the centre. 0..1 */
  ringClosure: number;
  /** How circular the ring response is (1 = perfectly round). */
  circularity: number;
  /** Height/width of the fitted ellipse. */
  aspect: number;
}

export interface MarkerDetection extends MarkerCandidate {
  ocrPrediction?: number | null;
  ocrConfidence?: number;
  ocrAttempts?: OcrAttempt[];
  /** True when the digit isolator found two glyphs (candidate for "10"). */
  glyphCount?: number;
  /** Index of the digit-shape group this marker was matched to, or -1. */
  shapeGroup?: number;
  /** All digit hypotheses, best first — lets a rejected reading fall back. */
  ocrRanked?: Array<{ value: number; score: number }>;

  ringColor?: RingColor;
  colorPrediction?: number | null;
  colorConfidence?: number;
  /** Perceptual distance (Delta E) to the learned colour for `colorPrediction`. */
  colorDistance?: number;
  /** Index into the discovered colour clusters, or -1. */
  colorCluster?: number;

  finalNumber?: number | null;
  finalConfidence: ConfidenceLevel;
  /** 0..1 numeric score behind `finalConfidence`, for sorting the review queue. */
  finalScore?: number;
  classificationMethod: ClassificationMethod;
  /** Human-readable explanation of how the final value was chosen. */
  reason?: string;
  /** Set by the user in the review UI; overrides everything. */
  manualNumber?: number | null;
  /** Marked by the user as "not a marker" — excluded from all counts. */
  rejected?: boolean;
  /** True while the marker still needs a human decision. */
  needsReview?: boolean;
}

/** A colour cluster discovered in this image (k-means over Lab). */
export interface ColorCluster {
  index: number;
  lab: [number, number, number];
  rgb: [number, number, number];
  size: number;
  /** Mean Delta E of members to the centroid. */
  spread: number;
  /** Number assigned via OCR-confirmed members, or null when unmapped. */
  assignedNumber: number | null;
  /** Fraction of OCR-confirmed members that agreed on `assignedNumber`. */
  purity: number;
}

/** Learned "number -> typical ring colour" model, built from this image alone. */
export interface ColorModelEntry {
  number: number;
  lab: [number, number, number];
  rgb: [number, number, number];
  /** Robust spread (median absolute Delta E) of the training samples. */
  spread: number;
  samples: number;
}

export interface ColorModel {
  entries: ColorModelEntry[];
  /** Smallest Delta E between any two learned colours — how separable they are. */
  minSeparation: number;
  trained: boolean;
}

export interface DetectorSettings {
  /**
   * The numbers this image actually uses, e.g. [1, 2, 3, 4].
   *
   * `null` means "work it out from the image". When set it is a HARD
   * constraint: the OCR engine is restricted to those digits and no marker may
   * be classified as anything else. Kits come with a legend, so this is one tap
   * for the user and by far the largest single accuracy lever available.
   */
  allowedNumbers: number[] | null;
  /** 0..1. Higher finds more markers (and more false positives). */
  markerSensitivity: number;
  /** 0..1. Higher accepts weaker OCR readings. */
  ocrSensitivity: number;
  /** Expected marker diameter in original-image pixels; 0 = estimate it. */
  expectedMarkerSize: number;
  /** 0..1. How strongly learned colours may override or rescue weak OCR. */
  colorAssistStrength: number;
  /** Longest edge of the detection working copy, in pixels. */
  workingResolution: number;
  /** Try to load Tesseract; falls back to the built-in classifier if it fails. */
  useTesseract: boolean;
  /**
   * Let ring colour influence classification.
   *
   * Off by default: one mislabelled colour group is hundreds of wrong markers at
   * once, and the digit's shape is the thing actually being counted. Colour is
   * still measured, for the debug view and for markers with no readable digit.
   */
  useColorAssist: boolean;
}

export const DEFAULT_SETTINGS: DetectorSettings = {
  allowedNumbers: null,
  markerSensitivity: 0.5,
  ocrSensitivity: 0.5,
  expectedMarkerSize: 0,
  colorAssistStrength: 0.6,
  workingResolution: 2000,
  useTesseract: true,
  useColorAssist: false,
};

/** One distinct digit shape found in the image, and the number it reads as. */
export interface ShapeGroup {
  index: number;
  number: number | null;
  /** Confidence of reading the AVERAGED picture, not any single marker. */
  confidence: number;
  count: number;
  /** 0..1 — how consistently the members agree, i.e. how sharp the average is. */
  sharpness: number;
  /** Mean distance of members to the averaged shape, in pixels. */
  spread: number;
  glyphCount: number;
  /** Averaged glyph mask(s), 32x32 each, laid out side by side. */
  prototype: number[];
}

export interface PipelineStats {
  candidatesProposed: number;
  candidatesRejected: number;
  duplicatesMerged: number;
  finalMarkers: number;
  estimatedRadius: number;
  workingScale: number;
  imageWidth: number;
  imageHeight: number;
  ocrEngine: string;
  ocrConfidenceHistogram: number[];
  colorClusters: ColorCluster[];
  ocrColorDisagreements: number;
  colorRescued: number;
  /** Numbers the image was judged to actually contain. */
  activeNumbers: number[];
  /** How that set was arrived at. */
  activeNumbersSource: 'user' | 'inferred';
  /** Readings discarded because they named a number not in the active set. */
  outOfVocabularyReadings: number;
  /** Markers corrected (not merely flagged) by their colour group. */
  clusterCorrected: number;
  /** How many markers were actually put through the digit reader. */
  markersRead: number;
  /** Distinct digit shapes found, and what each was read as. */
  shapeGroups: ShapeGroup[];
  /** Markers counted from a shape group rather than an individual reading. */
  groupAssigned: number;
  /** Markers whose digit could not be isolated, so had to be read alone. */
  unmatchedMarkers: number;
  /** Detections set aside because they contained no digit at all. */
  discardedWithoutDigit: number;
  /** Fraction of detections that carried a digit at the chosen strictness. */
  detectionYield: number;
  /** The strictness the calibration settled on. */
  detectionSensitivity: number;
  /** Detections dropped because nothing marker-like sat near them. */
  isolatedRejected: number;
  durationMs: number;
  stageTimings: Record<string, number>;
}

export interface AnalysisResult {
  markers: MarkerDetection[];
  possibleMissed: MarkerCandidate[];
  /**
   * Detections set aside because they held no digit.
   *
   * Kept apart from `possibleMissed` so the results screen can report them as
   * what they are -- things that turned out not to be markers -- instead of
   * presenting a thousand rejected shapes as outstanding work.
   */
  discarded: MarkerCandidate[];
  colorModel: ColorModel;
  stats: PipelineStats;
  settings: DetectorSettings;
}

export type PipelineStage =
  | 'preparing'
  | 'detecting'
  | 'deduplicating'
  | 'cropping'
  | 'reading'
  | 'colors'
  | 'clustering'
  | 'resolving'
  | 'verifying'
  | 'counting'
  | 'done';

export interface ProgressUpdate {
  stage: PipelineStage;
  label: string;
  /** 0..1 overall progress. */
  progress: number;
  detail?: string;
}

export interface CountSummary {
  total: number;
  counts: Map<number, number>;
  highConfidence: number;
  mediumConfidence: number;
  needsReview: number;
  rejected: number;
}
