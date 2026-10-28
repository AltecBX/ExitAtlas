// GPS map matching, driven mileage ledger and pace model. Port of Tracking/*.swift.
// Times are seconds (epoch seconds as floating point).
import { angleDifference, isValid } from './geo.js';

/// A GPS fix: {coordinate:{lat,lon}, accuracy (m, negative invalid), course (deg|null), speed (m/s|null), t (s)}.

export const TrackerConfig = Object.freeze({
  maxAcceptableAccuracy: 150,
  offRouteDistance: 60,
  offRouteConfirmations: 3,
  offRouteMinimumDuration: 6,
  deadReckoningAfter: 4,
  deadReckoningLimit: 180,
  backwardTolerance: 40,
});

/// Map matches GPS fixes onto a route polyline. Status: acquiring, onRoute, offRoute, signalLost.
export class RouteProgressTracker {
  constructor(route, startedAt, config = TrackerConfig) {
    this.route = route;
    this.config = config;
    this.match = { status: 'acquiring', distanceAlongRoute: 0, offset: null, isEstimated: false, t: startedAt, speed: 0 };
    this.lastAccepted = null;
    this.offRouteCount = 0;
    this.firstOffRouteTime = null;
  }

  ingest(sample) {
    const cfg = this.config;
    const accuracy = sample.accuracy;
    if (!(accuracy >= 0) || accuracy > cfg.maxAcceptableAccuracy || !isValid(sample.coordinate)) {
      return this.estimate(sample.t);
    }
    const threshold = Math.max(cfg.offRouteDistance, accuracy * 1.5);
    const candidates = this.route.projections(sample.coordinate, threshold * 2);
    const moving = (sample.speed ?? 0) >= 3 && sample.course != null;
    let best = null, bestCost = Infinity;
    for (const p of candidates) {
      const c = this.cost(p, sample, moving);
      if (c < bestCost) { bestCost = c; best = p; }
    }
    let headingMismatch = false;
    if (best && moving) {
      headingMismatch = angleDifference(sample.course, this.route.bearingAt(best.distanceAlong)) > 100;
    }
    if (!best || best.offset > threshold || headingMismatch) {
      this.registerMiss(sample);
      return this.match;
    }
    this.offRouteCount = 0;
    this.firstOffRouteTime = null;
    let distance = best.distanceAlong;
    const m = this.match;
    if (m.status === 'onRoute' && distance < m.distanceAlongRoute && m.distanceAlongRoute - distance <= cfg.backwardTolerance) {
      distance = m.distanceAlongRoute; // GPS jitter: never step backwards
    }
    const speed = this.smoothedSpeed(sample, distance);
    this.match = {
      status: 'onRoute', distanceAlongRoute: Math.min(distance, this.route.length), offset: best.offset,
      isEstimated: false, t: sample.t, speed,
    };
    this.lastAccepted = sample;
    return this.match;
  }

  /// Position at a time without a new fix (dead reckoning along the route).
  estimate(t) {
    const m = this.match, last = this.lastAccepted;
    if (!(m.status === 'onRoute' || m.status === 'signalLost') || !last) return m;
    const elapsed = t - last.t;
    if (!(elapsed > this.config.deadReckoningAfter)) return m;
    const usable = Math.min(elapsed, this.config.deadReckoningLimit);
    const out = { ...m, distanceAlongRoute: Math.min(this.route.length, m.distanceAlongRoute + m.speed * usable), isEstimated: true, t };
    if (elapsed > this.config.deadReckoningLimit) out.status = 'signalLost';
    return out;
  }

  reset(distance, t, speed = 0) {
    this.match = { status: 'onRoute', distanceAlongRoute: distance, offset: null, isEstimated: false, t, speed };
    this.offRouteCount = 0;
    this.firstOffRouteTime = null;
  }

