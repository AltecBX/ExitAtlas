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

const SIZES = [['phone', 390, 844], ['small phone', 375, 667], ['landscape', 844, 390]];
const failures = [];
const browser = await chromium.launch();
for (const [label, width, height] of SIZES) {
  for (const scheme of ['dark', 'light']) {
    for (const presentation of ['map', 'focus']) {
      const name = `${label} ${scheme} ${presentation}`;
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // Offline (no tiles, no live sources): the layout must not depend on the network.
      await page.route('https://**', (r) => r.fulfill({ status: 503, body: '' }));
      await page.goto(`${base}?demo`);
      await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
      await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
      if (presentation === 'focus') await page.evaluate(() => document.querySelector('[data-act="drive-view"][data-arg="focus"]').click());
      await page.waitForTimeout(1500);
      const r = await page.evaluate((pres) => {
        const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
        const chrome = Math.max(box('.appbar').bottom, box('#banner').bottom);
        const tab = box('.tabbar').top;
        const essentials = pres === 'map' ? ['.guide', '.speed-chip', '.journey'] : ['.fv-instruments', '.journey', '.fv-exit, .fv-guide'];
        const overlays = pres === 'map' ? ['.nav-top', '.nav-left', '.nav-right', '.nav-bottom'] : [];
        return { chrome, tab, width: innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollY: scrollY,
          essentials: essentials.map((s) => [s, box(s)]), overlays: overlays.map((s) => [s, box(s)]),
          card: box(pres === 'map' ? '.nav-card' : '.fv-card'), actions: box('.fv-actions') };
      }, presentation);
      const fail = (m) => failures.push(`${name}: ${m}`);
      if (r.scrollWidth > r.width + 1) fail(`scrolls sideways (${r.scrollWidth} > ${r.width})`);
      for (const [sel, b] of r.essentials) {
        if (!b) { fail(`${sel} missing`); continue; }
        if (b.top < r.chrome - 1) fail(`${sel} starts under the top bar (${Math.round(b.top)} < ${Math.round(r.chrome)})`);
        if (b.bottom > r.tab + 1) fail(`${sel} ends behind the tab bar or below the screen (${Math.round(b.bottom)} > ${Math.round(r.tab)})`);
      }
      // The adaptive card and the action buttons too, except sideways where they may sit in a second column.
      if (label !== 'landscape') for (const [what, b] of [['adaptive card', r.card], ['fuel and restroom buttons', r.actions]]) {
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
