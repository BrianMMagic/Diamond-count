/** Dump the prototypes and readings for one synthetic case. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { synthesize } from '../tests/synth.ts';
import { toGray } from '../src/core/cv/color.ts';
import { detectGlyphs } from '../src/core/glyphDetector.ts';
import { extractGlyph, GLYPH_SIZE } from '../src/core/glyphShape.ts';
import type { GlyphMask } from '../src/core/glyphShape.ts';
import { clusterGlyphs } from '../src/core/glyphClusters.ts';
import { estimatePitch } from '../src/core/calibrate.ts';
import { readPrototype } from '../src/core/prototypeReader.ts';

const which = process.argv[2] ?? 'plain';
const opts: Record<string, Parameters<typeof synthesize>[0]> = {
  plain: { counts: { 1: 30, 2: 45, 3: 25, 4: 20 }, radius: 16, seed: 1 } as never,
  beads: {
    counts: { 1: 220, 2: 420, 3: 210, 4: 115 }, radius: 17, spacingFactor: 1.08, jitter: 0.06, noise: 4, seed: 2024,
    ringColors: { 1: [225, 224, 220], 2: [22, 22, 24], 3: [196, 150, 70], 4: [214, 120, 110] },
    faceColors: { 1: [238, 238, 236], 2: [245, 244, 240], 3: [205, 163, 84], 4: [248, 246, 244] },
    specular: 0.55,
  } as never,
};

const { image, truth } = synthesize(opts[which]);
const gray = toGray(image);
const pitch = estimatePitch(gray).pitch;
const detections = detectGlyphs(gray, { pitch });
const glyphs: GlyphMask[] = [];
for (const d of detections) {
  const g = extractGlyph(gray, d, pitch);
  if (g) glyphs.push(g);
}
const clusters = clusterGlyphs(glyphs);
console.log(`${which}: truth ${JSON.stringify(truth.counts)} total ${truth.total}`);
console.log(`  pitch ${pitch.toFixed(1)}  detections ${detections.length}  glyphs ${glyphs.length}  clusters ${clusters.length}`);
const heights = detections.map((d) => d.maxY - d.minY + 1).sort((a, b) => a - b);
console.log(`  glyph height min/med/max: ${heights[0]} / ${heights[heights.length >> 1]} / ${heights[heights.length - 1]}`);
for (const c of clusters) {
  const r = readPrototype(c.prototype, null);
  const top = r.ranked.slice(0, 3).map((s) => `${s.digit}:${s.similarity.toFixed(2)}`).join(' ');
  console.log(`    #${c.id} n=${String(c.members.length).padStart(4)} -> ${r.value} conf ${r.confidence.toFixed(2)} aspect ${c.prototype.aspect.toFixed(2)} [${top}]`);
}

const zoom = 5;
const cell = GLYPH_SIZE * zoom;
const gap = 8;
const w = clusters.length * (cell + gap) + gap;
const png = new PNG({ width: w, height: cell + gap * 2 });
png.data.fill(40);
clusters.forEach((c, i) => {
  const ox = gap + i * (cell + gap);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const v = c.prototype.data[Math.floor(y / zoom) * GLYPH_SIZE + Math.floor(x / zoom)];
      const shade = Math.round(255 * (1 - v));
      const di = ((gap + y) * w + ox + x) * 4;
      png.data[di] = shade; png.data[di + 1] = shade; png.data[di + 2] = shade; png.data[di + 3] = 255;
    }
  }
});
const outDir = join(root(), 'samples', 'output');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `synth-${which}-prototypes.png`);
writeFileSync(out, PNG.sync.write(png));
console.log(`  ${out}`);
function root() { return join(dirname(fileURLToPath(import.meta.url)), '..'); }