  cost(p, sample, moving) {
    const cfg = this.config, m = this.match;
    let c = p.offset / Math.max(sample.accuracy, 5);
    if (moving) {
      const diff = angleDifference(sample.course, this.route.bearingAt(p.distanceAlong));
      c += diff / 30;
      if (diff > 100) c += 10;
    }
    if (m.status === 'acquiring') {
      c += 0.5 * p.distanceAlong / Math.max(this.route.length, 1);
    } else {
      const dt = Math.max(0, sample.t - m.t);
      const expected = m.distanceAlongRoute + m.speed * dt;
      const tolerance = 50 + 0.5 * m.speed * dt + sample.accuracy;
      const delta = (p.distanceAlong - expected) / tolerance;
      c += Math.min(delta * delta, 50);
      if (p.distanceAlong < m.distanceAlongRoute - cfg.backwardTolerance) c += 5;
    }
    return c;
  }

  registerMiss(sample) {
    const cfg = this.config;
    this.offRouteCount += 1;
    if (this.firstOffRouteTime === null) this.firstOffRouteTime = sample.t;
    const elapsed = sample.t - this.firstOffRouteTime;
    const m = { ...this.match };
    if (this.offRouteCount >= cfg.offRouteConfirmations && elapsed >= cfg.offRouteMinimumDuration && m.status !== 'acquiring') {
      m.status = 'offRoute';
      m.isEstimated = false;
    }
    m.t = sample.t;
    if (sample.speed != null && sample.speed >= 0) m.speed = sample.speed;
    this.match = m;
  }

  smoothedSpeed(sample, newDistance) {
    if (sample.speed != null && sample.speed >= 0) {
      return this.match.status === 'onRoute' ? 0.6 * sample.speed + 0.4 * this.match.speed : sample.speed;
    }
    if (this.lastAccepted) {
      const dt = sample.t - this.lastAccepted.t;
      if (dt > 0) return Math.max(0, (newDistance - this.match.distanceAlongRoute) / dt);
    }
    return this.match.speed;
  }
}

/// What has actually been driven, by state, across route changes.
export class TripLedger {
  constructor(json = null) {
    this.stints = json?.stints ? json.stints.map((s) => ({ ...s })) : [];
    this.startedAt = json?.startedAt ?? null;
  }

  toJSON() { return { stints: this.stints, startedAt: this.startedAt }; }

  get totalMeters() { return this.stints.reduce((sum, s) => sum + s.meters, 0); }

  get totalsByRegion() {
    const order = [], meters = new Map(), names = new Map(), codes = new Map();
    for (const s of this.stints) {
      const key = s.code ?? '-';
      if (!meters.has(key)) { order.push(key); meters.set(key, 0); }
      meters.set(key, meters.get(key) + s.meters);
      names.set(key, s.name);
      codes.set(key, s.code);
    }
    return order.map((k) => ({ code: codes.get(k), name: names.get(k), meters: meters.get(k) }));
  }

  /// Records on-route progress from d0 to d1, split across the route's state segments.
  recordRouteProgress(d0, d1, states, startTime, endTime) {
    if (!(d1 > d0)) return;
    if (this.startedAt === null) this.startedAt = startTime;
    const span = d1 - d0, duration = endTime - startTime;
    let cursor = d0;
    while (cursor < d1) {
      const index = states.segmentIndexAt(cursor);
      if (index === null) return;
      const seg = states.segments[index];
      const pieceEnd = Math.min(d1, seg.endDistance > cursor ? seg.endDistance : d1);
      const timeAtStart = startTime + duration * ((cursor - d0) / span);
      this.add(pieceEnd - cursor, seg.code, seg.displayName, timeAtStart);
      if (pieceEnd <= cursor) break;
      cursor = pieceEnd;
    }
  }

  recordOffRoute(meters, region, t) {
    if (!(meters > 0)) return;
    if (this.startedAt === null) this.startedAt = t;
    this.add(meters, region ? region.code : null, region ? region.name : 'Outside U.S. states', t);
  }

  add(meters, code, name, t) {
    if (!(meters > 0)) return;
    const last = this.stints[this.stints.length - 1];
    if (last && last.code === code) {
      last.meters += meters;
    } else {
      if (last) last.exitedAt = t;
      this.stints.push({ code, name, meters, enteredAt: t, exitedAt: null });
    }
  }
}

