// Weather ahead on the route, on real National Weather Service answers recorded on I-95 (web/tests/fixtures/
// weatherahead): the hour at the arrival time, warnings and quiet lines, stretches, "unavailable" (never clear)
// when a forecast is missing, old or does not reach the arrival time, and the fetcher's requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { METERS_PER_MILE as MILE, RoutePolyline } from '../js/engine/geo.js';
import { AHEAD_RULES, samplePoints, forecastAt, weatherLevel, weatherStretches, weatherAhead, aheadPhrase, coveredByAlert } from '../js/engine/weatherahead.js';
import { WeatherAhead } from '../js/app/weatherahead.js';
import { Announcer } from '../js/app/announcer.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/weatherahead');
const F = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const at = (iso) => Date.parse(iso) / 1000;
// Recorded at this time; NWS last updated these grids between 22:02 and 00:32 UTC.
const RECORDED = at('2026-11-05T03:26:30Z');
// The Nov 6 hours (rain and storms) read a day after the recording: this scenario widens only the "NWS last
// updated" limit, so the hour selection and the levels can be checked on real periods.
const NOV6 = { ...AHEAD_RULES, maxUpdateAge: 60 * 3600 };

test('the hour that contains the arrival time, with its kind and chance (real VA, NC, SC and GA hours)', () => {
  const now = at('2026-11-06T11:00:00Z'); // 6:00 AM Eastern
  const va = forecastAt(F('hourly_va.json'), at('2026-11-06T12:30:00Z'), now, now - 600, NOV6);
  assert.deepEqual([va.status, va.kind, va.chance, va.text], ['ok', 'thunder', 87, 'Showers And Thunderstorms']);
  assert.equal(weatherLevel(va, NOV6), 'warn');
  const nc = forecastAt(F('hourly_nc.json'), at('2026-11-06T14:10:00Z'), now, now - 600, NOV6);
  assert.deepEqual([nc.kind, nc.chance, weatherLevel(nc, NOV6), aheadPhrase(nc.kind, nc.chance)], ['showers', 84, 'warn', 'Showers']);
  const sc = forecastAt(F('hourly_sc.json'), at('2026-11-06T13:00:00Z'), now, now - 600, NOV6);
  assert.deepEqual([sc.kind, sc.chance, weatherLevel(sc, NOV6), aheadPhrase(sc.kind, sc.chance)], ['showers', 58, 'warn', 'Showers likely']);
  // 32%: a quiet line, not a warning.
  const ga = forecastAt(F('hourly_ga.json'), at('2026-11-06T19:20:00Z'), at('2026-11-06T18:00:00Z'), at('2026-11-06T17:50:00Z'), NOV6);
  assert.deepEqual([ga.kind, ga.chance, weatherLevel(ga, NOV6), aheadPhrase(ga.kind, ga.chance)], ['showers', 32, 'quiet', 'Chance of showers']);
  // "Chance Showers And Thunderstorms", 50%: any thunder is a warning.
  const sct = forecastAt(F('hourly_sc.json'), at('2026-11-06T18:30:00Z'), at('2026-11-06T17:00:00Z'), at('2026-11-06T16:55:00Z'), NOV6);
  assert.deepEqual([sct.kind, sct.chance, weatherLevel(sct, NOV6), aheadPhrase(sct.kind, sct.chance)], ['thunder', 50, 'warn', 'Chance of storms']);
});

test('fog is a warning, also when NWS draws a low chance rain icon for "Areas Of Fog" (real NC hours)', () => {
  const now = RECORDED;
  const six = forecastAt(F('hourly_nc.json'), at('2026-11-05T11:20:00Z'), now, now);
  assert.deepEqual([six.kind, weatherLevel(six), aheadPhrase(six.kind, six.chance)], ['fog', 'warn', 'Fog']);
  // 7 AM: "Areas Of Fog" with icon rain_showers,20 and a 15% chance.
  const seven = forecastAt(F('hourly_nc.json'), at('2026-11-05T12:20:00Z'), now, now);
  assert.equal(seven.text, 'Areas Of Fog');
  assert.deepEqual([seven.kind, weatherLevel(seven)], ['fog', 'warn']);
  // Mostly cloudy, 1%: nothing to flag.
  const clear = forecastAt(F('hourly_va.json'), at('2026-11-05T04:00:00Z'), now, now);
  assert.deepEqual([clear.status, clear.kind, weatherLevel(clear)], ['ok', 'mostlyCloudy', null]);
});

