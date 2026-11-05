// Weather ahead on the route, in a real browser at phone sizes, light and dark, in both Drive presentations:
// the National Weather Service answers recorded on I-95 (web/tests/fixtures/weatherahead) served for the
// simulated drive near Jacksonville with the browser clock at 5:15 AM Eastern on Nov 5, 2026 (an hour the
// recording covers, with fog forecast from 5 to 7 AM). Checks the warning in the weather pill (it fits the top
// bar), the Road Ahead row, the weather sheet, and, with the forecasts failing, "Weather ahead unavailable"
// and no warning, never "no rain".
// Each /points request gets the recorded point nearest in latitude; a station list or observation gets the
// recorded Jacksonville ones (Tests/ExitAtlasCoreTests/Fixtures/weather; too old to be current, so the pill shows
// this hour's forecast temperature).
// Run: node web/tests/layout/weatherahead.layout.mjs [--shots <dir>]   (needs Playwright with Chromium)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIX = path.join(root, 'web/tests/fixtures/weatherahead');
const WX = path.join(root, 'Tests/ExitAtlasCoreTests/Fixtures/weather');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
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

const CITIES = { fl: 30.33, ga: 31.15, sc: 32.90, nc: 34.62, va: 36.69 };
const text = (dir, name) => readFileSync(path.join(dir, name), 'utf8');
const HOURLY = Object.fromEntries(Object.keys(CITIES).map((k) => [JSON.parse(text(FIX, `points_${k}.json`)).properties.forecastHourly, k]));

/// The recorded NWS answers, or 500 for forecasts when `failForecasts`. Everything else on https: 503 (offline map).
async function serve(page, { failForecasts = false } = {}) {
  await page.route((u) => u.protocol === 'https:', (r) => {
    const url = r.request().url();
    const geo = (body) => r.fulfill({ status: 200, headers: { 'content-type': 'application/geo+json', 'access-control-allow-origin': '*' }, body });
    const pts = /api\.weather\.gov\/points\/(-?[\d.]+),(-?[\d.]+)$/.exec(url);
    if (pts) {
      const lat = Number(pts[1]);
      const k = Object.keys(CITIES).sort((a, b) => Math.abs(CITIES[a] - lat) - Math.abs(CITIES[b] - lat))[0];
      return geo(text(FIX, `points_${k}.json`));
    }
    if (HOURLY[url]) return failForecasts ? r.fulfill({ status: 500, body: '' }) : geo(text(FIX, `hourly_${HOURLY[url]}.json`));
    if (/api\.weather\.gov\/gridpoints\/[^/]+\/[\d,]+\/stations/.test(url)) return geo(text(WX, 'stations.json'));
    if (/api\.weather\.gov\/stations\/KNIP\/observations\/latest/.test(url)) return geo(text(WX, 'obs_KNIP.json'));
    if (/api\.weather\.gov\/stations\/KCRG\/observations\/latest/.test(url)) return geo(text(WX, 'obs_KCRG.json'));
    return r.fulfill({ status: 503, body: '' });
  });
}

const failures = [];
const browser = await chromium.launch();
// The last size uses a wide system font (DejaVu Sans, as on a Linux runner) with the phone's text size, so the
// pill's shorter forms are checked: the top bar takes the system font, which sets how much room the warning has.
const SIZES = [['phone', 390, 844], ['small phone', 375, 667], ['wide font phone', 390, 844, 'body { font-family: "DejaVu Sans", sans-serif !important; }']];
const IOS_TEXT = 'html { font-size: 17px !important; }';

async function open(width, height, scheme, opts = {}, css = '') {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((css) => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }), IOS_TEXT + css);
  // 5:15 AM Eastern, Nov 5 2026: within the recording, during the 5 to 7 AM fog forecast for Jacksonville and Brunswick.
  await page.clock.install({ time: new Date('2026-11-05T10:15:00Z') });
  await serve(page, opts);
  // Mile 345 of the sample route (Miami to Manhattan), on I-95 just south of Jacksonville.
  await page.goto(`${base}?demo=345`);
  await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
  return { ctx, page, errors };
}

