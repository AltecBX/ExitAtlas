// Trip plan, dashboard snapshot and live session. Port of Trip/*.swift.
import { METERS_PER_MILE, distance as geoDistance } from './geo.js';
import { RegionSegmenter } from './datasets.js';
import { ExitMatcher, optionsForSource } from './exits.js';
import { matchRestAreas } from './restareas.js';
import { matchDiscover } from './discover.js';
import { RouteProgressTracker, TripLedger, PaceModel } from './tracking.js';
import { readingProblem, trafficSecondsTo, etaBasis } from './traffic.js';

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

/// Everything derived from one route: ordered state segments, time zones, exits and rest areas.
/// datasets: {states: RegionIndex, timeZones: TimeZoneResolver|null, interstates: InterstateDataset|null,
///            restAreas: RestAreaDataset|null, discover: DiscoverDataset|null}
export class TripPlan {
  constructor(route, datasets, { segmenter = new RegionSegmenter(), matcher = null } = {}) {
    this.route = route;
    this.states = segmenter.segment(route.polyline, datasets.states);
    this.exits = datasets.interstates
      ? (matcher ?? new ExitMatcher(optionsForSource(route.source))).match(route.polyline, datasets.interstates)
      : [];
    this.exitDistances = this.exits.map((e) => e.distanceAlongRoute);
    this.restAreas = datasets.restAreas
      ? matchRestAreas(route.polyline, datasets.restAreas, { highwayAt: (d) => route.stepAt(d)?.highways ?? null })
      : [];
    this.restAreaDistances = this.restAreas.map((r) => r.distanceAlongRoute);
    this.discover = datasets.discover ? matchDiscover(route.polyline, datasets.discover, this.exits) : [];
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

  /// Rest areas strictly after `start` up to `end`, in route order.
  restAreasBetween(start, end) {
    const lo = upperBound(this.restAreaDistances, start), hi = upperBound(this.restAreaDistances, end);
    return lo < hi ? this.restAreas.slice(lo, hi) : [];
  }

  nextRestArea(distance) {
    const i = upperBound(this.restAreaDistances, distance);
    return i < this.restAreas.length ? this.restAreas[i] : null;
  }

  timeZoneIDAt(distance) {
    if (!this.timeZones) return null;
    const code = this.states.segmentAt(distance)?.code ?? null;
    return this.timeZones.identifier(this.route.polyline.coordinateAt(distance), code);
  }

  timeZoneIDAtSegmentStart(index) {
    return index < this.timeZoneIDs.length ? this.timeZoneIDs[index] : null;
  }

  /// Dashboard snapshot for the current match. Times are epoch seconds. `traffic` is the traffic reading
  /// shown (engine/traffic.js, after stabilizeReading): used where it covers the road, if it is usable now.
  snapshot(match, ledger, pace, now, { exitLookahead = 100 * METERS_PER_MILE, maxUpcomingExits = 200, traffic = null } = {}) {
    const route = this.route;
    const d = Math.min(Math.max(match.distanceAlongRoute, 0), route.length);
    const reading = traffic && readingProblem(traffic, { routeId: route.id, progress: d, now }) === null ? traffic : null;
    const timing = { modelSeconds: (a, b) => route.timeProfile.secondsBetween(a, b), paceSeconds: (m) => pace.secondsFor(m) };
    const paceKnown = pace.recentSpeed !== null || Math.abs(pace.factor - 1) > 0.02;
    const basisTo = (target) => etaBasis(reading, reading !== null, target, paceKnown);
    const eta = (target) => {
      let seconds = reading ? trafficSecondsTo(reading, d, target, timing) : timing.paceSeconds(timing.modelSeconds(d, target));
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
    const toRest = (r) => ({ restArea: r, distance: r.distanceAlongRoute - d, eta: eta(r.distanceAlongRoute) });
    const nr = this.nextRestArea(d);
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
      paceFactor: pace.factor, paceRecent: pace.recentFactor, recentSpeed: pace.recentSpeed, etaTo: eta,
      traffic: reading, basisTo, arrivalBasis: basisTo(route.length),
      highway: route.highwayAt(d), current, next, itinerary,
      nextExit: ne ? toUpcoming(ne) : null, upcomingExits,
      nextRestArea: nr ? toRest(nr) : null, upcomingRestAreas: this.restAreasBetween(d, d + exitLookahead).map(toRest),
      borderCrossingsRemaining: ahead.length, statesAhead,
      nextStop: stop ? { stop, distance: stop.distanceAlongRoute - d, eta: eta(stop.distanceAlongRoute) } : null,
      drivenStints: ledger.stints,
      distanceToNextBorder: current && next ? current.remainingMeters : null,
    };
  }
}

/// Fixes further apart than this (screen locked, tunnel) teach the pace model only when the time fits
/// driving all the way, no slower than the slowest pace it predicts: a stop hidden in the gap is not slow driving.
const PACE_GAP_SECONDS = 30;
const SLOWEST_PACE = 2.5;
/// Off the route, a parked phone's fixes wander several meters every second. Movement counts only beyond this
/// (or twice the reported accuracy), and not while the reported speed says stopped.
const OFF_ROUTE_WANDER = 40;
const STOPPED_SPEED = 1;
/// Back on the route after a long gap: the route between counts as driven when it fits this speed (m/s).
const GAP_MAX_SPEED = 45;

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
    /// The last fix counted as driven while off the route (null on the route).
    this.offRouteAnchor = null;
    /// True from a reroute (whose route starts where the driver was) until the first fix on it.
    this.startsAtDriver = false;
    /// The traffic reading shown (engine/traffic.js, after stabilizeReading), used while it is usable.
    this.traffic = null;
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
      const modeled = this.plan.route.timeProfile.secondsBetween(previous.distanceAlongRoute, current.distanceAlongRoute);
      if (dt > 0 && moved / dt > 2 && (dt <= PACE_GAP_SECONDS || dt <= SLOWEST_PACE * modeled)) {
        this.pace.observe(modeled, dt, moved);
      }
    } else if ((previous.status === 'offRoute' || (previous.status === 'acquiring' && this.startsAtDriver))
      && current.status === 'onRoute' && this.lastSample
      && sample.t - this.lastSample.t >= 120 && current.distanceAlongRoute > this.recordedUpTo
      && (current.distanceAlongRoute - this.recordedUpTo) / (sample.t - this.lastSample.t) <= GAP_MAX_SPEED) {
      // Back on the route after a gap that hid the way back (screen locked at a stop): the route between counts.
      this.ledger.recordRouteProgress(this.recordedUpTo, current.distanceAlongRoute, this.plan.states, this.lastSample.t, current.t);
      this.recordedUpTo = current.distanceAlongRoute;
    } else if (this.hasStartedDriving && current.status !== 'onRoute' && this.lastSample
      && sample.accuracy >= 0 && sample.accuracy <= 100) {
      if (sample.t - this.lastSample.t >= 120) {
        this.offRouteAnchor = sample; // the way between is unknown
      } else if (!(sample.speed != null && sample.speed < STOPPED_SPEED)) {
        const anchor = (this.offRouteAnchor ??= this.lastSample);
        const meters = geoDistance(anchor.coordinate, sample.coordinate);
        if (meters > Math.max(OFF_ROUTE_WANDER, 2 * sample.accuracy)) {
          this.ledger.recordOffRoute(meters, this.states.regionContaining(sample.coordinate), sample.t);
          this.offRouteAnchor = sample;
        }
      }
    }
    if (current.status === 'onRoute') {
      this.hasStartedDriving = true;
      this.startsAtDriver = false;
      this.offRouteAnchor = null;
    }
    if (current.status === 'offRoute') {
      if (this.offRouteSince === null) this.offRouteSince = sample.t;
    } else {
      this.offRouteSince = null;
    }
    if (sample.accuracy >= 0) this.lastSample = sample;
    return this.plan.snapshot(current, this.ledger, this.pace, sample.t, { traffic: this.traffic });
  }

  snapshotAt(t) {
    return this.plan.snapshot(this.tracker.estimate(t), this.ledger, this.pace, t, { traffic: this.traffic });
  }

  needsReroute(t) {
    return this.offRouteSince !== null && t - this.offRouteSince >= this.rerouteDelay;
  }

  replacePlan(plan, t) {
    this.plan = plan;
    this.tracker = new RouteProgressTracker(plan.route.polyline, t);
    this.offRouteSince = null;
    this.recordedUpTo = 0;
    this.offRouteAnchor = null;
    this.startsAtDriver = true;
  }
}
