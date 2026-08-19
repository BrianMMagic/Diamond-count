import type { GrayImage } from './image.ts';

export interface Component {
  label: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Centroid. */
  cx: number;
  cy: number;
  /** Second-order central moments, for ellipse fitting. */
  mu20: number;
  mu11: number;
  mu02: number;
  /** Number of background pixels fully enclosed by this component. */
  holeArea: number;
  holeCount: number;
}

export interface LabelResult {
  width: number;
  height: number;
  /** 0 = background, otherwise the component index + 1. */
  labels: Int32Array;
  components: Component[];
}

/**
 * Two-pass 8-connected labelling with union-find.
 *
 * `mask` is treated as binary: non-zero is foreground. Hole statistics come from
 * a second labelling of the background where any region touching the image
 * border is discarded — a marker ring encloses its white centre, so "has a hole
 * of roughly the right size" is one of the strongest ring signals we have.
 */
export function connectedComponents(mask: GrayImage, computeHoles = false): LabelResult {
  const { width: w, height: h, data } = mask;
  const n = w * h;
  const labels = new Int32Array(n);
  const parent: number[] = [0];

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    while (parent[a] !== root) {
      const next = parent[a];
      parent[a] = root;
      a = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      let best = 0;
      // Neighbours already visited in raster order: W, NW, N, NE.
      const cand = [
        x > 0 ? labels[i - 1] : 0,
        x > 0 && y > 0 ? labels[i - w - 1] : 0,
        y > 0 ? labels[i - w] : 0,
        x < w - 1 && y > 0 ? labels[i - w + 1] : 0,
      ];
      for (const c of cand) if (c && (best === 0 || c < best)) best = c;
      if (best === 0) {
        best = next++;
        parent[best] = best;
      }
      labels[i] = best;
      for (const c of cand) if (c) union(best, c);
    }
  }

  // Flatten labels to a dense 1..k numbering.
  const remap = new Int32Array(next);
  let count = 0;
  for (let l = 1; l < next; l++) {
    if (find(l) === l) remap[l] = ++count;
  }
  const components: Component[] = [];
  for (let i = 0; i < count; i++) {
    components.push({
      label: i + 1,
      area: 0,
      minX: w,
      minY: h,
      maxX: -1,
      maxY: -1,
      cx: 0,
      cy: 0,
      mu20: 0,
      mu11: 0,
      mu02: 0,
      holeArea: 0,
      holeCount: 0,
    });
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const l = remap[find(labels[i])];
      labels[i] = l;
      const c = components[l - 1];
      c.area++;
      c.cx += x;
      c.cy += y;
      if (x < c.minX) c.minX = x;
      if (y < c.minY) c.minY = y;
      if (x > c.maxX) c.maxX = x;
      if (y > c.maxY) c.maxY = y;
    }
  }
  for (const c of components) {
    if (c.area > 0) {
      c.cx /= c.area;
      c.cy /= c.area;
    }
  }
  // Second sweep for central moments (needs the centroid).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const c = components[l - 1];
      const dx = x - c.cx;
      const dy = y - c.cy;
      c.mu20 += dx * dx;
      c.mu11 += dx * dy;
      c.mu02 += dy * dy;
    }
  }
  for (const c of components) {
    if (c.area > 0) {
      c.mu20 /= c.area;
      c.mu11 /= c.area;
      c.mu02 /= c.area;
    }
  }

  if (computeHoles) attachHoles(mask, labels, components);
  return { width: w, height: h, labels, components };
}

function attachHoles(mask: GrayImage, labels: Int32Array, components: Component[]): void {
  const { width: w, height: h, data } = mask;
  const inverted: GrayImage = { width: w, height: h, data: new Uint8ClampedArray(w * h) };
  for (let i = 0; i < data.length; i++) inverted.data[i] = data[i] ? 0 : 255;
  // 4-connected background labelling avoids diagonal leaks out of a ring.
  const bg = labelFour(inverted);
  const touchesBorder = new Uint8Array(bg.count + 1);
  for (let x = 0; x < w; x++) {
    touchesBorder[bg.labels[x]] = 1;
    touchesBorder[bg.labels[(h - 1) * w + x]] = 1;
  }
  for (let y = 0; y < h; y++) {
    touchesBorder[bg.labels[y * w]] = 1;
    touchesBorder[bg.labels[y * w + w - 1]] = 1;
  }
  const holeArea = new Float64Array(bg.count + 1);
  const holeOwner = new Int32Array(bg.count + 1).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bl = bg.labels[i];
      if (!bl || touchesBorder[bl]) continue;
      holeArea[bl]++;
      if (holeOwner[bl] === -1) {
        // Any foreground neighbour of an enclosed region belongs to its owner.
        const neighbours = [
          x > 0 ? labels[i - 1] : 0,
          x < w - 1 ? labels[i + 1] : 0,
          y > 0 ? labels[i - w] : 0,
          y < h - 1 ? labels[i + w] : 0,
        ];
        for (const nl of neighbours) if (nl) { holeOwner[bl] = nl; break; }
      }
    }
  }
  for (let bl = 1; bl <= bg.count; bl++) {
    if (touchesBorder[bl] || holeOwner[bl] <= 0) continue;
    const owner = components[holeOwner[bl] - 1];
    if (!owner) continue;
    owner.holeArea += holeArea[bl];
    owner.holeCount++;
  }
}

function labelFour(mask: GrayImage): { labels: Int32Array; count: number } {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < labels.length; start++) {
    if (!data[start] || labels[start]) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && data[i - 1] && !labels[i - 1]) { labels[i - 1] = count; stack[sp++] = i - 1; }
      if (x < w - 1 && data[i + 1] && !labels[i + 1]) { labels[i + 1] = count; stack[sp++] = i + 1; }
      if (y > 0 && data[i - w] && !labels[i - w]) { labels[i - w] = count; stack[sp++] = i - w; }
      if (y < h - 1 && data[i + w] && !labels[i + w]) { labels[i + w] = count; stack[sp++] = i + w; }
    }
  }
  return { labels, count };
}

/** 4*pi*area / perimeter^2 approximated from the second moments of the region. */
export function momentCircularity(c: Component): number {
  if (c.area <= 0) return 0;
  const common = Math.sqrt(Math.max(0, (c.mu20 - c.mu02) ** 2 + 4 * c.mu11 * c.mu11));
  const major = Math.sqrt(Math.max(1e-9, 2 * (c.mu20 + c.mu02 + common)));
  const minor = Math.sqrt(Math.max(1e-9, 2 * (c.mu20 + c.mu02 - common)));
  return minor / major;
}

/** Semi-axes of the ellipse with the same second moments as the component. */
export function ellipseAxes(c: Component): { major: number; minor: number } {
  const common = Math.sqrt(Math.max(0, (c.mu20 - c.mu02) ** 2 + 4 * c.mu11 * c.mu11));
  return {
    major: Math.sqrt(Math.max(1e-9, 2 * (c.mu20 + c.mu02 + common))),
    minor: Math.sqrt(Math.max(1e-9, 2 * (c.mu20 + c.mu02 - common))),
  };
}
