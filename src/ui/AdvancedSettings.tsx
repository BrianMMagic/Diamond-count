import type { DetectorSettings } from '../core/types.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';

interface Props {
  settings: DetectorSettings;
  estimatedMarkerSize?: number;
  onChange(next: DetectorSettings): void;
  onReanalyze(): void;
}

/**
 * Everything here has a working default; the panel exists so a difficult image
 * can be rescued, not because the normal flow needs it.
 */
export function AdvancedSettings({ settings, estimatedMarkerSize, onChange, onReanalyze }: Props) {
  const set = <K extends keyof DetectorSettings>(key: K, value: DetectorSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <details className="advanced">
      <summary>Advanced</summary>
      <div className="advanced-body">
        <label className="field">
          <span>
            Marker sensitivity <em>{settings.markerSensitivity.toFixed(2)}</em>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.markerSensitivity}
            onChange={(e) => set('markerSensitivity', Number(e.target.value))}
          />
          <small>Higher finds more markers, at the cost of more false positives.</small>
        </label>

        <label className="field">
          <span>
            Number sensitivity <em>{settings.ocrSensitivity.toFixed(2)}</em>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.ocrSensitivity}
            onChange={(e) => set('ocrSensitivity', Number(e.target.value))}
          />
          <small>Higher accepts weaker digit readings without asking for review.</small>
        </label>

        <label className="field">
          <span>Expected marker size (px)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.expectedMarkerSize}
            onChange={(e) => set('expectedMarkerSize', Math.max(0, Number(e.target.value)))}
          />
          <small>
            0 = estimate automatically
            {estimatedMarkerSize ? ` (last run measured ${Math.round(estimatedMarkerSize * 2)} px across)` : ''}.
          </small>
        </label>

        <label className="field">
          <span>Working resolution (px)</span>
          <input
            type="number"
            min={800}
            max={4000}
            step={100}
            value={settings.workingResolution}
            onChange={(e) => set('workingResolution', Math.max(600, Number(e.target.value)))}
          />
          <small>Longest edge used for detection. Raise it if markers are very small.</small>
        </label>

        <label className="switch">
          <input
            type="checkbox"
            checked={settings.useTesseract}
            onChange={(e) => set('useTesseract', e.target.checked)}
          />
          <span>
            Also use the Tesseract OCR engine — needs a network connection the first time
          </span>
        </label>

        <div className="advanced-actions">
          <button type="button" className="btn btn-quiet" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset defaults
          </button>
          <button type="button" className="btn btn-primary" onClick={onReanalyze}>
            Reanalyze image
          </button>
        </div>
      </div>
    </details>
  );
}
