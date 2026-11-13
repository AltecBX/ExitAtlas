// The page's Content Security Policy in a real browser: the whole app (every tab, sheets, the map library and its
// worker, the cockpit, the profile export) runs with no policy violation; the Census address lookup still works
// inside its sandboxed frame and a failed lookup is reported at once; an injected inline event handler does NOT run
// (script elements and javascript: links stay open on purpose, see index.html: this policy is a partial guard, the
// app's escaping is the real one); the map credit is the app's own fixed text even when
// the tile style carries a hostile attribution. Fixture servers only (no real network).
// Run: node web/tests/layout/security.layout.mjs   (needs Playwright with Chromium; CI installs it)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/index.html`;
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
const blocked = [];
// (Playwright's service worker block touches navigator.serviceWorker in every frame, which throws inside the
// sandboxed lookup frame: its error, not the app's.)
page.on('pageerror', (e) => { if (!/Service worker is disabled because the context is sandboxed/.test(e.message)) errors.push(e.message); });
page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text().slice(0, 220)); });
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile ?? ''}:${e.lineNumber ?? ''}`));
});
let census = 'ok';
const HOSTILE = '<img onx="" onerror="window.__pwned=1" src=x><iframe srcdoc="<script>parent.__pwned=2</script>"></iframe>';
await page.route((u) => u.protocol === 'https:', (r) => {
  const u = new URL(r.request().url());
  if (u.host === 'geocoding.geo.census.gov') {
    if (census !== 'ok') return r.fulfill({ status: 500, body: '' });
    return r.fulfill({ status: 200, contentType: 'text/javascript', body: `${u.searchParams.get('callback')}(${JSON.stringify({ result: { addressMatches: [{ matchedAddress: '11318 PECKHAM PL, TAMPA, FL, 33625', coordinates: { x: -82.6, y: 28.07 } }] } })})` });
  }
  if (u.host === 'nominatim.openstreetmap.org') return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  // A tile style whose source carries a hostile attribution (as a compromised tile server could send).
  if (u.host === 'tiles.openfreemap.org' && u.pathname.startsWith('/styles/')) {
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 8, sources: { x: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: HOSTILE } },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#223' } }, { id: 'x', type: 'line', source: 'x' }] }) });
  }
  return r.fulfill({ status: 503, body: '' });
});
const click = (act, arg) => page.evaluate(([a, g]) => { const b = document.createElement('button'); b.dataset.act = a; if (g != null) b.dataset.arg = g; document.body.append(b); b.click(); b.remove(); }, [act, arg]);

await page.goto(`${base}?demo=120`);
await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
// The map library, its worker and the style load on the Drive screen.
await page.waitForFunction(() => window.exitAtlas.navMap?.map && document.querySelector('#navmap canvas'), null, { timeout: 20000 }).catch(() => fail('the map did not start under the policy'));
await page.waitForFunction(() => window.exitAtlas.navMap?.ready, null, { timeout: 20000 }).catch(() => fail('the map style did not load under the policy'));
await page.waitForTimeout(1500);
const credit = await page.evaluate(() => document.querySelector('#navmap .maplibregl-ctrl-attrib')?.innerHTML ?? null);
if (!credit || !/OpenFreeMap/.test(credit) || !/OpenStreetMap/.test(credit)) fail(`map credit missing: ${credit}`);
if (/onerror|srcdoc|<img|<iframe/i.test(credit ?? '')) fail(`the tile style's attribution reached the page: ${credit}`);
if (await page.evaluate(() => window.__pwned)) fail('a hostile map attribution ran script');
if ((await page.evaluate(() => [...document.querySelectorAll('#navmap .maplibregl-ctrl-attrib a')].every((a) => a.rel.includes('noopener') && a.target === '_blank'))) !== true) fail('map credit links must open with rel=noopener');

// Every tab and the main sheets.
for (const tab of ['ahead', 'trip', 'settings', 'drive']) { await click('tab', tab); await page.waitForTimeout(500); }
for (const sheet of ['fuel', 'weather']) { await click('sheet', sheet); await page.waitForTimeout(400); await click('close-sheet'); }
await click('cockpit-open'); await page.waitForTimeout(800); await click('ck-close');
await click('car-details'); await page.waitForTimeout(400); await click('close-sheet');

// The Census address lookup under the policy: an address search returns its match first.
await click('add-stop');
await page.waitForSelector('#sheet [data-form="place-search"] input[name="q"]', { timeout: 5000 });
await page.fill('#sheet [data-form="place-search"] input[name="q"]', '11318 Peckham Pl Tampa FL');
let t0 = Date.now();
await page.evaluate(() => document.querySelector('#sheet [data-form="place-search"]').requestSubmit());
await page.waitForFunction(() => /Peckham/i.test(document.querySelector('#sheet-body')?.textContent ?? '') && !window.exitAtlas.placeSearch.busy, null, { timeout: 12000 }).catch(() => {});
const found = await page.evaluate(() => window.exitAtlas.placeSearch.results.map((r) => r.name ?? r.label ?? JSON.stringify(r)).join(' | '));
if (!/Peckham/i.test(found)) fail(`the Census address did not come back under the policy: ${found} (${Date.now() - t0} ms)`);
// A failed Census request is reported at once, not after the 10 s time limit.
census = 'down';
await page.fill('#sheet [data-form="place-search"] input[name="q"]', '500 Main St Tampa FL');
t0 = Date.now();
await page.evaluate(() => document.querySelector('#sheet [data-form="place-search"]').requestSubmit());
await page.waitForFunction(() => !window.exitAtlas.placeSearch.busy, null, { timeout: 15000 }).catch(() => {});
const took = Date.now() - t0;
if (took > 6000) fail(`a failed Census lookup held the search for ${took} ms`);
if ((await page.evaluate(() => document.querySelectorAll('iframe').length)) !== 0) fail('the lookup frame was left in the page');
await click('close-sheet');

// What the policy is for: injected markup with inline event handlers does not run.
await page.evaluate(() => {
  const d = document.createElement('div');
  d.innerHTML = '<img src="x" onerror="window.__injected=1"><svg onload="window.__injected=2"></svg><details open ontoggle="window.__injected=3"></details>';
  document.body.append(d);
});
await page.waitForTimeout(500);
const injected = await page.evaluate(() => window.__injected ?? null);
if (injected !== null) fail(`injected inline script ran (${injected}): the policy is not in force`);
// Those attempts are the only violations: the app itself caused none.
const violations = await page.evaluate(() => window.__csp);
const own = violations.filter((v) => !/script-src-attr/.test(v));
if (own.length) fail(`the app broke its own policy: ${own.join(' || ')}`);
if (violations.length < 2) fail(`the injected markup raised ${violations.length} violations, expected 2 or more`);
const appBlocked = blocked.filter((b) => !/__injected|inline event handler|inline script|javascript:|JavaScript URL/.test(b));
if (appBlocked.length) fail(`blocked by the policy: ${appBlocked.join(' || ')}`);
if (errors.length) fail(`page errors: ${errors.join(' | ')}`);

await browser.close();
server.close();
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('Security policy: every check passed');
