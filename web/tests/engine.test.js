// The JavaScript engine checked against the same independent oracles as the Swift engine
// (Tests/ExitAtlasCoreTests): shapely/pyproj state segments on full resolution TIGER/Line,
// OSM node membership for exits, published I-95 state lengths, simulated GPS traces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, load, route, START, near } from './support.js';
import {
  METERS_PER_MILE, distance, initialBearing, angleDifference, offset, RoutePolyline, decodePolyline, encodePolyline,
} from '../js/engine/geo.js';
import { RegionSegmenter, RegionIndex } from '../js/engine/datasets.js';
import { ExitMatcher, MatchingOptions, optionsForSource } from '../js/engine/exits.js';
import { RouteProgressTracker, TripLedger, PaceModel } from '../js/engine/tracking.js';
import { TripPlan, TripSession } from '../js/engine/trip.js';
import { HighwayDiscovery, GPSSimulator } from '../js/engine/discovery.js';
import { PlannedRoute, TravelTimeProfile, parseHighways, highwayLabel } from '../js/engine/route.js';
import { serializeRoute, deserializeRoute } from '../js/engine/osrm.js';

const FIXTURES = ['miami_to_manhattan', 'atlanta_to_nashville', 'richmond_to_nyc_turnpike', 'richmond_to_nyc_via_pa'];
const TOL = 0.05 * METERS_PER_MILE;

// MARK: Geodesy and polyline

test('Vincenty matches the classic Flinders Peak to Buninyong distance', () => {
  const a = { lat: -(37 + 57 / 60 + 3.72030 / 3600), lon: 144 + 25 / 60 + 29.52440 / 3600 };
  const b = { lat: -(37 + 39 / 60 + 10.15610 / 3600), lon: 143 + 55 / 60 + 35.38390 / 3600 };
  near(distance(a, b), 54972.271, 0.01);
});

