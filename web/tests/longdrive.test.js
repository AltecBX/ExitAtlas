// Long drive regressions found by simulating a Yonkers to Orlando trip (I-95, 1,091 miles) with drift, stops,
// parked phones and GPS gaps. Each test drives a real route fixture (OSRM, OpenStreetMap) with simulated fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START, near, loadOSRM, osrmAnswerFrom } from './support.js';
import { offset, normalizedDegrees } from '../js/engine/geo.js';
import { RouteProgressTracker, TrackerConfig } from '../js/engine/tracking.js';
import { TripPlan, TripSession } from '../js/engine/trip.js';
import { GPSSimulator } from '../js/engine/discovery.js';
import { PlannedRoute, TravelTimeProfile, highwayLabel, parseHighways, makeStep } from '../js/engine/route.js';
import { nextManeuver } from '../js/engine/guidance.js';
import { RoutePolyline } from '../js/engine/geo.js';
import { osrmRouteQuery, routeFromOSRM } from '../js/engine/osrm.js';
import { ReroutePacer, REROUTE_PACING, STAY_ON_ROAD, chooseReroute, startingRoad, metersOnRoad } from '../js/app/reroute.js';

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

// MARK: Reroutes the driver does not take

test('tracking: a route never joined is off route after a minute of driving away from it, never while parked', () => {
  // Found on a simulated drive: after a reroute the driver ignored, "Acquiring" lasted the whole hour and no
  // reroute followed.
  const r = route('atlanta_to_nashville');
  const parked = new RouteProgressTracker(r.polyline, START);
  for (let k = 0; k < 600; k++) {
    const m = parked.ingest(fixAt(r, 30000, START + k, { side: 300, speed: 0, course: null }));
    assert.equal(m.status, 'acquiring', 'parked away from the route');
  }
  const driving = new RouteProgressTracker(r.polyline, START);
  let offAt = null;
  for (let k = 0; k < 120 && offAt === null; k++) {
    if (driving.ingest(fixAt(r, 30000 + 25 * k, START + k, { side: 500, speed: 25 })).status === 'offRoute') offAt = k;
  }
  assert.ok(offAt !== null && offAt >= TrackerConfig.acquireTimeout && offAt <= TrackerConfig.acquireTimeout + 5, `off route after ${offAt} s`);
});

test('session: a reroute the driver never reaches asks for another one', () => {
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, DS), data.states, START);
  for (const { sample } of new GPSSimulator(r).trace(0, 30000, START)) session.ingest(sample);
  // The new route starts 300 m from the driver, on another road, and the driver keeps going 500 m off it.
  const rest = r.polyline.slice(30400, r.polyline.length);
  const start = offset(r.polyline.coordinateAt(30000), r.polyline.bearingAt(30000) - 90, 300);
  const polyline = new RoutePolyline([start, ...rest.points]);
  const rerouted = new PlannedRoute({
    source: 'osrm', polyline, timeProfile: TravelTimeProfile.uniform(polyline.length, polyline.length / 28),
    origin: { name: 'Here', coordinate: start }, destination: r.destination,
  });
  const t0 = session.lastSample.t + 1;
  session.replacePlan(new TripPlan(rerouted, DS), t0);
  let askedAt = null;
  for (let k = 0; k < 200 && askedAt === null; k++) {
    session.ingest(fixAt(r, 30100 + 25 * k, t0 + k, { side: 2000, speed: 25 }));
    if (session.needsReroute(t0 + k)) askedAt = k;
  }
  assert.ok(askedAt !== null && askedAt <= 80, `reroute asked after ${askedAt} s`);
});

