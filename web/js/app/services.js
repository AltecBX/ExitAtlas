// Browser services: bundled data, OSRM routing, place search, GPS, voice, wake lock and storage.
import { RegionIndex, InterstateDataset, CorridorDataset, TimeZoneResolver } from '../engine/datasets.js';
import { routeFromOSRM, osrmRouteQuery } from '../engine/osrm.js';
import { RestAreaDataset } from '../engine/restareas.js';
import { StationFacts } from './smartstops.js';
import { DiscoverDataset } from '../engine/discover.js';
import { chooseManifest, candidates, loadVerified, usedManifest, fileURL } from '../engine/datamanifest.js';
import { distance, initialBearing } from '../engine/geo.js';

export const DATA_BASE = new URL('../App/ExitAtlas/Resources/Data/', document.baseURI);
const DEMO_VERSION = '20261028';
const LAST_GOOD_KEY = 'ea.dataManifest';

// MARK: Data

/// What data is in use: the manifest, and files that fell back to the last good version.
export const dataStatus = { manifest: null, rolledBack: [], failed: [] };
let dataSet = { manifest: null, fallback: null };

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

async function digestHex(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/// Removes a copy that failed its check from the offline cache, so the next load fetches it again.
async function dropCached(url) {
  try {
    for (const key of await caches.keys()) await (await caches.open(key)).delete(url.href);
  } catch { /* no cache API */ }
}

function readLastGood() {
  try { return JSON.parse(localStorage.getItem(LAST_GOOD_KEY)); } catch { return null; }
}

/// How long start up waits for a fresh data list when a last good one is stored (it is asked again next load).
export const MANIFEST_WAIT = { ms: 4000 };

/// The data manifest: fetched fresh (the service worker falls back to its copy offline), or the last
/// manifest that loaded, when the fetched one is missing, unreadable or older.
async function manifestSet() {
  if (dataSet.manifest) return dataSet;
  let fetched = null;
  const lastGood = readLastGood();
  // With a last good list the data is on the phone: a stalled connection must not hold the loading screen.
  try {
    fetched = await timed('the data list', lastGood ? MANIFEST_WAIT.ms : 60000, null, async (s) => {
      const res = await fetch(new URL('manifest.json', DATA_BASE), { cache: 'no-store', signal: s });
      return res.ok ? res.json() : null;
    });
  } catch { fetched = null; }
  const chosen = chooseManifest(fetched, lastGood);
  if (!chosen.manifest) throw new Error('The data list (manifest.json) could not be loaded. Check the connection and reload.');
  dataSet = chosen;
  dataStatus.manifest = chosen.manifest;
  return dataSet;
}

/// The service worker's cache for data files (web/sw.js DATA_CACHE).
const DATA_CACHE = 'exitatlas-data';

/// On a first visit (or after Safari cleared the site's storage) the data loads before the new service worker
/// controls the page, so the worker never sees it, and it would be kept for offline use only after another
/// visit online. A file that loaded and passed its check is put in the worker's data cache here unless it is
/// already there: no second download.
async function keepOffline(url, bytes) {
  try {
    const sw = navigator.serviceWorker;
    if (!bytes || !sw || !globalThis.caches || !(await sw.getRegistration())) return;
    const cache = await caches.open(DATA_CACHE);
    if (await cache.match(url.href)) return;
    await cache.put(url.href, new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }));
  } catch { /* kept on the next visit online */ }
}

/// One data file, checked against the manifest; the last good version if the new one fails.
async function loadFile(name, parse, onProgress) {
  const { manifest, fallback } = await manifestSet();
  let bytes = null;
  const io = { fetchBytes: async (url) => (bytes = await fetchBytes(url, onProgress)), digestHex, dropCached };
  try {
    const r = await loadVerified(name, candidates(name, manifest, fallback), DATA_BASE, io, parse);
    if (r.rolledBack) dataStatus.rolledBack.push(name);
    keepOffline(fileURL(name, r.entry, DATA_BASE), bytes);
    return r;
  } catch (e) {
    dataStatus.failed.push(name);
    throw e;
  }
}

