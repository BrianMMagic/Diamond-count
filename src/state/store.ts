import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadImageFile, toTransferable, fromTransferable } from '../core/imageLoader.ts';
import type { LoadedImage } from '../core/imageLoader.ts';
import { countMarkers } from '../core/resultCounter.ts';
import { refineWithCorrections } from '../core/pipeline.ts';
import { reviewPriority } from '../core/confidenceCalculator.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';
import type {
  AnalysisResult,
  DetectorSettings,
  MarkerCandidate,
  MarkerDetection,
  ProgressUpdate,
} from '../core/types.ts';
import type { WorkerResponse } from '../worker/protocol.ts';

export type Phase = 'idle' | 'loaded' | 'analyzing' | 'results';

export interface OverlayState {
  visible: boolean;
  showDetections: boolean;
  showNumbers: boolean;
  lowConfidenceOnly: boolean;
  showPossibleMissed: boolean;
}

const DEFAULT_OVERLAY: OverlayState = {
  visible: true,
  showDetections: true,
  showNumbers: true,
  lowConfidenceOnly: false,
  showPossibleMissed: false,
};

let manualSeq = 0;

export function useAppController() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DetectorSettings>(DEFAULT_SETTINGS);
  const [overlay, setOverlay] = useState<OverlayState>(DEFAULT_OVERLAY);
  const [showAllNumbers, setShowAllNumbers] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const imageRef = useRef<LoadedImage | null>(null);

  imageRef.current = image;

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      if (imageRef.current) URL.revokeObjectURL(imageRef.current.previewUrl);
    },
    [],
  );

  const openFile = useCallback(async (file: File | Blob) => {
    setError(null);
    setResult(null);
    setSelectedId(null);
    setProgress(null);
    try {
      const loaded = await loadImageFile(file);
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return loaded;
      });
      setPhase('loaded');
    } catch (err) {
      setError(`Could not read that image: ${(err as Error).message}`);
      setPhase('idle');
    }
  }, []);

  const analyze = useCallback(
    async (override?: Partial<DetectorSettings>) => {
      const current = imageRef.current;
      if (!current) return;
      const effective = { ...settings, ...override };
      setSettings(effective);
      setError(null);
      setPhase('analyzing');
      setProgress({ stage: 'preparing', label: 'Preparing image', progress: 0 });

      workerRef.current?.terminate();
      const worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'progress') {
          setProgress(msg.update);
          return;
        }
        // The worker hands the pixel buffer back so crops can be re-cut for the
        // review UI without keeping a second full-resolution copy alive.
        if (msg.image && imageRef.current) {
          imageRef.current.full = fromTransferable(msg.image);
        }
        if (msg.type === 'result') {
          setResult(msg.result);
          setPhase('results');
        } else {
          setError(msg.message);
          setPhase('loaded');
        }
        worker.terminate();
        workerRef.current = null;
      };
      worker.onerror = (event) => {
        setError(event.message || 'The analysis worker failed to start.');
        setPhase('loaded');
        worker.terminate();
        workerRef.current = null;
      };

      const payload = toTransferable(current.full);
      worker.postMessage({ type: 'analyze', image: payload, settings: effective }, [payload.buffer]);
    },
    [settings],
  );

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setPhase(image ? 'loaded' : 'idle');
    setProgress(null);
  }, [image]);

  const updateMarker = useCallback((id: string, change: Partial<MarkerDetection>) => {
    setResult((prev) => {
      if (!prev) return prev;
      const markers = prev.markers.map((m) => (m.id === id ? { ...m, ...change } : m));
      return { ...prev, markers };
    });
  }, []);

  const setMarkerNumber = useCallback(
    (id: string, value: number | null) => {
      updateMarker(id, {
        manualNumber: value,
        rejected: false,
        finalNumber: value,
        finalConfidence: 'high',
        finalScore: 1,
        classificationMethod: 'manual',
        needsReview: false,
        reason: 'Set by you.',
      });
    },
    [updateMarker],
  );

  const rejectMarker = useCallback(
    (id: string) => {
      updateMarker(id, {
        rejected: true,
        manualNumber: null,
        finalNumber: null,
        needsReview: false,
        classificationMethod: 'manual',
        reason: 'Marked as "not a marker" by you.',
      });
    },
    [updateMarker],
  );

  const markUnknown = useCallback(
    (id: string) => {
      updateMarker(id, {
        manualNumber: null,
        rejected: false,
        finalNumber: null,
        finalConfidence: 'review',
        finalScore: 0,
        classificationMethod: 'unknown',
        needsReview: true,
        reason: 'Marked as unknown by you.',
      });
    },
    [updateMarker],
  );

  const addMarker = useCallback((x: number, y: number, value: number) => {
    setResult((prev) => {
      if (!prev) return prev;
      const radius = prev.markers.length
        ? prev.markers.reduce((s, m) => s + m.radius, 0) / prev.markers.length
        : prev.stats.estimatedRadius || 10;
      const marker: MarkerDetection = {
        id: `manual-${manualSeq++}`,
        x,
        y,
        radius,
        width: radius * 2,
        height: radius * 2,
        detectionScore: 1,
        source: 'manual',
        finalNumber: value,
        manualNumber: value,
        finalConfidence: 'high',
        finalScore: 1,
        classificationMethod: 'manual',
        needsReview: false,
        reason: 'Added by you.',
      };
      return { ...prev, markers: [...prev.markers, marker] };
    });
  }, []);

  const confirmMissed = useCallback((candidate: MarkerCandidate, value: number) => {
    setResult((prev) => {
      if (!prev) return prev;
      const marker: MarkerDetection = {
        ...candidate,
        id: `recovered-${candidate.id}`,
        source: 'recovered',
        finalNumber: value,
        manualNumber: value,
        finalConfidence: 'high',
        finalScore: 1,
        classificationMethod: 'manual',
        needsReview: false,
        reason: 'Confirmed from a possible missed marker.',
      };
      return {
        ...prev,
        markers: [...prev.markers, marker],
        possibleMissed: prev.possibleMissed.filter((c) => c.id !== candidate.id),
      };
    });
  }, []);

  const dismissMissed = useCallback((candidate: MarkerCandidate) => {
    setResult((prev) =>
      prev ? { ...prev, possibleMissed: prev.possibleMissed.filter((c) => c.id !== candidate.id) } : prev,
    );
  }, []);

  /** Relabel a whole digit group — one tap can settle hundreds of markers. */
  const relabelMarkerGroup = useCallback((groupIndex: number, value: number) => {
    setResult((prev) => {
      if (!prev) return prev;
      const markers = prev.markers.map((m) =>
        m.shapeGroup === groupIndex && !m.rejected
          ? {
              ...m,
              finalNumber: value,
              manualNumber: value,
              classificationMethod: 'manual' as const,
              finalConfidence: 'high' as const,
              finalScore: 1,
              needsReview: false,
              reason: 'Set by you for this whole digit group.',
            }
          : m,
      );
      return {
        ...prev,
        markers,
        stats: {
          ...prev.stats,
          shapeGroups: prev.stats.shapeGroups.map((g) =>
            g.index === groupIndex ? { ...g, number: value, confidence: 1 } : g,
          ),
        },
      };
    });
  }, []);

  /** Re-learn colours from the corrections and re-decide the uncertain markers. */
  const applyCorrections = useCallback(() => {
    setResult((prev) => (prev ? refineWithCorrections({ ...prev, markers: prev.markers.map((m) => ({ ...m })) }) : prev));
  }, []);

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setResult(null);
    setProgress(null);
    setSelectedId(null);
    setError(null);
    setImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setPhase('idle');
  }, []);

  const counts = useMemo(() => (result ? countMarkers(result.markers) : null), [result]);

  const reviewQueue = useMemo(() => {
    if (!result) return [] as MarkerDetection[];
    return result.markers
      .filter((m) => !m.rejected && m.manualNumber == null && (m.needsReview || m.finalConfidence !== 'high'))
      .sort((a, b) => reviewPriority(a) - reviewPriority(b));
  }, [result]);

  const selected = useMemo(
    () => result?.markers.find((m) => m.id === selectedId) ?? null,
    [result, selectedId],
  );

  return {
    phase,
    image,
    progress,
    result,
    error,
    settings,
    overlay,
    showAllNumbers,
    selectedId,
    selected,
    addMode,
    counts,
    reviewQueue,
    openFile,
    analyze,
    cancel,
    reset,
    setSettings,
    setOverlay,
    setShowAllNumbers,
    setSelectedId,
    setAddMode,
    setMarkerNumber,
    rejectMarker,
    markUnknown,
    addMarker,
    confirmMissed,
    dismissMissed,
    relabelMarkerGroup,
    applyCorrections,
    setError,
  };
}

export type AppController = ReturnType<typeof useAppController>;
