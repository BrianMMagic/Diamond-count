import type { MarkerCrop } from '../markerCropper.ts';
import type { OcrAttempt } from '../types.ts';

export interface ClassificationOutput {
  /** 1..10, or null when nothing plausible was read. */
  value: number | null;
  /** 0..1. */
  confidence: number;
  /** Every preprocessing/engine attempt, for the debug view. */
  attempts: OcrAttempt[];
  /** How many separate glyphs the isolator found. */
  glyphCount: number;
  /**
   * Every digit hypothesis, best first.
   *
   * Without this a reading of "7" in an image that only contains 1-4 can only
   * be thrown away; with it, the resolver can drop to the best candidate that
   * the image actually uses instead of falling back to colour alone.
   */
  ranked: Array<{ value: number; score: number }>;
}

/** Restricts an engine to the digits an image actually uses. */
export interface ClassifierOptions {
  /** null = all of 1..10. */
  allowedNumbers: number[] | null;
}

/**
 * The single seam behind which digit recognition lives.
 *
 * Anything that can turn a marker crop into a number fits here: the built-in
 * template matcher, Tesseract, or a future TensorFlow.js / ONNX digit model.
 * Nothing outside this folder knows which engine produced a reading.
 */
export interface NumberClassifier {
  readonly name: string;
  /** Load models/workers. Must be safe to call twice. */
  init(): Promise<void>;
  /** Narrow the engine to a known number set. Safe to call before `init`. */
  setAllowedNumbers(allowed: number[] | null): void;
  /** Batch API so engines with per-call overhead can amortise it. */
  classify(
    crops: MarkerCrop[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassificationOutput[]>;
  dispose(): Promise<void>;
}

/** Convenience wrapper for one marker, as described in the spec. */
export async function classifyMarkerNumber(
  classifier: NumberClassifier,
  crop: MarkerCrop,
): Promise<ClassificationOutput> {
  await classifier.init();
  const [result] = await classifier.classify([crop]);
  return result;
}

/** Only 1..10 are meaningful for these markers. */
export function isPlausible(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 10;
}

/** Normalise an allowed-number list, or null when it constrains nothing. */
export function normalizeAllowed(allowed: number[] | null | undefined): Set<number> | null {
  if (!allowed || allowed.length === 0) return null;
  const set = new Set(allowed.filter((n) => isPlausible(n)));
  return set.size === 0 || set.size >= 10 ? null : set;
}
