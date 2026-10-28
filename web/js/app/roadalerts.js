// Fetches the road alert sources for the active trip, politely: only while a trip is running, every few
// minutes or after a long move, with backoff after errors. Each source keeps its own state, so a failure
// shows as "data unavailable", never as "no alerts". The engine (engine/roadintel.js) does the matching.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { nwsIncidents, NWS_EVENTS } from '../engine/alertsources.js';

const NWS_URL = 'https://api.weather.gov/alerts/active';

/// One source: its fetch plan and its last result, in the shape roadIntel() reads.
function source(id, name, kinds, refreshSeconds, maxAgeSeconds) {
  return { id, name, kinds, refreshSeconds, maxAgeSeconds, state: 'notConfigured', fetchedAt: null, incidents: [],
    uncovered: [], error: null, nextAt: 0, failures: 0, fetchedAtProgress: null, busy: false };
}

export class RoadAlerts {
  constructor({ fetchFn = (...a) => fetch(...a), clock = () => Date.now() / 1000 } = {}) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.sources = {
      // Weather: points every 25 miles over the next 150, every 10 minutes or after 20 miles.
      nws: { ...source('nws', 'National Weather Service', [...new Set(Object.values(NWS_EVENTS))], 600, 1800), state: 'idle' },
    };
  }

  /// The sources as roadIntel() expects them.
  providers() {
    return Object.values(this.sources).map((s) => ({
      id: s.id, name: s.name, kinds: s.kinds, state: s.state === 'idle' ? 'pending' : s.state, fetchedAt: s.fetchedAt,
      maxAgeSeconds: s.maxAgeSeconds, incidents: s.incidents, uncovered: s.uncovered,
    }));
  }

  /// Called with each new position while a trip runs. Fetches what is due; returns true when something changed.
  async refresh(plan, progress, { online = true } = {}) {
    if (!plan || !online) return false;
    const now = this.clock();
    const jobs = [];
    const nws = this.sources.nws;
    const moved = nws.fetchedAtProgress != null && Math.abs(progress - nws.fetchedAtProgress) > 20 * MILE;
    if (!nws.busy && (now >= nws.nextAt || moved)) jobs.push(this.fetchNws(plan, progress, now));
    if (!jobs.length) return false;
    await Promise.all(jobs);
    return true;
  }

  /// Sample points on the route ahead: here, then every 25 miles up to 150 (or the destination).
  static samplePoints(plan, progress) {
    const length = plan.route.polyline.length;
    const out = [];
    for (let d = progress; d <= Math.min(length, progress + 150 * MILE); d += 25 * MILE) out.push(plan.route.polyline.coordinateAt(d));
    return out;
  }

  async fetchNws(plan, progress, now) {
    const s = this.sources.nws;
    s.busy = true;
    try {
      const responses = [];
      for (const point of RoadAlerts.samplePoints(plan, progress)) {
        const url = `${NWS_URL}?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
        const res = await this.fetchFn(url, { headers: { Accept: 'application/geo+json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        responses.push({ point: { lat: point.lat, lon: point.lon }, features: body.features ?? [] });
      }
      s.incidents = nwsIncidents(responses);
      s.state = 'ok';
      s.fetchedAt = now;
      s.fetchedAtProgress = progress;
      s.error = null;
      s.failures = 0;
      s.nextAt = now + s.refreshSeconds;
    } catch (e) {
      // Keep the last good result until it is older than maxAgeSeconds; the engine then reports it unavailable.
      s.error = e.message;
      s.failures += 1;
      if (s.fetchedAt == null) s.state = 'error';
      s.nextAt = now + Math.min(1800, 60 * 2 ** Math.min(s.failures, 5));
    } finally {
      s.busy = false;
    }
  }

  /// Forget everything (a new trip).
  reset() {
    for (const s of Object.values(this.sources)) {
      Object.assign(s, { state: s.id === 'nws' ? 'idle' : 'notConfigured', fetchedAt: null, incidents: [], error: null, nextAt: 0, failures: 0, fetchedAtProgress: null });
    }
  }
}
