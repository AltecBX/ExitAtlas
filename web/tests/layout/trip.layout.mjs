// The trip from start to end in a real browser, with the routing and place search servers replaced by fixtures
// (a recorded OSRM route, New York City to Richmond) and GPS fed through the app's own location code:
// search and route when the servers stall, start, drive, leave the route while the routing server stalls,
// come back, reroute, reload mid trip, run a simulated drive, resume and end.
// Run: node web/tests/layout/trip.layout.mjs   (needs Playwright with Chromium)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodePolyline, distance } from '../../js/engine/geo.js';

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

// The recorded Richmond to New York City route, driven the other way (as from Yonkers, heading south).
const fixture = JSON.parse(readFileSync(path.join(root, 'Tests/ExitAtlasCoreTests/Fixtures/richmond_to_nyc_turnpike.route.json'), 'utf8'));
const coords = fixture.coordinates.map(([lat, lon]) => ({ lat, lon })).reverse();
const durations = [...fixture.segment_durations_s].reverse();
const steps = [...fixture.steps].reverse().map((s) => ({ name: s.name, ref: s.ref, distance: s.distance_m, maneuver: { type: 'continue' } }));
/// An OSRM answer from `start` to Richmond: the recorded route from its point nearest to `start` on.
function osrmFrom(start) {
  let k = 0, best = Infinity;
  for (let i = 0; i < coords.length; i++) { const d = distance(start, coords[i]); if (d < best) { best = d; k = i; } }
  const pts = k === 0 && best < 50 ? coords : [start, ...coords.slice(k + 1)];
  const durs = k === 0 && best < 50 ? durations : [distance(start, coords[k + 1]) / 15, ...durations.slice(k + 1)];
  return JSON.stringify({ code: 'Ok', routes: [{ geometry: encodePolyline(pts, 6), duration: durs.reduce((a, b) => a + b, 0), distance: 0,
    legs: [{ annotation: { duration: durs }, steps }] }] });
}

