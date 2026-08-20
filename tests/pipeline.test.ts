import { describe, expect, it } from 'vitest';
import { synthesize } from './synth.ts';
import type { SynthOptions } from './synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import type { AnalysisResult } from '../src/core/types.ts';

const run = (image: Parameters<typeof runPipeline>[0]) =>
  runPipeline(image, { settings: { ...DEFAULT_SETTINGS, useTesseract: false } });

/**
 * How well the analysis matched the sheet it was given.
 *
 * Recall, purity and naming are reported apart because they fail independently
 * and only two of them are fatal.
 *
 * Purity is the one the design rests on. Every marker in a group takes the name
 * the user gives that group, so as long as each group holds a single digit, the
 * counts are one naming decision away from correct and a wrong name costs a
 * tap. A group holding two different digits cannot be fixed by any name at all,
 * and nothing on screen reveals it — which makes over-merging the failure worth
 * testing for, and over-splitting merely untidy.
 */
function score(result: AnalysisResult, placed: ReturnType<typeof synthesize>['markers']) {
  const groups = new Map<number, number[]>();
  let matched = 0;
  for (const m of result.markers) {
    let best: (typeof placed)[number] | null = null;
    let bestD = Infinity;
    for (const p of placed) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best || bestD > best.radius * 1.2) continue;
    matched++;
    const g = m.shapeGroup ?? -1;
    const bucket = groups.get(g);
    if (bucket) bucket.push(best.number);
    else groups.set(g, [best.number]);
  }

  let pure = 0;
  let named = 0;
  for (const [index, values] of groups) {
    const tally = new Map<number, number>();
    for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [majority, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    pure += n;
    if (result.stats.shapeGroups[index]?.number === majority) named += n;
  }
  return {
    recall: result.markers.length / placed.length,
    purity: matched > 0 ? pure / matched : 0,
    naming: matched > 0 ? named / matched : 0,
    matched,
  };
}

const cases: Array<{ name: string; opts: SynthOptions }> = [
  { name: 'a plain sheet', opts: { counts: { 1: 30, 2: 45, 3: 25, 4: 20 }, radius: 16, seed: 1 } },
  {
    name: 'markers printed almost touching',
    opts: { counts: { 1: 40, 2: 60, 3: 30, 4: 25 }, radius: 17, spacingFactor: 1.08, seed: 2 },
  },
  {
    name: 'a blurred, noisy photograph',
    opts: { counts: { 1: 30, 2: 50, 3: 30, 4: 20 }, radius: 16, blur: 1, noise: 8, seed: 3 },
  },
  {
    name: 'uneven lighting across the sheet',
    opts: { counts: { 1: 25, 2: 35, 3: 25, 4: 15 }, radius: 16, lightingGradient: 0.35, blur: 1, seed: 4 },
  },
  {
    name: 'markers jittered in place and in size',
    opts: {
      counts: { 1: 35, 2: 55, 3: 30, 4: 20 },
      radius: 20, jitter: 0.12, radiusJitter: 0.1, noise: 10, seed: 7,
    },
  },
  { name: 'a photograph taken close up', opts: { counts: { 1: 30, 2: 40, 3: 25, 4: 20 }, radius: 38, seed: 6 } },
  { name: 'a photograph taken very close up', opts: { counts: { 1: 30, 2: 40, 3: 25, 4: 20 }, radius: 64, seed: 9 } },
];

describe('the analysis, against sheets whose contents are known', () => {
  for (const c of cases) {
    it(`finds every marker and keeps one digit per group on ${c.name}`, async () => {
      const { image, markers } = synthesize(c.opts);
      const result = await run(image);
      const s = score(result, markers);
      expect(s.recall).toBeGreaterThanOrEqual(0.99);
      expect(s.recall).toBeLessThanOrEqual(1.01);
      expect(s.purity).toBeGreaterThanOrEqual(0.995);
    }, 120_000);
  }

  /**
   * The case the whole rewrite exists for.
   *
   * Ring and face colours are taken from a real kit. The metallic and pearl
   * beads are the hard ones, because their rim is nearly the same tone as their
   * own face — there is no ring edge to find. A detector that looks for the
   * ring loses them outright, and the first real card tested reported zero 3s
   * while being covered in gold beads.
   */
  it('counts a dense sheet of pearl, black, metallic and pink beads', async () => {
    const { image, markers, truth } = synthesize({
      counts: { 1: 220, 2: 420, 3: 210, 4: 115 },
      radius: 17,
      spacingFactor: 1.08,
      jitter: 0.06,
      noise: 4,
      seed: 2024,
      ringColors: { 1: [225, 224, 220], 2: [22, 22, 24], 3: [196, 150, 70], 4: [214, 120, 110] },
      faceColors: { 1: [238, 238, 236], 2: [245, 244, 240], 3: [205, 163, 84], 4: [248, 246, 244] },
      specular: 0.55,
    });
    const result = await run(image);
    const s = score(result, markers);
    expect(s.recall).toBeGreaterThanOrEqual(0.99);
    expect(s.purity).toBe(1);

    // Named automatically as well, so the counts stand up without correction.
    const summary = countMarkers(result.markers);
    expect([...summary.counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    for (const n of [1, 2, 3, 4]) {
      expect(summary.counts.get(n), `count of ${n}`).toBe(Number(truth.counts[String(n)]));
    }
  }, 180_000);

  it('never emits two markers for one physical marker', async () => {
    const { image, markers } = synthesize({
      counts: { 1: 30, 2: 45, 3: 25, 4: 20 }, radius: 17, spacingFactor: 1.08, seed: 88,
    });
    const result = await run(image);
    const claimed = new Set<number>();
    for (const m of result.markers) {
      let bestIndex = -1;
      let bestD = Infinity;
      markers.forEach((p, i) => {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < bestD) { bestD = d; bestIndex = i; }
      });
      expect(claimed.has(bestIndex), `two detections claimed marker ${bestIndex}`).toBe(false);
      claimed.add(bestIndex);
    }
  }, 120_000);

  it('does not need to be told which digits the sheet uses', async () => {
    // Inventing a digit the sheet does not contain used to be the loudest
    // failure mode: an unconstrained run labelled 409 markers `7` on a card
    // with no `7` on it.
    const { image, truth } = synthesize({ counts: { 1: 30, 2: 45, 3: 25, 4: 20 }, radius: 20, seed: 5 });
    const result = await run(image);
    const summary = countMarkers(result.markers);
    for (const n of summary.counts.keys()) {
      expect(Object.keys(truth.counts), `reported a ${n} that is not on the sheet`).toContain(String(n));
    }
  }, 120_000);

  it('leaves a group unnamed rather than guessing when it is not a digit', async () => {
    const { image } = synthesize({
      counts: { 2: 60, 4: 40 }, radius: 18, seed: 21, distractors: 60,
    });
    const result = await run(image);
    // Whatever the decoys become, nothing may be counted as a digit the sheet
    // does not use.
    const summary = countMarkers(result.markers);
    for (const n of summary.counts.keys()) {
      expect([2, 4], `reported a ${n}`).toContain(n);
    }
  }, 120_000);
});
