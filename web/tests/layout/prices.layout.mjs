// Check for gas prices (docs/17): in a real browser, at phone sizes and in both themes, with SIMULATED prices
// (?demo&prices): Road Ahead, Fuel lists every station with its price or "Price unavailable"; under Lowest
// price no unknown or old price sorts before a current one; a station beyond the range left says so and sorts
// after every one the range reaches; the cheaper stop note keeps the favorite brand;
// nothing offers Report a price (removed Oct 30, 2026) and Station details link to the consumer price pages in a
// new tab, never in a frame; the price book still refuses a bad price and stores no position; and no paid
// Google request is made even with a Google key stored, because Google Maps prices are off by default.
// Run: node web/tests/layout/prices.layout.mjs   (needs Playwright with Chromium; CI installs it)
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
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/index.html`;

const SIZES = [['phone', 390, 844], ['small phone', 320, 568]];
const failures = [];
const browser = await chromium.launch();
for (const [label, width, height] of SIZES) {
  for (const scheme of ['dark', 'light']) {
    const name = `${label} ${scheme}`;
    const fail = (m) => failures.push(`${name}: ${m}`);
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
    // A Google key stored from before: with Google Maps prices off (the default) it must never be used.
    await ctx.addInitScript(() => { try { localStorage.setItem('ea.googleKey', JSON.stringify('stored-test-key')); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    const errors = [];
    const outside = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route((u) => u.protocol === 'https:', (r) => { outside.push(r.request().url()); r.fulfill({ status: 503, body: '' }); });
    await page.goto(`${base}?demo=120&prices`);
    await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
    await page.waitForTimeout(1200);
    // A gas car with a tank size and a range reading, so a fill can be costed. Overnight Drive Mode off: in its
    // window (00:00 to 04:00 at the stop) only stops with known open hours qualify, so the cheaper stop note and
    // the stations listed would depend on the hour the test runs.
    await page.evaluate(() => {
      const a = window.exitAtlas;
      a.settings.overnightMode = 'off';
      a.profile = { ...a.profile, overnight: { ...a.profile.overnight, mode: 'off' } };
      a.settings.vehicle = { id: 'test', year: 2022, make: 'Test', model: 'Car', label: 'SIMULATED test vehicle', fuel: 'R', city: 28, hwy: 39, comb: 32, tankGallons: 15.8, ev: false };
      a.fuel = { rangeMeters: 140 * 1609.344, drivenAtEntry: a.snapshot.drivenTotal, enteredAt: Date.now() / 1000, source: 'dashboard' };
    });
    const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
    await click('.tabbar [data-arg="ahead"]');
    await page.waitForTimeout(500);
    await click('[data-act="ahead-filter"][data-arg="fuel"]');
    await page.waitForSelector('[data-testid="price-compare"]', { timeout: 20000 });
    // The demo prices the fuel stop pick at the next render after the range is set.
    await page.waitForSelector('[data-testid="cheaper-note"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const fuel = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll('.pr-row')].map((r) => ({ priced: Boolean(r.querySelector('.ptag .pv')), none: Boolean(r.querySelector('.ptag.none')) })),
      sim: /SIMULATED PRICES/.test(document.querySelector('[data-testid="price-compare"]')?.textContent ?? ''),
      unavailable: /Price\s*unavailable/.test(document.querySelector('.ahead')?.textContent ?? ''),
      cheaper: document.querySelector('[data-testid="cheaper-note"]')?.textContent ?? '',
      urgentNote: document.querySelector('.filter-note')?.textContent ?? '',
    }));
    if (fuel.scrollWidth > fuel.width + 1) fail(`Fuel scrolls sideways (${fuel.scrollWidth} > ${fuel.width})`);
    if (fuel.rows.length < 2) fail(`Fuel lists ${fuel.rows.length} stations`);
    if (fuel.rows.some((r) => r.priced === r.none)) fail('a station row shows neither a price nor "Price unavailable"');
    if (!fuel.sim) fail('simulated prices are not labeled as simulated');
    if (!fuel.unavailable) fail('no station says "Price unavailable"');
    if (!/preference stays|favorite brands stay/.test(fuel.cheaper)) fail('the cheaper stop note is missing or does not keep the favorite');
    if (!/Estimate/.test(fuel.cheaper)) fail(`the saving is not labeled as an estimate: ${fuel.cheaper}`);

    await click('[data-act="price-sort"][data-arg="price"]');
    await page.waitForTimeout(300);
    const sorted = await page.evaluate(() => [...document.querySelectorAll('.pr-row .ptag')].map((t) => ({
      kind: t.classList.contains('none') ? 'none' : t.classList.contains('old') ? 'old' : 'current',
      value: Number((t.querySelector('.pv')?.textContent ?? '').replace('$', '')),
    })));
    const firstOther = sorted.findIndex((x) => x.kind !== 'current');
    if (firstOther >= 0 && sorted.slice(firstOther).some((x) => x.kind === 'current')) fail('an unknown or old price sorts before a current one');
    const current = sorted.filter((x) => x.kind === 'current').map((x) => x.value);
    for (let i = 1; i < current.length; i++) if (current[i] < current[i - 1]) fail(`Lowest price is out of order (${current.join(', ')})`);

    // With 20 miles of range and a 100 mile window, stations the range does not reach say so and come after every
    // one it does, even under "Shell first" (a Shell beyond the range never tops the list).
    const shortRange = async (miles, win) => {
      await page.evaluate((m) => { const a = window.exitAtlas; a.fuel = { ...a.fuel, rangeMeters: m * 1609.344, drivenAtEntry: a.snapshot.drivenTotal, enteredAt: Date.now() / 1000 }; }, miles);
      await click(`[data-act="exits-window"][data-arg="${win}"]`);
      await page.waitForTimeout(400);
    };
    const priorWindow = await page.evaluate(() => window.exitAtlas.exitsUI.window);
    await shortRange(20, 100);
    for (const sort of ['brand', 'detour', 'price']) {
      await click(`[data-act="price-sort"][data-arg="${sort}"]`);
      await page.waitForTimeout(300);
      const beyond = await page.evaluate(() => [...document.querySelectorAll('.pr-row')].map((r) => Boolean(r.querySelector('[data-testid="beyond-range"]'))));
      if (!beyond.includes(true)) fail(`${sort}: no station is marked beyond a 20 mile range in a 100 mile window`);
      if (beyond.indexOf(true) >= 0 && beyond.slice(beyond.indexOf(true)).includes(false)) fail(`${sort}: a station beyond the range sorts before one within it`);
    }
    await shortRange(140, priorWindow);

    // No Report a price anywhere; Station details link to the consumer price pages in a new tab.
    const best = await page.evaluate(() => document.querySelectorAll('.best-stop [data-act="report-price"]').length);
    if (best) fail('the recommended stop offers Report a price');
    await click('.pr-row');
    await page.waitForSelector('#sheet.open [data-testid="check-google"]', { timeout: 5000 });
    await page.waitForTimeout(300);
    const station = await page.evaluate(() => ({
      report: document.querySelectorAll('[data-act="report-price"]').length,
      frames: document.querySelectorAll('iframe').length,
      links: [...document.querySelectorAll('#sheet-body a.link-row')].map((a) => ({ target: a.target, rel: a.rel, host: new URL(a.href).host })),
      note: /Consumer webpages, not ExitAtlas data/.test(document.querySelector('#sheet-body')?.textContent ?? ''),
      asks: /report the one you see|add the price you see/i.test(document.body.textContent),
      scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
    }));
    if (station.report) fail('Station details offer Report a price');
    if (station.frames) fail('a page is embedded in an iframe');
    if (!station.links.length || station.links.some((l) => l.target !== '_blank' || !/noopener/.test(l.rel))) fail(`consumer links: ${JSON.stringify(station.links)}`);
    if (station.links[0]?.host !== 'www.google.com') fail(`the first link is not Google Maps: ${JSON.stringify(station.links)}`);
    if (!station.note) fail('the consumer pages are not labeled as such');
    if (station.asks) fail('the app still asks the driver to report a price');
    if (station.scrollWidth > station.width + 1) fail('Station details scroll sideways');
    await click('[data-act="close-sheet"]');
    // The price book (saved reports, still shown until they expire) refuses a bad price and stores no position.
    const book = await page.evaluate(async (id) => {
      const b = window.exitAtlas.priceBook;
      const bad = await b.report({ stationId: id, grade: 'R', price: 31, payment: 'credit', member: false }, {});
      const good = await b.report({ stationId: id, grade: 'R', price: 3.159, payment: 'credit', member: false }, {});
      return { bad: bad.ok, good: good.ok, stored: JSON.parse(localStorage.getItem('ea.priceReports') ?? '[]') };
    }, await page.evaluate(() => document.querySelector('.pr-row')?.dataset.arg));
    if (book.bad) fail('an out of range price was accepted');
    if (!book.good || book.stored.length !== 1 || book.stored[0].price !== 3.159) fail(`the price book did not save the report (${JSON.stringify(book.stored)})`);
    if (book.stored.some((r) => 'lat' in r || 'lon' in r || 'coordinate' in r)) fail('a report stores a position');

    await click('#settings-btn');
    await page.waitForTimeout(400);
    const settings = await page.evaluate(() => ({
      google: document.querySelector('[data-price="google"]')?.checked, shared: document.querySelector('[data-price="community"]')?.checked,
      own: document.querySelector('[data-price="ownReports"]')?.checked, scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
    }));
    if (settings.google !== false) fail('Google Maps prices are not off by default');
    if (settings.shared !== false) fail('shared reports are not off by default');
    if (settings.own !== true) fail('your own reports are not on by default');
    if (settings.scrollWidth > settings.width + 1) fail('Settings scrolls sideways');
    const paid = outside.filter((u) => /googleapis\.com|places/.test(u));
    if (paid.length) fail(`paid Google requests were made: ${paid.join(', ')}`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    console.log(`${failures.some((x) => x.startsWith(name + ':')) ? 'FAIL' : 'ok  '} ${name} (outside requests, all blocked: ${[...new Set(outside.map((u) => new URL(u).host))].join(', ') || 'none'})`);
    await ctx.close();
  }
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Gas prices layout: every check passed');
