// Offline check for the service worker (web/sw.js) in a real browser:
// - after one visit online the offline data is kept and the app starts with no network;
// - a deploy while online installs the new version's whole set and shows it from the next load, without
//   throwing the offline data away (also when upgrading from the old cache layout);
// - a reload on a stalled connection opens at once from the cache, data and all;
// - a host that has updated only some files does not produce a mixed app: index.html, its scripts and its
//   styles always come from one version;
// - with no network the app starts and offers to resume a saved trip, and other apps' caches are left alone.
// Run: node web/tests/layout/offline.layout.mjs   (needs Playwright with Chromium)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { appFiles, appHash, withHash } from '../swhash.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

// Build n of the app: the repo as is for 0; from 1 on, the page, one module and the styles each carry the build
// number (what the page shows of it is read back below), and sw.js has the matching APP_HASH, as a deploy would.
function variant(rel, bytes, n) {
  if (!n) return bytes;
  if (rel === 'web/index.html') return Buffer.from(String(bytes).replace('<head>', `<head>\n<meta name="ea-build" content="${n}">`));
  if (rel === 'web/js/app/format.js') return Buffer.concat([bytes, Buffer.from(`\nglobalThis.eaBuild = ${n};\n`)]);
  if (rel === 'web/css/app.css') return Buffer.concat([bytes, Buffer.from(`\n:root { --ea-build: "${n}"; }\n`)]);
  return bytes;
}
const swText = readFileSync(path.join(root, 'web/sw.js'), 'utf8');
const hashOf = (n) => appHash(appFiles(swText), (f) => variant(`web/${f === './' ? 'index.html' : f}`, readFileSync(path.join(root, 'web', f === './' ? 'index.html' : f)), n));
const cacheOf = (n) => `exitatlas-v34-${hashOf(n).slice(0, 12)}`;

