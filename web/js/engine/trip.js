// Trip plan, dashboard snapshot and live session. Port of Trip/*.swift.
import { METERS_PER_MILE, distance as geoDistance } from './geo.js';
import { RegionSegmenter } from './datasets.js';
import { ExitMatcher, optionsForSource } from './exits.js';
import { RouteProgressTracker, TripLedger, PaceModel } from './tracking.js';

function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

function upperBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; }
  return lo;
}

/// Everything derived from one route: ordered state segments, time zones and exits.
/// datasets: {states: RegionIndex, timeZones: TimeZoneResolver|null, interstates: InterstateDataset|null}
export class TripPlan {
  constructor(route, datasets, { segmenter = new RegionSegmenter(), matcher = null } = {}) {
    this.route = route;
    this.states = segmenter.segment(route.polyline, datasets.states);
    this.exits = datasets.interstates
      ? (matcher ?? new ExitMatcher(optionsForSource(route.source))).match(route.polyline, datasets.interstates)
      : [];
    this.exitDistances = this.exits.map((e) => e.distanceAlongRoute);
    this.timeZones = datasets.timeZones ?? null;
    this.timeZoneIDs = this.states.segments.map((seg) => (
      this.timeZones ? this.timeZones.identifier(seg.entryCoordinate, seg.code) : null));
  }

  /// Exits strictly after `start` and before `end`, counted by position, never by exit numbers.
  exitCount(start, end) {
    if (!(end > start)) return 0;
    return lowerBound(this.exitDistances, end) - upperBound(this.exitDistances, start);
  }

  exitsBetween(start, end) {
    const lo = upperBound(this.exitDistances, start), hi = upperBound(this.exitDistances, end);
    return lo < hi ? this.exits.slice(lo, hi) : [];
  }

  nextExit(distance) {
    const i = upperBound(this.exitDistances, distance);
    return i < this.exits.length ? this.exits[i] : null;
  }

  timeZoneIDAt(distance) {
    if (!this.timeZones) return null;
    const code = this.states.segmentAt(distance)?.code ?? null;
    return this.timeZones.identifier(this.route.polyline.coordinateAt(distance), code);
  }

  timeZoneIDAtSegmentStart(index) {
    return index < this.timeZoneIDs.length ? this.timeZoneIDs[index] : null;
  }

  /// Dashboard snapshot for the current match. Times are epoch seconds.
  snapshot(match, ledger, pace, now, { exitLookahead = 100 * METERS_PER_MILE, maxUpcomingExits = 200 } = {}) {
    const route = this.route;
    const d = Math.min(Math.max(match.distanceAlongRoute, 0), route.length);
    const factor = pace.factor;
    const eta = (target) => {
      let seconds = route.timeProfile.secondsBetween(d, target) * factor;
      for (const stop of route.stops) {
        if (stop.distanceAlongRoute > d && stop.distanceAlongRoute < target) seconds += stop.plannedDwell ?? 0;
      }
      return now + seconds;
    };
    const segs = this.states.segments;
    const currentIndex = this.states.segmentIndexAt(d);
    const lastStint = ledger.stints[ledger.stints.length - 1] ?? null;
    const itinerary = segs.map((seg) => {
      const status = currentIndex === null ? 'upcoming'
        : seg.index < currentIndex ? 'completed' : seg.index === currentIndex ? 'current' : 'upcoming';
      const entryTZ = this.timeZoneIDAtSegmentStart(seg.index);
      const exitTZ = seg.index + 1 < segs.length ? this.timeZoneIDAtSegmentStart(seg.index + 1) : this.timeZoneIDAt(seg.endDistance);
      const exitCount = this.exitCount(seg.startDistance, seg.endDistance);
      let f;
      if (status === 'completed') {
        f = { drivenMeters: seg.length, remainingMeters: 0, exitCount, exitsRemaining: 0, entryTime: null, exitTime: null };
      } else if (status === 'current') {
        let driven = d - seg.startDistance, entered = null;
        if (lastStint && lastStint.code === seg.code) {
          driven = Math.max(driven, lastStint.meters);
          entered = lastStint.enteredAt;
        }
        f = {
          drivenMeters: driven, remainingMeters: seg.endDistance - d, exitCount,
          exitsRemaining: this.exitCount(d, seg.endDistance), entryTime: entered, exitTime: eta(seg.endDistance),
        };
      } else {
        f = {
          drivenMeters: 0, remainingMeters: seg.length, exitCount, exitsRemaining: exitCount,
          entryTime: eta(seg.startDistance), exitTime: eta(seg.endDistance),
        };
      }
      f.segment = seg;
      f.status = status;
      f.entryTimeZoneID = entryTZ;
      f.exitTimeZoneID = exitTZ;
      f.totalMeters = f.drivenMeters + f.remainingMeters;
      f.fractionComplete = f.totalMeters > 0 ? Math.min(1, f.drivenMeters / f.totalMeters) : 0;
      f.plannedDuration = f.entryTime !== null && f.exitTime !== null ? f.exitTime - f.entryTime : null;
      return f;
    });
    const current = currentIndex !== null ? itinerary[currentIndex] : null;
    const next = currentIndex !== null && currentIndex + 1 < itinerary.length ? itinerary[currentIndex + 1] : null;
    const toUpcoming = (e) => ({
      exit: e, distance: e.distanceAlongRoute - d, eta: eta(e.distanceAlongRoute),
      stateCode: this.states.segmentAt(e.distanceAlongRoute)?.code ?? null,
    });
    const upcomingExits = this.exitsBetween(d, d + exitLookahead).slice(0, maxUpcomingExits).map(toUpcoming);
    const ne = this.nextExit(d);
    const ahead = itinerary.filter((f) => f.status === 'upcoming');
    const statesAhead = [];
    for (const f of ahead) {
      const code = f.segment.code;
      if (code && code !== current?.segment.code && !statesAhead.includes(code)) statesAhead.push(code);
    }
    const stop = route.stops.find((s) => s.distanceAlongRoute > d);
    const arrival = eta(route.length);
    return {
      t: now, match, routeLength: route.length, progress: d, remaining: route.length - d,
      drivenTotal: Math.max(ledger.totalMeters, d), eta: arrival, timeRemaining: arrival - now,
      paceFactor: factor, highway: route.highwayAt(d), current, next, itinerary,
      nextExit: ne ? toUpcoming(ne) : null, upcomingExits,
      borderCrossingsRemaining: ahead.length, statesAhead,
      nextStop: stop ? { stop, distance: stop.distanceAlongRoute - d, eta: eta(stop.distanceAlongRoute) } : null,
      drivenStints: ledger.stints,
      distanceToNextBorder: current && next ? current.remainingMeters : null,
    };
  }
}

