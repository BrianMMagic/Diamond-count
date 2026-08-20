import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadImageFile, toTransferable, fromTransferable } from '../core/imageLoader.ts';
import type { LoadedImage } from '../core/imageLoader.ts';
import { countMarkers } from '../core/resultCounter.ts';
import { refineWithCorrections } from '../core/pipeline.ts';
import { reviewPriority } from '../core/reviewQueue.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';
import type {
  AnalysisResult,
  DetectorSettings,
  MarkerCandidate,
  MarkerDetection,
  ProgressUpdate,
} from '../core/types.ts';
import type { ExemplarPoint, WorkerResponse } from '../worker/protocol.ts';
import { imageSignature, loadTraining, saveTraining } from './trainingStore.ts';

export type Phase = 'idle' | 'loaded' | 'analyzing' | 'results';

/** Which confidence levels the overlay draws. */
export type ConfidenceFilter = 'all' | 'high' | 'medium' | 'review';

export interface OverlayState {
  visible: boolean;
  showDetections: boolean;
  showNumbers: boolean;
  /**
   * Restrict the overlay to one confidence level.
   *
   * `medium` earns its own filter because it is not a vague middle: a marker
   * lands there when its group's averaged picture came out fuzzy, so the
   * medium set tends to be one whole class of marker rather than a scattering.
   * On the reference card 97 of the 106 medium markers were `4`s — the digit
   * that was actually going wrong.
   */
  confidence: ConfidenceFilter;
  /**
   * Show only these numbers, or all of them when null.
   *
   * Showing one number at a time is the quickest way to audit a count: a marker
   * the app got wrong stands out against its neighbours, and a marker it missed
   * shows up as a hole in an otherwise even run of dots.
   */
  onlyNumbers: number[] | null;
  showPossibleMissed: boolean;
}

const DEFAULT_OVERLAY: OverlayState = {
  visible: true,
  showDetections: true,
  showNumbers: true,
  confidence: 'all',
  onlyNumbers: null,
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
  /**
   * Markers the user has pointed at and named, one per digit.
   *
   * Kept beside the settings rather than inside them because they belong to one
   * image: the shape and bead colour measured at these points are what the
   * analysis matches everything else against, and neither survives a change of
   * photograph.
   */
  const [exemplars, setExemplars] = useState<ExemplarPoint[]>([]);
  const [overlay, setOverlay] = useState<OverlayState>(DEFAULT_OVERLAY);
  const [showAllNumbers, setShowAllNumbers] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const imageRef = useRef<LoadedImage | null>(null);
  const exemplarsRef = useRef<ExemplarPoint[]>([]);
  /** Content fingerprint of the loaded photo; training is saved against it. */
  const signatureRef = useRef<string | null>(null);
  // These let the correction handlers reach helpers defined further down without
  // shuffling the file into dependency order.
  const resultRef = useRef<AnalysisResult | null>(null);
  const addExemplarRef = useRef<(x: number, y: number, digit: number) => void>(() => {});
  const analyzeRef = useRef<() => Promise<void>>(async () => {});

  imageRef.current = image;
  exemplarsRef.current = exemplars;
  resultRef.current = result;

  // Persist whenever the training changes, so a reload keeps it.
  useEffect(() => {
    if (signatureRef.current) saveTraining(signatureRef.current, exemplars);
  }, [exemplars]);

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
      // Examples are coordinates on one particular photograph, so they can never
      // carry over to a different one — kept, they would point at whatever
      // happens to sit at those pixels. Training for THIS photo is restored if
      // it was saved earlier.
      const signature = imageSignature(loaded.full);
      signatureRef.current = signature;
      setExemplars(loadTraining(signature));
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
      worker.postMessage(
        { type: 'analyze', image: payload, settings: effective, exemplars: exemplarsRef.current },
        [payload.buffer],
      );
    },
    [settings],
  );

  analyzeRef.current = analyze;

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
      // A correction is an example, and the most valuable kind: the user is
      // pointing at a marker the analysis got wrong and saying what it really
      // is. Kept, re-analysing fixes every other marker that was wrong the same
      // way, instead of asking for the same correction once per marker.
      if (value != null) {
        const marker = resultRef.current?.markers.find((m) => m.id === id);
        if (marker) addExemplarRef.current(marker.x, marker.y, value);
      }
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

  /**
   * Record an example of a digit at a point the user tapped.
   *
   * One per digit is enough; marking a second replaces the first, so tapping
   * again is how a mistake is undone rather than a thing to warn about.
   */
  const addExemplar = useCallback((x: number, y: number, digit: number) => {
    setExemplars((prev) => {
      // Several examples of the same number are useful — a `3` on gold and a `3`
      // on white fur are the same digit photographed under different conditions,
      // and each marker is matched to the closest example of each number. A tap
      // on a marker already marked replaces it, so a mis-tap is undone by
      // repeating it rather than being a thing to warn about.
      const kept = prev.filter((e) => Math.hypot(e.x - x, e.y - y) > 8);
      return [...kept, { digit, x, y }];
    });
  }, []);

  const removeExemplar = useCallback((digit: number, x?: number, y?: number) => {
    setExemplars((prev) =>
      x == null || y == null
        ? prev.filter((e) => e.digit !== digit)
        : prev.filter((e) => !(e.digit === digit && Math.hypot(e.x - x, e.y - y) <= 8)),
    );
  }, []);

  const clearExemplars = useCallback(() => setExemplars([]), []);

  addExemplarRef.current = addExemplar;

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

  /**
   * Throw out every marker in a digit group.
   *
   * Shapes that are not markers at all tend to look like each other, so they
   * land in groups of their own. Rejecting the group is one tap instead of
   * hundreds, and is the fastest way to clear a batch of false detections.
   */
  const rejectMarkerGroup = useCallback((groupIndex: number) => {
    setResult((prev) => {
      if (!prev) return prev;
      const markers = prev.markers.map((m) =>
        m.shapeGroup === groupIndex
          ? {
              ...m,
              rejected: true,
              manualNumber: null,
              finalNumber: null,
              needsReview: false,
              classificationMethod: 'manual' as const,
              reason: 'You marked this whole group as not markers.',
            }
          : m,
      );
      return { ...prev, markers };
    });
  }, []);

  /** Re-learn colours from the corrections and re-decide the uncertain markers. */
  /**
   * Re-decide the uncertain markers in light of what the user has fixed.
   *
   * Once there are examples to go on, the corrections have changed what the
   * analysis knows, so it is re-run: a marker fixed by hand becomes an example,
   * and every other marker that was wrong the same way follows without being
   * touched. Without examples there is nothing new to learn from, so the cheap
   * in-place pass is all that is available.
   */
  const applyCorrections = useCallback(() => {
    if (exemplarsRef.current.length > 0 && imageRef.current) {
      void analyzeRef.current();
      return;
    }
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
      // Only markers that genuinely need a decision. Including every
      // medium-confidence marker put six hundred items in the queue, almost all
      // of which were settled -- which buries the handful that actually matter.
      .filter((m) => !m.rejected && m.manualNumber == null && (m.needsReview || m.finalNumber == null))
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
    exemplars,
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
    addExemplar,
    removeExemplar,
    clearExemplars,
    confirmMissed,
    dismissMissed,
    relabelMarkerGroup,
    rejectMarkerGroup,
    applyCorrections,
    setError,
  };
}

export type AppController = ReturnType<typeof useAppController>;
