import { SUPPORTED_NUMBERS } from '../core/types.ts';

interface Props {
  value: number | null;
  onPick(value: number): void;
  onReject?(): void;
  onUnknown?(): void;
  compact?: boolean;
}

/** Big touch targets: correcting a marker should be one confident tap. */
export function NumberPad({ value, onPick, onReject, onUnknown, compact }: Props) {
  return (
    <div className={`numberpad${compact ? ' is-compact' : ''}`}>
      {SUPPORTED_NUMBERS.map((n) => (
        <button
          key={n}
          type="button"
          className={`numberpad-key${value === n ? ' is-active' : ''}`}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
      {onReject && (
        <button type="button" className="numberpad-key is-wide is-danger" onClick={onReject}>
          Not a marker
        </button>
      )}
      {onUnknown && (
        <button type="button" className="numberpad-key is-wide" onClick={onUnknown}>
          Unknown
        </button>
      )}
    </div>
  );
}
