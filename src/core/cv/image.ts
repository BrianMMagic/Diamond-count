/** Minimal image containers. Everything downstream works on these. */

export interface GrayImage {
  width: number;
  height: number;
  /** Row-major, 1 byte per pixel. */
  data: Uint8ClampedArray;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

export interface FloatImage {
  width: number;
  height: number;
  data: Float32Array;
}

export function createGray(width: number, height: number): GrayImage {
  return { width, height, data: new Uint8ClampedArray(width * height) };
}

export function createFloat(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height) };
}

export function createRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneGray(src: GrayImage): GrayImage {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

export function cloneRgba(src: RgbaImage): RgbaImage {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v | 0;
}

/** Nearest-pixel read that clamps at the borders. */
export function grayAt(img: GrayImage, x: number, y: number): number {
  const xi = clampInt(x, 0, img.width - 1);
  const yi = clampInt(y, 0, img.height - 1);
  return img.data[yi * img.width + xi];
}

/** Bilinear read; returns 0-255 as a float. */
export function grayBilinear(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = grayAt(img, x0, y0);
  const b = grayAt(img, x0 + 1, y0);
  const c = grayAt(img, x0, y0 + 1);
  const d = grayAt(img, x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
