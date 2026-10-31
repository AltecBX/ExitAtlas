// The Navigation View map keeps following the vehicle, in a real browser with touch: panning it stops following
// and shows the recenter button; left alone 12 s it follows again, gliding back to the vehicle (no jump); a map that stops drawing (frozen frames, or a
// lost WebGL context, which iOS Safari can take away) is replaced by a new one on the vehicle; and a normal drive
// never replaces it. Also the simulated drive's speed button: 30, 60, 90 and 120 times, then 30 again.
// Run: node web/tests/layout/navmap.layout.mjs   (needs Playwright with Chromium; CI installs it)
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
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Offline (no tiles): the route and the vehicle still draw on the plain background.
await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
await page.goto(`${base}?demo=120`);
await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
await page.evaluate(() => document.querySelector('[data-act="drive-view"][data-arg="map"]')?.click());
await page.waitForFunction(() => window.exitAtlas.navMap?.ready, null, { timeout: 60000 });
await page.waitForTimeout(3000);

// Where things are: is the vehicle inside the map's open area (below the guidance, above the bottom panel)?
const state = () => page.evaluate(() => {
  const m = window.exitAtlas.navMap;
  const puck = document.querySelector('.nav-marker.you')?.getBoundingClientRect();
  const top = document.querySelector('.nav-top')?.getBoundingClientRect().bottom ?? 0;
  const bottom = document.querySelector('.nav-bottom')?.getBoundingClientRect().top ?? innerHeight;
  const cx = puck ? puck.x + puck.width / 2 : null, cy = puck ? puck.y + puck.height / 2 : null;
  return { following: m.following, ready: m.ready, failed: m.failed, rebuilds: m.rebuiltAt?.length ?? 0,
    button: Boolean(document.querySelector('[data-act="nav-recenter"]')),
    onScreen: puck ? cx > 0 && cx < innerWidth && cy > top && cy < bottom : false, puck: puck ? [Math.round(cx), Math.round(cy)] : null };
});
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
// A pan in the map's open area (between the speed and the bottom panel, left of the buttons), which the card at
// the bottom can make shorter.
const pan = async () => {
  const [x, y] = await page.evaluate(() => {
    const top = document.querySelector('.nav-left').getBoundingClientRect().bottom;
    const bottom = document.querySelector('.nav-bottom').getBoundingClientRect().top;
    return [Math.round(innerWidth * 0.4), Math.round(top + (bottom - top) * 0.75)];
  });
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [[x + i * 6, y - i * 12]]); await page.waitForTimeout(16); }
  await touch('touchEnd', []);
  await page.waitForTimeout(600);
};

let s = await state();
if (!s.following || !s.onScreen) fail(`before any touch: not following the vehicle (${JSON.stringify(s)})`);
// Where the vehicle sits on screen while followed.
const home = s.puck;
// The vehicle's distance on screen from that spot, every 100 ms for `ms`: [ms since start, px].
const track = (ms) => page.evaluate(async (args) => {
  const [hx, hy, span] = args;
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < span) {
    const b = document.querySelector('.nav-marker.you')?.getBoundingClientRect();
    out.push([Math.round(performance.now() - t0), b ? Math.round(Math.hypot(b.x + b.width / 2 - hx, b.y + b.height / 2 - hy)) : 9999]);
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}, [home[0], home[1], ms]);
// How long the vehicle took to come back: from the first sample clearly on the way to the first within 30 px.
const glide = (samples) => {
  const d0 = samples[0][1];
  const startAt = samples.find(([, d]) => d < d0 * 0.9)?.[0];
  const endAt = samples.find(([, d]) => d < 30)?.[0];
  return startAt === undefined || endAt === undefined ? null : endAt - startAt;
};

// 1. A pan stops following and shows the recenter button; the vehicle drives off the screen.
await pan();
s = await state();
if (s.following) fail('a pan did not stop following');
if (!s.button) fail(`no recenter button after a pan (${JSON.stringify(s)})`);

// 1b. So does a two finger pinch (zoom), after the recenter button.
await page.evaluate(() => document.querySelector('[data-act="nav-recenter"]')?.click());
await page.waitForTimeout(2000);
{
  const [x, y] = await page.evaluate(() => {
    const top = document.querySelector('.nav-left').getBoundingClientRect().bottom;
    const bottom = document.querySelector('.nav-bottom').getBoundingClientRect().top;
    return [Math.round(innerWidth * 0.4), Math.round((top + bottom) / 2)];
  });
  await touch('touchStart', [[x - 30, y - 30], [x + 30, y + 30]]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [[x - 30 - i * 5, y - 30 - i * 5], [x + 30 + i * 5, y + 30 + i * 5]]); await page.waitForTimeout(16); }
  await touch('touchEnd', []);
  await page.waitForTimeout(600);
}
s = await state();
if (s.following || !s.button) fail(`a pinch did not stop following (${JSON.stringify(s)})`);

