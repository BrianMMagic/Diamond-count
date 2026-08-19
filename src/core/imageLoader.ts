import type { RgbaImage } from './cv/image.ts';
import { downscaleRgba } from './cv/resize.ts';

export interface LoadedImage {
  /** Full-resolution pixels, EXIF orientation already applied. */
  full: RgbaImage;
  /** Object URL for cheap <img>/<canvas> display. Revoke when done. */
  previewUrl: string;
  fileName: string;
  /** Dimensions as decoded, before any capping. */
  sourceWidth: number;
  sourceHeight: number;
  /** True when the source was above `maxPixels` and had to be reduced. */
  capped: boolean;
}

/**
 * A 12MP iPhone photo is 48 MB of RGBA; a 48MP one is 190 MB and will crash a
 * mobile browser once we start making working copies of it. 24 MP keeps every
 * marker comfortably above the size we need while staying within budget.
 */
const DEFAULT_MAX_PIXELS = 24_000_000;

export async function loadImageFile(
  file: File | Blob,
  maxPixels = DEFAULT_MAX_PIXELS,
): Promise<LoadedImage> {
  const bitmap = await decode(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  let rgba = bitmapToRgba(bitmap);
  bitmap.close?.();

  let capped = false;
  const pixels = rgba.width * rgba.height;
  if (pixels > maxPixels) {
    capped = true;
    rgba = downscaleRgba(rgba, Math.sqrt(maxPixels / pixels));
  }

  return {
    full: rgba,
    previewUrl: URL.createObjectURL(file),
    fileName: file instanceof File ? file.name : 'image',
    sourceWidth,
    sourceHeight,
    capped,
  };
}

/**
 * `imageOrientation: 'from-image'` makes the browser apply the EXIF rotation for
 * us, which is essential for phone photos — an un-rotated portrait shot would
 * otherwise be analysed sideways.
 */
async function decode(file: File | Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari ignores the option object entirely.
    return await createImageBitmap(file);
  }
}

function bitmapToRgba(bitmap: ImageBitmap): RgbaImage {
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('Could not get a 2D canvas context for image decoding.');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: data.width, height: data.height, data: new Uint8ClampedArray(data.data) };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Structured-clone friendly view of an RgbaImage, for worker transfer. */
export interface TransferableImage {
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export function toTransferable(img: RgbaImage): TransferableImage {
  const copy = new Uint8ClampedArray(img.data);
  return { width: img.width, height: img.height, buffer: copy.buffer };
}

export function fromTransferable(t: TransferableImage): RgbaImage {
  return { width: t.width, height: t.height, data: new Uint8ClampedArray(t.buffer) };
}
