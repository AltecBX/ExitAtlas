// Discovery mode, stop planning, fuel range and GPS simulation.
// Port of Discovery/HighwayDiscovery.swift, Planning/*.swift and Simulation/GPSSimulator.swift.
import { METERS_PER_MILE, normalizedDegrees, offset } from './geo.js';
import { PlannedRoute, TravelTimeProfile, makeStep, parseHighways } from './route.js';
import { searchAlongRoute } from './exits.js';

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
  const lo = profile.distanceAfter(Math.max(0, seconds - tolerance) / pace.factor, d);
  const hi = profile.distanceAfter((seconds + tolerance) / pace.factor, d);
  return [lo, Math.max(lo, hi)];
}

/// Stop suggestions in a window, with ETA and distance from the target time when given.
export function stopSuggestions(dataset, plan, snapshot, pace, requirements, window, servicesFor) {
  const d = snapshot.progress;
  let range, target = null;
  if (window.kind === 'time') {
    range = timeWindow(plan, d, window.seconds, window.tolerance, pace);
    target = snapshot.t + window.seconds;
  } else {
    range = [d + window.from, d + window.to];
  }
  const matches = searchAlongRoute(dataset, plan.exits, requirements, range[0], range[1], servicesFor);
  const out = matches.map((m) => {
    const eta = snapshot.t + plan.route.timeProfile.secondsBetween(d, m.exit.distanceAlongRoute) * pace.factor;
    return { match: m, distanceAhead: m.exit.distanceAlongRoute - d, eta, timeFromTarget: target !== null ? eta - target : null };
  });
  if (target !== null) out.sort((a, b) => Math.abs(a.timeFromTarget) - Math.abs(b.timeFromTarget));
  return out;
}

/// Gas stations ahead with range and detour. No prices: there is no licensed price source yet.
/// vehicle: {mpg, tankGallons, reserveGallons}
export function fuelOptions(plan, snapshot, vehicle, fuelGallons, servicesFor) {
  const metersPerGallon = vehicle.mpg * METERS_PER_MILE;
  const usable = Math.max(0, fuelGallons - vehicle.reserveGallons) * metersPerGallon;
  const horizon = Math.min(usable * 1.5, 500 * METERS_PER_MILE);
  const d = snapshot.progress;
  const out = [];
  for (const exit of plan.exitsBetween(d, d + horizon)) {
    const ahead = exit.distanceAlongRoute - d;
    for (const service of servicesFor(exit)) {
      if (service.place.category !== 1) continue;
      const oneWay = service.detourMeters / 2;
      out.push({
        exit, ahead, service, reachable: ahead + oneWay <= usable,
        detourGallons: service.detourMeters / metersPerGallon,
      });
    }
  }
  return { usableMeters: usable, options: out };
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
