/**
 * Exercise the overlay filters in a real browser.
 *
 *   npm run build && npm run browser:filters
 *
 * Counts the dots actually drawn, by reading them back out of the canvas, so a
 * filter that changes the chip state without changing the picture is caught.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const sample = join(root, 'samples', 'IMG_5199.jpg');
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.map': 'application/json', '.json': 'application/json',
};
const server = createServer((req, res) => {
  const rel = (req.url ?? '/').split('?')[0];
  const path = join(dist, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!existsSync(path)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', sample);
await page.getByRole('button', { name: /^analyz|^analys/i }).first().click();
await page.waitForFunction(() => /total markers/i.test(document.body.innerText), undefined, { timeout: 90_000 });
await page.waitForTimeout(1200);

/**
 * Count pixels painted in one of the overlay's own stroke colours.
 *
 * Counting "saturated" pixels instead measures the photograph as much as the
 * overlay, and misleadingly so: the `3`s sit on gold fur that is already
 * saturated, so drawing green rings there changed the total by nothing at all
 * and the filter looked broken when it was working.
 */
const STROKES: Array<[number, number, number]> = [
  [22, 163, 74],   // high
  [14, 165, 233],  // medium
  [245, 158, 11],  // needs review
  [219, 39, 119],  // set by hand
];

const inked = () =>
  page.evaluate((strokes) => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      for (const s of strokes) {
        if (Math.abs(r - s[0]) < 40 && Math.abs(g - s[1]) < 40 && Math.abs(b - s[2]) < 40) { n++; break; }
      }
    }
    return n;
  }, STROKES);

const numberChip = (n: string) => page.locator(`.filters [data-filter-number="${n}"]`).first();
const levelChip = (v: string) => page.locator(`.filters [data-filter-level="${v}"]`).first();
// The photograph has plenty of saturated pixels of its own — orange fur, pink
// beads — so a raw count mostly measures the dog. Hiding the overlay gives the
// baseline to subtract, leaving the strokes actually drawn.
const hide = page.locator('.overlay-toggles .chip', { hasText: 'Hide overlay' }).first();
await hide.click();
await page.waitForTimeout(500);
const baseline = await inked();
await hide.click();
await page.waitForTimeout(500);
console.log(`photograph alone (overlay hidden): ${baseline}`);

const overlayInk = async () => Math.max(0, (await inked()) - baseline);
const results: Array<[string, number]> = [];
results.push(['all markers', await overlayInk()]);

for (const digit of ['1', '2', '3', '4']) {
  await numberChip(digit).click();
  await page.waitForTimeout(500);
  results.push([`only ${digit}s`, await overlayInk()]);
  await numberChip('all').click();
  await page.waitForTimeout(400);
}

for (const level of ['high', 'medium', 'review']) {
  await levelChip(level).click();
  await page.waitForTimeout(500);
  results.push([`${level} only`, await overlayInk()]);
}
await levelChip('all').click();
await page.waitForTimeout(400);

for (const [label, n] of results) console.log(`${label.padEnd(16)} overlay pixels drawn: ${n}`);

const all = results[0][1];
const only4 = results.find(([l]) => l === 'only 4s')![1];
if (!(only4 < all * 0.5)) problems.push('filtering to one number did not visibly reduce the overlay');

mkdirSync(join(root, 'samples', 'output'), { recursive: true });
const shot = join(root, 'samples', 'output', 'browser-filters.png');
await page.screenshot({ path: shot, fullPage: true });

// The view this was built for: one number at a time, so a gap in an even run of
// dots is a marker it missed and a dot on the wrong bead is one it got wrong.
await numberChip('4').click();
await page.waitForTimeout(600);
const shot4 = join(root, 'samples', 'output', 'browser-only-4s.png');
await page.screenshot({ path: shot4, fullPage: true });
console.log(`screenshot: ${shot4}`);
console.log(`screenshot: ${shot}`);
if (problems.length) { console.log('\nproblems:'); for (const p of problems) console.log(`  ${p}`); }
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
