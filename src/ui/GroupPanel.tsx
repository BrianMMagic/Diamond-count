import { useEffect, useRef, useState } from 'react';
import { GLYPH_SIZE } from '../core/markerCropper.ts';
import type { AnalysisResult, ShapeGroup } from '../core/types.ts';
import { paintMask } from './canvasUtils.ts';
import { NumberPad } from './NumberPad.tsx';

interface Props {
  result: AnalysisResult;
  onRelabel(groupIndex: number, value: number): void;
  onReject(groupIndex: number): void;
}

/**
 * The distinct digits found in the image, each shown as the AVERAGE of every
 * marker that matched it.
 *
 * This is the one screen worth checking. Any single marker is too small and too
 * noisy to judge by eye, but the average of a few hundred is unmistakable — and
 * because the counts are built from these groups, correcting one label settles
 * every marker in it. Checking six pictures beats reviewing seven hundred
 * markers, and it is also a far more reliable check.
 */
export function GroupPanel({ result, onRelabel, onReject }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const groups = result.stats.shapeGroups;
  if (groups.length === 0) return null;

  return (
    <section className="groups">
      <h3>Digits found</h3>
      <p className="panel-lede">
        Each picture is the average of every marker that matched it, so it is much sharper than any
        single marker. Check it against the number — changing one fixes every marker in that group,
        and a group that isn't markers at all can be removed in one tap.
      </p>
      {groups
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((group) => {
          const open = editing === group.index;
          return (
            <div
              key={group.index}
              className={`group-row${group.number == null || group.count < 10 || group.sharpness < 0.6 ? ' is-ambiguous' : ''}`}
            >
              <div className="group-main">
                <PrototypeGlyph group={group} />
                <div className="group-text">
                  <strong>{group.number == null ? 'Not identified' : `Number ${group.number}`}</strong>
                  <small>
                    {(group.assignedCount ?? group.count)} marker
                    {(group.assignedCount ?? group.count) === 1 ? '' : 's'}
                    {group.assignedCount != null && group.assignedCount < group.count
                      ? ` · ${group.count - group.assignedCount} more matched another number by bead colour`
                      : ''}{' '}
                    ·{' '}
                    {group.sharpness >= 0.6
                      ? 'combined picture is clear'
                      : 'combined picture is fuzzy — worth checking'}
                  </small>
                </div>
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setEditing(open ? null : group.index)}
                >
                  {open ? 'Cancel' : 'Change'}
                </button>
              </div>
              {open && (
                <>
                  <NumberPad
                    compact
                    value={group.number}
                    onPick={(v) => {
                      onRelabel(group.index, v);
                      setEditing(null);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-quiet group-reject"
                    onClick={() => {
                      onReject(group.index);
                      setEditing(null);
                    }}
                  >
                    These aren't markers — remove all {group.count}
                  </button>
                </>
              )}
            </div>
          );
        })}
    </section>
  );
}

function PrototypeGlyph({ group }: { group: ShapeGroup }) {
  const refs = useRef<Array<HTMLCanvasElement | null>>([]);
  useEffect(() => {
    for (let k = 0; k < group.glyphCount; k++) {
      const canvas = refs.current[k];
      if (!canvas) continue;
      paintMask(
        canvas,
        group.prototype.slice(k * GLYPH_SIZE * GLYPH_SIZE, (k + 1) * GLYPH_SIZE * GLYPH_SIZE),
        GLYPH_SIZE,
        52,
      );
    }
  }, [group]);
  return (
    <div className="prototype">
      {Array.from({ length: group.glyphCount }, (_, k) => (
        <canvas
          key={k}
          ref={(el) => {
            refs.current[k] = el;
          }}
        />
      ))}
    </div>
  );
}