/// Seconds of moving time over which recent pace fades (exponential time constant).
export const RECENT_PACE_TAU = 300;
/// Modeled seconds ahead that are predicted entirely at the recent pace.
export const RECENT_PACE_HORIZON = 1800;
/// Beyond the horizon, the prediction moves from recent pace to trip pace with this time constant.
export const PACE_BLEND_TAU = 3600;

const clampFactor = (f) => Math.min(Math.max(f, 0.4), 2.5);

/// Learns the driver's moving pace against the travel time model (OSRM road speeds).
///
/// Both estimates are ratios of actual to modeled seconds over moving time only, so stops never
/// count as slow driving:
///   * recent pace: about the last 5 minutes of moving time;
///   * trip pace: everything driven this trip, with a 15 minute prior centered on the driver's
///     pace from earlier trips (or the model when there is no history).
/// Predicted time to a target is the integral of the pace over the modeled road ahead: the next
/// 30 modeled minutes at the recent pace, then shifting to trip pace with a 1 hour time constant.
/// The prediction always increases with distance, so ETAs along the route stay in order.
export class PaceModel {
  constructor(json = null, { priorFactor = 1 } = {}) {
    this.observedSeconds = json?.observedSeconds ?? 0;
    this.expectedSeconds = json?.expectedSeconds ?? 0;
    this.priorSeconds = json?.priorSeconds ?? 900;
    this.priorFactor = clampFactor(json?.priorFactor ?? priorFactor);
    this.recentObserved = json?.recentObserved ?? 0;
    this.recentExpected = json?.recentExpected ?? 0;
    this.recentMeters = json?.recentMeters ?? 0;
  }

  toJSON() {
    return {
      observedSeconds: this.observedSeconds, expectedSeconds: this.expectedSeconds, priorSeconds: this.priorSeconds,
      priorFactor: this.priorFactor, recentObserved: this.recentObserved, recentExpected: this.recentExpected,
      recentMeters: this.recentMeters,
    };
  }

  /// Trip ratio of actual to modeled time. Below 1 means faster than the model.
  get factor() {
    return clampFactor((this.observedSeconds + this.priorSeconds * this.priorFactor) / (this.expectedSeconds + this.priorSeconds));
  }

  /// Ratio over about the last 5 minutes of moving time, or null with under 2 minutes of data.
  get recentFactor() {
    if (this.recentObserved < 120 || !(this.recentExpected > 0)) return null;
    return clampFactor(this.recentObserved / this.recentExpected);
  }

  /// Average moving speed over the recent window (m/s), or null.
  get recentSpeed() {
    return this.recentObserved >= 120 ? this.recentMeters / this.recentObserved : null;
  }

  /// Predicted driving seconds for a stretch the model says takes `modelSeconds`.
  secondsFor(modelSeconds) {
    const s = Math.max(0, modelSeconds);
    const trip = this.factor, recent = this.recentFactor;
    if (recent === null) return trip * s;
    // Integral of the weight of recent pace: 1 up to the horizon, then exponential decay.
    const h = RECENT_PACE_HORIZON, tau = PACE_BLEND_TAU;
    const w = s <= h ? s : h + tau * (1 - Math.exp(-(s - h) / tau));
    return trip * s + (recent - trip) * w;
  }

  /// Average factor over a stretch of `modelSeconds` (predicted seconds / modeled seconds).
  factorFor(modelSeconds) {
    if (!(modelSeconds > 0)) return this.recentFactor ?? this.factor;
    return this.secondsFor(modelSeconds) / modelSeconds;
  }

  /// Modeled seconds that take `seconds` of predicted driving (inverse of secondsFor).
  modelSecondsFor(seconds) {
    let lo = 0, hi = Math.max(1, seconds / 0.4);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.secondsFor(mid) < seconds) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  observe(expected, actual, meters = 0) {
    if (!(expected > 0) || !(actual > 0) || !(actual < 600)) return;
    this.expectedSeconds += expected;
    this.observedSeconds += actual;
    const decay = Math.exp(-actual / RECENT_PACE_TAU);
    this.recentObserved = this.recentObserved * decay + actual;
    this.recentExpected = this.recentExpected * decay + expected;
    this.recentMeters = this.recentMeters * decay + meters;
  }
}
