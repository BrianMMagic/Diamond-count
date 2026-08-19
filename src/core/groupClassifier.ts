import { deltaE94 } from './cv/color.ts';
import { median } from './cv/threshold.ts';
import type { ClusterResult } from './colorClusterer.ts';
import type { MarkerDetection } from './types.ts';

export interface MarkerGroup {
  /** Index into the colour-cluster list. */
  index: number;
  number: number | null;
  count: number;
  rgb: [number, number, number];
  /** 0..1 agreement among the sampled readings. */
  purity: number;
  /** How many members were actually read. */
  sampled: number;
  votes: Array<{ value: number; weight: number }>;
  /** Marker ids whose crops were read, for the "is this a 3?" preview. */
  sampleIds: string[];
  /** True when the group's readings disagreed too much to label it. */
  ambiguous: boolean;
  source: 'vote' | 'manual' | 'unresolved';
}

export interface GroupOptions {
  /** How many members of each group to actually read. */
  samplesPerGroup: number;
  /**
   * Reject the group's label when the runner-up gets more than this share of
   * the winner's support.
   *
   * Purity alone cannot tell "one value plus scattered misreadings" from "two
   * values evenly mixed" — both can sit at the same number. Misreadings scatter
   * across many digits, so they never build a strong SECOND place; a group that
   * really holds two numbers does. That ratio is the honest discriminator.
   */
  maxRunnerUpRatio: number;
  /** Minimum agreeing readings before a group may be labelled at all. */
  minVotes: number;
}

export const DEFAULT_GROUP: GroupOptions = {
  samplesPerGroup: 20,
  maxRunnerUpRatio: 0.35,
  minVotes: 3,
};

/**
 * Pick the clearest members of each colour group to spend OCR on.
 *
 * The digits on these cards are 10-15 pixels tall, which is below the height any
 * OCR engine reads reliably — so reading all several hundred of them just
 * accumulates errors. But an image only contains a handful of DISTINCT markers,
 * so the useful question is not "what is this marker?" several hundred times, it
 * is "what is this group?" a handful of times, answered from the members that
 * happen to have photographed cleanly.
 */
export function selectRepresentatives(
  markers: MarkerDetection[],
  clusters: ClusterResult,
  opts: GroupOptions = DEFAULT_GROUP,
): number[] {
  const byCluster = new Map<number, number[]>();
  markers.forEach((_, i) => {
    const c = clusters.assignment[i];
    if (c < 0) return;
    const bucket = byCluster.get(c);
    if (bucket) bucket.push(i);
    else byCluster.set(c, [i]);
  });

  const chosen: number[] = [];
  for (const [clusterIndex, members] of byCluster) {
    const centroid = clusters.clusters[clusterIndex]?.lab;
    const scored = members.map((i) => ({ i, quality: crispness(markers[i], centroid) }));
    scored.sort((a, b) => b.quality - a.quality);

    // Half the sample is the crispest members, because those are the ones whose
    // digits are actually readable. The other half is spread evenly across the
    // group, because "crispest" is not a neutral filter: if it happens to
    // correlate with one digit's shape, a biased sample can vote unanimously
    // for the wrong answer. The spread half is what makes a group holding two
    // numbers look like one.
    const half = Math.max(1, Math.floor(opts.samplesPerGroup / 2));
    const picked = new Set<number>();
    for (const s of scored.slice(0, half)) picked.add(s.i);
    const stride = Math.max(1, Math.floor(members.length / half));
    for (let k = 0; k < members.length && picked.size < opts.samplesPerGroup; k += stride) {
      picked.add(members[k]);
    }
    for (const i of picked) chosen.push(i);
  }
  // Markers that belong to no group still need reading on their own.
  markers.forEach((_, i) => {
    if (clusters.assignment[i] < 0) chosen.push(i);
  });
  return chosen;
}

/**
 * How likely this marker is to photograph a readable digit: a well-formed ring,
 * a clean colour sample, and a colour close to its group's centre.
 */
function crispness(marker: MarkerDetection, centroid: [number, number, number] | undefined): number {
  const ring = marker.profile?.ringClosure ?? 0.5;
  const contrast = marker.profile
    ? Math.min(1, (marker.profile.centerBright - marker.profile.centerDark) / 90)
    : 0.5;
  const noise = marker.ringColor ? Math.max(0, 1 - marker.ringColor.spread / 30) : 0.5;
  const fit =
    centroid && marker.ringColor ? Math.max(0, 1 - deltaE94(marker.ringColor.lab, centroid) / 25) : 0.5;
  return 0.3 * marker.detectionScore + 0.25 * contrast + 0.2 * ring + 0.15 * noise + 0.1 * fit;
}

/**
 * Turn the sampled readings into one label per group.
 *
 * A group is only labelled when its samples actually agree. If two numbers share
 * a ring colour — which some kits do — the vote splits, the group is marked
 * ambiguous, and its members fall back to being read individually. That guard is
 * what keeps this from being a worse answer on kits where colour is not a clean
 * separator.
 */