/// Live trip: plan, GPS tracking, driven history and pace. Survives reroutes.
export class TripSession {
  constructor(plan, states, startedAt, { ledger = null, pace = null } = {}) {
    this.plan = plan;
    this.states = states;
    this.tracker = new RouteProgressTracker(plan.route.polyline, startedAt);
    this.ledger = ledger ?? new TripLedger();
    this.pace = pace ?? new PaceModel();
    this.lastSample = null;
    this.hasStartedDriving = this.ledger.totalMeters > 0;
    this.offRouteSince = null;
    this.recordedUpTo = 0;
    this.rerouteDelay = 8;
  }

  ingest(sample) {
    const previous = this.tracker.match;
    const current = this.tracker.ingest(sample);
    if (previous.status === 'onRoute' && current.status === 'onRoute'
      && current.distanceAlongRoute > Math.max(previous.distanceAlongRoute, this.recordedUpTo)) {
      // Credit only distance beyond the furthest point already credited.
      const from = Math.max(previous.distanceAlongRoute, this.recordedUpTo);
      this.ledger.recordRouteProgress(from, current.distanceAlongRoute, this.plan.states, previous.t, current.t);
      this.recordedUpTo = current.distanceAlongRoute;
      const dt = current.t - previous.t;
      const moved = current.distanceAlongRoute - previous.distanceAlongRoute;
      if (dt > 0 && moved / dt > 2) {
        this.pace.observe(this.plan.route.timeProfile.secondsBetween(previous.distanceAlongRoute, current.distanceAlongRoute), dt);
      }
    } else if (this.hasStartedDriving && current.status !== 'onRoute' && this.lastSample
      && sample.accuracy >= 0 && sample.accuracy <= 100 && sample.t - this.lastSample.t < 120) {
      const meters = geoDistance(this.lastSample.coordinate, sample.coordinate);
      this.ledger.recordOffRoute(meters, this.states.regionContaining(sample.coordinate), sample.t);
    }
    if (current.status === 'onRoute') this.hasStartedDriving = true;
    if (current.status === 'offRoute') {
      if (this.offRouteSince === null) this.offRouteSince = sample.t;
    } else {
      this.offRouteSince = null;
    }
    if (sample.accuracy >= 0) this.lastSample = sample;
    return this.plan.snapshot(current, this.ledger, this.pace, sample.t);
  }

  snapshotAt(t) {
    return this.plan.snapshot(this.tracker.estimate(t), this.ledger, this.pace, t);
  }

  needsReroute(t) {
    return this.offRouteSince !== null && t - this.offRouteSince >= this.rerouteDelay;
  }

  replacePlan(plan, t) {
    this.plan = plan;
    this.tracker = new RouteProgressTracker(plan.route.polyline, t);
    this.offRouteSince = null;
    this.recordedUpTo = 0;
  }
}
