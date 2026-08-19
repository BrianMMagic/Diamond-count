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
    // Detection may drop the odd marker; what matters here is that "10" is
    // recognised as a two-digit value and never split into a 1 and a 0.
    expect(summary.counts.get(10)).toBeGreaterThanOrEqual(23);
    expect(summary.counts.get(2)).toBeGreaterThanOrEqual(38);
    expect([...summary.counts.keys()].sort((a, b) => a - b)).toEqual([2, 10]);
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

describe('shapes that are not markers', () => {
  it('rejects ringed shapes with no digit instead of counting or queuing them', async () => {
    // 220 ringed shapes with nothing printed inside, alongside 210 real markers:
    // the texture a real photograph is full of, which is what produced 1375
    // "needs review" items on the first real card tested.
    const { image } = synthesize({
      counts: { 1: 40, 2: 90, 3: 50, 4: 30 },
      radius: 16,
      artwork: true,
      noise: 5,
      distractors: 220,
      seed: 4711,
    });
    const result = await run(image);
    const summary = countMarkers(result.markers);

    // The phantoms are set aside, not counted and not dumped on the user.
    expect(result.discarded.length).toBeGreaterThan(20);
    expect(summary.needsReview).toBeLessThan(15);
    // Counts for the well-detected numbers land on the truth. Exact equality
    // would be testing detection recall to the marker, which drifts by one or
    // two with any change; a tight tolerance is the honest assertion.
    expect(summary.counts.get(2)).toBeGreaterThanOrEqual(88);
    expect(summary.counts.get(2)).toBeLessThanOrEqual(92);
    expect(summary.counts.get(3)).toBeGreaterThanOrEqual(48);
    expect(summary.counts.get(3)).toBeLessThanOrEqual(52);
    expect(summary.counts.get(4)).toBeGreaterThanOrEqual(28);
    expect(summary.counts.get(4)).toBeLessThanOrEqual(32);
    // And nothing outside the real number set is reported.
    for (const n of summary.counts.keys()) expect([1, 2, 3, 4]).toContain(n);
  }, 120_000);

  it('calibrates detection strictness from how many detections carry a digit', async () => {
    const { image } = synthesize({
      counts: { 2: 60, 3: 40 },
      radius: 16,
      distractors: 120,
      seed: 191,
    });
    const result = await run(image);
    expect(result.stats.detectionYield).toBeGreaterThan(0.55);
    expect(result.stats.detectionSensitivity).toBeGreaterThanOrEqual(0);
    expect(result.stats.detectionSensitivity).toBeLessThanOrEqual(1);
  }, 120_000);
});

describe('a card modelled on real beads', () => {
  it('counts a dense sheet of pearl, black, metallic and pink beads', async () => {
    // Ring and face colours taken from a real kit: the metallic beads are the
    // hard case, because their ring is nearly the same tone as their own face
    // and they carry a specular highlight. Getting this wrong lost every gold
    // bead on the first real card tested and reported zero 3s.
    const { image, truth } = synthesize({
      counts: { 1: 220, 2: 420, 3: 210, 4: 115 },
      radius: 17,
      spacingFactor: 1.08,
      jitter: 0.06,
      ringColors: {
        1: [225, 224, 220],
        2: [22, 22, 24],
        3: [196, 150, 70],
        4: [214, 120, 110],
      },
      faceColors: {
        1: [238, 238, 236],
        2: [245, 244, 240],
        3: [205, 163, 84],
        4: [248, 246, 244],
      },
      specular: 0.55,
      noise: 4,
      seed: 2024,
    });
    const result = await run(image);
    const summary = countMarkers(result.markers);

    // Every number present must be reported — a missing category is the
    // failure this test exists to catch.
    expect([...summary.counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    for (const n of [1, 2, 3, 4]) {
      const expected = Number(truth.counts[String(n)]);
      expect(summary.counts.get(n)!).toBeGreaterThan(expected * 0.7);
      expect(summary.counts.get(n)!).toBeLessThanOrEqual(expected * 1.05);
    }
    expect(summary.total).toBeGreaterThan(truth.total! * 0.85);
    expect(summary.needsReview).toBeLessThan(30);
  }, 180_000);
});
