import type { GrayImage, RgbaImage } from './cv/image.ts';
import { createGray, createRgba, grayAt } from './cv/image.ts';
import { toGray } from './cv/color.ts';
import { autoContrast, unsharp } from './cv/filters.ts';
import { upscaleGray, downscaleGray } from './cv/resize.ts';
import { median, otsuThreshold, sauvola } from './cv/threshold.ts';
import { connectedComponents } from './cv/connected.ts';
import type { MarkerCandidate } from './types.ts';

/** Side of the normalised crop. Big enough that a 6px printed digit becomes ~40px. */
export const NORM_SIZE = 160;
/** Crop side as a multiple of the marker radius: ring plus a little context. */
export const CROP_FACTOR = 2.6;
/** Normalised glyph bitmaps handed to the classifier. */
export const GLYPH_SIZE = 32;

export interface Glyph {
  /** GLYPH_SIZE x GLYPH_SIZE, 255 = ink. */
  mask: Uint8ClampedArray;
  /** Bounding box within the normalised crop. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ink pixels / bbox area. */
  fill: number;
  /** Enclosed holes — a "0", "6", "8" or "9" has at least one. */
  holes: number;
}

export interface MarkerCrop {
  id: string;
  /** Original-resolution colour crop, for the review UI and debug gallery. */
  display: RgbaImage;
  /** Normalised grayscale crop (NORM_SIZE square). */
  normalized: GrayImage;
  /** Contrast-stretched + sharpened variant. */
  enhanced: GrayImage;
  /** Binary variant, 255 = ink. */
  binary: GrayImage;
  /** White-background, black-digit image sized for an OCR engine. */
  ocrImage: GrayImage;
  /** Individually isolated digits, left to right. */
  glyphs: Glyph[];
  /** Radius of the marker's light centre, in normalised crop pixels. */
  innerRadius: number;
  /** Ring radius in normalised crop pixels. */
  ringRadius: number;
}