test('reroute pacing: at least 2 minutes apart, backing off while new routes are ignored, at most 8 an hour', () => {
  const pacer = new ReroutePacer();
  const sent = [];
  // Off route for an hour and asking every second.
  for (let t = 0; t < 3600; t++) if (pacer.allow(t)) { pacer.started(t); sent.push(t); }
  assert.deepEqual(sent.slice(0, 5), [0, 120, 360, 840, 1440]);
  assert.ok(sent.length <= 8, `${sent.length} requests in an hour`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= REROUTE_PACING.spacing);
  // A mile driven on the new route resets the back off; the 2 minute spacing stays.
  pacer.observe({ match: { status: 'onRoute' }, progress: 1700 });
  const last = sent[sent.length - 1];
  assert.equal(pacer.allow(last + 119), false);
  assert.equal(pacer.allow(last + 120), true);
  pacer.started(last + 120);
  assert.equal(pacer.allow(last + 240), true, 'back to 2 minutes after a followed route');
  pacer.reset();
  assert.equal(pacer.allow(0), true, 'a new trip starts with no wait');
});

test('reroute request: the course goes to OSRM as the first coordinate\'s bearing, nothing else changes', () => {
  const w = (lat, lon) => ({ name: 'x', coordinate: { lat, lon } });
  const three = [w(40.9, -73.9), w(39.7, -75.5), w(28.5, -81.4)];
  const plain = osrmRouteQuery(three, { alternatives: false });
  assert.equal(plain, '-73.900000,40.900000;-75.500000,39.700000;-81.400000,28.500000?overview=full&geometries=polyline6&steps=true&annotations=duration&alternatives=false');
  assert.equal(osrmRouteQuery(three, { alternatives: false, bearing: 196.6 }), `${plain}&bearings=197,45;;`);
  assert.equal(osrmRouteQuery(three.slice(0, 2), { alternatives: false, bearing: 359.7 }).split('&bearings=')[1], '0,45;');
  assert.ok(!osrmRouteQuery(three, { bearing: null }).includes('bearings'));
  assert.match(osrmRouteQuery(three.slice(0, 2)), /alternatives=3$/);
  // An automatic reroute while driving asks for alternatives in the same request: one request, the course kept.
  assert.equal(osrmRouteQuery(three.slice(0, 2), { alternatives: true, bearing: 313 }).split('alternatives=')[1], '3&bearings=313,45;');
});

// MARK: Reroutes that keep the driver on their highway (real OSRM answers: Fixtures/reroute, recorded on the
// Taconic State Parkway, where a driver to the Berkshires was told at each reroute to get off at the next exit)

const MI = 1609.344;

/// The routes of a recorded OSRM answer, as the app builds them.
function answerRoutes(answer) {
  const waypoints = answer.waypoints.map((w) => ({ name: w.name, coordinate: { lat: w.location[1], lon: w.location[0] } }));
  return answer.routes.map((r) => routeFromOSRM(r, waypoints));
}

test('reroute choice: past the NY 82 exit on the Taconic, the route that stays on it is taken, not the one off at US 44', () => {
  const routes = answerRoutes(loadOSRM('taconic_past_ny82_to_lenox'));
  const road = startingRoad(routes[0]);
  assert.deepEqual([...road], ['Taconic State Parkway']);
  near(metersOnRoad(routes[0], road) / MI, 10.6, 0.1, 'fastest on the Taconic');
  near(metersOnRoad(routes[1], road) / MI, 50.8, 0.1, 'other on the Taconic');
  const extra = routes[1].timeProfile.totalSeconds - routes[0].timeProfile.totalSeconds;
  assert.ok(extra > 0 && extra < 120, `the other is ${extra.toFixed(0)} s slower`);
  assert.equal(chooseReroute(routes), routes[1]);
  assert.equal(nextManeuver(routes[0], 0).text, 'Take the exit on the right toward US-44 E');
  const next = nextManeuver(routes[1], 0);
  assert.ok(next.text === 'Turn right onto Rigor Hill Road' && next.distance > 50 * MI, `${next.text} in ${next.distance}`);
});

