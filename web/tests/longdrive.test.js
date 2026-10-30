// Long drive regressions found by simulating a Yonkers to Orlando trip (I-95, 1,091 miles) with drift, stops,
// parked phones and GPS gaps. Each test drives a real route fixture (OSRM, OpenStreetMap) with simulated fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START, near } from './support.js';
import { offset, normalizedDegrees } from '../js/engine/geo.js';
import { RouteProgressTracker, TrackerConfig } from '../js/engine/tracking.js';
import { TripPlan, TripSession } from '../js/engine/trip.js';
import { GPSSimulator } from '../js/engine/discovery.js';
import { PlannedRoute, TravelTimeProfile, highwayLabel, parseHighways } from '../js/engine/route.js';
import { nextManeuver } from '../js/engine/guidance.js';
import { RoutePolyline } from '../js/engine/geo.js';

const DS = { states: data.states, timeZones: null, interstates: null };

/// A fix at a distance along the route, moved `side` meters to the right of travel.
function fixAt(r, d, t, { side = 0, accuracy = 8, speed = 28, course = 'route' } = {}) {
  const bearing = r.polyline.bearingAt(d);
  const c = r.polyline.coordinateAt(d);
  return {
    coordinate: side ? offset(c, bearing + 90, side) : c, accuracy,
    course: course === 'route' ? bearing : course, speed, t,
  };
}

/// Deterministic GPS wander: about `sigma` meters per axis.
function wander(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u = s / 2147483648;
    s = (s * 1103515245 + 12345) % 2147483648;
    const v = s / 2147483648;
    return Math.sqrt(-2 * Math.log(Math.max(u, 1e-9))) * Math.cos(2 * Math.PI * v);
  };
}

// MARK: Off route detection under GPS drift

test('tracking: 80 m of GPS drift beside the route for 50 s is not taken for leaving it', () => {
  const r = route('atlanta_to_nashville');
  const trace = new GPSSimulator(r, { noise: 5, reportedAccuracy: 8 }).trace(45000, 62000, START);
  const tracker = new RouteProgressTracker(r.polyline, START);
  let estimated = 0, lastInDrift = null;
  for (const { sample, truth } of trace) {
    const drifting = truth >= 50000 && truth <= 51100; // about 47 s at 23.6 m/s
    const s = drifting
      ? { ...sample, coordinate: offset(sample.coordinate, r.polyline.bearingAt(truth) + 90, 80), accuracy: 10 }
      : sample;
    const m = tracker.ingest(s);
    assert.notEqual(m.status, 'offRoute', `false off route at ${truth.toFixed(0)} m`);
    if (drifting) {
      if (m.isEstimated) estimated += 1;
      lastInDrift = { m, truth };
    } else if (truth > 51300) {
      near(m.distanceAlongRoute, truth, 40, 'after the drift');
    }
  }
  // Progress keeps moving through the drift, and says it is an estimate.
  assert.ok(estimated > 30, `estimated fixes: ${estimated}`);
  near(lastInDrift.m.distanceAlongRoute, lastInDrift.truth, 60, 'end of the drift');
});

test('tracking: stop and go traffic with 75 m of wandering drift never flips to off route', () => {
  const r = route('atlanta_to_nashville');
  const tracker = new RouteProgressTracker(r.polyline, START);
  for (const { sample } of new GPSSimulator(r).trace(78000, 80000, START)) tracker.ingest(sample);
  const g = wander(7);
  let n = 0, e = 0, d = 80000, t = START + 100;
  const statuses = new Set();
  for (let k = 0; k < 600; k++, t += 1) {
    d += 1.2;
    n += g() * 4; e += g() * 4;
    const m = Math.hypot(n, e);
    if (m > 75) { n *= 75 / m; e *= 75 / m; }
    const c = offset(offset(r.polyline.coordinateAt(d), 0, n), 90, e);
    statuses.add(tracker.ingest({ coordinate: c, accuracy: 25, course: null, speed: 1.2, t }).status);
  }
  assert.deepEqual([...statuses], ['onRoute']);
});

