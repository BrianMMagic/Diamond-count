/**
 * Remembering the examples a user marked, between visits.
 *
 * Marking examples is the most valuable thing a user can do and, until now, the
 * most easily lost: the points lived in memory, so a reload threw them away and
 * re-analysing the same card meant tapping them all again.
 *
 * Everything here is keyed to a signature of the image itself, and that is the
 * point rather than an optimisation. An example is a coordinate on one specific
 * photograph — the glyph and bead colour are measured at that spot — so carrying
 * it over to a different photo does not degrade gracefully, it silently points
 * at whatever happens to be there. Keying by content means a different photo
 * simply has no saved training, and the same photo has all of it.
 */
import type { RgbaImage } from '../core/cv/image.ts';
import type { ExemplarPoint } from '../worker/protocol.ts';

const KEY = 'marker-count.training.v1';
/** How many images' training to keep. Oldest is dropped first. */
const MAX_IMAGES = 8;

interface Stored {
  [signature: string]: { at: number; exemplars: ExemplarPoint[] };
}

/**
 * A cheap content fingerprint.
 *
 * Dimensions alone would collide across photographs of the same card, which is
 * exactly the case that matters, so a sparse grid of pixels is mixed in as well.
 * It only has to tell two photographs apart, not resist tampering.
 */
export function imageSignature(image: RgbaImage): string {
  let hash = 0x811c9dc5;
  const stepX = Math.max(1, Math.floor(image.width / 32));
  const stepY = Math.max(1, Math.floor(image.height / 32));
  for (let y = 0; y < image.height; y += stepY) {
    for (let x = 0; x < image.width; x += stepX) {
      const i = (y * image.width + x) * 4;
      hash ^= image.data[i] | (image.data[i + 1] << 8) | (image.data[i + 2] << 16);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${image.width}x${image.height}-${hash.toString(36)}`;
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    // Private browsing, a full quota, or a corrupt entry. Training is a
    // convenience; losing it must never stop the app from running.
    return {};
  }
}

export function loadTraining(signature: string): ExemplarPoint[] {
  const entry = read()[signature];
  return entry?.exemplars ?? [];
}

export function saveTraining(signature: string, exemplars: ExemplarPoint[]): void {
  try {
    const all = read();
    if (exemplars.length === 0) delete all[signature];
    else all[signature] = { at: Date.now(), exemplars };

    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const stale of keys.slice(MAX_IMAGES)) delete all[stale];

    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // As above: saving is best-effort.
  }
}
