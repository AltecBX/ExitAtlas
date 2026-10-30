// Data clients with fake servers: Google Places prices and DOE AFDC chargers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from './support.js';
import { GasPrices, GOOGLE_DAILY_LIMIT, pacificDay, parsePlaces, pricedForGrade, priceText, ageText } from '../js/app/prices.js';
import { parseStations, routeWKT, fetchChargers } from '../js/app/chargers.js';
import { proxyBase, loadProxy, switchedOff } from '../js/app/proxy.js';

const placesJSON = {
  places: [
    { id: 'a', displayName: { text: 'Shell' }, location: { latitude: 31.2, longitude: -81.5 },
      fuelOptions: { fuelPrices: [
        { type: 'REGULAR_UNLEADED', price: { currencyCode: 'USD', units: '3', nanos: 290000000 }, updateTime: '2026-10-28T02:00:00Z' },
        { type: 'PREMIUM', price: { currencyCode: 'USD', units: '4', nanos: 90000000 }, updateTime: '2026-10-28T02:00:00Z' }] },
      currentOpeningHours: { openNow: true, periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, restroom: true },
    { id: 'b', displayName: { text: 'Wawa' }, location: { latitude: 31.21, longitude: -81.5 },
      fuelOptions: { fuelPrices: [{ type: 'REGULAR_UNLEADED', price: { currencyCode: 'USD', units: '3', nanos: 150000000 }, updateTime: '2026-10-28T01:00:00Z' }] } },
    { id: 'c', displayName: { text: 'No prices' }, location: { latitude: 31.22, longitude: -81.5 } },
  ],
};

test('Google Places prices: parsing, grade sort, one request per exit per hour', async () => {
  const stations = parsePlaces(placesJSON);
  assert.equal(stations.length, 3);
  near(stations[0].prices.REGULAR_UNLEADED.value, 3.29);
  assert.deepEqual(stations[0].periods, [{ open: { day: 0, hour: 0, minute: 0 } }]);
  assert.equal(stations[0].restroom, true);
  assert.equal(stations[1].periods, null, 'no hours listed: unknown, not closed');
  assert.equal(stations[1].restroom, null);
  const regular = pricedForGrade(stations, 'REGULAR_UNLEADED', { now: Date.parse('2026-10-28T03:00:00Z') });
  assert.deepEqual(regular.map((s) => s.name), ['Wawa', 'Shell']);
  assert.equal(priceText(regular[0].prices.REGULAR_UNLEADED), '$3.15');
  // An old Google price (past the driver's age limit) or one without a time is never the cheapest.
  assert.deepEqual(pricedForGrade(stations, 'REGULAR_UNLEADED', { now: Date.parse('2026-10-29T01:30:00Z') }).map((s) => s.name), ['Shell'],
    'the Wawa price is 24.5 hours old: not compared');
  assert.deepEqual(pricedForGrade(stations, 'REGULAR_UNLEADED', { now: Date.parse('2026-10-28T03:00:00Z'), maxAgeHours: 6 }).map((s) => s.name), ['Wawa', 'Shell']);
  const untimed = [{ name: 'X', prices: { REGULAR_UNLEADED: { value: 2.5, updated: null } } }, ...stations];
  assert.deepEqual(pricedForGrade(untimed, 'REGULAR_UNLEADED', { now: Date.parse('2026-10-28T03:00:00Z') }).map((s) => s.name), ['Wawa', 'Shell']);
  assert.equal(priceText({ value: 3.099 }), '$3.099', 'tenths of a cent as posted, not rounded up to $3.10');
  assert.equal(ageText(Date.parse('2026-10-28T01:00:00Z'), Date.parse('2026-10-28T01:25:00Z')), '25 min ago');

  let now = 0, calls = 0, lastReq = null;
  // Paid: off unless the driver turned Google Maps prices on, whatever key is stored (docs/17).
  let fetched = 0;
  const notAllowed = new GasPrices({ getKey: () => 'k', fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, json: async () => placesJSON }; } });
  assert.equal(notAllowed.enabled, false);
  assert.equal(await notAllowed.load({ id: 'x0', coordinate: { lat: 31.2, lon: -81.5 } }), null);
  assert.equal(fetched, 0, 'no Google request without the switch');
  const prices = new GasPrices({
    getKey: () => 'k', allowed: () => true, now: () => now,
    fetchImpl: async (url, opts) => { calls += 1; lastReq = { url, opts }; return { ok: true, status: 200, json: async () => placesJSON }; },
  });
  const exit = { id: 'x1', coordinate: { lat: 31.2, lon: -81.5 } };
  const a = await prices.load(exit);
  assert.equal(a.stations.length, 3);
  assert.equal(lastReq.opts.headers['X-Goog-Api-Key'], 'k');
  assert.match(lastReq.opts.headers['X-Goog-FieldMask'], /fuelOptions/);
  assert.match(lastReq.opts.headers['X-Goog-FieldMask'], /currentOpeningHours,places\.restroom/);
  const body = JSON.parse(lastReq.opts.body);
  assert.deepEqual(body.includedTypes, ['gas_station']);
  assert.equal(body.locationRestriction.circle.radius, 1600);
  await prices.load(exit);
  assert.equal(calls, 1, 'kept in memory');
  now += 59 * 60 * 1000;
  assert.equal(prices.peek('x1').stations.length, 3);
  await prices.load(exit);
  assert.equal(calls, 1, 'still within the hour');
  now += 2 * 60 * 1000;
  assert.equal(prices.peek('x1'), null, 'dropped after an hour');
  await prices.load(exit);
  assert.equal(calls, 2, 'looked up again after an hour');
  const off = new GasPrices({ getKey: () => '', allowed: () => true });
  assert.equal(off.enabled, false);
  assert.equal(await off.load(exit), null);
});

