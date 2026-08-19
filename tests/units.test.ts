import { describe, expect, it } from 'vitest';
import { deduplicate } from '../src/core/markerDeduplicator.ts';
import type { MarkerCandidate, MarkerDetection } from '../src/core/types.ts';
import { countMarkers, countRows, formatCounts } from '../src/core/resultCounter.ts';
import { deltaE94, labToRgb, rgbToHsv, rgbToLab } from '../src/core/cv/color.ts';
import { connectedComponents } from '../src/core/cv/connected.ts';
import { otsuThreshold } from '../src/core/cv/threshold.ts';
import { getDigitTemplates } from '../src/core/classifier/digitFont.ts';
import { GLYPH_SIZE } from '../src/core/markerCropper.ts';
import { scoreGlyph } from '../src/core/classifier/templateClassifier.ts';
import { interpret } from '../src/core/classifier/tesseractClassifier.ts';
import { learnColorModel, predictFromColor } from '../src/core/colorAnalyzer.ts';
import { evaluate } from '../src/testing/groundTruth.ts';

function candidate(id: string, x: number, y: number, r = 10, score = 0.8): MarkerCandidate {
  return {
    id,
    x,
    y,
    radius: r,
    width: r * 2,
    height: r * 2,
    detectionScore: score,
    source: 'radial-symmetry',
  };
}

describe('deduplication', () => {
  it('merges overlapping candidates and keeps distinct ones', () => {
    const result = deduplicate([
      candidate('a', 100, 100, 10, 0.9),
      candidate('b', 103, 101, 10, 0.7),
      candidate('c', 140, 100, 10, 0.8),
    ]);
    expect(result.markers).toHaveLength(2);
    expect(result.merged).toBe(1);
    expect(result.markers[0].id).toBe('a');
  });

  it('rewards agreement between two independent generators', () => {
    const a = candidate('a', 50, 50, 10, 0.6);
    const b = { ...candidate('b', 51, 50, 10, 0.55), source: 'contour' as const };
    const result = deduplicate([a, b]);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].detectionScore).toBeGreaterThan(0.6);
  });
});

describe('colour maths', () => {
  it('round-trips Lab and sRGB closely enough to paint swatches', () => {
    for (const rgb of [
      [230, 120, 40],
      [20, 20, 22],
      [244, 241, 234],
      [40, 150, 160],
    ] as Array<[number, number, number]>) {
      const back = labToRgb(rgbToLab(...rgb));
      for (let c = 0; c < 3; c++) expect(Math.abs(back[c] - rgb[c])).toBeLessThanOrEqual(2);
    }
  });

  it('reports orange and red as closer than orange and black', () => {
    const orange = rgbToLab(226, 138, 44);
    const red = rgbToLab(206, 74, 60);
    const black = rgbToLab(26, 26, 28);
    expect(deltaE94(orange, red)).toBeLessThan(deltaE94(orange, black));
  });

  it('computes hue for a saturated ring', () => {
    const [h, s, v] = rgbToHsv(226, 138, 44);
    expect(h).toBeGreaterThan(20);
    expect(h).toBeLessThan(40);
    expect(s).toBeGreaterThan(0.7);
    expect(v).toBeGreaterThan(0.8);
  });
});

describe('colour learning', () => {
  const makeMarker = (
    id: string,
    number: number,
    rgb: [number, number, number],
    confidence: number,
  ): MarkerDetection => ({
    ...candidate(id, 0, 0),
    ocrPrediction: number,
    ocrConfidence: confidence,
    ringColor: {
      r: rgb[0],
      g: rgb[1],
      b: rgb[2],
      h: 0,
      s: 0,
      v: 0,
      lab: rgbToLab(...rgb),
      spread: 2,
      samples: 100,
    },
    finalConfidence: 'review',
    classificationMethod: 'unknown',
  });

  it('learns colours only from confident readings and rescues an unread marker', () => {
    const markers: MarkerDetection[] = [];
    for (let i = 0; i < 8; i++) markers.push(makeMarker(`o${i}`, 3, [226, 138, 44], 0.95));
    for (let i = 0; i < 8; i++) markers.push(makeMarker(`k${i}`, 2, [26, 26, 28], 0.95));
    // A low-confidence marker must not teach anything.
    markers.push(makeMarker('bad', 7, [226, 138, 44], 0.2));

    const model = learnColorModel(markers);
    expect(model.entries.map((e) => e.number).sort()).toEqual([2, 3]);

    const unread = makeMarker('x', 0, [224, 141, 48], 0);
    const prediction = predictFromColor(model, unread.ringColor);
    expect(prediction.number).toBe(3);
    expect(prediction.confidence).toBeGreaterThan(0.5);
  });

  it('returns nothing when no colours could be learned', () => {
    const model = learnColorModel([]);
    expect(model.trained).toBe(false);
    expect(predictFromColor(model, undefined).number).toBeNull();
  });
});