test('reroute choice: the fastest is kept when staying on the road is much slower, or when it stays on longest itself', () => {
  // To Canaan, CT, staying on the Taconic past the US 44 exit is much slower: no route that does is offered, and
  // the other route (10 minutes slower) leaves the Taconic sooner.
  const canaan = answerRoutes(loadOSRM('taconic_past_ny82_to_canaan'));
  assert.ok(metersOnRoad(canaan[1], startingRoad(canaan[0])) < metersOnRoad(canaan[0], startingRoad(canaan[0])));
  assert.equal(chooseReroute(canaan), canaan[0]);
  // From Briarcliff Manor the fastest stays on the Taconic 37 miles; the other leaves after 2, 18 minutes slower.
  const briarcliff = answerRoutes(loadOSRM('taconic_briarcliff_to_lenox'));
  assert.equal(chooseReroute(briarcliff), briarcliff[0]);
  // With stops there are no alternatives: the one route.
  assert.equal(chooseReroute(briarcliff.slice(1)), briarcliff[1]);
  assert.equal(chooseReroute([]), null);
});

/// A route on `road` for `miles`, then an off ramp and another road; `seconds` long.
function onRoad(seconds, miles, road = 'I 87 New York State Thruway', then = [['turn right', 'NY 32 Main Street']]) {
  const steps = [makeStep(0, miles * MI, 'depart', road)];
  let at = miles * MI;
  for (const [instruction, name, length = 400] of [['off ramp slight right', ''], ...then]) {
    steps.push(makeStep(at, length, instruction, name));
    at += length;
  }
  return { steps, timeProfile: { totalSeconds: seconds } };
}

test('reroute choice: slower by at most 10 percent or 10 minutes, whichever is larger, and a mile farther on the road', () => {
  // The recorded Taconic routes: the one that stays is taken only within the time allowed.
  const taconic = answerRoutes(loadOSRM('taconic_past_ny82_to_lenox'));
  const extra = taconic[1].timeProfile.totalSeconds - taconic[0].timeProfile.totalSeconds;
  assert.equal(chooseReroute(taconic, { ...STAY_ON_ROAD, fraction: 0, seconds: extra - 1 }), taconic[0]);
  assert.equal(chooseReroute(taconic, { ...STAY_ON_ROAD, fraction: 0, seconds: extra }), taconic[1]);
  // An hour: 10 minutes. Three hours: 18 minutes (10 percent).
  for (const [fastest, allowed] of [[3600, 600], [10800, 1080]]) {
    const off = onRoad(fastest, 2);
    assert.equal(chooseReroute([off, onRoad(fastest + allowed, 30)]).steps[0].length, 30 * MI, `${fastest} s, ${allowed} s slower`);
    assert.equal(chooseReroute([off, onRoad(fastest + allowed + 1, 30)]), off, `${fastest} s, more than ${allowed} s slower`);
  }
  // Less than a mile farther is the same exit as far as the driver is concerned: the fastest.
  const off = onRoad(3600, 2);
  assert.equal(chooseReroute([off, onRoad(3610, 2.9)]), off);
  assert.equal(chooseReroute([off, onRoad(3610, 3.1)]).steps[0].length, 3.1 * MI);
  // Of the routes that stay farther, the one that stays farthest; of two about as far, the quicker.
  const far = onRoad(3900, 30), farther = onRoad(4000, 30.5), less = onRoad(3700, 10);
  assert.equal(chooseReroute([off, less, far]), far);
  assert.equal(chooseReroute([off, farther, far]), far, 'half a mile more is not worth 100 s');
  // OSRM's order is kept as the default even when an alternative is a little quicker and stays no farther.
  assert.equal(chooseReroute([onRoad(3600, 2), onRoad(3590, 2)]).timeProfile.totalSeconds, 3600);
});

