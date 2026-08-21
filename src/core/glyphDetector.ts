/**
 * Find markers by the digit printed on them.
 *
 * The previous detector looked for the marker's *ring*, using a radial-symmetry
 * transform over the brightness gradient. On this artwork the ring is the one
 * feature that is not invariant: a `3` bead has a gold rim, a `2` bead a black
 * one, and a `1` bead is pearl all over, its rim within a few grey levels of
 * its own face. That last case has no gradient to find, which is why the
 * reference photograph reported seven `3`s and no `2`s at all while being
 * covered in both.
 *
 * What every marker does have, whatever its body is made of, is a black digit
 * printed on a bright face. That is high-contrast by construction — it has to
 * be legible to the person doing the craft — so it survives the pearl bead, the
 * black bead on black fur, and the gold bead on gold fur alike.
 *
 * So detection looks for ink, and then asks whether that ink sits on a bright
 * disc. Finding the digit first also means every detection arrives with its
 * glyph already isolated, which is exactly what the classifier wants next.
 */
import type { GrayImage } from './cv/image.ts';
import { createGray } from './cv/image.ts';
import { buildIntegral, localMeanStd } from './cv/integral.ts';
import { sauvola } from './cv/threshold.ts';
import { connectedComponents } from './cv/connected.ts';
import type { Component, LabelResult } from './cv/connected.ts';

export interface GlyphDetection {
  /** Marker centre in the coordinates of the image passed in. */
  x: number;
  y: number;
  /** Bounding box of the ink that formed this detection. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Mean brightness of the printed face around the glyph. */
  faceMean: number;
  /** Mean brightness of the ink itself. */
  glyphMean: number;
  /** How strongly the face stands out from what surrounds the marker. */
  faceContrast: number;
  /**
   * Roughness of the face around the digit: its standard deviation over its
   * mean, counting only the bright pixels so the digit itself does not inflate
   * it. A printed face is smooth and scores low; fur, which is what survives
   * the contrast tests when a dark strand crosses pale hair, scores high.
   */
  faceRoughness: number;
  /** Combined detection quality, higher is better. */
  score: number;
  /**
   * True when this marker was found on an inverted copy of the image.
   *
   * Kits mix two kinds of marker: a dark digit printed on a light face, and a
   * light digit printed on a dark one. Everything here looks for the first, so
   * the second is found by looking at the image upside down in brightness, and
   * whoever reads the glyph afterwards has to be told which copy it came from.
   */
  inverted: boolean;
}

export interface GlyphDetectorOptions {
  /** Centre-to-centre marker spacing, from calibration. */
  pitch: number;
  /**
   * How much ink to accept. Raising it finds fainter digits and more noise;
   * the pipeline sweeps this rather than trusting one value.
   */
  k?: number;
  /**
   * Require the face to be at least this much brighter than the ink (0-255).
   *
   * Printed digits on the reference card clear 90-110. The default sits well
   * below that rather than near it: the markers that come closest to the bar
   * are the pearl ones on pale fur, which are the markers most worth keeping,
   * and a threshold tuned to the edge of the real population deletes them.
   * What it does exclude is fur shadow, which lands around 30.
   */
  minInkContrast?: number;
  /** Sauvola window as a fraction of pitch. Exposed for tuning sweeps. */
  windowFactor?: number;
  /** Largest glyph height as a fraction of pitch. Exposed for tuning sweeps. */
  maxGlyphHeight?: number;
  /** Skip the self-calibrating size band. Used when a caller applies its own. */
  keepAllSizes?: boolean;
}

