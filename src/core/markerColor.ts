/**
 * The colour of a marker's body, sampled from the rim around its printed face.
 *
 * Colour was removed from this pipeline once before, for a good reason: it was
 * being learned without supervision, so the app decided for itself which colour
 * meant which digit, and one mislabelled colour group is hundreds of wrong
 * markers at once with nothing on screen to say so.
 *
 * It comes back here under a different arrangement. The user marks one marker
 * per digit, so the colour-to-digit mapping is theirs, not a guess — a colour
 * can only ever name a digit a person pointed at. That removes the failure that
 * justified taking it out, and restores by far the strongest signal on a real
 * bead card: every marker's face is white with a black digit, but the bodies are
 * pearl, black, gold and pink, and those are not close to each other.
 *
 * Where the ring is sampled matters more than it looks. Beads do not sit edge to
 * edge, so an annulus drawn wide enough to be safe includes the artwork between
 * them, and the fur underneath drags every reading toward the same muddy
 * average: measured on the reference card, a band at 0.26-0.44 of the spacing
 * put the genuine pink `4`s within 45 of their own mean and the impostors as
 * close as 30 — overlapping, and useless. Sampled tight at 0.18-0.26, just
 * outside the printed face and inside the bead's own edge, the genuine `4`s all
 * sit within 12 and the nearest impostor is 66 away.
 */
import type { RgbaImage } from './cv/image.ts';

export type Rgb = [number, number, number];

/** Inner and outer edge of the sampled band, as fractions of marker spacing. */
export const RIM_INNER = 0.18;
export const RIM_OUTER = 0.26;

/**
 * Mean colour of the band around a marker's face.
 *
 * The median would be steadier against a stray highlight, but the band is small
 * and a mean over a few hundred pixels is already stable; the specular spot on a
 * glossy bead is part of what that bead looks like anyway.
 */
export function sampleRim(image: RgbaImage, cx: number, cy: number, pitch: number): Rgb {
  const r0 = pitch * RIM_INNER;
  const r1 = pitch * RIM_OUTER;
  const x0 = Math.max(0, Math.floor(cx - r1));
  const x1 = Math.min(image.width - 1, Math.ceil(cx + r1));
  const y0 = Math.max(0, Math.floor(cy - r1));
  const y1 = Math.min(image.height - 1, Math.ceil(cy + r1));
  const inner = r0 * r0;
  const outer = r1 * r1;

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 < inner || d2 > outer) continue;
      const i = (y * image.width + x) * 4;
      r += image.data[i];
      g += image.data[i + 1];
      b += image.data[i + 2];
      n++;
    }
  }
  if (n === 0) return [0, 0, 0];
  return [r / n, g / n, b / n];
}

/** Straight-line distance in RGB, which the measured gap makes ample here. */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Colour distance rescaled so it can be added to a shape distance.
 *
 * Shape distances run 0 to 1. On the reference card markers of the same digit
 * stayed within about 12 RGB of each other and different digits were 60 apart
 * or more, so dividing by 60 puts "same colour" near 0.2 and "different colour"
 * near or above 1 — the same range shape works in, without either signal being
 * able to silence the other.
 */
export const COLOR_SCALE = 60;

export function normalizedColorDistance(a: Rgb, b: Rgb): number {
  return colorDistance(a, b) / COLOR_SCALE;
}
