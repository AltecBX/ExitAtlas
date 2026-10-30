// Routing and place search requests give up after a time limit with a plain reason. A request that never
// answered (a dead zone, a stalled server) left "Finding routes" disabled and "Rerouting" up for good, and no
// later reroute could start. When the OSRM demo server fails, the FOSSGIS server (same API) is asked once; the
// driver hears of it only when both fail. The one time fix for planning from here says in plain words why it failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodePolyline } from '../js/engine/geo.js';

globalThis.document = { baseURI: 'http://127.0.0.1/web/' };
const { fetchRoutes, searchPlaces, currentPosition, REQUEST_TIMEOUT, POSITION_PROBLEMS, ROUTING_SERVERS, ROUTING_SPACING } = await import('../js/app/services.js');
// One request per second per server is checked on its own below; elsewhere the tests do not wait for it.
ROUTING_SPACING.ms = 0;

const here = { name: 'Yonkers, NY', coordinate: { lat: 40.9312, lon: -73.8988 } };
const there = { name: 'Richmond, VA', coordinate: { lat: 37.5407, lon: -77.436 } };
const realFetch = globalThis.fetch;
const PRIMARY = 'https://router.project-osrm.org/route/v1/driving/';
const BACKUP = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';

/// A server that accepts the request and never answers (the signal is ignored on purpose: the time limit
/// must hold even when a browser does not cancel a stalled body read).
const never = () => new Promise(() => {});
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const OK = { code: 'Ok', routes: [{ geometry: encodePolyline([here.coordinate, there.coordinate], 6), duration: 20000,
  legs: [{ annotation: { duration: [20000] }, steps: [] }] }] };
const down = async () => { throw new TypeError('Load failed'); };
/// A fake network: `primary` and `backup` say how each server answers; every URL asked is kept.
function servers(primary, backup) {
  const asked = [];
  globalThis.fetch = async (url, opts) => {
    asked.push(String(url));
    return (String(url).startsWith(PRIMARY) ? primary : backup)(url, opts);
  };
  return asked;
}

test('the time limits are long enough for the OSRM demo server and short enough to retry', () => {
  assert.equal(REQUEST_TIMEOUT.routing, 25000);
  assert.equal(REQUEST_TIMEOUT.search, 15000);
  assert.deepEqual(ROUTING_SERVERS.map((x) => x.base), [PRIMARY, BACKUP]);
});

