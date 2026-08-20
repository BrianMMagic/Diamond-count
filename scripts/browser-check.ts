/**
 * Drive the built app in a real browser and screenshot what it produces.
 *
 *   npm run build && npm run browser
 *
 * The Node harness runs the pipeline directly, which proves the algorithm and
 * nothing about the app: the worker boundary, image decoding, EXIF handling and
 * the results screen only exist in a browser. This walks the actual flow a user
 * walks — drop a photograph in, wait, read the counts off the page.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const sample = join(root, 'samples', process.argv[2] ?? 'IMG_5199.jpg');

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
  if (!existsSync(path)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

const problems: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', sample);

// The analysis runs in a worker; wait for the counts to appear rather than for
// a fixed delay.
// The upload screen waits for the user to start the run.
const analyse = page.getByRole('button', { name: /analyz|analys/i }).first();
await analyse.waitFor({ state: 'visible', timeout: 30_000 });
await analyse.click();

const started = Date.now();
let finished = true;
try {
  await page.waitForFunction(
    () => /\b\d+\s*markers?\b/i.test(document.body.innerText) || /counts/i.test(document.body.innerText),
    undefined,
    { timeout: 90_000 },
  );
} catch {
  finished = false;
  problems.push('the results never appeared');
}
await page.waitForTimeout(1500);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (!finished) console.log('TIMED OUT waiting for results — page state below');

const text = await page.evaluate(() => document.body.innerText);
mkdirSync(join(root, 'samples', 'output'), { recursive: true });
const shot = join(root, 'samples', 'output', 'browser-results.png');
await page.screenshot({ path: shot, fullPage: true });

console.log(`analysed in ${elapsed}s in the browser`);
console.log('--- page text ---');
console.log(text.split('\n').filter((l) => l.trim()).slice(0, 40).join('\n'));
console.log('--- end ---');
console.log(`screenshot: ${shot}`);
if (problems.length > 0) {
  console.log(`\n${problems.length} console/page error(s):`);
  for (const p of problems.slice(0, 10)) console.log(`  ${p}`);
}

await browser.close();
server.close();
process.exit(problems.length > 0 ? 1 : 0);
