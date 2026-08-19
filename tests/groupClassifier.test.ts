import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { TemplateClassifier } from '../src/core/classifier/templateClassifier.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import type { MarkerCrop } from '../src/core/markerCropper.ts';
import type { ClassificationOutput, NumberClassifier } from '../src/core/classifier/index.ts';

/**
 * Stands in for reading a 12-pixel digit: right most of the time, wrong the
 * rest, exactly the regime that makes per-marker classification accumulate
 * error across several hundred markers.
 */
class UnreliableClassifier implements NumberClassifier {
  readonly name = 'unreliable';
  calls = 0;
  private truth = new TemplateClassifier();
  private seed = 1;

  constructor(private readonly errorRate: number) {}

  setAllowedNumbers(): void {}
  async init(): Promise<void> {
    await this.truth.init();
  }

  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  async classify(crops: MarkerCrop[]): Promise<ClassificationOutput[]> {
    const real = await this.truth.classify(crops);
    this.calls += crops.length;
    return real.map((r) => {
      if (r.value === null || this.random() > this.errorRate) return r;
      const wrong = ((r.value + 1 + Math.floor(this.random() * 3)) % 10) + 1;
      return { ...r, value: wrong, confidence: 0.55, ranked: [{ value: wrong, score: 0.55 }] };
    });
  }

  async dispose(): Promise<void> {
    await this.truth.dispose();
  }
}

describe('group-first classification', () => {
  it('reads far fewer markers than it counts', async () => {
    const { image, truth } = synthesize({
      counts: { 1: 30, 2: 70, 3: 40, 4: 25 },
      radius: 16,
      seed: 5150,
    });
    const engine = new UnreliableClassifier(0);
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: async () => ({ classifier: engine, engine: 'unreliable' }),
    });
    // Every marker is counted, but only a sample of each group is ever read.
    expect(result.markers.length).toBeGreaterThan(120);
    expect(result.stats.markersRead).toBeLessThan(result.markers.length * 0.6);
    expect(truth.total).toBeGreaterThan(150);
  }, 90_000);

  it('keeps the counts right even when a third of the readings are wrong', async () => {
    const { image } = synthesize({
      counts: { 1: 30, 2: 70, 3: 40, 4: 25 },
      radius: 16,
      seed: 5150,
    });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: async () => ({
        classifier: new UnreliableClassifier(0.33),
        engine: 'unreliable',
      }),
    });
    const summary = countMarkers(result.markers);
    const reported = [...summary.counts.keys()].sort((a, b) => a - b);

    // A per-marker design would scatter a third of the markers across wrong
    // numbers. Voting per group means a wrong reading has to beat 15 others.
    expect(reported.length).toBeLessThanOrEqual(5);
    const dominant = [...summary.counts.entries()].sort((a, b) => b[1] - a[1]);
    expect(dominant[0][1]).toBeGreaterThan(summary.total * 0.25);
    for (const n of reported) expect(n).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('falls back to reading markers individually when a group is not separable', async () => {
    // Two numbers sharing the EXACT same ring colour, so clustering genuinely
    // cannot tell them apart: the group vote must split, and those markers must
    // be read on their own instead.
    const { image } = synthesize({
      counts: { 2: 45, 3: 45 },
      radius: 17,
      ringColors: { 2: [210, 130, 40], 3: [210, 130, 40] },
      seed: 616,
    });
    const engine = new UnreliableClassifier(0);
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: async () => ({ classifier: engine, engine: 'unreliable' }),
    });
    // With colour useless, nearly every marker has to be read individually.
    expect(result.stats.markersRead).toBeGreaterThan(result.markers.length * 0.7);
  }, 90_000);
});
