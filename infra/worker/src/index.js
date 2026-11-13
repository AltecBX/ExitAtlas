// ExitAtlas key proxy (Cloudflare Worker). Holds the API keys the browser must not see and caps
// spending with daily budgets. Two endpoints, each a fixed request shape so the keys cannot be used
// for anything else:
//   POST /v1/gas-prices  {lat, lon}       Google Places API (New) Nearby Search, gas stations with
//                                         fuel prices within 1.6 km. Never cached (Google's terms).
//   POST /v1/chargers    form body        U.S. DOE AFDC nearby-route search (public domain data),
//                                         cached for a day.
//   GET  /v1/wzdx/<state>                 A state's work zone feed (WZDx, CC0, no key) for browsers that
//                                         may not read it directly (no CORS). Only the feeds in the app's
//                                         own table; cached for 2 minutes; passed through unparsed.
//   POST /v1/price-reports {stationId, grade, price, payment, member, install, near}
//   GET  /v1/price-reports?stations=a,b   Shared gas price reports from drivers (src/prices.js, docs/17), on a D1
//                                         database bound as PRICES_DB; off without one.
//   GET  /v1/fuel-benchmarks              EIA's weekly average retail prices by region (public domain, no key),
//                                         parsed, cached for 6 hours. Context only, never a station price (docs/17).
//   GET  /v1/config                       Provider switches for the app (see docs/11).
// Setup and limits: infra/worker/README.md.
import { WZDX_FEEDS } from '../../../web/js/engine/alertsources.js';
import { postReport, getReports, countCall, readCapped } from './prices.js';
import { parseEiaSummary } from '../../../web/js/engine/gasprices.js';

const GOOGLE = 'https://places.googleapis.com/v1/places:searchNearby';
// Same fields as the app's own request (web/js/app/prices.js): billed once at the highest SKU.
const GOOGLE_FIELDS = 'places.id,places.displayName,places.location,places.fuelOptions,places.currentOpeningHours,places.restroom';
const AFDC = 'https://developer.nlr.gov/api/alt-fuel-stations/v1/nearby-route.json';
const AFDC_PARAMS = new Set(['route', 'distance', 'fuel_type', 'ev_charging_level', 'status', 'limit', 'ev_network']);
const MAX_BODY = 64 * 1024;
const EIA_SUMMARY = 'https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml';

