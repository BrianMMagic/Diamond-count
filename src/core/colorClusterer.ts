import { deltaE94, labToRgb } from './cv/color.ts';
import { median } from './cv/threshold.ts';
import type { ColorCluster, MarkerDetection } from './types.ts';

interface Sample {
  index: number;
  lab: [number, number, number];
}

/**
 * Deterministic k-means++ seeding.
 *
 * Deterministic matters here: rerunning the same photo must produce the same
 * counts, so the seed walks the samples in a fixed order rather than drawing
 * random numbers.
 */
function seed(samples: Sample[], k: number): Array<[number, number, number]> {
  const centroids: Array<[number, number, number]> = [samples[0].lab];
  while (centroids.length < k) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < samples.length; i++) {
      let d = Infinity;
      for (const c of centroids) d = Math.min(d, deltaE94(samples[i].lab, c));
      if (d > bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    centroids.push(samples[bestIdx].lab);
  }
  return centroids;
}

function kmeans(samples: Sample[], k: number, iterations = 24): { assign: Int32Array; centroids: Array<[number, number, number]> } {
  const centroids = seed(samples, k);
  const assign = new Int32Array(samples.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = deltaE94(samples[i].lab, centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    for (let c = 0; c < k; c++) {
      const members = samples.filter((_, i) => assign[i] === c);
      if (members.length === 0) continue;
      centroids[c] = [
        median(members.map((m) => m.lab[0])),
        median(members.map((m) => m.lab[1])),
        median(members.map((m) => m.lab[2])),
      ];
    }
    if (!moved) break;
  }
  return { assign, centroids };
}

/** Mean distance to own centroid vs. the nearest other centroid (silhouette). */
function silhouette(samples: Sample[], assign: Int32Array, centroids: Array<[number, number, number]>): number {
  if (centroids.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const own = deltaE94(samples[i].lab, centroids[assign[i]]);
    let other = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      if (c === assign[i]) continue;
      other = Math.min(other, deltaE94(samples[i].lab, centroids[c]));
    }
    total += (other - own) / Math.max(own, other, 1e-6);
  }
  return total / samples.length;
}

export interface ClusterResult {
  clusters: ColorCluster[];
  /** Cluster index per marker, aligned with the input array; -1 when unsampled. */
  assignment: Int32Array;
}

/**
 * Discover how many distinct ring colours the image actually uses.
 *
 * The spec is explicit that we must not assume ten colours: a kit may use four.
 * k is chosen by the best silhouette score across 1..10, so an image with four
 * ring colours produces four clusters and no phantom categories.
 */
export function clusterRingColors(markers: MarkerDetection[], maxK = 10): ClusterResult {
  const samples: Sample[] = [];
  markers.forEach((m, index) => {
    if (m.ringColor) samples.push({ index, lab: m.ringColor.lab });
  });
  const assignment = new Int32Array(markers.length).fill(-1);
  if (samples.length < 4) return { clusters: [], assignment };

  const upper = Math.min(maxK, Math.max(1, Math.floor(samples.length / 3)));
  let best: { k: number; score: number; assign: Int32Array; centroids: Array<[number, number, number]> } | null = null;
  for (let k = 1; k <= upper; k++) {
    const run = kmeans(samples, k);
    // A single cluster is only preferred when the colours really are uniform,
    // so give k=1 a fixed modest score to beat.
    const score = k === 1 ? 0.35 : silhouette(samples, run.assign, run.centroids);
    if (!best || score > best.score + 1e-6) best = { k, score, assign: run.assign, centroids: run.centroids };
  }
  if (!best) return { clusters: [], assignment };

  const clusters: ColorCluster[] = best.centroids.map((lab, index) => ({
    index,
    lab,
    rgb: labToRgb(lab),
    size: 0,
    spread: 0,
    assignedNumber: null,
    purity: 0,
  }));
  const perCluster: number[][] = clusters.map(() => []);
  samples.forEach((s, i) => {
    const c = best!.assign[i];
    assignment[s.index] = c;
    clusters[c].size++;
    perCluster[c].push(deltaE94(s.lab, clusters[c].lab));
  });
  clusters.forEach((c, i) => {
    c.spread = perCluster[i].length ? median(perCluster[i]) : 0;
  });
  return { clusters, assignment };
}

/**
 * Attach a number to each colour cluster using only OCR readings we trust.
 *
 * This is where a cluster of 120 identically-coloured markers with 118 confident
 * "2" readings lets the remaining two unreadable ones be counted correctly.
 */
export function assignClusterNumbers(
  markers: MarkerDetection[],
  result: ClusterResult,
  minConfidence = 0.75,
): void {
  const votes = result.clusters.map(() => new Map<number, number>());
  markers.forEach((m, i) => {
    const c = result.assignment[i];
    if (c < 0 || m.ocrPrediction == null) return;
    if ((m.ocrConfidence ?? 0) < minConfidence) return;
    const map = votes[c];
    map.set(m.ocrPrediction, (map.get(m.ocrPrediction) ?? 0) + 1);
  });
  result.clusters.forEach((cluster, i) => {
    const map = votes[i];
    let total = 0;
    let bestNum: number | null = null;
    let bestCount = 0;
    for (const [num, count] of map) {
      total += count;
      if (count > bestCount) {
        bestCount = count;
        bestNum = num;
      }
    }
    if (total >= 3 && bestNum !== null) {
      cluster.assignedNumber = bestNum;
      cluster.purity = bestCount / total;
    }
  });
}