test('reroute choice: the road is the one the routes start on, by its name or number', () => {
  // A street is no highway: the fastest, however far another route stays on it.
  assert.equal(chooseReroute([onRoad(3600, 1, 'Main Street'), onRoad(3601, 20, 'Main Street')]).timeProfile.totalSeconds, 3600);
  // Another parkway is another road: the Sprain Brook Parkway ends where the Taconic State Parkway begins.
  const sprain = onRoad(3600, 3, 'Sprain Brook Parkway', [['merge slight left', 'I 287 Cross Westchester Expressway']]);
  const toTaconic = { steps: [makeStep(0, 11 * MI, 'depart', 'Sprain Brook Parkway'), makeStep(11 * MI, 90 * MI, 'new name straight', 'Taconic State Parkway')], timeProfile: { totalSeconds: 3700 } };
  assert.equal(metersOnRoad(toTaconic, startingRoad(sprain)), 11 * MI);
  // A number shared with another road (I-684 and NY 22 together) is still the road; a ramp with no name between
  // two stretches of it does not end it.
  const i684 = { steps: [makeStep(0, 5 * MI, 'depart', 'I 684 '), makeStep(5 * MI, 600, 'fork slight left', ''), makeStep(5 * MI + 600, 20 * MI, 'merge slight left', 'I 684; NY 22 '), makeStep(25 * MI + 600, 400, 'off ramp slight right', ''), makeStep(25 * MI + 1000, 9000, 'turn left', 'Main Street')], timeProfile: { totalSeconds: 3700 } };
  near(metersOnRoad(i684, startingRoad(i684)), 25 * MI + 600, 1, 'on I-684');
  assert.equal(chooseReroute([onRoad(3600, 5, 'I 684 '), i684]), i684);
});

/// Drives the Taconic past the NY 82 exit on the route from Briarcliff Manor that leaves there, then on along the
/// Taconic for `miles` past the exit, with fixes every second. A reroute is answered from the answer OSRM gave
/// just past the exit, trimmed to where the driver is, and `pick` chooses the route. Pacing as in the app.
function driveOnPastTheExit(pick, miles = 30) {
  const first = answerRoutes(loadOSRM('taconic_briarcliff_to_lenox'))[0];
  const past = loadOSRM('taconic_past_ny82_to_lenox');
  const ramp = first.steps[1].startDistance;
  // The Taconic as recorded past the exit (its first point is 600 m past the ramp, along the Taconic).
  const taconic = answerRoutes(past)[1].polyline;
  const path = new RoutePolyline([...first.polyline.slice(ramp - 3000, ramp).points, ...taconic.points]);
  const session = new TripSession(new TripPlan(first, DS), data.states, START);
  const pacer = new ReroutePacer();
  const reroutes = [];
  let off = 0;
  for (let d = 0, t = START; d < 3000 + miles * MI; d += 28, t += 1) {
    const fix = { coordinate: path.coordinateAt(d), accuracy: 8, course: path.bearingAt(d), speed: 28, t };
    const snap = session.ingest(fix);
    pacer.observe(snap);
    if (reroutes.length && snap.match.status === 'offRoute') off += 1;
    if (!session.needsReroute(t) || !pacer.allow(t)) continue;
    pacer.started(t);
    const route = pick(answerRoutes(osrmAnswerFrom(past, fix.coordinate)));
    session.replacePlan(new TripPlan(route, DS), t);
    reroutes.push({ at: d - 3000, route, next: nextManeuver(route, 0) });
  }
  return { reroutes, off, status: session.tracker.match.status };
}

test('reroute on the Taconic: past the exit of the route, one reroute keeps the driver on the Taconic past the next exits', () => {
  const { reroutes, off, status } = driveOnPastTheExit(chooseReroute);
  assert.equal(reroutes.length, 1, `reroutes at ${reroutes.map((r) => (r.at / MI).toFixed(1)).join(', ')} mi past the exit`);
  const [r] = reroutes;
  assert.ok(r.at > 0 && r.at < 1 * MI, `rerouted ${r.at.toFixed(0)} m past the exit`);
  assert.equal(r.route.steps[0].roadName, 'Taconic State Parkway');
  assert.ok(r.next.distance > 49 * MI, `next: ${r.next.text} in ${(r.next.distance / MI).toFixed(1)} mi`);
  // 30 miles on, past the US 44 exit (where the fastest route would have left) and the ones after: never off it.
  assert.equal(off, 0);
  assert.equal(status, 'onRoute');
  // Taking the fastest each time (as before) sends the driver off at the US 44 exit, and a second reroute follows.
  const before = driveOnPastTheExit((routes) => routes[0]);
  assert.equal(before.reroutes[0].next.text, 'Take the exit on the right toward US-44 E');
  assert.ok(before.reroutes.length >= 2, `${before.reroutes.length} reroutes taking the fastest`);
});
