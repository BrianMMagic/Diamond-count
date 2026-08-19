import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { MarkerCandidate, MarkerDetection } from '../core/types.ts';
import type { OverlayState } from '../state/store.ts';
import { drawOverlay, hitTest } from './overlayRenderer.ts';

interface Props {
  previewUrl: string;
  markers: MarkerDetection[];
  possibleMissed: MarkerCandidate[];
  overlay: OverlayState;
  selectedId: string | null;
  addMode: boolean;
  onSelect(marker: MarkerDetection | null): void;
  onAddAt(x: number, y: number): void;
  expanded: boolean;
  onToggleExpanded(): void;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_SCALE_FACTOR = 0.6;
const MAX_SCALE = 24;

/**
 * Pan/zoom image canvas with the detection overlay drawn on top.
 *
 * The overlay shares the canvas and the transform with the photo, which is the
 * only way to guarantee the circles stay glued to the markers at every zoom
 * level — an overlay in a separate DOM layer drifts by a pixel or two and makes
 * verification harder than it needs to be.
 */
export function ImageViewer(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const fitScaleRef = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; cx: number; cy: number } | null>(null);
  const moved = useRef(0);
  const [, forceRender] = useState(0);
  const [ready, setReady] = useState(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const view = viewRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, view.tx * dpr, view.ty * dpr);
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(img, 0, 0);
    if (props.overlay.visible) {
      drawOverlay(ctx as CanvasRenderingContext2D, props.markers, props.possibleMissed, {
        showDetections: props.overlay.showDetections,
        showNumbers: props.overlay.showNumbers,
        lowConfidenceOnly: props.overlay.lowConfidenceOnly,
        showPossibleMissed: props.overlay.showPossibleMissed,
        selectedId: props.selectedId,
        scale: view.scale,
      });
    }
  }, [props.markers, props.possibleMissed, props.overlay, props.selectedId]);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img) return;
    const rect = wrap.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    fitScaleRef.current = scale;
    viewRef.current = {
      scale,
      tx: (rect.width - img.naturalWidth * scale) / 2,
      ty: (rect.height - img.naturalHeight * scale) / 2,
    };
    draw();
  }, [draw]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setReady(true);
      fit();
    };
    img.src = props.previewUrl;
    return () => {
      imgRef.current = null;
      setReady(false);
    };
  }, [props.previewUrl, fit]);

  useLayoutEffect(() => {
    if (ready) draw();
  }, [ready, draw]);

  useEffect(() => {
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit]);

  // Entering or leaving full screen changes the canvas box, so the image has to
  // be re-fitted or it stays scaled for the old one.
  useEffect(() => {
    if (ready) requestAnimationFrame(() => fit());
  }, [props.expanded, ready, fit]);

  const clampView = useCallback(() => {
    const view = viewRef.current;
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    view.scale = Math.max(fitScaleRef.current * MIN_SCALE_FACTOR, Math.min(MAX_SCALE, view.scale));
    const w = img.naturalWidth * view.scale;
    const h = img.naturalHeight * view.scale;
    // Centre the image while it is smaller than the viewport; once it is larger,
    // keep the viewport strictly inside it so panning cannot lose the photo.
    view.tx = w <= rect.width ? (rect.width - w) / 2 : Math.min(0, Math.max(rect.width - w, view.tx));
    view.ty = h <= rect.height ? (rect.height - h) / 2 : Math.min(0, Math.max(rect.height - h, view.ty));
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const view = viewRef.current;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const ix = (px - view.tx) / view.scale;
      const iy = (py - view.ty) / view.scale;
      view.scale *= factor;
      clampView();
      view.tx = px - ix * view.scale;
      view.ty = py - iy * view.scale;
      clampView();
      draw();
    },
    [clampView, draw],
  );

  const toImage = useCallback((clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - view.tx) / view.scale,
      y: (clientY - rect.top - view.ty) / view.scale,
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      viewRef.current.tx += dx;
      viewRef.current.ty += dy;
      clampView();
      draw();
    } else if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      moved.current += 10;
      if (gesture.current.distance > 0) zoomAt(cx, cy, distance / gesture.current.distance);
      gesture.current = { distance, cx, cy };
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (!wasSingle || moved.current > 8) return;
    const pt = toImage(e.clientX, e.clientY);
    if (!pt) return;
    if (props.addMode) {
      props.onAddAt(pt.x, pt.y);
      return;
    }
    const tolerance = 22 / viewRef.current.scale;
    props.onSelect(hitTest(props.markers, pt.x, pt.y, tolerance));
  };

  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  };

  const nudge = (factor: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    forceRender((n) => n + 1);
  };

  return (
    <div className="viewer" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={`viewer-canvas${props.addMode ? ' is-adding' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
      <div className="viewer-zoom">
        <button
          type="button"
          className="viewer-expand"
          onClick={props.onToggleExpanded}
          aria-label={props.expanded ? 'Exit full screen' : 'Full screen'}
          title={props.expanded ? 'Exit full screen' : 'Full screen'}
        >
          {props.expanded ? '✕' : '⛶'}
        </button>
        <button type="button" onClick={() => nudge(1 / 1.5)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={() => { fit(); forceRender((n) => n + 1); }} aria-label="Fit image">
          ⤢
        </button>
        <button type="button" onClick={() => nudge(1.5)} aria-label="Zoom in">
          +
        </button>
      </div>
      {props.addMode && <div className="viewer-hint">Tap where a marker is missing</div>}
    </div>
  );
}
