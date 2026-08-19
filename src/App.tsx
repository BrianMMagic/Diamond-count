import { useCallback, useEffect, useState } from 'react';
import { useAppController } from './state/store.ts';
import { UploadPanel } from './ui/UploadPanel.tsx';
import { ProgressPanel } from './ui/ProgressPanel.tsx';
import { ResultsPanel } from './ui/ResultsPanel.tsx';
import { ImageViewer } from './ui/ImageViewer.tsx';
import { MarkerEditor } from './ui/MarkerEditor.tsx';
import { ReviewMode } from './ui/ReviewMode.tsx';
import { DebugPanel } from './ui/DebugPanel.tsx';
import { AdvancedSettings } from './ui/AdvancedSettings.tsx';
import { NumberPad } from './ui/NumberPad.tsx';
import { NumberSetPicker } from './ui/NumberSetPicker.tsx';
import { GroupPanel } from './ui/GroupPanel.tsx';

type Sheet = 'none' | 'marker' | 'review' | 'debug' | 'add';

export default function App() {
  const app = useAppController();
  const [sheet, setSheet] = useState<Sheet>('none');
  const [pendingAdd, setPendingAdd] = useState<{ x: number; y: number } | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(
    () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'),
  );

  // Selecting a marker opens its editor; clearing the selection closes it.
  useEffect(() => {
    if (app.selectedId && sheet === 'none') setSheet('marker');
    if (!app.selectedId && sheet === 'marker') setSheet('none');
  }, [app.selectedId, sheet]);

  const closeSheet = useCallback(() => {
    setSheet('none');
    app.setSelectedId(null);
    setPendingAdd(null);
  }, [app]);

  const onAddAt = useCallback((x: number, y: number) => {
    setPendingAdd({ x, y });
    setSheet('add');
  }, []);

  const hasImage = !!app.image;
  const showViewer = hasImage && app.phase !== 'idle';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="topbar-mark" aria-hidden="true">
            ◎
          </span>
          Marker Count
        </div>
        <div className="topbar-actions">
          {hasImage && (
            <button type="button" className="btn btn-quiet" onClick={app.reset}>
              New image
            </button>
          )}
          {debugEnabled && app.result && (
            <button type="button" className="btn btn-quiet" onClick={() => setSheet('debug')}>
              Debug
            </button>
          )}
        </div>
      </header>

      {app.error && (
        <div className="banner banner-error" role="alert">
          {app.error}
          <button type="button" className="link" onClick={() => app.setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className={`layout${showViewer ? ' has-viewer' : ''}`}>
        {!hasImage && <UploadPanel onFile={app.openFile} />}

        {showViewer && app.image && (
          <div className="stage">
            <ImageViewer
              previewUrl={app.image.previewUrl}
              markers={app.result?.markers ?? []}
              possibleMissed={app.result?.possibleMissed ?? []}
              overlay={app.overlay}
              selectedId={app.selectedId}
              addMode={app.addMode}
              onSelect={(m) => {
                app.setSelectedId(m?.id ?? null);
                setSheet(m ? 'marker' : 'none');
              }}
              onAddAt={onAddAt}
            />
            {app.result && (
              <div className="overlay-toggles">
                <Toggle
                  label="Detections"
                  checked={app.overlay.showDetections && app.overlay.visible}
                  onChange={(v) => app.setOverlay({ ...app.overlay, showDetections: v, visible: true })}
                />
                <Toggle
                  label="Numbers"
                  checked={app.overlay.showNumbers && app.overlay.visible}
                  onChange={(v) => app.setOverlay({ ...app.overlay, showNumbers: v, visible: true })}
                />
                <Toggle
                  label="Low confidence only"
                  checked={app.overlay.lowConfidenceOnly}
                  onChange={(v) => app.setOverlay({ ...app.overlay, lowConfidenceOnly: v, visible: true })}
                />
                <Toggle
                  label="Possible missed"
                  checked={app.overlay.showPossibleMissed}
                  onChange={(v) => app.setOverlay({ ...app.overlay, showPossibleMissed: v, visible: true })}
                />
                <Toggle
                  label="Hide overlay"
                  checked={!app.overlay.visible}
                  onChange={(v) => app.setOverlay({ ...app.overlay, visible: !v })}
                />
                <button
                  type="button"
                  className={`chip${app.addMode ? ' is-active' : ''}`}
                  onClick={() => app.setAddMode(!app.addMode)}
                >
                  {app.addMode ? 'Cancel add' : 'Add marker'}
                </button>
              </div>
            )}
          </div>
        )}

        <aside className="panel">
          {app.phase === 'loaded' && (
            <div className="panel-block">
              <p className="panel-lede">
                {app.image?.capped
                  ? 'Very large photo — it was scaled down slightly so your browser can handle it.'
                  : 'Ready to analyse. Everything runs on your device.'}
              </p>
              <NumberSetPicker
                value={app.settings.allowedNumbers}
                onChange={(v) => app.setSettings({ ...app.settings, allowedNumbers: v })}
              />
              <button type="button" className="btn btn-primary btn-block" onClick={() => app.analyze()}>
                Analyze image
              </button>
              <AdvancedSettings
                settings={app.settings}
                onChange={app.setSettings}
                onReanalyze={() => app.analyze()}
              />
            </div>
          )}

          {app.phase === 'analyzing' && <ProgressPanel progress={app.progress} onCancel={app.cancel} />}

          {app.phase === 'results' && app.result && app.counts && app.image && (
            <div className="panel-block">
              <ResultsPanel
                result={app.result}
                summary={app.counts}
                showAll={app.showAllNumbers}
                fileName={app.image.fileName}
                onToggleShowAll={app.setShowAllNumbers}
                onReview={() => setSheet('review')}
                onApplyCorrections={app.applyCorrections}
              />
              <GroupPanel
                result={app.result}
                original={app.image.full}
                onRelabel={app.relabelMarkerGroup}
              />
              <NumberSetPicker
                value={app.settings.allowedNumbers}
                onChange={(v) => app.setSettings({ ...app.settings, allowedNumbers: v })}
                inferred={app.result.stats.activeNumbers}
              />
              {app.settings.allowedNumbers !== null &&
                app.settings.allowedNumbers.join() !== app.result.stats.activeNumbers.join() && (
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    onClick={() => app.analyze()}
                  >
                    Reanalyze with these numbers
                  </button>
                )}
              <AdvancedSettings
                settings={app.settings}
                estimatedMarkerSize={app.result.stats.estimatedRadius}
                onChange={app.setSettings}
                onReanalyze={() => app.analyze()}
              />
              {!debugEnabled && (
                <button type="button" className="link debug-link" onClick={() => setDebugEnabled(true)}>
                  Enable debug mode
                </button>
              )}
            </div>
          )}
        </aside>
      </main>

      {sheet === 'marker' && app.selected && app.image && (
        <MarkerEditor
          marker={app.selected}
          original={app.image.full}
          onPick={(v) => app.setMarkerNumber(app.selected!.id, v)}
          onReject={() => {
            app.rejectMarker(app.selected!.id);
            closeSheet();
          }}
          onUnknown={() => app.markUnknown(app.selected!.id)}
          onClose={closeSheet}
        />
      )}

      {sheet === 'review' && app.image && app.result && (
        <ReviewMode
          queue={app.reviewQueue}
          possibleMissed={app.result.possibleMissed}
          original={app.image.full}
          onPick={app.setMarkerNumber}
          onReject={app.rejectMarker}
          onConfirmMissed={app.confirmMissed}
          onDismissMissed={app.dismissMissed}
          onFocus={app.setSelectedId}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'debug' && app.result && app.image && (
        <DebugPanel
          result={app.result}
          original={app.image.full}
          onFocus={(id) => {
            app.setSelectedId(id);
            setSheet('marker');
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'add' && pendingAdd && (
        <div className="sheet" role="dialog" aria-label="Add marker">
          <div className="sheet-head">
            <strong>Add marker</strong>
            <button type="button" className="link" onClick={closeSheet}>
              Cancel
            </button>
          </div>
          <div className="sheet-body">
            <p className="panel-lede">Which number is on this marker?</p>
            <NumberPad
              value={null}
              onPick={(v) => {
                app.addMarker(pendingAdd.x, pendingAdd.y, v);
                setPendingAdd(null);
                setSheet('none');
                app.setAddMode(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <button
      type="button"
      className={`chip${checked ? ' is-active' : ''}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  );
}
