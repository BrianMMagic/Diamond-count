/**
 * Turn a detection into a normalised picture of the digit printed on it.
 *
 * Every later stage compares glyphs to other glyphs, never to a typeface, so
 * what matters here is that the same digit from two different markers lands in
 * the same place in the same size. Aspect ratio is preserved while doing it: a
 * `1` stretched to fill a square box becomes a thick bar indistinguishable from
 * a `7`, and the narrowness of a `1` is most of what identifies it.
 */
import type { GrayImage } from './cv/image.ts';
import { otsuThreshold } from './cv/threshold.ts';
import type { GlyphDetection } from './glyphDetector.ts';

/** Edge length of the normalised glyph picture. */
export const GLYPH_SIZE = 32;
/**
 * Pixels of blank kept around the digit inside that box.
 *
 * Must match the margin the stroke templates are rasterised with. The distance
 * between a glyph and a template is measured in pixels, so normalising the two
 * to different sizes compares a digit against a slightly larger copy of every
 * candidate — and a `1`, being a bare vertical stroke, is the shape that best
 * tolerates the mismatch. At a margin of 3 against templates built at 2, every
 * prototype on the reference card read as `1`.
 */
const MARGIN = 2;

export interface GlyphMask {
  /** GLYPH_SIZE * GLYPH_SIZE, 0 = blank, 1 = ink. This is what gets displayed. */
  data: Float32Array;
  /**
   * The same picture, blurred, and the version distances are measured on.
   *
   * Comparing crisp masks measures stroke weight and sub-pixel placement as
   * much as it measures shape: the same digit printed a shade heavier, or
   * landing half a pixel further left, scores as far apart as a different digit
   * does. On the reference card that split the `3`s into seven separate piles.
   * Blurring first lets a stroke overlap a slightly displaced copy of itself,
   * so what remains is the difference in shape.
   */
  soft: Float32Array;
  /** Ink width divided by ink height, before normalisation. */
  aspect: number;
  /** Fraction of the ink box that is ink. */
  density: number;
}

/** Separable 1-2-1 blur, applied twice. Cheap and enough to absorb a pixel of shift. */
function soften(src: Float32Array): Float32Array {
  const n = GLYPH_SIZE;
  let cur = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const l = x > 0 ? cur[y * n + x - 1] : cur[y * n + x];
        const r = x < n - 1 ? cur[y * n + x + 1] : cur[y * n + x];
        tmp[y * n + x] = (l + 2 * cur[y * n + x] + r) / 4;
      }
    }
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = y > 0 ? tmp[(y - 1) * n + x] : tmp[y * n + x];
        const d = y < n - 1 ? tmp[(y + 1) * n + x] : tmp[y * n + x];
        out[y * n + x] = (u + 2 * tmp[y * n + x] + d) / 4;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Cut the digit out of the image and normalise it.
 *
 * Thresholding is done on the marker's face alone. Across a whole tile a black
 * marker body dominates the histogram and Otsu splits body from face rather
 * than ink from face, which swallows the digit entirely.
 */