/// Builds the handler. Tests pass their own fetch, cache, store and clock.
export function createHandler({ fetchImpl = (...a) => fetch(...a), cache = null, now = () => Date.now() } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // The iOS app sends no Origin (it is not a web page); it names itself instead and gets no CORS headers.
    const native = !origin && /^ios\/[\w.-]{1,20}$/.test(request.headers.get('X-ExitAtlas-Client') ?? '');
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : native ? {} : null;
    const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json', ...(cors ?? {}), ...headers } });

    // Browsers send Origin on these requests; other sites, and clients that are neither a listed page nor
    // the iOS app, are refused. (A non-browser client can fake either header, which is why every endpoint
    // also has a budget.)
    if (!cors) return reply(403, { error: 'origin not allowed' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });

    if (url.pathname === '/v1/config' && request.method === 'GET') {
      return reply(200, config(env), { 'Cache-Control': 'max-age=300' });
    }
    if (url.pathname.startsWith('/v1/wzdx/') && request.method === 'GET') {
      const state = url.pathname.slice('/v1/wzdx/'.length);
      const feed = Object.hasOwn(WZDX_FEEDS, state) ? WZDX_FEEDS[state] : null;
      if (!feed) return reply(404, { error: 'no work zone feed for that state' });
      if (!config(env).wzdx) return reply(503, { error: 'work zone feeds are switched off' });
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=120', ...cors };
      const key = new Request(`https://cache.exitatlas/wzdx/${state}`);
      const hit = await cache?.match(key);
      if (hit) return new Response(hit.body, { status: 200, headers: { ...headers, 'X-Cache': 'hit' } });
      const res = await fetchImpl(feed.url, { headers: { Accept: 'application/geo+json, application/json', 'User-Agent': 'ExitAtlas proxy (github.com/AltecBX/ExitAtlas)' } });
      if (!res.ok) return reply(502, { error: `the ${state} feed answered ${res.status}` });
      // Streamed through without parsing (some feeds are several MB; parsing would cost CPU time).
      await cache?.put(key, new Response(res.clone().body, { headers: { 'Cache-Control': 'max-age=120' } }));
      return new Response(res.body, { status: 200, headers: { ...headers, 'X-Cache': 'miss' } });
    }
    if (url.pathname === '/v1/fuel-benchmarks' && request.method === 'GET') {
      if (!config(env).benchmarks) return reply(503, { error: 'fuel benchmarks are switched off' });
      const key = new Request('https://cache.exitatlas/fuel-benchmarks');
      const hit = await cache?.match(key);
      if (hit) return reply(200, await hit.text(), { 'X-Cache': 'hit', 'Cache-Control': 'max-age=3600' });
      const res = await fetchImpl(EIA_SUMMARY, { headers: { 'User-Agent': 'ExitAtlas proxy (github.com/AltecBX/ExitAtlas)' } });
      const summary = res.ok ? parseEiaSummary(await res.text()) : null;
      if (!summary) return reply(502, { error: res.ok ? 'the EIA summary could not be read' : `EIA answered ${res.status}` });
      const text = JSON.stringify({ ...summary, source: 'U.S. Energy Information Administration, weekly retail prices (public domain)' });
      await cache?.put(key, new Response(text, { headers: { 'Cache-Control': 'max-age=21600' } }));
      return reply(200, text, { 'X-Cache': 'miss', 'Cache-Control': 'max-age=3600' });
    }
    if (url.pathname === '/v1/price-reports') {
      if (!config(env).community) return reply(503, { error: 'shared price reports are not set up' });
      try { return await priceReports(); } catch {
        // D1 refuses queries once the free daily limits are used up (or is down): no reports until it
        // answers again, never a charge (README).
        return reply(503, { error: 'shared price reports are unavailable right now; they resume after midnight UTC at the latest' }, { 'Cache-Control': 'no-store' });
      }
    }
    async function priceReports() {
      // Without the secret salt the stored and published ids would be plain hashes of addresses and install ids,
      // which can be guessed back: no reports until it is set (scripts/deploy.sh sets it).
      if (!env.CLIENT_SALT) return reply(503, { error: 'shared price reports are not set up (CLIENT_SALT is missing)' }, { 'Cache-Control': 'no-store' });
      const hash = (s) => sha256(`${env.CLIENT_SALT}:${s}`);
      const client = (await hash(`ip:${clientAddress(request)}`)).slice(0, 16);
      if (request.method === 'GET') {
        // Not cached: a report must reach other drivers right away. The daily lookup budgets keep the
        // database reads under the free limit (src/prices.js).
        const [status, body] = await getReports(url, env, { nowMs: now(), hash, client });
        return reply(status, body, { 'Cache-Control': 'no-store' });
      }
      if (request.method === 'POST') {
        const [status, body] = await postReport(request, env, { nowMs: now(), client, hash });
        return reply(status, body, { 'Cache-Control': 'no-store' });
      }
      return reply(405, { error: 'method not allowed' });
    }
    if (request.method !== 'POST') return reply(405, { error: 'method not allowed' });
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_BODY) return reply(413, { error: 'request too large' });

    if (url.pathname === '/v1/gas-prices') {
      if (!env.GOOGLE_KEY) return reply(503, { error: 'gas prices are not configured' });
      let lat, lon;
      const text = await readCapped(request, 1024);
      if (text === null) return reply(413, { error: 'request too large' });
      try { ({ lat, lon } = JSON.parse(text)); } catch { return reply(400, { error: 'expected JSON {lat, lon}' }); }
      if (!inUS(lat, lon)) return reply(400, { error: 'lat and lon must be a point in the United States' });
      let over;
      // This is the one endpoint that can cost money: when the count cannot be kept, no request goes to Google.
      try { over = await spend(env, request, 'prices', now()); } catch { return reply(503, { error: 'the daily budget could not be counted; no price request was made' }, { 'Cache-Control': 'no-store' }); }
      if (over === NO_STORE) return reply(503, { error: over }, { 'Cache-Control': 'no-store' });
      if (over) return reply(429, { error: over }, { 'Retry-After': String(secondsToMidnight(now(), 'prices')) });
      const res = await fetchImpl(GOOGLE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_KEY, 'X-Goog-FieldMask': GOOGLE_FIELDS },
        body: JSON.stringify({
          includedTypes: ['gas_station'], maxResultCount: 10, rankPreference: 'DISTANCE',
          locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: 1600 } },
        }),
      });
      // Passed through as is, never stored.
      return reply(res.status, await res.text(), { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/v1/chargers') {
      if (!env.NREL_KEY) return reply(503, { error: 'charger lookups are not configured' });
      const body = await readCapped(request, MAX_BODY);
      if (body === null) return reply(413, { error: 'request too large' });
      const form = new URLSearchParams(body);
      for (const [k, v] of form) {
        if (!AFDC_PARAMS.has(k)) return reply(400, { error: `unexpected parameter ${k}` });
        if (k !== 'route' && !/^[\w.,-]{1,40}$/.test(v)) return reply(400, { error: `unexpected value for ${k}` });
      }
      if (new Set(form.keys()).size !== [...form.keys()].length) return reply(400, { error: 'a parameter is given twice' });
      if (!/^LINESTRING\([-\d. ,]+\)$/.test(form.get('route') ?? '')) return reply(400, { error: 'route must be a WKT LINESTRING' });
      if (form.has('distance') && !(Number(form.get('distance')) > 0 && Number(form.get('distance')) <= 5)) return reply(400, { error: 'distance must be 5 miles or less' });
      form.sort();
      const key = new Request(`https://cache.exitatlas/chargers/${await sha256(form.toString())}`);
      const hit = await cache?.match(key);
      if (hit) return reply(200, await hit.text(), { 'X-Cache': 'hit' });
      let over;
      try { over = await spend(env, request, 'chargers', now()); } catch { over = null; } // free data: a counter that is down does not stop it
      if (over && over !== NO_STORE) return reply(429, { error: over }, { 'Retry-After': String(secondsToMidnight(now())) });
      const res = await fetchImpl(`${AFDC}?api_key=${encodeURIComponent(env.NREL_KEY)}`, { method: 'POST', body: form });
      const text = await res.text();
      if (res.ok) await cache?.put(key, new Response(text, { headers: { 'Cache-Control': 'max-age=86400' } }));
      return reply(res.status, text, { 'X-Cache': 'miss' });
    }

    return reply(404, { error: 'not found' });
  };
}

