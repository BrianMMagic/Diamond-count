import { useEffect, useMemo, useRef } from 'react';
import { CROP_FACTOR, cropRgba } from '../core/markerCropper.ts';
import type { RgbaImage } from '../core/cv/image.ts';
import type { MarkerCandidate } from '../core/types.ts';
import { paintRgba } from './canvasUtils.ts';

interface Props {
  original: RgbaImage;
  marker: MarkerCandidate;
  size: number;
  /** Multiplier on the crop window; >1 shows more of the surroundings. */
  context?: number;
  /** Ring the marker and dim its neighbours, so it is obvious which one it is. */
  highlight?: boolean;
  className?: string;
}

/**
 * An enlarged view of one marker, cut fresh from the full-resolution image.
 *
 * Crops are re-cut on demand rather than shipped back from the worker: several
 * hundred tiles would be tens of megabytes to keep in memory for the sake of a
 * few that are ever looked at.
 */
export function MarkerThumb({ original, marker, size, context = 1, highlight, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const crop = useMemo(
    () => cropRgba(original, marker.x, marker.y, marker.radius * 2 * CROP_FACTOR * context),
    [original, marker.x, marker.y, marker.radius, context],
  );
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    paintRgba(canvas, crop, size);
    if (!highlight) return;

    // On a densely packed card a crop of one marker inevitably contains several
    // of its neighbours, and a bare tile gives no clue which one is being asked
    // about. Dim everything else and ring the subject.
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const px = canvas.width;
    const scale = px / crop.width;
    const centre = px / 2;
    const radius = marker.radius * scale;

    ctx.save();
    ctx.fillStyle = 'rgba(6, 12, 24, 0.66)';
    ctx.beginPath();
    ctx.rect(0, 0, px, px);
    ctx.arc(centre, centre, radius * 1.45, 0, Math.PI * 2, true);
    ctx.fill('evenodd');

    ctx.lineWidth = Math.max(2, radius * 0.13);
    ctx.strokeStyle = 'rgba(4, 10, 20, 0.85)';
    ctx.beginPath();
    ctx.arc(centre, centre, radius * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, radius * 0.09);
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(centre, centre, radius * 1.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }, [crop, size, highlight, marker.radius]);
  return <canvas ref={ref} className={className ?? 'thumb'} />;
}
