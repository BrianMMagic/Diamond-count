import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { TemplateClassifier } from '../src/core/classifier/templateClassifier.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { evaluate } from '../src/testing/groundTruth.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';

/** Tesseract is not available in Node, so tests exercise the built-in reader. */
const offlineClassifier = async () => ({
  classifier: new TemplateClassifier(),
  engine: 'template',
});

describe('end-to-end pipeline', () => {
  it('counts a synthetic sheet and reports its own uncertainty', async () => {
    const { image, truth } = synthesize({
      counts: { 1: 12, 2: 30, 3: 18, 4: 10 },
      radius: 18,
      seed: 101,
    });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: offlineClassifier,
    });
    const summary = countMarkers(result.markers);
    const report = evaluate(truth, summary);

    expect(result.markers.length).toBeGreaterThan(50);
    // Total count should be close; the review queue absorbs the rest.
    expect(report.totalAccuracy).toBeGreaterThan(0.75);
    expect(summary.highConfidence + summary.mediumConfidence + summary.needsReview).toBe(
      result.markers.length,
    );
    expect(result.stats.finalMarkers).toBe(result.markers.length);
  }, 60_000);

  it('learns a number-to-colour mapping from the image itself', async () => {
    const { image } = synthesize({
      counts: { 2: 30, 3: 30 },
      radius: 18,
      // Deliberately NOT the defaults: nothing may be hard-coded.
      ringColors: { 2: [20, 90, 190], 3: [200, 40, 140] },
      seed: 55,
    });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: offlineClassifier,
    });
    // At least one colour was learned, and the clusters match the two inks used.
    expect(result.stats.colorClusters.length).toBeGreaterThanOrEqual(2);
    expect(result.stats.colorClusters.length).toBeLessThanOrEqual(4);
    for (const entry of result.colorModel.entries) {
      expect(entry.samples).toBeGreaterThanOrEqual(4);
    }
  }, 60_000);

  it('never emits two markers for one physical marker', async () => {
    const { image } = synthesize({ counts: { 4: 40 }, radius: 20, seed: 77 });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: offlineClassifier,
    });
    for (let i = 0; i < result.markers.length; i++) {
      for (let j = i + 1; j < result.markers.length; j++) {
        const a = result.markers[i];
        const b = result.markers[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius * 0.8);
      }
    }
    const ids = new Set(result.markers.map((m) => m.id));
    expect(ids.size).toBe(result.markers.length);
  }, 60_000);
});
