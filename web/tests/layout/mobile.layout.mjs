// iPhone Safari checks (docs/15) in a real browser at phone sizes with Safari's default text size: sheets fit and
// close with a 44 point button; the profile button and the Drive view switch take a 44 point tap; a <details>
// the driver opened stays open while the screen updates during a drive; the screen wake lock is asked for,
// asked again on a tap after a refusal (with a note on the Drive screen), and let go when the drive ends;
// coming back after the screen was locked says how long location was paused; the map does not redraw while
// parked; quick double taps do not zoom the page.
// Run: node web/tests/layout/mobile.layout.mjs   (needs Playwright with Chromium; CI installs it)
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

// Safari's default text size (html { font: -apple-system-body } is 17 px; Chromium ignores it and uses 16 px).
const IOS_TEXT = 'html { font-size: 17px !important; }';
// A wake lock that refuses the first request (as Safari may without a tap) and grants the next ones.
function fakeWakeLock() {
  let n = 0;
  window.__wake = { requests: 0, released: 0 };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
    window.__wake.requests++;
    if (n++ === 0) throw new Error('NotAllowedError');
    const lock = { released: false, handlers: [], addEventListener(t, f) { if (t === 'release') this.handlers.push(f); },
      async release() { if (!this.released) { this.released = true; window.__wake.released++; this.handlers.forEach((f) => f()); } } };
    return lock;
  } } });
}

const failures = [];
const browser = await chromium.launch();
async function open(width, height, url, { scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((css) => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }), IOS_TEXT);
  await page.addInitScript(fakeWakeLock);
  await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto(url);
  await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
  await page.waitForFunction(() => window.exitAtlas?.data, null, { timeout: 60000 });
  return { ctx, page, errors };
}
const click = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
const act = (page, act, arg = '') => page.evaluate(([a, g]) => { const b = document.createElement('button'); b.dataset.act = a; if (g) b.dataset.arg = g; document.body.append(b); b.click(); b.remove(); }, [act, arg]);
/// The control a tap lands on 21 points from its center in each direction (a 44 point target reaches all four).
const reach = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return 'missing';
  const b = e.getBoundingClientRect(), x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
  const miss = [[21, 0], [-21, 0], [0, 21], [0, -21]].filter(([dx, dy]) => document.elementFromPoint(x + dx, y + dy)?.closest(s) !== e);
  return miss.length ? `misses ${miss.map((d) => d.join(',')).join(' ')}` : null;
}, sel);

