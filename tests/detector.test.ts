import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import { prepareImage } from '../src/core/imagePreprocessor.ts';
import { detectMarkers, filterBySizeConsistency } from '../src/core/markerDetector.ts';
import { deduplicate } from '../src/core/markerDeduplicator.ts';

function detect(image: Parameters<typeof prepareImage>[0], sensitivity = 0.5) {
  const prepared = prepareImage(image, { workingResolution: 2000 });
  const outcome = detectMarkers(prepared, { sensitivity, expectedMarkerSize: 0 });
  const deduped = deduplicate(outcome.accepted);
  const sized = filterBySizeConsistency(deduped.markers);
  return { outcome, deduped, markers: sized.kept };
}

describe('marker detection', () => {
  it('finds a clean sheet of markers with no duplicates', () => {
    const { image, markers: truth } = synthesize({
      counts: { 1: 30, 2: 40, 3: 25, 4: 20 },
      radius: 15,
      seed: 7,
    });
    const { markers } = detect(image);
    // The synthetic sheet includes a cream ring on cream paper with no shadow,
    // which is harder than a photographed bead; 80% recall on that worst case
    // still leaves the review queue short.
    expect(markers.length).toBeGreaterThanOrEqual(truth.length * 0.8);
    expect(markers.length).toBeLessThanOrEqual(truth.length * 1.03);

    // Every detection should sit on top of a real marker.
    for (const m of markers) {
      const nearest = Math.min(...truth.map((t) => Math.hypot(t.x - m.x, t.y - m.y)));
      expect(nearest).toBeLessThan(m.radius * 0.6);
    }
  });

  it('estimates marker size without being told', () => {
    const { image } = synthesize({ counts: { 2: 60 }, radius: 22, seed: 11 });
    const prepared = prepareImage(image, { workingResolution: 2000 });
    const outcome = detectMarkers(prepared, { sensitivity: 0.5, expectedMarkerSize: 0 });
    const radiusInOriginal = outcome.radius / prepared.scale;
    expect(radiusInOriginal).toBeGreaterThan(22 * 0.6);
    expect(radiusInOriginal).toBeLessThan(22 * 1.6);
  });

  it('survives uneven lighting, blur and sensor noise', () => {
    const { image, markers: truth } = synthesize({
      counts: { 1: 25, 2: 35, 3: 25, 4: 15 },
      radius: 16,
      lightingGradient: 0.35,
      blur: 1,
      noise: 6,
      artwork: true,
      seed: 23,
    });
    const { markers } = detect(image, 0.6);
    expect(markers.length).toBeGreaterThanOrEqual(truth.length * 0.75);
    expect(markers.length).toBeLessThanOrEqual(truth.length * 1.08);
  });

  it('keeps markers that sit close together separate', () => {
    const { image, markers: truth } = synthesize({
      counts: { 2: 80 },
      radius: 14,
      spacingFactor: 1.08,
      jitter: 0.04,
      seed: 31,
    });
    const { markers } = detect(image);
    expect(markers.length).toBeGreaterThanOrEqual(truth.length * 0.95);
    expect(markers.length).toBeLessThanOrEqual(truth.length * 1.02);
  });
});
