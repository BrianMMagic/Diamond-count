import type { MarkerCandidate, MarkerDetection } from '../core/types.ts';

export interface OverlayOptions {
  showDetections: boolean;
  showNumbers: boolean;
  lowConfidenceOnly: boolean;
  showPossibleMissed: boolean;
  selectedId: string | null;
  /** Current image->screen scale, so strokes stay a constant size on screen. */
  scale: number;
}

export const MARKER_COLORS = {
  high: '#16a34a',
  medium: '#0ea5e9',
  review: '#f59e0b',
  manual: '#db2777',
  rejected: '#94a3b8',
  missed: '#e11d48',
} as const;

export function colorForMarker(m: MarkerDetection): string {
  if (m.rejected) return MARKER_COLORS.rejected;
  if (m.manualNumber != null) return MARKER_COLORS.manual;
  if (m.finalConfidence === 'review') return MARKER_COLORS.review;
  if (m.finalConfidence === 'high') return MARKER_COLORS.high;
  return MARKER_COLORS.medium;
}

/**
 * Draw the verification overlay in IMAGE coordinates.
 *
 * The caller has already applied the pan/zoom transform, so everything here is
 * in the image's own pixel space; line widths and font sizes are divided by the
 * scale so they stay legible at any zoom level. Without a trustworthy overlay
 * the counts are unverifiable, so this is deliberately the plainest code in the
 * app: one circle per detection, one label, no cleverness.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  markers: MarkerDetection[],
  possibleMissed: MarkerCandidate[],
  opts: OverlayOptions,
): void {
  const px = 1 / Math.max(opts.scale, 1e-6);
  ctx.save();
  ctx.lineJoin = 'round';

  if (opts.showPossibleMissed) {
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = MARKER_COLORS.missed;
    ctx.lineWidth = 2 * px;
    for (const c of possibleMissed) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius * 1.15, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (opts.showDetections) {
    for (const m of markers) {
      if (opts.lowConfidenceOnly && m.finalConfidence !== 'review' && m.manualNumber == null) continue;
      const selected = m.id === opts.selectedId;
      ctx.strokeStyle = colorForMarker(m);
      ctx.lineWidth = (selected ? 3.5 : m.finalConfidence === 'review' ? 2.6 : 1.8) * px;
      if (m.rejected) ctx.setLineDash([3 * px, 3 * px]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.radius * 1.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2 * px;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.radius * 1.32, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  if (opts.showNumbers) {
    const fontSize = Math.max(9 * px, 0);
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of markers) {
      if (opts.lowConfidenceOnly && m.finalConfidence !== 'review' && m.manualNumber == null) continue;
      if (m.rejected) continue;
      const value = m.manualNumber ?? m.finalNumber;
      const label = value == null ? '?' : String(value);
      const y = m.y - m.radius * 1.55;
      const w = ctx.measureText(label).width + 5 * px;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      roundRect(ctx, m.x - w / 2, y - fontSize * 0.72, w, fontSize * 1.44, 3 * px);
      ctx.fill();
      ctx.fillStyle = colorForMarker(m);
      ctx.fillText(label, m.x, y);
    }
  }
  ctx.restore();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Nearest marker to an image-space point, within a generous touch radius. */
export function hitTest(
  markers: MarkerDetection[],
  x: number,
  y: number,
  tolerance: number,
): MarkerDetection | null {
  let best: MarkerDetection | null = null;
  let bestD = Infinity;
  for (const m of markers) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < Math.max(m.radius * 1.4, tolerance) && d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/**
 * Draw the markers the user pointed at as examples.
 *
 * Deliberately loud and unlike everything else on the overlay. These few points
 * decide what every other marker is called, so it has to be obvious at a glance
 * which ones they are and what each was named — a single example put on the
 * wrong marker is the one mistake here that silently moves hundreds of counts.
 */
export function drawExemplars(
  ctx: CanvasRenderingContext2D,
  exemplars: Array<{ digit: number; x: number; y: number }>,
  radius: number,
  scale: number,
): void {
  const px = 1 / Math.max(scale, 1e-6);
  ctx.save();
  ctx.lineJoin = 'round';
  for (const e of exemplars) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, radius * 1.15, 0, Math.PI * 2);
    ctx.lineWidth = 4 * px;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.lineWidth = 2.5 * px;
    ctx.strokeStyle = MARKER_COLORS.manual;
    ctx.stroke();

    const label = String(e.digit);
    const size = Math.max(12, radius * 1.1);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ly = e.y - radius * 1.9;
    const w = ctx.measureText(label).width + size * 0.7;
    ctx.fillStyle = MARKER_COLORS.manual;
    roundRect(ctx, e.x - w / 2, ly - size * 0.65, w, size * 1.3, size * 0.35);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, e.x, ly);
  }
  ctx.restore();
}
