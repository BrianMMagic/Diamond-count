import { describe, expect, it } from 'vitest';
import { getDigitTemplates } from '../src/core/classifier/digitFont.ts';
import { scoreGlyph } from '../src/core/classifier/templateClassifier.ts';
import { connectedComponents } from '../src/core/cv/connected.ts';

const SIZE = 32;
const GRID = 8;

/**
 * What each digit is supposed to look like, at eight by eight.
 *
 * This exists because the obvious test does not work. Asking whether each
 * rendered digit matches its own template back is vacuous — a `2` drawn as a
 * squashed `z` still matches a squashed `z` perfectly — and that is not
 * hypothetical: `2`, `3` and `5` were drawn with their bowls sweeping the wrong
 * way round and rasterised upside down, while every test in the suite passed.
 * The synthetic sheets are rendered from these same shapes, so the fixtures
 * agreed with the templates and the templates agreed with the fixtures, and a
 * real `2` was read as a `7` on the only input that had an outside opinion.
 *
 * A fingerprint breaks that circle: it is an external description of the shape,
 * legible in a diff, that has to be read and agreed with by a person. If a
 * change to the stroke definitions alters what a digit looks like, this fails
 * and the picture in the diff shows what it now draws.
 */
const EXPECTED: Record<number, string[]> = {
  0: ['...##...', '..####..', '..#..#..', '.##..##.', '.##..##.', '..#..#..', '..####..', '...##...'],
  1: ['....#...', '...##...', '...##...', '....#...', '....#...', '....#...', '....#...', '....#...'],
  2: ['...##...', '..####..', '.##..##.', '....##..', '....#...', '...##...', '..####..', '..#####.'],
  3: ['...##...', '..####..', '.....#..', '...###..', '...###..', '..#..##.', '..####..', '...##...'],
  4: ['....##..', '....##..', '...###..', '..####..', '..#.##..', '.######.', '....##..', '....##..'],
  5: ['..####..', '..####..', '..#.....', '..####..', '.....##.', '.....##.', '..####..', '...##...'],
  6: ['........', '..##....', '..##....', '..####..', '..#..#..', '..#..##.', '..####..', '...##...'],
  7: ['..####..', '..####..', '....##..', '....##..', '....#...', '...##...', '...#....', '...#....'],
  8: ['...##...', '..####..', '..#..#..', '..####..', '..####..', '.##..##.', '..####..', '..####..'],
  9: ['...##...', '..####..', '..#..##.', '..#..#..', '..#####.', '.....#..', '....##..', '....#...'],
};

function fingerprint(mask: Uint8ClampedArray): string[] {
  const cell = SIZE / GRID;
  const rows: string[] = [];
  for (let by = 0; by < GRID; by++) {
    let row = '';
    for (let bx = 0; bx < GRID; bx++) {
      let on = 0;
      for (let y = by * cell; y < (by + 1) * cell; y++) {
        for (let x = bx * cell; x < (bx + 1) * cell; x++) {
          if (mask[y * SIZE + x]) on++;
        }
      }
      row += on >= cell * cell * 0.22 ? '#' : '.';
    }
    rows.push(row);
  }
  return rows;
}

describe('the built-in digit font', () => {
  it('draws each digit the way it is meant to look', () => {
    for (const t of getDigitTemplates(SIZE)) {
      expect(fingerprint(t.mask), `digit ${t.digit}`).toEqual(EXPECTED[t.digit]);
    }
  });

  it('gives the digits with counters their counters, and the others none', () => {
    const templates = getDigitTemplates(SIZE);
    const holes = (d: number) => templates.find((t) => t.digit === d)!.holes;
    expect(holes(8)).toBe(2);
    for (const d of [0, 4, 6, 9]) expect(holes(d), `digit ${d}`).toBe(1);
    for (const d of [1, 2, 3, 5, 7]) expect(holes(d), `digit ${d}`).toBe(0);
  });

  it('matches each rendered digit back to itself', () => {
    for (const t of getDigitTemplates(SIZE)) {
      const holes = connectedComponents({ width: SIZE, height: SIZE, data: t.mask }, true)
        .components.reduce((s, c) => s + c.holeCount, 0);
      const scores = scoreGlyph({
        mask: t.mask, x: 0, y: 0, width: SIZE, height: SIZE, fill: 0.4, holes,
      });
      expect(scores[0].digit, `digit ${t.digit}`).toBe(t.digit);
    }
  });

  it('keeps every digit distinguishable from every other', () => {
    // A pair that scores nearly as well against the wrong digit as the right one
    // is a pair the reader will confuse on a real card.
    const templates = getDigitTemplates(SIZE);
    for (const t of templates) {
      const holes = connectedComponents({ width: SIZE, height: SIZE, data: t.mask }, true)
        .components.reduce((s, c) => s + c.holeCount, 0);
      const scores = scoreGlyph({
        mask: t.mask, x: 0, y: 0, width: SIZE, height: SIZE, fill: 0.4, holes,
      });
      expect(scores[0].similarity, `digit ${t.digit} against ${scores[1].digit}`)
        .toBeGreaterThan(scores[1].similarity * 1.25);
    }
  });
});