test('unavailable, never clear: no forecast, a copy fetched over 2 hours ago, NWS not updated in 12 hours, no hour for the arrival', () => {
  const now = RECORDED;
  const eta = now + 3600;
  for (const [w, reason] of [
    [forecastAt(null, eta, now, now), 'no forecast'],
    [forecastAt(F('hourly_va.json'), eta, now, now - 2 * 3600 - 1), 'forecast too old'],
    [forecastAt(F('hourly_va.json'), eta, now, null), 'forecast too old'],
    // A day later, NWS's last update (Nov 4, 23:38 UTC) is over 12 hours old.
    [forecastAt(F('hourly_va.json'), at('2026-11-06T12:30:00Z'), at('2026-11-06T11:00:00Z'), at('2026-11-06T10:55:00Z')), 'forecast too old'],
    // The periods end Nov 7, midnight Eastern.
    [forecastAt(F('hourly_va.json'), at('2026-11-07T06:00:00Z'), at('2026-11-06T22:00:00Z'), at('2026-11-06T21:55:00Z'), NOV6), 'no hour for the arrival time'],
  ]) {
    assert.equal(w.status, 'unavailable');
    assert.equal(w.reason, reason);
    assert.equal(weatherLevel(w), 'unavailable');
  }
});

test('an hour that has ended is never used: an arrival in the past reads the current hour', () => {
  const now = at('2026-11-05T09:30:00Z'); // 4:30 AM Eastern: NC "Patchy Fog" 4 to 5 AM
  const w = forecastAt(F('hourly_nc.json'), now - 2 * 3600, now, now);
  assert.deepEqual([w.status, w.start, w.text], ['ok', at('2026-11-05T09:00:00Z'), 'Patchy Fog']);
  assert.ok(w.end > now);
});

/// A point every 12 miles with a given forecast.
const pt = (mi, w, eta = 0) => ({ along: mi * MILE, eta, w });
const ok = (kind, chance, updated = 100) => ({ status: 'ok', kind, chance, text: null, start: 0, end: 1, updated });
const gone = { status: 'unavailable', reason: 'no forecast' };

test('stretches: consecutive points with the same level merge, the worst kind and highest chance win, clear points end them', () => {
  const points = [pt(0, ok('mostlyCloudy', 5)), pt(12, ok('showers', 30), 10), pt(24, ok('showers', 58, 90), 20), pt(36, ok('thunder', 50), 30),
    pt(48, gone, 40), pt(60, gone, 50), pt(72, ok('clear', 0), 60), pt(84, ok('fog', 4), 70)];
  const s = weatherStretches(points, 3 * MILE);
  assert.deepEqual(s.map((x) => [x.level, x.kind, x.chance, x.phrase, Math.round(x.start / MILE), Math.round(x.end / MILE), x.eta, x.etaEnd, x.points]), [
    ['quiet', 'showers', 30, 'Chance of showers', 6, 18, 10, 10, 1],
    ['warn', 'thunder', 58, 'Storms likely', 18, 42, 20, 30, 2],
    ['unavailable', null, null, 'Weather ahead unavailable', 42, 66, 40, 50, 2],
    ['warn', 'fog', 4, 'Fog', 78, 90, 70, 70, 1],
  ]);
  assert.equal(s[1].updated, 90, 'the oldest update of the points it merges');
  // The driver past a point's stretch: it is gone; inside one: it starts where the driver is.
  const later = weatherStretches(points, 20 * MILE);
  assert.deepEqual(later.map((x) => [x.level, Math.round(x.start / MILE)]), [['warn', 20], ['unavailable', 42], ['warn', 78]]);
});

test('the summary: warnings, quiet lines, unavailable stretches and how far the forecast was read', () => {
  const r = weatherAhead([pt(12, ok('showers', 30)), pt(24, ok('rain', 70)), pt(36, gone)], 10 * MILE);
  assert.deepEqual([r.warnings.length, r.quiet.length, r.unavailable.length, Math.round(r.coveredTo / MILE), r.checked, r.updated], [1, 1, 1, 42, 3, 100]);
  assert.equal(r.warnings[0].phrase, 'Rain likely');
  // Nothing read at all: every stretch unavailable, no warnings, never "clear".
  const none = weatherAhead([pt(12, gone), pt(24, gone)], 10 * MILE);
  assert.deepEqual([none.warnings.length, none.unavailable.length, Math.round(none.unavailable[0].start / MILE), Math.round(none.unavailable[0].end / MILE)], [0, 1, 10, 30]);
});

