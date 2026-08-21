import type { ExemplarPoint } from '../worker/protocol.ts';

interface Props {
  exemplars: ExemplarPoint[];
  marking: boolean;
  onStartMarking(): void;
  onStopMarking(): void;
  onRemove(digit: number, x?: number, y?: number): void;
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
  // Grouped by number, because that is the question being answered: which
  // numbers has it been shown, and how many examples of each.
  const byDigit = new Map<number, ExemplarPoint[]>();
  for (const e of exemplars) {
    const bucket = byDigit.get(e.digit);
    if (bucket) bucket.push(e);
    else byDigit.set(e.digit, [e]);
  }
  const sorted = [...byDigit.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <section className="teach">
      <h3>Teach it your numbers</h3>
      <p className="panel-lede">
        {marking
          ? 'Tap a marker on the photo, then choose which number it is. One example of each number is enough to start; add more of any number that keeps coming out wrong.'
          : 'Optional, but it is the single biggest accuracy gain — especially if one number keeps coming out wrong. Point at an example of each number and the app matches everything else against your examples instead of guessing from a built-in font. Your examples are saved for this photo.'}
      </p>
      <p className="panel-lede">
        If your card has numbers printed <strong>light on a dark bead</strong> as well as dark on a
        light one, mark one of those too. They are found by a second pass that only runs once you
        have pointed at one, because on a card without them that pass invents markers.
      </p>

      {sorted.length > 0 && (
        <ul className="teach-list">
          {sorted.map(([digit, points]) => (
            <li key={digit}>
              <span className="teach-digit">{digit}</span>
              <span className="teach-where">
                {points.length} example{points.length === 1 ? '' : 's'} marked
              </span>
              <button type="button" className="btn btn-quiet" onClick={() => onRemove(digit)}>
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