test('tracking: leaving on a road beside the route is still flagged, after the drift tolerance', () => {
  const r = route('atlanta_to_nashville');
  const tracker = new RouteProgressTracker(r.polyline, START);
  let t = START, d = 45000;
  for (; d < 50000; d += 28, t += 1) tracker.ingest(fixAt(r, d, t));
  const left = t;
  let offAt = null;
  for (let k = 0; k < 120 && offAt === null; k++, d += 28, t += 1) {
    const m = tracker.ingest(fixAt(r, d, t, { side: Math.min(110, 11 * (k + 1)) }));
    if (m.status === 'offRoute') offAt = t;
  }
  assert.ok(offAt !== null, 'never flagged off route');
  assert.ok(offAt - left <= TrackerConfig.driftTolerance + 10, `flagged after ${offAt - left} s`);
});

// MARK: Pace across GPS gaps

test('pace: a stop hidden in a GPS gap (phone locked at a plaza) is not learned as slow driving', () => {
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, DS), data.states, START);
  const trace = new GPSSimulator(r).trace(0, 60000, START);
  let before = null;
  for (const { sample } of trace) before = session.ingest(sample);
  const last = trace[trace.length - 1].sample;
  // Six minutes parked beside the road with no fixes, then a minute of driving.
  const after = session.ingest(fixAt(r, 61800, last.t + 420, { speed: 30 }));
  assert.equal(after.match.status, 'onRoute');
  assert.ok(session.pace.recentFactor < 1.2, `recent pace ${session.pace.recentFactor}`);
  assert.ok(after.timeRemaining < before.timeRemaining, `time remaining ${before.timeRemaining} then ${after.timeRemaining}`);

  // A gap that is plain driving (two minutes in a tunnel at the usual speed) still counts.
  const observed = session.pace.observedSeconds;
  const speed = r.timeProfile.speedAt(70000);
  session.ingest(fixAt(r, 62000, last.t + 440, { speed: 30 }));
  session.ingest(fixAt(r, 62000 + speed * 120, last.t + 560, { speed }));
  assert.ok(session.pace.observedSeconds - observed >= 120, 'tunnel gap not learned');
});

// MARK: Driven miles off the route

function departAndPark(r, session, fromT, { minutes, speedReported }) {
  // Exit at 30 km: 20 s on a ramp to 250 m off the route, then parked with GPS wander.
  let t = fromT;
  for (let k = 1; k <= 20; k++, t += 1) {
    session.ingest(fixAt(r, 30000 + 8 * k, t, { side: 12.5 * k, speed: 13, course: normalizedDegrees(r.polyline.bearingAt(30000) + 60) }));
  }
  const g = wander(3);
  const spot = offset(r.polyline.coordinateAt(30160), r.polyline.bearingAt(30160) + 90, 250);
  for (let k = 0; k < minutes * 60; k++, t += 1) {
    const c = offset(offset(spot, 0, g() * 6), 90, g() * 6);
    session.ingest({ coordinate: c, accuracy: 8, course: null, speed: speedReported, t });
  }
  return t;
}

for (const speedReported of [0, null]) {
  test(`ledger: a phone parked off the route for 40 minutes adds no miles (speed ${speedReported === null ? 'not reported' : '0'})`, () => {
    const r = route('atlanta_to_nashville');
    const session = new TripSession(new TripPlan(r, DS), data.states, START);
    const trace = new GPSSimulator(r).trace(0, 30000, START);
    for (const { sample } of trace) session.ingest(sample);
    const driven = session.ledger.totalMeters;
    departAndPark(r, session, trace[trace.length - 1].sample.t + 1, { minutes: 40, speedReported });
    assert.equal(session.tracker.match.status, 'offRoute');
    // The ramp is about 300 m; GPS wander used to add about 25 km here.
    const extra = session.ledger.totalMeters - driven;
    assert.ok(extra > 150 && extra < 600, `off route meters ${extra.toFixed(0)}`);
  });
}

