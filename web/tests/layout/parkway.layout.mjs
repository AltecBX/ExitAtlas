// A trip on the Taconic State Parkway in a real browser (the recorded OSRM route, Yonkers to Lenox, served in
// place of the routing server; GPS fed through the app's own location code): at phone sizes and in both themes,
// the Drive screen names the parkway (not "Local roads"), the next exit is the parkway's next numbered exit, Road
// Ahead lists its exits in order and drops the ones passed, and nothing scrolls sideways.
// Run: node web/tests/layout/parkway.layout.mjs   (needs Playwright with Chromium; SHOTS=<dir> saves screenshots)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodePolyline } from '../../js/engine/geo.js';

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

const fixture = JSON.parse(readFileSync(path.join(root, 'Tests/ExitAtlasCoreTests/Fixtures/yonkers_to_lenox_taconic.route.json'), 'utf8'));
const coords = fixture.coordinates.map(([lat, lon]) => ({ lat, lon }));
const osrm = JSON.stringify({ code: 'Ok', routes: [{ geometry: encodePolyline(coords, 6), duration: fixture.duration_s, distance: fixture.distance_m,
  legs: [{ annotation: { duration: fixture.segment_durations_s },
    steps: fixture.steps.map((s) => ({ name: s.name, ref: s.ref, distance: s.distance_m, maneuver: { type: s.maneuver, modifier: s.modifier } })) }] }] });
const MILE = 1609.344;
const shotDir = process.env.SHOTS ?? null;