export function assignGroupNumbers(
  markers: MarkerDetection[],
  clusters: ClusterResult,
  sampled: Set<string>,
  opts: GroupOptions = DEFAULT_GROUP,
): MarkerGroup[] {
  const groups: MarkerGroup[] = clusters.clusters.map((c) => ({
    index: c.index,
    number: null,
    count: 0,
    rgb: c.rgb,
    purity: 0,
    sampled: 0,
    votes: [],
    sampleIds: [],
    ambiguous: false,
    source: 'unresolved',
  }));

  const tally = groups.map(() => new Map<number, number>());
  markers.forEach((m, i) => {
    const c = clusters.assignment[i];
    if (c < 0 || !groups[c]) return;
    groups[c].count++;
    if (!sampled.has(m.id)) return;
    groups[c].sampled++;
    groups[c].sampleIds.push(m.id);
    if (m.ocrPrediction == null) return;
    const weight = Math.max(0.15, m.ocrConfidence ?? 0);
    tally[c].set(m.ocrPrediction, (tally[c].get(m.ocrPrediction) ?? 0) + weight);
  });

  groups.forEach((group, c) => {
    const votes = [...tally[c].entries()]
      .map(([value, weight]) => ({ value, weight }))
      .sort((a, b) => b.weight - a.weight);
    group.votes = votes;
    if (votes.length === 0) {
      group.ambiguous = true;
      return;
    }
    const total = votes.reduce((s, v) => s + v.weight, 0);
    const purity = votes[0].weight / total;
    const runnerUpRatio = votes.length > 1 ? votes[1].weight / votes[0].weight : 0;
    const agreeing = markers.filter(
      (marker, i) =>
        clusters.assignment[i] === c && sampled.has(marker.id) && marker.ocrPrediction === votes[0].value,
    ).length;
    group.purity = purity;
    if (runnerUpRatio <= opts.maxRunnerUpRatio && agreeing >= opts.minVotes) {
      group.number = votes[0].value;
      group.source = 'vote';
    } else {
      group.ambiguous = true;
    }
  });

  return groups;
}

export interface ApplyResult {
  assigned: number;
  outliers: number;
  /** Markers in ambiguous groups, which still need individual readings. */
  needIndividualReading: number[];
}

/**
 * Give every marker its group's number.
 *
 * A marker whose colour sits far outside its own group is not counted silently —
 * it is sent to review, because that is exactly what a marker photographed under
 * glare, or one the detector mis-centred, looks like.
 */
export function applyGroups(
  markers: MarkerDetection[],
  clusters: ClusterResult,
  groups: MarkerGroup[],
): ApplyResult {
  let assigned = 0;
  let outliers = 0;
  const needIndividualReading: number[] = [];

  // Outlier bar per group: generous, but scaled to how tight the group is.
  const tolerance = groups.map((g) => {
    const cluster = clusters.clusters[g.index];
    return Math.max(6, (cluster?.spread ?? 4) * 3);
  });

  markers.forEach((marker, i) => {
    if (marker.manualNumber != null || marker.rejected) return;
    const c = clusters.assignment[i];
    const group = c >= 0 ? groups[c] : undefined;
    if (!group || group.number === null) {
      if (c >= 0) needIndividualReading.push(i);
      return;
    }

    const centroid = clusters.clusters[group.index]?.lab;
    const distance = centroid && marker.ringColor ? deltaE94(marker.ringColor.lab, centroid) : 0;
    marker.colorPrediction = group.number;
    marker.colorDistance = distance;

    if (distance > tolerance[c]) {
      outliers++;
      marker.finalNumber = marker.ocrPrediction ?? group.number;
      marker.classificationMethod = marker.ocrPrediction != null ? 'ocr' : 'color';
      marker.finalConfidence = 'review';
      marker.finalScore = 0.4;
      marker.needsReview = true;
      marker.reason =
        `Its colour sits well outside the "${group.number}" group (ΔE ${distance.toFixed(1)}), ` +
        `so it was not counted on the group's word.`;
      return;
    }

    assigned++;
    const agreed = marker.ocrPrediction === group.number;
    marker.finalNumber = group.number;
    marker.colorConfidence = Math.max(0, Math.min(1, 1 - distance / tolerance[c]));
    marker.classificationMethod = agreed ? 'ocr+color' : 'color';
    marker.needsReview = false;
    // A big, unanimous group is strong evidence; a small or split one is not.
    const groupStrength = Math.min(1, group.count / 25) * group.purity;
    marker.finalScore = Math.max(0.55, Math.min(1, 0.55 + 0.45 * groupStrength));
    marker.finalConfidence = groupStrength >= 0.55 ? 'high' : 'medium';
    marker.reason = agreed
      ? `Read as ${group.number}, matching its colour group of ${group.count} markers.`
      : `Counted as ${group.number} from its colour group — ${group.sampled} sampled markers in this ` +
        `group read as ${group.number} (${Math.round(group.purity * 100)}% agreement).`;
  });

  return { assigned, outliers, needIndividualReading };
}

/** Relabel a whole group — one tap in the UI fixes every marker in it. */
export function relabelGroup(
  markers: MarkerDetection[],
  clusters: ClusterResult,
  groupIndex: number,
  value: number | null,
): number {
  let changed = 0;
  markers.forEach((marker, i) => {
    if (clusters.assignment[i] !== groupIndex) return;
    if (marker.manualNumber != null || marker.rejected) return;
    marker.finalNumber = value;
    marker.manualNumber = value;
    marker.classificationMethod = 'manual';
    marker.finalConfidence = value == null ? 'review' : 'high';
    marker.finalScore = value == null ? 0 : 1;
    marker.needsReview = value == null;
    marker.reason = 'Set by you for this whole colour group.';
    changed++;
  });
  return changed;
}

/** Median colour spread across groups; reported in the debug panel. */
export function groupSeparation(clusters: ClusterResult): number {
  const labs = clusters.clusters.map((c) => c.lab);
  if (labs.length < 2) return Infinity;
  const distances: number[] = [];
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) distances.push(deltaE94(labs[i], labs[j]));
  }
  return median(distances);
}
