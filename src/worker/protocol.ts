import type { TransferableImage } from '../core/imageLoader.ts';
import type { AnalysisResult, DetectorSettings, ProgressUpdate } from '../core/types.ts';

/** A marker the user identified by hand, in original-image coordinates. */
export interface ExemplarPoint {
  digit: number;
  x: number;
  y: number;
}

export interface AnalyzeRequest {
  type: 'analyze';
  /** The pixel buffer is transferred, not copied — the worker hands it back. */
  image: TransferableImage;
  settings: DetectorSettings;
  /**
   * Examples the user marked, one per digit.
   *
   * The point is snapped to the nearest detected marker inside the pipeline, so
   * the UI only has to report roughly where the user tapped.
   */
  exemplars?: ExemplarPoint[];
}

export type WorkerRequest = AnalyzeRequest;

export type WorkerResponse =
  | { type: 'progress'; update: ProgressUpdate }
  | { type: 'result'; result: AnalysisResult; image: TransferableImage }
  | { type: 'error'; message: string; image?: TransferableImage };
