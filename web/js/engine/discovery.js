// Discovery mode, stop planning and GPS simulation.
// Port of Discovery/HighwayDiscovery.swift, Planning/StopPlanner.swift and Simulation/GPSSimulator.swift.
import { METERS_PER_MILE, normalizedDegrees, offset } from './geo.js';
import { PlannedRoute, TravelTimeProfile, makeStep, parseHighways } from './route.js';
import { searchAlongRoute } from './exits.js';
import { matchesFavorite } from './fuel.js';

/// Works out which interstate and direction the driver is on, without a destination.
export class HighwayDiscovery {
  constructor(corridors) {
    this.corridors = corridors;
    this.requiredConfirmations = 3;
    this.releaseAfterMisses = 5;
    this.minimumSpeed = 6; // m/s, about 13 mph
    this.state = { kind: 'searching' };
    this.candidateKey = null;
    this.candidateDistance = 0;
    this.confirmations = 0;
    this.misses = 0;
  }

  ingest(sample) {
    if (sample.course == null || sample.speed == null || sample.speed < this.minimumSpeed
      || !(sample.accuracy >= 0) || sample.accuracy > 65) {
      return this.state;
    }
    const radius = Math.max(35, sample.accuracy + 20);
    const matches = this.corridors.matches(sample.coordinate, sample.course, radius);
    if (this.state.kind === 'locked') {
      const cur = this.state.match;
      const same = matches.find((m) => m.corridor.id === cur.corridor.id && m.partIndex === cur.partIndex);
      if (same) {
        this.misses = 0;
        this.state = { kind: 'locked', match: same };
      } else {
        this.misses += 1;
        if (this.misses >= this.releaseAfterMisses) {
          this.state = { kind: 'searching' };
          this.candidateKey = null;
          this.confirmations = 0;
          this.misses = 0;
        }
      }
      return this.state;
    }
    const best = matches[0];
    if (!best) {
      this.candidateKey = null;
      this.confirmations = 0;
      return this.state;
    }
    const key = this.candidateKey;
    if (key && key.corridor === best.corridor.id && key.part === best.partIndex
      && best.projection.distanceAlong >= this.candidateDistance - 30) {
      this.confirmations += 1;
    } else {
      this.candidateKey = { corridor: best.corridor.id, part: best.partIndex };
      this.confirmations = 1;
    }
    this.candidateDistance = best.projection.distanceAlong;
    if (this.confirmations >= this.requiredConfirmations) {
      this.state = { kind: 'locked', match: best };
      this.misses = 0;
    }
    return this.state;
  }

  /// A route for the corridor ahead of the match, so the normal trip engine can run.
  static routeAhead(match, lookahead = 400 * METERS_PER_MILE, now = Date.now()) {
    const part = match.part;
    const start = match.projection.distanceAlong;
    const polyline = part.slice(start, Math.min(part.length, start + lookahead));
    const profile = TravelTimeProfile.uniform(polyline.length, polyline.length / match.corridor.averageSpeed);
    const ref = parseHighways(match.corridor.highway)[0];
    const steps = [makeStep(0, polyline.length, match.corridor.displayName, match.corridor.highway, ref ? [ref] : [])];
    return new PlannedRoute({
      source: 'corridor', polyline, steps, timeProfile: profile,
      origin: { name: 'Current location', coordinate: polyline.point(0) },
      destination: { name: `End of ${match.corridor.displayName}`, coordinate: polyline.point(polyline.pointCount - 1) },
      createdAt: now, title: match.corridor.displayName,
    });
  }
}

/// Distance window ahead for "about N hours ahead, plus or minus a tolerance", pace adjusted.
export function timeWindow(plan, d, seconds, tolerance, pace) {
  const profile = plan.route.timeProfile;
  const lo = profile.distanceAfter(pace.modelSecondsFor(Math.max(0, seconds - tolerance)), d);
  const hi = profile.distanceAfter(pace.modelSecondsFor(seconds + tolerance), d);
  return [lo, Math.max(lo, hi)];
}

