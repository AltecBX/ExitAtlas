// Current weather where you are, during a trip, from the National Weather Service: the point record (which
// forecast grid and which stations), the latest observations of the nearest stations, and the hourly
// forecast. Every 10 minutes or after 10 miles; the point record again after 5 miles. A failed refresh keeps
// the last answers, and the engine (engine/weather.js) still drops an observation once it is 90 minutes
// old; answers fetched more than 25 miles back are not shown at all. Same plan as
// App/ExitAtlas/Services/WeatherService.swift.
import { METERS_PER_MILE as MILE, distance } from '../engine/geo.js';
import { currentWeather, nearestStations } from '../engine/weather.js';

const API = 'https://api.weather.gov';

export class LiveWeather {
  constructor({ fetchFn = (...a) => fetch(...a), clock = () => Date.now() / 1000 } = {}) {
    this.fetchFn = fetchFn;
    this.clock = clock;
    this.reset();
  }

  reset() {
    this.point = null;       // {position, hourlyURL, place, timeZone, stations}
    this.answers = null;     // {position, observations, hourly}
    this.nextAt = 0;
    this.ranAt = -Infinity;
    this.failures = 0;
    this.busy = false;
    this.memo = null;
  }

  /// The weather to show at `position` now, or null (nothing current, or the answers are for elsewhere).
  current(position) {
    const a = this.answers;
    if (!a || !position || distance(a.position, position) > 25 * MILE) return null;
    const minute = Math.floor(this.clock() / 60);
    if (this.memo?.minute !== minute || this.memo.answers !== a) {
      const value = currentWeather({ observations: a.observations, hourly: a.hourly, now: this.clock(), place: this.point?.place ?? null });
      this.memo = { minute, answers: a, value: value && { ...value, timeZone: this.point?.timeZone ?? null } };
    }
    // How far the station is from where you are now, not from where it was looked up.
    const v = this.memo.value;
    return v?.station?.coordinate ? { ...v, station: { ...v.station, distance: distance(position, v.station.coordinate) } } : v;
  }

  /// Called with each new position while a trip runs; fetches when due. Returns true when something changed.
  async refresh(position, { online = true } = {}) {
    if (!position || !online || this.busy) return false;
    const now = this.clock();
    // Moving on: again after 10 miles, but not more than every 2 minutes (a simulated drive runs at 30 times
    // speed), and not while backing off after failures.
    const moved = this.answers && this.failures === 0 && distance(this.answers.position, position) > 10 * MILE && now - this.ranAt >= 120;
    if (now < this.nextAt && !moved) return false;
    this.busy = true;
    this.ranAt = now;
    try {
      if (!this.point || distance(this.point.position, position) > 5 * MILE) this.point = await this.loadPoint(position);
      const observations = [];
      for (const station of this.point.stations) {
        const body = await this.get(`${API}/stations/${station.id}/observations/latest`).catch(() => null);
        if (body) observations.push({ station, body });
        // The nearest station that reported recently is enough.
        const t = Date.parse(body?.properties?.timestamp ?? '') / 1000;
        if (body?.properties?.temperature?.value != null && now - t <= 90 * 60) break;
      }
      const hourly = this.point.hourlyURL ? await this.get(this.point.hourlyURL).catch(() => null) : null;
      if (!observations.length && !hourly) throw new Error('no weather answers');
      this.answers = { position: { lat: position.lat, lon: position.lon }, observations, hourly };
      this.failures = 0;
      this.nextAt = now + 600;
    } catch {
      this.failures += 1;
      this.nextAt = now + Math.min(1800, 60 * 2 ** Math.min(this.failures, 5));
    } finally {
      this.busy = false;
    }
    return true;
  }

  async loadPoint(position) {
    // Rounded to about 1 km: enough for the forecast grid, and no more of your position than needed.
    const p = (await this.get(`${API}/points/${position.lat.toFixed(2)},${position.lon.toFixed(2)}`)).properties ?? {};
    const rel = p.relativeLocation?.properties;
    const stations = p.observationStations ? nearestStations(await this.get(`${p.observationStations}?limit=10`), position) : [];
    return { position: { lat: position.lat, lon: position.lon }, hourlyURL: p.forecastHourly, stations, timeZone: p.timeZone ?? null,
      place: rel?.city ? `${rel.city}, ${rel.state}` : null };
  }

  async get(url) {
    const res = await this.fetchFn(url, { headers: { Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