/// Provider switches the app reads at start (an off switch for each public service).
export function config(env) {
  const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    routing: env.ROUTING ?? 'osrm-demo',
    search: env.SEARCH ?? 'nominatim',
    disabled: list(env.DISABLED),
    prices: Boolean(env.GOOGLE_KEY) && !list(env.DISABLED).includes('prices'),
    chargers: Boolean(env.NREL_KEY) && !list(env.DISABLED).includes('chargers'),
    wzdx: !list(env.DISABLED).includes('wzdx'),
    community: Boolean(env.PRICES_DB) && !list(env.DISABLED).includes('community'),
    benchmarks: !list(env.DISABLED).includes('benchmarks'),
  };
}

/// The budgets used when wrangler.toml sets none or something that is not a number (0 still means no limit).
const DEFAULT_BUDGETS = { DAILY_PRICES: 30, CLIENT_DAILY_PRICES: 30, DAILY_CHARGERS: 200, CLIENT_DAILY_CHARGERS: 40 };
const NO_STORE = 'the daily budget store is not set up; no request was made';

function budget(env, name) {
  const raw = env[name];
  const v = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(v) || v < 0 ? DEFAULT_BUDGETS[name] ?? 0 : v;
}

/// The caller's address for per client limits: an IPv4 address, or the /64 network of an IPv6 address (one
/// subscriber holds a whole /64, so counting single IPv6 addresses would be no limit at all).
export function clientAddress(request) {
  const ip = (request.headers.get('CF-Connecting-IP') ?? 'unknown').trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/// Counts one call against the day's budgets: each client first (by a hash of its address, never the address
/// itself), then all clients together. Returns a message when a budget is used up, NO_STORE when there is
/// nowhere to count, else null.
/// With the D1 database bound, each count is one atomic statement, so calls at the same moment cannot both slip
/// under a limit. Without it the counters are in KV, which is eventually consistent and takes at most one write
/// per second per key: under bursts those counts run a little under, and a counter write that fails throws
/// (the caller decides whether that stops the request). The Google Cloud quota on the key is the hard stop (README).
export async function spend(env, request, service, nowMs) {
  const day = budgetDay(service, nowMs);
  const total = budget(env, `DAILY_${service.toUpperCase()}`);
  const perClient = budget(env, `CLIENT_DAILY_${service.toUpperCase()}`);
  const client = (await sha256(`${env.CLIENT_SALT ?? ''}:${clientAddress(request)}`)).slice(0, 16);
  const reset = service === 'prices' ? 'midnight Pacific time' : 'midnight UTC';
  const messages = [`your daily ${service} limit is used up; it resets at ${reset}`, `the daily ${service} budget for everyone is used up; it resets at ${reset}`];
  if (env.PRICES_DB) {
    if (perClient > 0 && await countCall(env.PRICES_DB, `${service}:${client}`, day) > perClient) return messages[0];
    if (total > 0 && await countCall(env.PRICES_DB, service, day) > total) return messages[1];
    return null;
  }
  const store = env.BUDGET;
  if (!store) return NO_STORE;
  const keys = [`${day}:${service}`, `${day}:${service}:${client}`];
  const [all, mine] = await Promise.all(keys.map(async (k) => Number(await store.get(k)) || 0));
  if (perClient > 0 && mine >= perClient) return messages[0];
  if (total > 0 && all >= total) return messages[1];
  const ttl = { expirationTtl: 2 * 86400 };
  await Promise.all([store.put(keys[0], String(all + 1), ttl), store.put(keys[1], String(mine + 1), ttl)]);
  return null;
}

function inUS(lat, lon) {
  // Contiguous states, Alaska and Hawaii, loosely.
  return Number.isFinite(lat) && Number.isFinite(lon) && lat > 18 && lat < 72 && lon > -180 && lon < -65;
}

/// Google's daily quotas reset at midnight Pacific time (docs/17), so the Google prices budget counts by the
/// Pacific day, the same window as the quota on the key; the others count by the UTC day.
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const PACIFIC_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function budgetDay(service, nowMs) {
  return service === 'prices' ? PACIFIC_DAY.format(nowMs) : new Date(nowMs).toISOString().slice(0, 10);
}

/// Seconds until the budget day ends (for Retry-After; on the days clocks change, Pacific time is an hour off).
function secondsToMidnight(nowMs, service = '') {
  if (service === 'prices') {
    const [h, m, sec] = PACIFIC_CLOCK.format(nowMs).split(':').map(Number);
    return Math.max(1, 86400 - (h * 3600 + m * 60 + sec));
  }
  const d = new Date(nowMs);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs) / 1000));
}

async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const handler = createHandler({ cache: globalThis.caches?.default ?? null });
export default { fetch: (request, env) => handler(request, env) };
