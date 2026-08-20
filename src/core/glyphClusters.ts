/**
 * Group markers by the shape of their digit, without knowing what any digit is.
 *
 * An image holds a handful of distinct markers, not several hundred independent
 * puzzles. Reading each one on its own throws that away and spreads a reader's
 * error rate across every marker on the card; clustering first means a mistake
 * is made once per distinct digit rather than once per marker, and can be
 * corrected once too.
 *
 * The clusters come out unlabelled on purpose. Deciding which cluster is a `3`
 * from the pixels is the step that has no reliable answer at this print size,
 * and guessing it is how the old pipeline produced 409 markers labelled `7` on
 * a card with no `7` on it. The user names each averaged prototype instead —
 * one decision per distinct digit, on a picture that is sharp because it is the
 * mean of hundreds.
 */
import type { GlyphMask } from './glyphShape.ts';
import { averageGlyphs, glyphDistance } from './glyphShape.ts';

export interface GlyphCluster {
  /** Index into the cluster list; stable for the life of one analysis. */
  id: number;
  /** The averaged picture the user is shown and asked to name. */
  prototype: GlyphMask;
  /** Indices into the glyph array that was clustered. */
  members: number[];
  /** Mean distance of members from the prototype. Higher means less coherent. */
  spread: number;
}

export interface ClusterOptions {
  /**
   * How different two glyphs may be and still be the same digit.
   *
   * Measured rather than assumed: across the reference card, two instances of
   * the same digit stayed below 0.35 while two different digits never came
   * closer than 0.55, so the boundary sits in open space between them.
   */
  joinDistance?: number;
  /** Clusters smaller than this are dissolved and their members reassigned. */
  minMembers?: number;
}

export function clusterGlyphs(glyphs: GlyphMask[], opts: ClusterOptions = {}): GlyphCluster[] {
  const join = opts.joinDistance ?? 0.35;
  const minMembers = opts.minMembers ?? 3;
  if (glyphs.length === 0) return [];

  // Seed by a single pass: each glyph either joins the nearest prototype it is
  // close enough to, or starts a new one. Order matters slightly, which the
  // reassignment passes below wash out.
  let prototypes: GlyphMask[] = [];
  let assignment = new Int32Array(glyphs.length).fill(-1);

  for (let i = 0; i < glyphs.length; i++) {
    const { index, distance } = nearest(glyphs[i], prototypes);
    if (index >= 0 && distance < join) {
      assignment[i] = index;
    } else {
      prototypes.push(glyphs[i]);
      assignment[i] = prototypes.length - 1;
    }
  }

  // Re-average and re-assign. A prototype seeded from one noisy glyph pulls its
  // neighbourhood off-centre; once it is the mean of its members it sits where
  // the digit actually is, and glyphs that went to the wrong pile move back.
  for (let pass = 0; pass < 3; pass++) {
    prototypes = rebuildPrototypes(glyphs, assignment, prototypes.length);
    prototypes = mergeClose(prototypes, join * 0.8);
    assignment = assignAll(glyphs, prototypes);
  }

  let clusters = collect(glyphs, assignment, prototypes);

  // Dissolve the stragglers. A cluster of one or two is a damaged glyph or a
  // false detection, not a distinct digit, and showing it to the user as
  // something to name is noise.
  const survivors = clusters.filter((c) => c.members.length >= minMembers);
  if (survivors.length > 0 && survivors.length < clusters.length) {
    const protos = survivors.map((c) => c.prototype);
    assignment = assignAll(glyphs, protos);
    clusters = collect(glyphs, assignment, protos);
  }

  return clusters.sort((a, b) => b.members.length - a.members.length).map((c, i) => ({ ...c, id: i }));
}

function nearest(g: GlyphMask, protos: GlyphMask[]): { index: number; distance: number } {
  let index = -1;
  let best = Infinity;
  for (let p = 0; p < protos.length; p++) {
    const d = glyphDistance(g, protos[p]);
    if (d < best) {
      best = d;
      index = p;
    }
  }
  return { index, distance: best };
}

function rebuildPrototypes(glyphs: GlyphMask[], assignment: Int32Array, count: number): GlyphMask[] {
  const buckets: GlyphMask[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < glyphs.length; i++) {
    const a = assignment[i];
    if (a >= 0 && a < count) buckets[a].push(glyphs[i]);
  }
  return buckets.filter((b) => b.length > 0).map(averageGlyphs);
}

/**
 * Merge piles that are the same digit split in two.
 *
 * Prototypes are compared more strictly than raw glyphs were, because a mean is
 * not noisy: two averaged pictures of the same digit are very close indeed, so
 * a tighter bar here repairs over-splitting without risking a merge of two
 * genuinely different digits.
 */
function mergeClose(protos: GlyphMask[], limit: number): GlyphMask[] {
  const out: GlyphMask[] = [];
  const merged = new Array<boolean>(protos.length).fill(false);
  for (let i = 0; i < protos.length; i++) {
    if (merged[i]) continue;
    const group = [protos[i]];
    merged[i] = true;
    for (let j = i + 1; j < protos.length; j++) {
      if (merged[j]) continue;
      if (glyphDistance(protos[i], protos[j]) < limit) {
        group.push(protos[j]);
        merged[j] = true;
      }
    }
    out.push(group.length === 1 ? group[0] : averageGlyphs(group));
  }
  return out;
}

function assignAll(glyphs: GlyphMask[], protos: GlyphMask[]): Int32Array<ArrayBuffer> {
  const assignment = new Int32Array(glyphs.length);
  for (let i = 0; i < glyphs.length; i++) {
    assignment[i] = nearest(glyphs[i], protos).index;
  }
  return assignment;
}

function collect(glyphs: GlyphMask[], assignment: Int32Array, protos: GlyphMask[]): GlyphCluster[] {
  const members: number[][] = Array.from({ length: protos.length }, () => []);
  for (let i = 0; i < glyphs.length; i++) {
    const a = assignment[i];
    if (a >= 0) members[a].push(i);
  }
  const out: GlyphCluster[] = [];
  for (let p = 0; p < protos.length; p++) {
    if (members[p].length === 0) continue;
    const prototype = averageGlyphs(members[p].map((i) => glyphs[i]));
    const spread =
      members[p].reduce((s, i) => s + glyphDistance(glyphs[i], prototype), 0) / members[p].length;
    out.push({ id: out.length, prototype, members: members[p], spread });
  }
  return out;
}

/**
 * How confidently a glyph belongs to the cluster it was put in.
 *
 * The margin to the runner-up, not the distance to the winner. A glyph can sit
 * far from every prototype and still be unambiguous, while one sitting neatly
 * between two is the case a person needs to look at.
 */
export function membershipMargin(g: GlyphMask, protos: GlyphMask[]): number {
  if (protos.length < 2) return 1;
  let best = Infinity;
  let second = Infinity;
  for (const p of protos) {
    const d = glyphDistance(g, p);
    if (d < best) {
      second = best;
      best = d;
    } else if (d < second) {
      second = d;
    }
  }
  if (!Number.isFinite(second) || second === 0) return 1;
  return Math.max(0, Math.min(1, (second - best) / second));
}
