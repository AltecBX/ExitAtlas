// Requests that stall (a dead zone, a tower handoff) fail after a timeout and go through each source's
// backoff, instead of keeping the source busy for the rest of the trip. Never a "none" or an all clear.
// Fake servers that never answer; no live calls. Without the timeouts these tests would wait forever, so each
// has its own 5 second limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, data } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { roadIntel } from '../js/engine/roadintel.js';
import { withTimeout } from '../js/app/net.js';
import { RoadAlerts } from '../js/app/roadalerts.js';
import { LiveWeather } from '../js/app/weather.js';
import { SpeedLimits } from '../js/app/limits.js';
import { fetchChargers } from '../js/app/chargers.js';
import { alertStatus, alertEmptyTitle } from '../js/app/views.js';

const START = 1793231600;
/// A server that never answers. It records the abort signal it was given.
function stalled() {
  const signals = [];
  const fetchFn = (url, opts = {}) => { signals.push(opts.signal); return new Promise(() => {}); };
  return { signals, fetchFn };
}

test('withTimeout: the answer when it comes in time; else an error, and the request is aborted', async () => {
  assert.equal(await withTimeout(async () => 7, 50), 7);
  let signal = null;
  await assert.rejects(withTimeout((s) => { signal = s; return new Promise(() => {}); }, 30), /no answer in 0 s/);
  assert.equal(signal.aborted, true);
  await assert.rejects(withTimeout(async () => { throw new Error('HTTP 503'); }, 50), /HTTP 503/);
});

test('road alerts: a stalled NWS or work zone request is a failure, shown as unavailable, then retried after the backoff', { timeout: 5000 }, async () => {
  const r = route('miami_to_manhattan');
  const plan = new TripPlan(r, { states: data.states });
  let now = START;
  const server = stalled();
  const ra = new RoadAlerts({ fetchFn: server.fetchFn, clock: () => now, timeoutMs: 30 });
  const at = 1000 * MILE; // Delaware ahead: its work zone feed is read directly
  const done = await ra.refresh(plan, at);
  assert.equal(done, true, 'the refresh finished instead of waiting forever');
  assert.ok(server.signals.every((s) => s?.aborted), 'every stalled request was aborted');
  const nws = ra.sources.nws;
  assert.equal(nws.busy, false);
  assert.equal(nws.state, 'error');
  assert.match(nws.error, /no answer/);
  assert.equal(nws.nextAt, now + 120, 'backoff after the first failure');
  assert.equal(ra.wzdx.DE.state, 'error');
  const intel = roadIntel(r, at, ra.providers(), { now });
  assert.equal(intel.status.weather.state, 'unavailable');
  assert.equal(intel.status.closures.state, 'unavailable');
  assert.doesNotMatch(alertStatus(intel), /none from connected sources/);
  assert.equal(alertEmptyTitle(intel, 50), 'Some alert sources are unavailable');
  // Not asked again on every position while backing off; asked again once it is over.
  const calls = server.signals.length;
  now += 60;
  await ra.refresh(plan, at + 2 * MILE);
  assert.equal(server.signals.length, calls);
  now += 61;
  await ra.refresh(plan, at + 4 * MILE);
  assert.ok(server.signals.length > calls);
});

test('weather: a stalled request ends the refresh, backs off and shows nothing rather than an old answer', { timeout: 5000 }, async () => {
  let now = START;
  const server = stalled();
  const w = new LiveWeather({ fetchFn: server.fetchFn, clock: () => now, timeoutMs: 30 });
  const here = { lat: 39.95, lon: -75.16 };
  assert.equal(await w.refresh(here), true);
  assert.equal(w.busy, false);
  assert.equal(w.failures, 1);
  assert.equal(w.current(here), null);
  const calls = server.signals.length;
  now += 30;
  await w.refresh(here);
  assert.equal(server.signals.length, calls, 'backing off');
});

test('speed limits: a stalled request fails and backs off; three in a row show the limit as unknown', { timeout: 5000 }, async () => {
  const r = route('atlanta_to_nashville');
  let now = 0;
  const server = stalled();
  const limits = new SpeedLimits(r, { fetchImpl: server.fetchFn, now: () => now, timeoutMs: 30 });
  await limits.ensureAhead(0);
  assert.equal(limits.pending, null, 'not stuck waiting');
  assert.equal(limits.failures, 1);
  assert.equal(limits.state(0), 'loading');
  for (const wait of [15000, 30000]) { now += wait; await limits.ensureAhead(0); }
  assert.equal(server.signals.length, 3);
  assert.equal(limits.state(0), 'unknown');
  assert.equal(limits.at(0), null);
});

test('chargers: a stalled search fails, so it is retried later instead of loading forever', { timeout: 5000 }, async () => {
  const r = route('atlanta_to_nashville');
  await assert.rejects(fetchChargers(r.polyline, { fetchImpl: stalled().fetchFn, timeoutMs: 30 }), /no answer/);
});
