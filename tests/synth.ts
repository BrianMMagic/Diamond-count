import { createRgba } from '../src/core/cv/image.ts';
import type { RgbaImage } from '../src/core/cv/image.ts';
import { DIGIT_SHAPES, rasterizeDigit } from '../src/core/classifier/digitFont.ts';
import type { GroundTruth } from '../src/testing/groundTruth.ts';

export interface SynthMarker {
  x: number;
  y: number;
  radius: number;
  number: number;
}

export interface SynthOptions {
  width?: number;
  height?: number;
  radius?: number;
  /** Centre-to-centre spacing as a multiple of the diameter. */
  spacingFactor?: number;
  /** How many markers of each number to place, in placement order. */
  counts: Record<number, number>;
  ringColors?: Record<number, [number, number, number]>;
  background?: [number, number, number];
  /** Gaussian-ish pixel noise amplitude, 0..40. */
  noise?: number;
  /** Box-blur radius applied at the end, simulating a soft photo. */
  blur?: number;
  /** Multiplicative lighting gradient across the frame, 0..0.5. */
  lightingGradient?: number;
  /** Random position jitter as a fraction of the radius. */
  jitter?: number;
  /** Random radius jitter as a fraction of the radius. */
  radiusJitter?: number;
  /** Paint coloured blobs under the markers, like printed artwork. */
  artwork?: boolean;
  seed?: number;
}

const DEFAULT_RING_COLORS: Record<number, [number, number, number]> = {
  1: [232, 224, 205],
  2: [26, 26, 28],
  3: [226, 138, 44],
  4: [206, 74, 60],
  5: [58, 122, 196],
  6: [72, 158, 96],
  7: [148, 96, 178],
  8: [120, 120, 126],
  9: [214, 190, 60],
  10: [40, 150, 160],
};

/** Deterministic PRNG so a failing test always fails the same way. */
function makeRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function coverage(distance: number, radius: number): number {
  return Math.max(0, Math.min(1, radius + 0.5 - distance));
}

function blend(img: RgbaImage, i: number, color: [number, number, number], alpha: number): void {
  img.data[i] = img.data[i] * (1 - alpha) + color[0] * alpha;
  img.data[i + 1] = img.data[i + 1] * (1 - alpha) + color[1] * alpha;
  img.data[i + 2] = img.data[i + 2] * (1 - alpha) + color[2] * alpha;
}

/**
 * Paint one marker: coloured ring, light centre, dark printed digit.
 * Coverage is computed analytically so edges are anti-aliased like real print.
 */
export function drawMarker(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  digit: number,
  ring: [number, number, number],
): void {
  const rOuter = radius * 1.08;
  const rInner = radius * 0.8;
  const centre: [number, number, number] = [246, 245, 242];
  const ink: [number, number, number] = [24, 24, 26];

  const x0 = Math.max(0, Math.floor(cx - rOuter - 2));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + rOuter + 2));
  const y0 = Math.max(0, Math.floor(cy - rOuter - 2));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + rOuter + 2));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const outer = coverage(d, rOuter);
      const inner = coverage(d, rInner);
      if (outer <= 0) continue;
      const i = (y * img.width + x) * 4;
      blend(img, i, ring, outer - inner);
      blend(img, i, centre, inner);
    }
  }

  // The printed digit(s) inside the light centre.
  const glyphs = digit === 10 ? [1, 0] : [digit];
  const glyphHeight = rInner * 1.15;
  const size = Math.max(9, Math.round(glyphHeight));
  const masks = glyphs.map((g) => rasterizeDigit(DIGIT_SHAPES[g], size));
  const totalWidth = masks.length * size * 0.62;
  let cursor = cx - totalWidth / 2;
  for (const mask of masks) {
    for (let gy = 0; gy < size; gy++) {
      for (let gx = 0; gx < size; gx++) {
        if (!mask.mask[gy * size + gx]) continue;
        const px = Math.round(cursor + gx - size * 0.19);
        const py = Math.round(cy - size / 2 + gy);
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        blend(img, (py * img.width + px) * 4, ink, 1);
      }
    }
    cursor += size * 0.62;
  }
}

/**
 * Build a synthetic sheet of markers plus its ground truth.
 *
 * Real sample photographs are the only way to judge final accuracy, but they
 * cannot live in a unit test; a synthetic sheet with known counts lets the
 * detector, the deduplicator and the colour learner be regression-tested on
 * every commit.
 */