export function extractGlyph(gray: GrayImage, d: GlyphDetection, pitch: number): GlyphMask | null {
  const pad = Math.max(2, Math.round(pitch * 0.06));
  const x0 = Math.max(0, Math.round(d.minX) - pad);
  const y0 = Math.max(0, Math.round(d.minY) - pad);
  const x1 = Math.min(gray.width - 1, Math.round(d.maxX) + pad);
  const y1 = Math.min(gray.height - 1, Math.round(d.maxY) + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 3 || h < 3) return null;

  const patch = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * gray.width + x0;
    for (let x = 0; x < w; x++) patch[y * w + x] = gray.data[src + x];
  }

  const t = otsuThreshold(patch);
  const ink = isolateDigit(patch, w, h, t);
  if (!ink) return null;

  let inkMinX = w;
  let inkMinY = h;
  let inkMaxX = -1;
  let inkMaxY = -1;
  let inkCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      inkCount++;
      if (x < inkMinX) inkMinX = x;
      if (y < inkMinY) inkMinY = y;
      if (x > inkMaxX) inkMaxX = x;
      if (y > inkMaxY) inkMaxY = y;
    }
  }
  if (inkMaxX < 0 || inkCount < 4) return null;

  const iw = inkMaxX - inkMinX + 1;
  const ih = inkMaxY - inkMinY + 1;
  const inner = GLYPH_SIZE - MARGIN * 2;
  // One scale for both axes keeps the digit's proportions intact.
  const scale = inner / Math.max(iw, ih);
  const offX = MARGIN + (inner - iw * scale) / 2;
  const offY = MARGIN + (inner - ih * scale) / 2;

  // Resample by walking the DESTINATION and averaging the source area each
  // output cell covers.
  //
  // Scattering source pixels into the destination instead looks equivalent and
  // is not: a digit is often smaller than the box it is normalised into, and
  // when a 11-pixel glyph is enlarged to 28 most destination cells receive no
  // source pixel at all, so the stroke arrives full of holes and its shape
  // stops being comparable to anything. Gathering covers every output cell by
  // construction, and averaging the covered area (rather than taking the
  // nearest pixel) keeps a thin stroke alive when the glyph is being shrunk
  // instead.
  const data = new Float32Array(GLYPH_SIZE * GLYPH_SIZE);
  const step = 1 / scale;
  for (let dy = 0; dy < GLYPH_SIZE; dy++) {
    // Source span this output row covers, in ink-box coordinates.
    const sy0 = (dy - offY) * step;
    const sy1 = sy0 + step;
    if (sy1 <= 0 || sy0 >= ih) continue;
    const y0 = Math.max(0, Math.floor(sy0));
    const y1 = Math.min(ih - 1, Math.ceil(sy1) - 1);
    for (let dx = 0; dx < GLYPH_SIZE; dx++) {
      const sx0 = (dx - offX) * step;
      const sx1 = sx0 + step;
      if (sx1 <= 0 || sx0 >= iw) continue;
      const x0 = Math.max(0, Math.floor(sx0));
      const x1 = Math.min(iw - 1, Math.ceil(sx1) - 1);
      let on = 0;
      let n = 0;
      for (let sy = y0; sy <= y1; sy++) {
        const row = (inkMinY + sy) * w + inkMinX;
        for (let sx = x0; sx <= x1; sx++) {
          if (ink[row + sx]) on++;
          n++;
        }
      }
      if (n > 0) data[dy * GLYPH_SIZE + dx] = on / n;
    }
  }

  return { data, soft: soften(data), aspect: iw / ih, density: inkCount / (iw * ih) };
}

/**
 * Keep the printed digit and discard everything else dark in the patch.
 *
 * Otsu splits the patch into dark and light, but not all the dark is the digit:
 * a black marker body intrudes at the corners, a shadow runs along one rim, and
 * fur shows through at the edges. Left in, that ink joins the digit's bounding
 * box and stretches it sideways — which is measurable, and was the cause of the
 * `3` prototypes arriving with aspect ratios from 0.58 to 0.79 and refusing to
 * merge into one pile.
 *
 * Ink touching the patch border came from outside the face, so it goes. Of what
 * remains, the digit is the substantial piece nearest the middle; specks are
 * JPEG noise.
 */
