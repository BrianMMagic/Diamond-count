# Sample images

Drop real photographs of numbered artwork in this folder (`.jpg` or `.png`) and run:

```bash
npm run samples              # every image here
npm run samples -- IMG_1234.jpg
npm run samples -- --overlay # also writes samples/output/*-overlay.png
```

The harness runs the same pipeline the browser runs (using the built-in digit
classifier, since Tesseract needs a browser) and prints the counts it produced.

## Ground truth

To turn an image into a regression fixture, count it by hand — or verify a run
in the app and use **Save as ground truth** — then save the file here:

`samples/ground-truth/<image-basename>.json`

```json
{
  "image": "IMG_1234.jpg",
  "counts": { "1": 142, "2": 317, "3": 201, "4": 98 },
  "total": 758,
  "notes": "Verified by hand, 2026-08-19."
}
```

Once a fixture exists, `npm run samples` reports per-number differences, the
total accuracy, and lower bounds on missed / extra / misclassified markers — so
an algorithm change can be judged by numbers instead of by eye.

Sample images and their outputs are git-ignored; the ground-truth JSON is not.