const SIZES = [['phone', 390, 844, 'dark'], ['small phone', 320, 568, 'light']];
const failures = [];
const browser = await chromium.launch();
for (const [label, width, height, scheme] of SIZES) {
  const name = `${label} ${scheme}`;
  const check = (ok, m) => { if (!ok) failures.push(`${name}: ${m}`); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${m}`); };
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  // GPS only from the test: the planner's one time fix is the route's start in Yonkers.
  await ctx.addInitScript(([lat, lon]) => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: lat, longitude: lon, accuracy: 10, heading: null, speed: null }, timestamp: Date.now() }), 20),
      watchPosition: () => 1, clearWatch: () => {},
    } });
  }, [coords[0].lat, coords[0].lon]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route((u) => u.protocol === 'https:', (r) => {
    const u = new URL(r.request().url());
    if (u.host === 'router.project-osrm.org') return r.fulfill({ status: 200, contentType: 'application/json', body: osrm });
    if (u.host === 'nominatim.openstreetmap.org' && u.pathname === '/search') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ display_name: 'Lenox, Massachusetts, United States', lat: '42.3565', lon: '-73.2848' }]) });
    }
    return r.fulfill({ status: 503, body: '' });
  });
  const app = (fn, arg) => page.evaluate(fn, arg);
  const shot = async (what) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `parkway-${what}-${width}.png`) }); };
  const tap = (sel) => app((s) => { const e = document.querySelector(s); if (!e) throw new Error(`${s} not found`); e.click(); }, sel);
  await page.goto(base);
  await page.waitForFunction(() => window.exitAtlas?.data, null, { timeout: 60000 });
  check(await app(() => Boolean(window.exitAtlas.data.freeways)), 'the exits on other freeways load');
  await app(async () => { const m = await import('./js/app/services.js'); m.ROUTING_SPACING.ms = 0; });
  await tap('.tabbar [data-arg="trip"]');
  await page.waitForSelector('[data-act="pick"][data-arg="to"]');
  await tap('[data-act="pick"][data-arg="to"]');
  await page.waitForSelector('#sheet-body input[name="q"]');
  await page.fill('#sheet-body input[name="q"]', 'Lenox');
  await app(() => document.querySelector('#sheet-body form').requestSubmit());
  await page.waitForSelector('[data-act="choose-place"]', { timeout: 8000 });
  await tap('[data-act="choose-place"]');
  await page.waitForSelector('[data-act="find-routes"]:not([disabled])');
  await tap('[data-act="find-routes"]');
  await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 });
  await tap('[data-act="start-route"][data-arg="0"]');
  // Drive from `miles` for a few seconds: the trip picks up there, as after a resume, then follows the fixes.
  const driveAt = (miles) => app((d) => {
    const a = window.exitAtlas;
    const poly = a.plan.route.polyline;
    window.__t = (window.__t ?? Math.floor(Date.now() / 1000)) + 600;
    a.session.tracker.reset(d, window.__t);
    a.session.recordedUpTo = d;
    for (let k = 1; k <= 6; k++) {
      const x = d + 30 * k;
      const c = poly.coordinateAt(x);
      a.location.handle({ coords: { latitude: c.lat, longitude: c.lon, accuracy: 8, heading: poly.bearingAt(x), speed: 30 }, timestamp: (window.__t + k) * 1000 });
    }
    window.__t += 6;
  }, miles * MILE);
  const width_ = () => app(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));

  // Mile 51 on the Taconic, northbound: Exit 38 just passed, Exit 41 next.
  await driveAt(51);
  await page.waitForTimeout(300);
  await tap('[data-act="drive-view"][data-arg="focus"]');
  await page.waitForSelector('.focus-view');
  const focus = await app(() => {
    const box = (s) => document.querySelector(s)?.getBoundingClientRect();
    const name = document.querySelector('.road-name');
    const n = box('.road-name'), t = box('.fv-instruments .view-toggle'), card = box('.fv-instruments');
    return { road: name?.textContent.trim(), dir: document.querySelector('.road-dir')?.textContent.trim(),
      exit: document.querySelector('.fv-exit .exit-sign .n')?.textContent.trim(), cut: name ? name.scrollHeight > name.clientHeight + 1 : true,
      clear: n && t && card && (n.top >= t.bottom - 0.5 || n.right <= t.left) && n.right <= card.right + 0.5,
      boxes: `name ${n?.top.toFixed(1)}-${n?.bottom.toFixed(1)} x ${n?.left.toFixed(1)}-${n?.right.toFixed(1)}, buttons to ${t?.bottom.toFixed(1)} from x ${t?.left.toFixed(1)}, card to x ${card?.right.toFixed(1)}` };
  });
  await shot('focus');
  check(focus.road === 'Taconic State Pkwy' && focus.dir === 'North', `Focus View names the road (${focus.road} ${focus.dir})`);
  check(focus.exit === '41', `the next exit is Exit 41 (${focus.exit})`);
  check(!focus.cut && focus.clear, `the road name shows whole, clear of the view buttons and inside its card (${focus.boxes}${focus.cut ? ', cut' : ''})`);
  let w = await width_();
  check(w.scroll <= w.width + 1, `Focus View does not scroll sideways (${w.scroll} of ${w.width} px)`);
  await tap('[data-act="drive-view"][data-arg="map"]');
  await page.waitForSelector('.nav-view');
  const nav = await app(() => ({ exit: document.querySelector('.guide.exit .exit-sign .n')?.textContent.trim(), sub: document.querySelector('.guide-sub.static')?.textContent.trim() ?? '' }));
  await shot('nav');
  check(nav.exit === '41' && nav.sub.startsWith('Taconic State Pkwy N'), `Navigation View: Exit 41 next, on Taconic State Pkwy N (${nav.exit}, ${nav.sub})`);

  const ahead = async () => {
    await tap('.tabbar [data-arg="ahead"]');
    await page.waitForSelector('.tl', { timeout: 20000 });
    return app(() => ({ labels: [...document.querySelectorAll('.tl-exit .exit-sign .n')].map((n) => n.textContent.trim()),
      miles: [...document.querySelectorAll('.tl > .tl-row .tl-dist b')].map((b) => (b.textContent === 'Now' ? 0 : Number(b.textContent.replace(/,/g, '')))),
      scroll: document.documentElement.scrollWidth, width: innerWidth }));
  };
  let a = await ahead();
  await shot('ahead');
  check(a.labels.slice(0, 7).join(' ') === '41 43A 43B 45 47A 47B 48', `Road Ahead lists the parkway's exits in order (${a.labels.slice(0, 8).join(' ')})`);
  check(!a.labels.includes('38') && !a.labels.includes('35'), 'exits already passed are not listed');
  check(a.miles.every((m, i) => i === 0 || m + 0.15 >= a.miles[i - 1]), 'Road Ahead is in route order');
  check(a.scroll <= a.width + 1, `Road Ahead does not scroll sideways (${a.scroll} of ${a.width} px)`);

  // Past Exit 47A: it drops off and 47B is next.
  await driveAt(59.12);
  await page.waitForTimeout(300);
  a = await ahead();
  check(a.labels[0] === '47B' && !a.labels.includes('47A'), `after Exit 47A, Road Ahead starts at 47B (${a.labels.slice(0, 3).join(' ')})`);
  await tap('.tabbar [data-arg="drive"]');
  await page.waitForSelector('[data-act="drive-view"][data-arg="focus"]', { timeout: 8000 });
  await tap('[data-act="drive-view"][data-arg="focus"]');
  await page.waitForSelector('.focus-view', { timeout: 8000 });
  const next = await app(() => document.querySelector('.fv-exit .exit-sign .n')?.textContent.trim());
  check(next === '47B', `the Drive card's next exit is 47B (${next})`);
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await ctx.close();
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Parkway layout: every check passed');