/** Ink components smaller than this fraction of the pitch are paper noise. */
const MIN_GLYPH_H = 0.12;
/**
 * Ink components taller than this fraction of the spacing are artwork.
 *
 * The bound is on the *marker spacing*, not the marker, so how much of a card's
 * spacing a digit occupies depends on how tightly its markers are laid out. On
 * a card whose beads sit apart, a 31px digit against 70px spacing fills 0.44 of
 * it. On a card whose beads touch, the same relationship gives 0.8 — the digit
 * is no bigger relative to its own bead, there is simply no gap between beads to
 * dilute it.
 *
 * At 0.5 the second kind of card lost every real marker: the digits were all
 * rejected as too tall and what survived was fur between the beads, 82
 * detections where there were over six hundred markers. A digit cannot be
 * larger than the marker carrying it and markers cannot overlap, so anything up
 * to the full spacing is physically possible; 0.8 keeps that headroom while
 * still excluding the large artwork this test exists to reject.
 */
const MAX_GLYPH_H = 0.8;

/** A brightness-inverted copy: light ink on a dark face becomes dark on light. */
export function invertGray(src: GrayImage): GrayImage {
  const out = createGray(src.width, src.height);
  for (let i = 0; i < src.data.length; i++) out.data[i] = 255 - src.data[i];
  return out;
}

/**
 * Find markers of both polarities.
 *
 * A single card commonly carries both: on one real card the `3`s are a black
 * digit on a cream bead and the `7`s a white digit on a black bead. Every test
 * in this file asks whether some ink is dark against a bright face, so the
 * second kind fails all of them — not marginally, but by construction, and no
 * amount of marking examples can rescue a marker that was never detected. That
 * card reported 420 markers, every one of them a `3`, with 433 `7`s invisible.
 *
 * Inverting the image turns the second kind into the first, so the same tests
 * apply unchanged. Suppression is run again over the union because a marker can
 * be proposed by both passes, and the stronger reading should win.
 */
/**
 * Find markers of both polarities.
 *
 * Kits mix two kinds: a dark digit on a light face, and a light digit on a dark
 * one. Everything else in this file asks whether some ink is dark against a
 * bright face, so the second kind fails every test by construction — a real card
 * reported 420 markers, all of them `3`s, with its 400-odd `7`s invisible, and
 * because they were never detected no amount of marking examples could rescue
 * them. Inverting the image turns the second kind into the first.
 *
 * This is not run unless the caller has a reason to believe the card has a
 * second polarity, and the reason is deliberately not a guess. Inverting an
 * ordinary card turns every marker's own face into something that reads as a
 * glyph, so the inverted pass always returns plenty — hundreds of confident
 * readings of the wrong feature, which displace real markers when merged. Every
 * automatic test tried for telling the two apart worked on some cards and failed
 * on others: size agreement, face roughness, how much of the pass landed where
 * the first found nothing. The one signal that does not need a threshold is a
 * user marking an example on a marker the first pass cannot see.
 */
export function detectMarkers(gray: GrayImage, opts: GlyphDetectorOptions): GlyphDetection[] {
  const onLight = detectGlyphs(gray, opts);
  if (onLight.length < 8) return onLight;

  // Size the second pass against the first, rather than against itself. On a
  // sheet with both polarities the impostors outnumbered the real markers, so
  // the pass's self-calibrating band took its median from them and discarded
  // every real marker as the wrong size. Judged against the digit height the
  // first pass established, the impostors go instead: they are the size of a
  // marker face, and a digit is not.
  const band = heightBand(onLight);
  const onDark = detectGlyphs(invertGray(gray), { ...opts, keepAllSizes: true })
    .filter((d) => {
      const h = d.maxY - d.minY + 1;
      return h >= band.lo && h <= band.hi;
    })
    .map((d) => ({ ...d, inverted: true }));
  if (onDark.length === 0) return onLight;

  // Keep only the inverted markers that are somewhere new.
  //
  // An inverted detection on top of a marker the first pass already found is
  // that same bead read a second time, and read worse: it describes the face
  // rather than the digit, so its glyph is meaningless and it drags whatever it
  // is compared against. On one card those impostors turned a 434/396 split
  // into 245/582. A genuine light-on-dark marker is a different bead, so it sits
  // where the first pass found nothing and this costs it nothing at all.
  const elsewhere = onDark.filter((d) => !hasNeighbour(onLight, d, opts.pitch * 0.55));
  if (elsewhere.length === 0) return onLight;
  return suppressNeighbours([...onLight, ...elsewhere], opts.pitch);
}