for (const [label, width, height, css = ''] of SIZES) {
  for (const scheme of ['light', 'dark']) {
    for (const presentation of ['map', 'focus']) {
      const name = `${label} ${scheme} ${presentation}`;
      const fail = (m) => failures.push(`${name}: ${m}`);
      const { ctx, page, errors } = await open(width, height, scheme, {}, css);
      if (presentation === 'focus') await page.evaluate(() => document.querySelector('[data-act="drive-view"][data-arg="focus"]').click());
      // The forecast points are looked up one at a time, a quarter second apart.
      await page.waitForFunction(() => document.querySelector('#weather .wx-pill.has-ahead'), null, { timeout: 45000 }).catch(() => {});
      const pill = await page.evaluate(() => {
        const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        const p = document.querySelector('#weather .wx-pill');
        const t = document.querySelector('#weather .wx-ahead-t');
        return { html: Boolean(p), ahead: Boolean(p?.classList.contains('has-ahead')), text: t?.textContent.trim() ?? '', label: p?.getAttribute('aria-label') ?? '',
          pill: box(p), status: box(document.querySelector('#status .pill')), end: box(document.querySelector('#end')),
          truncated: t ? t.scrollWidth > t.clientWidth + 1 : null, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
      });
      if (!pill.ahead) fail(`no weather warning in the pill (${JSON.stringify(pill)})`);
      else {
        // The whole warning where it fits; a narrow bar or a wide font gets "Fog now", "Fog ahead" or "Fog".
        if (!/^Fog( (in [\d.]+ mi|next [\d.]+ mi|now|ahead))?$/.test(pill.text)) fail(`pill says "${pill.text}"`);
        if (!/National Weather Service forecast/.test(pill.label)) fail(`pill label does not name the NWS forecast: ${pill.label}`);
        if (pill.truncated) fail(`the warning is cut off: "${pill.text}" ${JSON.stringify(pill)}`);
        const hit = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        if (hit(pill.pill, pill.status) || hit(pill.pill, pill.end)) fail(`the pill overlaps the top bar controls ${JSON.stringify(pill)}`);
      }
      if (pill.scrollWidth > pill.width + 1) fail(`scrolls sideways (${pill.scrollWidth} > ${pill.width})`);
      if (SHOTS && presentation === 'map' && label === 'phone') await page.screenshot({ path: path.join(SHOTS, `drive-${scheme}.png`) });
      if (SHOTS && presentation === 'focus' && label === 'phone') await page.screenshot({ path: path.join(SHOTS, `focus-${scheme}.png`) });

      if (presentation === 'map') {
        // Road Ahead: the fog row, amber, with the arrival time and the NWS forecast named.
        await page.evaluate(() => document.querySelector('.tabbar [data-arg="ahead"]').click());
        await page.waitForSelector('.tl-wx', { timeout: 15000 }).catch(() => {});
        const row = await page.evaluate(() => {
          const r = document.querySelector('.tl-wx.warn');
          return r ? { text: r.textContent.replace(/\s+/g, ' ').trim(), width: r.getBoundingClientRect().width } : null;
        });
        if (!row) fail('no weather warning row in Road Ahead');
        else if (!/Fog/.test(row.text) || !/arriving about \d{1,2}:\d{2} [AP]M/.test(row.text) || !/NWS forecast/.test(row.text)) fail(`Road Ahead row: ${row.text}`);
        if (SHOTS && label === 'phone') {
          await page.evaluate(() => document.querySelector('.tl-wx')?.scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(SHOTS, `ahead-${scheme}.png`) });
        }
        // The sheet: the warning first, where, how long, when, and what the forecast is (and is not).
        await page.evaluate(() => document.querySelector('.tl-wx.warn button, button.tl-card.wx.warn')?.click());
        await page.waitForSelector('#sheet.open .wx-ahead-list', { timeout: 10000 }).catch(() => {});
        const sheet = await page.evaluate(() => {
          const b = document.querySelector('#sheet-body');
          return b ? { text: b.textContent.replace(/\s+/g, ' ').trim(), warn: b.querySelectorAll('.wx-ah-row.warn').length, first: b.querySelector('.section-title')?.textContent ?? '' } : null;
        });
        if (!sheet || !sheet.warn) fail(`the weather sheet lists no warning: ${sheet?.text.slice(0, 200)}`);
        else {
          if (sheet.first !== 'Ahead on your route') fail(`the warning is not first in the sheet (${sheet.first})`);
          for (const want of [/Fog/, /arriving about/, /National Weather Service hourly forecast/, /not radar/, /NWS updated the forecast/]) if (!want.test(sheet.text)) fail(`sheet lacks ${want}`);
        }
        if (SHOTS && label === 'phone') { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, `sheet-${scheme}.png`) }); }
      }
      if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
      console.log(`${failures.some((f) => f.startsWith(name)) ? 'FAIL' : 'ok  '} ${name}`);
      await ctx.close();
    }
  }
}

// The forecasts fail: no warning anywhere, "Weather ahead unavailable" in Road Ahead and the sheet, never "no rain".
{
  const name = 'forecasts failing';
  const fail = (m) => failures.push(`${name}: ${m}`);
  const { ctx, page, errors } = await open(390, 844, 'light', { failForecasts: true });
  await page.evaluate(() => document.querySelector('.tabbar [data-arg="ahead"]').click());
  await page.waitForSelector('.tl-wx.unavail', { timeout: 45000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    unavailable: [...document.querySelectorAll('.tl-wx.unavail')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    warn: document.querySelectorAll('.tl-wx.warn').length,
  }));
  if (!r.unavailable.length || !/Weather ahead unavailable/.test(r.unavailable[0])) fail(`no "Weather ahead unavailable" row (${JSON.stringify(r)})`);
  if (r.warn) fail('a warning shows without a forecast');
  await page.evaluate(() => document.querySelector('.tabbar [data-arg="drive"]').click());
  await page.waitForTimeout(500);
  if (await page.evaluate(() => Boolean(document.querySelector('#weather .wx-pill.has-ahead')))) fail('the pill shows a warning without a forecast');
  await page.evaluate(() => document.querySelector('.tabbar [data-arg="ahead"]').click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('.tl-wx.unavail .tl-card, button.tl-card.wx.unavail')?.click());
  await page.waitForSelector('#sheet.open .wx-ahead-list', { timeout: 10000 }).catch(() => {});
  const sheet = await page.evaluate(() => document.querySelector('#sheet-body')?.textContent.replace(/\s+/g, ' ') ?? '');
  if (!/Weather ahead unavailable/.test(sheet)) fail(`the sheet does not say unavailable: ${sheet.slice(0, 200)}`);
  if (/No rain, storms/.test(sheet)) fail('the sheet says no rain without a forecast');
  if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, 'sheet-unavailable.png') }); }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  console.log(`${failures.some((f) => f.startsWith(name)) ? 'FAIL' : 'ok  '} ${name}`);
  await ctx.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Weather ahead: every check passed');
