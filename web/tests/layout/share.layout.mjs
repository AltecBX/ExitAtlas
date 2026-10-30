// Check for shared driver reports (docs/17) on the real Worker runtime: install A (one browser profile) stands
// at a station, passes the location check and shares a price through Report a price; install B (another
// profile, nothing stored) then sees that price in Compare Prices, credited to "ExitAtlas drivers", with its
// time. Needs a running proxy with a D1 database that allows http://127.0.0.1:8765, for example
// `wrangler dev --local` (CI starts one).
// Run: WORKER_URL=http://127.0.0.1:8787 node web/tests/layout/share.layout.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dollars } from '../../js/engine/gasprices.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const worker = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));
const PRICE = (3 + Math.floor(Math.random() * 900) / 1000).toFixed(3); // a fresh price each run
// As the app shows it: $3.120 shows as $3.12 (engine/gasprices.js dollars).
const SHOWN = dollars(Number(PRICE));
const shotDir = process.env.SHOTS ?? null;
const browser = await chromium.launch();
const until = async (page, fn, arg, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`timed out: ${label}`);
};
async function install() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: shotDir ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.addInitScript((url) => { localStorage.setItem('ea.proxyURL', JSON.stringify(url)); }, worker);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto('http://127.0.0.1:8765/web/index.html?demo=120');
  await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
  await until(page, () => window.exitAtlas?.proxy?.community === true, null, 20000, 'the proxy offers shared reports');
  await page.evaluate(() => {
    const a = window.exitAtlas;
    a.settings.vehicle = { id: 'test', year: 2022, make: 'Test', model: 'Car', label: 'TEST vehicle', fuel: 'R', city: 28, hwy: 39, comb: 32, tankGallons: 15.8, ev: false };
  });
  const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
  await click('#settings-btn');
  await page.waitForSelector('[data-price="community"]');
  await page.evaluate(() => { const t = document.querySelector('[data-price="community"]'); if (!t.checked) t.click(); });
  await click('.tabbar [data-arg="ahead"]');
  await page.waitForTimeout(400);
  await click('[data-act="ahead-filter"][data-arg="fuel"]');
  await page.waitForSelector('[data-testid="price-compare"]');
  return { ctx, page, click, errors };
}

const failures = [];
const A = await install();
const station = await A.page.evaluate(() => {
  const id = document.querySelector('.pr-row')?.dataset.arg;
  const x = window.exitAtlas.findStation(id);
  return { id, name: x.name, lat: x.coordinate.lat, lon: x.coordinate.lon };
});
// Install A stands at the station: device GPS for this report (the demo drive itself is simulated).
await A.ctx.grantPermissions(['geolocation']);
await A.ctx.setGeolocation({ latitude: station.lat, longitude: station.lon, accuracy: 10 });
await A.page.evaluate(() => { window.exitAtlas.gps = 'device'; });
await A.click(`.pr-row[data-arg="${station.id}"]`);
await A.page.waitForSelector('#sheet.open [data-act="report-price"]');
await A.click('#sheet-body [data-act="report-price"]');
await until(A.page, () => window.exitAtlas.report?.near === true, null, 15000, 'the location check');
// The demo car is moving: the sheet asks for the passenger check before saving.
await A.page.evaluate(() => { const t = document.querySelector('#sheet-body [data-report="passenger"]'); if (t && !t.checked) t.click(); });
await A.page.waitForTimeout(300);
await A.page.fill('#sheet-body [data-report="price"]', PRICE);
await A.click('#sheet-body [data-act="report-save"]');
await until(A.page, () => Boolean(window.exitAtlas.report?.result), null, 15000, 'the report result');
const result = await A.page.evaluate(() => window.exitAtlas.report.result);
if (!result.ok || result.shared !== 'sent') failures.push(`install A: ${JSON.stringify(result)}`);
if (shotDir) await A.page.screenshot({ path: `${shotDir}/share-a.png` });

const B = await install();
try {
  await until(B.page, (a) => [...document.querySelectorAll('.pr-row')].some((r) => r.dataset.arg === a.id && r.textContent.includes(a.shown) && /ExitAtlas drivers/.test(r.textContent)),
    { id: station.id, shown: SHOWN }, 30000, 'install B sees the shared price');
} catch (e) { failures.push(e.message); }
const row = await B.page.evaluate((id) => document.querySelector(`.pr-row[data-arg="${id}"]`)?.textContent.replace(/\s+/g, ' ').trim(), station.id);
const own = await B.page.evaluate(() => localStorage.getItem('ea.priceReports'));
if (own) failures.push('install B has reports of its own');
if (shotDir) {
  await B.page.evaluate((id) => document.querySelector(`.pr-row[data-arg="${id}"]`)?.scrollIntoView({ block: 'center' }), station.id);
  await B.page.screenshot({ path: `${shotDir}/share-b.png` });
}
for (const [name, x] of [['A', A], ['B', B]]) if (x.errors.length) failures.push(`install ${name} page errors: ${x.errors.join(' | ')}`);
console.log(`install A shared $${PRICE} at ${station.name}; install B row: ${row}`);
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Shared reports: every check passed');