describe('digit templates', () => {
  it('rasterises ten distinct digits with the expected counters', () => {
    const templates = getDigitTemplates(GLYPH_SIZE);
    expect(templates).toHaveLength(10);
    expect(templates.find((t) => t.digit === 8)!.holes).toBe(2);
    expect(templates.find((t) => t.digit === 7)!.holes).toBe(0);
    for (const t of templates) {
      const ink = t.mask.reduce((s, v) => s + (v ? 1 : 0), 0);
      expect(ink).toBeGreaterThan(40);
    }
  });

  it('matches each rendered digit back to itself', () => {
    const templates = getDigitTemplates(GLYPH_SIZE);
    for (const t of templates) {
      const holes = connectedComponents(
        { width: GLYPH_SIZE, height: GLYPH_SIZE, data: t.mask },
        true,
      ).components.reduce((s, c) => s + c.holeCount, 0);
      const scores = scoreGlyph({ mask: t.mask, x: 0, y: 0, width: GLYPH_SIZE, height: GLYPH_SIZE, fill: 0.4, holes });
      expect(scores[0].digit).toBe(t.digit);
    }
  });
});

describe('OCR result interpretation', () => {
  it('accepts 1-9 and 10 and rejects everything else', () => {
    expect(interpret('3', 1)).toBe(3);
    expect(interpret('10', 2)).toBe(10);
    expect(interpret('0', 1)).toBeNull();
    expect(interpret('', 1)).toBeNull();
    expect(interpret('44', 1)).toBe(4);
    expect(interpret('47', 2)).toBeNull();
  });
});

describe('image primitives', () => {
  it('labels components and finds an enclosed hole', () => {
    const size = 21;
    const data = new Uint8ClampedArray(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - 10, y - 10);
        data[y * size + x] = d > 6 && d < 9 ? 255 : 0;
      }
    }
    const { components } = connectedComponents({ width: size, height: size, data }, true);
    expect(components).toHaveLength(1);
    expect(components[0].holeCount).toBe(1);
    expect(components[0].holeArea).toBeGreaterThan(80);
  });

  it('splits a bimodal histogram near the midpoint', () => {
    const data = new Uint8ClampedArray(1000);
    data.fill(30, 0, 500);
    data.fill(220, 500);
    const t = otsuThreshold(data);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });
});

describe('counting and reporting', () => {
  const marker = (id: string, value: number | null, confidence: MarkerDetection['finalConfidence']): MarkerDetection => ({
    ...candidate(id, 0, 0),
    finalNumber: value,
    finalConfidence: confidence,
    classificationMethod: 'ocr',
  });

  it('summarises counts and confidence buckets', () => {
    const summary = countMarkers([
      marker('a', 1, 'high'),
      marker('b', 1, 'high'),
      marker('c', 2, 'medium'),
      marker('d', null, 'review'),
      { ...marker('e', 3, 'high'), rejected: true },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.counts.get(1)).toBe(2);
    expect(summary.highConfidence).toBe(2);
    expect(summary.needsReview).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(formatCounts(summary, false)).toBe('1: 2, 2: 1');
    expect(countRows(summary, true)).toHaveLength(10);
  });

  it('honours a manual override over the automatic value', () => {
    const summary = countMarkers([{ ...marker('a', 4, 'high'), manualNumber: 7 }]);
    expect(summary.counts.get(7)).toBe(1);
    expect(summary.counts.get(4)).toBeUndefined();
  });
});

describe('ground-truth evaluation', () => {
  it('separates missed markers from misclassifications', () => {
    const summary = countMarkers([]);
    summary.counts.set(1, 141);
    summary.counts.set(2, 317);
    summary.counts.set(3, 202);
    summary.total = 660;
    const report = evaluate(
      { image: 'x.jpg', counts: { '1': 142, '2': 317, '3': 201 } },
      summary,
    );
    expect(report.expectedTotal).toBe(660);
    expect(report.totalDifference).toBe(0);
    expect(report.misclassifiedAtLeast).toBe(1);
    expect(report.missed).toBe(0);
  });
});