/// Loads states, time zones, exits, rest areas, station hours and Discover places. Corridors load later, only for
/// discovery mode. Rest areas, stations and Discover are optional: without them those rows, details and sections are
/// simply absent (station hours and restrooms then read as unknown).
export async function loadCoreData(onProgress) {
  const { manifest } = await manifestSet();
  const names = ['states.eab', 'timezones.eab', 'interstates.eax', 'restareas.json', 'discover.json', 'stations.json'];
  const total = names.reduce((sum, n) => sum + (manifest.files[n]?.bytes ?? 0), 0) || 1;
  const done = {};
  const progress = (name) => (n) => {
    done[name] = n;
    onProgress?.(Math.min(1, Object.values(done).reduce((a, b) => a + b, 0) / total), total);
  };
  const json = (Type) => (bytes) => new Type(JSON.parse(new TextDecoder().decode(bytes)));
  const [s, z, x, r, d, st] = await Promise.all([
    loadFile('states.eab', (b) => new RegionIndex(b), progress('states.eab')),
    loadFile('timezones.eab', (b) => new RegionIndex(b), progress('timezones.eab')),
    loadFile('interstates.eax', (b) => new InterstateDataset(b), progress('interstates.eax')),
    loadFile('restareas.json', json(RestAreaDataset), progress('restareas.json')).catch(() => null),
    loadFile('discover.json', json(DiscoverDataset), progress('discover.json')).catch(() => null),
    loadFile('stations.json', json(StationFacts), progress('stations.json')).catch(() => null)]);
  // Everything required loaded: remember these versions as the fallback for the next load.
  try {
    const used = { 'states.eab': s.entry, 'timezones.eab': z.entry, 'interstates.eax': x.entry,
      'restareas.json': r?.entry, 'discover.json': d?.entry, 'stations.json': st?.entry };
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(usedManifest(manifest, used)));
  } catch { /* storage full or blocked */ }
  const zones = z.value;
  return { states: s.value, zoneIndex: zones, timeZones: new TimeZoneResolver(zones), interstates: x.value,
    restAreas: r?.value ?? null, discover: d?.value ?? null, stations: st?.value ?? null };
}

export async function loadCorridors() {
  return (await loadFile('corridors.eac', (b) => new CorridorDataset(b))).value;
}

/// EPA vehicle list with verified tank sizes (about 2.5 MB, compressed by the host). Loaded on demand.
export async function loadVehicles() {
  return (await loadFile('vehicles.json', (b) => JSON.parse(new TextDecoder().decode(b)))).value;
}

export async function loadDemoRouteJSON() {
  const res = await fetch(new URL(`demo_miami_manhattan.json?v=${DEMO_VERSION}`, DATA_BASE));
  if (!res.ok) throw new Error(`demo route: HTTP ${res.status}`);
  return res.json();
}

// MARK: Routing (OSRM demo server, OpenStreetMap data; the FOSSGIS OSRM server as its backup)

/// Asked in order. The backup runs the same OSRM API and is asked only when the first fails (no connection, no
/// answer in time, HTTP 5xx or 429), never for an answer such as NoRoute. Its terms (fossgis.de, OSM-Server
/// Nutzungsbedingungen, routing): light use only, at most one request per second, OpenStreetMap attribution
/// with a link to report map errors (views.js attribution), and a reachable contact for the site's operator.
export const ROUTING_SERVERS = Object.freeze([
  { base: 'https://router.project-osrm.org/route/v1/driving/', name: 'routing server' },
  { base: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/', name: 'backup routing server' },
]);
/// Both servers allow at most one request per second.
export const ROUTING_SPACING = { ms: 1000 };
const routingAskedAt = new Map();
const routingSentAt = new Map();

/// Public services the owner's proxy has switched off for everyone (see proxy.js), set at start.
export const serviceSwitches = { disabled: [] };

function checkSwitch(service, name) {
  if (serviceSwitches.disabled.includes(service)) throw new Error(`${name} is switched off on the ExitAtlas server for now`);
}

/// How long a routing or place search request may take. A request that never answers (a dead zone, a stalled
/// server) would otherwise leave "Finding routes" or "Rerouting" up for good, and block every later reroute.
export const REQUEST_TIMEOUT = { routing: 25000, search: 15000 };

/// Runs `run(signal)` (a fetch and reading its body), giving up after `ms` even if the request never settles.
/// Network failures and the time limit become plain reasons naming the server; cancelling through `outer`
/// still throws the AbortError.
async function timed(what, ms, outer, run) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  outer?.addEventListener('abort', stop);
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const s = Math.round(ms / 1000);
      reject(new Error(`${what} did not answer within ${s} second${s === 1 ? '' : 's'}`));
      ctl.abort();
    }, ms);
  });
  const work = run(ctl.signal);
  work.catch(() => {}); // after the time limit its failure is already reported
  try {
    return await Promise.race([work, late]);
  } catch (e) {
    if (outer?.aborted) throw e;
    if (e instanceof TypeError) throw Object.assign(new Error(`${what} could not be reached (no connection, or the server is busy)`), { kind: 'network' });
    if (ctl.signal.aborted) e.kind = 'timeout';
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}

