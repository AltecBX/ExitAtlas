// Layout check for the Drive screen (docs/15): in a real browser, at phone sizes, in both presentations and
// both themes, everything a driver needs is on screen without scrolling, nothing sits under the top bar or
// behind the tab bar, the overlays over the map do not overlap, and nothing scrolls sideways.
// Run: node web/tests/layout/drive.layout.mjs   (needs Playwright with Chromium; CI installs it)
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

const SIZES = [['phone', 390, 844], ['small phone', 375, 667], ['large phone', 430, 932], ['landscape', 844, 390], ['small landscape', 667, 375]];
// Safari on iPhone sizes text from the Text Size setting (html { font: -apple-system-body }): 17 px at the
// default, where Chromium uses 16 px. The check runs at Safari's default so the screen is checked as it shows.
const IOS_TEXT = 'html { font-size: 17px !important; }';
const failures = [];
const browser = await chromium.launch();
// Overnight Drive Mode on shows the overnight restroom card (taller) whatever the hour; the default (Auto)
// shows it only from midnight to 5 AM at the stop, so both are checked.
// "road": as on a real drive, the driver's own GPS and no simulation banner (the demo's banner takes about 50
// points at the top that a real drive has). "alert": the simulated crash ahead, the tallest adaptive card.
const RUNS = [['dark', 'auto'], ['light', 'auto'], ['dark', 'on'], ['dark', 'auto', 'road'], ['dark', 'on', 'road'], ['dark', 'auto', 'road', 'alert']];
for (const [label, width, height] of SIZES) {
  for (const [scheme, overnight, road, alert] of RUNS) {
    for (const presentation of ['map', 'focus']) {
      const name = `${label} ${scheme}${overnight === 'on' ? ' overnight' : ''}${road ? ' road' : ''}${alert ? ' alert' : ''} ${presentation}`;
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript((css) => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }), IOS_TEXT);
      // Offline (no tiles, no live sources): the layout must not depend on the network.
      await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
      await page.goto(`${base}?demo${alert ? '=120&alert' : ''}`);
      await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
      await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
      if (presentation === 'focus') await page.evaluate(() => document.querySelector('[data-act="drive-view"][data-arg="focus"]').click());
      if (overnight === 'on') {
        await page.evaluate(() => {
          const a = window.exitAtlas;
          a.settings.overnightMode = 'on';
          a.profile = { ...a.profile, overnight: { ...a.profile.overnight, mode: 'on' } };
        });
      }
      await page.waitForTimeout(1500);
      if (road) {
        await page.evaluate(() => {
          const a = window.exitAtlas;
          clearInterval(a.sim.timer);
          a.sim = null;
          a.gps = 'device';
          document.querySelector('.tabbar [data-arg="drive"]').click();
        });
        await page.waitForTimeout(400);
        if (await page.evaluate(() => document.querySelector('#banner').textContent.trim() !== '')) failures.push(`${name}: a banner shows on a real drive`);
      }
      if (overnight === 'on' && !(await page.evaluate(() => Boolean(document.querySelector('.night-card'))))) failures.push(`${name}: the overnight restroom card does not show`);
      if (alert && !(await page.evaluate(() => Boolean(document.querySelector('.nav-card .alert-card, .fv-card .alert-card'))))) failures.push(`${name}: the alert card does not show`);
      // Navigation View with both left column notes due at once (the browser refused to keep the screen on, and
      // the map is offline): only one shows, and the column stays clear of the bottom panel on every size.
      if (presentation === 'map') {
        const notes = await page.evaluate(async () => {
          const a = window.exitAtlas;
          a.settings.keepAwake = true;
          a.wake.wanted = true;
          a.wake.error = 'Test: refused';
          if (a.wake.lock) { a.wake.lock = null; }
          if (a.navMap) a.navMap.offline = true;
          await new Promise((r) => setTimeout(r, 1500));
          return document.querySelectorAll('.nav-left .nav-note').length;
        });
        if (notes > 1) failures.push(`${name}: ${notes} notes stacked in the left column`);
      }
      const r = await page.evaluate((pres) => {
        const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
        const chrome = Math.max(box('.appbar').bottom, box('#banner').bottom);
        const tab = box('.tabbar').top;
        const essentials = pres === 'map' ? ['.guide', '.speed-chip', '.journey', '.trip-strip'] : ['.fv-instruments', '.journey', '.trip-strip', '.fv-exit, .fv-guide'];
        const overlays = pres === 'map' ? ['.nav-top', '.nav-left', '.nav-right', '.nav-bottom'] : [];
        return { chrome, tab, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollY: scrollY,
          essentials: essentials.map((s) => [s, box(s)]), overlays: overlays.map((s) => [s, box(s)]),
          card: box(pres === 'map' ? '.nav-card' : '.fv-card'), actions: box('.fv-actions'), night: Boolean(document.querySelector('.night-card')) };
      }, presentation);
      const fail = (m) => failures.push(`${name}: ${m}`);
      if (r.scrollWidth > r.width + 1) fail(`scrolls sideways (${r.scrollWidth} > ${r.width})`);
      for (const [sel, b] of r.essentials) {
        if (!b) { fail(`${sel} missing`); continue; }
        if (b.top < r.chrome - 1) fail(`${sel} starts under the top bar (${Math.round(b.top)} < ${Math.round(r.chrome)})`);
        if (b.bottom > r.tab + 1) fail(`${sel} ends behind the tab bar or below the screen (${Math.round(b.bottom)} > ${Math.round(r.tab)})`);
      }
      // The adaptive card and the action buttons too: on a real drive at every size, sideways included (iPhone SE
      // sideways is 375 points tall); with the demo banner on portrait screens without the taller overnight card
      // (which Auto also shows from midnight to 5 AM, so the check looks at the card, not the setting).
      if (road || (!label.endsWith('landscape') && !r.night)) for (const [what, b] of [['adaptive card', r.card], ['fuel and restroom buttons', r.actions]]) {
        if (b && b.bottom > r.tab + 1) fail(`${what} below the fold (${Math.round(b.bottom)} > ${Math.round(r.tab)})`);
      }
      const hit = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      for (let i = 0; i < r.overlays.length; i++) for (let j = i + 1; j < r.overlays.length; j++) {
        const [sa, a] = r.overlays[i], [sb, b] = r.overlays[j];
        if (hit(a, b)) fail(`${sa} overlaps ${sb}`);
      }
      if (errors.length) fail(`page errors: ${errors.join('; ')}`);
      console.log(`${failures.some((f) => f.startsWith(name)) ? 'FAIL' : 'ok  '} ${name}`);
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Drive layout: every check passed');
