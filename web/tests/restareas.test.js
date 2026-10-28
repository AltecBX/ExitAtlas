// Rest areas and service plazas on real routes: the driver's side only, merged duplicates, verified amenities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START } from './support.js';
import { METERS_PER_MILE as MILE, RoutePolyline, angleDifference } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { TripLedger, PaceModel } from '../js/engine/tracking.js';
import { matchRestAreas, amenityBadges, restAreaTitle, gasGaps, AMENITIES } from '../js/engine/restareas.js';

const ds = () => ({ states: data.states, timeZones: data.timeZones, interstates: data.interstates, restAreas: data.restAreas });
let miamiPlan = null;
const miami = () => (miamiPlan ??= new TripPlan(route('miami_to_manhattan'), ds()));
const named = (list, re) => list.filter((r) => re.test(r.name));

test('the dataset carries provenance and only known kinds', () => {
  const d = data.restAreas;
  assert.equal(d.metadata.license, 'ODbL-1.0');
  assert.match(d.metadata.attribution, /OpenStreetMap/);
  assert.ok(d.items.length > 1000);
  const ids = new Set(d.items.map((i) => i.id));
  assert.equal(ids.size, d.items.length);
  for (const i of d.items) {
    assert.ok(['rest', 'welcome', 'plaza', 'parking'].includes(i.kind), i.kind);
    for (const [k, v] of Object.entries(i.amenities ?? {})) {
      assert.ok(AMENITIES.some(([key]) => key === k), k);
      assert.equal(typeof v, 'boolean');
    }
  }
});

test('Miami to Manhattan lists northbound facilities in route order on the driver side', () => {
  const plan = miami();
  const ras = plan.restAreas;
  assert.ok(ras.length >= 15, `${ras.length}`);
  for (let i = 1; i < ras.length; i++) assert.ok(ras[i].distanceAlongRoute > ras[i - 1].distanceAlongRoute);
  // Georgia's visitor center on I-95 northbound at the Florida line, two OSM records merged into one row.
  const ga = named(ras, /Georgia Visitor Information Center/);
  assert.equal(ga.length, 1);
  assert.equal(ga[0].kind, 'welcome');
  assert.equal(ga[0].side, 'yours');
  // Median plazas serve both directions.
  assert.equal(named(ras, /Chesapeake House/)[0]?.side, 'both');
  // Joyce Kilmer serves northbound; Thomas Edison is the southbound plaza at Grover Cleveland's mile.
  assert.equal(named(ras, /Joyce Kilmer/).length, 1);
  assert.equal(named(ras, /Thomas Edison/).length, 0);
  for (const r of ras) {
    if (r.side !== 'yours') continue;
    const b = r.records.find((x) => x.bearing != null).bearing;
    assert.ok(angleDifference(b, plan.route.polyline.bearingAt(r.distanceAlongRoute)) <= 50, restAreaTitle(r));
  }
});

test('the same road driven the other way gets the other side', () => {
  const pts = route('richmond_to_nyc_via_pa').polyline.points;
  const north = matchRestAreas(new RoutePolyline(pts), data.restAreas);
  const south = matchRestAreas(new RoutePolyline([...pts].reverse()), data.restAreas);
  assert.equal(named(north, /Joyce Kilmer/).length, 1);
  assert.equal(named(south, /Joyce Kilmer/).length, 0);
  assert.equal(named(south, /Thomas Edison/).length, 1);
  // Median plazas appear both ways.
  assert.equal(named(north, /Chesapeake House/).length, 1);
  assert.equal(named(south, /Chesapeake House/).length, 1);
});

test('a road that is not an interstate never gets rest areas', () => {
  const r = route('miami_to_manhattan');
  const all = matchRestAreas(r.polyline, data.restAreas);
  const none = matchRestAreas(r.polyline, data.restAreas, { highwayAt: () => [{ kind: 'usRoute', prefix: 'US', number: '1' }] });
  assert.ok(all.length > 10);
  assert.equal(none.length, 0);
});

test('badges show only tagged amenities, and the snapshot lists the next facility', () => {
  const plan = miami();
  for (const r of plan.restAreas) {
    for (const b of amenityBadges(r)) {
      if (b.key === 'hours') continue;
      assert.equal(r.amenities[b.key], b.value);
    }
  }
  const unknown = { amenities: {}, hours: null };
  assert.deepEqual(amenityBadges(unknown), []);
  const snap = plan.snapshot({ status: 'onRoute', distanceAlongRoute: 370 * MILE, offset: 0, isEstimated: false, t: START, speed: 30 },
    new TripLedger(), new PaceModel(), START);
  assert.match(snap.nextRestArea.restArea.name, /Georgia Visitor Information Center/);
  assert.ok(snap.nextRestArea.distance > 0 && snap.nextRestArea.distance < 10 * MILE);
  assert.ok(snap.upcomingRestAreas.every((u) => u.distance > 0 && u.distance <= 100 * MILE));
});

test('gas gaps report long stretches and an open gap at the window end', () => {
  const stops = [10, 20, 75, 80].map((m) => ({ distance: m * MILE }));
  const gaps = gasGaps(stops, 0, 150 * MILE, 40 * MILE, 500 * MILE);
  assert.deepEqual(gaps.map((g) => [g.from / MILE, g.to / MILE, g.open]), [[20, 75, false], [80, 150, true]]);
  const closed = gasGaps(stops, 0, 150 * MILE, 40 * MILE, 150 * MILE);
  assert.equal(closed[1].open, false);
  assert.deepEqual(gasGaps(stops, 70 * MILE, 100 * MILE, 40 * MILE), []);
});
