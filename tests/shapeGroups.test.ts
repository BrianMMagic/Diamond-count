import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { TemplateClassifier } from '../src/core/classifier/templateClassifier.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';

const offline = async () => ({ classifier: new TemplateClassifier(), engine: 'template' });

const run = (image: Parameters<typeof runPipeline>[0], allowedNumbers: number[] | null = null) =>
  runPipeline(image, {
    settings: { ...DEFAULT_SETTINGS, useTesseract: false, allowedNumbers },
    classifierFactory: offline,
  });

describe('classification by digit shape', () => {
  it('counts correctly when every marker is the same colour', async () => {
    // Colour carries no information at all here, so the digit shape must.
    const { image } = synthesize({
      counts: { 1: 30, 2: 70, 3: 40, 4: 25 },
      radius: 17,
      seed: 5150,
      ringColors: {
        1: [200, 120, 40],
        2: [200, 120, 40],
        3: [200, 120, 40],
        4: [200, 120, 40],
      },
    });
    const result = await run(image);
    const summary = countMarkers(result.markers);

    expect([...summary.counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    // Every reported count within a marker or two of the truth.
    expect(summary.counts.get(1)!).toBeGreaterThanOrEqual(28);
    expect(summary.counts.get(2)!).toBeGreaterThanOrEqual(67);
    expect(summary.counts.get(3)!).toBeGreaterThanOrEqual(37);
    expect(summary.counts.get(4)!).toBeGreaterThanOrEqual(23);
    expect(summary.total).toBeGreaterThanOrEqual(160);
  }, 90_000);

  it('finds one group per distinct digit and reads each only once', async () => {
    const { image } = synthesize({
      counts: { 1: 30, 2: 70, 3: 40, 4: 25 },
      radius: 16,
      artwork: true,
      noise: 5,
      seed: 77,
    });
    const result = await run(image);

    expect(result.stats.shapeGroups).toHaveLength(4);
    const labels = result.stats.shapeGroups.map((g) => g.number).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(labels).toEqual([1, 2, 3, 4]);
    // The whole point: a handful of reads, not one per marker.
    expect(result.stats.markersRead).toBeLessThanOrEqual(8);
    expect(result.stats.groupAssigned).toBeGreaterThan(140);
  }, 90_000);

  it('averaging sharpens the group picture well past any single marker', async () => {
    const { image } = synthesize({ counts: { 2: 80, 4: 60 }, radius: 15, noise: 8, seed: 246 });
    const result = await run(image);
    for (const group of result.stats.shapeGroups) {
      // Sharpness is how consistently members agree pixel by pixel; a noisy
      // pile would sit near zero.
      expect(group.sharpness).toBeGreaterThan(0.6);
    }
  }, 90_000);

  it('handles the two-digit value 10 as its own shape', async () => {
    const { image } = synthesize({ counts: { 2: 40, 10: 25 }, radius: 18, seed: 313 });
    const result = await run(image);
    const summary = countMarkers(result.markers);
    expect(summary.counts.get(10)).toBe(25);
    expect(summary.counts.get(2)).toBe(40);
    const tens = result.stats.shapeGroups.find((g) => g.number === 10);
    expect(tens?.glyphCount).toBe(2);
  }, 90_000);

  it('does not let colour decide anything by default', async () => {
    const { image } = synthesize({ counts: { 2: 50, 3: 50 }, radius: 17, seed: 808 });
    const result = await run(image);
    expect(DEFAULT_SETTINGS.useColorAssist).toBe(false);
    for (const m of result.markers) {
      if (m.finalNumber != null) expect(m.classificationMethod).not.toBe('color');
    }
  }, 90_000);

  it('still honours a declared number set', async () => {
    const { image } = synthesize({ counts: { 1: 20, 2: 45, 3: 25 }, radius: 17, seed: 4242 });
    const result = await run(image, [1, 2, 3]);
    expect(result.stats.activeNumbersSource).toBe('user');
    for (const m of result.markers) {
      if (m.finalNumber != null) expect([1, 2, 3]).toContain(m.finalNumber);
    }
  }, 90_000);
});
