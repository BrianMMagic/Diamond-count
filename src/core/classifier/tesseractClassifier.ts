import type { GrayImage } from '../cv/image.ts';
import type { MarkerCrop } from '../markerCropper.ts';
import type { OcrAttempt } from '../types.ts';
import { normalizeAllowed } from './types.ts';
import type { ClassificationOutput, NumberClassifier } from './types.ts';

type TessWorker = {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(image: unknown): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
};

/** Convert a grayscale tile into something tesseract.js can ingest. */
function toCanvas(img: GrayImage): OffscreenCanvas {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not available in this environment.');
  }
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not obtain a 2D context.');
  const data = ctx.createImageData(img.width, img.height);
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    data.data[j] = img.data[i];
    data.data[j + 1] = img.data[i];
    data.data[j + 2] = img.data[i];
    data.data[j + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/**
 * Tesseract-backed reader.
 *
 * It never sees the raw photo: by the time a crop gets here the digit has been
 * isolated, deskewed onto white and enlarged, which is the difference between
 * Tesseract being useful on 6-pixel print and being useless on it. Recognition
 * is locked to digits and to a single character (or a single word for the
 * two-glyph "10" case) so the engine cannot invent letters or punctuation.
 */
export class TesseractClassifier implements NumberClassifier {
  readonly name = 'tesseract';
  private worker: TessWorker | null = null;
  private mode: '10' | '8' | null = null;
  private initPromise: Promise<void> | null = null;
  private allowed: Set<number> | null = null;

  /**
   * Narrowing the character whitelist is the single most effective constraint
   * available: if the image only uses 1-4, the engine is physically unable to
   * emit a 7, so a whole class of impossible readings disappears rather than
   * having to be caught downstream.
   */
  setAllowedNumbers(allowed: number[] | null): void {
    this.allowed = normalizeAllowed(allowed);
    if (this.worker) void this.applyWhitelist();
  }

  private whitelist(): string {
    if (!this.allowed) return '0123456789';
    const digits = new Set<string>();
    for (const n of this.allowed) {
      if (n === 10) {
        digits.add('1');
        digits.add('0');
      } else {
        digits.add(String(n));
      }
    }
    return [...digits].sort().join('');
  }

  private async applyWhitelist(): Promise<void> {
    await this.worker?.setParameters({ tessedit_char_whitelist: this.whitelist() });
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const mod = (await import('tesseract.js')) as unknown as {
      createWorker: (lang: string, oem?: number, options?: Record<string, unknown>) => Promise<TessWorker>;
    };
    this.worker = await mod.createWorker('eng');
    await this.worker.setParameters({
      tessedit_char_whitelist: this.whitelist(),
      classify_bln_numeric_mode: '1',
    });
  }

  private async setMode(mode: '10' | '8'): Promise<void> {
    if (this.mode === mode || !this.worker) return;
    await this.worker.setParameters({ tessedit_pageseg_mode: mode });
    this.mode = mode;
  }

  async classify(
    crops: MarkerCrop[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassificationOutput[]> {
    await this.init();
    // Group by glyph count so the page-segmentation mode is switched a handful
    // of times instead of once per marker.
    const order = crops.map((_, i) => i).sort((a, b) => crops[a].glyphs.length - crops[b].glyphs.length);
    const results: ClassificationOutput[] = new Array(crops.length);
    let done = 0;
    for (const idx of order) {
      results[idx] = await this.classifyOne(crops[idx]);
      done++;
      if (onProgress && (done % 10 === 0 || done === crops.length)) onProgress(done, crops.length);
    }
    return results;
  }

  private async classifyOne(crop: MarkerCrop): Promise<ClassificationOutput> {
    const glyphCount = crop.glyphs.length;
    if (glyphCount === 0 || !this.worker) {
      return { value: null, confidence: 0, attempts: [], glyphCount, ranked: [] };
    }
    await this.setMode(glyphCount > 1 ? '8' : '10');
    const attempts: OcrAttempt[] = [];
    try {
      const { data } = await this.worker.recognize(toCanvas(crop.ocrImage));
      const raw = data.text.replace(/[^0-9]/g, '');
      let value = interpret(raw, glyphCount);
      if (value !== null && this.allowed && !this.allowed.has(value)) value = null;
      const confidence = Math.max(0, Math.min(1, data.confidence / 100));
      attempts.push({ variant: 'isolated', engine: this.name, value, confidence, raw: data.text.trim() });
      return {
        value,
        confidence: value === null ? 0 : confidence,
        attempts,
        glyphCount,
        // Tesseract exposes only its winning reading, so the ranking has one entry.
        ranked: value === null ? [] : [{ value, score: confidence }],
      };
    } catch (err) {
      attempts.push({
        variant: 'isolated',
        engine: this.name,
        value: null,
        confidence: 0,
        raw: `error: ${(err as Error).message}`,
      });
      return { value: null, confidence: 0, attempts, glyphCount, ranked: [] };
    }
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
  }
}

/** Map raw OCR text onto the 1..10 range, rejecting anything impossible. */
export function interpret(raw: string, glyphCount: number): number | null {
  if (!raw) return null;
  if (raw.length === 1) {
    const v = Number(raw);
    return v >= 1 && v <= 9 ? v : null;
  }
  if (raw === '10') return 10;
  // Tesseract sometimes doubles a digit on a noisy tile ("33"); with a single
  // isolated glyph the only sane reading is that digit.
  if (glyphCount === 1) {
    const v = Number(raw[0]);
    return v >= 1 && v <= 9 ? v : null;
  }
  return null;
}