// `build`: what the host serves; `stale`: a file the host still serves from the build before; `offline` drops
// every connection; `stall` accepts requests and never answers (a weak signal).
let build = 0, stale = null, offline = false, stall = false;
const downloads = {};
const stalled = [];
const server = http.createServer(async (req, res) => {
  if (offline) { req.socket.destroy(); return; }
  if (stall) { stalled.push(res); return; }
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.includes('/Resources/Data/')) downloads[path.basename(pathname)] = (downloads[path.basename(pathname)] ?? 0) + 1;
  // Like GitHub Pages: a folder serves its index.html.
  const rel = (pathname.endsWith('/') ? `${pathname}index.html` : pathname).slice(1);
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    let body = await readFile(file);
    if (rel === 'web/sw.js') body = build ? withHash(String(body), hashOf(build)) : body;
    else body = variant(rel, body, rel === stale ? build - 1 : build);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/`;

const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const check = (ok, m) => { if (!ok) fail(m); else console.log(`ok   ${m}`); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
const loaded = (ms = 60000) => page.waitForFunction(() => window.exitAtlas?.data, null, { timeout: ms });
/// Polls an async check in the page (waitForFunction does not wait for a promise) until it is true.
async function until(check, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250)) if (await page.evaluate(check)) return true;
  return false;
}
/// Which build the running page got its page, script and styles from.
const shown = () => page.evaluate(() => ({
  html: Number(document.querySelector('meta[name="ea-build"]')?.content ?? 0),
  js: globalThis.eaBuild ?? 0,
  css: Number(getComputedStyle(document.documentElement).getPropertyValue('--ea-build').replace(/"/g, '').trim() || 0),
}));
const one = (v, n) => v.html === n && v.js === n && v.css === n;
const str = (v) => `page ${v.html}, script ${v.js}, styles ${v.css}`;
/// Asks the browser to look for a new worker (as each visit does) and waits until that attempt is over.
const update = () => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const before = navigator.serviceWorker.controller;
  await reg.update().catch(() => {});
  for (let i = 0; i < 120 && reg.installing; i++) await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 20 && navigator.serviceWorker.controller === before; i++) await new Promise((r) => setTimeout(r, 250));
  return navigator.serviceWorker.controller !== before;
});
const appCaches = () => page.evaluate(async () => (await caches.keys()).filter((k) => /^exitatlas-v\d+-/.test(k)));
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
check(kept, 'after a first visit the offline data is kept');
// Kept from what was just loaded: nothing downloads twice (routing here also turns off the browser's HTTP cache).
const twice = Object.entries(downloads).filter(([, n]) => n > 1);
check(!twice.length, `nothing downloaded twice on the first visit${twice.length ? `: ${twice.map(([f, n]) => `${f} ${n} times`).join(', ')}` : ''}`);
// The worker fetches and checks its whole set before it takes over.
check(await until(() => Boolean(navigator.serviceWorker.controller), 30000), 'the service worker controls the page once its set is in');
check((await appCaches()).join() === cacheOf(0), `this version's files are in its own cache (${(await appCaches()).join()})`);
offline = true;
await page.reload().catch((e) => fail(`reload offline after a first visit: ${e.message}`));
check(await loaded().then(() => true, () => false), 'after a first visit the app starts offline');
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
check(hasAll(await dataCached()), 'the data is cached after the second visit');

// The caches the versions before this one left, so the deploy below is the upgrade a phone goes through:
// exitatlas-v33 (the live version) kept its app files in a cache of that name and the datasets in exitatlas-data;
// up to exitatlas-v32 the datasets sat in the app cache, which every deploy renamed. Both are set up here: the
// app files in exitatlas-v33, two datasets moved to exitatlas-v32, the rest left in exitatlas-data.
await page.evaluate(async () => {
  const v33 = await caches.open('exitatlas-v33');
  const v32 = await caches.open('exitatlas-v32');
  const data = await caches.open('exitatlas-data');
  for (const name of (await caches.keys()).filter((k) => /^exitatlas-v34-/.test(k))) {
    const c = await caches.open(name);
    for (const req of await c.keys()) await v33.put(req, await c.match(req));
  }
  for (const req of await data.keys()) {
    if (!/\/(states|timezones)\.eab$/.test(new URL(req.url).pathname)) continue;
    await v32.put(req, await data.match(req));
    await data.delete(req);
  }
});

// 2. A deploy while online: the new worker installs its whole set and takes over; the page in use keeps its
//    version, and the next load shows the new one, all of it.
build = 1;
check(await update(), 'a deploy installs the new version');
check(await until(async () => !(await caches.keys()).some((k) => k === 'exitatlas-v32' || k === 'exitatlas-v33')), 'the caches of the versions before are removed after a deploy');
check(hasAll(await dataCached()), 'a deploy keeps the offline data');
check(one(await shown(), 0), `the page in use keeps its version until the next load (${str(await shown())})`);
await page.reload();
await loaded();
check(one(await shown(), 1), `the next load shows the new version, all of it (${str(await shown())})`);
check((await appCaches()).join() === cacheOf(1), `only the new version's cache is left (${(await appCaches()).join()})`);

// 3. A weak signal: every request is accepted and never answered. The app opens from the cache at once, with
//    its data, and offers the saved trip.
stall = true;
let t0 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch((e) => fail(`reload on a stalled connection: ${e.message}`));
const pageAt = await page.waitForFunction(() => window.exitAtlas, null, { timeout: 10000 }).then(() => Date.now() - t0, () => null);
const dataAt = await loaded(15000).then(() => Date.now() - t0, () => null);
check(pageAt !== null && pageAt < 3000, `on a stalled connection the app opens from the cache (${pageAt} ms)`);
check(dataAt !== null && dataAt < 8000, `and its data loads (${dataAt} ms)`);
check(await page.evaluate(() => Boolean(document.querySelector('[data-act="resume"]'))), 'and the saved trip can be resumed');
check(one(await shown(), 1), `still one version (${str(await shown())})`);
stall = false;
for (const r of stalled.splice(0)) r.destroy();

// 4. A host that has updated all but one file: the new set does not match its version, so it is not installed.
//    The app stays on the version before, whole, never a newer page with older scripts.
build = 2;
stale = 'web/js/app/format.js';
check(!(await update()), 'a half updated host does not install a new version');
await page.reload();
await loaded();
check(one(await shown(), 1), `the app stays on one version (${str(await shown())})`);
// The host catches up: the next visit installs it.
stale = null;
check(await update(), 'once the host has every file, the new version installs');
await page.reload();
await loaded();
check(one(await shown(), 2), `and shows whole (${str(await shown())})`);

// 5. No network at all: the app starts, with its data, and offers the saved trip.
offline = true;
await page.reload().catch((e) => fail(`reload offline: ${e.message}`));
const startedOffline = await loaded().then(() => true, () => false);
check(startedOffline && await page.evaluate(() => Boolean(document.querySelector('[data-act="resume"]'))), 'with no network the app starts and offers the saved trip');
check(one(await shown(), 2), `offline, still one version (${str(await shown())})`);

// 6. Caches of other apps on the same host (github.io serves every project from one origin) are left alone.
offline = false;
build = 3;
await page.evaluate(async () => { await (await caches.open('someone-elses-app')).put('/other.txt', new Response('x')); });
check(await update(), 'another deploy installs');
await until(async () => (await caches.keys()).filter((k) => /^exitatlas-v\d+-/.test(k)).length === 1, 5000);
check(await page.evaluate(async () => (await caches.keys()).includes('someone-elses-app')), 'a deploy leaves another app\'s cache alone');
check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);

await browser.close();
server.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Offline: every check passed');
