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
