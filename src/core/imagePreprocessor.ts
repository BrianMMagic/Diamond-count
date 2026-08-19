import type { GrayImage, RgbaImage } from './cv/image.ts';
import { toGray } from './cv/color.ts';
import { autoContrast, normalizeIllumination, smooth, sobel, unsharp } from './cv/filters.ts';
import type { Gradient } from './cv/filters.ts';
import { downscaleRgba } from './cv/resize.ts';

export interface PreparedImage {
  /** Untouched full-resolution source. Never mutated. */
  original: RgbaImage;
  /** Colour working copy used for detection and colour sampling. */
  working: RgbaImage;
  /** Grayscale of `working`. */
  gray: GrayImage;
  /** Illumination-flattened, contrast-normalised grayscale used for detection. */
  detection: GrayImage;
  /** Sobel gradient of `detection`, mildly smoothed to survive JPEG noise. */
  gradient: Gradient;
  /** working = original * scale. */
  scale: number;
}

export interface PrepareOptions {
  /** Longest edge of the working copy in pixels. */
  workingResolution: number;
  /** Radius (working px) of the illumination-flattening background estimate. */
  flattenRadius?: number;
  /** Set false to skip the sharpening pass (useful in tests). */
  sharpen?: boolean;
}

/**
 * Turn an uploaded photo into the set of buffers the detector needs.
 *
 * The original is kept pristine — crops for OCR and colour sampling are taken
 * from it at full resolution — while detection runs on a normalised working
 * copy that is small enough to process quickly but still large enough that a
 * marker is tens of pixels across.
 */
export function prepareImage(original: RgbaImage, opts: PrepareOptions): PreparedImage {
  const longest = Math.max(original.width, original.height);
  const scale = Math.min(1, opts.workingResolution / longest);
  const working = scale < 1 ? downscaleRgba(original, scale) : { ...original, data: new Uint8ClampedArray(original.data) };

  const gray = toGray(working);
  const flattenRadius = opts.flattenRadius ?? Math.max(8, Math.round(Math.max(working.width, working.height) / 40));
  // Flatten first (kills shadows/vignetting), then stretch what is left.
  let detection = normalizeIllumination(gray, flattenRadius, 0.85);
  detection = autoContrast(detection, 0.4);
  if (opts.sharpen !== false) detection = unsharp(detection, 1, 0.6);

  // One light smoothing pass before Sobel: JPEG blocking creates spurious
  // gradients that would otherwise cast votes all over the symmetry map.
  const gradient = sobel(smooth(detection, 1));

  return { original, working, gray, detection, gradient, scale: working.width / original.width };
}
