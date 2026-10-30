// Offline check for the service worker (web/sw.js) in a real browser: after one visit online the offline data
// is kept and the app starts with no network; a deploy (a new service worker with a new cache name) must not
// throw that data away, and the app must then still start with no network, and offer to resume a saved trip.
// Run: node web/tests/layout/offline.layout.mjs   (needs Playwright with Chromium)
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

// `deploy` renames the cache in sw.js, as every release does; `offline` drops every connection.
let deploy = 0, offline = false;
const downloads = {};
const server = http.createServer(async (req, res) => {
  if (offline) { req.socket.destroy(); return; }
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.includes('/Resources/Data/')) downloads[path.basename(pathname)] = (downloads[path.basename(pathname)] ?? 0) + 1;
  // Like GitHub Pages: a folder serves its index.html.
  const file = path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    let body = await readFile(file);
    if (pathname === '/web/sw.js' && deploy) body = String(body).replace(/const CACHE = '([^']+)'/, (m, name) => `const CACHE = '${name}-deploy${deploy}'`);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/`;

const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
const loaded = () => page.waitForFunction(() => window.exitAtlas?.data, null, { timeout: 60000 });
/// Polls an async check in the page (waitForFunction does not wait for a promise) until it is true.
async function until(check, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250)) if (await page.evaluate(check)) return true;
  return false;
}
// Data entries in each cache (the service worker keeps them by path with ?v=hash).
const dataCached = () => page.evaluate(async () => {
  const out = {};
  for (const k of await caches.keys()) {
    out[k] = (await (await caches.open(k)).keys()).filter((r) => r.url.includes('/Resources/Data/')).map((r) => new URL(r.url).pathname.split('/').pop());
  }
  return out;
});
const required = ['states.eab', 'timezones.eab', 'interstates.eax', 'manifest.json'];
const hasAll = (lists) => required.every((n) => Object.values(lists).some((l) => l.includes(n)));

// 1. First visit online. The app registers its service worker only on https; here it is registered as each
//    page starts (localhost counts as secure), as main.js does there. The data starts loading before the new
//    worker controls the page, and must still be kept for offline use without a second visit.
await ctx.addInitScript(() => { navigator.serviceWorker?.register('sw.js'); });
await page.goto(base);
await loaded();
const kept = await until(async () => {
  const names = [];
  for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) names.push(new URL(r.url).pathname.split('/').pop());
  return ['states.eab', 'timezones.eab', 'interstates.eax'].every((n) => names.includes(n));
});
if (!kept) fail('after a first visit the offline data is not kept');
// Kept from what was just loaded: nothing downloads twice (routing here also turns off the browser's HTTP cache).
const twice = Object.entries(downloads).filter(([, n]) => n > 1);
if (twice.length) fail(`downloaded more than once on the first visit: ${twice.map(([f, n]) => `${f} ${n} times`).join(', ')}`);
if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) fail('the service worker does not control the page');
offline = true;
await page.reload().catch((e) => fail(`reload offline after a first visit: ${e.message}`));
if (!(await loaded().then(() => true, () => false))) fail('after a first visit the app does not start offline');
offline = false;
// A second visit online, as most phones have had.
await page.reload();
await loaded();
// A trip in progress, saved as the app saves it (a real GPS trip).
await page.evaluate(() => localStorage.setItem('ea.active', JSON.stringify({
  route: { v: 1, id: 'r1', source: 'osrm', lat: [40.93, 40.80], lon: [-73.89, -73.95], tpd: [0, 15000], tps: [0, 900], steps: [],
    origin: { name: 'Yonkers, NY', coordinate: { lat: 40.93, lon: -73.89 } }, destination: { name: 'Manhattan, NY', coordinate: { lat: 40.8, lon: -73.95 } },
    stops: [], hasTolls: false, createdAt: Date.now(), title: null },
  ledger: { stints: [{ code: 'NY', name: 'New York', meters: 3000, enteredAt: Date.now() / 1000 - 600, exitedAt: null }], startedAt: Date.now() / 1000 - 600 },
  pace: null, startedAt: Date.now() / 1000 - 600, savedAt: Date.now() / 1000, remainingWaypoints: [] })));
const before = await dataCached();
if (!hasAll(before)) fail(`data not cached after the first visit: ${JSON.stringify(before)}`);

// Versions up to exitatlas-v32 kept the datasets in the app cache, which every deploy renamed. Put the data
// where such a version left it, so the deploy below is the upgrade a phone that used the old one goes through.
await page.evaluate(async () => {
  const old = await caches.open('exitatlas-v32');
  for (const name of await caches.keys()) {
    if (name === 'exitatlas-v32') continue;
    const c = await caches.open(name);
    for (const req of await c.keys()) if (req.url.includes('/Resources/Data/')) await old.put(req, await c.match(req));
  }
  await caches.delete('exitatlas-data');
});

// 2. A deploy: the new service worker installs and takes over while the driver is online.
deploy = 1;
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const changed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  await reg.update();
  await changed;
});
// The old app cache is cleaned up after the new worker takes over.
if (!(await until(async () => !(await caches.keys()).includes('exitatlas-v32')))) fail('the old app cache was not removed after a deploy');
const after = await dataCached();
console.log(`caches after a deploy: ${Object.entries(after).map(([k, v]) => `${k} (${v.length} data files)`).join(', ')}`);
if (!hasAll(after)) fail('a deploy threw away the offline data');

// 3. No network at all: the app must still start, with its data, and offer the saved trip.
offline = true;
await page.reload().catch((e) => fail(`reload offline: ${e.message}`));
try {
  await loaded();
  const r = await page.evaluate(() => ({ resume: Boolean(document.querySelector('[data-act="resume"]')), text: document.querySelector('#view')?.textContent ?? '' }));
  if (!r.resume) fail(`no Resume card offline: ${r.text.slice(0, 120)}`);
} catch {
  fail(`the app did not start offline: ${(await page.evaluate(() => document.querySelector('#load-label')?.textContent ?? document.body.textContent).catch(() => '?')).slice(0, 200)}`);
}

// 4. Caches of other apps on the same host (github.io serves every project from one origin) are left alone.
offline = false;
deploy = 2;
await page.evaluate(async () => { await (await caches.open('someone-elses-app')).put('/other.txt', new Response('x')); });
await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const changed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  await reg.update();
  await changed;
});
await until(async () => !(await caches.keys()).some((k) => k.endsWith('-deploy1')));
if (!(await page.evaluate(async () => (await caches.keys()).includes('someone-elses-app')))) fail('a deploy deleted another app\'s cache on the same host');
if (errors.length) fail(`page errors: ${errors.join('; ')}`);

await browser.close();
server.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Offline: every check passed');