/** Crop with edge clamping so markers near the border still produce a full tile. */
export function cropRgba(src: RgbaImage, cx: number, cy: number, side: number): RgbaImage {
  const s = Math.max(4, Math.round(side));
  const out = createRgba(s, s);
  const x0 = Math.round(cx - s / 2);
  const y0 = Math.round(cy - s / 2);
  for (let y = 0; y < s; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, y0 + y));
    for (let x = 0; x < s; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, x0 + x));
      const si = (sy * src.width + sx) * 4;
      const di = (y * s + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

function resampleTo(img: GrayImage, size: number): GrayImage {
  if (img.width === size) return img;
  if (img.width < size) return upscaleGray(img, size, size);
  return downscaleGray(img, size / img.width);
}

/**
 * Build every representation of a marker that later stages need.
 *
 * Crops come from the ORIGINAL full-resolution image, not the detection working
 * copy — the working copy is deliberately small, and a digit that survives
 * detection there may already be too soft to read.
 */
export function cropMarker(original: RgbaImage, marker: MarkerCandidate): MarkerCrop {
  const side = Math.max(8, marker.radius * 2 * CROP_FACTOR);
  const display = cropRgba(original, marker.x, marker.y, side);
  const gray = toGray(display);
  const normalized = resampleTo(gray, NORM_SIZE);
  const enhanced = unsharp(autoContrast(normalized, 1.0), 1, 0.9);

  // The crop spans CROP_FACTOR * radius, so the ring lands at this radius once
  // the tile has been resampled to NORM_SIZE.
  const ringRadius = NORM_SIZE / CROP_FACTOR;
  // Measure the light centre rather than assuming it. The detector reports the
  // middle of the ring stroke and is a few percent out either way; a disc sized
  // from that assumption either clips a tall digit (which reads downstream as
  // "OCR failed" on perfectly legible print) or swallows part of the ring.
  const innerRadius = measureCenterRadius(enhanced, ringRadius);

  const binary = binarizeDisc(enhanced, innerRadius * 1.35);
  const glyphs = isolateGlyphs(enhanced, innerRadius);
  const ocrImage = composeOcrImage(glyphs);

  return {
    id: marker.id,
    display,
    normalized,
    enhanced,
    binary,
    ocrImage,
    glyphs,
    innerRadius,
    ringRadius,
  };
}

/**
 * Find the radius of the marker's light centre by walking outwards until the
 * ring darkens the image, and taking the median across spokes so one spoke
 * crossing the digit or a glare highlight cannot decide it.
 */
function measureCenterRadius(img: GrayImage, ringRadius: number): number {
  const half = img.width / 2;
  const fallback = ringRadius * 0.62;
  const centre = grayAt(img, Math.round(half), Math.round(half));
  const hits: number[] = [];
  for (let a = 0; a < 24; a++) {
    const th = (a / 24) * Math.PI * 2;
    const ca = Math.cos(th);
    const sa = Math.sin(th);
    // Reference brightness just off-centre, away from the digit itself.
    let reference = centre;
    for (let r = ringRadius * 0.2; r <= ringRadius * 0.45; r += 1) {
      reference = Math.max(reference, grayAt(img, Math.round(half + ca * r), Math.round(half + sa * r)));
    }
    for (let r = ringRadius * 0.45; r <= ringRadius * 1.1; r += 1) {
      const v = grayAt(img, Math.round(half + ca * r), Math.round(half + sa * r));
      if (v < reference - 45) {
        hits.push(r);
        break;
      }
    }
  }
  if (hits.length < 12) return fallback;
  // Stop just short of the ring edge we found.
  const measured = median(hits) * 0.9;
  // Never stray far from the expected geometry: a wild measurement means the
  // crop is not really a marker, and the fallback is the safer answer.
  return Math.max(ringRadius * 0.45, Math.min(ringRadius * 0.78, measured));
}

/**
 * Otsu applied to the marker's light centre only.
 *
 * Thresholding the whole tile would let a black ring dominate the histogram and
 * swallow the digit; restricting the statistics to the disc keeps the split
 * between "white centre" and "printed digit" where it belongs.
 */
function binarizeDisc(img: GrayImage, radius: number): GrayImage {
  const half = img.width / 2;
  const samples: number[] = [];
  for (let y = 0; y < img.height; y++) {
    const dy = y - half;
    for (let x = 0; x < img.width; x++) {
      const dx = x - half;
      if (dx * dx + dy * dy <= radius * radius) samples.push(img.data[y * img.width + x]);
    }
  }
  const t = samples.length > 16 ? otsuThreshold(samples) : 128;
  const out = createGray(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] <= t ? 255 : 0;
  return out;
}

/**
 * Find the printed digit(s) inside the marker.
 *
 * Everything that touches the edge of the centre disc is ring bleed, and
 * anything too small is paper noise or a JPEG artefact. What survives is sorted
 * left to right, which is what makes a two-glyph "1" + "0" readable as ten.
 */
export function isolateGlyphs(img: GrayImage, innerRadius: number): Glyph[] {
  const size = img.width;
  const half = size / 2;
  const discR = innerRadius;

  const samples: number[] = [];
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      if (dx * dx + dy * dy <= discR * discR) samples.push(img.data[y * size + x]);
    }
  }
  if (samples.length < 32) return [];
  const t = otsuThreshold(samples);

  const mask = createGray(size, size);
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      if (dx * dx + dy * dy > discR * discR) continue;
      mask.data[y * size + x] = img.data[y * size + x] <= t ? 255 : 0;
    }
  }

  const { labels, components } = connectedComponents(mask, true);

  // Tell a printed digit from ring bleed by SHAPE, not by a radius cutoff.
  //
  // A digit fills the middle of the marker, so some of its pixels always come
  // near the centre. Ring bleed is an arc: it hugs the boundary and never
  // reaches inwards. Judging by "does it touch a rim band" instead needs a
  // constant that is simultaneously wide enough to exclude the ring and narrow
  // enough to keep a digit that fills the centre -- there isn't one, and getting
  // it wrong silently drops good glyphs or swallows the ring.
  const nearestRadius = new Float64Array(components.length + 1).fill(Infinity);
  const farthestRadius = new Float64Array(components.length + 1);
  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const l = labels[y * size + x];
      if (!l) continue;
      const dx = x - half;
      const d = Math.hypot(dx, dy);
      if (d < nearestRadius[l]) nearestRadius[l] = d;
      if (d > farthestRadius[l]) farthestRadius[l] = d;
    }
  }
  const isRingBleed = (label: number) =>
    nearestRadius[label] > discR * 0.55 || farthestRadius[label] > discR * 0.99;

  const discArea = Math.PI * discR * discR;
  const kept: Glyph[] = [];
  for (const c of components) {
    if (c.area < discArea * 0.012) continue;
    if (c.area > discArea * 0.75) continue;
    const w = c.maxX - c.minX + 1;
    const h = c.maxY - c.minY + 1;
    if (isRingBleed(c.label)) continue;
    if (h < discR * 0.35) continue; // digits span most of the centre's height
    if (w > discR * 1.8 || h > discR * 2.1) continue;
    kept.push(extractGlyph(labels, size, c.label, c.minX, c.minY, w, h, c.area, c.holeCount));
  }
  kept.sort((a, b) => a.x - b.x);
  // A marker holds at most two digits; keep the two largest if noise slipped in.
  if (kept.length > 2) {
    kept.sort((a, b) => b.width * b.height - a.width * a.height);
    kept.length = 2;
    kept.sort((a, b) => a.x - b.x);
  }
  return kept;
}

