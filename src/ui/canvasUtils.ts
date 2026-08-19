import type { GrayImage, RgbaImage } from '../core/cv/image.ts';

/** Paint an RGBA buffer into a canvas, scaled to fill it. */
export function paintRgba(canvas: HTMLCanvasElement, img: RgbaImage, cssSize: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.max(1, Math.round(cssSize * dpr));
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;
  offCtx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  ctx.imageSmoothingEnabled = px / img.width < 2.5;
  ctx.clearRect(0, 0, px, px);
  ctx.drawImage(off, 0, 0, px, px);
}

/** Paint a grayscale buffer (debug variants) into a canvas. */
export function paintGray(canvas: HTMLCanvasElement, img: GrayImage, cssSize: number): void {
  const rgba: RgbaImage = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.width * img.height * 4) };
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    rgba.data[j] = img.data[i];
    rgba.data[j + 1] = img.data[i];
    rgba.data[j + 2] = img.data[i];
    rgba.data[j + 3] = 255;
  }
  paintRgba(canvas, rgba, cssSize);
}

/** Paint a 32x32 glyph mask (255 = ink) as black on white. */
export function paintMask(canvas: HTMLCanvasElement, mask: ArrayLike<number>, size: number, cssSize: number): void {
  const rgba: RgbaImage = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  for (let i = 0, j = 0; i < size * size; i++, j += 4) {
    const v = mask[i] ? 20 : 245;
    rgba.data[j] = v;
    rgba.data[j + 1] = v;
    rgba.data[j + 2] = v;
    rgba.data[j + 3] = 255;
  }
  paintRgba(canvas, rgba, cssSize);
}
