// Routing and place search requests give up after a time limit with a plain reason. A request that never
// answered (a dead zone, a stalled server) left "Finding routes" disabled and "Rerouting" up for good, and no
// later reroute could start.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { baseURI: 'http://127.0.0.1/web/' };
const { fetchRoutes, searchPlaces, REQUEST_TIMEOUT } = await import('../js/app/services.js');

const here = { name: 'Yonkers, NY', coordinate: { lat: 40.9312, lon: -73.8988 } };
const there = { name: 'Richmond, VA', coordinate: { lat: 37.5407, lon: -77.436 } };
const realFetch = globalThis.fetch;

/// A server that accepts the request and never answers (the signal is ignored on purpose: the time limit
/// must hold even when a browser does not cancel a stalled body read).
const never = () => new Promise(() => {});

test('the time limits are long enough for the OSRM demo server and short enough to retry', () => {
  assert.equal(REQUEST_TIMEOUT.routing, 25000);
  assert.equal(REQUEST_TIMEOUT.search, 15000);
});

test('a routing request that never answers fails after the time limit with a plain reason', async () => {
  globalThis.fetch = never;
  try {
    const t0 = Date.now();
    await assert.rejects(fetchRoutes([here, there], { timeout: 300 }), /^Error: the routing server did not answer within/);
    assert.ok(Date.now() - t0 < 2000);
    await assert.rejects(fetchRoutes([here, there], { timeout: 1000 }), { message: 'the routing server did not answer within 1 second' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a routing answer whose body never arrives also fails after the time limit', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: never });
  try {
    await assert.rejects(fetchRoutes([here, there], { timeout: 300 }), /did not answer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the time limit aborts the request, and no connection reads as no connection', async () => {
  let signal = null;
  globalThis.fetch = (url, opts) => { signal = opts.signal; return never(); };
  try {
    await assert.rejects(fetchRoutes([here, there], { timeout: 200 }));
    assert.equal(signal.aborted, true);
    globalThis.fetch = async () => { throw new TypeError('Load failed'); };
    await assert.rejects(fetchRoutes([here, there]), { message: 'the routing server could not be reached (no connection, or the server is busy)' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cancelling a routing request still reads as cancelled, and server errors are unchanged', async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  try {
    const ctl = new AbortController();
    const p = fetchRoutes([here, there], { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, { name: 'AbortError' });
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ code: 'TooBig', message: 'Too many requests' }) });
    await assert.rejects(fetchRoutes([here, there]), { message: 'Too many requests' });
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not JSON'); } });
    await assert.rejects(fetchRoutes([here, there]), { message: 'routing server error (HTTP 502)' });
  } finally {
    globalThis.fetch = realFetch;
  }
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