test('an NWS warning already on the route covers the same kind of forecast stretch, not others', () => {
  const fog = { kind: 'fog', start: 10 * MILE, end: 30 * MILE };
  const rain = { kind: 'showers', start: 10 * MILE, end: 30 * MILE };
  const alert = (description, start, end) => ({ start: start * MILE, end: end * MILE, incident: { category: 'weather', description } });
  assert.equal(coveredByAlert(fog, [alert('Dense Fog Advisory', 25, 60)]), true);
  assert.equal(coveredByAlert(fog, [alert('Dense Fog Advisory', 31, 60)]), false, 'not overlapping');
  assert.equal(coveredByAlert(rain, [alert('Dense Fog Advisory', 0, 60)]), false, 'another kind');
  assert.equal(coveredByAlert(rain, [alert('Severe Thunderstorm Warning', 0, 12)]), true);
  assert.equal(coveredByAlert(rain, [alert('Wind Advisory', 0, 60)]), false);
  assert.equal(coveredByAlert({ kind: null, start: 0, end: 1 }, [alert('Dense Fog Advisory', 0, 60)]), false, 'unavailable is never covered');
});

// The five recorded points as a route, Jacksonville FL to Emporia VA (about 450 miles).
const CITIES = { fl: [30.33, -81.66], ga: [31.15, -81.49], sc: [32.90, -80.66], nc: [34.62, -79.01], va: [36.69, -77.54] };
const route = { id: 'i95', polyline: new RoutePolyline(Object.values(CITIES).map(([lat, lon]) => ({ lat, lon }))) };
route.length = route.polyline.length;

test('points every 12 miles at fixed route positions, to 150 miles or 3 hours ahead', () => {
  const now = 1000;
  // 30 m/s, about 67 mph, from where the driver is.
  const etaFrom = (progress, speed = 30) => (d) => now + (d - progress) / speed;
  const p = samplePoints(route, 20 * MILE, etaFrom(20 * MILE), now);
  assert.deepEqual(p.map((x) => Math.round(x.along / MILE)), [24, 36, 48, 60, 72, 84, 96, 108, 120, 132, 144, 156, 168]);
  assert.ok(p.every((x) => x.eta >= now));
  // The point just behind the driver (its stretch still covers where they are) counts, at now.
  const q = samplePoints(route, 13 * MILE, etaFrom(13 * MILE), now);
  assert.deepEqual([Math.round(q[0].along / MILE), q[0].eta], [12, now]);
  // Slow traffic: 3 hours reached before 150 miles.
  const slow = samplePoints(route, 0, etaFrom(0, 8), now);
  assert.ok(slow.length < 13 && slow.every((x) => x.eta - now <= 3 * 3600), `${slow.length} points`);
  // Near the end of the route: the last point is the destination.
  const end = samplePoints(route, route.length - 20 * MILE, etaFrom(route.length - 20 * MILE), now);
  assert.equal(end[end.length - 1].along, route.length);
});