test('Google Places errors are reported, not thrown', async () => {
  const prices = new GasPrices({ getKey: () => 'bad', allowed: () => true, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) }) });
  const r = await prices.load({ id: 'x', coordinate: { lat: 1, lon: 1 } });
  assert.equal(r.error, 'API key not valid');
  assert.equal(r.stations.length, 0);
});

test('Google lookups stop at 30 a day on the device, and a used up quota says so', async () => {
  let fetched = 0, used = 29;
  const prices = new GasPrices({
    getKey: () => 'k', allowed: () => true, usedToday: () => used, onCall: () => { used += 1; },
    fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, json: async () => ({ places: [] }) }; },
  });
  assert.equal(GOOGLE_DAILY_LIMIT, 30);
  assert.equal((await prices.load({ id: 'a', coordinate: { lat: 1, lon: 1 } })).error, null, 'the 30th lookup runs');
  const over = await prices.load({ id: 'b', coordinate: { lat: 1, lon: 1 } });
  assert.equal(fetched, 1, 'no request past the daily limit');
  assert.match(over.error, /30 Google price checks are used.*midnight Pacific/);
  assert.equal(over.stations.length, 0);

  const quota = new GasPrices({ getKey: () => 'k', allowed: () => true,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }) }) });
  assert.match((await quota.load({ id: 'c', coordinate: { lat: 1, lon: 1 } })).error, /daily limit for this key is reached/);
  const proxy = new GasPrices({ getKey: () => '', getProxy: () => 'https://p.example.workers.dev/', allowed: () => true,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'daily budget reached' }) }) });
  assert.equal((await proxy.load({ id: 'd', coordinate: { lat: 1, lon: 1 } })).error, 'daily budget reached', 'the proxy keeps its own reason');
});

test('pacificDay follows Pacific time, when Google quotas reset', () => {
  assert.equal(pacificDay(Date.parse('2026-10-30T06:59:00Z')), '2026-10-29');
  assert.equal(pacificDay(Date.parse('2026-10-30T07:00:00Z')), '2026-10-30');
});

