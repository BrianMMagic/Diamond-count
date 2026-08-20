/**
 * Run the pipeline over synthetic sheets whose contents are known exactly.
 *
 *   npm run synth
 *
 * Ground truth here is generated rather than observed, so it cannot be talked
 * into agreeing with the pipeline the way a hand-marked photograph can. That
 * makes it the only measurement in the project immune to the thing being
 * measured — which matters, because the previous test suite passed while the
 * app was badly broken: the sheets were rendered from the same digit shapes the
 * classifier matched against, so a mistake in those shapes agreed with itself.
 *
 * Three properties are reported separately, because they fail independently and
 * only one of them is fatal:
 *
 *   recall  — every marker found. Nothing downstream can recover a miss.
 *   purity  — each group holds exactly one true digit. This is the property the
 *             whole design rests on: if groups are pure, naming them correctly
 *             makes every count correct, so a wrong name costs one tap. If they
 *             are mixed, no amount of naming can produce a right answer.
 *   naming  — the automatic reading of each averaged prototype was right. This
 *             is a convenience, not a requirement; the user confirms the names.
 */
import { synthesize } from '../tests/synth.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import type { SynthOptions } from '../tests/synth.ts';

const REAL_BEADS: Partial<SynthOptions> = {
  ringColors: { 1: [225, 224, 220], 2: [22, 22, 24], 3: [196, 150, 70], 4: [214, 120, 110] },
  faceColors: { 1: [238, 238, 236], 2: [245, 244, 240], 3: [205, 163, 84], 4: [248, 246, 244] },
  specular: 0.55,
};

const cases: Array<{ name: string; opts: SynthOptions }> = [
  { name: 'plain', opts: { counts: { 1: 30, 2: 45, 3: 25, 4: 20 }, radius: 16, seed: 1 } },
  { name: 'tight spacing', opts: { counts: { 1: 40, 2: 60, 3: 30, 4: 25 }, radius: 17, spacingFactor: 1.08, seed: 2 } },
  { name: 'blur + noise', opts: { counts: { 1: 30, 2: 50, 3: 30, 4: 20 }, radius: 16, blur: 1, noise: 8, seed: 3 } },
  { name: 'lighting gradient', opts: { counts: { 1: 25, 2: 35, 3: 25, 4: 15 }, radius: 16, lightingGradient: 0.35, blur: 1, seed: 4 } },
  { name: 'tiny markers (r12)', opts: { counts: { 1: 30, 2: 40, 3: 25, 4: 20 }, radius: 12, seed: 5 } },
  { name: 'large markers (r38)', opts: { counts: { 1: 30, 2: 40, 3: 25, 4: 20 }, radius: 38, seed: 6 } },
  { name: 'very large (r64)', opts: { counts: { 1: 30, 2: 40, 3: 25, 4: 20 }, radius: 64, seed: 9 } },
  { name: 'jitter + noise', opts: { counts: { 1: 35, 2: 55, 3: 30, 4: 20 }, radius: 20, jitter: 0.12, radiusJitter: 0.1, noise: 10, seed: 7 } },
  {
    name: 'real beads (pearl/black/gold/pink)',
    opts: {
      counts: { 1: 220, 2: 420, 3: 210, 4: 115 },
      radius: 17, spacingFactor: 1.08, jitter: 0.06, noise: 4, seed: 2024, ...REAL_BEADS,
    },
  },
];

let failures = 0;
for (const c of cases) {
  const { image, truth, markers: placed } = synthesize(c.opts);
  const result = await runPipeline(image, { settings: { ...DEFAULT_SETTINGS, useTesseract: false } });

  const expectedTotal = Number(truth.total);
  const recall = result.markers.length / expectedTotal;

  // Match each detection to the nearest placed marker so a group's members can
  // be checked against what was actually printed there.
  const groups = new Map<number, number[]>();
  let matched = 0;
  for (const m of result.markers) {
    let best: (typeof placed)[number] | null = null;
    let bestD = Infinity;
    for (const p of placed) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best || bestD > best.radius * 1.2) continue;
    matched++;
    const g = m.shapeGroup ?? -1;
    const bucket = groups.get(g);
    if (bucket) bucket.push(best.number);
    else groups.set(g, [best.number]);
  }

  // Purity: the share of markers sitting in a group whose majority digit is
  // their own.
  let pure = 0;
  let namedRight = 0;
  for (const [gi, values] of groups) {
    const tally = new Map<number, number>();
    for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [majority, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    pure += n;
    if (result.stats.shapeGroups[gi]?.number === majority) namedRight += n;
  }
  const purity = matched > 0 ? pure / matched : 0;
  const naming = matched > 0 ? namedRight / matched : 0;

  const ok = recall >= 0.99 && recall <= 1.01 && purity >= 0.995;
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(34)} ` +
      `recall ${(recall * 100).toFixed(1)}%  purity ${(purity * 100).toFixed(1)}%  ` +
      `naming ${(naming * 100).toFixed(1)}%  groups ${result.stats.shapeGroups.length}/${Object.keys(truth.counts).length}`,
  );
}
console.log(
  failures === 0
    ? '\nall cases: every marker found, every group holds one digit'
    : `\n${failures} case(s) failed on recall or purity`,
);
