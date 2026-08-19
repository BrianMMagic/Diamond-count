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
    if (votes.size === 0) {
      return { value: null, confidence: 0, attempts, glyphCount: outputs[0]?.glyphCount ?? 0 };
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const [value, score] = ranked[0];
    const runnerUp = ranked[1]?.[1] ?? 0;
    const totalWeight = this.weights.reduce((s, w) => s + w, 0);
    let confidence = Math.min(1, score / totalWeight);
    if (ranked.length > 1) {
      // Engines pointing at different digits: keep the leader but say so.
      confidence *= Math.max(0.35, 1 - runnerUp / Math.max(score, 1e-6));
    } else if (outputs.filter((o) => o.value === value).length === outputs.length && outputs.length > 1) {
      confidence = Math.min(1, confidence * 1.2);
    }
    const glyphCount = outputs.find((o) => o.value === value)?.glyphCount ?? outputs[0].glyphCount;
    return { value, confidence, attempts, glyphCount };
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

/**
 * Build the classifier for a run.
 *
 * The template matcher is always present, so a blocked CDN, an offline device
 * or an unsupported browser degrades to a working (if slightly weaker) app
 * rather than to an error screen.
 */
export async function createClassifier(useTesseract: boolean): Promise<ClassifierChoice> {
  const template = new TemplateClassifier();
  await template.init();
  if (!useTesseract) {
    return { classifier: template, engine: template.name };
  }
  const tess = new TesseractClassifier();
  try {
    await tess.init();
  } catch (err) {
    return {
      classifier: template,
      engine: template.name,
      warning: `Tesseract could not be loaded (${(err as Error).message}); using the built-in classifier.`,
    };
  }
  return {
    classifier: new EnsembleClassifier([tess, template], [0.62, 0.38]),
    engine: 'tesseract+template',
  };
}
