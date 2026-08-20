/**
 * Turn one averaged prototype into a number.
 *
 * This is the only place in the pipeline where a digit becomes a number, and it
 * runs a handful of times per image rather than once per marker. The picture it
 * reads is the mean of every marker in its group, which is sharp where any
 * single marker is mush: noise on one marker is independent of noise on the
 * next, while the digit is not.
 */
import { scoreGlyph } from './classifier/templateClassifier.ts';
import type { Glyph } from './markerCropper.ts';
import { GLYPH_SIZE } from './glyphShape.ts';
import type { GlyphMask } from './glyphShape.ts';

export interface PrototypeReading {
  value: number | null;
  confidence: number;
  /**
   * How closely the averaged picture resembles the digit it was read as, 0-1.
   *
   * Separate from `confidence`, which only compares the winner against the
   * runner-up. A shape that is not a digit at all still has a best match, and
   * can even have a clear margin over second place, so the margin alone cannot
   * say "this is not a number". Similarity can: on the reference card real
   * digits scored 0.80 to 0.94 while two clusters of blurred fur scored 0.53
   * and 0.67.
   */
  similarity: number;
  /** Every digit considered, best first. Shown in the debug panel. */
  ranked: Array<{ digit: number; similarity: number }>;
}

export function readPrototype(mask: GlyphMask, allowed: Set<number> | null): PrototypeReading {
  const glyph = toClassifierGlyph(mask);
  const scores = scoreGlyph(glyph).filter((s) => !allowed || allowed.has(s.digit));
  if (scores.length === 0) return { value: null, confidence: 0, similarity: 0, ranked: [] };
  // scoreGlyph returns similarities, best first.
  const best = scores[0];
  const second = scores[1];
  // Confidence is the margin over the runner-up, not the winner's own score. A
  // prototype can sit far from every stroke template and still be unambiguous,
  // while one sitting between two is exactly what a person should look at.
  const confidence = second
    ? Math.max(0, Math.min(1, (best.similarity - second.similarity) / Math.max(1e-6, best.similarity)))
    : 0.5;
  return { value: best.digit, confidence, similarity: best.similarity, ranked: scores };
}

/** Adapt a normalised prototype to the shape the stroke matcher expects. */
function toClassifierGlyph(mask: GlyphMask): Glyph {
  const data = new Uint8ClampedArray(GLYPH_SIZE * GLYPH_SIZE);
  let minX = GLYPH_SIZE;
  let minY = GLYPH_SIZE;
  let maxX = -1;
  let maxY = -1;
  let ink = 0;
  for (let y = 0; y < GLYPH_SIZE; y++) {
    for (let x = 0; x < GLYPH_SIZE; x++) {
      const i = y * GLYPH_SIZE + x;
      // The prototype is an average, so most cells are fractional. Half the
      // members carrying ink is what makes a stroke part of the digit.
      if (mask.data[i] < 0.5) continue;
      data[i] = 255;
      ink++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { mask: data, x: 0, y: 0, width: 0, height: 0, fill: 0, holes: 0 };
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  return {
    mask: data,
    x: minX,
    y: minY,
    width,
    height,
    fill: ink / Math.max(1, width * height),
    holes: countHoles(data),
  };
}

/**
 * Enclosed background regions. A `0`, `6`, `8` or `9` has at least one, and the
 * stroke matcher uses that as a hard structural prior.
 */
function countHoles(mask: Uint8ClampedArray): number {
  const n = GLYPH_SIZE;
  const seen = new Uint8Array(n * n);
  const stack: number[] = [];
  // Flood the border first; whatever background is left is enclosed.
  for (let i = 0; i < n; i++) {
    for (const p of [i, (n - 1) * n + i, i * n, i * n + n - 1]) {
      if (!mask[p] && !seen[p]) {
        seen[p] = 1;
        stack.push(p);
      }
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % n;
    const y = (p - x) / n;
    if (x > 0 && !mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (x < n - 1 && !mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && !mask[p - n] && !seen[p - n]) { seen[p - n] = 1; stack.push(p - n); }
    if (y < n - 1 && !mask[p + n] && !seen[p + n]) { seen[p + n] = 1; stack.push(p + n); }
  }
  let holes = 0;
  for (let p = 0; p < n * n; p++) {
    if (mask[p] || seen[p]) continue;
    holes++;
    seen[p] = 1;
    stack.push(p);
    while (stack.length > 0) {
      const q = stack.pop()!;
      const x = q % n;
      const y = (q - x) / n;
      if (x > 0 && !mask[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack.push(q - 1); }
      if (x < n - 1 && !mask[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack.push(q + 1); }
      if (y > 0 && !mask[q - n] && !seen[q - n]) { seen[q - n] = 1; stack.push(q - n); }
      if (y < n - 1 && !mask[q + n] && !seen[q + n]) { seen[q + n] = 1; stack.push(q + n); }
    }
  }
  return holes;
}