export function synthesize(opts: SynthOptions): {
  image: RgbaImage;
  truth: GroundTruth;
  markers: SynthMarker[];
} {
  const radius = opts.radius ?? 14;
  const spacing = radius * 2 * (opts.spacingFactor ?? 1.35);
  const background = opts.background ?? [244, 241, 234];
  const rand = makeRandom(opts.seed ?? 12345);
  const ringColors = { ...DEFAULT_RING_COLORS, ...(opts.ringColors ?? {}) };

  const sequence: number[] = [];
  for (const [key, count] of Object.entries(opts.counts)) {
    for (let i = 0; i < count; i++) sequence.push(Number(key));
  }
  // Interleave so each number is spread across the sheet rather than blocked.
  sequence.sort(() => rand() - 0.5);

  const columns = Math.ceil(Math.sqrt(sequence.length * 1.3));
  const rows = Math.ceil(sequence.length / columns);
  const margin = radius * 2.2;
  const width = opts.width ?? Math.round(margin * 2 + spacing * (columns - 1) + radius * 2);
  const height = opts.height ?? Math.round(margin * 2 + spacing * (rows - 1) + radius * 2);

  const img = createRgba(width, height);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = background[0];
    img.data[i + 1] = background[1];
    img.data[i + 2] = background[2];
    img.data[i + 3] = 255;
  }

  if (opts.artwork) paintArtwork(img, rand);

  const markers: SynthMarker[] = [];
  sequence.forEach((number, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const jitter = (opts.jitter ?? 0.12) * radius;
    const rj = 1 + ((rand() - 0.5) * 2 * (opts.radiusJitter ?? 0.06));
    const x = margin + radius + col * spacing + (rand() - 0.5) * 2 * jitter;
    const y = margin + radius + row * spacing + (rand() - 0.5) * 2 * jitter;
    const r = radius * rj;
    drawMarker(img, x, y, r, number, ringColors[number] ?? [120, 120, 120]);
    markers.push({ x, y, radius: r, number });
  });

  if (opts.lightingGradient) applyLighting(img, opts.lightingGradient);
  if (opts.blur) applyBlur(img, opts.blur);
  if (opts.noise) applyNoise(img, opts.noise, rand);

  const counts: Record<string, number> = {};
  for (const m of markers) counts[String(m.number)] = (counts[String(m.number)] ?? 0) + 1;

  return {
    image: img,
    truth: { image: 'synthetic', counts, total: markers.length },
    markers,
  };
}

function paintArtwork(img: RgbaImage, rand: () => number): void {
  for (let blob = 0; blob < 14; blob++) {
    const cx = rand() * img.width;
    const cy = rand() * img.height;
    const r = 40 + rand() * Math.min(img.width, img.height) * 0.25;
    const color: [number, number, number] = [60 + rand() * 170, 60 + rand() * 170, 60 + rand() * 170];
    for (let y = Math.max(0, cy - r) | 0; y < Math.min(img.height, cy + r); y++) {
      for (let x = Math.max(0, cx - r) | 0; x < Math.min(img.width, cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        blend(img, (y * img.width + x) * 4, color, 0.35 * (1 - d / r));
      }
    }
  }
}

function applyLighting(img: RgbaImage, strength: number): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const fx = x / img.width;
      const fy = y / img.height;
      const gain = 1 + strength * (0.5 - (fx * 0.6 + fy * 0.4));
      const i = (y * img.width + x) * 4;
      img.data[i] *= gain;
      img.data[i + 1] *= gain;
      img.data[i + 2] *= gain;
    }
  }
}

function applyBlur(img: RgbaImage, radius: number): void {
  const src = new Uint8ClampedArray(img.data);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const sy = Math.min(img.height - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const sx = Math.min(img.width - 1, Math.max(0, x + dx));
          const i = (sy * img.width + sx) * 4;
          sr += src[i];
          sg += src[i + 1];
          sb += src[i + 2];
          n++;
        }
      }
      const o = (y * img.width + x) * 4;
      img.data[o] = sr / n;
      img.data[o + 1] = sg / n;
      img.data[o + 2] = sb / n;
    }
  }
}

function applyNoise(img: RgbaImage, amplitude: number, rand: () => number): void {
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * amplitude;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
}
