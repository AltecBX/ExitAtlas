// Browser services: bundled data, OSRM routing, place search, GPS, voice, wake lock and storage.
import { RegionIndex, InterstateDataset, CorridorDataset, TimeZoneResolver } from '../engine/datasets.js';
import { routeFromOSRM, osrmRouteQuery } from '../engine/osrm.js';
import { RestAreaDataset } from '../engine/restareas.js';
import { StationFacts } from './smartstops.js';
import { DiscoverDataset } from '../engine/discover.js';
import { chooseManifest, candidates, loadVerified, usedManifest } from '../engine/datamanifest.js';
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

/// The data manifest: fetched fresh (the service worker falls back to its copy offline), or the last
/// manifest that loaded, when the fetched one is missing, unreadable or older.
async function manifestSet() {
  if (dataSet.manifest) return dataSet;
  let fetched = null;
  try {
    const res = await fetch(new URL('manifest.json', DATA_BASE), { cache: 'no-store' });
    if (res.ok) fetched = await res.json();
  } catch { fetched = null; }
  const chosen = chooseManifest(fetched, readLastGood());
  if (!chosen.manifest) throw new Error('The data list (manifest.json) could not be loaded. Check the connection and reload.');
  dataSet = chosen;
  dataStatus.manifest = chosen.manifest;
  return dataSet;
}

/// One data file, checked against the manifest; the last good version if the new one fails.
async function loadFile(name, parse, onProgress) {
  const { manifest, fallback } = await manifestSet();
  const io = { fetchBytes: (url) => fetchBytes(url, onProgress), digestHex, dropCached };
  try {
    const r = await loadVerified(name, candidates(name, manifest, fallback), DATA_BASE, io, parse);
    if (r.rolledBack) dataStatus.rolledBack.push(name);
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

// MARK: Routing (OSRM demo server, OpenStreetMap data)

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

/// Public services the owner's proxy has switched off for everyone (see proxy.js), set at start.
export const serviceSwitches = { disabled: [] };

function checkSwitch(service, name) {
  if (serviceSwitches.disabled.includes(service)) throw new Error(`${name} is switched off on the ExitAtlas server for now`);
}

/// Routes through the waypoints. Alternatives only exist without stops. `bearing`: the driver's course for the
/// start of a reroute (engine/osrm.js osrmRouteQuery), or null.
export async function fetchRoutes(waypoints, { alternatives = true, signal, bearing = null } = {}) {
  checkSwitch('routing', 'Routing');
  const res = await fetch(`${OSRM}${osrmRouteQuery(waypoints, { alternatives, bearing })}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 'Ok') {
    throw new Error(body?.message || `routing server error (HTTP ${res.status})`);
  }
  return body.routes.map((r) => routeFromOSRM(r, waypoints));
}

// MARK: Place search (Nominatim). Search on submit only, as its usage policy requires.

let lastSearchAt = 0;
export async function searchPlaces(query, near = null) {
  checkSwitch('search', 'Place search');
  const wait = 1100 - (Date.now() - lastSearchAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
  const params = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'us', limit: '6' });
  if (near) {
    const d = 3;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept-Language': 'en-US' } });
  if (!res.ok) throw new Error(`place search failed (HTTP ${res.status})`);
  const rows = await res.json();
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

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('No location service')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : e.message)),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    );
  });
}

// MARK: Wake lock

export class ScreenWake {
  constructor() { this.lock = null; this.wanted = false; }

  get supported() { return 'wakeLock' in navigator; }
  get active() { return !!this.lock && !this.lock.released; }

  async request() {
    this.wanted = true;
    if (!this.supported || this.active || document.visibilityState !== 'visible') return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
    } catch {
      this.lock = null;
    }
  }

  release() {
    this.wanted = false;
    this.lock?.release().catch(() => {});
    this.lock = null;
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
