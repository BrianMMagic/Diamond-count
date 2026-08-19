import type { GrayImage, RgbaImage } from './image.ts';
import { createGray } from './image.ts';

/** Rec.601 luma — matches what most OCR front-ends expect. */
export function toGray(src: RgbaImage): GrayImage {
  const out = createGray(src.width, src.height);
  const s = src.data;
  const d = out.data;
  for (let i = 0, j = 0; j < d.length; i += 4, j++) {
    d[j] = (s[i] * 299 + s[i + 1] * 587 + s[i + 2] * 114) / 1000;
  }
  return out;
}

/** Hue 0-360, saturation 0-1, value 0-1. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 1e-6) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max <= 1e-6 ? 0 : delta / max;
  return [h, s, max];
}

const D65_X = 95.047;
const D65_Y = 100.0;
const D65_Z = 108.883;

function pivotRgb(c: number): number {
  const v = c / 255;
  return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}

function pivotXyz(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** sRGB (D65) -> CIE L*a*b*. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = pivotRgb(r) * 100;
  const gl = pivotRgb(g) * 100;
  const bl = pivotRgb(b) * 100;
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / D65_X;
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / D65_Y;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / D65_Z;
  const fx = pivotXyz(x);
  const fy = pivotXyz(y);
  const fz = pivotXyz(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function unpivotXyz(t: number): number {
  const t3 = t * t * t;
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
}

function unpivotRgb(c: number): number {
  const v = c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** CIE L*a*b* -> sRGB, used to paint learned colours in the debug UI. */
export function labToRgb(lab: [number, number, number]): [number, number, number] {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const x = (unpivotXyz(fx) * D65_X) / 100;
  const y = (unpivotXyz(fy) * D65_Y) / 100;
  const z = (unpivotXyz(fz) * D65_Z) / 100;
  const r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const b = x * 0.0557 + y * -0.204 + z * 1.057;
  return [unpivotRgb(r), unpivotRgb(g), unpivotRgb(b)];
}

/**
 * CIE94 (graphic-arts weights) perceptual distance.
 *
 * CIE76 over-reports differences between saturated colours, which matters here:
 * a red ring and an orange ring are genuinely close in Lab but easy to tell
 * apart by eye, and CIE94's chroma weighting reflects that better.
 */
export function deltaE94(a: [number, number, number], b: [number, number, number]): number {
  const dL = a[0] - b[0];
  const c1 = Math.hypot(a[1], a[2]);
  const c2 = Math.hypot(b[1], b[2]);
  const dC = c1 - c2;
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  const dH2 = Math.max(0, da * da + db * db - dC * dC);
  const sl = 1;
  const sc = 1 + 0.045 * c1;
  const sh = 1 + 0.015 * c1;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + dH2 / (sh * sh));
}
