import type { GrayImage, RgbaImage } from './image.ts';
import { createGray } from './image.ts';

/**
 * Rec.601 luma.
 *
 * The only colour operation left in the pipeline. Everything downstream works
 * on grayscale: markers are identified by the shape of the digit printed on
 * them, never by what colour the marker is. The Lab conversions and perceptual
 * distance that used to live here went with the colour classifier.
 */
export function toGray(src: RgbaImage): GrayImage {
  const out = createGray(src.width, src.height);
  const s = src.data;
  const d = out.data;
  for (let i = 0, j = 0; j < d.length; i += 4, j++) {
    d[j] = (s[i] * 299 + s[i + 1] * 587 + s[i + 2] * 114) / 1000;
  }
  return out;
}
