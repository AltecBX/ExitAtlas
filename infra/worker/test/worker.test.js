import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, config } from '../src/index.js';

const ORIGIN = 'https://altecbx.github.io';
const kv = () => {
  const m = new Map();
  return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } };
};
const memoryCache = () => {
  const m = new Map();
  return { match: async (r) => (m.has(r.url) ? new Response(m.get(r.url)) : undefined), put: async (r, res) => { m.set(r.url, await res.text()); } };
};
const env = (extra = {}) => ({ ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8000`, GOOGLE_KEY: 'g-secret', NREL_KEY: 'n-secret',
  BUDGET: kv(), DAILY_PRICES: '3', CLIENT_DAILY_PRICES: '2', DAILY_CHARGERS: '100', CLIENT_SALT: 's', ...extra });
const post = (path, body, { origin = ORIGIN, ip = '203.0.113.5', json = true } = {}) => new Request(`https://proxy.test${path}`, {
  method: 'POST', body: json ? JSON.stringify(body) : body,
  headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
});
const upstream = (calls, status = 200, body = '{"places":[]}') => async (url, init) => { calls.push({ url: String(url), init }); return new Response(body, { status }); };
const WKT = 'LINESTRING(-81.6 30.3, -81.7 30.6)';

test('gas prices: the key stays on the server and the request shape is fixed', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: upstream(calls) });
  const res = await handle(post('/v1/gas-prices', { lat: 30.4, lon: -81.6, radius: 50000, extra: 'x' }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'g-secret');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.locationRestriction.circle.radius, 1600, 'client values other than lat and lon are ignored');
  assert.deepEqual(sent.includedTypes, ['gas_station']);
  assert.ok(!(await res.text()).includes('g-secret'));
});

test('requests from other sites, bad input and unknown paths are refused', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: upstream(calls) });
  assert.equal((await handle(post('/v1/gas-prices', { lat: 30, lon: -81 }, { origin: 'https://evil.example' }), env())).status, 403);
  assert.equal((await handle(post('/v1/gas-prices', { lat: 51.5, lon: -0.1 }), env())).status, 400);
  assert.equal((await handle(post('/v1/gas-prices', 'not json', { json: false }), env())).status, 400);
  assert.equal((await handle(post('/v1/nope', {}), env())).status, 404);
  assert.equal((await handle(post('/v1/chargers', `route=${encodeURIComponent(WKT)}&api_key=mine`, { json: false }), env())).status, 400);
  assert.equal((await handle(post('/v1/chargers', 'route=DROP%20TABLE', { json: false }), env())).status, 400);
  assert.equal((await handle(post('/v1/gas-prices', { lat: 30, lon: -81 }), env({ GOOGLE_KEY: '' }))).status, 503);
  assert.equal(calls.length, 0);
});

test('daily budgets: per client and for everyone, counted by a hash of the IP address', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: upstream(calls), now: () => Date.UTC(2026, 9, 28, 23, 0) });
  const e = env();
  const a = (ip) => handle(post('/v1/gas-prices', { lat: 30.4, lon: -81.6 }, { ip }), e);
  assert.equal((await a('198.51.100.1')).status, 200);
  assert.equal((await a('198.51.100.1')).status, 200);
  const third = await a('198.51.100.1');
  assert.equal(third.status, 429, 'per client limit');
  assert.equal(third.headers.get('Retry-After'), '3600');
  assert.equal((await a('198.51.100.2')).status, 200);
  assert.match(await (await a('198.51.100.3')).text(), /budget for everyone/);
  assert.equal(calls.length, 3);
  for (const key of e.BUDGET.map.keys()) assert.ok(!key.includes('198.51.100'), 'no IP address is stored');
});

test('chargers: forwarded with the server key, cached for a day, cache hits cost nothing', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: upstream(calls, 200, '{"fuel_stations":[]}'), cache: memoryCache() });
  const e = env({ DAILY_CHARGERS: '1' });
  const body = new URLSearchParams({ route: WKT, distance: '2.5', fuel_type: 'ELEC', ev_network: 'Tesla' }).toString();
  const first = await handle(post('/v1/chargers', body, { json: false }), e);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Cache'), 'miss');
  assert.match(calls[0].url, /api_key=n-secret/);
  // Same search with the parameters in another order: served from the cache, budget untouched.
  const reordered = new URLSearchParams({ ev_network: 'Tesla', fuel_type: 'ELEC', distance: '2.5', route: WKT }).toString();
  const second = await handle(post('/v1/chargers', reordered, { json: false }), e);
  assert.equal(second.headers.get('X-Cache'), 'hit');
  assert.equal(calls.length, 1);
});

