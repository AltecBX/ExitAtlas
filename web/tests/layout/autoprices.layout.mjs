// Google Maps prices without a tap (docs/17), in a real browser with Google's API answered by a TEST
// FIXTURE (made up prices, never a real Google response; this proves the app's behavior, not that a live
// feed exists): with Google Maps prices off, nothing is ever asked; turned on, the Drive screen asks nothing
// (Google prices never go on a non-Google map), Road Ahead, Fuel looks up at most 4 exits by itself, shows
// their prices as Google Maps prices in Compare Prices and SmartStop's pick, does not ask again while they are
// fresh, and stops at the daily budget.
// Run: node web/tests/layout/autoprices.layout.mjs   (needs Playwright with Chromium; CI installs it)
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

const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' });
await ctx.addInitScript(() => { try { localStorage.setItem('ea.googleKey', JSON.stringify('TEST-KEY-not-real')); } catch { /* ignore */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Google's answer: TEST prices for the gas stations mapped at the exit nearest the request, at their own spot.
let exitsData = [];
const asked = [];
await page.route((u) => u.protocol === 'https:', async (r) => {
  const url = r.request().url();
  if (!url.startsWith('https://places.googleapis.com/')) { r.fulfill({ status: 503, body: '' }); return; }
  const body = JSON.parse(r.request().postData() ?? '{}');
  const c = body.locationRestriction?.circle?.center ?? {};
  asked.push(`${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`);
  const near = exitsData.reduce((best, e) => {
    const d = Math.hypot(e.lat - c.latitude, e.lon - c.longitude);
    return !best || d < best.d ? { e, d } : best;
  }, null)?.e;
  const places = (near?.gas ?? []).map((g, i) => ({
    id: `test-${g.id}`, displayName: { text: g.name }, location: { latitude: g.lat, longitude: g.lon },
    fuelOptions: { fuelPrices: [{ type: 'REGULAR_UNLEADED', price: { currencyCode: 'USD', units: '3', nanos: (411 + 10 * i) * 1e6 }, updateTime: new Date(Date.now() - 40 * 60000).toISOString() }] },
  }));
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ places }) });
});

await page.goto(`${base}?demo=120`);
await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const a = window.exitAtlas;
  a.settings.vehicle = { id: 'test', year: 2022, make: 'Test', model: 'Car', label: 'SIMULATED test vehicle', fuel: 'R', city: 28, hwy: 39, comb: 32, tankGallons: 15.8, ev: false };
  a.fuel = { rangeMeters: 140 * 1609.344, drivenAtEntry: a.snapshot.drivenTotal, enteredAt: Date.now() / 1000, source: 'dashboard' };
});
exitsData = await page.evaluate(() => {
  const a = window.exitAtlas;
  return a.plan.exits.map((e) => ({
    lat: e.coordinate.lat, lon: e.coordinate.lon,
    gas: a.servicesFor(e).filter((x) => x.place.category === 1).map((x) => ({ id: x.place.id, name: x.place.brand ?? x.place.name ?? 'Gas', lat: x.place.coordinate.lat, lon: x.place.coordinate.lon })),
  })).filter((e) => e.gas.length);
});
const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

// 1. Off (the default): Road Ahead, Fuel asks Google nothing, even with a key stored.
await click('.tabbar [data-arg="ahead"]');
await page.waitForTimeout(400);
await click('[data-act="ahead-filter"][data-arg="fuel"]');
await page.waitForTimeout(4000);
if (asked.length) fail(`Google was asked ${asked.length} times with Google Maps prices off`);

// 2. On, on the Drive screen: still nothing.
await page.evaluate(() => { const a = window.exitAtlas; a.settings.prices = { ...(a.settings.prices ?? {}), google: true }; });
await click('.tabbar [data-arg="drive"]');
await page.waitForTimeout(4000);
if (asked.length) fail(`the Drive screen asked Google ${asked.length} times`);

