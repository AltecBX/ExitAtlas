// ExitAtlas key proxy (Cloudflare Worker). Holds the API keys the browser must not see and caps
// spending with daily budgets. Two endpoints, each a fixed request shape so the keys cannot be used
// for anything else:
//   POST /v1/gas-prices  {lat, lon}       Google Places API (New) Nearby Search, gas stations with
//                                         fuel prices within 1.6 km. Never cached (Google's terms).
//   POST /v1/chargers    form body        U.S. DOE AFDC nearby-route search (public domain data),
//                                         cached for a day.
//   GET  /v1/config                       Provider switches for the app (see docs/11).
// Setup and limits: infra/worker/README.md.

const GOOGLE = 'https://places.googleapis.com/v1/places:searchNearby';
const GOOGLE_FIELDS = 'places.id,places.displayName,places.location,places.fuelOptions';
const AFDC = 'https://developer.nlr.gov/api/alt-fuel-stations/v1/nearby-route.json';
const AFDC_PARAMS = new Set(['route', 'distance', 'fuel_type', 'ev_charging_level', 'status', 'limit', 'ev_network']);
const MAX_BODY = 64 * 1024;

/// Builds the handler. Tests pass their own fetch, cache, store and clock.
export function createHandler({ fetchImpl = (...a) => fetch(...a), cache = null, now = () => Date.now() } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
      : null;
    const reply = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json', ...(cors ?? {}), ...headers } });

    // Browsers send Origin on these requests; anything else is refused. (A non-browser client can fake
    // the header, which is why every endpoint also has a budget.)
    if (!cors) return reply(403, { error: 'origin not allowed' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });

    if (url.pathname === '/v1/config' && request.method === 'GET') {
      return reply(200, config(env), { 'Cache-Control': 'max-age=300' });
    }
    if (request.method !== 'POST') return reply(405, { error: 'method not allowed' });
    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_BODY) return reply(413, { error: 'request too large' });

    if (url.pathname === '/v1/gas-prices') {
      if (!env.GOOGLE_KEY) return reply(503, { error: 'gas prices are not configured' });
      let lat, lon;
      try { ({ lat, lon } = await request.json()); } catch { return reply(400, { error: 'expected JSON {lat, lon}' }); }
      if (!inUS(lat, lon)) return reply(400, { error: 'lat and lon must be a point in the United States' });
      const over = await spend(env, request, 'prices', now());
      if (over) return reply(429, { error: over }, { 'Retry-After': String(secondsToMidnight(now())) });
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
      const form = new URLSearchParams(await request.text());
      for (const k of form.keys()) if (!AFDC_PARAMS.has(k)) return reply(400, { error: `unexpected parameter ${k}` });
      if (!/^LINESTRING\([-\d. ,]+\)$/.test(form.get('route') ?? '')) return reply(400, { error: 'route must be a WKT LINESTRING' });
      form.sort();
      const key = new Request(`https://cache.exitatlas/chargers/${await sha256(form.toString())}`);
      const hit = await cache?.match(key);
      if (hit) return reply(200, await hit.text(), { 'X-Cache': 'hit' });
      const over = await spend(env, request, 'chargers', now());
      if (over) return reply(429, { error: over }, { 'Retry-After': String(secondsToMidnight(now())) });
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
  };
}

/// Counts one call against the day's budgets: all clients together, and each client (by a hash of its
/// IP address, never the address itself). Returns a message when a budget is used up.
/// KV is eventually consistent and takes at most one write per second per key, so under bursts the
/// counts run a little under; a failed counter write never fails the request. The Google Cloud quota
/// on the key is the hard stop (README).
export async function spend(env, request, service, nowMs) {
  const store = env.BUDGET;
  if (!store) return null;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const total = Number(env[`DAILY_${service.toUpperCase()}`] ?? 0);
  const perClient = Number(env[`CLIENT_DAILY_${service.toUpperCase()}`] ?? 0);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const client = (await sha256(`${env.CLIENT_SALT ?? ''}:${ip}`)).slice(0, 16);
  const keys = [`${day}:${service}`, `${day}:${service}:${client}`];
  const [all, mine] = await Promise.all(keys.map(async (k) => Number(await store.get(k)) || 0));
  if (total > 0 && all >= total) return `the daily ${service} budget for everyone is used up; it resets at midnight UTC`;
  if (perClient > 0 && mine >= perClient) return `your daily ${service} limit is used up; it resets at midnight UTC`;
  const ttl = { expirationTtl: 2 * 86400 };
  await Promise.allSettled([store.put(keys[0], String(all + 1), ttl), store.put(keys[1], String(mine + 1), ttl)]);
  return null;
}

function inUS(lat, lon) {
  // Contiguous states, Alaska and Hawaii, loosely.
  return Number.isFinite(lat) && Number.isFinite(lon) && lat > 18 && lat < 72 && lon > -180 && lon < -65;
}

function secondsToMidnight(nowMs) {
  const d = new Date(nowMs);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs) / 1000));
}

async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const handler = createHandler({ cache: globalThis.caches?.default ?? null });
export default { fetch: (request, env) => handler(request, env) };