// What the servers do: 'ok', 'hang' (accept and never answer) or 'down' (no connection). The backup routing
// server (FOSSGIS) does what the OSRM demo server does unless `backup` says otherwise.
const servers = { routing: 'ok', search: 'ok', backup: null };
let routingCalls = 0, backupCalls = 0, lastRoutingPoints = 0;
const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const check = (ok, m) => { if (!ok) fail(m); else console.log(`ok   ${m}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
// GPS comes only from the test: the app's watch never fires on its own, the planner's one time fix is Times Square.
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: 40.758, longitude: -73.9855, accuracy: 10, heading: null, speed: null }, timestamp: Date.now() }), 20),
    watchPosition: () => 1, clearWatch: () => {},
  } });
  const set = Storage.prototype.setItem;
  window.__writes = [];
  Storage.prototype.setItem = function (key, value) {
    window.__writes.push({ key, size: String(value).length, id: key === 'ea.activeRoute' ? JSON.parse(value).id : null });
    return set.call(this, key, value);
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route((u) => u.protocol === 'https:', async (r) => {
  const u = new URL(r.request().url());
  const backup = u.host === 'routing.openstreetmap.de';
  const kind = u.host === 'router.project-osrm.org' || backup ? 'routing' : u.host === 'nominatim.openstreetmap.org' && u.pathname === '/search' ? 'search' : null;
  if (!kind) return r.fulfill({ status: 503, body: '' });
  if (backup) backupCalls++;
  else if (kind === 'routing') { routingCalls++; lastRoutingPoints = u.pathname.split('/').pop().split(';').length; }
  const mode = backup ? servers.backup ?? servers.routing : servers[kind];
  if (mode === 'hang') return; // accepted, never answered
  if (mode === 'down') return r.abort('internetdisconnected');
  if (kind === 'search') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ display_name: 'Richmond, Virginia, United States', lat: '37.5407', lon: '-77.436' }]) });
  const [lon, lat] = u.pathname.split('/').pop().split(';')[0].split(',').map(Number);
  return r.fulfill({ status: 200, contentType: 'application/json', body: osrmFrom({ lat, lon }) });
});

const app = (fn, arg) => page.evaluate(fn, arg);
const tap = (sel) => app((s) => { const e = document.querySelector(s); if (!e) throw new Error(`${s} not found`); e.click(); }, sel);
const until = async (fn, arg, ms = 8000) => { try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const view = () => app(() => document.querySelector('#view').textContent);
const loaded = async () => {
  await page.waitForFunction(() => window.exitAtlas?.data, null, { timeout: 60000 });
  // Short time limits so the stalls below take seconds. Same module instance as the app's.
  await app(async () => { const m = await import('./js/app/services.js'); if (m.REQUEST_TIMEOUT) Object.assign(m.REQUEST_TIMEOUT, { routing: 1500, search: 1500 }); if (m.ROUTING_SPACING) m.ROUTING_SPACING.ms = 0; });
  // Fixes along window.__route (the route being driven), one per second of GPS time.
  await app(() => {
    window.__gps = { t: Math.floor(Date.now() / 1000), d: 0 };
    const fix = (c, heading, speed) => {
      window.__gps.t += 1;
      window.exitAtlas.location.handle({ coords: { latitude: c.lat, longitude: c.lon, accuracy: 8, heading, speed }, timestamp: window.__gps.t * 1000 });
    };
    window.__drive = (seconds, speed = 30) => {
      const poly = window.__route.polyline;
      for (let k = 0; k < seconds; k++) { window.__gps.d += speed; fix(poly.coordinateAt(window.__gps.d), poly.bearingAt(window.__gps.d), speed); }
    };
    /// Stopped `meters` east of the route (a gas station off the highway). Yields between fixes, as a real
    /// GPS does, so a request started by one fix can finish before the next.
    window.__park = async (seconds, meters) => {
      const c = window.__route.polyline.coordinateAt(window.__gps.d);
      const p = { lat: c.lat, lon: c.lon + meters / (111320 * Math.cos(c.lat * Math.PI / 180)) };
      for (let k = 0; k < seconds; k++) { fix(p, null, 0); await new Promise((r) => setTimeout(r, 15)); }
    };
  });
};
const state = () => app(() => { const a = window.exitAtlas; return { mode: a.mode, gps: a.gps, status: a.snapshot?.match.status ?? null, rerouting: a.isRerouting,
  error: a.lastError, driven: a.session?.ledger.totalMeters ?? 0, pill: document.querySelector('#status').textContent.trim() }; });

// 1. First visit, nothing stored.
await page.goto(base);
await loaded();
check(!(await app(() => Boolean(document.querySelector('[data-act="resume"]')))) && (await view()).includes('Where are you headed?'), 'first visit: plan a trip, nothing to resume');

// 2. Place search that stalls, then works.
await tap('.tabbar [data-arg="trip"]');
await page.waitForSelector('[data-act="pick"][data-arg="to"]');
await tap('[data-act="pick"][data-arg="to"]');
await page.waitForSelector('#sheet-body input[name="q"]');
servers.search = 'hang';
await page.fill('#sheet-body input[name="q"]', 'Richmond');
await app(() => document.querySelector('#sheet-body form').requestSubmit());
check(await until(() => !window.exitAtlas.placeSearch.busy && /did not answer/.test(document.querySelector('#sheet-body').textContent), null, 6000),
  'a stalled place search ends with a reason');
servers.search = 'ok';
await app(() => document.querySelector('#sheet-body form').requestSubmit());
await page.waitForSelector('[data-act="choose-place"]', { timeout: 8000 });
await tap('[data-act="choose-place"]');

// 3. Routing that stalls, then works.
servers.routing = 'hang';
await page.waitForSelector('[data-act="find-routes"]:not([disabled])');
await tap('[data-act="find-routes"]');
check(await until(() => !window.exitAtlas.planner.busy, null, 6000), 'a stalled route request ends');
check(/did not answer/.test(await view()) && await app(() => !document.querySelector('[data-act="find-routes"]').disabled), 'it says why, and Find routes works again');
// The OSRM demo server down, the FOSSGIS backup up: routes, and nothing extra to read.
servers.routing = 'down';
servers.backup = 'ok';
const backupBefore = backupCalls;
await tap('[data-act="find-routes"]');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 }).catch(() => {});
check(backupCalls === backupBefore + 1 && await app(() => window.exitAtlas.planner.results.length > 0 && !window.exitAtlas.planner.error),
  'with the routing server down the backup server answers, and no error shows');
servers.backup = null;
servers.routing = 'ok';
await tap('[data-act="find-routes"]');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 });
await tap('[data-act="start-route"][data-arg="0"]');
await app(() => { window.__route = window.exitAtlas.plan.route; });
check((await state()).mode === 'trip' && await app(() => window.exitAtlas.places.recent[0]?.name.startsWith('Richmond')), 'the trip starts and Richmond is a recent place');

// 4. Driving: on route, progress, saved for resuming.
await app(() => window.__drive(120));
let s = await state();
check(s.status === 'onRoute' && s.driven > 3000, `on route after 2 minutes (${Math.round(s.driven)} m driven)`);
check(await app(() => JSON.parse(localStorage.getItem('ea.active'))?.routeId === window.exitAtlas.plan.route.id
  && JSON.parse(localStorage.getItem('ea.activeRoute'))?.id === window.exitAtlas.plan.route.id), 'the trip is saved for resuming');
// The route (large) is written once; the save every 30 seconds is small.
const writes = await app(() => window.__writes.filter((w) => w.key.startsWith('ea.active')));
const small = writes.filter((w) => w.key === 'ea.active');
check(writes.filter((w) => w.key === 'ea.activeRoute').length === 1 && small.length >= 3 && small.every((w) => w.size < 5000),
  `the route is saved once, the progress every 30 s is small (${small.length} saves, largest ${Math.max(...small.map((w) => w.size))} characters)`);

// 5. Off the route while the routing server stalls: the reroute gives up, says so, and does not block the next.
servers.routing = 'hang';
let before = routingCalls;
await app(() => window.__park(30, 1500));
check(routingCalls > before, 'leaving the route requests a new route');
await until(() => !window.exitAtlas.isRerouting, null, 8000);
s = await state();
check(!s.rerouting && s.pill !== 'Rerouting' && /did not answer/.test(s.error ?? ''), `a stalled reroute ends with a reason (${s.pill}: ${s.error})`);
before = routingCalls;
// Automatic reroutes are paced (at least 2 minutes apart; section 8 and web/tests/longdrive.test.js check the
// pacing). Each section here starts with the pacing cleared, so it checks only its own behavior.
const unpaced = () => app(() => window.exitAtlas.reroutePacer.reset());
await unpaced();
await app(() => window.__park(25, 1500));
check(routingCalls > before, 'a later reroute is still requested');
await until(() => !window.exitAtlas.isRerouting, null, 8000);

// 6. Back on the route: no reroute is pending, so "Will retry" goes.
await app(() => window.__drive(10));
await page.waitForTimeout(300);
s = await state();
check(s.status === 'onRoute' && s.error === null && !(await view()).includes('Will retry'), `back on the route, no stale reroute message (${s.error})`);

// 7. Off the route with the server up: one new route from here, miles driven kept, still going to Richmond.
servers.routing = 'ok';
const driven = (await state()).driven;
const oldRoute = await app(() => window.exitAtlas.plan.route.id);
before = routingCalls;
await unpaced();
await app(() => window.__park(40, 1500));
await until(() => !window.exitAtlas.isRerouting);
s = await state();
check(await app((id) => window.exitAtlas.plan.route.id !== id, oldRoute) && routingCalls - before === 1, `rerouted with one request (${routingCalls - before})`);
check(s.driven >= driven && await app(() => window.exitAtlas.remainingWaypoints.map((w) => w.name).join() === 'Richmond, Virginia'), 'miles driven and the destination are kept');
await app(() => { window.__route = window.exitAtlas.plan.route; window.__gps.d = 0; window.__drive(40); });
check((await state()).status === 'onRoute', 'on the new route');

// 7b. A stop from an exit's places, added mid trip. With no connection it is not added, and the driver is told;
//     with one, the new route goes through it.
const pick = await app(() => {
  const a = window.exitAtlas, d = a.snapshot.progress;
  const e = a.plan.exits.find((x) => x.distanceAlongRoute > d + 2000 && a.servicesFor(x).length);
  const p = a.servicesFor(e)[0].place;
  return { arg: `${e.id}|${p.id}` };
});
const addStop = () => app((arg) => {
  const b = document.createElement('button');
  b.dataset.act = 'add-trip-stop';
  b.dataset.arg = arg;
  document.body.append(b);
  b.click();
  b.remove();
}, pick.arg);
const ahead = () => app(() => window.exitAtlas.remainingWaypoints.map((w) => w.name));
servers.routing = 'down';
await addStop();
await page.waitForTimeout(300);
await until(() => !window.exitAtlas.isRerouting);
const notAdded = await app(() => document.querySelector('#toast').textContent);
check(/^Could not add .+: the routing servers could not be reached/.test(notAdded) && (await ahead()).join() === 'Richmond, Virginia',
  `a stop that could not be added is not kept, and the driver is told (${notAdded})`);
servers.routing = 'ok';
await addStop();
await page.waitForTimeout(300);
await until(() => !window.exitAtlas.isRerouting);
check((await ahead()).length === 2 && (await ahead())[1] === 'Richmond, Virginia' && lastRoutingPoints === 3, `a stop added mid trip is routed through (${(await ahead()).join(' then ')})`);
await app(() => { window.__route = window.exitAtlas.plan.route; window.__gps.d = 0; window.__drive(5); });

// 8. No connection while off the route: paced retries (app/reroute.js: at least 2 minutes apart, longer while
//    each new route goes unfollowed), not one on every fix.
servers.routing = 'down';
before = routingCalls;
await unpaced();
await app(() => window.__park(100, 2000));
await page.waitForTimeout(300);
const early = routingCalls - before;
await app(() => window.__park(400, 2000));
await page.waitForTimeout(300);
const calls = routingCalls - before;
check(early <= 1 && calls >= 2 && calls <= 4, `paced reroute requests without a connection (${early} in the first 100 s, ${calls} in 500 s)`);
servers.routing = 'ok';
await app(() => window.__drive(35));
await app(() => window.dispatchEvent(new Event('pagehide')));
const saved = await app(() => JSON.parse(localStorage.getItem('ea.active')));
const savedMeters = saved.ledger.stints.reduce((a, x) => a + x.meters, 0);
const routeWrites = await app(() => window.__writes.filter((w) => w.key === 'ea.activeRoute').map((w) => w.id));
check(routeWrites.length >= 2 && new Set(routeWrites).size === routeWrites.length && routeWrites.at(-1) === saved.routeId,
  `each new route is saved once, when it changes (${routeWrites.length} routes)`);

// 9. The page reloads mid trip (iOS does this to background tabs): offered to resume.
await page.reload();
await loaded();
await page.waitForSelector('[data-act="resume"]', { timeout: 5000 }).catch(() => {});
check((await view()).includes('Resume your trip to Richmond'), 'after a reload the trip can be resumed');

// 10. A simulated drive in between does not throw the saved trip away.
await tap('[data-act="demo"]');
await until(() => window.exitAtlas.mode === 'trip' && window.exitAtlas.gps === 'simulation', null, 20000);
await tap('#end');
await page.waitForTimeout(300);
check(await app(() => Boolean(localStorage.getItem('ea.active'))) && (await view()).includes('Resume your trip to Richmond'),
  'ending a simulated drive keeps the saved trip');

// 11. Resume: where the trip was (an estimate until a fix), same miles, back on GPS. The page was gone for
//     20 km: those miles count, in their states, as they do when a backgrounded page catches up.
await tap('[data-act="resume"]');
const resumedAt = await app(() => ({ progress: window.exitAtlas.snapshot.progress, pill: document.querySelector('#status').textContent.trim() }));
check(Math.abs(resumedAt.progress - saved.progress) < 1 && resumedAt.pill === 'Estimating',
  `resumed where the trip was saved, as an estimate (${Math.round(resumedAt.progress)} of ${Math.round(saved.progress)} m, ${resumedAt.pill})`);
await app((d) => { window.__route = window.exitAtlas.plan.route; window.__gps.d = d + 20000; window.__drive(10); }, saved.progress);
s = await state();
check(s.mode === 'trip' && s.gps === 'device' && s.status === 'onRoute' && s.driven >= savedMeters + 20000,
  `resumed with the miles driven, including the 20 km while the page was gone (${Math.round(s.driven)} m, ${Math.round(savedMeters)} m saved)`);

// 12. Resumed while off the route (the page reloaded at a gas station): a new route is requested. The trip was
//     saved by the version live before this one (v33: the route inside ea.active, with progress).
// Rewritten from an idle page: a page with the trip running saves it again when it unloads.
await page.reload();
await loaded();
const v33 = await app(() => {
  const rec = JSON.parse(localStorage.getItem('ea.active'));
  const { routeId, ...rest } = rec;
  const old = { ...rest, route: JSON.parse(localStorage.getItem('ea.activeRoute')) };
  localStorage.setItem('ea.active', JSON.stringify(old));
  localStorage.removeItem('ea.activeRoute');
  return old;
});
await page.reload();
await loaded();
await page.waitForSelector('[data-act="resume"]', { timeout: 5000 });
await tap('[data-act="resume"]');
check(await app((rec) => window.exitAtlas.mode === 'trip' && window.exitAtlas.plan.route.id === rec.route.id
  && Math.abs(window.exitAtlas.snapshot.progress - rec.progress) < 1, v33), 'a trip saved by the version before (v33) resumes where it was');
await app(() => window.dispatchEvent(new Event('pagehide')));
check(await app(() => !JSON.parse(localStorage.getItem('ea.active')).route && Boolean(localStorage.getItem('ea.activeRoute'))),
  'and is saved again the new way');
before = routingCalls;
await app(async () => { window.__route = window.exitAtlas.plan.route; window.__gps.d = window.exitAtlas.snapshot.progress; await window.__park(30, 1500); });
check(routingCalls > before, 'resumed off the route: a new route is requested');
await until(() => !window.exitAtlas.isRerouting);

// 13. End: nothing left to resume, the trip is in history.
await tap('#end');
await page.waitForTimeout(300);
check(await app(() => localStorage.getItem('ea.active') === null && window.exitAtlas.history.length === 1 && !document.querySelector('[data-act="resume"]')),
  'ending the trip clears it and records it');

// 13b. A trip saved by v32 (the route inside ea.active, no progress) resumes too.
await app((rec) => { const { progress, ...v32 } = rec; localStorage.setItem('ea.active', JSON.stringify({ ...v32, savedAt: Date.now() / 1000 })); }, v33);
await page.reload();
await loaded();
await page.waitForSelector('[data-act="resume"]', { timeout: 5000 }).catch(() => {});
check((await view()).includes('Resume your trip to Richmond'), 'a trip saved by v32 is offered');
await tap('[data-act="resume"]');
check(await app((id) => window.exitAtlas.mode === 'trip' && window.exitAtlas.plan.route.id === id, v33.route.id), 'and resumes');
await tap('#end');
await page.waitForTimeout(300);
check(await app(() => localStorage.getItem('ea.active') === null && localStorage.getItem('ea.activeRoute') === null), 'ending it clears both saved parts');

// 14. A saved trip that cannot be read is not offered, and the app still starts.
await app(() => localStorage.setItem('ea.active', JSON.stringify({ route: { destination: { name: 'X' } }, ledger: { stints: 5 }, savedAt: Date.now() / 1000 })));
await page.reload();
await loaded();
await page.waitForTimeout(500);
check(await app(() => !document.querySelector('#loading') && !document.querySelector('[data-act="resume"]') && /Where are you headed/.test(document.querySelector('#view').textContent)),
  'an unreadable saved trip does not stop the app from starting');

if (errors.length) fail(`page errors: ${errors.join('; ')}`);
await browser.close();
server.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Trip: every check passed');
