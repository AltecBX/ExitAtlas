// Weather ahead on the route, during a trip, from the National Weather Service (public domain, no key): the
// point record of each route position ahead (which forecast grid; looked up once, rounded to about 1 km), and
// each grid's hourly forecast (again after 20 minutes). One request at a time, a short pause between them.
// Refreshed every 20 minutes, and after 40 miles (not more than every 2 minutes, for a simulated drive). A
// failed request leaves that stretch "unavailable"; the engine (engine/weatherahead.js) never shows a forecast
// fetched more than 2 hours ago. Forecasts no point uses any more are dropped.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { AHEAD_RULES, samplePoints, forecastAt, weatherAhead } from '../engine/weatherahead.js';
import { withTimeout } from './net.js';

const API = 'https://api.weather.gov';
const FORECAST_TTL = 20 * 60;
const REFRESH = 20 * 60;
const MOVED = 40 * MILE;

export class WeatherAhead {
  constructor({ fetchFn = (...a) => fetch(...a), clock = () => Date.now() / 1000, timeoutMs = 15000, pauseMs = 250, rules = AHEAD_RULES } = {}) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.pauseMs = pauseMs;
    this.rules = rules;
    this.generation = 0;
    this.reset();
  }

  reset() {
    this.routeId = null;
    this.grids = new Map();      // "lat,lon" (2 decimals) -> {hourlyURL, timeZone}
    this.forecasts = new Map();  // hourly URL -> {body, fetchedAt}
    this.samples = [];           // [{along, coordinate, key}]
    this.nextAt = 0;
    this.ranAt = -Infinity;
    this.fetchedAtProgress = null;
    this.failures = 0;
    this.busy = false;
    this.requests = 0;
    this.memo = null;
  }

  /// Called with each new snapshot while a trip runs; fetches when due. Returns true when something changed.
  async refresh(plan, s, { online = true, enabled = true } = {}) {
    if (!plan || !s || !online || !enabled || this.busy) return false;
    const now = this.clock();
    if (plan.route.id !== this.routeId) {
      this.routeId = plan.route.id;
      this.samples = [];
      this.nextAt = 0;
      this.fetchedAtProgress = null;
    }
    const moved = this.fetchedAtProgress !== null && s.progress - this.fetchedAtProgress > MOVED && now - this.ranAt >= 120;
    if (now < this.nextAt && !moved) return false;
    this.busy = true;
    this.ranAt = now;
    const generation = this.generation;
    try {
      const etaAt = (d) => now + (s.etaTo(d) - s.t);
      const points = samplePoints(plan.route, s.progress, etaAt, now, this.rules);
      const samples = [];
      let read = 0;
      for (const p of points) {
        if (generation !== this.generation) return false;
        const key = `${p.coordinate.lat.toFixed(2)},${p.coordinate.lon.toFixed(2)}`;
        let grid = this.grids.get(key);
        if (!grid) {
          grid = await this.loadGrid(key);
          if (grid) this.grids.set(key, grid);
        }
        if (grid?.hourlyURL) {
          const f = this.forecasts.get(grid.hourlyURL);
          if (!f || this.clock() - f.fetchedAt > FORECAST_TTL) {
            const body = await this.get(grid.hourlyURL).catch(() => null);
            if (body?.properties?.periods) this.forecasts.set(grid.hourlyURL, { body, fetchedAt: this.clock() });
            await this.pause();
          }
          if (this.forecasts.has(grid.hourlyURL)) read += 1;
        }
        samples.push({ along: p.along, coordinate: p.coordinate, key });
      }
      if (generation !== this.generation) return false;
      this.samples = samples;
      this.fetchedAtProgress = s.progress;
      // Forecasts no point ahead uses any more are dropped (each is about 160 KB).
      const used = new Set(samples.map((x) => this.grids.get(x.key)?.hourlyURL).filter(Boolean));
      for (const url of this.forecasts.keys()) if (!used.has(url)) this.forecasts.delete(url);
      if (this.grids.size > 400) this.grids.clear();
      this.failures = read === 0 && samples.length ? this.failures + 1 : 0;
      this.nextAt = now + (this.failures ? Math.min(1800, 60 * 2 ** Math.min(this.failures, 5)) : REFRESH);
      this.memo = null;
    } finally {
      if (generation === this.generation) this.busy = false;
    }
    return true;
  }

  async loadGrid(key) {
    try {
      const p = (await this.get(`${API}/points/${key}`)).properties ?? {};
      return p.forecastHourly ? { hourlyURL: p.forecastHourly, timeZone: p.timeZone ?? null } : null;
    } catch {
      return null;
    } finally {
      await this.pause();
    }
  }

  /// What to show for the snapshot: engine/weatherahead.js weatherAhead() plus the time zone of each stretch,
  /// or null before the first answer. Recomputed each minute and every quarter mile.
  ahead(s) {
    if (!s || !this.samples.length) return null;
    const now = this.clock();
    const key = `${Math.floor(now / 60)}|${Math.floor(s.progress / 400)}`;
    if (this.memo?.key === key && this.memo.samples === this.samples) return this.memo.value;
    const points = this.samples.map((x) => {
      const eta = x.along <= s.progress ? now : now + (s.etaTo(x.along) - s.t);
      const grid = this.grids.get(x.key);
      const f = grid ? this.forecasts.get(grid.hourlyURL) : null;
      return { along: x.along, eta, timeZone: grid?.timeZone ?? null, w: forecastAt(f?.body ?? null, eta, now, f?.fetchedAt ?? null, this.rules) };
    });
    const value = weatherAhead(points, s.progress, this.rules);
    for (const st of value.stretches) st.timeZone = points.find((p) => p.along + this.rules.spacing / 2 > st.start)?.timeZone ?? null;
    this.memo = { key, samples: this.samples, value };
    return value;
  }

  /// A trip ended or the route changed under a refresh: its answers are not used.
  stop() {
    this.generation += 1;
    this.reset();
  }

  pause() {
    return this.pauseMs > 0 ? new Promise((r) => setTimeout(r, this.pauseMs)) : Promise.resolve();
  }

  async get(url) {
    this.requests += 1;
    return withTimeout(async (signal) => {
      const res = await this.fetchFn(url, { headers: { Accept: 'application/geo+json' }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }, this.timeoutMs);
  }
}
