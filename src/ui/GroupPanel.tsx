import { useState } from 'react';
import type { RgbaImage } from '../core/cv/image.ts';
import type { AnalysisResult } from '../core/types.ts';
import { MarkerThumb } from './MarkerThumb.tsx';
import { NumberPad } from './NumberPad.tsx';

interface Props {
  result: AnalysisResult;
  original: RgbaImage;
  onRelabel(groupIndex: number, value: number): void;
}

/**
 * The marker groups, each with a sample crop and the number it was given.
 *
 * This is where a correction is worth making: the groups are what the counts are
 * actually built from, so fixing one label here settles every marker in it at
 * once. Checking four pictures against four numbers is a far better use of the
 * user's attention than stepping through several hundred markers.
 */
export function GroupPanel({ result, original, onRelabel }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const groups = result.stats.groups;
  if (groups.length === 0) return null;

  const sample = (index: number) => {
    const inGroup = result.markers.filter((m) => m.colorCluster === index);
    return inGroup.sort((a, b) => b.detectionScore - a.detectionScore)[0] ?? null;
  };

  return (
    <section className="groups">
      <h3>Marker groups</h3>
      <p className="panel-lede">
        Each group was labelled by reading its clearest markers. Check the picture matches the
        number — changing one fixes every marker in that group.
      </p>
      {groups
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((group) => {
          const rep = sample(group.index);
          const open = editing === group.index;
          return (
            <div key={group.index} className={`group-row${group.ambiguous ? ' is-ambiguous' : ''}`}>
              <div className="group-main">
                {rep && <MarkerThumb original={original} marker={rep} size={54} context={1.2} />}
                <span
                  className="swatch swatch-lg"
                  style={{ background: `rgb(${group.rgb[0]},${group.rgb[1]},${group.rgb[2]})` }}
                />
                <div className="group-text">
                  <strong>
                    {group.number == null ? 'Not identified' : `Number ${group.number}`}
                  </strong>
                  <small>
                    {group.count} markers ·{' '}
                    {group.ambiguous
                      ? 'read individually — this colour covers more than one number'
                      : `${group.sampled} sampled, ${Math.round(group.purity * 100)}% agreed`}
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
                <NumberPad
                  compact
                  value={group.number}
                  onPick={(v) => {
                    onRelabel(group.index, v);
                    setEditing(null);
                  }}
                />
              )}
            </div>
          );
        })}
    </section>
  );
}
