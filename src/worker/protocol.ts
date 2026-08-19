import type { TransferableImage } from '../core/imageLoader.ts';
import type { AnalysisResult, DetectorSettings, ProgressUpdate } from '../core/types.ts';

export interface AnalyzeRequest {
  type: 'analyze';
  /** The pixel buffer is transferred, not copied — the worker hands it back. */
  image: TransferableImage;
  settings: DetectorSettings;
}

export type WorkerRequest = AnalyzeRequest;

export type WorkerResponse =
  | { type: 'progress'; update: ProgressUpdate }
  | { type: 'result'; result: AnalysisResult; image: TransferableImage }
  | { type: 'error'; message: string; image?: TransferableImage };
