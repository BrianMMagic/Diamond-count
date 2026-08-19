import { useEffect, useMemo, useRef, useState } from 'react';
import type { RgbaImage } from '../core/cv/image.ts';
import { GLYPH_SIZE, cropMarker } from '../core/markerCropper.ts';
import type { AnalysisResult, MarkerDetection } from '../core/types.ts';
import { paintGray, paintMask, paintRgba } from './canvasUtils.ts';

interface Props {
  result: AnalysisResult;
  original: RgbaImage;
  onFocus(id: string): void;
  onClose(): void;
}

type Filter = 'all' | 'review' | 'color' | 'disagree' | 'unread';

const PAGE = 24;

/**
 * Developer view over every stage of the pipeline.
 *
 * Improving accuracy on real photographs means being able to see WHY a marker
 * was classified the way it was — the crop the classifier actually saw, the
 * glyph it isolated, the colour it sampled — rather than guessing from a total
 * that is off by nine.
 */
export function DebugPanel({ result, original, onFocus, onClose }: Props) {
  const [filter, setFilter] = useState<Filter>('review');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const all = result.markers;
    switch (filter) {
      case 'review':
        return all.filter((m) => m.finalConfidence === 'review' || m.needsReview);
      case 'color':
        return all.filter((m) => m.classificationMethod === 'color');
      case 'disagree':
        return all.filter(
          (m) => m.ocrPrediction != null && m.colorPrediction != null && m.ocrPrediction !== m.colorPrediction,
        );
      case 'unread':
        return all.filter((m) => m.ocrPrediction == null);
      default:
        return all;
    }
  }, [result.markers, filter]);

  const pageItems = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const stats = result.stats;
  const histMax = Math.max(1, ...stats.ocrConfidenceHistogram);

  return (
    <div className="sheet sheet-tall" role="dialog" aria-label="Debug">
      <div className="sheet-head">
        <strong>Debug</strong>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">
        <div className="debug-grid">
          <Stat label="Candidates proposed" value={stats.candidatesProposed} />
          <Stat label="Candidates rejected" value={stats.candidatesRejected} />
          <Stat label="Duplicates merged" value={stats.duplicatesMerged} />
          <Stat label="Final markers" value={stats.finalMarkers} />
          <Stat label="Marker diameter" value={`${Math.round(stats.estimatedRadius * 2)} px`} />
          <Stat label="Working scale" value={stats.workingScale.toFixed(3)} />
          <Stat label="OCR engine" value={stats.ocrEngine} />
          <Stat label="OCR/colour conflicts" value={stats.ocrColorDisagreements} />
          <Stat label="Rescued by colour" value={stats.colorRescued} />
          <Stat label="Total time" value={`${(stats.durationMs / 1000).toFixed(1)} s`} />
        </div>

        <h3>Stage timings</h3>
        <ul className="debug-timings">
          {Object.entries(stats.stageTimings).map(([stage, ms]) => (
            <li key={stage}>
              <span>{stage}</span>
              <span>{Math.round(ms)} ms</span>
            </li>
          ))}
        </ul>

        <h3>Number-recognition confidence</h3>
        <div className="histogram">
          {stats.ocrConfidenceHistogram.map((count, i) => (
            <div key={i} className="histogram-col" title={`${i * 10}–${i * 10 + 10}%: ${count}`}>
              <div className="histogram-bar" style={{ height: `${(count / histMax) * 100}%` }} />
              <span>{i * 10}</span>
            </div>
          ))}
        </div>

        <h3>Colour groups discovered</h3>
        <ul className="clusters">
          {stats.colorClusters.map((c) => (
            <li key={c.index}>
              <span className="swatch" style={{ background: `rgb(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]})` }} />
              <span>
                {c.size} markers · {c.assignedNumber == null ? 'unassigned' : `number ${c.assignedNumber}`}
                {c.assignedNumber != null && ` (${Math.round(c.purity * 100)}% pure)`} · spread{' '}
                {c.spread.toFixed(1)}
              </span>
            </li>
          ))}
          {stats.colorClusters.length === 0 && <li>No colour groups were formed.</li>}
        </ul>

        <h3>Learned number → colour</h3>
        <ul className="clusters">
          {result.colorModel.entries.map((e) => (
            <li key={e.number}>
              <span className="swatch" style={{ background: `rgb(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]})` }} />
              <span>
                {e.number} · {e.samples} samples · spread {e.spread.toFixed(1)}
              </span>
            </li>
          ))}
          {result.colorModel.entries.length === 0 && (
            <li>Not enough confident readings to learn any colours.</li>
          )}
        </ul>

        <h3>Marker inspector</h3>
        <div className="debug-filters">
          {(['review', 'disagree', 'color', 'unread', 'all'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`chip${filter === f ? ' is-active' : ''}`}
              onClick={() => {
                setFilter(f);
                setPage(0);
              }}
            >
              {f}
            </button>
          ))}
          <span className="debug-count">{filtered.length} markers</span>
        </div>

        <div className="debug-gallery">
          {pageItems.map((m) => (
            <MarkerDebugCard key={m.id} marker={m} original={original} onFocus={onFocus} />
          ))}
          {pageItems.length === 0 && <p className="empty">Nothing matches this filter.</p>}
        </div>

        {pages > 1 && (
          <div className="review-nav">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              Previous
            </button>
            <span>
              Page {page + 1} / {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function MarkerDebugCard({
  marker,
  original,
  onFocus,
}: {
  marker: MarkerDetection;
  original: RgbaImage;
  onFocus(id: string): void;
}) {
  const crop = useMemo(() => cropMarker(original, marker), [original, marker.id, marker.x, marker.y, marker.radius]);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const normRef = useRef<HTMLCanvasElement | null>(null);
  const binRef = useRef<HTMLCanvasElement | null>(null);
  const glyphRefs = useRef<Array<HTMLCanvasElement | null>>([]);

  useEffect(() => {
    if (displayRef.current) paintRgba(displayRef.current, crop.display, 56);
    if (normRef.current) paintGray(normRef.current, crop.enhanced, 56);
    if (binRef.current) paintGray(binRef.current, crop.binary, 56);
    crop.glyphs.forEach((g, i) => {
      const c = glyphRefs.current[i];
      if (c) paintMask(c, g.mask, GLYPH_SIZE, 42);
    });
  }, [crop]);

  const ring = marker.ringColor;
  return (
    <div className="debug-card">
      <button type="button" className="debug-card-head" onClick={() => onFocus(marker.id)}>
        <canvas ref={displayRef} />
        <canvas ref={normRef} />
        <canvas ref={binRef} />
        {crop.glyphs.map((_, i) => (
          <canvas
            key={i}
            ref={(el) => {
              glyphRefs.current[i] = el;
            }}
          />
        ))}
      </button>
      <dl className="debug-kv">
        <dt>final</dt>
        <dd>
          <strong>{marker.manualNumber ?? marker.finalNumber ?? '?'}</strong> · {marker.finalConfidence} ·{' '}
          {(marker.finalScore ?? 0).toFixed(2)}
        </dd>
        <dt>ocr</dt>
        <dd>
          {marker.ocrPrediction ?? '—'} ({Math.round((marker.ocrConfidence ?? 0) * 100)}%)
          {marker.ocrAttempts?.length ? ` · ${marker.ocrAttempts.map((a) => `${a.engine}/${a.variant}:${a.raw || '∅'}`).join(' ')}` : ''}
        </dd>
        <dt>colour</dt>
        <dd>
          {ring && (
            <span
              className="swatch"
              style={{ background: `rgb(${Math.round(ring.r)},${Math.round(ring.g)},${Math.round(ring.b)})` }}
            />
          )}
          {marker.colorPrediction ?? '—'} ({Math.round((marker.colorConfidence ?? 0) * 100)}%) · ΔE{' '}
          {marker.colorDistance == null || !Number.isFinite(marker.colorDistance)
            ? '—'
            : marker.colorDistance.toFixed(1)}{' '}
          · cluster {marker.colorCluster ?? '—'}
        </dd>
        <dt>detect</dt>
        <dd>
          score {marker.detectionScore.toFixed(2)} · r {marker.radius.toFixed(1)} · {marker.source}
          {marker.profile && ` · closure ${marker.profile.ringClosure.toFixed(2)} · aspect ${marker.profile.aspect.toFixed(2)}`}
        </dd>
        <dt>why</dt>
        <dd>{marker.reason}</dd>
      </dl>
    </div>
  );
}
