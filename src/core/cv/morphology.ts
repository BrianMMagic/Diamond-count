import type { GrayImage } from './image.ts';
import { createGray } from './image.ts';

/** 3x3 dilation: a pixel turns on if any neighbour is on. */
export function dilate(mask: GrayImage, iterations = 1): GrayImage {
  let src = mask;
  for (let it = 0; it < iterations; it++) {
    const out = createGray(src.width, src.height);
    const { width: w, height: h, data } = src;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (data[yy * w + xx]) {
              on = 1;
              break;
            }
          }
        }
        out.data[y * w + x] = on ? 255 : 0;
      }
    }
    src = out;
  }
  return src;
}

/** 3x3 erosion: a pixel stays on only if all neighbours are on. */
export function erode(mask: GrayImage, iterations = 1): GrayImage {
  let src = mask;
  for (let it = 0; it < iterations; it++) {
    const out = createGray(src.width, src.height);
    const { width: w, height: h, data } = src;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            // Outside the image counts as background, so edges erode away.
            if (yy < 0 || yy >= h || xx < 0 || xx >= w || !data[yy * w + xx]) {
              all = 0;
              break;
            }
          }
        }
        out.data[y * w + x] = all ? 255 : 0;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Close small gaps: dilate then erode.
 *
 * A printed digit photographed at a dozen pixels tall often arrives with its
 * strokes broken by noise or JPEG ringing. Each fragment is then too small to
 * pass a size filter and the whole digit is discarded as "no number found" —
 * which is far worse than the mild thickening this costs.
 */
export function close(mask: GrayImage, iterations = 1): GrayImage {
  return erode(dilate(mask, iterations), iterations);
}