/// fetch on the recorded answers: a /points request gets the nearest recorded point (by latitude), a forecast
/// URL its recorded hourly forecast. Counts requests.
function recorded({ failPoints = false, failForecasts = false } = {}) {
  const calls = [];
  const urls = Object.fromEntries(Object.keys(CITIES).map((k) => [F(`points_${k}.json`).properties.forecastHourly, k]));
  const fn = async (url) => {
    calls.push(url);
    const m = /\/points\/(-?[\d.]+),(-?[\d.]+)$/.exec(url);
    if (m) {
      if (failPoints) return { ok: false, status: 503, json: async () => ({}) };
      const lat = Number(m[1]);
      const k = Object.keys(CITIES).sort((a, b) => Math.abs(CITIES[a][0] - lat) - Math.abs(CITIES[b][0] - lat))[0];
      return { ok: true, status: 200, json: async () => F(`points_${k}.json`) };
    }
    if (urls[url] && !failForecasts) return { ok: true, status: 200, json: async () => F(`hourly_${urls[url]}.json`) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { fn, calls };
}

test('the fetcher: points looked up once, each grid forecast fetched once, again after 20 minutes; warnings at the arrival time', async () => {
  let now = at('2026-11-05T09:30:00Z'); // 4:30 AM Eastern, 9 to 11.5 hours after NWS last updated these grids
  const { fn, calls } = recorded();
  const wa = new WeatherAhead({ fetchFn: fn, clock: () => now, pauseMs: 0 });
  // Leaving Jacksonville at about 67 mph.
  const snap = (progress) => ({ progress, t: now, etaTo: (d) => now + (d - progress) / 30 });
  assert.equal(await wa.refresh({ route }, snap(0)), true);
  const points = calls.filter((u) => u.includes('/points/')).length, forecasts = calls.length - points;
  assert.equal(points, 13, 'one point record per position (150 mi / 12 mi, from mile 0)');
  assert.ok(forecasts >= 1 && forecasts <= points, `${forecasts} forecasts`);
  assert.equal(new Set(calls.filter((u) => !u.includes('/points/'))).size, forecasts, 'each grid once');
  const r = wa.ahead(snap(0));
  assert.equal(r.checked, 13);
  assert.equal(r.unavailable.length, 0);
  // 5 to 7 AM Eastern: patchy fog in Jacksonville and Brunswick.
  assert.ok(r.warnings.length >= 1 && r.warnings.every((w) => w.kind === 'fog'), JSON.stringify(r.warnings.map((w) => [w.kind, w.start / MILE])));
  // Not due again for 20 minutes.
  calls.length = 0;
  now += 60;
  assert.equal(await wa.refresh({ route }, snap(1 * MILE)), false);
  assert.equal(calls.length, 0);
  // After 21 minutes: the forecasts again, not the point records.
  now += 20 * 60;
  assert.equal(await wa.refresh({ route }, snap(2 * MILE)), true);
  assert.equal(calls.filter((u) => u.includes('/points/')).length, 0);
  assert.equal(calls.length, forecasts);
});

test('the fetcher: failed requests leave the stretch unavailable, never clear, and back off', async () => {
  const now = at('2026-11-05T09:30:00Z');
  for (const opts of [{ failPoints: true }, { failForecasts: true }]) {
    const { fn } = recorded(opts);
    const wa = new WeatherAhead({ fetchFn: fn, clock: () => now, pauseMs: 0 });
    const snap = { progress: 0, t: now, etaTo: (d) => now + d / 30 };
    await wa.refresh({ route }, snap);
    const r = wa.ahead(snap);
    assert.equal(r.warnings.length, 0);
    assert.equal(r.unavailable.length, 1, JSON.stringify(opts));
    assert.equal(r.unavailable[0].phrase, 'Weather ahead unavailable');
    assert.ok(wa.nextAt - now <= 120, 'tries again within 2 minutes');
  }
});

test('the fetcher: nothing while offline, switched off, or for an old route after the trip ends', async () => {
  const now = at('2026-11-05T09:30:00Z');
  const { fn, calls } = recorded();
  const wa = new WeatherAhead({ fetchFn: fn, clock: () => now, pauseMs: 0 });
  const snap = { progress: 0, t: now, etaTo: (d) => now + d / 30 };
  assert.equal(await wa.refresh({ route }, snap, { online: false }), false);
  assert.equal(await wa.refresh({ route }, snap, { enabled: false }), false);
  assert.equal(calls.length, 0);
  const running = wa.refresh({ route }, snap);
  wa.stop();
  assert.equal(await running, false);
  assert.equal(wa.ahead(snap), null, 'answers for a stopped trip are not kept');
});

test('voice: a warning is said once, about 20 miles ahead, and not again when a refresh moves its start', () => {
  const said = [];
  const a = new Announcer((t) => said.push(t));
  const settings = { voice: true, alerts: { voice: true, weather: true }, announceStateLines: false, announceTimeZones: false, announceGasGaps: false, announceRestAreas: false, announceExits: false };
  const snap = (mi) => ({ match: { status: 'onRoute' }, progress: mi * MILE, drivenTotal: mi * MILE, current: null, nextRestArea: null, nextExit: null });
  const wx = (start) => ({ level: 'warn', kind: 'showers', phrase: 'Showers likely', start: start * MILE, end: (start + 24) * MILE });
  a.consider(snap(0), settings, { weather: wx(30) });
  assert.deepEqual(said, [], 'not yet: 30 miles ahead');
  a.consider(snap(15), settings, { weather: wx(30) });
  assert.deepEqual(said, ['Weather forecast: showers likely ahead, in about 15 miles.']);
  a.consider(snap(16), settings, { weather: wx(30) });
  a.consider(snap(17), settings, { weather: wx(30 + 12) });
  assert.equal(said.length, 1, 'once per stretch');
  // Voice for road alerts off, or the weather switch off: nothing.
  const quiet = new Announcer((t) => said.push(t));
  quiet.consider(snap(15), { ...settings, alerts: { voice: false, weather: true } }, { weather: wx(30) });
  quiet.consider(snap(15), { ...settings, alerts: { voice: true, weather: false } }, { weather: wx(30) });
  assert.equal(said.length, 1);
});
