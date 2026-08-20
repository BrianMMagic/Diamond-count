# Marker Count

**Live app: https://brianmmagic.github.io/Diamond-count/**

Photograph a picture covered in small numbered circles and get an accurate count
for every number on it. Everything runs in the browser — **images are processed
on your device and are not uploaded.**

```
Upload image → (optional) mark one example of each number → wait → check → done.
```

The reference photograph is a bead card of 640 markers. It analyses in about
1.5 seconds and asks the user to confirm seven pictures.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle into dist/
npm test           # unit + end-to-end tests
npm run synth      # accuracy against sheets with known contents
npm run samples    # run real photographs in samples/ through the pipeline
npm run browser    # drive the built app in a real browser and screenshot it
npm run browser:teach  # same, but marking one example of each number first
npm run browser:filters # check the overlay filters actually narrow what is drawn
```

Two dependencies, `react` and `react-dom`. No backend, no API keys, no CDN, no
network access at any point. The production bundle is a static site
(`base: './'`, so it can be served from any sub-path).

---

## How it works

An image holds a **handful of distinct markers, not several hundred independent
puzzles**. Everything below follows from taking that seriously.

A marker's digit is around 30 pixels tall in a good photograph and half that in
an ordinary one. Reading each marker on its own means running a reader hundreds
of times on input near the edge of what can be read at all, and a reader that is
95% right then scatters thirty-five mistakes across seven hundred markers, none
of them visible to the person holding the phone.

So no marker is ever read on its own. Markers are grouped by the *shape* of
their digit, each group is averaged, and only the averages are read — a handful
of readings per image, on pictures far sharper than any single marker, which the
user then confirms. A mistake lands once per distinct digit instead of once per
marker, it is visible as a picture that does not match its label, and correcting
it settles every marker in that group.

```
find the digits → isolate each one → group by shape → average → read → confirm
```

### 1. Finding markers — `core/glyphDetector.ts`

Detection looks for the **printed digit**, not the marker's ring.

The ring is the one feature that is not invariant. On a real bead card a `3` has
a gold rim, a `2` a black one, and a `1` is pearl throughout — its rim within a
few grey levels of its own face, with no edge to find at all. A detector built
on ring gradients loses those markers outright and nothing downstream can
recover a marker that was never proposed.

What every marker has, whatever its body is made of, is a black digit on a
bright face, and that contrast exists by construction: a person has to be able
to read it. So the detector Sauvola-thresholds for ink, then asks of each piece
whether it sits on a bright disc — is it dark against its immediate
surroundings, and is that bright patch distinct from the artwork further out.

Two details carry more weight than they look like they should:

- **The face is measured without the digit standing on it.** A window centred on
  a glyph contains that glyph, so a plain mean is dragged down in proportion to
  how much ink the digit carries. That turns a test meant to reject
  not-a-marker into a partial measurement of *which digit is present*: a `1` is
  a solid bar in the middle of the window, and it failed. Sampling only the
  bright pixels fixes it in both directions — real markers that were being
  deleted come back, and fur that was passing now fails.
- **Glyph size is taken from the image's own population.** Digits on one card
  vary by under a fifth in height, because they came off one press. A dark
  strand crossing pale fur can pass every photometric test and still be 18
  pixels tall next to neighbours at 29. Nothing is assumed about absolute size,
  so a card shot from further away carries over unchanged.

Marker spacing is measured from the image's own periodicity
(`core/calibrate.ts`), accurate to well under 1% on sheets of known spacing, and
the search range scales with the image rather than being fixed — a constant cap
does not degrade when the true spacing exceeds it, it collapses.

### 2. Isolating the digit — `core/glyphShape.ts`

Each detection is thresholded on its own face — across a whole tile a black
marker body dominates the histogram and Otsu splits body from face rather than
ink from face, swallowing the digit — and then the digit is separated from
everything else dark in the patch. Ink touching the patch border came from
outside the face; of what remains, the digit is the substantial piece nearest
the middle.

Normalisation preserves aspect ratio: a `1` stretched to fill a square box
becomes a thick bar indistinguishable from a `7`, and the narrowness of a `1` is
most of what identifies it. Resampling **gathers** per output cell rather than
scattering source pixels into the output; enlarging an 11-pixel digit into a
28-pixel box the other way leaves most cells empty and the stroke arrives full
of holes.

### 3. Grouping and averaging — `core/glyphClusters.ts`

Glyphs are clustered by shape, and each cluster averaged. Noise on one marker is
independent of noise on the next while the digit is not, so the mean of two
hundred instances is sharp where every individual one is mush.

Distances are measured on a blurred copy of each glyph. Comparing crisp masks
measures stroke weight and sub-pixel placement as much as shape — the same digit
printed a shade heavier scores as far apart as a different digit does.

The join threshold is deliberately **tight**, because the two ways of being
wrong are not symmetric:

|                    | cost                                                         |
| ------------------ | ------------------------------------------------------------ |
| one digit split across groups | one extra tap per spare group; cannot change a count |
| two digits merged into one group | unfixable — every marker takes whatever name the group is given, and nothing on screen says so |

### 4. Reading — `core/prototypeReader.ts`, `core/classifier/`

Each averaged prototype is matched against a small built-in vector font by
symmetric chamfer distance, with counter count ("does it have a hole?") as a
hard structural prior. This runs a handful of times per image.

A prototype that does not resemble any digit closely enough is **left unnamed**
rather than guessed at, so it reaches the results screen as a picture the user
can see is not a number and reject in one tap.

### 4b. Teaching it your numbers — `core/exemplars.ts`, `core/markerColor.ts`

Tap one marker per number before analysing and the built-in font is not
consulted at all: every marker is matched against the examples instead.

Several examples of the same number are allowed and are the way to fix a number
that keeps coming out wrong — a `3` on gold and a `3` on white fur are the same
digit under different conditions. Each marker is matched to the closest example
of each number, and the confidence behind it is the margin between *numbers*,
never between examples: comparing examples, a second `3` becomes the runner-up
to a `3`, so the margin collapses on markers that are in fact certain and the
review queue grows the more you teach it. Correcting a marker by hand also
records it as an example, so re-running fixes every other marker that was wrong
the same way.

Examples are saved in the browser against a fingerprint of the photograph, so
they survive a reload. They are deliberately *not* carried to a different photo:
an example is a coordinate on one image, and reused elsewhere it points at
whatever happens to sit at those pixels.

This is worth doing, and not only because it fixes the names. It unlocks the one
signal the automatic path cannot use. Every marker on a card like this has a
white face with a black digit, so shape is all a reader has to work with — but
the bead *bodies* are pearl, black, gold and pink, which are nothing like each
other. Colour is only safe once a person supplies the mapping: learned without
supervision it is the most dangerous signal available, because one mislabelled
colour is hundreds of wrong markers at once. Anchored to examples, a colour can
only ever name a number somebody pointed at.

On the reference photograph the `4`s were the weakest class. Grouped by shape
alone they were collected correctly and still picked up seven markers that were
plainly `1`s, `2`s and `3`s — at this print size those glyphs really do resemble
a `4` once averaged, and splitting the groups finer did not separate them (it
went from 7 groups to 59 with the same seven mistakes). Bead colour separates
them outright: sampled in a tight band just outside the printed face, every
genuine `4` sat within 12 of the marked example and the nearest impostor was 66
away.

|                       | `4` count | `4`s away from the tail | needing review |
| --------------------- | --------- | ----------------------- | -------------- |
| no examples marked    | 101       | 7                       | 31             |
| one example per number| 94        | **0**                   | 12             |

Where that band is sampled decides whether any of this works. Beads do not sit
edge to edge, so a band wide enough to look safe includes the artwork between
them and the fur underneath drags every reading toward the same muddy average —
at 0.26-0.44 of the marker spacing the genuine `4`s and their impostors overlap
and the signal is useless.

### 5. Confirming

The results screen shows each distinct digit as its averaged picture, rendered
as grey so its sharpness is visible. This is the screen worth checking: any
single marker is too small to judge by eye, the average of a few hundred is
unmistakable, and because the counts are built from these groups, correcting one
label settles every marker in it.

The overlay draws every detection on the photo, colour-coded by confidence, with
zoom and pan. Individual markers can be relabelled, rejected or added; the review
queue steps through the genuinely uncertain ones worst-first.

Two filters narrow it to something a person can actually check by looking, since
six hundred dots at once can only be judged as a whole:

- **One number at a time.** A marker the app got wrong stands out against its
  neighbours, and one it missed shows up as a hole in an otherwise even run of
  dots. Neither is visible with every other number drawn on top.
- **One confidence level at a time**, and *medium* especially. Medium is not a
  vague middle: a marker lands there when the averaged picture of its group came
  out fuzzy, so the medium set tends to be one whole class of marker rather than
  a scattering. On the reference card 97 of the 106 medium markers were `4`s —
  exactly the digit that was going wrong.

---

## Export

- **Copy counts** — `1: 112, 2: 282, 3: 145, 4: 101`
- **CSV / JSON** — per marker: id, number, position, radius, confidence, which
  group it came from, and how it was decided
- **Save as ground truth** — writes a verified run into the fixture format below

---

## Measuring accuracy

Three harnesses, deliberately independent.

**`npm run synth`** — sheets rendered with known contents: blur, sensor noise,
lighting gradients, position and size jitter, tight spacing, marker radii from
12 to 64 pixels, and a case modelled on a real kit's pearl, black, metallic and
pink beads with specular highlights. It reports three numbers separately,
because they fail independently:

- **recall** — every marker found. Nothing downstream recovers a miss.
- **purity** — each group holds one true digit. This is the property the design
  rests on.
- **naming** — the automatic reading was right. A convenience; the user confirms.

Current state: recall and purity are 100% on every case except 12-pixel markers,
where recall falls to 84%. The real-bead sheet counts 965 of 965 with every
digit exact.

**`npm run samples`** — real photographs in `samples/`, with per-group output so
that a count which looks right but was built from groups that look wrong is
visible. Add `samples/ground-truth/<name>.json` to get per-number differences.

**`npm run browser`** — builds, serves and drives the app in Chromium, uploading
a real photograph and reading the counts off the page. The Node harnesses prove
the algorithm and nothing about the app; the worker boundary, image decoding and
results screen only exist in a browser.

### On circular ground truth

The synthetic sheets are rendered from the same digit shapes the reader matches
against. That made the suite blind in a specific way: `2`, `3` and `5` were
drawn with their bowls sweeping the wrong way round and rasterised upside down —
a `2` came out as a squashed `z` — and every test passed, because the fixtures
agreed with the templates and the templates agreed with the fixtures. The only
input with an outside opinion was a real photograph, where a real `2` matched
its own broken template so poorly that `7` beat it and 409 markers were labelled
with a digit the card did not contain.

`tests/digitFont.test.ts` breaks that circle with an 8×8 ASCII fingerprint of
each digit — an external description, legible in a diff, that a person has to
read and agree with.

---

## Known limits

- **Small digits.** Below roughly 20 pixels of ink the automatic naming becomes
  unreliable and below about 15 recall starts to fall. Grouping stays pure, so
  the counts are still one confirmation away from correct, but this is the case
  to photograph closer.
- **The built-in font is a generic sans-serif.** A kit with a distinctive
  typeface may need its groups renamed; that is one tap each, and the grouping
  itself does not depend on the font. Marking one example per number avoids the
  font entirely and is the better fix.
- **Numbers whose beads share a colour.** Marking examples helps most when each
  number has its own bead colour. Where two numbers use the same colour the
  match falls back to shape, which is where it started.
- **Markers that are not on a printed face.** Detection assumes a bright disc
  under the digit.

## Layout

```
src/core/cv/          image primitives: grayscale, integral images, filters,
                      thresholding, resampling, connected components
src/core/             calibrate · glyphDetector · glyphShape · glyphClusters ·
                      prototypeReader · pipeline · markerCropper · imageLoader ·
                      resultCounter · reviewQueue
src/core/classifier/  the reader seam: digitFont · templateClassifier
src/worker/           analysis worker + its message protocol
src/state/            app controller (load, analyse, correct, re-apply)
src/ui/               viewer + overlay renderer, results, review, editor, debug
src/export/           CSV / JSON / clipboard / ground-truth
src/testing/          ground-truth types and evaluation
tests/                synthetic sheet generator and the test suite
scripts/              sample, synthetic, crop, detect, cluster and browser harnesses
```