test('ledger: miles driven while the screen was locked after leaving the route count once back on it', () => {
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, DS), data.states, START);
  const trace = new GPSSimulator(r).trace(0, 30000, START);
  for (const { sample } of trace) session.ingest(sample);
  const t = departAndPark(r, session, trace[trace.length - 1].sample.t + 1, { minutes: 1, speedReported: 0 });
  // 15 minutes without fixes: the rest of the stop, then back on the highway; first fix 20 km on.
  let snap = null;
  for (let k = 0; k < 5; k++) snap = session.ingest(fixAt(r, 50000 + 28 * k, t + 900 + k));
  assert.equal(snap.match.status, 'onRoute');
  near(session.ledger.totalMeters, 50112, 800, 'driven');
});

test('ledger: the same after a reroute from the exit, and never for a resumed trip', () => {
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, DS), data.states, START);
  const trace = new GPSSimulator(r).trace(0, 30000, START);
  for (const { sample } of trace) session.ingest(sample);
  const t = departAndPark(r, session, trace[trace.length - 1].sample.t + 1, { minutes: 1, speedReported: 0 });
  // The reroute's route starts at the parked car and joins the original route 400 m on.
  const spot = session.lastSample.coordinate;
  const rest = r.polyline.slice(30400, r.polyline.length);
  const polyline = new RoutePolyline([spot, ...rest.points]);
  const rerouted = new PlannedRoute({
    source: 'osrm', polyline, timeProfile: TravelTimeProfile.uniform(polyline.length, polyline.length / 28),
    origin: { name: 'Here', coordinate: spot }, destination: r.destination,
  });
  session.replacePlan(new TripPlan(rerouted, DS), t);
  const shift = 30400 - (polyline.length - rest.length);
  for (let k = 0; k < 5; k++) session.ingest(fixAt(r, 50000 + 28 * k, t + 900 + k));
  assert.equal(session.tracker.match.status, 'onRoute');
  near(session.tracker.match.distanceAlongRoute, 50112 - shift, 60, 'on the new route');
  near(session.ledger.totalMeters, 50112, 800, 'driven');

  // A trip resumed after a reload starts a fresh session on the saved route: its first fix far along the
  // route must not be credited from the start of the route.
  const resumed = new TripSession(new TripPlan(r, DS), data.states, START, { ledger: session.ledger });
  const total = resumed.ledger.totalMeters;
  for (let k = 0; k < 5; k++) resumed.ingest(fixAt(r, 120000 + 28 * k, t + 5000 + k));
  assert.ok(resumed.ledger.totalMeters - total < 200, 'resume credited the route before the first fix');
});

// MARK: Road and direction out of Yonkers (real routes: yonkers_to_orlando, yonkers_to_morristown fixtures)

test('road direction: US 9 and NY 9A south out of Yonkers, not west because the route turns west later', () => {
  const MI = 1609.344;
  const label = (r, mi) => {
    const hw = r.highwayAt(mi * MI);
    return `${highwayLabel(hw.ref)} ${hw.direction}`;
  };
  for (const name of ['yonkers_to_orlando', 'yonkers_to_morristown']) {
    const r = route(name);
    assert.equal(label(r, 0.5), 'US-9 S', name);
    assert.equal(label(r, 1.5), 'US-9 S', name);
    assert.equal(label(r, 4), 'NY-9A S', name);
    assert.equal(nextManeuver(r, 1.5 * MI).text, 'Take the ramp onto NY-9A S', name);
  }
  const r = route('yonkers_to_orlando');
  assert.equal(label(r, 8.5), 'I-95 S');
  assert.equal(label(r, 220), 'MD-295 S', 'Baltimore-Washington Parkway');
  // OSRM names the turnpike "NJTP New Jersey Turnpike": shown as one road.
  assert.equal(highwayLabel(r.highwayAt(100 * MI).ref), 'New Jersey Turnpike');
  assert.deepEqual(parseHighways('NJTP New Jersey Turnpike'), [{ kind: 'named', prefix: '', number: 'New Jersey Turnpike' }]);
});
