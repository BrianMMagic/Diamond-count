/**
 * Detect, extract glyphs, cluster them, and draw the averaged prototypes.
 *
 *   npm run cluster -- IMG_5199.jpg --pitch=78
 *
 * The prototypes are what the user is asked to name, so they are the thing to
 * look at: if the averaged pictures are sharp and there is one per digit, the
 * naming step is trivial and every marker in the pile is settled by it.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaImage } from '../src/core/cv/image.ts';
import { toGray } from '../src/core/cv/color.ts';
import { detectGlyphs } from '../src/core/glyphDetector.ts';
import { extractGlyph, GLYPH_SIZE } from '../src/core/glyphShape.ts';
import type { GlyphMask } from '../src/core/glyphShape.ts';
import { clusterGlyphs } from '../src/core/glyphClusters.ts';
import { estimatePitch } from '../src/core/calibrate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'IMG_5199.jpg';
const flag = (key: string) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);

const buffer = readFileSync(join(root, 'samples', name));
const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
const image: RgbaImage = {
  width: raw.width,
  height: raw.height,
  data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length),
};

const gray = toGray(image);
const pitch = Number(flag('pitch') ?? 0) || estimatePitch(gray).pitch;
const join_ = Number(flag('join') ?? 0.35);

const detections = detectGlyphs(gray, { pitch });
const glyphs: GlyphMask[] = [];
const kept: number[] = [];
detections.forEach((d, i) => {
  const g = extractGlyph(gray, d, pitch);
  if (g) {
    glyphs.push(g);
    kept.push(i);
  }
});

const clusters = clusterGlyphs(glyphs, { joinDistance: join_ });

console.log(`${name}  pitch ${pitch.toFixed(1)}px  join ${join_}`);
console.log(`  detections ${detections.length}, glyphs extracted ${glyphs.length}`);
console.log(`  clusters ${clusters.length}`);
for (const c of clusters) {
  console.log(
    `    #${c.id}  members ${String(c.members.length).padStart(4)}  spread ${c.spread.toFixed(3)}  ` +
      `aspect ${c.prototype.aspect.toFixed(2)}`,
  );
}

// One row of prototypes, scaled up enough to read.
const zoom = 5;
const cell = GLYPH_SIZE * zoom;
const gap = 8;
const sheetW = clusters.length * (cell + gap) + gap;
const sheetH = cell + gap * 2;
const png = new PNG({ width: sheetW, height: sheetH });
png.data.fill(40);
clusters.forEach((c, idx) => {
  const ox = gap + idx * (cell + gap);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const v = c.prototype.data[Math.floor(y / zoom) * GLYPH_SIZE + Math.floor(x / zoom)];
      const shade = Math.round(255 * (1 - v));
      const di = ((gap + y) * sheetW + ox + x) * 4;
      png.data[di] = shade;
      png.data[di + 1] = shade;
      png.data[di + 2] = shade;
      png.data[di + 3] = 255;
    }
  }
});

const outDir = join(root, 'samples', 'output');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${basename(name, extname(name))}-prototypes.png`);
writeFileSync(out, PNG.sync.write(png));
console.log(`  prototypes: ${out} (${sheetW}x${sheetH})`);
