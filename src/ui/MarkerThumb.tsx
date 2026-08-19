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
  className?: string;
}

/**
 * An enlarged view of one marker, cut fresh from the full-resolution image.
 *
 * Crops are re-cut on demand rather than shipped back from the worker: several
 * hundred tiles would be tens of megabytes to keep in memory for the sake of a
 * few that are ever looked at.
 */
export function MarkerThumb({ original, marker, size, context = 1, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const crop = useMemo(
    () => cropRgba(original, marker.x, marker.y, marker.radius * 2 * CROP_FACTOR * context),
    [original, marker.x, marker.y, marker.radius, context],
  );
  useEffect(() => {
    if (ref.current) paintRgba(ref.current, crop, size);
  }, [crop, size]);
  return <canvas ref={ref} className={className ?? 'thumb'} />;
}
