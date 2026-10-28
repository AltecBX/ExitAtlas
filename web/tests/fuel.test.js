// Fuel stop planner on the real Miami to Manhattan route, checked by brute force over the same data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START, near } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { TripLedger, PaceModel } from '../js/engine/tracking.js';
import { servicesForExit } from '../js/engine/exits.js';
import { planFuelStop, rangeLeft, fullTankRange } from '../js/engine/fuel.js';

const ds = () => ({ states: data.states, timeZones: data.timeZones, interstates: data.interstates });
let miamiPlan = null;
const miami = () => (miamiPlan ??= new TripPlan(route('miami_to_manhattan'), ds()));
const servicesFor = (e) => servicesForExit(data.interstates, e);
const snap = (plan, miles) => plan.snapshot(
  { status: 'onRoute', distanceAlongRoute: miles * MILE, offset: 0, isEstimated: false, t: START, speed: 30 },
  new TripLedger(), new PaceModel(), START);

/// Every exit with a gas station, with range left on arrival, computed independently of the planner.
function gasExits(plan, fromMeters, range) {
  const out = [];
  for (const e of plan.exits) {
    const ahead = e.distanceAlongRoute - fromMeters;
    if (ahead <= 0) continue;
    const gas = servicesFor(e).filter((s) => s.place.category === 1);
    if (!gas.length) continue;
    const arrive = range - ahead - Math.min(...gas.map((s) => s.detourMeters)) / 2;
    if (arrive >= 0) out.push({ id: e.id, ahead, arrive });
  }
  return out;
}

test('range counts down with miles driven', () => {
  const fuel = { rangeMeters: 300 * MILE, drivenAtEntry: 10 * MILE };
  near(rangeLeft(fuel, 10 * MILE), 300 * MILE, 1e-6);
  near(rangeLeft(fuel, 60 * MILE), 250 * MILE, 1e-6);
  assert.equal(rangeLeft(fuel, 400 * MILE), 0);
  assert.equal(rangeLeft(null, 0), null);
  near(fullTankRange({ tankGallons: 17, mpg: 34 }), 578 * MILE, 1e-6);
  assert.equal(fullTankRange({ tankGallons: null, mpg: 34 }), null);
});

test('recommends the last gas exit reached with at least the buffer left', () => {
  const plan = miami();
  const s = snap(plan, 100);
  const range = 300 * MILE;
  const r = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor });
  assert.equal(r.status, 'planned');
  const truth = gasExits(plan, s.progress, range);
  const keeps = truth.filter((x) => x.arrive >= 50 * MILE);
  assert.ok(keeps.length > 5);
  const expected = keeps[keeps.length - 1];
  assert.equal(r.recommended.exit.id, expected.id);
  near(r.recommended.rangeOnArrival, expected.arrive, 1e-6);
  assert.ok(r.recommended.rangeOnArrival >= 50 * MILE);
  // The next gas exit after it would arrive with less than the buffer.
  const after = truth.find((x) => x.ahead > expected.ahead);
  if (after) assert.ok(after.arrive < 50 * MILE);
  // Earlier alternatives come before it, nearest first.
  assert.equal(r.earlier.length, 2);
  assert.ok(r.earlier[0].ahead < r.recommended.ahead && r.earlier[1].ahead < r.earlier[0].ahead);
  // The stop lands roughly 250 miles ahead (300 range minus 50 buffer), within one gas gap.
  assert.ok(r.recommended.ahead > 200 * MILE && r.recommended.ahead <= 250 * MILE);
  assert.ok(r.recommended.eta > START);
});

test('reaches the destination with the buffer: no stop needed', () => {
  const plan = new TripPlan(route('atlanta_to_nashville'), ds());
  const r = planFuelStop(plan, snap(plan, 0), 400 * MILE, { bufferMeters: 50 * MILE, servicesFor });
  assert.equal(r.status, 'destination');
  near(r.destinationSpare / MILE, 400 - plan.route.length / MILE, 0.01);
  // Without a destination (discovery mode) it plans a stop instead.
  const d = planFuelStop(plan, snap(plan, 0), 400 * MILE, { bufferMeters: 50 * MILE, servicesFor, hasDestination: false });
  assert.notEqual(d.status, 'destination');
});

test('below the buffer: nearest gas first; no range: none', () => {
  const plan = miami();
  const s = snap(plan, 450); // I-95 in Georgia (mile 100 is on Florida's Turnpike, which has no exit data)
  const low = planFuelStop(plan, s, 30 * MILE, { bufferMeters: 50 * MILE, servicesFor });
  assert.equal(low.status, 'low');
  const truth = gasExits(plan, s.progress, 30 * MILE);
  assert.equal(low.recommended.exit.id, truth[0].id);
  assert.equal(planFuelStop(plan, s, 0, { bufferMeters: 50 * MILE, servicesFor }).status, 'none');
});

test('a preferred brand within 60 miles before the latest stop wins', () => {
  const plan = miami();
  const s = snap(plan, 100);
  const range = 300 * MILE;
  const base = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor });
  // Pick a brand present at an earlier qualifying exit but not at the latest one.
  const latestNames = new Set(base.recommended.gas.map((g) => (g.place.brand || g.place.name).toLowerCase()));
  const candidate = base.stations.filter((x) => x.rangeOnArrival >= 50 * MILE && base.recommended.ahead - x.ahead <= 60 * MILE && x !== base.recommended)
    .flatMap((x) => x.gas.map((g) => (g.place.brand || g.place.name).toLowerCase()))
    .find((n) => n && !latestNames.has(n));
  if (!candidate) return; // nothing to distinguish on this stretch
  const r = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor, preferredBrands: [candidate] });
  assert.ok(r.recommended.preferred);
  assert.ok(r.recommended.ahead < base.recommended.ahead);
  assert.ok(base.recommended.ahead - r.recommended.ahead <= 60 * MILE);
});
