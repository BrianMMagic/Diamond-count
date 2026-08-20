import type { MarkerCrop } from '../markerCropper.ts';
import type { OcrAttempt } from '../types.ts';
import { TemplateClassifier } from './templateClassifier.ts';
import { TesseractClassifier } from './tesseractClassifier.ts';
import type { ClassificationOutput, NumberClassifier } from './types.ts';

export * from './types.ts';
export { TemplateClassifier } from './templateClassifier.ts';
export { TesseractClassifier } from './tesseractClassifier.ts';

/**
 * Runs two independent readers and merges their opinions.
 *
 * Agreement between a stroke-shape matcher and a trained OCR engine is much
 * stronger evidence than either engine's own confidence number, and their
 * disagreement is a reliable signal that a marker needs a human — which is
 * precisely the outcome we want when counting hundreds of them.
 */
export class EnsembleClassifier implements NumberClassifier {
  readonly name: string;
  private readonly engines: NumberClassifier[];
  private readonly weights: number[];

  constructor(engines: NumberClassifier[], weights: number[]) {
    this.engines = engines;
    this.weights = weights;
    this.name = engines.map((e) => e.name).join('+');
  }

  setAllowedNumbers(allowed: number[] | null): void {
    for (const e of this.engines) e.setAllowedNumbers(allowed);
  }

  async init(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.init()));
  }

  async classify(
    crops: MarkerCrop[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassificationOutput[]> {
    const perEngine: ClassificationOutput[][] = [];
    for (let e = 0; e < this.engines.length; e++) {
      const engine = this.engines[e];
      const share = 1 / this.engines.length;
      perEngine.push(
        await engine.classify(crops, (done, total) => {
          onProgress?.(Math.round((e * share + (done / total) * share) * total), total);
        }),
      );
    }
    return crops.map((_, i) => this.merge(perEngine.map((r) => r[i])));
  }

  private merge(outputs: ClassificationOutput[]): ClassificationOutput {
    const attempts: OcrAttempt[] = outputs.flatMap((o) => o.attempts);
    const votes = new Map<number, number>();
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (o.value === null) continue;
      votes.set(o.value, (votes.get(o.value) ?? 0) + o.confidence * this.weights[i]);
    }
    // Merge the per-engine rankings so a rejected winner can fall back.
    const rankedScores = new Map<number, number>();
    for (let i = 0; i < outputs.length; i++) {
      for (const r of outputs[i].ranked) {
        rankedScores.set(r.value, (rankedScores.get(r.value) ?? 0) + r.score * this.weights[i]);
      }
    }
    const ranked = [...rankedScores.entries()]
      .map(([value, score]) => ({ value, score }))
      .sort((a, b) => b.score - a.score);

    if (votes.size === 0) {
      return { value: null, confidence: 0, attempts, glyphCount: outputs[0]?.glyphCount ?? 0, ranked };
    }
    const byVote = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const [value, score] = byVote[0];
    const runnerUp = byVote[1]?.[1] ?? 0;
    const totalWeight = this.weights.reduce((s, w) => s + w, 0);
    let confidence = Math.min(1, score / totalWeight);
    if (byVote.length > 1) {
      // Engines pointing at different digits: keep the leader but say so.
      confidence *= Math.max(0.35, 1 - runnerUp / Math.max(score, 1e-6));
    } else if (outputs.filter((o) => o.value === value).length === outputs.length && outputs.length > 1) {
      confidence = Math.min(1, confidence * 1.2);
    }
    const glyphCount = outputs.find((o) => o.value === value)?.glyphCount ?? outputs[0].glyphCount;
    return { value, confidence, attempts, glyphCount, ranked };
  }

  async dispose(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.dispose()));
  }
}

export interface ClassifierChoice {
  classifier: NumberClassifier;
  /** What actually loaded, for the stats panel. */
  engine: string;
  /** Set when Tesseract was requested but could not be loaded. */
  warning?: string;
}

/** How long to wait for an optional engine before giving up on it. */
const ENGINE_LOAD_TIMEOUT_MS = 15000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not load within ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Build the classifier for a run.
 *
 * The built-in matcher is always present, so a blocked CDN, an offline device
 * or an unsupported browser degrades to a working app rather than to a stall.
 *
 * The timeout is not belt-and-braces. Tesseract fetches its worker script from
 * a CDN and, when that fetch fails, throws inside its OWN nested worker — the
 * promise this function awaits neither resolves nor rejects, so a try/catch
 * never fires and the whole analysis hangs at "Reading numbers" forever. Racing
 * the load against a clock is the only way to notice.
 */
export async function createClassifier(
  useTesseract: boolean,
  allowedNumbers: number[] | null = null,
): Promise<ClassifierChoice> {
  const template = new TemplateClassifier();
  template.setAllowedNumbers(allowedNumbers);
  await template.init();
  if (!useTesseract) {
    return { classifier: template, engine: template.name };
  }
  const tess = new TesseractClassifier();
  tess.setAllowedNumbers(allowedNumbers);
  try {
    await withTimeout(tess.init(), ENGINE_LOAD_TIMEOUT_MS, 'Tesseract');
  } catch (err) {
    void tess.dispose().catch(() => {});
    return {
      classifier: template,
      engine: template.name,
      warning: `Tesseract could not be loaded (${(err as Error).message}); using the built-in reader.`,
    };
  }
  const ensemble = new EnsembleClassifier([tess, template], [0.62, 0.38]);
  ensemble.setAllowedNumbers(allowedNumbers);
  return { classifier: ensemble, engine: 'tesseract+template' };
}