const abortError = () => new DOMException('The request was cancelled', 'AbortError');

/// Waits `ms`, or rejects with an AbortError as soon as `signal` is cancelled.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/// One routing server's answer. A failure that another server may not share (no connection, no answer in time,
/// HTTP 5xx or 429) is marked `retry`; an answer such as NoRoute or NoSegment is not.
async function askRouter(server, query, signal, timeout) {
  // The slot is taken before waiting, so calls that arrive together (planning while a reroute starts) still go
  // out a second apart; a call cancelled while it waits sends nothing.
  const now = Date.now();
  const at = Math.max(now, (routingAskedAt.get(server.base) ?? -Infinity) + ROUTING_SPACING.ms);
  routingAskedAt.set(server.base, at);
  if (at > now) await pause(at - now, signal);
  // A timer can fire late (Safari pauses a hidden page): keep a second after the request actually sent last too.
  // The check and the record below run with no wait between them, so two waiters cannot both pass.
  for (;;) {
    if (signal?.aborted) throw abortError();
    const gap = (routingSentAt.get(server.base) ?? -Infinity) + ROUTING_SPACING.ms - Date.now();
    if (gap <= 0) break;
    await pause(gap, signal);
  }
  routingSentAt.set(server.base, Date.now());
  routingAskedAt.set(server.base, Math.max(routingAskedAt.get(server.base), Date.now()));
  let res, body;
  try {
    ({ res, body } = await timed(`the ${server.name}`, timeout, signal, async (s) => {
      const r = await fetch(`${server.base}${query}`, { signal: s });
      return { res: r, body: await r.json().catch((e) => { if (s.aborted) throw e; return null; }) };
    }));
  } catch (e) {
    e.retry = Boolean(e.kind);
    throw e;
  }
  if (res.ok && body?.code === 'Ok') return body;
  throw Object.assign(new Error(body?.message || `${server.name} error (HTTP ${res.status})`), { retry: res.status >= 500 || res.status === 429 });
}

/// Routes through the waypoints. Alternatives only exist without stops. `bearing`: the driver's course for the
/// start of a reroute (engine/osrm.js osrmRouteQuery), or null. The backup server is asked only when the first
/// fails, so the driver hears of it only when both do.
export async function fetchRoutes(waypoints, { alternatives = true, signal, bearing = null, timeout = REQUEST_TIMEOUT.routing } = {}) {
  checkSwitch('routing', 'Routing');
  const query = osrmRouteQuery(waypoints, { alternatives, bearing });
  let body;
  try {
    body = await askRouter(ROUTING_SERVERS[0], query, signal, timeout);
  } catch (first) {
    if (!first.retry) throw first;
    try {
      body = await askRouter(ROUTING_SERVERS[1], query, signal, timeout);
    } catch (second) {
      if (!second.retry) throw second;
      if (first.kind === 'network' && second.kind === 'network') {
        throw new Error('the routing servers could not be reached (no connection, or both are busy)');
      }
      throw new Error(`${first.message}, and ${second.message.replace(/^backup routing server error/, 'the backup failed too')}`);
    }
  }
  return body.routes.map((r) => routeFromOSRM(r, waypoints));
}

// MARK: Place search (Nominatim). Search on submit only, as its usage policy requires.

let lastSearchAt = 0;
export async function searchPlaces(query, near = null, { timeout = REQUEST_TIMEOUT.search } = {}) {
  checkSwitch('search', 'Place search');
  const wait = 1100 - (Date.now() - lastSearchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
  const params = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'us', limit: '6' });
  if (near) {
    const d = 3;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const rows = await timed('the place search server', timeout, null, async (s) => {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept-Language': 'en-US' }, signal: s });
    if (!res.ok) throw new Error(`place search failed (HTTP ${res.status})`);
    return res.json();
  });
  return rows.map((r) => ({
    name: shortName(r.display_name),
    detail: r.display_name,
    coordinate: { lat: parseFloat(r.lat), lon: parseFloat(r.lon) },
  }));
}

function shortName(display) {
  const parts = display.split(',').map((s) => s.trim());
  const state = parts.find((p) => STATE_NAMES[p]);
  const head = parts.slice(0, 2).join(', ');
  return state && !head.includes(state) ? `${head}, ${STATE_NAMES[state]}` : head;
}

const STATE_NAMES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
  'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

// MARK: GPS

/// Wraps watchPosition. Fills course and speed from consecutive fixes when the browser omits them.
export class LocationService {
  constructor() {
    this.watchID = null;
    this.onSample = null;
    this.onError = null;
    this.previous = null;
  }

