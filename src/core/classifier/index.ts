/**
 * The seam behind which digit recognition lives.
 *
 * Only one engine remains. The Tesseract ensemble went with the stage that
 * needed it: readings used to be taken per marker, hundreds per image, where a
 * second opinion was worth its cost. Digits are now read from one averaged
 * picture per distinct shape — a handful of reads per image, on a picture far
 * sharper than any single marker — and a general-purpose OCR engine has nothing
 * to add to that. It also fetched its worker and language data from a CDN,
 * which made an otherwise offline app depend on the network and, when that
 * fetch failed inside its own nested worker, hung the analysis outright.
 */
export * from './types.ts';
export { TemplateClassifier, scoreGlyph, chamferDistance } from './templateClassifier.ts';
export type { GlyphScore } from './templateClassifier.ts';
