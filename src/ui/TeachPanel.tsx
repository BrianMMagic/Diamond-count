import type { ExemplarPoint } from '../worker/protocol.ts';

interface Props {
  exemplars: ExemplarPoint[];
  marking: boolean;
  onStartMarking(): void;
  onStopMarking(): void;
  onRemove(digit: number): void;
  onClear(): void;
}

/**
 * Teaching the app what each number looks like on *this* card.
 *
 * Without examples the app groups markers by the shape of their digit and then
 * reads each group against a generic built-in font — a font that has never seen
 * the kit's typeface, and which is the weakest part of the whole pipeline. On
 * the reference photograph it grouped the `4`s correctly and still pulled in
 * seven markers that were plainly `1`s, `2`s and `3`s, because at this print
 * size those glyphs really do resemble a `4` once averaged.
 *
 * Pointing at one marker per number fixes that, and fixes it in a way shape
 * alone cannot. It supplies the right name for each shape, and it supplies what
 * that number's bead actually looks like. Every marker on a card like this has a
 * white face with a black digit, so shape is all the reader has to work with;
 * the bead bodies are pearl, black, gold and pink, which are nothing like each
 * other. On the reference card that took the `4`s from seven wrong to none.
 *
 * Colour is only safe because the user supplies the mapping. Learned without
 * supervision it is the most dangerous signal available — one mislabelled colour
 * is hundreds of wrong markers at once — which is why it can only ever name a
 * number somebody pointed at.
 */
export function TeachPanel({ exemplars, marking, onStartMarking, onStopMarking, onRemove, onClear }: Props) {
  const sorted = [...exemplars].sort((a, b) => a.digit - b.digit);

  return (
    <section className="teach">
      <h3>Teach it your numbers</h3>
      <p className="panel-lede">
        {marking
          ? 'Tap a marker on the photo, then choose which number it is. One example of each number is enough.'
          : 'Optional, but it is the single biggest accuracy gain — especially if one number keeps coming out wrong. Point at one example of each number and the app matches everything else against your examples instead of guessing from a built-in font.'}
      </p>

      {sorted.length > 0 && (
        <ul className="teach-list">
          {sorted.map((e) => (
            <li key={e.digit}>
              <span className="teach-digit">{e.digit}</span>
              <span className="teach-where">
                marked at {Math.round(e.x)}, {Math.round(e.y)}
              </span>
              <button type="button" className="btn btn-quiet" onClick={() => onRemove(e.digit)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="teach-actions">
        <button
          type="button"
          className={`btn ${marking ? 'btn-primary' : 'btn-quiet'}`}
          onClick={marking ? onStopMarking : onStartMarking}
        >
          {marking ? 'Done marking' : sorted.length > 0 ? 'Mark another' : 'Mark examples'}
        </button>
        {sorted.length > 0 && !marking && (
          <button type="button" className="btn btn-quiet" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
    </section>
  );
}
