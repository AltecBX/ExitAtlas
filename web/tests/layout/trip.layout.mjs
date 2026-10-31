// The trip from start to end in a real browser, with the routing and place search servers replaced by fixtures
// (a recorded OSRM route, New York City to Richmond) and GPS fed through the app's own location code:
// search and route when the servers stall, start, drive, leave the route while the routing server stalls,
// come back, reroute, reload mid trip, run a simulated drive, resume and end. Then the Taconic State Parkway
// (recorded OSRM answers): past the exit of the route and on along the Taconic, a reroute that keeps to it.
// Run: node web/tests/layout/trip.layout.mjs   (needs Playwright with Chromium)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { encodePolyline, decodePolyline, distance } from '../../js/engine/geo.js';
import { loadOSRM, osrmAnswerFrom } from '../support.js';

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
// Section 16 answers from the Taconic State Parkway (`taconic`): from Briarcliff Manor the answer recorded there,
// from anywhere else (the driver past the NY 82 exit) the one recorded 600 m past that exit, from the driver on.
const servers = { routing: 'ok', search: 'ok', backup: null, taconic: false };
let routingCalls = 0, backupCalls = 0, lastRoutingPoints = 0, lastRoutingStart = null, lastRoutingQuery = '';
const fromBriarcliff = loadOSRM('taconic_briarcliff_to_lenox'), pastNY82 = loadOSRM('taconic_past_ny82_to_lenox');
const BRIARCLIFF = { lat: 41.1533, lon: -73.8166 };
const taconicFrom = (start) => JSON.stringify(distance(start, BRIARCLIFF) < 500 ? fromBriarcliff : osrmAnswerFrom(pastNY82, start));
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
    // Storage full for the small trip record only (section 7): its route write still goes in.
    if (window.__activeFull && key === 'ea.active') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    window.__writes.push({ key, size: String(value).length, id: key === 'ea.activeRoute' ? JSON.parse(value).id : null, full: Boolean(window.__activeFull) });
    return set.call(this, key, value);
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Questions the app asks (confirm): kept, and answered with `answerYes`.
const dialogs = [];
let answerYes = true;
page.on('dialog', (d) => { dialogs.push(d.message()); return answerYes ? d.accept() : d.dismiss(); });
await page.route((u) => u.protocol === 'https:', async (r) => {
  const u = new URL(r.request().url());
  const backup = u.host === 'routing.openstreetmap.de';
  const kind = u.host === 'router.project-osrm.org' || backup ? 'routing' : u.host === 'nominatim.openstreetmap.org' && u.pathname === '/search' ? 'search' : null;
  if (!kind) return r.fulfill({ status: 503, body: '' });
  if (backup) backupCalls++;
  else if (kind === 'routing') {
    routingCalls++;
    const points = u.pathname.split('/').pop().split(';');
    lastRoutingPoints = points.length;
    const [lon, lat] = points[0].split(',').map(Number);
    lastRoutingStart = { lat, lon };
    lastRoutingQuery = u.search;
  }
  const mode = backup ? servers.backup ?? servers.routing : servers[kind];
  if (mode === 'hang') return; // accepted, never answered
  if (mode === 'down') return r.abort('internetdisconnected');
  if (kind === 'search') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ display_name: 'Richmond, Virginia, United States', lat: '37.5407', lon: '-77.436' }]) });
  const [lon, lat] = u.pathname.split('/').pop().split(';')[0].split(',').map(Number);
  return r.fulfill({ status: 200, contentType: 'application/json', body: servers.taconic ? taconicFrom({ lat, lon }) : osrmFrom({ lat, lon }) });
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
    /// The same, yielding between fixes as a real GPS does, so a request started by one fix can finish.
    window.__driveOn = async (seconds, speed = 30) => {
      for (let k = 0; k < seconds; k++) { window.__drive(1, speed); await new Promise((r) => setTimeout(r, 15)); }
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
// Storage full for the trip record while the new route is saved: the route saved before must stay with its
// record, so the trip still resumes.
const savedBefore = await app(() => JSON.parse(localStorage.getItem('ea.active')).routeId);
await app(() => { window.__activeFull = true; });
await app(() => window.__park(40, 1500));
await until(() => !window.exitAtlas.isRerouting);
s = await state();
check(await app((id) => window.exitAtlas.plan.route.id !== id, oldRoute) && routingCalls - before === 1, `rerouted with one request (${routingCalls - before})`);
await app(() => window.dispatchEvent(new Event('pagehide')));
const kept = await app(() => ({ record: JSON.parse(localStorage.getItem('ea.active')).routeId, route: JSON.parse(localStorage.getItem('ea.activeRoute'))?.id }));
check(kept.record === savedBefore && kept.route === savedBefore, `with storage full, the saved trip keeps its own route (${kept.record} / ${kept.route})`);
await app(() => { window.__activeFull = false; window.dispatchEvent(new Event('pagehide')); });
const now = await app(() => ({ record: JSON.parse(localStorage.getItem('ea.active')).routeId, route: JSON.parse(localStorage.getItem('ea.activeRoute'))?.id, plan: window.exitAtlas.plan.route.id }));
check(now.record === now.plan && now.route === now.plan, 'once there is room, the new route and its record are saved together');
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
// Outside the storage full stretch of section 7 (where a route is put back and written again on purpose).
const routeWrites = await app(() => window.__writes.filter((w) => w.key === 'ea.activeRoute' && !w.full).map((w) => w.id));
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
dialogs.length = 0;
await tap('#end');
await page.waitForTimeout(300);
check(dialogs.length === 0 && await app(() => window.exitAtlas.mode === 'idle'), 'a simulated drive ends at once, without asking');
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

// 13. End: on a real trip the driver is asked first (one mis tap must not end it). No keeps the trip going;
//     yes ends it: nothing left to resume, the trip is in history.
dialogs.length = 0;
answerYes = false;
await tap('#end');
await page.waitForTimeout(300);
check(dialogs.join() === 'End this trip? It cannot be resumed after this.' && await app(() => window.exitAtlas.mode === 'trip' && Boolean(localStorage.getItem('ea.active'))),
  `ending a real trip asks first, and no keeps it going (${dialogs.join() || 'nothing asked'})`);
answerYes = true;
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

// 15. A trip planned from another start, through a stop, then ended. Home from "Where to?" plans the next trip
//     from the current location with no stops; a stop the driver sets for the new trip is kept.
const place = (name, lat, lon) => ({ name, coordinate: { lat, lon } });
await app(([home, from, stop, to]) => {
  const a = window.exitAtlas;
  a.places.home = home;
  Object.assign(a.planner, { from, stops: [stop], to, results: [] });
  document.querySelector('.tabbar [data-arg="trip"]').click();
}, [place('Home, Yonkers', 40.9312, -73.8988), place('Newark, NJ', 40.7357, -74.1724), place('Trenton, NJ', 40.2206, -74.7597), place('Richmond, Virginia', 37.5407, -77.436)]);
await page.waitForSelector('[data-act="find-routes"]:not([disabled])');
await tap('[data-act="find-routes"]');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 });
const planned = lastRoutingPoints;
await tap('[data-act="start-route"][data-arg="0"]');
await tap('#end');
await page.waitForTimeout(300);
await page.waitForSelector('[data-act="go-to"][data-arg="home"]', { timeout: 5000 });
await tap('[data-act="go-to"][data-arg="home"]');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 }).catch(() => {});
const nearTimesSquare = (c) => c && Math.abs(c.lat - 40.758) < 0.001 && Math.abs(c.lon + 73.9855) < 0.001;
check(planned === 3 && lastRoutingPoints === 2 && nearTimesSquare(lastRoutingStart),
  `after a trip, Home is planned from the current location with no stops (${lastRoutingPoints} points from ${JSON.stringify(lastRoutingStart)})`);
