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

  describe('when the user marks one example of each number', () => {
    const beadSheet = () =>
      synthesize({
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

    /** One marker of each digit, as if the user had tapped them. */
    const examples = (placed: ReturnType<typeof synthesize>['markers']) =>
      [...new Set(placed.map((m) => m.number))].map((digit) => {
        const m = placed.find((p) => p.number === digit)!;
        return { digit, x: m.x, y: m.y };
      });

    it('counts every number exactly', async () => {
      const { image, markers, truth } = beadSheet();
      const result = await runPipeline(image, {
        settings: { ...DEFAULT_SETTINGS, useTesseract: false },
        exemplars: examples(markers),
      });
      const summary = countMarkers(result.markers);
      for (const n of [1, 2, 3, 4]) {
        expect(summary.counts.get(n), `count of ${n}`).toBe(Number(truth.counts[String(n)]));
      }
    }, 180_000);

    it('cannot produce a number nobody pointed at', async () => {
      // The examples deliberately omit 3. Nothing may come back as a 3, however
      // much some marker's glyph happens to look like one.
      const { image, markers } = beadSheet();
      const result = await runPipeline(image, {
        settings: { ...DEFAULT_SETTINGS, useTesseract: false },
        exemplars: examples(markers).filter((e) => e.digit !== 3),
      });
      const summary = countMarkers(result.markers);
      expect([...summary.counts.keys()].sort((a, b) => a - b)).toEqual([1, 2, 4]);
    }, 180_000);

    it('does not get less certain when given more examples of the same number', async () => {
      // The margin behind a marker's confidence has to compare NUMBERS, not
      // examples. Comparing examples, a second `4` becomes the runner-up to a
      // `4`, the margin collapses on markers that are in fact certain, and
      // marking more examples — the thing a user does when they want a better
      // answer — made the review queue grow from 12 to 70 on the reference card.
      const { image, markers, truth } = beadSheet();
      const one = examples(markers);
      const extra = one.flatMap(({ digit }) => {
        const of = markers.filter((m) => m.number === digit);
        return [of[Math.floor(of.length / 2)], of[of.length - 1]]
          .filter(Boolean)
          .map((m) => ({ digit, x: m.x, y: m.y }));
      });

      const run1 = await runPipeline(image, {
        settings: { ...DEFAULT_SETTINGS, useTesseract: false },
        exemplars: one,
      });
      const run3 = await runPipeline(image, {
        settings: { ...DEFAULT_SETTINGS, useTesseract: false },
        exemplars: [...one, ...extra],
      });

      const a = countMarkers(run1.markers);
      const b = countMarkers(run3.markers);
      expect(b.needsReview).toBeLessThanOrEqual(a.needsReview + 2);
      // And the answer itself must not drift.
      for (const n of [1, 2, 3, 4]) {
        expect(b.counts.get(n), `count of ${n}`).toBe(Number(truth.counts[String(n)]));
      }
    }, 180_000);

    it('reports how many of a group actually carry its number', async () => {
      const { image, markers } = beadSheet();
      const result = await runPipeline(image, {
        settings: { ...DEFAULT_SETTINGS, useTesseract: false },
        exemplars: examples(markers),
      });
      for (const g of result.stats.shapeGroups) {
        expect(g.assignedCount, `group ${g.index}`).toBeDefined();
        expect(g.assignedCount!).toBeLessThanOrEqual(g.count);
        const actual = result.markers.filter(
          (m) => m.shapeGroup === g.index && m.finalNumber === g.number,
        ).length;
        expect(g.assignedCount).toBe(actual);
      }
    }, 180_000);
  });

  /**
   * The case that broke on a second real card.
   *
   * Every size bound is expressed against marker *spacing*, not against the
   * marker, so how much of the spacing a digit occupies depends on how tightly
   * the card is laid out. Beads sitting apart with a modest digit gave 0.44;
   * beads touching with a digit filling the face gave 0.8. A cap at 0.5 fitted
   * the first card and rejected every real digit on the second — leaving only
   * fur between the beads, 82 detections where there were over six hundred
   * markers, and the app confidently counting the gaps.
   */
  it('finds markers whose digit nearly fills the space between them', async () => {
    const { image, markers, truth } = synthesize({
      counts: { 4: 60, 8: 120 },
      radius: 22,
      spacingFactor: 1.0,
      glyphScale: 1.7,
      seed: 5,
    });
    const result = await run(image);
    const s = score(result, markers);
    expect(s.recall).toBeGreaterThanOrEqual(0.99);
    expect(s.purity).toBeGreaterThanOrEqual(0.995);
    expect(result.markers.length).toBe(Number(truth.total));
  }, 120_000);

  /**
   * Marker spacing has to survive markers that are not on a grid.
   *
   * Spacing is read off the image's own periodicity, which is accurate to well
   * under a percent when the markers are laid out in rows and gives no answer at
   * all when they are not. A real card whose beads follow the contours of the
   * picture in curved lines has no lattice to find, so the estimate returned
   * nothing, the pipeline had no size to work with, and it reported zero markers
   * on a card covered in them. Scattering the markers here reproduces that:
   * periodicity lands on 16.7 against a true 46.8, which is not a slightly worse
   * answer but a useless one.
   */
  it('works out the spacing when the markers are not on a grid', async () => {
    const { image, markers } = synthesize({
      counts: { 3: 90, 7: 60 }, radius: 18, spacingFactor: 1.3, jitter: 0.6, seed: 12,
    });
    const result = await run(image);
    const s = score(result, markers);
    expect(s.recall).toBeGreaterThanOrEqual(0.95);
    expect(s.purity).toBeGreaterThanOrEqual(0.99);
  }, 120_000);

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