test('bearings, angle difference and encoded polyline', () => {
  const a = { lat: 35, lon: -80 };
  near(initialBearing(a, { lat: 36, lon: -80 }), 0, 0.01);
  near(initialBearing(a, { lat: 35, lon: -79 }), 90, 0.5);
  near(angleDifference(350, 10), 20, 1e-9);
  near(angleDifference(90, 270), 180, 1e-9);
  const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(decoded.length, 3);
  near(decoded[0].lat, 38.5, 1e-6);
  near(decoded[2].lon, -126.453, 1e-6);
  assert.equal(encodePolyline(decoded), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

test('projection side, loop passes and slicing', () => {
  const origin = { lat: 40, lon: -75 };
  const line = new RoutePolyline([origin, offset(origin, 0, 1000)]);
  const right = offset(offset(origin, 0, 400), 90, 12);
  const p = line.nearestProjection(right, 50);
  near(p.distanceAlong, 400, 0.5);
  near(p.offset, 12, 0.2);
  assert.ok(p.signedOffset > 0);

  const pts = [0, 1, 2, 3, 4].map((k) => offset(origin, 0, k * 50));
  const center = offset(pts[pts.length - 1], 90, 40);
  for (let k = 1; k <= 24; k++) pts.push(offset(center, 270 - k * 15, 40));
  pts.push(offset(pts[pts.length - 1], 180, 200));
  const loop = new RoutePolyline(pts);
  const passes = loop.projections(offset(origin, 0, 200), 120);
  assert.ok(passes.length >= 2);
  near(passes[0].distanceAlong, 200, 1);
  assert.ok(passes[passes.length - 1].distanceAlong > 300);

  const straight = new RoutePolyline(Array.from({ length: 21 }, (_, k) => offset(origin, 10, k * 250)));
  near(straight.slice(1100, 3900).length, 2800, 1);
});

test('highway parsing', () => {
  assert.deepEqual(parseHighways('I 95; US 17').map(highwayLabel), ['I-95', 'US-17']);
  assert.deepEqual(parseHighways('Merge onto I-95 N toward New York').map(highwayLabel), ['I-95']);
  assert.equal(parseHighways('I-35E')[0].number, '35E');
  assert.equal(highwayLabel(parseHighways('NJTP')[0]), 'New Jersey Turnpike');
  assert.equal(highwayLabel(parseHighways('SR 70')[0]), 'SR-70');
  assert.equal(parseHighways('Brickell Avenue').length, 0);
});

// MARK: Synthetic regions

function squaresIndex() {
  const bytes = [];
  const u8 = (v) => bytes.push(v & 0xff);
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
  const i32 = (v) => u32(v >>> 0);
  const e7 = (x) => Math.round(x * 1e7);
  const str = (s) => [...Buffer.from(s)].forEach(u8);
  const square = (code, lat0, lon0, size) => {
    u8(code.length); str(code); u16(code.length); str(code); u8(0);
    i32(e7(lat0)); i32(e7(lon0)); i32(e7(lat0 + size)); i32(e7(lon0 + size));
    u32(1); u32(1); u32(5);
    for (const [la, lo] of [[lat0, lon0], [lat0, lon0 + size], [lat0 + size, lon0 + size], [lat0 + size, lon0], [lat0, lon0]]) {
      i32(e7(la)); i32(e7(lo));
    }
  };
  str('EAB1'); u32(1); u32(2); str('{}'); u32(4);
  square('A', 0, 0, 1); square('B', 0, 1, 1); square('C', 0, 2, 1); square('D', 1, 1, 1);
  return new RegionIndex(new Uint8Array(bytes).buffer);
}

test('synthetic regions: crossings, reentry, noise merge, outside', () => {
  const index = squaresIndex();
  const seg = (pts, opts) => new RegionSegmenter(opts).segment(new RoutePolyline(pts), index);
  const p = seg([{ lat: 0.5, lon: 0.5 }, { lat: 0.5, lon: 2.5 }, { lat: 0.5, lon: 1.5 }, { lat: 1.5, lon: 1.5 }, { lat: 0.5, lon: 1.5 }]);
  assert.deepEqual(p.segments.map((s) => s.code), ['A', 'B', 'C', 'B', 'D', 'B']);
  assert.deepEqual(p.segments.filter((s) => s.code === 'B').map((s) => s.visit), [1, 2, 3]);
  near(p.segments[1].entryCoordinate.lon, 1, 1e-9);
  const lonPoke = 1 + 20 / (111319.49 * Math.cos(0.5 * Math.PI / 180));
  const poke = [{ lat: 0.5, lon: 0.9 }, { lat: 0.5001, lon: lonPoke }, { lat: 0.5002, lon: 0.9 }];
  assert.deepEqual(seg(poke).segments.map((s) => s.code), ['A']);
  const fine = seg(poke, { noiseThreshold: 10 });
  assert.deepEqual(fine.segments.map((s) => s.code), ['A', 'B', 'A']);
  assert.ok(fine.segments[1].isBrief);
  const out = seg([{ lat: 0.5, lon: 2.5 }, { lat: 0.5, lon: 3.5 }]);
  assert.deepEqual(out.segments.map((s) => s.code), ['C', null]);
  assert.equal(out.segments[1].displayName, 'Outside U.S. states');
});

// MARK: State segmentation against the oracle

for (const name of FIXTURES) {
  test(`state segmentation matches the oracle: ${name}`, () => {
    const r = route(name);
    const { expected } = load(name);
    const profile = new RegionSegmenter().segment(r.polyline, data.states);
    assert.deepEqual(profile.segments.map((s) => s.code), expected.states.map((s) => s.code), 'state order');
    near(r.polyline.length, expected.geodesic_length_m, 1.0, 'route length');
    profile.segments.forEach((got, i) => {
      near(got.length, expected.states[i].length_m, TOL, `${got.code} length`);
      near(got.startDistance, expected.states[i].start_m, TOL, `${got.code} start`);
    });
    const sum = profile.segments.reduce((a, s) => a + s.length, 0);
    near(sum, r.polyline.length, 0.01, 'segments cover the route');
    for (let i = 1; i < profile.segments.length; i++) {
      near(profile.segments[i - 1].endDistance, profile.segments[i].startDistance, 1e-6, 'contiguous');
    }
  });
}

test('Georgia is reentered on Atlanta to Nashville', () => {
  const profile = new RegionSegmenter().segment(route('atlanta_to_nashville').polyline, data.states);
  assert.deepEqual(profile.segments.filter((s) => s.code === 'GA').map((s) => s.visit), [1, 2]);
  assert.deepEqual(profile.totals.map((t) => t.code), ['GA', 'TN']);
  assert.equal(profile.totals[0].visits, 2);
});

test('published I-95 state lengths (GA 111.80, SC 198.76, NC 181.36 mi)', () => {
  const profile = new RegionSegmenter().segment(route('miami_to_manhattan').polyline, data.states);
  for (const [code, miles] of [['GA', 111.80], ['SC', 198.76], ['NC', 181.36]]) {
    const s = profile.segments.find((x) => x.code === code);
    near(s.length / METERS_PER_MILE, miles, 0.25, code);
  }
});

// MARK: Exits against OSM node membership

for (const name of FIXTURES) {
  test(`exit matching agrees with OSM node membership: ${name}`, () => {
    const r = route(name);
    const { fixture, expected } = load(name);
    const truth = expected.exits_on_route;
    const found = new ExitMatcher(optionsForSource(r.source)).encounters(r.polyline, data.interstates);
    const seen = new Set();
    const matched = found.map((e) => e.record.osmNodeID).filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
    const truthSet = new Set(truth), foundSet = new Set(matched);
    for (const node of truth.filter((n) => !foundSet.has(n))) {
      const i = fixture.osm_nodes.indexOf(node);
      const routeCopy = { lat: fixture.coordinates[i][0], lon: fixture.coordinates[i][1] };
      const datasetCopy = data.interstates.exits.find((e) => e.osmNodeID === node).coordinate;
      assert.ok(distance(routeCopy, datasetCopy) > 5, `missed exit node ${node}`);
    }
    for (const e of found) {
      if (!truthSet.has(e.record.osmNodeID)) assert.ok(e.offset < 1.0, `extra exit ${e.record.osmNodeID} ${e.offset} m off`);
    }
    assert.deepEqual(matched.filter((n) => truthSet.has(n)), truth.filter((n) => foundSet.has(n)), 'order');
  });
}

test('reversed route rejects forward direction exits', () => {
  const r = route('miami_to_manhattan');
  const forward = new Set(load('miami_to_manhattan').expected.exits_on_route);
  const reversed = new RoutePolyline(r.polyline.points.reverse());
  const found = new ExitMatcher(MatchingOptions.thirdPartyGeometry).encounters(reversed, data.interstates);
  const wrong = found.filter((e) => forward.has(e.record.osmNodeID) && e.confidence === 'high');
  assert.equal(wrong.length, 0);
});

test('merged exits are ordered with ASCII labels', () => {
  const r = route('miami_to_manhattan');
  const exits = new ExitMatcher(optionsForSource(r.source)).match(r.polyline, data.interstates);
  assert.ok(exits.length > 250);
  for (let i = 1; i < exits.length; i++) {
    assert.ok(exits[i - 1].distanceAlongRoute <= exits[i].distanceAlongRoute);
    assert.equal(exits[i].ordinal, exits[i - 1].ordinal + 1);
  }
  for (const e of exits) assert.match(e.label, /^[\x20-\x7e]*$/);
});

// MARK: Snapshot

const datasets = () => ({ states: data.states, timeZones: data.timeZones, interstates: data.interstates });
let miamiPlan = null;
const miami = () => (miamiPlan ??= new TripPlan(route('miami_to_manhattan'), datasets()));
const onRoute = (d) => ({ status: 'onRoute', distanceAlongRoute: d, offset: 0, isEstimated: false, t: START, speed: 30 });

test('snapshot: state order and upcoming states from Florida', () => {
  const plan = miami();
  const s = plan.snapshot(onRoute(100 * METERS_PER_MILE), new TripLedger(), new PaceModel(), START);
  assert.equal(s.current.segment.code, 'FL');
  assert.equal(s.next.segment.code, 'GA');
  assert.deepEqual(s.statesAhead, ['GA', 'SC', 'NC', 'VA', 'DC', 'MD', 'DE', 'NJ', 'NY']);
  assert.equal(s.borderCrossingsRemaining, 9);
  const expected = load('miami_to_manhattan').expected.states;
  near(s.current.remainingMeters, expected[0].end_m - 100 * METERS_PER_MILE, 80);
  near(s.next.totalMeters, expected[1].length_m, 80);
  near(s.distanceToNextBorder, s.current.remainingMeters, 0.001);
});

test('snapshot: exits left before the Georgia line match node membership', () => {
  const plan = miami();
  const { fixture, expected } = load('miami_to_manhattan');
  const byNode = new Map(data.interstates.exits.map((e) => [e.osmNodeID, e]));
  const nodeIndex = new Map();
  fixture.osm_nodes.forEach((n, i) => { if (!nodeIndex.has(n)) nodeIndex.set(n, i); });
  const truth = expected.exits_on_route
    .filter((n) => nodeIndex.has(n) && byNode.has(n))
    .map((n) => ({ distance: plan.route.polyline.cum[nodeIndex.get(n)], label: byNode.get(n).label }));
  const border = expected.states[0].end_m;
  for (const miles of [10, 120, 250, 370]) {
    const d = miles * METERS_PER_MILE;
    let count = 0, last = null;
    for (const t of truth) {
      if (!(t.distance > d && t.distance < border)) continue;
      if (last && t.label && last.label === t.label && t.distance - last.distance <= 800) { last = t; continue; }
      count += 1;
      last = t;
    }
    const s = plan.snapshot(onRoute(d), new TripLedger(), new PaceModel(), START);
    assert.ok(s.current.exitsRemaining >= count && s.current.exitsRemaining <= count + 3, `mile ${miles}: ${s.current.exitsRemaining} vs ${count}`);
  }
});

test('snapshot: ETAs follow the travel time model and pace', () => {
  const plan = miami();
  const d = 50 * METERS_PER_MILE;
  const s = plan.snapshot(onRoute(d), new TripLedger(), new PaceModel(), START);
  near(s.current.exitTime - START, plan.route.timeProfile.secondsBetween(d, s.current.segment.endDistance), 1);
  near(s.eta - START, plan.route.timeProfile.secondsBetween(d, plan.route.length), 1);
  const upcoming = s.itinerary.filter((f) => f.status === 'upcoming');
  for (let i = 1; i < upcoming.length; i++) {
    assert.ok(upcoming[i - 1].entryTime <= upcoming[i].entryTime);
    near(upcoming[i - 1].exitTime, upcoming[i].entryTime, 1e-6);
  }
  const pace = new PaceModel();
  for (let i = 0; i < 60; i++) pace.observe(60, 72);
  const slower = plan.snapshot(onRoute(d), new TripLedger(), pace, START);
  assert.ok(slower.eta > s.eta);
  near(slower.timeRemaining / s.timeRemaining, pace.factor, 0.001);
});

test('snapshot: highway and direction, I-95 N in Georgia', () => {
  const s = miami().snapshot(onRoute(450 * METERS_PER_MILE), new TripLedger(), new PaceModel(), START);
  assert.equal(s.current.segment.code, 'GA');
  assert.equal(`${highwayLabel(s.highway.ref)} ${s.highway.direction}`, 'I-95 N');
});

test('time zones on Atlanta to Nashville', () => {
  const plan = new TripPlan(route('atlanta_to_nashville'), datasets());
  const s = plan.snapshot(onRoute(0), new TripLedger(), new PaceModel(), START);
  assert.equal(s.itinerary[0].entryTimeZoneID, 'America/New_York');
  assert.equal(s.itinerary[s.itinerary.length - 1].exitTimeZoneID, 'America/Chicago');
  assert.equal(plan.timeZoneIDAt(plan.route.length - 1000), 'America/Chicago');
  const zones = new RegionSegmenter().segment(plan.route.polyline, data.timeZoneIndex);
  assert.deepEqual(zones.segments.map((z) => z.code), ['Eastern', 'Central']);
  const lastTN = plan.states.segments[plan.states.segments.length - 1];
  assert.equal(lastTN.code, 'TN');
  assert.ok(zones.segments[1].startDistance > lastTN.startDistance);
});

// MARK: Tracking

test('tracking: noisy drive stays on route', () => {
  const r = route('atlanta_to_nashville');
  const trace = new GPSSimulator(r, { noise: 6, reportedAccuracy: 8 }).trace(0, null, START);
  const tracker = new RouteProgressTracker(r.polyline, START);
  const errors = [];
  for (const { sample, truth } of trace) {
    const m = tracker.ingest(sample);
    assert.notEqual(m.status, 'offRoute', `false off route at ${truth}`);
    if (m.status === 'onRoute') errors.push(Math.abs(m.distanceAlongRoute - truth));
  }
  errors.sort((a, b) => a - b);
  assert.ok(errors.length > trace.length - 5);
  assert.ok(errors[Math.floor(errors.length * 0.99)] < 30, 'p99');
  assert.ok(errors[errors.length - 1] < 60, 'worst');
});

test('tracking: tunnel dropout is dead reckoned and reacquired', () => {
  const r = route('miami_to_manhattan');
  const gapStart = 1750000, gapEnd = 1752400;
  const trace = new GPSSimulator(r, { dropouts: [[gapStart, gapEnd]] }).trace(gapStart - 5000, gapEnd + 5000, START);
  const tracker = new RouteProgressTracker(r.polyline, START);
  let lastBefore = null;
  for (const x of trace) if (x.truth < gapStart) { tracker.ingest(x.sample); lastBefore = x; }
  const est = tracker.estimate(lastBefore.sample.t + 60);
  assert.ok(est.isEstimated);
  assert.equal(est.status, 'onRoute');
  near(est.distanceAlongRoute, lastBefore.truth + 60 * lastBefore.sample.speed, 150);
  for (const x of trace) {
    if (x.truth <= gapEnd) continue;
    const m = tracker.ingest(x.sample);
    assert.equal(m.status, 'onRoute');
    near(m.distanceAlongRoute, x.truth, 40);
  }
  assert.equal(tracker.estimate(trace[trace.length - 1].sample.t + 600).status, 'signalLost');
});

test('tracking: leaving the route is flagged within 20 s', () => {
  const r = route('atlanta_to_nashville');
  const trace = new GPSSimulator(r, { departure: { atDistance: 50000, lateralSpeed: 12 } }).trace(45000, 52000, START);
  const tracker = new RouteProgressTracker(r.polyline, START);
  let offAt = null, lastOn = 0;
  for (const { sample } of trace) {
    const m = tracker.ingest(sample);
    if (m.status === 'onRoute') lastOn = m.distanceAlongRoute;
    if (m.status === 'offRoute' && offAt === null) offAt = sample.t;
  }
  assert.ok(offAt !== null);
  assert.ok(lastOn < 50400);
  const departureT = trace.find((x) => x.truth >= 50000).sample.t;
  assert.ok(offAt - departureT < 20);
});

test('tracking: acquires mid route and keeps the correct pass on an out and back road', () => {
  const r = route('miami_to_manhattan');
  const first = new GPSSimulator(r).trace(900000, 902000, START)[0];
  const m = new RouteProgressTracker(r.polyline, START).ingest(first.sample);
  assert.equal(m.status, 'onRoute');
  near(m.distanceAlongRoute, first.truth, 30);

  const origin = { lat: 35, lon: -80 };
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push(offset(origin, 0, i * 50));
  const east = offset(pts[pts.length - 1], 90, 15);
  for (let i = 0; i <= 40; i++) pts.push(offset(east, 180, i * 50));
  const polyline = new RoutePolyline(pts);
  const outAndBack = new PlannedRoute({
    source: 'testFixture', polyline, timeProfile: TravelTimeProfile.uniform(polyline.length, polyline.length / 15),
    origin: { name: 'A', coordinate: pts[0] }, destination: { name: 'B', coordinate: pts[pts.length - 1] },
  });
  const tracker = new RouteProgressTracker(polyline, START);
  for (const { sample, truth } of new GPSSimulator(outAndBack, { noise: 5 }).trace(0, null, START)) {
    near(tracker.ingest(sample).distanceAlongRoute, truth, 60, 'jumped to the other pass');
  }
});

// MARK: Reroute and discovery

test('ledger survives a reroute and state totals match the driven route', () => {
  const ds = { states: data.states, timeZones: null, interstates: data.interstates };
  const turnpike = route('richmond_to_nyc_turnpike');
  const viaPA = route('richmond_to_nyc_via_pa');
  const session = new TripSession(new TripPlan(turnpike, ds), data.states, START);
  const first = new GPSSimulator(turnpike).trace(0, 250000, START);
  for (const { sample } of first) session.ingest(sample);
  const lastSample = first[first.length - 1].sample;
  assert.equal(session.plan.states.segmentAt(250000).code, 'MD');
  const projection = viaPA.polyline.nearestProjection(lastSample.coordinate, 50);
  const remainder = viaPA.polyline.slice(projection.distanceAlong, viaPA.polyline.length);
  const rerouted = new PlannedRoute({
    source: 'osrm', polyline: remainder,
    timeProfile: TravelTimeProfile.uniform(remainder.length, viaPA.timeProfile.secondsBetween(projection.distanceAlong, viaPA.length)),
    origin: { name: 'Here', coordinate: remainder.point(0) }, destination: viaPA.destination,
  });
  session.replacePlan(new TripPlan(rerouted, ds), lastSample.t);
  assert.deepEqual(session.plan.states.segments.map((s) => s.code), ['MD', 'DE', 'PA', 'NJ', 'NY']);
  let snap = null;
  for (const { sample } of new GPSSimulator(viaPA).trace(projection.distanceAlong + 20, null, lastSample.t + 1)) snap = session.ingest(sample);
  const expected = load('richmond_to_nyc_via_pa').expected.states;
  const totals = session.ledger.totalsByRegion;
  assert.deepEqual(totals.map((t) => t.code), expected.map((s) => s.code));
  totals.forEach((t, i) => near(t.meters, expected[i].length_m, 120, t.code));
  assert.equal(snap.current.segment.code, 'NY');
  assert.equal(session.ledger.stints.filter((s) => s.code === 'MD').length, 1);
});

test('needs reroute after leaving the route; off route miles still credited', () => {
  const ds = { states: data.states, timeZones: null, interstates: null };
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, ds), data.states, START);
  let requested = false;
  for (const { sample } of new GPSSimulator(r, { departure: { atDistance: 30000, lateralSpeed: 10 } }).trace(25000, 34000, START)) {
    session.ingest(sample);
    if (session.needsReroute(sample.t)) requested = true;
  }
  assert.ok(requested);
  assert.equal(session.ledger.totalsByRegion[0].code, 'GA');
  assert.ok(session.ledger.totalMeters > 8000);
});

test('discovery locks onto I-95 northbound in Georgia and forecasts South Carolina', () => {
  const r = route('miami_to_manhattan');
  const discovery = new HighwayDiscovery(data.corridors);
  let locked = null;
  for (const { sample } of new GPSSimulator(r).trace(430 * METERS_PER_MILE, 431 * METERS_PER_MILE, START)) {
    const st = discovery.ingest(sample);
    if (st.kind === 'locked') locked = st.match;
  }
  assert.equal(locked?.corridor.highway, 'I-95');
  assert.equal(locked?.corridor.directionCode, 'NB');
  const plan = new TripPlan(HighwayDiscovery.routeAhead(locked, undefined, START * 1000),
    { states: data.states, timeZones: null, interstates: data.interstates });
  assert.equal(plan.states.segments[0].code, 'GA');
  assert.equal(plan.states.segments[1].code, 'SC');
  assert.ok(plan.exits.length > 10);
  const s = plan.snapshot(onRoute(0), new TripLedger(), new PaceModel(), START);
  assert.equal(`${highwayLabel(s.highway.ref)} ${s.highway.direction}`, 'I-95 N');
});

test('discovery does not lock while stationary', () => {
  const r = route('miami_to_manhattan');
  const base = new GPSSimulator(r).trace(430 * METERS_PER_MILE, 430.1 * METERS_PER_MILE, START)[0].sample;
  const discovery = new HighwayDiscovery(data.corridors);
  for (let i = 0; i < 10; i++) {
    assert.notEqual(discovery.ingest({ ...base, speed: 0, t: START + i }).kind, 'locked');
  }
});

test('route serialization round trip keeps geometry, profile and steps', () => {
  const r = route('atlanta_to_nashville');
  const back = deserializeRoute(JSON.parse(JSON.stringify(serializeRoute(r))));
  near(back.length, r.length, 0.5);
  near(back.timeProfile.totalSeconds, r.timeProfile.totalSeconds, 1e-6);
  assert.equal(back.steps.length, r.steps.length);
  near(back.timeProfile.secondsAt(100000), r.timeProfile.secondsAt(100000), 1);
});
