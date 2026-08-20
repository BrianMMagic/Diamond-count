/**
 * Drive the "teach it your numbers" flow in a real browser.
 *
 *   npm run build && npm run browser:teach
 *
 * Marks one example of each digit by clicking the photo at known marker
 * positions, then analyses and reads the counts off the page. This is the only
 * check that the tap-to-name path, the pin overlay, the worker message and the
 * pipeline all agree about where a click landed.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const sample = join(root, 'samples', 'IMG_5199.jpg');

/** Clear examples of each digit on IMG_5199, in original-image pixels. */
const EXAMPLES: Array<{ digit: number; x: number; y: number }> = [
  { digit: 4, x: 368, y: 433 },
  { digit: 2, x: 945, y: 1376 },
  { digit: 3, x: 1590, y: 1985 },
  { digit: 1, x: 1990, y: 1952 },
];

if (!existsSync(join(dist, 'index.html'))) {
  console.error('No dist/ — run `npm run build` first.');
  process.exit(1);
}

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
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', sample);
await page.getByRole('button', { name: /mark examples/i }).click();

// Map image pixels to page pixels.
//
// The viewer opens fitted, so the whole photo is letterboxed inside the canvas
// at one scale. Deriving the mapping from the canvas backing-store size instead
// puts every click somewhere else entirely, which is exactly the kind of
// disagreement this test exists to catch — so it is computed the same way the
// viewer computes it.
const canvas = page.locator('canvas').first();
await canvas.waitFor({ state: 'visible' });
const box = (await canvas.boundingBox())!;
const IMAGE_W = 2881;
const IMAGE_H = 3069;
const fit = Math.min(box.width / IMAGE_W, box.height / IMAGE_H);
const padX = (box.width - IMAGE_W * fit) / 2;
const padY = (box.height - IMAGE_H * fit) / 2;
console.log(`canvas ${box.width.toFixed(0)}x${box.height.toFixed(0)}  fit ${fit.toFixed(4)}`);

for (const e of EXAMPLES) {
  const sx = box.x + padX + e.x * fit;
  const sy = box.y + padY + e.y * fit;
  await page.mouse.click(sx, sy);
  await page.getByRole("dialog", { name: /name this example/i }).waitFor({ timeout: 10_000 });
  await page.getByRole("dialog", { name: /name this example/i })
    .getByRole('button', { name: new RegExp(`^${e.digit}$`) }).click();
  await page.waitForTimeout(120);
}

const listed = await page.locator('.teach-list li').count();
console.log(`examples marked: ${listed} of ${EXAMPLES.length}`);

// Training must survive a reload: it is the most valuable thing the user does
// and, before it was persisted, the easiest thing to lose.
await page.reload({ waitUntil: 'networkidle' });
await page.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 });
await page.setInputFiles('input[type=file]', sample);
await page.waitForTimeout(1200);
const afterReload = await page.locator('.teach-list li').count();
console.log(`examples after reloading the page and re-opening the photo: ${afterReload}`);
if (afterReload !== EXAMPLES.length) problems.push(`training did not survive a reload (${afterReload})`);

// A different photograph must NOT inherit these examples. They are coordinates
// on one image, so carried over they would point at whatever happens to sit at
// those pixels — wrong, and silently so.
const other = join(root, 'samples', 'other-card.png');
async function loadPhoto(path: string) {
  // The file input only exists on the upload screen, so go back to it first.
  const back = page.getByRole('button', { name: /new image/i });
  if (await back.count()) await back.first().click();
  await page.locator('input[type=file]').first().waitFor({ state: 'attached', timeout: 15_000 });
  await page.setInputFiles('input[type=file]', path);
  await page.waitForTimeout(1200);
}

if (existsSync(other)) {
  await loadPhoto(other);
  const carried = await page.locator('.teach-list li').count();
  console.log(`examples carried over to a different photo: ${carried} (want 0)`);
  if (carried !== 0) problems.push(`training leaked to another image (${carried})`);
  await loadPhoto(sample);
  const restored = await page.locator('.teach-list li').count();
  console.log(`examples restored on returning to the original photo: ${restored}`);
  if (restored !== EXAMPLES.length) problems.push(`training not restored on return (${restored})`);
}

await page.getByRole('button', { name: /^analyz|^analys/i }).first().click();
const started = Date.now();
let finished = true;
try {
  await page.waitForFunction(
    () => /total markers/i.test(document.body.innerText),
    undefined,
    { timeout: 90_000 },
  );
} catch {
  finished = false;
  problems.push('the results never appeared');
}
await page.waitForTimeout(1500);
console.log(`analysed in ${((Date.now() - started) / 1000).toFixed(1)}s${finished ? '' : ' (TIMED OUT)'}`);

const text = await page.evaluate(() => document.body.innerText);
mkdirSync(join(root, 'samples', 'output'), { recursive: true });
const shot = join(root, 'samples', 'output', 'browser-teach.png');
await page.screenshot({ path: shot, fullPage: true });
console.log('--- page text ---');
console.log(text.split('\n').filter((l) => l.trim()).slice(0, 30).join('\n'));
console.log('--- end ---');
console.log(`screenshot: ${shot}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
}
await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