// 2. The recenter button follows again at once, the camera gliding back to the vehicle.
await page.evaluate(() => document.querySelector('[data-act="nav-recenter"]')?.click());
let back = await track(2500);
let took = glide(back);
s = await state();
if (!s.following || s.button || !s.onScreen) fail(`the recenter button did not bring the vehicle back (${JSON.stringify(s)})`);
if (took === null || took < 800) fail(`the recenter button jumped back instead of gliding (${took} ms; ${JSON.stringify(back)})`);

// 3. Left alone 12 s after a pan, the map follows again by itself, gliding back, and the button goes.
await pan();
await page.waitForTimeout(8000);
s = await state();
if (s.following) fail(`the map followed again 8 s after a pan (12 s expected) ${JSON.stringify(s)}`);
await page.waitForTimeout(3200);
back = await track(3500);
took = glide(back);
s = await state();
if (!s.following || s.button || !s.onScreen) fail(`the map did not follow again 12 s after a pan (${JSON.stringify(s)})`);
if (took === null || took < 800) fail(`the map jumped back to the vehicle instead of gliding (${took} ms; ${JSON.stringify(back)})`);
if (s.rebuilds) fail(`a normal drive replaced the map ${s.rebuilds} times`);

// 4. Frozen: the map draws no more frames (its camera stops too) while the trip goes on. A new map takes over.
const first = await page.evaluate(() => { const m = window.exitAtlas.navMap.map; window.__old = m; m._render = () => m; return true; });
await page.waitForTimeout(9000);
s = await state();
const replaced = await page.evaluate(() => window.exitAtlas.navMap.map !== window.__old);
if (!first || !replaced || s.rebuilds !== 1) fail(`a frozen map was not replaced (${JSON.stringify(s)})`);
if (!s.ready || !s.following || !s.onScreen) fail(`after a frozen map, the new map does not show the vehicle (${JSON.stringify(s)})`);

// 5. The WebGL context lost, and not given back: a new map.
await page.evaluate(() => {
  const m = window.exitAtlas.navMap.map;
  window.__old = m;
  m.painter.context.gl.getExtension('WEBGL_lose_context').loseContext();
});
await page.waitForTimeout(6000);
s = await state();
const replaced2 = await page.evaluate(() => window.exitAtlas.navMap.map !== window.__old);
if (!replaced2 || s.rebuilds !== 2) fail(`a map that lost its WebGL context was not replaced (${JSON.stringify(s)})`);
if (!s.ready || !s.following || !s.onScreen || s.failed) fail(`after a lost context, the new map does not show the vehicle (${JSON.stringify(s)})`);

// 6. The new map keeps following as the trip goes on, without being replaced again.
await page.waitForTimeout(6000);
s = await state();
if (!s.onScreen || s.rebuilds !== 2) fail(`the new map stopped following or was replaced again (${JSON.stringify(s)})`);

// 7. The simulated drive's speed button: each tap the next of 30, 60, 90 and 120 times, then 30 again.
const speeds = [];
for (let i = 0; i < 5; i++) {
  speeds.push(await page.evaluate(() => [window.exitAtlas.sim.speedup, document.querySelector('[data-act="sim-speed"]').textContent.trim(), document.querySelector('#banner').textContent]));
  await page.evaluate(() => document.querySelector('[data-act="sim-speed"]').click());
  await page.waitForTimeout(300);
}
const want = [[30, '60×'], [60, '90×'], [90, '120×'], [120, '30×'], [30, '60×']];
if (speeds.some(([v, b], i) => v !== want[i][0] || b !== want[i][1])) fail(`speed button: ${JSON.stringify(speeds.map(([v, b]) => [v, b]))}, expected ${JSON.stringify(want)}`);
if (speeds.some(([v, , t]) => !t.includes(`Simulated drive at ${v}×`))) fail(`the banner does not say the speed: ${speeds.map(([, , t]) => t.trim()).join(' | ')}`);
if (errors.length) fail(`page errors: ${errors.join(' | ')}`);

await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Navigation map and simulation speeds: every check passed');
