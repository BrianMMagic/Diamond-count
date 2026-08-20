/**
 * Run the glyph detector over a sample and draw what it found.
 *
 *   npm run detect -- IMG_5199.jpg --pitch=78
 *   npm run detect -- IMG_5199.jpg --pitch=78 --crop=1500,1900,700,700 --zoom=2
 *
 * Recall is the number that matters and it cannot be read off a total, so this
 * writes an overlay: a missing marker is obvious as a bare digit, and a false
 * positive is obvious as a ring around fur. The `--crop` form renders a region
 * large enough to audit by eye.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaImage } from '../src/core/cv/image.ts';
import { toGray } from '../src/core/cv/color.ts';
import { detectGlyphs } from '../src/core/glyphDetector.ts';
import type { GlyphDetection } from '../src/core/glyphDetector.ts';
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
const k = Number(flag('k') ?? 0.28);

const t0 = performance.now();
const found = detectGlyphs(gray, { pitch, k });
const ms = Math.round(performance.now() - t0);

console.log(`${name}  ${image.width}x${image.height}  pitch ${pitch.toFixed(1)}px  k ${k}`);
console.log(`  detections: ${found.length}  (${ms}ms)`);
const scores = found.map((f) => f.score).sort((a, b) => a - b);
if (scores.length) {
  const at = (p: number) => scores[Math.floor(p * (scores.length - 1))].toFixed(0);
  console.log(`  score p10/p50/p90: ${at(0.1)} / ${at(0.5)} / ${at(0.9)}`);
}

const cropArg = flag('crop');
const zoom = Number(flag('zoom') ?? 1);
const region = cropArg
  ? (cropArg.split(',').map(Number) as [number, number, number, number])
  : ([0, 0, image.width, image.height] as [number, number, number, number]);

writeOverlay(region, zoom, found);

function writeOverlay(
  [rx, ry, rw, rh]: [number, number, number, number],
  scale: number,
  items: GlyphDetection[],
): void {
  const ow = Math.round(rw * scale);
  const oh = Math.round(rh * scale);
  const png = new PNG({ width: ow, height: oh });
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(image.width - 1, rx + Math.floor(x / scale));
      const sy = Math.min(image.height - 1, ry + Math.floor(y / scale));
      const si = (sy * image.width + sx) * 4;
      const di = (y * ow + x) * 4;
      png.data[di] = image.data[si];
      png.data[di + 1] = image.data[si + 1];
      png.data[di + 2] = image.data[si + 2];
      png.data[di + 3] = 255;
    }
  }

  const ring = Math.max(2, (pitch * 0.42 * scale) | 0);
  for (const d of items) {
    const cx = (d.x - rx) * scale;
    const cy = (d.y - ry) * scale;
    if (cx < -ring || cy < -ring || cx > ow + ring || cy > oh + ring) continue;
    drawCircle(png, ow, oh, cx, cy, ring, [0, 255, 60]);
    drawCircle(png, ow, oh, cx, cy, 2, [255, 0, 0]);
  }

  const outDir = join(root, 'samples', 'output');
  mkdirSync(outDir, { recursive: true });
  const tag = cropArg ? `-${rx}-${ry}` : '';
  const out = join(outDir, `${basename(name, extname(name))}${tag}-detect.png`);
  writeFileSync(out, PNG.sync.write(png));
  console.log(`  overlay: ${out} (${ow}x${oh})`);
}

function drawCircle(
  png: PNG,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  [cr, cg, cb]: [number, number, number],
): void {
  const steps = Math.max(12, Math.round(r * 8));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    for (const rr of [r, r - 1]) {
      const x = Math.round(cx + Math.cos(a) * rr);
      const y = Math.round(cy + Math.sin(a) * rr);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const di = (y * w + x) * 4;
      png.data[di] = cr;
      png.data[di + 1] = cg;
      png.data[di + 2] = cb;
    }
  }
}
