// Check for Road Ahead (docs/15): in a real browser, at phone sizes and in both themes, the timeline is in
// route order and never scrolls sideways; a filter never hides an urgent alert without saying so; the Alerts
// filter shows every source's status; the simulated alert is labeled as test data in its detail sheet; the
// States filter starts with the current state.
// Run: node web/tests/layout/ahead.layout.mjs   (needs Playwright with Chromium; CI installs it)
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
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://**', (r) => r.fulfill({ status: 503, body: '' }));
    // Mile 120 of the sample route, with the simulated crash 6 miles ahead.
    await page.goto(`${base}?demo=120&alert`);
    await page.waitForSelector('.tabbar [data-arg="ahead"]', { timeout: 60000 });
    await page.waitForTimeout(1200);
    const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
    await click('.tabbar [data-arg="ahead"]');
    await page.waitForSelector('.tl', { timeout: 20000 });
    const all = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      miles: [...document.querySelectorAll('.tl > .tl-row .tl-dist b')].map((b) => (b.textContent === 'Now' ? 0 : Number(b.textContent.replace(/,/g, '')))),
      urgent: document.querySelectorAll('.tl-alert.tier-urgent').length,
    }));
    if (all.scrollWidth > all.width + 1) fail(`All scrolls sideways (${all.scrollWidth} > ${all.width})`);
    if (!all.miles.length) fail('All shows no rows');
    for (let i = 1; i < all.miles.length; i++) if (all.miles[i] + 0.15 < all.miles[i - 1]) fail(`All is out of route order at row ${i} (${all.miles[i - 1]} then ${all.miles[i]})`);
    if (all.urgent !== 1) fail(`All shows ${all.urgent} urgent alerts, expected the simulated crash`);
    for (const f of ['fuel', 'rest', 'food', 'lodging', 'ev', 'dog']) {
      await click(`[data-act="ahead-filter"][data-arg="${f}"]`);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ urgent: document.querySelectorAll('.tl-alert.tier-urgent').length, note: document.querySelector('.filter-note')?.textContent ?? '',
        scrollWidth: document.documentElement.scrollWidth, width: innerWidth }));
      if (r.urgent !== 1) fail(`${f} filter hides the urgent alert`);
      if (!/urgent alert stays in view/.test(r.note)) fail(`${f} filter does not say the urgent alert stays in view`);
      if (r.scrollWidth > r.width + 1) fail(`${f} scrolls sideways`);
    }
    await click('[data-act="ahead-filter"][data-arg="alerts"]');
    await page.waitForTimeout(250);
    const alerts = await page.evaluate(() => ({ open: Boolean(document.querySelector('details.alert-status[open]')), rows: document.querySelectorAll('.alert-status .fac').length, alert: document.querySelectorAll('.tl-alert').length }));
    if (!alerts.open || alerts.rows < 3) fail('Alerts filter does not show each source status');
    if (alerts.alert < 1) fail('Alerts filter shows no alert');
    await click('.tl-card.al');
    await page.waitForTimeout(500);
    const sheet = await page.evaluate(() => document.querySelector('#sheet.open')?.textContent ?? '');
    if (!/SIMULATED TEST ALERT/.test(sheet) || !/Simulated test alert/.test(sheet)) fail('the simulated alert is not labeled as test data in its sheet');
    if (/all clear/i.test(sheet)) fail('the alert sheet says all clear');
    await click('[data-act="close-sheet"]');
    await click('[data-act="ahead-filter"][data-arg="states"]');
    await page.waitForTimeout(250);
    const states = await page.evaluate(() => ({ first: document.querySelector('.tl > .tl-row')?.textContent ?? '', lines: document.querySelectorAll('.tl-state').length }));
    if (!/You are in/.test(states.first)) fail('States does not start with the current state');
    if (states.lines < 3) fail(`States shows ${states.lines} states`);
    if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
    console.log(`${failures.some((x) => x.startsWith(name + ':')) ? 'FAIL' : 'ok  '} ${name}`);
    await ctx.close();
  }
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Road Ahead layout: every check passed');