/// Stop suggestions in a window, ranked, each with the reasons behind its place.
/// options: {favorites: brand names, restAreas: true to add rest areas and plazas on the highway (they
/// cost no detour)}.
/// Ranking for a time window: minutes from the target time, plus twice the detour time, minus five
/// minutes for a favorite brand and five for restrooms that OpenStreetMap lists. Distance windows keep
/// route order.
export function stopSuggestions(dataset, plan, snapshot, pace, requirements, window, servicesFor, options = {}) {
  const d = snapshot.progress;
  let range, target = null;
  if (window.kind === 'time') {
    range = timeWindow(plan, d, window.seconds, window.tolerance, pace);
    target = snapshot.t + window.seconds;
  } else {
    range = [d + window.from, d + window.to];
  }
  const favorites = options.favorites ?? [];
  const isFavorite = (name) => favorites.length > 0 && Boolean(name) && matchesFavorite(name, favorites);
  const out = [];
  for (const m of searchAlongRoute(dataset, plan.exits, requirements, range[0], range[1], servicesFor)) {
    const eta = snapshot.etaTo(m.exit.distanceAlongRoute);
    const best = m.matchesPerRequirement.map((hits) => hits[0]);
    const detourSeconds = best.reduce((sum, x) => sum + (x.detourSeconds ?? x.detourMeters / 13.4), 0);
    const favorite = m.matchesPerRequirement.some((hits) => hits.some((x) => isFavorite(x.place.brand || x.place.name)));
    out.push({ match: m, distanceAhead: m.exit.distanceAlongRoute - d, eta, timeFromTarget: target !== null ? eta - target : null,
      detourMeters: m.combinedDetourMeters, detourSeconds, favorite, restrooms: null });
  }
  if (options.restAreas) {
    const nameQuery = requirements.map((r) => (r.nameOrBrand ?? '').trim().toLowerCase()).find(Boolean);
    for (const r of plan.restAreasBetween(range[0], range[1])) {
      if (nameQuery && ![r.name, ...r.gas, ...r.food].some((n) => n.toLowerCase().includes(nameQuery))) continue;
      const eta = snapshot.etaTo(r.distanceAlongRoute);
      out.push({ restArea: r, distanceAhead: r.distanceAlongRoute - d, eta, timeFromTarget: target !== null ? eta - target : null,
        detourMeters: 0, detourSeconds: 0, favorite: [...r.gas, ...r.food].some(isFavorite), restrooms: r.amenities.toilets ?? null });
    }
  }
  for (const x of out) {
    x.score = (target !== null ? Math.abs(x.timeFromTarget) : 0) + 2 * x.detourSeconds - (x.favorite ? 300 : 0) - (x.restrooms ? 300 : 0);
    x.reasons = stopReasons(x);
  }
  if (target !== null) out.sort((a, b) => a.score - b.score);
  else out.sort((a, b) => a.distanceAhead - b.distanceAhead);
  return out;
}

function stopReasons(x) {
  const reasons = [];
  if (x.timeFromTarget !== null) {
    const min = Math.round(x.timeFromTarget / 60);
    reasons.push(Math.abs(min) < 5 ? 'Right on time' : min < 0 ? `${-min} min early` : `${min} min late`);
  }
  if (x.restArea) reasons.push(x.restArea.side === 'both' ? 'On the highway, both directions' : 'On the highway, no detour');
  else reasons.push(`About ${(x.detourMeters / METERS_PER_MILE).toFixed(1)} mi detour (estimate)`);
  if (x.favorite) reasons.push('Favorite brand');
  if (x.restrooms === true) reasons.push('Restrooms listed');
  if (x.restrooms === false) reasons.push('No restrooms');
  return reasons;
}

// MARK: Simulation

/// Seeded random numbers for reproducible simulations (mulberry32).
export function seededRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = () => {
    const u1 = Math.max(next(), 1e-12), u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return { next, gaussian };
}

/// Generates simulated GPS fixes along a route. Output is simulated data; the app labels it.
export class GPSSimulator {
  constructor(route, { interval = 1, noise = 4, reportedAccuracy = 6, speedFactor = 1, seed = 42, dropouts = [], departure = null } = {}) {
    this.route = route;
    this.o = { interval, noise, reportedAccuracy, speedFactor, seed, dropouts, departure };
    this.rng = seededRandom(seed);
    this.d = 0;
    this.lateral = 0;
  }

  /// Next fix from the current distance, or null at the end. Returns {sample, truth}.
  step(t) {
    const { route, o, rng } = this;
    if (this.d >= route.length) return null;
    const d = this.d;
    const speed = Math.max(route.timeProfile.speedAt(d), 3) * o.speedFactor;
    let coordinate = route.polyline.coordinateAt(d);
    const bearing = route.polyline.bearingAt(d);
    let course = bearing;
    if (o.departure && d >= o.departure.atDistance) {
      this.lateral += o.departure.lateralSpeed * o.interval;
      coordinate = offset(coordinate, bearing + 90, this.lateral);
      course = bearing + 45;
    }
    this.d += speed * o.interval;
    if (o.dropouts.some(([a, b]) => d >= a && d <= b)) return { sample: null, truth: d };
    const north = rng.gaussian() * o.noise, east = rng.gaussian() * o.noise;
    const noisy = offset(offset(coordinate, 0, north), 90, east);
    return {
      sample: {
        coordinate: noisy, accuracy: o.reportedAccuracy,
        course: normalizedDegrees(course + rng.gaussian() * 3), speed, t,
      },
      truth: d,
    };
  }

  /// Fixes from `start` to `end` meters, one per interval from startTime.
  trace(start = 0, end = null, startTime = 0) {
    this.d = Math.max(0, start);
    const stop = Math.min(end ?? this.route.length, this.route.length);
    const out = [];
    let t = startTime;
    while (this.d < stop) {
      const r = this.step(t);
      if (!r) break;
      if (r.sample) out.push(r);
      t += this.o.interval;
    }
    return out;
  }
}