await app((stop) => {
  const a = window.exitAtlas;
  a.planner.stops = [stop];
  a.tab = 'drive';
  document.querySelector('.tabbar [data-arg="drive"]').click();
}, place('Trenton, NJ', 40.2206, -74.7597));
await page.waitForSelector('[data-act="go-to"]:not([data-arg="home"])', { timeout: 5000 });
await tap('[data-act="go-to"]:not([data-arg="home"])');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 }).catch(() => {});
check(lastRoutingPoints === 3 && nearTimesSquare(lastRoutingStart), `a stop set for the new trip is kept (${lastRoutingPoints} points)`);

// 16. Yonkers to the Berkshires on the Taconic State Parkway (recorded OSRM answers, Fixtures/reroute). The route
//     from Briarcliff Manor leaves the Taconic at the NY 82 exit; the driver passes that exit and keeps on the
//     Taconic. The reroute is one request, with alternatives, and its route stays on the Taconic: 30 miles on, past
//     the US 44 exit the fastest would take and the exits after it, the driver is still on the route, with no other
//     request, no exit to take on the screen, and "New route." said once.
servers.taconic = true;
const MI = 1609.344;
await app(([from, to]) => {
  const a = window.exitAtlas;
  Object.assign(a.planner, { from, stops: [], to, results: [] });
  window.__spoken = [];
  a.announcer.speaker = (t) => window.__spoken.push(t);
  document.querySelector('.tabbar [data-arg="trip"]').click();
}, [place('Taconic State Parkway, Briarcliff Manor', BRIARCLIFF.lat, BRIARCLIFF.lon), place('Lenox, MA', 42.3565, -73.2848)]);
await page.waitForSelector('[data-act="find-routes"]:not([disabled])');
const planCalls = routingCalls;
await tap('[data-act="find-routes"]');
await page.waitForSelector('[data-act="start-route"]', { timeout: 8000 });
await tap('[data-act="start-route"][data-arg="0"]');
// The driver: the last 3 km of the Taconic before the NY 82 exit, then straight on along the Taconic as recorded
// from 600 m past the exit.
await app((ahead) => import('./js/engine/geo.js').then(({ RoutePolyline }) => {
  const route = window.exitAtlas.plan.route, ramp = route.steps[1].startDistance;
  window.__route = { polyline: new RoutePolyline([...route.polyline.slice(ramp - 3000, ramp).points, ...ahead]) };
  window.__gps.d = 0;
}), decodePolyline(pastNY82.routes[1].geometry, 6));
const frame = () => app(() => new Promise((r) => requestAnimationFrame(() => r())));
await app(() => window.__drive(90, 28));
await frame();
check((await state()).status === 'onRoute' && /Take Exit 43A toward NY-82 N/.test(await view()) && routingCalls - planCalls === 1,
  'from Briarcliff Manor the route says to take the NY 82 exit, by its number (Exit 43A)');