/** Whether `existing` holds anything within `limit` of `probe`. */
function hasNeighbour(existing: GlyphDetection[], probe: GlyphDetection, limit: number): boolean {
  for (const d of existing) {
    if (Math.abs(d.x - probe.x) > limit || Math.abs(d.y - probe.y) > limit) continue;
    if (Math.hypot(d.x - probe.x, d.y - probe.y) < limit) return true;
  }
  return false;
}

/** The height range the first pass established for this card's digits. */
function heightBand(items: GlyphDetection[]): { lo: number; hi: number } {
  const heights = items.map((d) => d.maxY - d.minY + 1).sort((a, b) => a - b);
  const mid = heights[heights.length >> 1] || 1;
  return { lo: mid * 0.72, hi: mid * 1.4 };
}

export function detectGlyphs(gray: GrayImage, opts: GlyphDetectorOptions): GlyphDetection[] {
  const { pitch } = opts;
  const k = opts.k ?? 0.28;
  const minInkContrast = opts.minInkContrast ?? 60;

  // The Sauvola window has to be wide enough to span the digit and some of the
  // face around it. Sized off the digit rather than the marker, a window that
  // fits inside the glyph makes its own strokes the local "background" and the
  // digit dissolves.
  const window = Math.max(3, Math.round(pitch * (opts.windowFactor ?? 0.22)));
  const ink = sauvola(gray, window, k);

  const labelled = connectedComponents(ink, false);
  const integral = buildIntegral(gray);

  const minH = pitch * MIN_GLYPH_H;
  const maxH = pitch * (opts.maxGlyphHeight ?? MAX_GLYPH_H);

  const kept: GlyphDetection[] = [];
  for (const c of labelled.components) {
    const w = c.maxX - c.minX + 1;
    const h = c.maxY - c.minY + 1;
    if (h < minH || h > maxH) continue;
    if (w > maxH) continue;
    // Printed digits are taller than they are wide. Fur and shadow fragments
    // are frequently the other way round.
    if (w > h * 1.6) continue;
    // Ink that fills almost none of its own box is a thin artwork edge.
    if (c.area < w * h * 0.12) continue;

    const detection = measureFace(gray, integral, labelled, c, pitch, minInkContrast);
    if (detection) kept.push(detection);
  }

  // Size first, then suppression.
  //
  // The other order loses markers outright. A marker's own ring is about 0.8 of
  // the spacing tall, so it passes the height bound and arrives as a candidate
  // sitting exactly where the digit is; it can outscore the digit in
  // suppression, and is then dropped by the size band — which takes the marker
  // with it. Removing the wrong-sized candidates before anything competes means
  // suppression only ever chooses between plausible markers.
  const merged = mergeGlyphParts(kept, pitch);
  return suppressNeighbours(opts.keepAllSizes ? merged : rejectSizeOutliers(merged), pitch);
}

/**
 * Drop detections whose digit is the wrong size for this card.
 *
 * Printed digits on one card are strikingly uniform — across the reference
 * photograph every real marker's glyph stood between 29 and 34 pixels tall,
 * a spread of under a fifth, because they came off the same press at the same
 * scale. What survives the contrast tests and is *not* a marker generally does
 * not: a dark strand crossing pale fur reads as genuine black ink on a genuine
 * bright face, and passes every photometric check, but came out 18 pixels tall
 * next to neighbours at 29.
 *
 * The band is taken from the image's own population rather than fixed, so it
 * carries over to a card printed at a different size or shot from further away.
 * It is set wide enough to keep both extremes seen on the reference card and
 * still exclude something a third too small.
 */
function rejectSizeOutliers(items: GlyphDetection[]): GlyphDetection[] {
  if (items.length < 12) return items;
  const heights = items.map((d) => d.maxY - d.minY + 1).sort((a, b) => a - b);
  const mid = heights[Math.floor(heights.length / 2)];
  if (mid <= 0) return items;
  const lo = mid * 0.72;
  const hi = mid * 1.4;
  return items.filter((d) => {
    const h = d.maxY - d.minY + 1;
    return h >= lo && h <= hi;
  });
}

