/**
 * Smoke-test the deployed site, not a local build.
 *
 *   npm run browser:live
 *
 * A green deploy only proves the files were published. This drives the real URL
 * the way a person would — upload a photo, teach it the numbers, analyse, and
 * read the counts off the page — because that is the only thing that proves the
 * published files work.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = join(root, 'samples', 'IMG_5199.jpg');
const url = process.argv[2] ?? 'https://brianmmagic.github.io/Diamond-count/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
// Anything fetched from another host would mean the app is not self-contained.
const external: string[] = [];
page.on('request', (r) => {
  const host = new URL(r.url()).host;
  if (host && !url.includes(host) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
    external.push(r.url());
  }
});

await page.goto(url, { waitUntil: 'networkidle' });
console.log(`loaded ${url}`);
await page.setInputFiles('input[type=file]', sample);

await page.getByRole('button', { name: /mark examples/i }).click();
const canvas = page.locator('canvas').first();
await canvas.waitFor({ state: 'visible' });
const box = (await canvas.boundingBox())!;
const fit = Math.min(box.width / 2881, box.height / 3069);
const padX = (box.width - 2881 * fit) / 2;
const padY = (box.height - 3069 * fit) / 2;
for (const e of [
  { digit: 4, x: 368, y: 433 }, { digit: 2, x: 945, y: 1376 },
  { digit: 3, x: 1590, y: 1985 }, { digit: 1, x: 1990, y: 1952 },
]) {
  await page.mouse.click(box.x + padX + e.x * fit, box.y + padY + e.y * fit);
  const dialog = page.getByRole('dialog', { name: /name this example/i });
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole('button', { name: new RegExp(`^${e.digit}$`) }).click();
  await page.waitForTimeout(150);
}
console.log(`examples marked: ${await page.locator('.teach-list li').count()}`);

const started = Date.now();
await page.getByRole('button', { name: /^analyz|^analys/i }).first().click();
await page.waitForFunction(() => /total markers/i.test(document.body.innerText), undefined, { timeout: 120_000 });
await page.waitForTimeout(1500);
console.log(`analysed in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const counts = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  return rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent?.trim()).join(':')).join('  ');
});
const total = await page.evaluate(() => {
  const m = document.body.innerText.match(/Total markers\s*([\d,]+)/i);
  return m ? m[1] : '?';
});
console.log(`total ${total}   counts ${counts}`);

// The two filters added most recently must be present and clickable.
const numberChips = await page.locator('.filters [data-filter-number]').count();
const mediumChip = await page.locator('.filters [data-filter-level="medium"]').count();
console.log(`filters: ${numberChips} number chips, medium filter present: ${mediumChip > 0}`);
if (numberChips === 0 || mediumChip === 0) problems.push('overlay filters missing');
await page.locator('.filters [data-filter-level="medium"]').first().click();
await page.waitForTimeout(400);

mkdirSync(join(root, 'samples', 'output'), { recursive: true });
const shot = join(root, 'samples', 'output', 'browser-live.png');
await page.screenshot({ path: shot, fullPage: true });
console.log(`screenshot: ${shot}`);
console.log(external.length === 0 ? 'no external requests — fully self-contained' : `EXTERNAL REQUESTS: ${external.join(', ')}`);
if (problems.length) { console.log('\nproblems:'); for (const p of problems) console.log(`  ${p}`); }
await browser.close();
process.exit(problems.length ? 1 : 0);
