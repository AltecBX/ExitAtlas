// Road alert fetching (app/roadalerts.js) against fake National Weather Service answers: polite request
// rates when the service fails, alerts for where the driver is now, storm warnings between the sample
// points, and simulated alerts that never outlive the demo. Events are simulated; no live calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, data } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { roadIntel } from '../js/engine/roadintel.js';
import { RoadAlerts } from '../js/app/roadalerts.js';

const r = route('richmond_to_nyc_via_pa');
const plan = new TripPlan(r, { states: data.states });
const START = 1793231600;

/// A fake fetch: NWS answers come from `nws(url)`; every other host (work zone feeds) answers with an empty,
/// current feed. Counts NWS calls.
function fakeFetch(clock, nws) {
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    let status = 200, body;
    if (u.includes('api.weather.gov')) {
      calls.push(u);
      const reply = nws(u);
      status = reply.status ?? 200;
      body = reply.body ?? { features: [] };
    } else {
      body = { feed_info: { update_date: new Date(clock() * 1000).toISOString().replace(/\.\d+Z$/, 'Z') }, features: [] };
    }
    const text = JSON.stringify(body);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  return { calls, fetchFn };
}

/// An NWS alert feature (no polygon unless `rings` is given).
function nwsAlert(id, event, { severity = 'Moderate', rings = null, now = START } = {}) {
  return {
    id: `https://api.weather.gov/alerts/${id}`,
    geometry: rings ? { type: 'Polygon', coordinates: rings } : null,
    properties: {
      id, event, status: 'Actual', severity, headline: `${event} (test)`, areaDesc: 'Test County',
      sent: new Date((now - 600) * 1000).toISOString(), effective: new Date((now - 600) * 1000).toISOString(),
      onset: new Date((now - 600) * 1000).toISOString(), expires: new Date((now + 6 * 3600) * 1000).toISOString(),
      ends: new Date((now + 12 * 3600) * 1000).toISOString(),
    },
  };
}

const pointOf = (u) => {
  const m = /[?&]point=([-\d.]+),([-\d.]+)/.exec(u);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
};

test('a failing weather service is asked again only after the backoff, even after a long move', async () => {
  let now = START;
  let failing = false;
  const fake = fakeFetch(() => now, () => (failing ? { status: 503, body: {} } : { body: { features: [] } }));
  const ra = new RoadAlerts({ fetchFn: fake.fetchFn, clock: () => now });
  const speed = (65 * MILE) / 3600;
  let progress = 10 * MILE;
  await ra.refresh(plan, progress);
  const first = fake.calls.length;
  assert.ok(first > 0, 'asked at the start of the trip');
  failing = true;
  // Half an hour at 65 mph, one position a second: well over 20 miles past the last good answer.
  for (let t = 0; t < 1800; t++) {
    now += 1;
    progress += speed;
    await ra.refresh(plan, progress);
  }
  const failed = fake.calls.length - first;
  // Every 10 minutes plus the backoff (1, 2, 4, 8 minutes...): a handful of requests, never one per position.
  assert.ok(failed <= 12, `${failed} requests to a failing service in 30 minutes`);
  assert.ok(failed >= 1, 'still tries again');
  // Not an all clear: the old answer is shown until it is 30 minutes old, then the source is unavailable.
  now += 60;
  const status = roadIntel(r, progress, ra.providers(), { now }).status.weather;
  assert.equal(status.state, 'unavailable');
});

test('a zone alert where the driver is stays on screen as the driver moves on, not a few seconds later gone', async () => {
  const now = START;
  // Returned only at the first sample point (where the driver is): a county alert without a polygon.
  const fog = nwsAlert('fog-here', 'Dense Fog Advisory', { severity: 'Minor' });
  let first = null;
  const fake = fakeFetch(() => now, (u) => {
    const p = pointOf(u);
    if (!p) return { body: { features: [] } };
    first ??= p;
    return { body: { features: p.lat === first.lat && p.lon === first.lon ? [fog] : [] } };
  });
  const ra = new RoadAlerts({ fetchFn: fake.fetchFn, clock: () => now });
  const at = 40 * MILE;
  await ra.refresh(plan, at);
  const here = roadIntel(r, at, ra.providers(), { now });
  assert.equal(here.alerts.length, 1, 'shown at the point it was asked for');
  assert.ok(Math.abs(here.alerts[0].ahead) < 1);
  // Half a mile and five miles on, before the next refresh: still where the driver is, not gone.
  for (const moved of [0.5, 5]) {
    const out = roadIntel(r, at + moved * MILE, ra.providers(), { now });
    assert.equal(out.alerts.length, 1, `${moved} mi on`);
    assert.ok(Math.abs(out.alerts[0].ahead) < 1, `${moved} mi on: here, not ${out.alerts[0].ahead / MILE} mi ahead`);
    assert.ok(out.alerts[0].approximate);
  }
  // Far past the last place it was reported (more than half the spacing between sample points): not claimed.
  assert.equal(roadIntel(r, at + 20 * MILE, ra.providers(), { now }).alerts.length, 0);
});