  get running() { return this.watchID !== null; }

  start() {
    if (this.watchID !== null || !('geolocation' in navigator)) {
      if (!('geolocation' in navigator)) this.onError?.('This browser has no location service.');
      return;
    }
    this.watchID = navigator.geolocation.watchPosition(
      (pos) => this.handle(pos),
      (err) => {
        // Timeouts and brief unavailability happen in tunnels and dead zones; dead reckoning covers them.
        if (err.code === 1) this.onError?.('Location permission denied. Allow location for this site in Settings, Privacy, Location Services, Safari Websites.');
        else if (err.code === 2) this.onError?.('GPS signal unavailable. Estimating position until it returns.');
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  stop() {
    if (this.watchID !== null) navigator.geolocation.clearWatch(this.watchID);
    this.watchID = null;
    this.previous = null;
  }

  restart() {
    if (this.watchID === null) return;
    this.stop();
    this.start();
  }

  handle(pos) {
    const c = pos.coords;
    const sample = {
      coordinate: { lat: c.latitude, lon: c.longitude },
      accuracy: Number.isFinite(c.accuracy) ? c.accuracy : -1,
      course: Number.isFinite(c.heading) && c.heading >= 0 && (c.speed ?? 0) > 0.5 ? c.heading : null,
      speed: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
      t: pos.timestamp / 1000,
    };
    const prev = this.previous;
    if (prev && (sample.course === null || sample.speed === null)) {
      const dt = sample.t - prev.t;
      const moved = distance(prev.coordinate, sample.coordinate);
      if (dt > 0 && dt <= 15 && moved >= 12 && moved > 1.5 * Math.max(sample.accuracy, 0)) {
        if (sample.course === null) sample.course = initialBearing(prev.coordinate, sample.coordinate);
        if (sample.speed === null) sample.speed = moved / dt;
      }
    }
    if (!prev || distance(prev.coordinate, sample.coordinate) >= 12 || sample.t - prev.t > 15) this.previous = sample;
    this.onSample?.(sample);
  }
}

/// Why the one time fix for planning from here failed, in plain words with what to do (the browser's own
/// messages read like "Timeout expired" or a system error code).
export const POSITION_PROBLEMS = {
  1: 'location permission is denied. Allow location for this site in Settings, Privacy, Location Services, Safari Websites, or choose a start place',
  2: 'your location is not available right now. Choose a start place, or try again',
  3: 'your location was not found within 20 seconds. Choose a start place, or try again',
};

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('this browser has no location service. Choose a start place')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(POSITION_PROBLEMS[e.code] ?? POSITION_PROBLEMS[2])),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  });
}

// MARK: Wake lock

export class ScreenWake {
  constructor({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
    this.nav = nav;
    this.doc = doc;
    this.lock = null;
    this.wanted = false;
    this.pending = null;
    /// Why the browser last refused to keep the screen on, or null. Cleared once the screen is held.
    this.error = null;
    /// Called when the lock is taken, refused or let go (to update what the screen says).
    this.onChange = null;
  }

  get supported() { return Boolean(this.nav && 'wakeLock' in this.nav); }
  get active() { return !!this.lock && !this.lock.released; }

  /// Keeps the screen on while a drive wants it. Safe to call often (one request at a time); never throws.
  /// The browser lets go of the lock whenever the page is hidden, so this is called again when it shows.
  request() {
    this.wanted = true;
    if (this.pending) return this.pending;
    if (!this.supported || this.active || this.doc?.visibilityState !== 'visible') return Promise.resolve(this.active);
    this.pending = (async () => {
      try {
        const lock = await this.nav.wakeLock.request('screen');
        // The drive ended while the browser was answering: let go at once.
        if (!this.wanted) { lock.release?.().catch?.(() => {}); return false; }
        this.lock = lock;
        this.error = null;
        lock.addEventListener?.('release', () => { if (this.lock === lock) { this.lock = null; this.onChange?.(); } });
        return true;
      } catch (e) {
        this.lock = null;
        this.error = e?.message || 'refused';
        return false;
      } finally {
        this.pending = null;
        this.onChange?.();
      }
    })();
    return this.pending;
  }

  release() {
    this.wanted = false;
    this.error = null;
    const lock = this.lock;
    this.lock = null;
    try { lock?.release?.().catch?.(() => {}); } catch { /* already released */ }
    this.onChange?.();
  }
}

// MARK: Voice

export { Announcer } from './announcer.js';

// MARK: Storage (wrapped: private mode or blocked storage must not break the app)

export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