for (const [label, width, height] of [['small phone', 375, 667], ['phone', 390, 844]]) {
  const fail = (m) => failures.push(`${label}: ${m}`);
  // Planning: the place search sheet (the destination is typed here).
  {
    const { ctx, page, errors } = await open(width, height, base);
    if (await page.evaluate(() => getComputedStyle(document.documentElement).touchAction) !== 'manipulation') fail('double tap zoom is not turned off (touch-action)');
    await click(page, '.tabbar [data-arg="trip"]');
    await page.waitForSelector('[data-act="pick"]', { timeout: 20000 });
    await click(page, '[data-act="pick"]');
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const sheet = document.querySelector('#sheet.open');
      const btn = sheet.querySelector('form[data-form="place-search"] button[type="submit"]').getBoundingClientRect();
      const input = sheet.querySelector('input[name="q"]');
      const x = sheet.querySelector('[data-act="close-sheet"]').getBoundingClientRect();
      return { sideways: sheet.scrollWidth - sheet.clientWidth, right: btn.right, h: btn.height, width: innerWidth, font: parseFloat(getComputedStyle(input).fontSize), x: [x.width, x.height] };
    });
    if (r.sideways > 0) fail(`the place search sheet scrolls sideways by ${r.sideways}`);
    if (r.right > r.width - 8) fail(`the Search button runs off the screen (${Math.round(r.right)} of ${r.width})`);
    if (r.h < 44) fail(`the Search button is ${Math.round(r.h)} points tall`);
    if (r.font < 16) fail(`the search field text is ${r.font} px: Safari zooms in on it`);
    if (r.x[0] < 44 || r.x[1] < 44) fail(`the sheet close button is ${r.x.map(Math.round).join('x')}`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    await ctx.close();
  }
  // Driving (the demo with the simulated crash ahead).
  {
    const { ctx, page, errors } = await open(width, height, `${base}?demo=120&alert`);
    await page.waitForSelector('.nav-view', { timeout: 60000 });
    await page.waitForTimeout(800);
    // Touch targets on the Drive screen.
    for (const sel of ['#settings-btn', '.nav-view [data-act="drive-view"][data-arg="map"]', '.nav-view [data-act="drive-view"][data-arg="focus"]']) {
      const m = await reach(page, sel);
      if (m) fail(`${sel} is under 44 points: ${m}`);
    }
    // Sheets close with a 44 point button.
    for (const [a, g] of [['sheet', 'fuel'], ['sheet', 'restroom'], ['alert', 'demo:crash']]) {
      await act(page, a, g);
      await page.waitForTimeout(350);
      const x = await page.evaluate(() => { const b = document.querySelector('#sheet.open [data-act="close-sheet"]')?.getBoundingClientRect(); return b ? [b.width, b.height, b.top] : null; });
      if (!x) fail(`${g} sheet has no close button`);
      else if (x[0] < 44 || x[1] < 44 || x[2] < 0) fail(`${g} sheet close button is ${Math.round(x[0])}x${Math.round(x[1])} at ${Math.round(x[2])}`);
      await click(page, '#sheet [data-act="close-sheet"]');
      await page.waitForTimeout(300);
      if (await page.evaluate(() => Boolean(document.querySelector('#sheet.open')))) fail(`${g} sheet does not close`);
    }
    // Wake lock: the first request was refused (fake), so the Drive screen says so; a tap asks again.
    const note = await page.evaluate(() => document.querySelector('.nav-note.warn')?.textContent ?? '');
    if (!/Screen may lock/.test(note)) fail('no note on the Drive screen after Safari refused to keep the screen on');
    await page.evaluate(() => document.querySelector('.speed-chip').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    await page.waitForTimeout(400);
    const held = await page.evaluate(() => ({ active: window.exitAtlas.wake.active, requests: window.__wake.requests, note: Boolean(document.querySelector('.nav-note.warn')) }));
    if (!held.active || held.requests !== 2) fail(`a tap did not keep the screen on (requests ${held.requests})`);
    if (held.note) fail('the screen lock note stays after the screen is held');
    // Road Ahead: "Why this stop" and the alert sources stay as the driver left them while the list updates.
    await click(page, '.tabbar [data-arg="ahead"]');
    await page.waitForSelector('.tl', { timeout: 20000 });
    await page.waitForTimeout(1700);
    const opened = await page.evaluate(() => { const d = [...document.querySelectorAll('#view details.bs-why, #view details.alert-status')]; d.forEach((x) => { x.open = true; }); return d.length; });
    if (opened < 2) fail(`expected "Why this stop" and the alert sources in Road Ahead, found ${opened}`);
    const swaps = await page.evaluate(() => { window.__swaps = 0; new MutationObserver(() => window.__swaps++).observe(document.querySelector('#view'), { childList: true }); });
    await page.waitForTimeout(3600);
    const kept = await page.evaluate(() => ({ swaps: window.__swaps, open: document.querySelectorAll('#view details.bs-why[open], #view details.alert-status[open]').length }));
    if (kept.swaps < 1) fail('Road Ahead did not update during the check');
    if (kept.open < opened) fail(`Road Ahead closed ${opened - kept.open} of the sections the driver opened when it updated`);
    // The Alerts filter opens the sources; closed by the driver, they stay closed.
    await click(page, '[data-act="ahead-filter"][data-arg="alerts"]');
    await page.waitForTimeout(400);
    await page.evaluate(() => { document.querySelector('#view details.alert-status').open = false; });
    await page.waitForTimeout(3600);
    if (await page.evaluate(() => document.querySelector('#view details.alert-status').open)) fail('the alert sources reopen by themselves under the Alerts filter');
    await click(page, '[data-act="ahead-filter"][data-arg="all"]');
    // Ending the drive lets the screen lock again.
    await click(page, '#end');
    await page.waitForTimeout(300);
    const ended = await page.evaluate(() => ({ active: window.exitAtlas.wake.active, released: window.__wake.released }));
    if (ended.active || ended.released < 1) fail('the screen stays awake after the drive ends');
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    await ctx.close();
  }
  // A real drive (own GPS): back from a locked screen, and parked with the map showing.
  {
    const { ctx, page, errors } = await open(width, height, `${base}?demo=300`);
    await page.waitForSelector('.nav-view', { timeout: 60000 });
    await page.waitForFunction(() => window.exitAtlas.navMap?.ready, null, { timeout: 60000 });
    await page.evaluate(() => {
      const a = window.exitAtlas;
      const fix = a.sim.simulator.step(Date.now() / 1000).sample;
      clearInterval(a.sim.timer);
      a.sim = null;
      a.gps = 'device';
      // Parked: the same place, a little GPS jitter, speed 0, once a second.
      window.__frames = 0;
      a.navMap.map.on('render', () => window.__frames++);
      let t = fix.t;
      setInterval(() => { t += 1; const j = () => (Math.random() - 0.5) * 0.00002; a.location.onSample({ ...fix, coordinate: { lat: fix.coordinate.lat + j(), lon: fix.coordinate.lon + j() }, speed: 0, t }); }, 1000);
    });
    await page.waitForTimeout(2500);
    const f0 = await page.evaluate(() => window.__frames);
    await page.waitForTimeout(4000);
    const frames = (await page.evaluate(() => window.__frames)) - f0;
    if (frames > 10) fail(`the map drew ${frames} frames in 4 seconds while parked`);
    // The screen locks for 3 minutes, then Safari comes back.
    await page.evaluate(() => {
      let state = 'hidden';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
      const now = Date.now;
      Date.now = () => now() + 180000;
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    const t = await page.evaluate(() => document.querySelector('#toast.show')?.textContent ?? '');
    if (!/paused for 3 minutes/.test(t)) fail(`no word about the paused location after the screen was locked (toast: "${t}")`);
    if (/[—–]|\w-\w/.test(t)) fail(`the message uses a hyphen or dash: "${t}"`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    await ctx.close();
  }
  console.log(`${failures.some((x) => x.startsWith(label + ':')) ? 'FAIL' : 'ok  '} ${label}`);
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('iPhone Safari checks: every check passed');