/**
 * Decide whether a piece of ink is sitting on a marker face.
 *
 * Two brightness comparisons, at different distances. The inner one asks
 * whether the ink is dark against its immediate surroundings — true of a digit
 * on a white face, false of a dark fur detail against dark fur. The outer one
 * asks whether that bright patch is itself distinct from the artwork further
 * out, which is what separates a marker from a highlight on pale fur.
 */
function measureFace(
  gray: GrayImage,
  integral: ReturnType<typeof buildIntegral>,
  labelled: LabelResult,
  c: Component,
  pitch: number,
  minInkContrast: number,
): GlyphDetection | null {
  const cx = c.cx;
  const cy = c.cy;

  const faceRadius = Math.max(2, Math.round(pitch * 0.22));
  const outerRadius = Math.max(faceRadius + 2, Math.round(pitch * 0.45));

  const rough = localMeanStd(integral, Math.round(cx), Math.round(cy), faceRadius);
  const outer = localMeanStd(integral, Math.round(cx), Math.round(cy), outerRadius);
  const glyphMean = meanOfComponent(gray, labelled, c);

  // Measure the face without the digit standing on it.
  //
  // A window centred on the glyph necessarily contains the glyph, so a mean
  // taken over all of it is pulled down in proportion to how much ink the digit
  // carries. That turns both tests below into partial measurements of which
  // digit is being looked at: a `1` is a solid bar sitting squarely in the
  // middle of the window, and its "face" came out around 7 grey levels darker
  // than its own surroundings — enough to fail a check meant to catch things
  // that are not markers at all, and it silently deleted `1`s in proportion to
  // how large the markers were.
  const face = sampleFace(gray, cx, cy, faceRadius, (rough.mean + glyphMean) / 2);
  const faceMean = face.n >= 8 ? face.mean : rough.mean;

  const inkContrast = faceMean - glyphMean;
  if (inkContrast < minInkContrast) return null;

  // The face must be the brighter thing locally. Equality is allowed a little
  // slack because a pearl marker on pale fur genuinely is close to its
  // surroundings — that case is carried by the ink contrast above instead.
  const faceContrast = faceMean - outer.mean;
  if (faceContrast < -6) return null;

  const score = inkContrast + Math.max(0, faceContrast) * 0.5;
  return {
    x: cx,
    y: cy,
    minX: c.minX,
    minY: c.minY,
    maxX: c.maxX,
    maxY: c.maxY,
    faceMean,
    glyphMean,
    faceContrast,
    faceRoughness: face.roughness,
    score,
    inverted: false,
  };
}

/**
 * Brightness and evenness of the marker face, ignoring the digit printed on it.
 *
 * Pixels darker than `split` are the digit and are left out. Including them
 * makes both figures depend on how much ink the digit happens to carry, so a
 * `4` and a `1` would be measured on different scales.
 */
function sampleFace(
  gray: GrayImage,
  cx: number,
  cy: number,
  radius: number,
  split: number,
): { mean: number; roughness: number; n: number } {
  const x0 = Math.max(0, Math.round(cx - radius));
  const x1 = Math.min(gray.width - 1, Math.round(cx + radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const y1 = Math.min(gray.height - 1, Math.round(cy + radius));
  const r2 = radius * radius;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * gray.width;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy > r2) continue;
      const v = gray.data[row + x];
      if (v < split) continue;
      n++;
      sum += v;
      sumSq += v * v;
    }
  }
  if (n < 8) return { mean: 0, roughness: 1, n };
  const mean = sum / n;
  if (mean <= 0) return { mean: 0, roughness: 1, n };
  const roughness = Math.sqrt(Math.max(0, sumSq / n - mean * mean)) / mean;
  return { mean, roughness, n };
}