function extractGlyph(
  labels: Int32Array,
  size: number,
  label: number,
  minX: number,
  minY: number,
  w: number,
  h: number,
  area: number,
  holes: number,
): Glyph {
  // Fit into GLYPH_SIZE preserving aspect, with a 2px margin, centred.
  const margin = 2;
  const target = GLYPH_SIZE - margin * 2;
  const scale = Math.min(target / w, target / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const offX = Math.floor((GLYPH_SIZE - dw) / 2);
  const offY = Math.floor((GLYPH_SIZE - dh) / 2);
  const mask = new Uint8ClampedArray(GLYPH_SIZE * GLYPH_SIZE);
  for (let y = 0; y < dh; y++) {
    // Area-average the source cell so thin strokes survive the downscale.
    const sy0 = minY + Math.floor((y * h) / dh);
    const sy1 = minY + Math.max(Math.floor(((y + 1) * h) / dh), Math.floor((y * h) / dh) + 1);
    for (let x = 0; x < dw; x++) {
      const sx0 = minX + Math.floor((x * w) / dw);
      const sx1 = minX + Math.max(Math.floor(((x + 1) * w) / dw), Math.floor((x * w) / dw) + 1);
      let on = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          if (labels[sy * size + sx] === label) on++;
          n++;
        }
      }
      mask[(y + offY) * GLYPH_SIZE + x + offX] = on / Math.max(1, n) >= 0.4 ? 255 : 0;
    }
  }
  return { mask, x: minX, y: minY, width: w, height: h, fill: area / (w * h), holes };
}

/** Lay the isolated glyphs out as black-on-white with generous padding for OCR. */
function composeOcrImage(glyphs: Glyph[]): GrayImage {
  const pad = 12;
  const cellH = 64;
  if (glyphs.length === 0) return createGray(1, 1);
  const cells = glyphs.map((g) => {
    const scale = cellH / g.height;
    return { g, w: Math.max(6, Math.round(g.width * scale)) };
  });
  const gap = glyphs.length > 1 ? 8 : 0;
  const width = pad * 2 + cells.reduce((s, c) => s + c.w, 0) + gap * (cells.length - 1);
  const height = pad * 2 + cellH;
  const out = createGray(width, height);
  out.data.fill(255);
  let cursor = pad;
  for (const cell of cells) {
    for (let y = 0; y < cellH; y++) {
      const sy = Math.min(GLYPH_SIZE - 1, Math.floor((y / cellH) * GLYPH_SIZE));
      for (let x = 0; x < cell.w; x++) {
        const sx = Math.min(GLYPH_SIZE - 1, Math.floor((x / cell.w) * GLYPH_SIZE));
        if (cell.g.mask[sy * GLYPH_SIZE + sx]) out.data[(y + pad) * width + cursor + x] = 0;
      }
    }
    cursor += cell.w + gap;
  }
  return out;
}

/** Sauvola variant of the tile — a fourth opinion for the classifier ensemble. */
export function adaptiveVariant(crop: MarkerCrop): GrayImage {
  return sauvola(crop.normalized, Math.round(crop.innerRadius * 0.8), 0.25);
}
