/**
 * Run every image in `samples/` through the real pipeline and, where a
 * ground-truth file exists, report exactly how far off the counts are.
 *
 * This is the loop that makes accuracy work improvable rather than anecdotal:
 * change the detector, run `npm run samples`, and see whether the numbers moved
 * in the right direction across the whole sample set.
 *
 *   npm run samples                  # every image in samples/
 *   npm run samples -- one.jpg       # a single image
 *   npm run samples -- --overlay     # also write *-overlay.png next to it
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaImage } from '../src/core/cv/image.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { TemplateClassifier } from '../src/core/classifier/templateClassifier.ts';
import { countMarkers } from '../src/core/resultCounter.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import type { MarkerDetection } from '../src/core/types.ts';
import { evaluate, formatEvaluation } from '../src/testing/groundTruth.ts';
import type { GroundTruth } from '../src/testing/groundTruth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = join(root, 'samples');
const truthDir = join(samplesDir, 'ground-truth');
const outDir = join(samplesDir, 'output');

const args = process.argv.slice(2);
const writeOverlay = args.includes('--overlay');
const only = args.filter((a) => !a.startsWith('--'));

/** Decode JPEG/PNG and apply the EXIF rotation the browser would apply for us. */
function decode(path: string): RgbaImage {
  const buffer = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  const image: RgbaImage = {
    width: raw.width,
    height: raw.height,
    data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length),
  };
  return applyOrientation(image, readExifOrientation(buffer));
}

/** Minimal EXIF reader: only the orientation tag (0x0112) is needed. */
function readExifOrientation(buffer: Buffer): number {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const size = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && buffer.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      const tiff = offset + 10;
      const little = buffer.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
      const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8);
      }
      return 1;
    }
    if (marker === 0xda) break;
    offset += 2 + size;
  }
  return 1;
}

function applyOrientation(img: RgbaImage, orientation: number): RgbaImage {
  if (orientation <= 1 || orientation > 8) return img;
  const swap = orientation >= 5;
  const w = swap ? img.height : img.width;
  const h = swap ? img.width : img.height;
  const out: RgbaImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let nx = x;
      let ny = y;
      switch (orientation) {
        case 2: nx = img.width - 1 - x; break;
        case 3: nx = img.width - 1 - x; ny = img.height - 1 - y; break;
        case 4: ny = img.height - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = img.height - 1 - y; ny = x; break;
        case 7: nx = img.height - 1 - y; ny = img.width - 1 - x; break;
        case 8: nx = y; ny = img.width - 1 - x; break;
      }
      const si = (y * img.width + x) * 4;
      const di = (ny * w + nx) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return out;
}

/** Draw the detections onto a copy of the image and save it as a PNG. */
function saveOverlay(path: string, img: RgbaImage, markers: MarkerDetection[]): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.data);
  const put = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  };
  for (const m of markers) {
    const rgb: [number, number, number] =
      m.finalConfidence === 'high' ? [34, 197, 94] : m.finalConfidence === 'medium' ? [14, 165, 233] : [245, 158, 11];
    const r = m.radius * 1.12;
    const steps = Math.max(24, Math.round(r * 8));
    for (let s = 0; s < steps; s++) {
      const th = (s / steps) * Math.PI * 2;
      for (const d of [-1, 0, 1]) {
        put(Math.round(m.x + Math.cos(th) * (r + d)), Math.round(m.y + Math.sin(th) * (r + d)), rgb);
      }
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

function loadTruth(name: string): GroundTruth | null {
  const path = join(truthDir, `${basename(name, extname(name))}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as GroundTruth;
}

async function main(): Promise<void> {
  if (!existsSync(samplesDir)) {
    console.error(`No samples directory at ${samplesDir}`);
    process.exit(1);
  }
  const files = readdirSync(samplesDir)
    .filter((f) => ['.jpg', '.jpeg', '.png'].includes(extname(f).toLowerCase()))
    .filter((f) => only.length === 0 || only.includes(f));

  if (files.length === 0) {
    console.log('No sample images found. Drop .jpg or .png files into samples/ and run again.');
    return;
  }
  if (writeOverlay) mkdirSync(outDir, { recursive: true });

  for (const file of files) {
    const path = join(samplesDir, file);
    const started = Date.now();
    const image = decode(path);
    const result = await runPipeline(image, {
      // Tesseract needs a browser; the harness exercises the built-in reader,
      // which is also the fallback the app uses when Tesseract cannot load.
      settings: { ...DEFAULT_SETTINGS, useTesseract: false },
      classifierFactory: async () => ({ classifier: new TemplateClassifier(), engine: 'template' }),
    });
    const summary = countMarkers(result.markers);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\n=== ${file} (${image.width}x${image.height}, ${elapsed}s) ===`);
    console.log(
      `  markers ${summary.total} · high ${summary.highConfidence} · medium ${summary.mediumConfidence} ` +
        `· review ${summary.needsReview} · possible missed ${result.possibleMissed.length}`,
    );
    console.log(
      `  detector: ${result.stats.candidatesProposed} proposed, ${result.stats.duplicatesMerged} merged, ` +
        `marker diameter ~${Math.round(result.stats.estimatedRadius * 2)}px`,
    );
    console.log(
      `  counts: ${[...summary.counts.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}: ${c}`).join(', ') || '—'}`,
    );

    const truth = loadTruth(file);
    if (truth) console.log(formatEvaluation(evaluate(truth, summary)));
    else console.log(`  (no ground truth — add samples/ground-truth/${basename(file, extname(file))}.json)`);

    if (writeOverlay) {
      const out = join(outDir, `${basename(file, extname(file))}-overlay.png`);
      saveOverlay(out, image, result.markers);
      console.log(`  overlay written to ${out}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
