import type { ConfidenceFilter, OverlayState } from '../state/store.ts';
import type { CountSummary } from '../core/types.ts';

interface Props {
  overlay: OverlayState;
  summary: CountSummary;
  onChange(next: OverlayState): void;
}

const LEVELS: Array<{ value: ConfidenceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'review', label: 'Needs review' },
];

/**
 * Narrowing the overlay to the markers worth looking at.
 *
 * Six hundred dots at once can only be checked as a whole, which is to say not
 * at all. Both filters exist to turn that into a question a person can actually
 * answer by looking.
 *
 * Picking a single number is the quickest audit there is: a marker the app got
 * wrong stands out against its neighbours, and one it missed shows up as a hole
 * in an otherwise even run of dots — neither of which is visible when every
 * other number is drawn on top.
 *
 * Confidence, and *medium* in particular, is the other. Medium is not a vague
 * middle; a marker lands there when the averaged picture of its group came out
 * fuzzy, so the medium set tends to be one whole class of marker rather than a
 * scattering. On the reference card 97 of 106 medium markers were `4`s — which
 * was exactly the digit going wrong.
 */
export function OverlayFilters({ overlay, summary, onChange }: Props) {
  const numbers = [...summary.counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([number]) => number)
    .sort((a, b) => a - b);

  const toggleNumber = (n: number) => {
    const current = overlay.onlyNumbers;
    if (!current) {
      // First pick starts a selection of just that number.
      onChange({ ...overlay, onlyNumbers: [n], visible: true });
      return;
    }
    const next = current.includes(n) ? current.filter((v) => v !== n) : [...current, n];
    onChange({ ...overlay, onlyNumbers: next.length === 0 || next.length === numbers.length ? null : next, visible: true });
  };

  const levelCount = (level: ConfidenceFilter) =>
    level === 'all'
      ? summary.total
      : level === 'high'
        ? summary.highConfidence
        : level === 'medium'
          ? summary.mediumConfidence
          : summary.needsReview;

  return (
    <section className="filters">
      <h3>Show on the photo</h3>

      <div className="filter-row">
        <span className="filter-label">Numbers</span>
        <div className="filter-chips">
          {numbers.map((n) => {
            const on = !overlay.onlyNumbers || overlay.onlyNumbers.includes(n);
            return (
              <button
                key={n}
                type="button"
                className={`chip${on ? ' is-active' : ''}`}
                aria-pressed={on}
                data-filter-number={n}
                onClick={() => toggleNumber(n)}
              >
                {n}
                <em>{summary.counts.get(n) ?? 0}</em>
              </button>
            );
          })}
          {overlay.onlyNumbers && (
            <button
              type="button"
              className="chip"
              data-filter-number="all"
              onClick={() => onChange({ ...overlay, onlyNumbers: null })}
            >
              All
            </button>
          )}
        </div>
      </div>

      <div className="filter-row">
        <span className="filter-label">Confidence</span>
        <div className="filter-chips">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              className={`chip${overlay.confidence === l.value ? ' is-active' : ''}`}
              aria-pressed={overlay.confidence === l.value}
              data-filter-level={l.value}
              onClick={() => onChange({ ...overlay, confidence: l.value, visible: true })}
            >
              {l.label}
              <em>{levelCount(l.value)}</em>
            </button>
          ))}
        </div>
      </div>

      {overlay.onlyNumbers?.length === 1 && (
        <p className="panel-lede">
          Showing only {overlay.onlyNumbers[0]}s. Gaps in an otherwise even run of dots are markers
          it missed; a dot sitting on the wrong bead is one it got wrong. Tap either to fix it.
        </p>
      )}
    </section>
  );
}
