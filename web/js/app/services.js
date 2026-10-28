// Browser services: bundled data, OSRM routing, place search, GPS, voice, wake lock and storage.
import { RegionIndex, InterstateDataset, CorridorDataset, TimeZoneResolver } from '../engine/datasets.js';
import { routeFromOSRM } from '../engine/osrm.js';
import { RestAreaDataset } from '../engine/restareas.js';
import { DiscoverDataset } from '../engine/discover.js';
import { distance, initialBearing } from '../engine/geo.js';

export const DATA_BASE = new URL('../App/ExitAtlas/Resources/Data/', document.baseURI);
const DATA_VERSION = '20261028';

// MARK: Data

async function fetchBuffer(name, onProgress) {
  const res = await fetch(new URL(`${name}?v=${DATA_VERSION}`, DATA_BASE));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
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

/// Loads states, time zones, exits, rest areas and Discover places. Corridors load later, only for discovery mode.
/// Rest areas are optional: without them the timeline simply has no rest area rows.
export async function loadCoreData(onProgress) {
  const sizes = { 'states.eab': 2786240, 'timezones.eab': 596473, 'interstates.eax': 11570373, 'restareas.json': 260457, 'discover.json': 442934 };
  const done = {};
  const report = () => {
    const got = Object.values(done).reduce((a, b) => a + b, 0);
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    onProgress?.(Math.min(1, got / total));
  };
  const get = (name) => fetchBuffer(name, (n) => { done[name] = n; report(); });
  const [s, z, x, r, d] = await Promise.all([get('states.eab'), get('timezones.eab'), get('interstates.eax'),
    get('restareas.json').catch(() => null), get('discover.json').catch(() => null)]);
  const states = new RegionIndex(s);
  const zones = new RegionIndex(z);
  const interstates = new InterstateDataset(x);
  let restAreas = null;
  try {
    if (r) restAreas = new RestAreaDataset(JSON.parse(new TextDecoder().decode(r)));
  } catch { restAreas = null; }
  let discover = null;
  try {
    if (d) discover = new DiscoverDataset(JSON.parse(new TextDecoder().decode(d)));
  } catch { discover = null; }
  return { states, zoneIndex: zones, timeZones: new TimeZoneResolver(zones), interstates, restAreas, discover };
}

export async function loadCorridors() {
  return new CorridorDataset(await fetchBuffer('corridors.eac'));
}

/// EPA vehicle list with verified tank sizes (about 2.5 MB, compressed by the host). Loaded on demand.
export async function loadVehicles() {
  const res = await fetch(new URL(`vehicles.json?v=${VEHICLES_VERSION}`, DATA_BASE));
  if (!res.ok) throw new Error(`vehicle list: HTTP ${res.status}`);
  return res.json();
}
const VEHICLES_VERSION = '20261028f';

export async function loadDemoRouteJSON() {
  const res = await fetch(new URL(`demo_miami_manhattan.json?v=${DATA_VERSION}`, DATA_BASE));
  if (!res.ok) throw new Error(`demo route: HTTP ${res.status}`);
  return res.json();
}

// MARK: Routing (OSRM demo server, OpenStreetMap data)

const OSRM = 'https://router.project-osrm.org/route/v1/driving/';

/// Routes through the waypoints. Alternatives only exist without stops.
export async function fetchRoutes(waypoints, { alternatives = true, signal } = {}) {
  const coords = waypoints.map((w) => `${w.coordinate.lon.toFixed(6)},${w.coordinate.lat.toFixed(6)}`).join(';');
  const params = new URLSearchParams({
    overview: 'full', geometries: 'polyline6', steps: 'true', annotations: 'duration',
    alternatives: alternatives && waypoints.length === 2 ? '3' : 'false',
  });
  const res = await fetch(`${OSRM}${coords}?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.code !== 'Ok') {
    throw new Error(body?.message || `routing server error (HTTP ${res.status})`);
  }
  return body.routes.map((r) => routeFromOSRM(r, waypoints));
}

// MARK: Place search (Nominatim). Search on submit only, as its usage policy requires.

let lastSearchAt = 0;
export async function searchPlaces(query, near = null) {
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