test('a routing request that never answers fails after the time limit, on both servers, with a plain reason', async () => {
  servers(never, never);
  try {
    const t0 = Date.now();
    await assert.rejects(fetchRoutes([here, there], { timeout: 300 }),
      /^Error: the routing server did not answer within .*, and the backup routing server did not answer within/);
    assert.ok(Date.now() - t0 < 2000);
    await assert.rejects(fetchRoutes([here, there], { timeout: 1000 }),
      { message: 'the routing server did not answer within 1 second, and the backup routing server did not answer within 1 second' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a routing answer whose body never arrives also fails after the time limit', async () => {
  const stalled = async () => ({ ok: true, status: 200, json: never });
  servers(stalled, stalled);
  try {
    await assert.rejects(fetchRoutes([here, there], { timeout: 300 }), /did not answer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the time limit aborts the request, and no connection reads as no connection', async () => {
  const signals = [];
  globalThis.fetch = (url, opts) => { signals.push(opts.signal); return never(); };
  try {
    await assert.rejects(fetchRoutes([here, there], { timeout: 200 }));
    assert.equal(signals.length, 2);
    assert.ok(signals.every((x) => x.aborted));
    servers(down, down);
    await assert.rejects(fetchRoutes([here, there]), { message: 'the routing servers could not be reached (no connection, or both are busy)' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the backup server answers when the first fails, with the same request and nothing to tell the driver', async () => {
  try {
    const cases = [['no connection', down], ['no answer in time', never], ['HTTP 503', async () => answer(503, null)],
      ['HTTP 429', async () => answer(429, { message: 'Too many requests' })], ['HTTP 502, not JSON', async () => answer(502, undefined)]];
    for (const [why, primary] of cases) {
      const asked = servers(primary, async () => answer(200, OK));
      const routes = await fetchRoutes([here, there], { timeout: 300, bearing: 190 });
      assert.equal(routes.length, 1, why);
      assert.equal(asked.length, 2, why);
      assert.ok(asked[0].startsWith(PRIMARY) && asked[1].startsWith(BACKUP), why);
      assert.equal(asked[1].slice(BACKUP.length), asked[0].slice(PRIMARY.length), `${why}: the same request`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the backup is not asked when the first server answers, even with no route', async () => {
  try {
    let asked = servers(async () => answer(200, OK), async () => answer(200, OK));
    await fetchRoutes([here, there]);
    assert.equal(asked.length, 1);
    asked = servers(async () => answer(400, { code: 'NoRoute', message: 'No route found' }), async () => answer(200, OK));
    await assert.rejects(fetchRoutes([here, there]), { message: 'No route found' });
    assert.equal(asked.length, 1);
    asked = servers(async () => answer(400, { code: 'NoSegment', message: 'Could not find a matching segment for any coordinate' }), async () => answer(200, OK));
    await assert.rejects(fetchRoutes([here, there]), /segment/);
    assert.equal(asked.length, 1);
    // The backup's own answer stands when the first was down.
    asked = servers(down, async () => answer(400, { code: 'NoRoute', message: 'No route found' }));
    await assert.rejects(fetchRoutes([here, there]), { message: 'No route found' });
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('when both servers fail the reason names both', async () => {
  try {
    servers(async () => answer(502, null), async () => answer(503, null));
    await assert.rejects(fetchRoutes([here, there]), { message: 'routing server error (HTTP 502), and the backup failed too (HTTP 503)' });
    servers(never, down);
    await assert.rejects(fetchRoutes([here, there], { timeout: 1000 }),
      { message: 'the routing server did not answer within 1 second, and the backup routing server could not be reached (no connection, or the server is busy)' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cancelling a routing request still reads as cancelled, and the backup is not asked', async () => {
  const cancellable = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  const asked = servers(cancellable, async () => answer(200, OK));
  try {
    const ctl = new AbortController();
    const p = fetchRoutes([here, there], { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(asked.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('each routing server is asked at most once a second', async () => {
  const times = [];
  const who = (url) => (String(url).startsWith(PRIMARY) ? 'primary' : 'backup');
  ROUTING_SPACING.ms = 1000;
  try {
    globalThis.fetch = async (url) => { times.push([who(url), Date.now()]); return answer(200, OK); };
    await fetchRoutes([here, there]);
    await fetchRoutes([here, there]);
    globalThis.fetch = async (url) => { times.push([who(url), Date.now()]); if (who(url) === 'primary') throw new TypeError('Load failed'); return answer(200, OK); };
    await fetchRoutes([here, there]);
    await fetchRoutes([here, there]);
    for (const w of ['primary', 'backup']) {
      const t = times.filter((x) => x[0] === w).map((x) => x[1]);
      for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 990, `${w}: ${t[i] - t[i - 1]} ms apart`);
    }
    assert.equal(times.filter((x) => x[0] === 'backup').length, 2);
  } finally {
    ROUTING_SPACING.ms = 0;
    globalThis.fetch = realFetch;
  }
});

test('routing calls that arrive together still go out a second apart, and a cancelled one sends nothing', async () => {
  const times = [];
  ROUTING_SPACING.ms = 1000;
  try {
    globalThis.fetch = async () => { times.push(Date.now()); return answer(200, OK); };
    await fetchRoutes([here, there]); // takes the slot now
    await Promise.all([fetchRoutes([here, there]), fetchRoutes([here, there]), fetchRoutes([here, there])]);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 990, `${times[i] - times[i - 1]} ms apart`);
    const ctl = new AbortController();
    const asked = times.length;
    const waiting = fetchRoutes([here, there], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(waiting, (e) => e.name === 'AbortError');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(times.length, asked, 'a call cancelled while it waited was sent anyway');
  } finally {
    ROUTING_SPACING.ms = 0;
    globalThis.fetch = realFetch;
  }
});

test('the backup server\'s terms: OpenStreetMap credit with a link to report map errors, and the server named', () => {
  const views = readFileSync(new URL('../js/app/views.js', import.meta.url), 'utf8');
  const at = views.indexOf('export function attribution');
  const credit = views.slice(at, at + 800);
  assert.match(credit, /https:\/\/www\.openstreetmap\.org\/copyright/);
  assert.match(credit, /https:\/\/www\.openstreetmap\.org\/fixthemap/);
  assert.match(views, /<b>Routing:<\/b>[^<]*routing\.openstreetmap\.de/);
});

test('a place search that never answers fails after the time limit', async () => {
  globalThis.fetch = never;
  try {
    await assert.rejects(searchPlaces('Richmond', null, { timeout: 300 }), /^Error: the place search server did not answer within/);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(searchPlaces('Richmond'), { message: 'the place search server could not be reached (no connection, or the server is busy)' });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ display_name: 'Richmond, Virginia, United States', lat: '37.54', lon: '-77.43' }] });
    const rows = await searchPlaces('Richmond');
    assert.equal(rows[0].name, 'Richmond, Virginia');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('planning from here: no fix, a denied permission or a timeout says what to do, not a system message', async () => {
  const answerFix = (code, message) => Object.defineProperty(globalThis.navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: (ok, err) => (code ? err({ code, message }) : ok({ coords: { latitude: 40.93, longitude: -73.9 } })),
  } });
  answerFix(1, 'User denied Geolocation');
  await assert.rejects(currentPosition(), { message: POSITION_PROBLEMS[1] });
  answerFix(2, 'The operation couldn’t be completed. (kCLErrorDomain error 0.)');
  await assert.rejects(currentPosition(), { message: 'your location is not available right now. Choose a start place, or try again' });
  answerFix(3, 'Timeout expired');
  await assert.rejects(currentPosition(), { message: 'your location was not found within 20 seconds. Choose a start place, or try again' });
  answerFix(0);
  assert.deepEqual(await currentPosition(), { lat: 40.93, lon: -73.9 });
  for (const text of Object.values(POSITION_PROBLEMS)) assert.doesNotMatch(text, /[-–—]/, 'house style: no hyphens or dashes');
  assert.match(POSITION_PROBLEMS[1], /choose a start place/);
});
