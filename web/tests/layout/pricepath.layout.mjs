// Check for the price data path (docs/17): one TEST REPORT, entered through the Report a price sheet at the
// fuel stop SmartStop picks, must show with its time and source in all five places: Drive (the fuel card),
// Road Ahead (the recommended stop), Compare Prices, Station details and SmartStop's reasons in the fuel
// sheet. Every other station keeps "Price unavailable". No simulated prices; outside requests are blocked and
// none goes to a paid Google service.
// This proves the app shows a price it has; it does not prove that any live price feed exists.
// Run: node web/tests/layout/pricepath.layout.mjs   (needs Playwright with Chromium; CI installs it)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/index.html`;
const PRICE = '3.459';
const shotDir = process.env.SHOTS ?? null;

const failures = [];
const browser = await chromium.launch();
for (const scheme of ['dark', 'light']) {
  const fail = (m) => failures.push(`${scheme}: ${m}`);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: shotDir ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [], outside = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((u) => u.protocol === 'https:', (r) => { outside.push(r.request().url()); r.fulfill({ status: 503, body: '' }); });
  await page.goto(`${base}?demo=120`);
  await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const a = window.exitAtlas;
    a.settings.vehicle = { id: 'test', year: 2022, make: 'Test', model: 'Car', label: 'TEST vehicle', fuel: 'R', city: 28, hwy: 39, comb: 32, tankGallons: 15.8, ev: false };
    a.fuel = { rangeMeters: 140 * 1609.344, drivenAtEntry: a.snapshot.drivenTotal, enteredAt: Date.now() / 1000, source: 'dashboard' };
  });
  const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ') ?? '', sel);
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${name}-${scheme}.png` }); };
  await click('.tabbar [data-arg="drive"]');
  await page.waitForTimeout(600);
  const pick = await page.evaluate(() => { const p = window.exitAtlas.smartStop()?.primary; return p ? { id: p.id, name: p.name } : null; });
  if (!pick) { fail('SmartStop picked no fuel stop'); await ctx.close(); continue; }

  // Report the price through the app: fuel card, fuel sheet, Prices, Report a price.
  await click('[data-act="sheet"][data-arg="fuel"]');
  await page.waitForSelector(`#sheet.open [data-act="station"][data-arg="${pick.id}"]`, { timeout: 10000 });
  await click(`#sheet-body [data-act="station"][data-arg="${pick.id}"]`);
  await page.waitForSelector('#sheet-body [data-act="report-price"]', { timeout: 10000 });
  await click('#sheet-body [data-act="report-price"]');
  await page.waitForSelector('#sheet-body [data-report="price"]', { timeout: 10000 });
  await page.evaluate(() => { const t = document.querySelector('#sheet-body [data-report="passenger"]'); if (t && !t.checked) t.click(); });
  await page.fill('#sheet-body [data-report="price"]', PRICE);
  await click('#sheet-body [data-act="report-save"]');
  await page.waitForTimeout(500);
  const saved = await text('#sheet-body .banner');
  if (!/Saved on this device/.test(saved)) fail(`the report was not saved: ${saved}`);
  await click('[data-act="close-sheet"]');
  await page.waitForTimeout(600);

  // 1. Drive: the fuel card.
  const drive = await text('.card[data-act="sheet"][data-arg="fuel"]');
  if (!drive.includes(`$${PRICE}`) || !/Reported (just now|1 minute ago)/.test(drive) || !/you/.test(drive)) fail(`Drive fuel card: ${drive}`);
  await shot('1-drive');
  // 2. Road Ahead: the recommended stop.
  await click('.tabbar [data-arg="ahead"]');
  await page.waitForTimeout(500);
  await click('[data-act="ahead-filter"][data-arg="fuel"]');
  await click('[data-act="exits-window"][data-arg="100"]');
  await page.waitForSelector('[data-testid="price-compare"]', { timeout: 10000 });
  await page.waitForTimeout(500);
  const best = await text('.best-stop');
  if (!best.includes(`$${PRICE}`)) fail(`Road Ahead recommended stop: ${best}`);
  // 3. Compare Prices: the station's row; every other row is unavailable.
  const rows = await page.evaluate((id) => [...document.querySelectorAll('.pr-row')].map((r) => ({ id: r.dataset.arg, text: r.textContent.replace(/\s+/g, ' ') })), pick.id);
  const row = rows.find((r) => r.id === pick.id);
  if (!row || !row.text.includes(`$${PRICE}`)) fail(`Compare Prices row: ${row?.text ?? 'missing'}`);
  const others = rows.filter((r) => r.id !== pick.id);
  if (!others.length || others.some((r) => !/Price\s*unavailable/.test(r.text))) fail('another station shows a price it does not have');
  await page.evaluate((id) => document.querySelector(`.pr-row[data-arg="${id}"]`)?.scrollIntoView({ block: 'center' }), pick.id);
  await shot('2-compare');
  // 4. Station details.
  await click(`.pr-row[data-arg="${pick.id}"]`);
  await page.waitForSelector('#sheet.open', { timeout: 10000 });
  await page.waitForTimeout(400);
  const sheet = await text('#sheet-body');
  if (!new RegExp(`Regular your grade.*you.*\\$${PRICE.replace('.', '\\.')}`).test(sheet)) fail(`Station details: ${sheet.slice(0, 200)}`);
  if ((sheet.match(/Price unavailable/g) ?? []).length !== 3) fail('Station details: the other grades are not unavailable');
  await shot('3-station');
  await click('[data-act="close-sheet"]');
  // 5. SmartStop: the price is one of the pick's reasons.
  await click('.tabbar [data-arg="drive"]');
  await page.waitForTimeout(400);
  await click('[data-act="sheet"][data-arg="fuel"]');
  await page.waitForSelector('#sheet.open .smart-reasons', { timeout: 10000 });
  const reasons = await text('#sheet-body .smart-reasons');
  if (!reasons.includes(`$${PRICE} a gallon`)) fail(`SmartStop reasons: ${reasons}`);
  await shot('4-smartstop');
  const paid = outside.filter((u) => /googleapis\.com|places/.test(u));
  if (paid.length) fail(`paid requests: ${paid.join(', ')}`);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  console.log(`${failures.some((x) => x.startsWith(scheme)) ? 'FAIL' : 'ok  '} ${scheme}: ${pick.name} at $${PRICE} in Drive, Road Ahead, Compare Prices, Station details and SmartStop`);
  await ctx.close();
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Price path: every check passed');