test('AFDC chargers: route WKT, parsing, request shape', async () => {
  const r = route('atlanta_to_nashville');
  const wkt = routeWKT(r.polyline);
  assert.match(wkt, /^LINESTRING\(-84\.\d+ 33\.\d+, /);
  assert.ok(wkt.split(',').length > 150 && wkt.split(',').length < 250, 'about one point per 2 km');
  const json = { fuel_stations: [
    { id: 1, station_name: 'Chattanooga, TN - Tesla Supercharger', latitude: 35.0, longitude: -85.3, ev_network: 'Tesla', ev_dc_fast_num: 12, status_code: 'E', ev_connector_types: ['TESLA'], access_days_time: '24 hours daily. NACS partner enabled.' },
    { id: 2, station_name: 'Planned', latitude: 35.1, longitude: -85.3, ev_network: 'Tesla', ev_dc_fast_num: 8, status_code: 'P' },
    { id: 3, station_name: 'Level 2 only', latitude: 35.2, longitude: -85.3, ev_network: 'Tesla', ev_dc_fast_num: null, status_code: 'E' },
  ] };
  const parsed = parseStations(json);
  assert.deepEqual(parsed.map((s) => s.id), [1]);
  assert.equal(parsed[0].openToOthers, true);
  let req = null;
  const out = await fetchChargers(r.polyline, { apiKey: 'K', fetchImpl: async (url, opts) => { req = { url, opts }; return { ok: true, status: 200, json: async () => json }; } });
  assert.equal(out.length, 1);
  assert.match(req.url, /nearby-route\.json\?api_key=K$/);
  assert.equal(req.opts.body.get('ev_network'), 'Tesla');
  assert.equal(req.opts.body.get('ev_charging_level'), 'dc_fast');
  await assert.rejects(fetchChargers(r.polyline, { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }), /rate limited/);
});

function near(a, b, tol = 1e-9) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

test('with the key proxy set, prices and chargers go through it and no key leaves the phone', async () => {
  const base = proxyBase('https://exitatlas-proxy.example.workers.dev');
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ places: [] }) }; };
  const prices = new GasPrices({ getKey: () => 'driver-key', getProxy: () => base, allowed: () => true, fetchImpl });
  assert.equal(prices.enabled, true);
  await prices.load({ id: 1, coordinate: { lat: 30.4, lon: -81.6 } });
  assert.equal(sent[0].url, 'https://exitatlas-proxy.example.workers.dev/v1/gas-prices');
  assert.deepEqual(JSON.parse(sent[0].opts.body), { lat: 30.4, lon: -81.6 });
  assert.ok(!JSON.stringify(sent[0].opts).includes('driver-key'));
  // Without a key of their own, the proxy alone turns prices on.
  assert.equal(new GasPrices({ getKey: () => '', getProxy: () => base, allowed: () => true }).enabled, true);
  assert.equal(new GasPrices({ getKey: () => '', getProxy: () => base }).enabled, false, 'the proxy does not turn on paid prices by itself');

  const r = route('miami_to_manhattan');
  await fetchChargers(r.polyline, { apiKey: 'K', proxy: base, fetchImpl: async (url, opts) => { sent.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ fuel_stations: [] }) }; } });
  assert.equal(sent[1].url, 'https://exitatlas-proxy.example.workers.dev/v1/chargers');
  assert.ok(!sent[1].url.includes('api_key') && !String(sent[1].opts.body).includes('api_key'));
  // A used up budget says so instead of blaming the demo key.
  await assert.rejects(fetchChargers(r.polyline, { proxy: base, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'your daily chargers limit is used up' }) }) }), /daily chargers limit/);
});

test('proxy URL and switches: https only, unreachable means not used', async () => {
  assert.equal(proxyBase('http://evil.example'), null);
  assert.equal(proxyBase('not a url'), null);
  assert.equal(String(proxyBase('https://p.example/x?y=1')), 'https://p.example/x/');
  assert.equal(String(proxyBase('http://localhost:8787')), 'http://localhost:8787/');
  const ok = await loadProxy('https://p.example', async () => ({ ok: true, json: async () => ({ prices: true, chargers: false, wzdx: true, community: true, benchmarks: true, disabled: ['search'] }) }));
  assert.deepEqual({ ...ok, base: String(ok.base) }, { base: 'https://p.example/', prices: true, chargers: false, wzdx: true, community: true, benchmarks: true, disabled: ['search'] });
  assert.equal(switchedOff(ok, 'search'), true);
  assert.equal(switchedOff(ok, 'routing'), false);
  assert.equal(await loadProxy('https://p.example', async () => { throw new Error('offline'); }), null);
  assert.equal(await loadProxy('https://p.example', async () => ({ ok: false, status: 404 })), null);
  assert.equal(await loadProxy(''), null);
});

test('clock: a weekday only within the coming week, a date beyond it', async () => {
  const { clock } = await import('../js/app/format.js');
  const plain = (s) => s.replace(/ /g, ' ');
  const now = Date.UTC(2026, 9, 29, 0, 0) / 1000; // Wednesday October 28, 8:00 PM in New York
  assert.equal(plain(clock(now + 3600, 'America/New_York', now)), '9:00 PM EDT');
  assert.equal(plain(clock(Date.UTC(2026, 9, 29, 13, 0) / 1000, 'America/New_York', now)), 'Thu 9:00 AM EDT');
  assert.equal(plain(clock(Date.UTC(2026, 11, 31, 5, 0) / 1000, 'America/New_York', now)), 'Dec 31 12:00 AM EST');
});
