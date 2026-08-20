/**
 * Calibration: what the user tells us about an image before analysis runs.
 *
 * The previous pipeline measured marker size by sweeping a radial-symmetry
 * transform across candidate radii and keeping the winning scale. On the
 * reference photograph that estimate came out at 53px against a true diameter
 * near 35, and because the detector's suppression distance is derived from the
 * radius, an over-large estimate silently deletes real markers: 593 were found
 * where roughly 1500 exist. The estimator has no way to notice it is wrong.
 *
 * Two clicks on adjacent markers remove that entire failure class, so the
 * spacing here is measured from the user's input and never guessed. The
 * autocorrelation estimate below exists only to place the initial guess in the
 * UI — the user confirms or drags it, and their value is what analysis uses.
 */
import type { GrayImage } from './cv/image.ts';
import { downscaleGray } from './cv/resize.ts';
import { normalizeIllumination } from './cv/filters.ts';
import { median } from './cv/threshold.ts';

/** One digit the user identified, with the patch they pointed at. */
export interface Exemplar {
  /** The digit printed inside the marker, as the user labelled it. */
  digit: string;
  /** Centre in original-image coordinates. */
  x: number;
  y: number;
}

export interface Calibration {
  /** Centre-to-centre distance between adjacent markers, in original pixels. */
  pitch: number;
  /** Marker radius in original pixels. */
  radius: number;
  /** One user-labelled example per distinct digit. */
  exemplars: Exemplar[];
}

/** The digit set, derived from what the user actually labelled. */
export function digitSet(cal: Calibration): string[] {
  return [...new Set(cal.exemplars.map((e) => e.digit))].sort();
}

/**
 * Build a calibration from the two clicks that set scale.
 *
 * Radius is derived from pitch rather than asked for separately. Markers in
 * these kits are printed nearly tangent — the ring of one almost touches the
 * next — so the radius is a hair under half the spacing. Asking the user to
 * click a rim as well would add a click and a source of error to recover a
 * number we can infer within a few percent.
 */
export function calibrationFromSpacing(a: Point, b: Point, exemplars: Exemplar[] = []): Calibration {
  const pitch = Math.hypot(b.x - a.x, b.y - a.y);
  return { pitch, radius: pitch * 0.46, exemplars };
}

export interface Point {
  x: number;
  y: number;
}

export interface PitchEstimate {
  /** Best spacing in original-image pixels, or 0 if nothing periodic was found. */
  pitch: number;
  /** Peak sharpness, 0-1. Low values mean the UI should not pre-fill a guess. */
  strength: number;
}

/**
 * Estimate marker spacing from the image's own periodicity.
 *
 * A grid of markers is a periodic signal, so its autocorrelation has a peak at
 * the grid spacing. Correlating along rows and columns separately (rather than
 * a full 2D transform) is enough: these grids are laid out square, and a photo
 * taken by hand is rotated by a few degrees at most, which broadens the peak
 * without moving it.
 *
 * Illumination is flattened first. Without that, the slow brightness ramp
 * across a photographed page dominates the correlation at every lag and buries
 * the periodic component entirely.
 */
export function estimatePitch(gray: GrayImage, maxPitch = 0): PitchEstimate {
  // Scale the search range to the image rather than fixing it. A photograph
  // taken closer, or on a better camera, puts the markers further apart in
  // pixels; with the range capped at a constant the true spacing falls outside
  // it and the estimate does not degrade, it collapses — a sheet whose markers
  // sat 135px apart returned nothing at all against a cap of 120.
  if (maxPitch <= 0) {
    maxPitch = Math.max(120, Math.min(gray.width, gray.height) / 8);
  }
  // Work small. Spacing is a low-frequency property and the cost is quadratic
  // in the number of lags we test.
  const scale = Math.min(1, 900 / Math.max(gray.width, gray.height));
  const small = scale < 1 ? downscaleGray(gray, scale) : gray;
  // The flattening window has to be wider than the spacing being looked for.
  // Anything narrower averages over a marker and its neighbours and subtracts
  // away the very periodicity this function exists to find.
  const flatRadius = Math.max(8, Math.round(maxPitch * scale));
  const flat = normalizeIllumination(small, flatRadius, 1);

  const { width: w, height: h, data } = flat;
  const mean = sum(data) / data.length;

  const minLag = 4;
  const maxLag = Math.min(Math.round(maxPitch * scale), Math.floor(Math.min(w, h) / 3));
  if (maxLag <= minLag) return { pitch: 0, strength: 0 };

  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    let n = 0;
    // Horizontal pairs.
    for (let y = 0; y < h; y += 2) {
      const row = y * w;
      for (let x = 0; x + lag < w; x += 2) {
        acc += (data[row + x] - mean) * (data[row + x + lag] - mean);
        n++;
      }
    }
    // Vertical pairs.
    for (let y = 0; y + lag < h; y += 2) {
      const row = y * w;
      const row2 = (y + lag) * w;
      for (let x = 0; x < w; x += 2) {
        acc += (data[row + x] - mean) * (data[row2 + x] - mean);
        n++;
      }
    }
    scores[lag] = n > 0 ? acc / n : 0;
  }

  const baseline = median(Array.from(scores.slice(minLag, maxLag + 1)));
  const peaks: Array<{ lag: number; score: number }> = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const s = scores[lag];
    if (s <= scores[lag - 1] || s < scores[lag + 1]) continue;
    if (s <= baseline) continue;
    peaks.push({ lag, score: s });
  }
  if (peaks.length === 0) return { pitch: 0, strength: 0 };

  // A grid correlates with itself at its spacing and again at every multiple of
  // it, so the tallest peak is not necessarily the spacing — it is often twice
  // it. The fundamental is the earliest peak that is still a serious one, so
  // take the strongest, then walk back to the first peak that comes close to
  // matching it.
  const strongest = peaks.reduce((a, b) => (b.score > a.score ? b : a));
  const fundamental = peaks.find((p) => p.score >= strongest.score * 0.5) ?? strongest;

  const peak = refinePeak(scores, fundamental.lag);
  const spread = Math.max(0, strongest.score - baseline);
  const strength = Math.max(0, Math.min(1, spread / (Math.abs(strongest.score) + 1e-6)));
  return { pitch: peak / scale, strength };
}

/** Sub-pixel peak position by fitting a parabola through the peak and its neighbours. */
function refinePeak(scores: Float64Array, i: number): number {
  const a = scores[i - 1];
  const b = scores[i];
  const c = scores[i + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return i;
  const shift = (0.5 * (a - c)) / denom;
  return Number.isFinite(shift) && Math.abs(shift) < 1 ? i + shift : i;
}

function sum(data: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < data.length; i++) total += data[i];
  return total;
}
