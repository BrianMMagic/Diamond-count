import { GLYPH_SIZE } from './markerCropper.ts';
import type { Glyph, MarkerCrop } from './markerCropper.ts';

/**
 * Group the markers by the SHAPE of the digit printed on them, then read the
 * average of each group.
 *
 * A single digit on these cards is 10-15 pixels tall, which no OCR engine reads
 * dependably — but the noise on one marker is independent of the noise on the
 * next, so averaging two hundred of them cancels it and leaves a sharp glyph.
 * That turns "read seven hundred blurry digits" into "read six clean pictures",
 * and it needs no colour at all: markers are matched against each other rather
 * than against a typeface, so nothing depends on a kit using the ink colours we
 * happened to expect.
 */

export interface GlyphCluster {
  index: number;
  /** Marker indices belonging to this cluster. */
  members: number[];
  /** Averaged, denoised glyph: the picture we actually read. */
  prototype: Uint8ClampedArray;
  /** Grey-level average before thresholding, 0..1 — high contrast means tight. */
  sharpness: number;
  /** Mean distance of members to the prototype, in pixels. */
  spread: number;
  /** How many glyphs each member had (1, or 2 for a "10"). */
  glyphCount: number;
}

/** Chamfer distance transform of a 32x32 mask (3-4 approximation). */
function distanceTransform(mask: ArrayLike<number>): Float32Array {
  const size = GLYPH_SIZE;
  const d = new Float32Array(size * size);
  const BIG = 1e6;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : BIG;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? BIG : d[y * size + x]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

interface Signature {
  markerIndex: number;
  masks: Uint8ClampedArray[];
  transforms: Float32Array[];
  inkCounts: number[];
}

function signatureFor(markerIndex: number, glyphs: Glyph[]): Signature | null {
  if (glyphs.length === 0 || glyphs.length > 2) return null;
  const masks = glyphs.map((g) => g.mask);
  return {
    markerIndex,
    masks,
    transforms: masks.map(distanceTransform),
    inkCounts: masks.map((m) => m.reduce((s, v) => s + (v ? 1 : 0), 0)),
  };
}

/** Symmetric mean chamfer distance between two glyph signatures, in pixels. */
function distance(a: Signature, b: Signature): number {
  // A one-digit marker and a two-digit marker are never the same thing.
  if (a.masks.length !== b.masks.length) return Infinity;
  let total = 0;
  for (let k = 0; k < a.masks.length; k++) {
    if (a.inkCounts[k] === 0 || b.inkCounts[k] === 0) return Infinity;
    let ab = 0;
    let ba = 0;
    for (let i = 0; i < a.masks[k].length; i++) {
      if (a.masks[k][i]) ab += b.transforms[k][i];
      if (b.masks[k][i]) ba += a.transforms[k][i];
    }
    total += (ab / a.inkCounts[k] + ba / b.inkCounts[k]) / 2;
  }
  return total / a.masks.length;
}

export interface ClusterGlyphOptions {
  /**
   * Two glyphs closer than this (pixels) are the same digit.
   *
   * Measured, not guessed: across a sheet of known digits, two instances of the
   * same digit never exceeded 0.51 apart while two different digits never came
   * closer than 0.85, so the boundary sits in that gap with room either side.
   */
  joinDistance: number;
  /**
   * Clusters whose AVERAGED shapes are closer than this are merged.
   *
   * Averaging removes most of the noise that made two piles of the same digit
   * look distinct, so prototypes can be compared far more strictly than raw
   * glyphs — this is what repairs over-splitting on a noisy photograph.
   */
  mergeDistance: number;
  /** Hard cap on how many distinct shapes an image may contain. */
  maxClusters: number;
  /** Clusters smaller than this are dissolved and their members reassigned. */
  minClusterSize: number;
}

export const DEFAULT_GLYPH_CLUSTERING: ClusterGlyphOptions = {
  joinDistance: 0.7,
  mergeDistance: 0.55,
  maxClusters: 24,
  minClusterSize: 3,
};

export interface GlyphClusterResult {
  clusters: GlyphCluster[];
  /** Cluster index per marker; -1 when the marker had no readable glyph. */
  assignment: Int32Array;
  /** Markers with no glyph at all — nothing to match. */
  unreadable: number[];
}

/**
 * Agglomerate glyphs into shape clusters.
 *
 * Distance transforms are computed once per glyph and reused, so comparing
 * hundreds of markers stays cheap. Members join the nearest prototype; the
 * prototype is then rebuilt as the average of its members, which sharpens it as
 * the cluster grows and makes later joins more reliable than earlier ones — so a
 * second pass reassigns everything against the finished prototypes.
 */
export function clusterGlyphs(
  crops: MarkerCrop[],
  opts: ClusterGlyphOptions = DEFAULT_GLYPH_CLUSTERING,
): GlyphClusterResult {
  const assignment = new Int32Array(crops.length).fill(-1);
  const unreadable: number[] = [];
  const signatures: Signature[] = [];
  crops.forEach((crop, i) => {
    const sig = signatureFor(i, crop.glyphs);
    if (sig) signatures.push(sig);
    else unreadable.push(i);
  });
  if (signatures.length === 0) return { clusters: [], assignment, unreadable };

  // Bigger, better-formed glyphs seed the clusters, so prototypes start clean.
  const order = signatures
    .map((s, i) => ({ i, ink: s.inkCounts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.ink - a.ink)
    .map((o) => o.i);

  const seeds: Signature[] = [];
  const buckets: number[][] = [];
  for (const oi of order) {
    const sig = signatures[oi];
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < seeds.length; c++) {
      const d = distance(sig, seeds[c]);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best >= 0 && bestD <= opts.joinDistance) {
      buckets[best].push(oi);
    } else if (seeds.length < opts.maxClusters) {
      seeds.push(sig);
      buckets.push([oi]);
    } else if (best >= 0) {
      buckets[best].push(oi);
    }
  }

  // Rebuild each prototype from its members, then reassign everything against
  // the finished prototypes so early joins are not privileged over later ones.
  let prototypes = buckets.map((members, c) => buildPrototype(signatures, members, seeds[c].masks.length));

  // Merge piles that turned out to be the same digit once averaged.
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let a = 0; a < prototypes.length; a++) {
      for (let b = a + 1; b < prototypes.length; b++) {
        if (distance(prototypes[a].signature, prototypes[b].signature) > opts.mergeDistance) continue;
        buckets[a] = buckets[a].concat(buckets[b]);
        buckets.splice(b, 1);
        prototypes.splice(b, 1);
        prototypes[a] = buildPrototype(signatures, buckets[a], prototypes[a].glyphCount);
        merged = true;
        break outer;
      }
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    const next: number[][] = prototypes.map(() => []);
    for (let si = 0; si < signatures.length; si++) {
      let best = -1;
      let bestD = Infinity;
      for (let c = 0; c < prototypes.length; c++) {
        const d = distance(signatures[si], prototypes[c].signature);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best >= 0) next[best].push(si);
    }
    prototypes = next.map((members, c) =>
      members.length > 0 ? buildPrototype(signatures, members, prototypes[c].glyphCount) : prototypes[c],
    );
    buckets.length = 0;
    buckets.push(...next);
  }

  const clusters: GlyphCluster[] = [];
  buckets.forEach((members, c) => {
    if (members.length < opts.minClusterSize) return;
    const proto = prototypes[c];
    const index = clusters.length;
    for (const si of members) assignment[signatures[si].markerIndex] = index;
    clusters.push({
      index,
      members: members.map((si) => signatures[si].markerIndex),
      prototype: proto.flat,
      sharpness: proto.sharpness,
      spread: members.length
        ? members.reduce((s, si) => s + distance(signatures[si], proto.signature), 0) / members.length
        : 0,
      glyphCount: proto.glyphCount,
    });
  });

  return { clusters, assignment, unreadable };
}

interface Prototype {
  signature: Signature;
  /** Averaged glyphs laid out side by side for display. */
  flat: Uint8ClampedArray;
  sharpness: number;
  glyphCount: number;
}

/**
 * Average the member glyphs, then threshold.
 *
 * This is the step that makes the whole approach work: individually the glyphs
 * are too noisy to read, but their noise is independent while the digit is not,
 * so the mean is far sharper than any single member.
 */
function buildPrototype(signatures: Signature[], members: number[], glyphCount: number): Prototype {
  const accum: Float32Array[] = [];
  for (let k = 0; k < glyphCount; k++) accum.push(new Float32Array(GLYPH_SIZE * GLYPH_SIZE));
  let counted = 0;
  for (const si of members) {
    const sig = signatures[si];
    if (sig.masks.length !== glyphCount) continue;
    counted++;
    for (let k = 0; k < glyphCount; k++) {
      for (let i = 0; i < accum[k].length; i++) if (sig.masks[k][i]) accum[k][i] += 1;
    }
  }
  const denom = Math.max(1, counted);
  const masks: Uint8ClampedArray[] = [];
  let contrast = 0;
  for (let k = 0; k < glyphCount; k++) {
    const mask = new Uint8ClampedArray(GLYPH_SIZE * GLYPH_SIZE);
    for (let i = 0; i < mask.length; i++) {
      const mean = accum[k][i] / denom;
      // Pixels the majority of members agree are ink.
      mask[i] = mean >= 0.5 ? 255 : 0;
      // Distance from the undecided middle, averaged, measures how consistent
      // the members are — a blurry cluster sits near 0.5 everywhere.
      contrast += Math.abs(mean - 0.5) * 2;
    }
    masks.push(mask);
  }
  const flat = new Uint8ClampedArray(GLYPH_SIZE * GLYPH_SIZE * glyphCount);
  masks.forEach((m, k) => flat.set(m, k * GLYPH_SIZE * GLYPH_SIZE));
  return {
    signature: {
      markerIndex: -1,
      masks,
      transforms: masks.map(distanceTransform),
      inkCounts: masks.map((m) => m.reduce((s, v) => s + (v ? 1 : 0), 0)),
    },
    flat,
    sharpness: contrast / (GLYPH_SIZE * GLYPH_SIZE * glyphCount),
    glyphCount,
  };
}

/**
 * Turn a cluster prototype into a crop the existing classifier can read.
 *
 * The averaged glyph is rendered large and black-on-white — the input every OCR
 * engine wants, and the exact opposite of the 12-pixel original.
 */
export function prototypeAsCrop(cluster: GlyphCluster, template: MarkerCrop): MarkerCrop {
  const glyphs: Glyph[] = [];
  for (let k = 0; k < cluster.glyphCount; k++) {
    const mask = cluster.prototype.slice(k * GLYPH_SIZE * GLYPH_SIZE, (k + 1) * GLYPH_SIZE * GLYPH_SIZE);
    let minX = GLYPH_SIZE;
    let minY = GLYPH_SIZE;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < GLYPH_SIZE; y++) {
      for (let x = 0; x < GLYPH_SIZE; x++) {
        if (!mask[y * GLYPH_SIZE + x]) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) continue;
    glyphs.push({
      mask,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      fill: 0.4,
      holes: countHoles(mask),
    });
  }
  return { ...template, id: `prototype-${cluster.index}`, glyphs };
}

/** Enclosed counters in a 32x32 mask, via a flood fill from the border. */
function countHoles(mask: Uint8ClampedArray): number {
  const size = GLYPH_SIZE;
  const seen = new Uint8Array(size * size);
  const stack: number[] = [];
  for (let x = 0; x < size; x++) {
    stack.push(x, (size - 1) * size + x);
  }
  for (let y = 0; y < size; y++) {
    stack.push(y * size, y * size + size - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || mask[i]) continue;
    seen[i] = 1;
    const x = i % size;
    const y = (i / size) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < size - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - size);
    if (y < size - 1) stack.push(i + size);
  }
  let holes = 0;
  const visited = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || seen[i] || visited[i]) continue;
    holes++;
    const q = [i];
    while (q.length) {
      const j = q.pop()!;
      if (visited[j] || mask[j] || seen[j]) continue;
      visited[j] = 1;
      const x = j % size;
      const y = (j / size) | 0;
      if (x > 0) q.push(j - 1);
      if (x < size - 1) q.push(j + 1);
      if (y > 0) q.push(j - size);
      if (y < size - 1) q.push(j + size);
    }
  }
  return holes;
}
