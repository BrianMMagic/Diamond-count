# Marker Count

**Live app: https://brianmmagic.github.io/Diamond-count/**

Photograph a picture covered in small numbered circles and get an accurate count
for every number on it. Everything runs in the browser — **images are processed
on your device and are not uploaded.**

```
Upload image → wait a few seconds → see counts → inspect the overlay → correct
any uncertain markers → done.
```

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm test           # unit + end-to-end pipeline tests
npm run samples    # run real photographs in samples/ through the pipeline
```

No backend, no API keys, no paid services. The production bundle is a static
site (`base: './'`, so it can be served from any sub-path).

---

## How it works

This is **not** OCR over the whole image. It is a purpose-built computer-vision
pipeline for ringed numeric markers, with every stage in its own module so it
can be tested, inspected and replaced independently.

```
image preparation
   → marker detection
   → duplicate removal
   → crop extraction
   → number recognition
   → colour analysis
   → colour clustering
   → evidence resolution
   → consistency check
   → counting
```

### 1. Image preparation — `core/imageLoader.ts`, `core/imagePreprocessor.ts`

EXIF orientation is applied at decode time (`imageOrientation: 'from-image'`),
so a portrait phone photo is not analysed sideways. Very large photos are capped
at 24 MP — a 48 MP shot is 190 MB of RGBA and will crash a mobile browser once
working copies exist. The original is never modified: crops for recognition and
colour sampling come from it at full resolution, while detection runs on a
normalised working copy (2000 px longest edge by default).

Preparation flattens uneven lighting by subtracting a heavily blurred copy —
this removes shadows, warm lamps and vignetting while leaving the rings, which
are a high-frequency feature — then stretches contrast and lightly sharpens.

### 2. Marker detection — `core/markerDetector.ts`

Two independent candidate generators feed one verifier.

**Fast Radial Symmetry Transform** (`cv/symmetry.ts`), "bright centre" variant:
each edge pixel votes for a point `n` pixels along its gradient, towards the
brighter side. Our markers have a light centre inside a darker ring, so the
ring's inner edge points straight at the centre and the whole ring votes for the
same spot. The textbook two-signed form would let the ring's outer edge cancel
those votes out.

Each pixel's magnitude contribution is **capped**. Without a cap, a black ring on
white paper outvotes a cream ring on cream paper by an order of magnitude and no
single threshold accepts both — this one change took recall on pale rings in the
synthetic test from 27% to 80%.

**Contour detection**: Sauvola-thresholded dark components that enclose a hole of
roughly the right size. Completely independent of the gradient statistics, so
the two generators fail in different ways.

**The verifier** (`measureProfile`) walks 36 spokes outwards from each candidate
and scores what it finds: a light centre, a dark region inside it (the printed
digit), a closed ring at a consistent radius, and a surround that differs from
the ring. It also re-centres the candidate and measures the real radius, ring
closure, circularity and ellipse aspect — markers are allowed to be oval, since
perspective and camera angle make them so.

Marker size is **estimated from the image**: the symmetry transform is swept over
a range of radii on a small copy and the winning scale (normalised for
circumference) is used, then detection is re-run once at the radius actually
measured.

### 2b. "A marker has a number in it"

The first real card produced **1,902 detections with 1,375 of them unknown** —
roughly a thousand shapes in the photograph that are not markers at all, each
arriving as a "?" for the user to resolve. The strongest available signal was
going unused: a real marker has a digit printed inside it.

So that is now a *detection* criterion, not just a classification outcome.
Detections with no isolatable digit are set aside — not counted, and reported as
"had no number inside" rather than queued as outstanding work. They stay visible
and restorable in one tap.

That also makes detection strictness **calibrated instead of assumed**. Each
candidate setting is scored by how many of its detections actually carry a digit
(sampled, not exhaustive), and the pipeline climbs towards whichever finds the
most real markers. Because the digit requirement cleans up the surplus, it is
free to detect loosely — the real risk is a pale ring missed for good, not a
phantom counted.

On a synthetic sheet of 210 markers salted with 220 ringed shapes that have no
digit: every phantom rejected, `2`, `3` and `4` counted exactly, and **one**
marker left needing review.

### 3. Duplicate removal — `core/markerDeduplicator.ts`

Greedy non-maximum suppression over a uniform spatial grid, using both centre
distance and bounding-box IoU. The strongest candidate absorbs the others and
moves to their score-weighted mean. Agreement between the two generators raises
the detection score. **One physical marker gets exactly one detection id.**

### 4. Crop extraction — `core/markerCropper.ts`

Each marker is cut from the *original* at 2.6× its radius and resampled to a
160 px tile, then several variants are produced (raw, contrast-enhanced, binary,
adaptive). Otsu is applied to the centre disc only — thresholding the whole tile
would let a black ring dominate the histogram and swallow the digit.

The digit is then **isolated**: components touching the disc rim are ring bleed,
components that are too small are paper noise, and what survives is sorted left
to right. A two-glyph result is the "10" case, handled by classifying `1` and `0`
separately.

### 5. Group by digit shape, then read the average — `core/glyphClusterer.ts`

On a card photographed at 2000px, a marker is 35-45px across and the printed
digit inside it is **10-15 pixels tall**. Tesseract wants ~30px+ character
height; below about 20px accuracy collapses. Upscaling 3-4x invents nothing — a
blurry 13px digit becomes a blurry 47px digit.

So reading every digit is the wrong shape of problem. An image contains a
*handful of distinct markers*, not several hundred independent puzzles. Markers
are matched **against each other** rather than against a typeface: glyphs are
clustered by shape, and each cluster's members are **averaged**.

That averaging is what makes the whole thing work. The noise on one marker is
independent of the noise on the next while the digit is not, so the mean of two
hundred instances is sharp where every individual one is mush. The classifier
then reads **one clean picture per distinct digit** — typically four to six
reads for an image holding several hundred markers — instead of hundreds of
blurry ones. A 95%-accurate reader stops scattering 35 errors across 700
markers.

The join threshold is measured, not guessed: across a sheet of known digits, two
instances of the same digit never exceeded 0.51 pixels apart while two different
digits never came closer than 0.85, so the boundary sits in that gap. Prototypes
are then compared far more strictly than raw glyphs and near-identical piles are
merged, which repairs over-splitting on a noisy photograph.

**Colour does not get a vote.** One mislabelled colour group is hundreds of wrong
markers at once — the failure mode is catastrophic rather than gradual, which is
a bad trade when the job is counting. Ring colour is still measured, for the
debug view and for markers whose digit could not be isolated at all, and
`useColorAssist` turns it back on; it is off by default.

The results screen shows each distinct digit as its averaged picture. Correcting
one label settles every marker in that group.

### 6. Number recognition — `core/classifier/`

Recognition sits behind one interface:

```ts
interface NumberClassifier {
  classify(crops: MarkerCrop[]): Promise<ClassificationOutput[]>;
}
```

Nothing outside that folder knows which engine produced a reading, so a
TensorFlow.js or ONNX digit model can be dropped in later without touching the
pipeline. Two engines ship today:

- **`TemplateClassifier`** — pure TypeScript, no network, no wasm. Digits 0–9 are
  described as vector strokes (`digitFont.ts`), rasterised the same way real
  glyphs are normalised, and matched by symmetric chamfer distance. Counter count
  ("does it have a hole?") is a hard structural prior. This is also the engine the
  Node test harness uses, so algorithm changes are reproducible outside a browser.
- **`TesseractClassifier`** — tesseract.js, loaded lazily, restricted to digits and
  to a single character (or a single word for "10"). It never sees the raw photo;
  by the time a crop reaches it the digit has been isolated onto white and
  enlarged, which is the difference between Tesseract being useful on 6-pixel
  print and useless on it.

They run as an **ensemble**. Agreement between a stroke matcher and a trained OCR
engine is much stronger evidence than either engine's own confidence, and their
disagreement reliably flags a marker for a human. If Tesseract cannot load
(offline, blocked CDN, unsupported browser) the app degrades to the built-in
reader rather than to an error screen, and says so in the debug panel.

### 7. Colour analysis — `core/colorAnalyzer.ts`, `core/colorClusterer.ts`

Nothing about colour is hard-coded. **The number → colour mapping is learned from
each uploaded image**, so a kit where 3 is orange and one where 3 is teal both
work.

Sampling walks 48 spokes and locks onto where the ring actually is, then takes
the **median** across spokes — a fixed annulus mixes in the white centre when the
radius is slightly off, and a mean would be dragged by one spoke crossing the
digit or a glare highlight. Colours are compared in CIE L\*a\*b\* with **CIE94**
distance, whose chroma weighting reflects that a red and an orange ring are easy
to tell apart by eye even though CIE76 calls them close.

Markers whose digit was read confidently teach the model; outliers are trimmed
before the centroid is taken. Separately, all ring colours are **clustered**
(deterministic k-means++, k chosen by silhouette over 1..10) — the spec is
explicit that ten colours must not be assumed, and an image using four numbers
produces four clusters. Clusters are then mapped to numbers by majority vote of
confident readings.

### 8. Global consistency — `core/globalConsistency.ts`

A kit uses a handful of numbers, not all ten. Deciding every marker against all
ten digits independently reliably manufactures a scattering of numbers that are
not in the image at all — the first real photograph tested produced 5 through 10
on a card that only contains 1 to 4.

Two things fix that:

- **Tell it the number set.** The picker on the main screen is a hard
  constraint. With 1–4 selected, Tesseract's character whitelist becomes `1234`
  and the template matcher only ranks those digits, so an impossible reading
  cannot be produced in the first place.
- **Infer the set when not told.** A number is real if many confident readings
  agree on it *or* it owns a substantial colour group. Anything clearing neither
  bar is noise, and every marker that named it is **re-read** with the engine
  narrowed to the numbers that do exist — a genuine second reading, not just a
  fallback to whatever ranked second.

Large, pure colour groups then **correct** disagreeing markers rather than just
flagging them. Flagging is right for a handful of markers and useless for seven
hundred; when a group of 200 identically-coloured markers is 95% "2" and a
marker sits squarely inside it with a weak digit, the group wins outright. A
confident, well-formed reading still survives and is flagged instead.

### 9. Combining the evidence — `core/classificationResolver.ts`

| Situation | Result |
| --- | --- |
| Strong reading, colour agrees | that number, **high** |
| Moderate reading, colour agrees | that number, **high** |
| Weak reading, colour strongly matches a learned number | the colour's number, method `color` |
| No reading at all, colour strongly matches | the colour's number, method `color` |
| **Strong reading, colour disagrees** | keep the reading, **flag for review** — colour never silently overrules a confident digit |
| Neither convincing | **needs review**, no guess |

A final consistency sweep demotes any marker whose ring colour sits squarely
inside a large, pure cluster labelled something else.

### 10. Confidence — `core/confidenceCalculator.ts`

One 0–1 score from OCR confidence, variant agreement, colour confidence,
number/colour agreement or conflict, detection quality, cluster purity and size
consistency — bucketed into **high / medium / needs review**. The weights are
deliberately conservative: with 700 markers it is far cheaper to review a handful
of flagged ones than to ship a wrong total.

---

## Verifying and correcting

- **Overlay** — every detection drawn on the photo, colour-coded by how it was
  classified (high / medium / colour-assisted / needs review / edited by you).
  Toggle detections, numbers, low-confidence-only, possible-missed, or hide it.
  The overlay shares the canvas and transform with the photo, so circles stay
  glued to markers at every zoom level.
- **Tap any marker** to see exactly why it was classified that way — the crop, the
  reading and its confidence, the sampled ring colour, the colour prediction, the
  method, and a plain-English reason — then change it. Totals update instantly.
- **Review uncertain markers** steps through only what is genuinely in doubt, with
  an enlarged crop and ten big buttons. This is where the last few percent of
  accuracy comes from.
- **Possible missed markers** — near-misses are kept rather than discarded, so a
  marker the detector nearly found is one tap away from being counted.
- **Add marker** — tap a spot, pick a number, for the rare complete miss.
- **Re-apply my corrections** re-learns the colour model from your edits and
  re-decides the uncertain markers. No pixels are touched, and a few manual fixes
  often settle several other markers.

The results screen never hides its own uncertainty: unresolved markers are
reported next to the total, and only when nothing is outstanding does it say
*All N markers classified.*

---

## Export

- **Copy counts** — `1: 163, 2: 284, 3: 177, 4: 118`
- **CSV** — `marker_id, number, x, y, radius, confidence, confidence_score,
  ocr_result, ocr_confidence, color_prediction, color_confidence, color_distance,
  ring_rgb, classification_method, review_status`
- **JSON** — the same per marker, plus every OCR attempt, the sampled ring colour
  in RGB and Lab, image-level statistics, and the learned colour model
- **Save as ground truth** — writes a verified run straight into the fixture format
  below

---

## Measuring accuracy on real photographs

Drop real images into `samples/` and run:

```bash
npm run samples                  # every image
npm run samples -- IMG_1234.jpg  # one image
npm run samples -- --overlay     # also write samples/output/*-overlay.png
```

The harness decodes JPEG/PNG (applying EXIF orientation itself), runs the same
pipeline the browser runs, and prints counts, detector statistics and timings.
Add `samples/ground-truth/<name>.json` with hand-verified counts and it also
reports per-number differences and lower bounds on missed, extra and
misclassified markers:

```
IMG_1234.jpg
  total: expected 758, detected 757 (-1, 99.9% accurate)
     1: expected  142 detected  141 (-1, 99.3%)
     2: expected  317 detected  317 (+0, 100.0%)
  missed >= 1, extra >= 0, misclassified >= 0, needs review 11
