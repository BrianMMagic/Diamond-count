/**
 * Report what the image itself says about marker spacing.
 *
 *   npm run measure -- IMG_5199.jpg
 *
 * Used to sanity-check the calibration guess against a photograph before the
 * UI exists to click on. Prints the autocorrelation estimate alongside the
 * detector's own estimate so the two can be compared directly.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { RgbaImage } from '../src/core/cv/image.ts';
import { toGray } from '../src/core/cv/color.ts';
import { estimatePitch } from '../src/core/calibrate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'IMG_5199.jpg';
const buffer = readFileSync(join(root, 'samples', name));
const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
const image: RgbaImage = {
  width: raw.width,
  height: raw.height,
  data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length),
};

const gray = toGray(image);
const t0 = performance.now();
const est = estimatePitch(gray);
const ms = Math.round(performance.now() - t0);

console.log(`${name}  ${image.width}x${image.height}`);
console.log(`  autocorrelation pitch : ${est.pitch.toFixed(1)}px  (strength ${est.strength.toFixed(2)}, ${ms}ms)`);
console.log(`  implied radius        : ${(est.pitch * 0.46).toFixed(1)}px`);
console.log(`  implied diameter      : ${(est.pitch * 0.92).toFixed(1)}px`);
