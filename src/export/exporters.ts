import type { AnalysisResult, CountSummary, MarkerDetection } from '../core/types.ts';
import { countRows } from '../core/resultCounter.ts';

const CSV_FIELDS = [
  'marker_id',
  'number',
  'x',
  'y',
  'radius',
  'confidence',
  'confidence_score',
  'ocr_result',
  'ocr_confidence',
  'shape_group',
  'classification_method',
  'review_status',
] as const;

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function round(v: number | undefined, digits = 3): string {
  return v == null || Number.isNaN(v) ? '' : String(Number(v.toFixed(digits)));
}

export function toCsv(result: AnalysisResult): string {
  const lines = [CSV_FIELDS.join(',')];
  for (const m of result.markers) {
    const value = m.manualNumber ?? m.finalNumber;
    const row = [
      m.id,
      value == null ? '' : String(value),
      round(m.x, 1),
      round(m.y, 1),
      round(m.radius, 1),
      m.rejected ? 'rejected' : m.finalConfidence,
      round(m.finalScore),
      m.ocrPrediction == null ? '' : String(m.ocrPrediction),
      round(m.ocrConfidence),
      m.shapeGroup == null || m.shapeGroup < 0 ? '' : String(m.shapeGroup),
      m.classificationMethod,
      m.rejected ? 'not-a-marker' : m.needsReview ? 'needs-review' : 'accepted',
    ];
    lines.push(row.map((v) => escapeCsv(String(v))).join(','));
  }
  return lines.join('\n');
}

export interface ExportedJson {
  version: 1;
  generatedAt: string;
  image: { width: number; height: number };
  summary: {
    total: number;
    counts: Record<string, number>;
    highConfidence: number;
    mediumConfidence: number;
    needsReview: number;
    rejected: number;
  };
  stats: AnalysisResult['stats'];
  markers: Array<Record<string, unknown>>;
}

export function toJson(result: AnalysisResult, summary: CountSummary): ExportedJson {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    image: { width: result.stats.imageWidth, height: result.stats.imageHeight },
    summary: {
      total: summary.total,
      counts: Object.fromEntries([...summary.counts.entries()].map(([k, v]) => [String(k), v])),
      highConfidence: summary.highConfidence,
      mediumConfidence: summary.mediumConfidence,
      needsReview: summary.needsReview,
      rejected: summary.rejected,
    },
    stats: result.stats,
    markers: result.markers.map(serializeMarker),
  };
}

function serializeMarker(m: MarkerDetection): Record<string, unknown> {
  return {
    id: m.id,
    x: Number(m.x.toFixed(1)),
    y: Number(m.y.toFixed(1)),
    width: Number(m.width.toFixed(1)),
    height: Number(m.height.toFixed(1)),
    radius: Number(m.radius.toFixed(1)),
    number: m.manualNumber ?? m.finalNumber ?? null,
    finalConfidence: m.rejected ? 'rejected' : m.finalConfidence,
    finalScore: m.finalScore == null ? null : Number(m.finalScore.toFixed(3)),
    classificationMethod: m.classificationMethod,
    ocrPrediction: m.ocrPrediction ?? null,
    ocrConfidence: m.ocrConfidence == null ? null : Number(m.ocrConfidence.toFixed(3)),
    ocrAttempts: m.ocrAttempts,
    glyphCount: m.glyphCount ?? null,
    shapeGroup: m.shapeGroup ?? null,
    detectionScore: Number(m.detectionScore.toFixed(3)),
    source: m.source,
    reason: m.reason,
    rejected: !!m.rejected,
  };
}

/** "1: 163, 2: 284" — the Copy Counts payload. */
export function countsClipboardText(summary: CountSummary, showAll: boolean): string {
  return countRows(summary, showAll)
    .map((r) => `${r.number}: ${r.count}`)
    .join(', ');
}

/**
 * Ground-truth stub in the exact shape `samples/ground-truth/*.json` expects, so
 * a verified image can be turned into a regression fixture in one click.
 */
export function toGroundTruth(fileName: string, summary: CountSummary): string {
  return JSON.stringify(
    {
      image: fileName,
      counts: Object.fromEntries(
        [...summary.counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]),
      ),
      total: summary.total,
      notes: 'Verified by hand.',
    },
    null,
    2,
  );
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
