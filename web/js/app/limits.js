// Posted speed limits along the route from OpenStreetMap `maxspeed` tags, via the public Valhalla
// server's trace_attributes (FOSSGIS). The route is sampled every 100 m and fetched in 80 km chunks
// just ahead of the driver, so a whole trip costs about one request per 50 miles.

const VALHALLA = 'https://valhalla1.openstreetmap.de/trace_attributes';
export const LIMIT_STEP = 100;
const CHUNK = 80000;
const PREFETCH = 2 * CHUNK;
const NOT_FETCHED = -2;
const UNKNOWN = -1;

export class SpeedLimits {
  constructor(route, { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.route = route;
    this.n = Math.floor(route.length / LIMIT_STEP) + 1;
    this.mph = new Int16Array(this.n).fill(NOT_FETCHED);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = null;
    this.retryAt = 0;
    this.failures = 0;
    this.onUpdate = null;
  }

  index(d) {
    return Math.min(this.n - 1, Math.max(0, Math.round(d / LIMIT_STEP)));
  }

  /// Posted limit in mph at a distance along the route, or null when unknown or not loaded yet.
  at(d) {
    const v = this.mph[this.index(d)];
    return v >= 0 ? v : null;
  }

  state(d) {
    const v = this.mph[this.index(d)];
    return v >= 0 ? 'known' : v === UNKNOWN ? 'unknown' : 'loading';
  }

  /// The next different known limit within `within` meters ahead: {mph, distance}.
  nextChange(d, within = 3218) {
    const i0 = this.index(d), cur = this.mph[i0];
    const last = Math.min(this.n - 1, this.index(d + within));
    for (let i = i0 + 1; i <= last; i++) {
      const v = this.mph[i];
      if (v >= 0 && v !== cur) return { mph: v, distance: i * LIMIT_STEP - d };
    }
    return null;
  }

  /// Loads the next chunk that is still missing within the prefetch window. Safe to call on every fix.
  ensureAhead(d) {
    if (this.pending || this.now() < this.retryAt) return this.pending;
    const start = this.index(d), end = this.index(d + PREFETCH);
    let i0 = -1;
    for (let i = start; i <= end; i++) if (this.mph[i] === NOT_FETCHED) { i0 = i; break; }
    if (i0 < 0) return null;
    const i1 = Math.min(this.n - 1, i0 + CHUNK / LIMIT_STEP);
    this.pending = this.fetchChunk(i0, i1).finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchChunk(i0, i1) {
    const shape = [];
    for (let i = i0; i <= i1; i++) {
      const c = this.route.polyline.coordinateAt(Math.min(i * LIMIT_STEP, this.route.length));
      shape.push({ lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6 });
    }
    const body = JSON.stringify({
      shape, costing: 'auto', shape_match: 'map_snap', units: 'miles',
      filters: { attributes: ['edge.speed_limit', 'matched.edge_index', 'matched.type'], action: 'include' },
    });
    try {
      // text/plain keeps this a simple request (no CORS preflight); Valhalla parses the JSON body.
      const res = await this.fetchImpl(VALHALLA, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        if (json?.error_code === 444 || json?.error_code === 443) {
          this.mph.fill(UNKNOWN, i0, i1 + 1); // the shape could not be matched: do not ask again
          this.onUpdate?.();
          return;
        }
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      applyTraceAttributes(this.mph, i0, i1, json);
      this.failures = 0;
      this.onUpdate?.();
    } catch {
      this.failures += 1;
      this.retryAt = this.now() + Math.min(300000, 15000 * 2 ** (this.failures - 1));
    }
  }
}

/// Writes mph values for sample points i0..i1 from a trace_attributes response.
export function applyTraceAttributes(mph, i0, i1, json) {
  const edges = json.edges ?? [];
  const points = json.matched_points ?? [];
  for (let k = 0; k <= i1 - i0; k++) {
    const p = points[k];
    const e = p && p.type !== 'unmatched' ? edges[p.edge_index] : null;
    const v = e?.speed_limit;
    mph[i0 + k] = typeof v === 'number' && v > 0 && v < 100 ? Math.round(v) : UNKNOWN;
  }
}
