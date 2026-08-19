import { useState } from 'react';
import { countRows } from '../core/resultCounter.ts';
import type { AnalysisResult, CountSummary } from '../core/types.ts';
import { copyToClipboard, countsClipboardText, downloadText, toCsv, toGroundTruth, toJson } from '../export/exporters.ts';

interface Props {
  result: AnalysisResult;
  summary: CountSummary;
  showAll: boolean;
  fileName: string;
  onToggleShowAll(value: boolean): void;
  onReview(): void;
  onApplyCorrections(): void;
}

/**
 * The headline answer.
 *
 * Unresolved markers are shown next to the total rather than folded into it —
 * a count that hides its own uncertainty is worse than one that admits it.
 */
export function ResultsPanel(props: Props) {
  const { summary } = props;
  const [copied, setCopied] = useState(false);
  const rows = countRows(summary, props.showAll);
  const allClassified = summary.needsReview === 0 && props.result.possibleMissed.length === 0;
  const base = props.fileName.replace(/\.[^.]+$/, '') || 'markers';

  return (
    <section className="results">
      <div className="results-total">
        <span className="results-total-label">Total markers</span>
        <span className="results-total-value">{summary.total}</span>
      </div>

      <table className="results-table">
        <thead>
          <tr>
            <th>Number</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.number} className={r.count === 0 ? 'is-zero' : undefined}>
              <td>{r.number}</td>
              <td>{r.count}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={2}>No markers were detected.</td>
            </tr>
          )}
        </tbody>
      </table>

      <label className="switch">
        <input
          type="checkbox"
          checked={props.showAll}
          onChange={(e) => props.onToggleShowAll(e.target.checked)}
        />
        <span>Show all numbers 1–10</span>
      </label>

      <ul className="results-quality">
        <li>
          <span className="dot dot-high" /> High confidence <strong>{summary.highConfidence}</strong>
        </li>
        <li>
          <span className="dot dot-medium" /> Medium <strong>{summary.mediumConfidence}</strong>
        </li>
        <li>
          <span className="dot dot-review" /> Needs review <strong>{summary.needsReview}</strong>
        </li>
        {summary.rejected > 0 && (
          <li>
            <span className="dot dot-rejected" /> Removed by you <strong>{summary.rejected}</strong>
          </li>
        )}
      </ul>

      {allClassified ? (
        <p className="results-verdict is-good">All {summary.total} markers classified.</p>
      ) : (
        <p className="results-verdict">
          {summary.needsReview > 0 && `${summary.needsReview} marker${summary.needsReview === 1 ? '' : 's'} still need review`}
          {summary.needsReview > 0 && props.result.possibleMissed.length > 0 && ' · '}
          {props.result.possibleMissed.length > 0 &&
            `${props.result.possibleMissed.length} possible missed marker${props.result.possibleMissed.length === 1 ? '' : 's'}`}
          . The total above is not final yet.
        </p>
      )}

      <div className="results-actions">
        <button type="button" className="btn btn-primary" onClick={props.onReview}>
          Review uncertain markers
        </button>
        <button type="button" className="btn" onClick={props.onApplyCorrections}>
          Re-apply my corrections
        </button>
      </div>

      <div className="results-exports">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={async () => {
            const ok = await copyToClipboard(countsClipboardText(summary, props.showAll));
            setCopied(ok);
            setTimeout(() => setCopied(false), 1800);
          }}
        >
          {copied ? 'Copied' : 'Copy counts'}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => downloadText(`${base}-markers.csv`, toCsv(props.result), 'text/csv')}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() =>
            downloadText(
              `${base}-markers.json`,
              JSON.stringify(toJson(props.result, summary), null, 2),
              'application/json',
            )
          }
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() =>
            downloadText(
              `${base}.groundtruth.json`,
              toGroundTruth(props.fileName, summary),
              'application/json',
            )
          }
          title="Save these verified counts as a regression fixture for samples/ground-truth"
        >
          Save as ground truth
        </button>
      </div>
    </section>
  );
}
