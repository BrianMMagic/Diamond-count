/**
 * A tiny built-in vector font for the digits 0-9.
 *
 * The offline classifier needs reference shapes, and shipping a bitmap font or
 * relying on canvas text rendering would tie us to a runtime that the Node test
 * harness does not have. Describing each digit as a handful of strokes keeps the
 * templates identical in the browser and in `npm test`, which matters when the
 * point of the harness is to compare algorithm changes reproducibly.
 */

import { connectedComponents } from '../cv/connected.ts';

export type Point = [number, number];
export type Stroke = Point[];

export interface DigitShape {
  digit: number;
  /** Natural width relative to a height of 1. */
  widthRatio: number;
  strokes: Stroke[];
  /** Enclosed counters, used as a structural prior. */
  holes: number;
}

/** Sample an elliptical arc. Angles in degrees, y grows downwards. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 28,
): Stroke {
  const pts: Stroke = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

function line(x0: number, y0: number, x1: number, y1: number): Stroke {
  return [
    [x0, y0],
    [x1, y1],
  ];
}

export const DIGIT_SHAPES: DigitShape[] = [
  {
    digit: 0,
    widthRatio: 0.64,
    holes: 1,
    strokes: [arc(0.32, 0.5, 0.26, 0.44, 0, 360, 40)],
  },
  {
    digit: 1,
    widthRatio: 0.36,
    holes: 0,
    strokes: [line(0.24, 0.03, 0.24, 0.97), line(0.24, 0.03, 0.04, 0.22)],
  },
  {
    digit: 2,
    widthRatio: 0.6,
    holes: 0,
    strokes: [
      arc(0.3, 0.3, 0.25, 0.25, 185, 20, 26),
      line(0.53, 0.38, 0.05, 0.94),
      line(0.03, 0.95, 0.58, 0.95),
    ],
  },
  {
    digit: 3,
    widthRatio: 0.6,
    holes: 0,
    strokes: [
      arc(0.3, 0.28, 0.24, 0.24, 190, 70, 24),
      arc(0.3, 0.71, 0.26, 0.26, 290, 160, 26),
      line(0.26, 0.5, 0.36, 0.5),
    ],
  },
  {
    digit: 4,
    widthRatio: 0.64,
    holes: 1,
    strokes: [line(0.46, 0.03, 0.03, 0.69), line(0.03, 0.7, 0.61, 0.7), line(0.46, 0.03, 0.46, 0.97)],
  },
  {
    digit: 5,
    widthRatio: 0.6,
    holes: 0,
    strokes: [
      line(0.08, 0.05, 0.55, 0.05),
      line(0.08, 0.05, 0.06, 0.44),
      line(0.06, 0.44, 0.26, 0.4),
      arc(0.3, 0.67, 0.27, 0.28, 285, 130, 26),
    ],
  },
  {
    digit: 6,
    widthRatio: 0.6,
    holes: 1,
    strokes: [arc(0.31, 0.68, 0.25, 0.27, 0, 360, 34), arc(0.34, 0.56, 0.26, 0.48, 245, 200, 20)],
  },
  {
    digit: 7,
    widthRatio: 0.58,
    holes: 0,
    strokes: [line(0.03, 0.05, 0.55, 0.05), line(0.55, 0.05, 0.2, 0.97)],
  },
  {
    digit: 8,
    widthRatio: 0.62,
    holes: 2,
    strokes: [arc(0.31, 0.27, 0.23, 0.23, 0, 360, 30), arc(0.31, 0.72, 0.27, 0.25, 0, 360, 32)],
  },
  {
    digit: 9,
    widthRatio: 0.6,
    holes: 1,
    strokes: [arc(0.31, 0.31, 0.25, 0.27, 0, 360, 34), arc(0.29, 0.5, 0.28, 0.44, 70, 10, 20)],
  },
];

export interface DigitTemplate {
  digit: number;
  /** size x size binary mask, 255 = ink. */
  mask: Uint8ClampedArray;
  /** Counters measured from the RASTER, not declared. */
  holes: number;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Rasterise one digit into `size` x `size`, fitted the same way the glyph
 * isolator fits a real digit: aspect preserved, centred, with a 2px margin.
 * Matching only works if both sides are normalised identically.
 */
export function rasterizeDigit(shape: DigitShape, size: number, strokeWidth = 0.14): DigitTemplate {
  const margin = 2;
  const inner = size - margin * 2;
  const h = shape.widthRatio > 1 ? inner / shape.widthRatio : inner;
  const w = h * shape.widthRatio;
  const scale = Math.min(inner / Math.max(w, 1e-6), inner / h);
  const dw = w * scale;
  const dh = h * scale;
  const offX = (size - dw) / 2;
  const offY = (size - dh) / 2;
  const halfStroke = (strokeWidth * dh) / 2;

  const segments: Array<[number, number, number, number]> = [];
  for (const stroke of shape.strokes) {
    for (let i = 0; i < stroke.length - 1; i++) {
      segments.push([
        offX + stroke[i][0] * dh,
        offY + stroke[i][1] * dh,
        offX + stroke[i + 1][0] * dh,
        offY + stroke[i + 1][1] * dh,
      ]);
    }
  }

  const mask = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let best = Infinity;
      for (const s of segments) {
        const d = distToSegment(x + 0.5, y + 0.5, s[0], s[1], s[2], s[3]);
        if (d < best) best = d;
        if (best <= halfStroke) break;
      }
      mask[y * size + x] = best <= halfStroke ? 255 : 0;
    }
  }
  // Measure the counters on the rasterised mask rather than trusting the
  // declaration: the glyphs we compare against are measured the same way, and a
  // stroke width that closes a gap must affect both sides equally.
  const measured = connectedComponents({ width: size, height: size, data: mask }, true).components;
  const holes = measured.reduce((sum, c) => sum + c.holeCount, 0);
  return { digit: shape.digit, mask, holes };
}

let cache: Map<number, DigitTemplate[]> | null = null;

/** Templates are deterministic, so build them once per size and reuse. */
export function getDigitTemplates(size: number): DigitTemplate[] {
  if (!cache) cache = new Map();
  const hit = cache.get(size);
  if (hit) return hit;
  const built = DIGIT_SHAPES.map((s) => rasterizeDigit(s, size));
  cache.set(size, built);
  return built;
}
