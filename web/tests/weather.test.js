// Current weather on real National Weather Service answers (the same expectations as WeatherTests.swift):
// the nearest station that reported in the last 90 minutes, else this hour's forecast, never an old reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { currentWeather, nearestStations, weatherKind, weatherLabel, windText, WEATHER_KINDS } from '../js/engine/weather.js';
import { LiveWeather } from '../js/app/weather.js';
import { weatherIcon, skyColors } from '../js/app/weathericons.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/weather');
const F = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const x = F('expect.json');
const now = Date.parse(x.now) / 1000;
const secs = (iso) => Date.parse(iso) / 1000;

function check(w, e) {
  for (const [k, v] of Object.entries(e)) {
    if (k === 'station') assert.equal(w.station?.id ?? null, v, k);
    else if (k === 'at') assert.equal(w.at, secs(v), k);
    else assert.equal(w[k], v, k);
  }
  assert.deepEqual(w.next.map((n) => ({ at: n.at, temperatureF: n.temperatureF, kind: n.kind, isDay: n.isDay, rainChance: n.rainChance })),
    x.next.map((n) => ({ ...n, at: secs(n.at) })));
}

test('stations: within 50 km, nearest first', () => {
  const st = nearestStations(F('stations.json'), x.position);
  assert.deepEqual(st.map((s) => [s.id, Math.round(s.distance / 10) / 100]), x.stations);
  assert.deepEqual(nearestStations(F('stations.json'), { lat: 33.75, lon: -84.39 }), [], 'none from Atlanta');
});

test('observed: a stale station is skipped for the next one that reported recently', () => {
  const st = nearestStations(F('stations.json'), x.position);
  const observations = [{ station: st[0], body: F('obs_KNIP.json') }, { station: st[1], body: F('obs_KCRG.json') }];
  check(currentWeather({ observations, hourly: F('hourly.json'), now, place: 'Jacksonville, FL' }), x.observed);
});

test('forecast: no recent observation gives this hour of the forecast, labeled as such', () => {
  const st = nearestStations(F('stations.json'), x.position);
  check(currentWeather({ observations: [{ station: st[0], body: F('obs_KNIP.json') }], hourly: F('hourly.json'), now }), x.forecastOnly);
  check(currentWeather({ observations: [], hourly: F('hourly.json'), now }), x.forecastOnly);
});

test('never an old reading or a past forecast as now', () => {
  const st = nearestStations(F('stations.json'), x.position);
  const kcrg = F('obs_KCRG.json');
  const at = secs(kcrg.properties.timestamp);
  const one = (t) => currentWeather({ observations: [{ station: st[1], body: kcrg }], hourly: null, now: t });
  assert.equal(one(at + 90 * 60).source, 'observed', 'exactly 90 minutes old');
  assert.equal(one(at + 90 * 60 + 1), null, 'older, and no forecast');
  assert.equal(one(at - 11 * 60), null, 'from the future');
  assert.equal(currentWeather({ observations: [], hourly: F('hourly.json'), now: now + 30 * 86400 }), null, 'forecast ran out');
  assert.equal(currentWeather({ observations: [], hourly: null, now }), null);
  const noTemp = structuredClone(kcrg);
  noTemp.properties.temperature.value = null;
  assert.equal(currentWeather({ observations: [{ station: st[1], body: noTemp }], hourly: F('hourly.json'), now }).source, 'forecast', 'no temperature');
});

test('kinds from NWS icons, else from the words', () => {
  for (const [icon, text, kind, isDay] of x.kinds) assert.deepEqual(weatherKind(icon, text), { kind, isDay }, `${icon} ${text}`);
  assert.equal(weatherLabel('clear', true), 'Sunny');
  assert.equal(weatherLabel('clear', false), 'Clear');
  assert.equal(weatherLabel('nope', true), null);
  assert.equal(windText({ windMph: 11, windFrom: 'NE', gustMph: 25 }), 'NE 11 mph, gusts 25');
  assert.equal(windText({ windMph: 0, windFrom: null, gustMph: null }), 'Calm');
  assert.equal(windText({ windMph: null }), null);
  for (const k of Object.keys(WEATHER_KINDS)) {
    for (const d of [true, false, null]) assert.match(weatherIcon(k, d), /^<svg [^>]*viewBox="0 0 32 32"[^>]*>.+<\/svg>$/s, k);
    assert.equal(skyColors(k, true).length, 2);
  }
});

/// Serves the captured answers by path; counts what was asked.
function fakeNWS(overrides = {}) {
  const asked = [];
  const files = { '/points/': 'points.json', '/stations?limit=10': 'stations.json', '/stations/KNIP/': 'obs_KNIP.json', '/stations/KCRG/': 'obs_KCRG.json', '/forecast/hourly': 'hourly.json' };
  const fetchFn = async (url) => {
    asked.push(url.replace('https://api.weather.gov', ''));
    for (const [part, name] of Object.entries({ ...files, ...overrides })) {
      if (!url.includes(part)) continue;
      if (name === 'fail') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => F(name) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { asked, fetchFn };
}

test('live: only when due, nearest station first, stops at the first recent one, keeps answers through a failure', async () => {
  let t = now;
  const nws = fakeNWS();
  const lw = new LiveWeather({ fetchFn: nws.fetchFn, clock: () => t });
  assert.equal(lw.current(x.position), null, 'nothing yet');
  assert.equal(await lw.refresh(x.position, { online: false }), false, 'offline');
  assert.equal(await lw.refresh(null), false, 'no position');
  assert.equal(await lw.refresh(x.position), true);
  assert.deepEqual(nws.asked, ['/points/30.33,-81.66', '/gridpoints/JAX/66,65/stations?limit=10',
    '/stations/KNIP/observations/latest', '/stations/KCRG/observations/latest', '/gridpoints/JAX/66,65/forecast/hourly']);
  const w = lw.current(x.position);
  assert.equal(w.source, 'observed');
  assert.equal(w.station.id, 'KCRG');
  assert.equal(w.place, 'Jacksonville, FL');
  assert.equal(w.timeZone, 'America/New_York');
  assert.equal(lw.current({ lat: x.position.lat + 0.5, lon: x.position.lon }), null, 'answers from more than 25 miles back');

  nws.asked.length = 0;
  t += 300;
  assert.equal(await lw.refresh(x.position), false, 'not due for 10 minutes');
  const ahead = { lat: x.position.lat + 11 / 69, lon: x.position.lon };
  t += 60;
  assert.equal(await lw.refresh(ahead), true, '11 miles on');
  assert.equal(nws.asked[0], `/points/${ahead.lat.toFixed(2)},-81.66`, 'a new point record after 5 miles');
  nws.asked.length = 0;
  const further = { lat: ahead.lat + 11 / 69, lon: ahead.lon };
  t += 60;
  assert.equal(await lw.refresh(further), false, 'not again within 2 minutes, however far');

  const down = fakeNWS({ '/stations/KNIP/': 'fail', '/stations/KCRG/': 'fail', '/stations/KJAX/': 'fail', '/forecast/hourly': 'fail' });
  lw.fetchFn = down.fetchFn;
  t += 600;
  assert.equal(await lw.refresh(ahead), true, 'ran');
  assert.equal(lw.failures, 1);
  assert.equal(lw.current(ahead).station.id, 'KCRG', 'the last answers stay until they are too old');
  assert.ok(lw.nextAt <= t + 120, 'retries soon');
  t += 90 * 60;
  assert.equal(lw.current(ahead).source, 'forecast', 'the observation aged out; the forecast for this hour remains');
});
