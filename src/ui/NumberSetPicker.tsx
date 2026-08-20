import { SUPPORTED_NUMBERS } from '../core/types.ts';

interface Props {
  value: number[] | null;
  onChange(value: number[] | null): void;
  /** What the last run worked out on its own, shown when set to Auto. */
  inferred?: number[];
}

/**
 * "Which numbers are on this card?"
 *
 * Kits come with a legend, so the user knows this for certain in a second — and
 * telling the recogniser makes it physically unable to produce a number the
 * image does not contain. It is the cheapest large accuracy win in the app,
 * which is why it sits on the main screen rather than behind Advanced.
 */
export function NumberSetPicker({ value, onChange, inferred }: Props) {
  const auto = value === null;
  const selected = new Set(value ?? []);

  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    onChange(next.size === 0 ? null : [...next].sort((a, b) => a - b));
  };

  return (
    <div className="numberset">
      <div className="numberset-head">
        <span>Numbers on this image</span>
        <button
          type="button"
          className={`chip${auto ? ' is-active' : ''}`}
          onClick={() => onChange(null)}
        >
          Auto
        </button>
      </div>
      <div className="numberset-keys">
        {SUPPORTED_NUMBERS.map((n) => (
          <button
            key={n}
            type="button"
            className={`numberset-key${selected.has(n) ? ' is-active' : ''}`}
            aria-pressed={selected.has(n)}
            onClick={() => toggle(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <small>
        {auto
          ? inferred && inferred.length > 0
            ? `Working it out from the image — last run found ${inferred.join(', ')}. Tap the numbers to pin them.`
            : 'Optional. Tap the numbers your image uses to rule the others out; Auto is usually just as accurate.'
          : `Only ${[...selected].sort((a, b) => a - b).join(', ')} will be counted.`}
      </small>
    </div>
  );
}