before = routingCalls;
await app(() => window.__driveOn(60, 28));
await until(() => !window.exitAtlas.isRerouting);
const rerouted = await app(async () => {
  const a = window.exitAtlas, r = a.plan.route;
  const { nextManeuver } = await import('./js/engine/guidance.js');
  return { first: r.steps[0].roadName, next: nextManeuver(r, a.snapshot.progress), status: a.snapshot.match.status };
});
check(routingCalls - before === 1 && /alternatives=3/.test(lastRoutingQuery) && /bearings=\d+,45;$/.test(lastRoutingQuery),
  `passing the exit on the Taconic: one reroute request, with alternatives and the course (${routingCalls - before}: ${lastRoutingQuery.slice(-40)})`);
check(rerouted.first === 'Taconic State Parkway' && rerouted.next.distance > 49 * MI && rerouted.status === 'onRoute',
  `the new route stays on the Taconic (${rerouted.next.text} in ${(rerouted.next.distance / MI).toFixed(1)} mi)`);
// 30 miles on along the Taconic, checking every fix: on the route, and no maneuver within 10 miles (the guidance
// banner's own rule); the screen checked every mile.
const onTaconic = { fixes: 0, off: 0, told: [], screens: 0 };
for (let k = 0; k < 30; k++) {
  const part = await app(async (mile) => {
    const { nextManeuver } = await import('./js/engine/guidance.js');
    const out = { fixes: 0, off: 0, told: [] };
    for (let n = 0; n < Math.round(mile / 28); n++) {
      window.__drive(1, 28);
      const a = window.exitAtlas, s = a.snapshot;
      out.fixes++;
      if (s.match.status !== 'onRoute') out.off++;
      const m = nextManeuver(a.plan.route, s.progress, { within: 10 * mile });
      if (m) out.told.push(m.text);
    }
    return out;
  }, MI);
  onTaconic.fixes += part.fixes;
  onTaconic.off += part.off;
  onTaconic.told.push(...part.told);
  await frame();
  if (/Take the exit|Take Exit/.test(await view())) onTaconic.screens++;
}
const spokenNew = await app(() => window.__spoken.filter((t) => t === 'New route.').length);
check(onTaconic.off === 0 && onTaconic.told.length === 0 && onTaconic.screens === 0 && routingCalls - before === 1,
  `30 miles on along the Taconic: on the route at all ${onTaconic.fixes} fixes, no exit to take (${onTaconic.told[0] ?? 'none'}), no other request (${routingCalls - before} in all)`);
check(spokenNew === 1, `"New route." said once (${spokenNew})`);
servers.taconic = false;

if (errors.length) fail(`page errors: ${errors.join('; ')}`);
await browser.close();
server.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Trip: every check passed');