test('upstream errors pass through and are not cached', async () => {
  const calls = [];
  const cache = memoryCache();
  const handle = createHandler({ fetchImpl: upstream(calls, 500, '{"error":"down"}'), cache });
  const body = new URLSearchParams({ route: WKT }).toString();
  assert.equal((await handle(post('/v1/chargers', body, { json: false }), env())).status, 500);
  assert.equal((await handle(post('/v1/chargers', body, { json: false }), env())).status, 500);
  assert.equal(calls.length, 2);
});

test('config: off switches and which services are available', async () => {
  const handle = createHandler();
  const res = await handle(new Request('https://proxy.test/v1/config', { headers: { Origin: ORIGIN } }), env({ DISABLED: 'search, prices' }));
  assert.deepEqual(await res.json(), { routing: 'osrm-demo', search: 'nominatim', disabled: ['search', 'prices'], prices: false, chargers: true, wzdx: true, community: false, benchmarks: true });
  assert.deepEqual(config({}), { routing: 'osrm-demo', search: 'nominatim', disabled: [], prices: false, chargers: false, wzdx: true, community: false, benchmarks: true });
  const pre = await handle(new Request('https://proxy.test/v1/gas-prices', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env());
  assert.equal(pre.status, 204);
});

test('a failed budget counter write does not fail the request', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: upstream(calls) });
  const store = { get: async () => null, put: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); } };
  const res = await handle(post('/v1/gas-prices', { lat: 30.4, lon: -81.6 }), env({ BUDGET: store }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('work zone feeds: only the feeds in the app table, cached, refused for other sites, off with a switch', async () => {
  const calls = [];
  const cache = memoryCache();
  const handle = createHandler({ fetchImpl: upstream(calls, 200, '{"feed_info":{},"features":[]}'), cache });
  const get = (path, origin = ORIGIN) => new Request(`https://proxy.test${path}`, { headers: { Origin: origin } });
  const first = await handle(get('/v1/wzdx/MD'), env());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(first.headers.get('X-Cache'), 'miss');
  assert.equal(await first.text(), '{"feed_info":{},"features":[]}');
  assert.deepEqual(calls.map((c) => c.url), ['https://filter.ritis.org/wzdx_v4.1/mdot.geojson']);
  const second = await handle(get('/v1/wzdx/MD'), env());
  assert.equal(second.headers.get('X-Cache'), 'hit');
  assert.equal(calls.length, 1, 'served from the cache');
  for (const bad of ['/v1/wzdx/XX', '/v1/wzdx/constructor', '/v1/wzdx/https%3A%2F%2Fevil.example']) {
    assert.equal((await handle(get(bad), env())).status, 404, bad);
  }
  assert.equal((await handle(get('/v1/wzdx/NJ', 'https://evil.example'), env())).status, 403);
  assert.equal((await handle(get('/v1/wzdx/NJ'), env({ DISABLED: 'wzdx' }))).status, 503);
  assert.equal(config(env({ DISABLED: 'wzdx' })).wzdx, false);
  assert.equal(config(env()).wzdx, true);
  const failing = createHandler({ fetchImpl: upstream([], 500, 'oops'), cache: memoryCache() });
  assert.equal((await failing(get('/v1/wzdx/NJ'), env())).status, 502);
  assert.equal(calls.length, 1);
});

test('fuel benchmarks: EIA weekly summary parsed, cached, off with a switch, never a station price', async () => {
  const rss = '<rss><channel><item><title>Data For 10/26/26</title><description><![CDATA[<br/>Regular Gasoline Retail Price<br/>(Dollars per Gallon)<br/>4.269  .. U.S.<br/>3.832  .... Lower Atlantic<br/>States<br/>4.017 .... Florida<br/>Cities<br/>4.077 .... Miami<br/>On-Highway Diesel Fuel Retail Price<br/>6.352  .. U.S.<br/>5.890 ....  Lower Atlantic]]></description></item></channel></rss>';
  const calls = [];
  const cache = memoryCache();
  const handle = createHandler({ fetchImpl: async (url) => { calls.push(String(url)); return new Response(rss); }, cache });
  const get = () => new Request('https://proxy.test/v1/fuel-benchmarks', { headers: { Origin: ORIGIN } });
  const first = await handle(get(), env());
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.weekOf, '2026-10-26');
  assert.deepEqual(body.regular, { US: 4.269, '1C': 3.832, FL: 4.017 });
  assert.deepEqual(body.diesel, { US: 6.352, '1C': 5.89 });
  assert.match(body.source, /Energy Information Administration/);
  assert.deepEqual(calls, ['https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml']);
  assert.equal((await handle(get(), env())).headers.get('X-Cache'), 'hit');
  assert.equal(calls.length, 1);
  assert.equal((await handle(get(), env({ DISABLED: 'benchmarks' }))).status, 503);
  const broken = createHandler({ fetchImpl: async () => new Response('not the summary'), cache: memoryCache() });
  assert.equal((await broken(get(), env())).status, 502);
});
