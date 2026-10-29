// Fetches the road alert sources for the active trip, politely: only while a trip is running, every few
// minutes or after a long move, with backoff after errors. Each source keeps its own state, so a failure
// shows as "data unavailable", never as "no alerts". The engine (engine/roadintel.js) does the matching.
// Same plan as App/ExitAtlas/Services/RoadAlertService.swift.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { nwsIncidents, NWS_EVENTS, WZDX_FEEDS, WZDX_KINDS, parseWzdx, wzdxIncidents, wzdxSource, wzdxUpdatedAt } from '../engine/alertsources.js';

const NWS_URL = 'https://api.weather.gov/alerts/active';
/// Work zone feeds are read for the states within this distance ahead.
const WZDX_AHEAD = 150 * MILE;
/// A feed whose publisher has not updated it for this long is treated as unavailable, not as current.
const WZDX_STALE = 86400;

/// One source: its fetch plan and its last result, in the shape roadIntel() reads.
function source(id, name, kinds, refreshSeconds, maxAgeSeconds) {
  return { id, name, kinds, refreshSeconds, maxAgeSeconds, state: 'notConfigured', fetchedAt: null, incidents: [],
    uncovered: [], error: null, nextAt: 0, failures: 0, fetchedAtProgress: null, busy: false };
}

export class RoadAlerts {
  /// proxyBase: the key proxy's base URL when it serves work zone feeds (infra/worker /v1/wzdx), else null.
  constructor({ fetchFn = (...a) => fetch(...a), clock = () => Date.now() / 1000, proxyBase = () => null } = {}) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.proxyBase = proxyBase;
    this.sources = {
      // Weather: points every 25 miles over the next 150, every 10 minutes or after 20 miles.
      nws: { ...source('nws', 'National Weather Service', [...new Set(Object.values(NWS_EVENTS))], 600, 1800), state: 'idle' },
    };
    // Work zones: one source per state feed, created when the state comes within 150 miles.
    this.wzdx = {};
    // States within 150 miles ahead: covered (a feed this app can read) and not.
    this.coverage = null;
  }

  /// The sources as roadIntel() expects them.
  providers() {
    const view = (s) => ({
      id: s.id, name: s.name, kinds: s.kinds, state: s.state === 'idle' ? 'pending' : s.state, fetchedAt: s.fetchedAt,
      maxAgeSeconds: s.maxAgeSeconds, incidents: s.incidents, uncovered: s.uncovered,
    });
    const list = [view(this.sources.nws)];
    const c = this.coverage;
    for (const st of c?.covered ?? []) if (this.wzdx[st]) list.push(view(this.wzdx[st]));
    // Which states ahead have no work zone feed: "unsupported" when none does, a coverage note otherwise.
    list.push({ id: 'wzdx', name: 'State work zone feeds', kinds: WZDX_KINDS,
      state: !c ? 'pending' : c.covered.length ? 'ok' : 'unsupported', fetchedAt: c?.at ?? null, maxAgeSeconds: 86400,
      incidents: [], uncovered: c?.uncovered ?? [] });
    return list;
  }

  /// Called with each new position while a trip runs. Fetches what is due; returns true when something changed.
  /// enabled: the Settings groups (a switched off group is not fetched).
  async refresh(plan, progress, { online = true, enabled = {} } = {}) {
    if (!plan || !online) return false;
    const now = this.clock();
    const jobs = [];
    const nws = this.sources.nws;
    const moved = nws.fetchedAtProgress != null && Math.abs(progress - nws.fetchedAtProgress) > 20 * MILE;
    if (enabled.weather !== false && !nws.busy && (now >= nws.nextAt || moved)) jobs.push(this.fetchNws(plan, progress, now));
    const changed = this.updateCoverage(plan, progress, now);
    if (enabled.closures !== false) {
      for (const st of this.coverage.covered) {
        const s = this.wzdx[st];
        if (!s.busy && now >= s.nextAt) jobs.push(this.fetchWzdx(st, now));
      }
    }
    if (!jobs.length) return changed;
    await Promise.all(jobs);
    return true;
  }

  /// The states within 150 miles ahead, split into those with a readable feed and those without.
  updateCoverage(plan, progress, now) {
    const states = [];
    for (const seg of plan.states?.segments ?? []) {
      if (seg.code && seg.endDistance > progress && seg.startDistance < progress + WZDX_AHEAD && !states.includes(seg.code)) states.push(seg.code);
    }
    const proxy = this.proxyBase();
    const covered = [], uncovered = [];
    for (const st of states) {
      const feed = WZDX_FEEDS[st];
      if (!feed) uncovered.push(st);
      else if (!feed.cors && !proxy) uncovered.push(`${st} (needs the key proxy)`);
      else {
        covered.push(st);
        this.wzdx[st] ??= { ...source(wzdxSource(st).id, wzdxSource(st).name, WZDX_KINDS, feed.large ? 1800 : 600, feed.large ? 3600 : 1800), state: 'idle' };
      }
    }
    const key = `${covered}|${uncovered}`;
    if (this.coverage?.key === key) return false;
    this.coverage = { key, covered, uncovered, at: now };
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
    await this.attempt(s, now, async () => {
      const responses = [];
      for (const point of RoadAlerts.samplePoints(plan, progress)) {
        const url = `${NWS_URL}?point=${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
        const res = await this.fetchFn(url, { headers: { Accept: 'application/geo+json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        responses.push({ point: { lat: point.lat, lon: point.lon }, features: body.features ?? [] });
      }
      s.incidents = nwsIncidents(responses);
      s.fetchedAtProgress = progress;
    });
  }

  /// One state's work zone feed: directly when the browser may read it, else through the key proxy.
  async fetchWzdx(state, now) {
    const s = this.wzdx[state];
    const feed = WZDX_FEEDS[state];
    await this.attempt(s, now, async () => {
      const url = feed.cors ? feed.url : new URL(`v1/wzdx/${state}`, this.proxyBase()).href;
      const res = await this.fetchFn(url, { headers: { Accept: 'application/geo+json, application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = parseWzdx(await res.text());
      const updated = wzdxUpdatedAt(data);
      if (updated != null && now - updated > WZDX_STALE) throw new Error('feed not updated for over a day');
      s.incidents = wzdxIncidents(data, state);
    });
  }

  /// Runs one fetch with the shared bookkeeping: success marks the source fresh; a failure keeps the last
  /// good result until it is older than maxAgeSeconds (the engine then reports it unavailable) and backs off.
  async attempt(s, now, work) {
    s.busy = true;
    try {
      await work();
      s.state = 'ok';
      s.fetchedAt = now;
      s.error = null;
      s.failures = 0;
      s.nextAt = now + s.refreshSeconds;
    } catch (e) {
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
    Object.assign(this.sources.nws, { state: 'idle', fetchedAt: null, incidents: [], error: null, nextAt: 0, failures: 0, fetchedAtProgress: null });
    this.wzdx = {};
    this.coverage = null;
  }
}
