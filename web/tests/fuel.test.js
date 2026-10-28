// Fuel stop planner on the real Miami to Manhattan route, checked by brute force over the same data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START, near } from './support.js';
import { METERS_PER_MILE as MILE, offset } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { TripLedger, PaceModel } from '../js/engine/tracking.js';
import { servicesForExit } from '../js/engine/exits.js';
import { planFuelStop, planStop, rangeLeft, fullTankRange, matchesFavorite, projectChargers, chargerCandidates } from '../js/engine/fuel.js';

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
  near(fullTankRange({ ev: true, rangeMiles: 310 }), 310 * MILE, 1e-6);
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

test('a favorite brand wins anywhere in range while keeping the buffer', () => {
  const plan = miami();
  const s = snap(plan, 100);
  const range = 300 * MILE;
  const base = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor });
  const name = (g) => (g.place.brand || g.place.name).toLowerCase();
  const latestNames = new Set(base.recommended.gas.map(name));
  const keeps = base.stations.filter((x) => x.rangeOnArrival >= 50 * MILE && x !== base.recommended);
  const candidate = keeps.flatMap((x) => x.gas.map(name)).find((n) => n && !latestNames.has(n));
  assert.ok(candidate, 'a brand only at earlier exits');
  const r = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor, favorites: [candidate] });
  assert.ok(r.recommended.favorite);
  assert.ok(r.recommended.rangeOnArrival >= 50 * MILE);
  // It is the latest exit with that brand that keeps the buffer.
  const withBrand = keeps.filter((x) => x.gas.some((g) => name(g) === candidate));
  assert.equal(r.recommended.exit.id, withBrand[withBrand.length - 1].exit.id);
  assert.equal(r.closestToTarget.exit.id, base.recommended.exit.id);
  // A favorite that is nowhere ahead falls back to the normal stop and says so.
  const none = planFuelStop(plan, s, range, { bufferMeters: 50 * MILE, servicesFor, favorites: ['No Such Brand'] });
  assert.ok(none.favoriteMissing);
  assert.equal(none.recommended.exit.id, base.recommended.exit.id);
});

test('favorite brand matching ignores case and punctuation', () => {
  assert.ok(matchesFavorite("Casey's General Store", ['caseys']));
  assert.ok(matchesFavorite('Costco Gasoline', ['Costco']));
  assert.ok(matchesFavorite('Shell', ['shell']));
  assert.ok(!matchesFavorite('Shell', ['Exxon']));
  assert.ok(!matchesFavorite('', ['Shell']));
});

test('charging stops: chargers near the route are placed on it and planned like gas', () => {
  const plan = miami();
  const poly = plan.route.polyline;
  const at = (mi, east) => { const c = poly.coordinateAt(mi * MILE); return offset(c, 90, east); };
  const stations = [
    { id: 1, name: 'A', ...ll(at(150, 400)) }, { id: 2, name: 'B', ...ll(at(260, 900)) },
    { id: 3, name: 'C', ...ll(at(330, 300)) }, { id: 4, name: 'Far', ...ll(at(200, 9000)) },
  ];
  const projected = projectChargers(poly, stations);
  assert.deepEqual(projected.map((c) => c.name), ['A', 'B', 'C']);
  near(projected[1].along / MILE, 260, 0.6);
  near(projected[1].offset, 900, 60);
  const s = snap(plan, 100);
  // With 265 mi of range, C (mile 330) arrives with about 34.8 mi, above the 30 mi buffer.
  const r = planStop(plan, s, 265 * MILE, chargerCandidates(projected, s.progress, 265 * MILE), { bufferMeters: 30 * MILE });
  assert.equal(r.status, 'planned');
  assert.equal(r.recommended.charger.name, 'C');
  near(r.recommended.rangeOnArrival / MILE, 265 - 230 - 1.3 * 300 / MILE, 0.7);
  // With 260 mi, C would arrive with 29.8 mi, below the buffer, so B is the stop and C the last chance.
  const b = planStop(plan, s, 260 * MILE, chargerCandidates(projected, s.progress, 260 * MILE), { bufferMeters: 30 * MILE });
  assert.equal(b.recommended.charger.name, 'B');
  assert.equal(b.lastChance.charger.name, 'C');
  const tight = planStop(plan, s, 200 * MILE, chargerCandidates(projected, s.progress, 200 * MILE), { bufferMeters: 30 * MILE });
  assert.equal(tight.recommended.charger.name, 'B');
});

function ll(c) { return { lat: c.lat, lon: c.lon }; }