// 3. Road Ahead, Fuel: up to 4 exits by themselves, shown as Google Maps prices.
await click('.tabbar [data-arg="ahead"]');
await page.waitForTimeout(400);
await click('[data-act="ahead-filter"][data-arg="fuel"]');
await page.waitForFunction(() => document.querySelectorAll('.pr-row .ptag .pv').length > 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);
const first = asked.length;
const view = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.pr-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
  attrib: document.querySelector('.ahead')?.textContent.includes('Google Maps') ?? false,
  today: window.exitAtlas.priceCallsToday(),
}));
const priced = view.rows.filter((t) => /\$3\.\d{3}/.test(t));
if (first < 1 || first > 4) fail(`Road Ahead, Fuel asked Google ${first} times (1 to 4 expected)`);
if (!priced.length) fail('no Google price shows in Compare Prices');
if (!priced.every((t) => /Google/.test(t))) fail(`a Google price is not labeled with its source: ${priced.find((t) => !/Google/.test(t))}`);
if (view.rows.some((t) => !/\$\d\.\d{3}|Price unavailable|Price\s*unavailable/.test(t))) fail('a row shows neither a price nor "Price unavailable"');
if (view.today !== first) fail(`the daily counter says ${view.today}, ${first} requests were made`);

// 4. Fresh answers are not asked again.
await click('[data-act="ahead-filter"][data-arg="all"]');
await page.waitForTimeout(300);
await click('[data-act="ahead-filter"][data-arg="fuel"]');
await page.waitForTimeout(4000);
if (asked.length !== first) fail(`fresh exits were asked again (${asked.length - first} more)`);

// 5. The fuel stop sheet: SmartStop's pick uses a Google price when its exit was looked up.
await click('.tabbar [data-arg="drive"]');
await page.waitForTimeout(300);
await click('.card[data-act="sheet"][data-arg="fuel"]');
await page.waitForSelector('#sheet.open', { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(3000);
const sheet = await page.evaluate(() => document.querySelector('#sheet-body')?.textContent.replace(/\s+/g, ' ') ?? '');
if (asked.length > 8) fail(`the fuel stop sheet pushed the requests to ${asked.length}`);
if (/\$3\.\d{3}/.test(sheet) && !/Google/.test(sheet)) fail('the fuel stop sheet shows a Google price without its source');
await click('[data-act="close-sheet"]');

// 6. The daily budget: with 24 used today, nothing more is asked by itself.
await page.evaluate(() => { const a = window.exitAtlas; a.prices.cache.clear(); localStorage.setItem('ea.priceCallsDay', JSON.stringify({ day: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now()), n: 24 })); });
const before = asked.length;
await click('.tabbar [data-arg="ahead"]');
await page.waitForTimeout(300);
await click('[data-act="ahead-filter"][data-arg="all"]');
await page.waitForTimeout(300);
await click('[data-act="ahead-filter"][data-arg="fuel"]');
await page.waitForTimeout(4000);
if (asked.length !== before) fail(`Google was asked ${asked.length - before} more times past the daily budget`);
if (errors.length) fail(`page errors: ${errors.join(' | ')}`);

if (process.env.SHOTS) {
  await page.evaluate(() => { const a = window.exitAtlas; localStorage.setItem('ea.priceCallsDay', JSON.stringify({ day: '2000-01-01', n: 0 })); a.prices.cache.clear(); });
  await click('[data-act="ahead-filter"][data-arg="all"]');
  await page.waitForTimeout(300);
  await click('[data-act="ahead-filter"][data-arg="fuel"]');
  await page.waitForTimeout(4000);
  await page.evaluate(() => document.querySelector('[data-testid="price-compare"]')?.scrollIntoView());
  await page.screenshot({ path: path.join(process.env.SHOTS, 'auto-compare.png') });
}
await browser.close();
server.close();
console.log(`Google asked ${first} times on Road Ahead, Fuel; ${priced.length} rows priced; ${asked.length} requests in all (TEST FIXTURE prices)`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Automatic Google prices: every check passed');