function isolateDigit(
  patch: Uint8ClampedArray,
  w: number,
  h: number,
  t: number,
): Uint8Array | null {
  const labels = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  const areas: number[] = [];
  const touchesBorder: boolean[] = [];
  const sumX: number[] = [];
  const sumY: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (patch[start] > t || labels[start] >= 0) continue;
    const id = areas.length;
    areas.push(0);
    touchesBorder.push(false);
    sumX.push(0);
    sumY.push(0);
    labels[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % w;
      const py = (p - px) / w;
      areas[id]++;
      sumX[id] += px;
      sumY[id] += py;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touchesBorder[id] = true;
      // Four-connected: diagonal links would bridge the digit to a corner of
      // marker body through a single touching pixel.
      if (px > 0 && patch[p - 1] <= t && labels[p - 1] < 0) { labels[p - 1] = id; stack.push(p - 1); }
      if (px < w - 1 && patch[p + 1] <= t && labels[p + 1] < 0) { labels[p + 1] = id; stack.push(p + 1); }
      if (py > 0 && patch[p - w] <= t && labels[p - w] < 0) { labels[p - w] = id; stack.push(p - w); }
      if (py < h - 1 && patch[p + w] <= t && labels[p + w] < 0) { labels[p + w] = id; stack.push(p + w); }
    }
  }
  if (areas.length === 0) return null;

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  // Prefer the biggest piece that stays clear of the border; fall back to the
  // biggest piece overall rather than returning nothing, since a digit printed
  // hard against the face edge is still a digit.
  let best = -1;
  let bestScore = -Infinity;
  for (let id = 0; id < areas.length; id++) {
    if (areas[id] < 4) continue;
    const dist = Math.hypot(sumX[id] / areas[id] - cx, sumY[id] / areas[id] - cy);
    const score = areas[id] - dist * dist * 0.5 - (touchesBorder[id] ? areas[id] * 0.75 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  if (best < 0) return null;

  const out = new Uint8Array(w * h);
  const keepArea = areas[best];
  const kcx = sumX[best] / keepArea;
  const kcy = sumY[best] / keepArea;
  for (let i = 0; i < w * h; i++) {
    const id = labels[i];
    if (id < 0) continue;
    if (id === best) {
      out[i] = 1;
      continue;
    }
    // A digit can legitimately arrive in pieces when a stroke is broken by
    // noise. Accept a fragment only if it is close to the kept piece and small
    // relative to it, which a marker body or a shadow never is.
    if (touchesBorder[id]) continue;
    if (areas[id] > keepArea * 0.6) continue;
    const dist = Math.hypot(sumX[id] / areas[id] - kcx, sumY[id] / areas[id] - kcy);
    if (dist > Math.max(w, h) * 0.35) continue;
    out[i] = 1;
  }
  return out;
}


/**
 * Distance between two normalised glyphs, 0 (identical) to 1.
 *
 * Plain per-pixel disagreement, but weighted so that ink disagreeing with blank
 * counts for more than blank disagreeing with blank. Two digits differ over a
 * small part of a mostly-empty box, and an unweighted measure buries that
 * difference under all the background they share.
 */
export function glyphDistance(a: GlyphMask, b: GlyphMask): number {
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.soft.length; i++) {
    const av = a.soft[i];
    const bv = b.soft[i];
    diff += Math.abs(av - bv);
    total += Math.max(av, bv);
  }
  return total > 0 ? diff / total : 1;
}

/**
 * Average several glyphs into one.
 *
 * Noise on one marker is independent of noise on the next while the digit is
 * not, so the mean of two hundred instances is sharp where each individual one
 * is mush. This is what lets a photograph of small print be read reliably: the
 * classifier sees one clean picture per distinct digit instead of hundreds of
 * blurry ones.
 */
export function averageGlyphs(items: GlyphMask[]): GlyphMask {
  const data = new Float32Array(GLYPH_SIZE * GLYPH_SIZE);
  for (const g of items) {
    for (let i = 0; i < data.length; i++) data[i] += g.data[i];
  }
  for (let i = 0; i < data.length; i++) data[i] /= Math.max(1, items.length);
  const aspect = items.reduce((s, g) => s + g.aspect, 0) / Math.max(1, items.length);
  const density = items.reduce((s, g) => s + g.density, 0) / Math.max(1, items.length);
  return { data, soft: soften(data), aspect, density };
}
