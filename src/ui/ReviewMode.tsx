import { useEffect, useState } from 'react';
import type { RgbaImage } from '../core/cv/image.ts';
import type { MarkerCandidate, MarkerDetection } from '../core/types.ts';
import { MarkerThumb } from './MarkerThumb.tsx';
import { NumberPad } from './NumberPad.tsx';

interface Props {
  queue: MarkerDetection[];
  possibleMissed: MarkerCandidate[];
  original: RgbaImage;
  onPick(id: string, value: number): void;
  onReject(id: string): void;
  onConfirmMissed(candidate: MarkerCandidate, value: number): void;
  onDismissMissed(candidate: MarkerCandidate): void;
  onFocus(id: string): void;
  onClose(): void;
}

/**
 * Step through only the markers that are genuinely in doubt.
 *
 * With hundreds of markers, the last few percent of accuracy comes from making
 * corrections fast rather than from a cleverer classifier — one enlarged crop,
 * ten big buttons, and the queue advances itself.
 */
export function ReviewMode(props: Props) {
  const [index, setIndex] = useState(0);
  const total = props.queue.length + props.possibleMissed.length;
  const onMissed = index >= props.queue.length;
  const marker = onMissed ? null : props.queue[index];
  const candidate = onMissed ? props.possibleMissed[index - props.queue.length] : null;

  useEffect(() => {
    if (index >= total && total > 0) setIndex(total - 1);
  }, [index, total]);

  useEffect(() => {
    if (marker) props.onFocus(marker.id);
  }, [marker?.id]);

  if (total === 0) {
    return (
      <div className="sheet" role="dialog" aria-label="Review uncertain markers">
        <div className="sheet-head">
          <strong>Review</strong>
          <button type="button" className="link" onClick={props.onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body">
          <p className="empty">Nothing left to review — every marker is classified with high confidence.</p>
        </div>
      </div>
    );
  }

  const advance = () => setIndex((i) => Math.min(i + 1, total - 1));

  return (
    <div className="sheet" role="dialog" aria-label="Review uncertain markers">
      <div className="sheet-head">
        <strong>
          Review {Math.min(index + 1, total)} of {total}
        </strong>
        <button type="button" className="link" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">
        {marker && (
          <>
            <div className="review-stage">
              <MarkerThumb original={props.original} marker={marker} size={168} context={1.4} className="thumb thumb-xl" />
              <div className="review-meta">
                <div className="review-guess">
                  Best guess <strong>{marker.finalNumber ?? '?'}</strong>
                </div>
                <div className="review-note">{marker.reason}</div>
              </div>
            </div>
            <NumberPad
              value={marker.finalNumber ?? null}
              onPick={(v) => {
                props.onPick(marker.id, v);
                advance();
              }}
              onReject={() => {
                props.onReject(marker.id);
                advance();
              }}
            />
          </>
        )}
        {candidate && (
          <>
            <div className="review-stage">
              <MarkerThumb original={props.original} marker={candidate} size={168} context={1.4} className="thumb thumb-xl" />
              <div className="review-meta">
                <div className="review-guess">Possible missed marker</div>
                <div className="review-note">
                  This looked like a marker but did not pass the detector. Pick its number to count it, or skip it.
                </div>
              </div>
            </div>
            <NumberPad
              value={null}
              onPick={(v) => {
                props.onConfirmMissed(candidate, v);
              }}
              onReject={() => {
                props.onDismissMissed(candidate);
              }}
            />
          </>
        )}
        <div className="review-nav">
          <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
            Previous
          </button>
          <button type="button" onClick={advance} disabled={index >= total - 1}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
