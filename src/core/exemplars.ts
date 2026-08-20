/**
 * Naming the digits from examples the user pointed at.
 *
 * Without exemplars the app groups markers by shape and then reads each averaged
 * picture against a generic stroke font. That font has never seen the kit's
 * typeface, and on a real card it is the weakest link: the `4`s on the reference
 * photograph were grouped correctly and still collected seven markers that were
 * plainly `1`s, `2`s and `3`s, because at this print size those glyphs genuinely
 * resemble a `4` once averaged and blurred.
 *
 * An exemplar replaces the guess with a fact. The user taps one marker per digit
 * and says what it is, which supplies two things the pipeline cannot work out on
 * its own: the right name for the shape, and — decisively — what that digit's
 * bead looks like. Every marker on this card has a white face and a black digit,
 * so shape is all the reader has; the bodies are pearl, black, gold and pink,
 * which are not close to each other at all.
 *
 * Shape is taken from the group's averaged picture, which is sharp because it is
 * the mean of hundreds. Colour is taken from the individual marker, because that
 * is what separates one marker from its neighbours in the same group. Using both
 * at the level each is reliable at is the whole idea.
 */
import type { GlyphMask } from './glyphShape.ts';
import { glyphDistance } from './glyphShape.ts';
import type { Rgb } from './markerColor.ts';
import { normalizedColorDistance } from './markerColor.ts';

/** One marker the user identified, with everything measured at that point. */
export interface Exemplar {
  digit: number;
  /** Where the user tapped, in original-image pixels. */
  x: number;
  y: number;
  glyph: GlyphMask;
  rim: Rgb;
}

export interface ExemplarMatch {
  digit: number | null;
  /** Combined shape-and-colour distance to the winning exemplar. */
  distance: number;
  /** How much better the winner was than the runner-up, 0-1. */
  margin: number;
}

/**
 * How much colour is allowed to weigh against shape.
 *
 * Shape leads, because it is what a digit *is* and it survives a kit whose
 * beads are all one colour. Colour is the tie-breaker, which is the role that
 * suits the evidence: on the reference card it separated the genuine `4`s from
 * their impostors by better than five to one, while shape could not separate
 * them at all.
 */
const COLOR_WEIGHT = 0.8;

/**
 * Name one marker.
 *
 * `shape` should be the averaged picture of the group the marker belongs to, not
 * the marker's own glyph: a single glyph at this print size is too noisy to
 * decide anything by, which is why they were grouped in the first place.
 */
export function matchExemplar(
  shape: GlyphMask,
  rim: Rgb,
  exemplars: Exemplar[],
): ExemplarMatch {
  if (exemplars.length === 0) return { digit: null, distance: Infinity, margin: 0 };

  // Collapse to the best example of each DIGIT before comparing.
  //
  // The margin has to say "how much better is this number than the next
  // number", not "how much better is this example than the next example". Those
  // are the same thing only while there is exactly one example per digit. Add a
  // second `4` and the runner-up to a `4` becomes the other `4`, so the margin
  // collapses to nothing on markers that are in fact certain — which is why
  // marking more examples made the review queue grow from 12 to 70 instead of
  // shrinking it.
  const bestPerDigit = new Map<number, number>();
  for (const e of exemplars) {
    const d = glyphDistance(shape, e.glyph) + COLOR_WEIGHT * normalizedColorDistance(rim, e.rim);
    const seen = bestPerDigit.get(e.digit);
    if (seen === undefined || d < seen) bestPerDigit.set(e.digit, d);
  }

  let best: { digit: number; d: number } | null = null;
  let second = Infinity;
  for (const [digit, d] of bestPerDigit) {
    if (!best || d < best.d) {
      if (best) second = best.d;
      best = { digit, d };
    } else if (d < second) {
      second = d;
    }
  }
  if (!best) return { digit: null, distance: Infinity, margin: 0 };
  const margin = Number.isFinite(second) && second > 0 ? Math.max(0, Math.min(1, (second - best.d) / second)) : 1;
  return { digit: best.digit, distance: best.d, margin };
}

/**
 * The distinct digits the user has identified so far.
 *
 * This doubles as the number set: a digit nobody pointed at cannot be produced,
 * which is the constraint the old pipeline needed a separate picker to express.
 */
export function exemplarDigits(exemplars: Exemplar[]): number[] {
  return [...new Set(exemplars.map((e) => e.digit))].sort((a, b) => a - b);
}
