import type { PipelineStage, ProgressUpdate } from '../core/types.ts';

interface Props {
  progress: ProgressUpdate | null;
  onCancel(): void;
}

const STEPS: Array<{ stage: PipelineStage; label: string }> = [
  { stage: 'preparing', label: 'Preparing image' },
  { stage: 'detecting', label: 'Detecting markers' },
  { stage: 'cropping', label: 'Extracting markers' },
  { stage: 'clustering', label: 'Grouping matching digits' },
  { stage: 'reading', label: 'Reading numbers' },
  { stage: 'resolving', label: 'Verifying detections' },
  { stage: 'counting', label: 'Counting' },
];

const ORDER: PipelineStage[] = [
  'preparing',
  'detecting',
  'deduplicating',
  'cropping',
  'reading',
  'clustering',
  'resolving',
  'verifying',
  'counting',
  'done',
];

export function ProgressPanel({ progress, onCancel }: Props) {
  const currentIndex = progress ? ORDER.indexOf(progress.stage) : 0;
  const pct = Math.round((progress?.progress ?? 0) * 100);
  return (
    <div className="progress">
      <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-pct">{pct}%</div>
      <ul className="progress-steps">
        {STEPS.map((step) => {
          const index = ORDER.indexOf(step.stage);
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'active' : 'todo';
          return (
            <li key={step.stage} className={`progress-step is-${state}`}>
              <span className="progress-dot" aria-hidden="true" />
              <span>{step.label}</span>
            </li>
          );
        })}
      </ul>
      {progress?.detail && <p className="progress-detail">{progress.detail}</p>}
      <button type="button" className="btn btn-quiet" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
