import { GLYPH_SIZE, isolateGlyphs } from '../markerCropper.ts';
import type { Glyph, MarkerCrop } from '../markerCropper.ts';
import type { OcrAttempt } from '../types.ts';
import { getDigitTemplates } from './digitFont.ts';
import type { DigitTemplate } from './digitFont.ts';
import type { ClassificationOutput, NumberClassifier } from './types.ts';

/**
 * Chamfer distance transform (two-pass 3-4 approximation).
 *
 * Exact Euclidean would cost more for no practical gain at 32x32, and the
 * matcher only cares about relative distances.
 */
function distanceTransform(mask: ArrayLike<number>, size: number): Float32Array {
  const d = new Float32Array(size * size);
  const BIG = 1e6;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : BIG;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? BIG : d[y * size + x]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      d[i] = Math.min(
        d[i],
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      d[i] = Math.min(
        d[i],
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

const templateDistances = new Map<number, Float32Array>();

function templateDistance(t: DigitTemplate): Float32Array {
  const hit = templateDistances.get(t.digit);
  if (hit) return hit;
  const d = distanceTransform(t.mask, GLYPH_SIZE);
  templateDistances.set(t.digit, d);
  return d;
}

/** Symmetric mean chamfer distance between a glyph and a template, in pixels. */
export function chamferDistance(glyph: Uint8ClampedArray, template: DigitTemplate): number {
  const td = templateDistance(template);
  const gd = distanceTransform(glyph, GLYPH_SIZE);
  let a = 0;
  let an = 0;
  let b = 0;
  let bn = 0;
  for (let i = 0; i < glyph.length; i++) {
    if (glyph[i]) {
      a += td[i];
      an++;
    }
    if (template.mask[i]) {
      b += gd[i];
      bn++;
    }
  }
  if (an === 0 || bn === 0) return 99;
  return (a / an + b / bn) / 2;
}

export interface GlyphScore {
  digit: number;
  similarity: number;
}

/**
 * Score one isolated glyph against all ten digit templates.
 *
 * The hole count is a hard structural fact — a "0" has a counter and a "2" does
 * not — so a mismatch is penalised heavily rather than left to the stroke
 * distance, which is the part most affected by print quality and blur.
 */
export function scoreGlyph(glyph: Glyph): GlyphScore[] {
  const templates = getDigitTemplates(GLYPH_SIZE);
  const scores: GlyphScore[] = [];
  for (const t of templates) {
    const d = chamferDistance(glyph.mask, t);
    let sim = Math.exp(-d / 2.2);
    const holeDelta = Math.abs(Math.min(2, glyph.holes) - t.holes);
    if (holeDelta === 1) sim *= 0.45;
    else if (holeDelta >= 2) sim *= 0.18;
    scores.push({ digit: t.digit, similarity: sim });
  }
  scores.sort((a, b) => b.similarity - a.similarity);
  return scores;
}

function combineGlyphs(glyphs: Glyph[]): { value: number | null; confidence: number; raw: string } {
  if (glyphs.length === 0) return { value: null, confidence: 0, raw: '' };
  const perGlyph = glyphs.map(scoreGlyph);

  if (glyphs.length === 1) {
    const [best, second] = perGlyph[0];
    const raw = String(best.digit);
    // 0 alone is not a valid marker value; treat it as an unreadable glyph.
    if (best.digit === 0) return { value: null, confidence: 0, raw };
    return { value: best.digit, confidence: margin(best.similarity, second.similarity), raw };
  }

  // Two glyphs: the only legal value is "10".
  const left = perGlyph[0];
  const right = perGlyph[1];
  const oneScore = left.find((s) => s.digit === 1)?.similarity ?? 0;
  const zeroScore = right.find((s) => s.digit === 0)?.similarity ?? 0;
  const raw = `${left[0].digit}${right[0].digit}`;
  const combined = Math.sqrt(oneScore * zeroScore);
  const rival = Math.sqrt(left[0].similarity * right[0].similarity);
  const conf = margin(combined, combined === rival ? 0 : rival * 0.9);
  return { value: 10, confidence: conf, raw };
}

/**
 * Turn "best vs runner-up" into a 0..1 confidence.
 *
 * A high similarity that barely beats the runner-up is not a confident reading,
 * which is exactly the situation the review queue exists for.
 */
function margin(best: number, second: number): number {
  if (best <= 0) return 0;
  const rel = Math.max(0, (best - second) / best);
  return Math.max(0, Math.min(1, best * (0.3 + 0.7 * Math.min(1, rel / 0.35))));
}

/**
 * The always-available classifier: pure TypeScript, no network, no wasm.
 *
 * It runs several preprocessing variants of the same marker and keeps the most
 * confident plausible answer, which is what makes tiny printed digits readable
 * at all — a threshold that works for a black ring often loses a pale one.
 */
export class TemplateClassifier implements NumberClassifier {
  readonly name = 'template';

  async init(): Promise<void> {
    getDigitTemplates(GLYPH_SIZE);
  }

  async classify(
    crops: MarkerCrop[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ClassificationOutput[]> {
    const out: ClassificationOutput[] = [];
    for (let i = 0; i < crops.length; i++) {
      out.push(this.classifyOne(crops[i]));
      if (onProgress && (i % 25 === 0 || i === crops.length - 1)) onProgress(i + 1, crops.length);
    }
    return out;
  }

  classifyOne(crop: MarkerCrop): ClassificationOutput {
    const variants: Array<{ name: string; glyphs: Glyph[] }> = [
      { name: 'enhanced', glyphs: crop.glyphs },
      { name: 'raw', glyphs: isolateGlyphs(crop.normalized, crop.innerRadius) },
    ];
    const attempts: OcrAttempt[] = [];
    let best: { value: number | null; confidence: number } = { value: null, confidence: 0 };
    let glyphCount = crop.glyphs.length;
    for (const v of variants) {
      const r = combineGlyphs(v.glyphs);
      attempts.push({
        variant: v.name,
        engine: this.name,
        value: r.value,
        confidence: r.confidence,
        raw: r.raw,
      });
      if (r.value !== null && r.confidence > best.confidence) {
        best = { value: r.value, confidence: r.confidence };
        glyphCount = v.glyphs.length;
      }
    }
    // Two variants agreeing is worth more than either alone.
    const agreeing = attempts.filter((a) => a.value === best.value && a.value !== null).length;
    const confidence = Math.min(1, best.confidence * (agreeing >= 2 ? 1.15 : 1));
    return { value: best.value, confidence, attempts, glyphCount };
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}
