import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { TemplateClassifier } from '../src/core/classifier/templateClassifier.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import { inferActiveNumbers, rejectIsolatedDetections } from '../src/core/globalConsistency.ts';
import type { MarkerDetection } from '../src/core/types.ts';
import type { ClusterResult } from '../src/core/colorClusterer.ts';

const offline = async () => ({ classifier: new TemplateClassifier(), engine: 'template' });

const noClusters: ClusterResult = { clusters: [], assignment: new Int32Array(0) };

function reading(id: string, value: number | null, confidence: number): MarkerDetection {
  return {
    id,
    x: 0,
    y: 0,
    radius: 10,
    width: 20,
    height: 20,
    detectionScore: 0.9,
    source: 'radial-symmetry',
    ocrPrediction: value,
    ocrConfidence: confidence,
    finalConfidence: 'review',
    classificationMethod: 'unknown',
  };
}

describe('active number set', () => {
  it('keeps the numbers the image really uses and discards the stragglers', () => {
    const markers: MarkerDetection[] = [];
    for (let i = 0; i < 160; i++) markers.push(reading(`a${i}`, 1, 0.9));
    for (let i = 0; i < 280; i++) markers.push(reading(`b${i}`, 2, 0.9));
    for (let i = 0; i < 170; i++) markers.push(reading(`c${i}`, 3, 0.9));
    for (let i = 0; i < 110; i++) markers.push(reading(`d${i}`, 4, 0.9));
    // The kind of noise the user saw: a few confident-looking impossible reads.
    markers.push(reading('n1', 7, 0.95));
    markers.push(reading('n2', 9, 0.88));
    markers.push(reading('n3', 8, 0.91));

    const active = inferActiveNumbers(markers, noClusters);
    expect(active.numbers).toEqual([1, 2, 3, 4]);
    expect(active.source).toBe('inferred');
  });

  it('takes the user at their word over anything it inferred', () => {
    const markers = [reading('a', 5, 0.99), reading('b', 5, 0.99), reading('c', 5, 0.99)];
    const active = inferActiveNumbers(markers, noClusters, {
      userSet: [1, 2, 3, 4],
      minShare: 0.015,
      minCount: 4,
      minConfidence: 0.6,
    });
    expect(active.numbers).toEqual([1, 2, 3, 4]);
    expect(active.source).toBe('user');
  });

  it('does not prune a small image down to a single number', () => {
    const markers = [
      reading('a', 1, 0.9),
      reading('b', 1, 0.9),
      reading('c', 2, 0.9),
      reading('d', 2, 0.9),
    ];
    const active = inferActiveNumbers(markers, noClusters);
    expect(active.numbers.length).toBeGreaterThanOrEqual(1);
  });
});

describe('isolated detections', () => {
  it('drops a weak detection stranded away from the field, keeps a strong one', () => {
    const markers: MarkerDetection[] = [];
    for (let i = 0; i < 40; i++) {
      const m = reading(`g${i}`, 2, 0.9);
      m.x = (i % 8) * 30;
      m.y = Math.floor(i / 8) * 30;
      markers.push(m);
    }
    const weakStray = reading('weak', 2, 0.4);
    weakStray.x = 2000;
    weakStray.y = 2000;
    weakStray.detectionScore = 0.5;
    const strongStray = reading('strong', 2, 0.9);
    strongStray.x = 3000;
    strongStray.y = 3000;
    strongStray.detectionScore = 0.95;
    markers.push(weakStray, strongStray);

    const { kept, dropped } = rejectIsolatedDetections(markers);
    expect(dropped.map((m) => m.id)).toEqual(['weak']);
    expect(kept.some((m) => m.id === 'strong')).toBe(true);
  });
});

describe('an image that only contains 1-4', () => {
  it('never reports a number the image does not contain', async () => {
    const { image } = synthesize({
      counts: { 1: 25, 2: 60, 3: 35, 4: 20 },
      radius: 17,
      spacingFactor: 1.15,
      artwork: true,
      noise: 4,
      seed: 909,
    });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: offline,
    });
    const summary = countMarkers(result.markers);
    const reported = [...summary.counts.keys()].sort((a, b) => a - b);
    for (const n of reported) expect([1, 2, 3, 4]).toContain(n);
    expect(result.stats.activeNumbers.every((n) => n >= 1 && n <= 4)).toBe(true);
  }, 90_000);

  it('honours a declared number set as a hard constraint', async () => {
    const { image } = synthesize({
      counts: { 1: 20, 2: 45, 3: 25, 4: 15 },
      radius: 17,
      artwork: true,
      seed: 4242,
    });
    const result = await runPipeline(image, {
      settings: { ...DEFAULT_SETTINGS, useTesseract: false, allowedNumbers: [1, 2, 3, 4] },
      classifierFactory: offline,
    });
    const summary = countMarkers(result.markers);
    expect(result.stats.activeNumbersSource).toBe('user');
    for (const n of summary.counts.keys()) expect(n).toBeLessThanOrEqual(4);
    for (const m of result.markers) {
      if (m.finalNumber != null) expect([1, 2, 3, 4]).toContain(m.finalNumber);
    }
  }, 90_000);
});