```

Counts alone cannot distinguish "missed a 3" from "read a 3 as a 4", so the
report separates what it can prove rather than overstating.

Sample photographs are git-ignored; the ground-truth JSON is tracked.

---

## Debug mode

Append `?debug=1` to the URL, or use the link on the results panel. It shows
aggregate statistics (candidates proposed and rejected, duplicates merged,
estimated marker size, engine used, stage timings, an OCR-confidence histogram,
the discovered colour clusters and the learned number → colour map) and a marker
inspector filtered to *needs review*, *OCR/colour disagreements*,
*colour-classified* or *unreadable*. Each card shows the original crop, the
enhanced crop, the binarised crop, the isolated glyph masks, every OCR attempt
with its raw text, the sampled ring colour and ΔE, and the reason for the final
decision.

---

## Testing

`npm test` covers the synthetic-sheet generator (`tests/synth.ts` renders marker
sheets with known counts, optional blur, sensor noise, lighting gradients,
coloured artwork underneath, position and size jitter, and tight spacing), the
detector's recall and localisation, marker-size estimation, deduplication,
colour maths and learning, the digit templates, OCR result interpretation,
counting, and end-to-end pipeline runs that assert no marker is ever emitted
twice and that the number → colour mapping is genuinely learned rather than
assumed.

## Performance

All pixel work happens in a Web Worker (`worker/analysis.worker.ts`), so the UI
never freezes. The image buffer is *transferred* in and handed back out, so two
full-resolution copies never exist at once. Progress is reported per stage.
Crops are re-cut on demand for the review UI rather than shipped back from the
worker — several hundred tiles would be tens of megabytes for the sake of the few
that are ever looked at.

## Known limits

- Recall is weakest on **pale rings against pale paper with no shadow** — the
  synthetic worst case sits around 80%. Real photographs of physical beads have
  edge shadows and do better, but this is the first thing to check against your
  own samples.
- **Set the number picker.** Auto-inference works, but the digits on these cards
  are only a few pixels tall and declaring the set removes a whole class of
  error outright.
- Tesseract loads its wasm core and language data from a CDN on first use. With
  no network the app falls back to the built-in classifier automatically.
- The built-in classifier's templates are a generic sans-serif. If your kit uses a
  distinctive typeface, corrections made in the review UI are the fastest fix, and
  `MarkerCrop.glyphs` already stores normalised 32×32 masks in a form suitable for
  training a dedicated tiny-digit model later.

## Layout

```
src/core/cv/          image primitives: colour spaces, integral images, filters,
                      thresholding, resampling, connected components, radial symmetry
src/core/             imageLoader · imagePreprocessor · markerDetector ·
                      markerDeduplicator · markerCropper · colorAnalyzer ·
                      colorClusterer · classificationResolver ·
                      globalConsistency · confidenceCalculator · resultCounter ·
                      missedMarkerFinder · pipeline
src/core/classifier/  the NumberClassifier seam: digitFont · templateClassifier ·
                      tesseractClassifier · ensemble
src/core/glyphClusterer.ts    shape clustering and averaged-prototype reading
src/worker/           analysis worker + its message protocol
src/state/            app controller (load, analyse, correct, re-refine)
src/ui/               viewer + overlay renderer, results, review, editor, debug
src/export/           CSV / JSON / clipboard / ground-truth
src/testing/          ground-truth types and evaluation
tests/                synthetic sheet generator and the test suite
scripts/              run-samples harness
```
