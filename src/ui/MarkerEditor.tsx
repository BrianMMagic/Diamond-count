import type { RgbaImage } from '../core/cv/image.ts';
import type { MarkerDetection } from '../core/types.ts';
import { MarkerThumb } from './MarkerThumb.tsx';
import { NumberPad } from './NumberPad.tsx';

interface Props {
  marker: MarkerDetection;
  original: RgbaImage;
  onPick(value: number): void;
  onReject(): void;
  onUnknown(): void;
  onClose(): void;
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  review: 'Needs review',
};

const METHOD_LABEL: Record<string, string> = {
  ocr: 'Number recognition',
  'ocr+color': 'Number recognition + colour',
  color: 'Colour match',
  manual: 'Set by you',
  unknown: 'Undecided',
};

/** Tap a marker, see exactly why it was classified that way, change it. */
export function MarkerEditor({ marker, original, onPick, onReject, onUnknown, onClose }: Props) {
  const value = marker.manualNumber ?? marker.finalNumber ?? null;
  const ring = marker.ringColor;
  return (
    <div className="sheet" role="dialog" aria-label="Marker details">
      <div className="sheet-head">
        <strong>Marker</strong>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">
        <div className="marker-detail">
          <MarkerThumb original={original} marker={marker} size={110} context={1.25} className="thumb thumb-lg" />
          <dl className="kv">
            <dt>Detected</dt>
            <dd className="kv-strong">{marker.rejected ? 'Not a marker' : (value ?? 'Unknown')}</dd>
            <dt>Confidence</dt>
            <dd>{CONFIDENCE_LABEL[marker.rejected ? 'high' : marker.finalConfidence]}</dd>
            <dt>Number read</dt>
            <dd>
              {marker.ocrPrediction ?? '—'}
              {marker.ocrConfidence != null && ` (${Math.round(marker.ocrConfidence * 100)}%)`}
            </dd>
            <dt>Colour match</dt>
            <dd>
              {marker.colorPrediction ?? '—'}
              {marker.colorConfidence != null && ` (${Math.round(marker.colorConfidence * 100)}%)`}
              {ring && (
                <span
                  className="swatch"
                  style={{ background: `rgb(${Math.round(ring.r)},${Math.round(ring.g)},${Math.round(ring.b)})` }}
                />
              )}
            </dd>
            <dt>Classification</dt>
            <dd>{METHOD_LABEL[marker.classificationMethod]}</dd>
          </dl>
        </div>
        {marker.reason && <p className="reason">{marker.reason}</p>}
        <NumberPad value={value} onPick={onPick} onReject={onReject} onUnknown={onUnknown} />
      </div>
    </div>
  );
}