/**
 * Mean brightness of the ink itself.
 *
 * Only pixels carrying this component's label are counted. Averaging the
 * bounding box instead looks like a shortcut and is not: a `1` fills a small
 * fraction of its own box and the rest is bright face, so the "ink" mean comes
 * out close to the face mean and the contrast test it feeds measures nothing.
 * Every marker on the reference card sat under an ink contrast of 45 that way,
 * when true black-on-white contrast is nearer 150.
 */
function meanOfComponent(gray: GrayImage, labelled: LabelResult, c: Component): number {
  let total = 0;
  let n = 0;
  for (let y = c.minY; y <= c.maxY; y++) {
    const row = y * gray.width;
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labelled.labels[row + x] !== c.label) continue;
      total += gray.data[row + x];
      n++;
    }
  }
  return n > 0 ? total / n : 0;
}

/**
 * Join ink that belongs to one digit.
 *
 * Printing and JPEG noise break a stroke in two often enough to matter, and a
 * `4` can arrive as separate pieces outright. Anything close enough that the
 * combined ink still fits inside one marker face is the same digit.
 */
function mergeGlyphParts(items: GlyphDetection[], pitch: number): GlyphDetection[] {
  const limit = pitch * 0.3;
  const used = new Array<boolean>(items.length).fill(false);
  const out: GlyphDetection[] = [];

  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    let group = [items[i]];
    used[i] = true;
    // One pass is enough at these separations; a digit is never more than a
    // few fragments.
    for (let j = i + 1; j < items.length; j++) {
      if (used[j]) continue;
      const near = group.some(
        (g) => Math.hypot(g.x - items[j].x, g.y - items[j].y) < limit,
      );
      if (!near) continue;
      const merged = boxOf([...group, items[j]]);
      if (merged.maxX - merged.minX > pitch * 0.55) continue;
      if (merged.maxY - merged.minY > pitch * 0.55) continue;
      group.push(items[j]);
      used[j] = true;
    }
    out.push(combine(group));
  }
  return out;
}

function boxOf(group: GlyphDetection[]) {
  return {
    minX: Math.min(...group.map((g) => g.minX)),
    minY: Math.min(...group.map((g) => g.minY)),
    maxX: Math.max(...group.map((g) => g.maxX)),
    maxY: Math.max(...group.map((g) => g.maxY)),
  };
}

function combine(group: GlyphDetection[]): GlyphDetection {
  if (group.length === 1) return group[0];
  const box = boxOf(group);
  const best = group.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    ...best,
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    ...box,
    score: Math.max(...group.map((g) => g.score)),
  };
}

/**
 * One marker, one detection.
 *
 * Markers on this artwork are printed roughly tangent but not overlapping, so
 * anything well inside a marker's own spacing is a duplicate reading of it
 * rather than a neighbour.
 */
function suppressNeighbours(items: GlyphDetection[], pitch: number): GlyphDetection[] {
  const limit = pitch * 0.55;
  // Where both polarities claim the same spot, prefer the ordinary reading.
  //
  // Inverting the image turns an ordinary marker's own face into something that
  // reads as a glyph, sitting exactly where that marker's digit is. Left to
  // score alone it can win, and the marker is then described by its face instead
  // of its digit — on one card that cut the count of a digit from 434 to 159.
  // A genuine second-polarity marker is somewhere else entirely, so it never
  // competes with anything and the preference costs it nothing.
  const rank = (d: GlyphDetection) => d.score * (d.inverted ? 1 : 1.25);
  const sorted = [...items].sort((a, b) => rank(b) - rank(a));
  const cell = Math.max(4, limit);
  const grid = new Map<string, GlyphDetection[]>();
  const out: GlyphDetection[] = [];

  for (const item of sorted) {
    const gx = Math.floor(item.x / cell);
    const gy = Math.floor(item.y / cell);
    let clash = false;
    for (let dy = -1; dy <= 1 && !clash; dy++) {
      for (let dx = -1; dx <= 1 && !clash; dx++) {
        for (const other of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(other.x - item.x, other.y - item.y) < limit) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    out.push(item);
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(item);
    else grid.set(key, [item]);
  }
  return out;
}