test('a zone alert at the driver and 25 miles on is here, not 25 miles ahead', async () => {
  const now = START;
  const wind = nwsAlert('wind-wide', 'Wind Advisory', { severity: 'Minor' });
  let n = 0;
  const fake = fakeFetch(() => now, (u) => (pointOf(u) ? { body: { features: n++ < 2 ? [wind] : [] } } : { body: { features: [] } }));
  const ra = new RoadAlerts({ fetchFn: fake.fetchFn, clock: () => now });
  const at = 40 * MILE;
  await ra.refresh(plan, at);
  const out = roadIntel(r, at + 3 * MILE, ra.providers(), { now });
  assert.equal(out.alerts.length, 1);
  assert.ok(Math.abs(out.alerts[0].ahead) < 1, `${out.alerts[0].ahead / MILE} mi ahead`);
});

test('a storm warning polygon between the sample points is found by the state query', async () => {
  const now = START;
  const at = 40 * MILE;
  // A narrow snow squall warning across the route about 10 to 14 miles ahead: no sample point (every 25 mi) is in it.
  const c1 = r.polyline.coordinateAt(at + 10 * MILE), c2 = r.polyline.coordinateAt(at + 14 * MILE);
  const pad = 0.03;
  const ring = [[Math.min(c1.lon, c2.lon) - pad, Math.min(c1.lat, c2.lat) - pad], [Math.max(c1.lon, c2.lon) + pad, Math.min(c1.lat, c2.lat) - pad],
    [Math.max(c1.lon, c2.lon) + pad, Math.max(c1.lat, c2.lat) + pad], [Math.min(c1.lon, c2.lon) - pad, Math.max(c1.lat, c2.lat) + pad],
    [Math.min(c1.lon, c2.lon) - pad, Math.min(c1.lat, c2.lat) - pad]];
  const squall = nwsAlert('squall', 'Snow Squall Warning', { severity: 'Severe', rings: [ring] });
  const inRing = (p) => p.lon >= ring[0][0] && p.lon <= ring[1][0] && p.lat >= ring[0][1] && p.lat <= ring[2][1];
  const fake = fakeFetch(() => now, (u) => {
    const p = pointOf(u);
    if (p) return { body: { features: inRing(p) ? [squall] : [] } };
    // The state query: every active alert of the listed events in the listed states.
    const q = new URL(u).searchParams;
    assert.ok(q.get('area'), 'names the states ahead');
    assert.ok(q.get('event').split(',').includes('Snow Squall Warning'));
    return { body: { features: [squall] } };
  });
  const ra = new RoadAlerts({ fetchFn: fake.fetchFn, clock: () => now });
  await ra.refresh(plan, at);
  const sampled = fake.calls.filter((u) => pointOf(u)).map(pointOf);
  assert.ok(sampled.length > 1 && !sampled.some(inRing), 'no sample point falls in the warning');
  const area = fake.calls.filter((u) => !pointOf(u));
  assert.equal(area.length, 1, 'one state query per refresh');
  assert.match(area[0], /area=VA(%2C|,)/, 'the states within 150 miles ahead, Virginia first');
  const out = roadIntel(r, at, ra.providers(), { now });
  const a = out.alerts.find((x) => x.incident.id === 'nws:squall');
  assert.ok(a, 'the warning is on the route ahead');
  // Starts where the route enters the polygon (before the first sample point inside 25 miles).
  assert.ok(a.ahead / MILE > 5 && a.ahead / MILE <= 10, `starts ${a.ahead / MILE} mi ahead`);
  assert.ok(inRing(r.polyline.coordinateAt(a.start)) && !inRing(r.polyline.coordinateAt(a.start - 0.1 * MILE)), 'at the edge of the polygon');
  assert.ok(!a.approximate, 'a polygon has a known extent');
  assert.ok(a.serious);
});

test('the simulated demo alert is gone after the demo ends', () => {
  const ra = new RoadAlerts({ fetchFn: async () => { throw new Error('offline'); } });
  ra.demoIncidents = [{ id: 'demo:crash', category: 'crash', source: { id: 'demo', name: 'Simulated test alert' } }];
  assert.ok(ra.providers().some((p) => p.id === 'demo'));
  ra.reset();
  assert.ok(!ra.providers().some((p) => p.id === 'demo'), 'a new trip has no simulated source');
  const status = roadIntel(r, 0, ra.providers(), { now: START }).status.incidents;
  assert.equal(status.state, 'notConfigured', 'crashes stay "No source connected", never "No relevant reports" from a simulation');
});
