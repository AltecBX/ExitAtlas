// Long drive regressions found by simulating a Yonkers to Orlando trip (I-95, 1,091 miles) with drift, stops,
// parked phones and GPS gaps. Each test drives a real route fixture (OSRM, OpenStreetMap) with simulated fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route, START, near } from './support.js';
import { offset } from '../js/engine/geo.js';
import { RouteProgressTracker, TrackerConfig } from '../js/engine/tracking.js';
import { GPSSimulator } from '../js/engine/discovery.js';

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
