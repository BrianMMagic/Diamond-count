/**
 * Cut a region out of a sample photograph and write it as a PNG.
 *
 *   npm run crop -- IMG_5199.jpg 1200 1500 500 400 [scale]
 *
 * Exists so regions can be inspected and hand-counted at a readable size while
 * building ground truth. Coordinates are in original-image pixels.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [name, xs, ys, ws, hs, ss] = process.argv.slice(2);
const x0 = Number(xs);
const y0 = Number(ys);
const w = Number(ws);
const h = Number(hs);
const scale = ss ? Number(ss) : 1;

const buffer = readFileSync(join(root, 'samples', name));
const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
const src = new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length);

const ow = Math.round(w * scale);
const oh = Math.round(h * scale);
const png = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) {
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(raw.width - 1, x0 + Math.floor(x / scale));
    const sy = Math.min(raw.height - 1, y0 + Math.floor(y / scale));
    const si = (sy * raw.width + sx) * 4;
    const di = (y * ow + x) * 4;
    png.data[di] = src[si];
    png.data[di + 1] = src[si + 1];
    png.data[di + 2] = src[si + 2];
    png.data[di + 3] = 255;
  }
}

const outDir = join(root, 'samples', 'output');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `crop-${x0}-${y0}-${w}x${h}.png`);
writeFileSync(out, PNG.sync.write(png));
console.log(`${out}  (${ow}x${oh}, source ${raw.width}x${raw.height})`);
