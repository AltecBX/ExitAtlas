// Exits on parkways, turnpikes and other freeways (freeways.eax, tools/data-pipeline/build_freeways.py) on real
// OSRM routes, checked against OSM node membership: the Sprain Brook and Taconic State Parkways (Yonkers to Lenox)
// and the Garden State Parkway (Paramus to Toms River).
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, load, route, START } from './support.js';
import { METERS_PER_MILE as MILE, RoutePolyline } from '../js/engine/geo.js';
import { ExitMatcher, MatchingOptions, optionsForSource, servicesForExit } from '../js/engine/exits.js';
import { TripPlan } from '../js/engine/trip.js';
import { TripLedger, PaceModel } from '../js/engine/tracking.js';
import { PlannedRoute, TravelTimeProfile, makeStep, parseHighways, highwayLabel } from '../js/engine/route.js';
import { nextManeuver } from '../js/engine/guidance.js';
import { Announcer } from '../js/app/announcer.js';

const plans = new Map();
const planFor = (name, exits = data.exits) => {
  const key = `${name}:${exits === data.exits ? 'all' : 'interstates'}`;
  if (!plans.has(key)) plans.set(key, new TripPlan(route(name), { states: data.states, timeZones: data.timeZones, interstates: exits }));
  return plans.get(key);
};
const at = (plan, miles) => plan.snapshot({ status: 'onRoute', distanceAlongRoute: miles * MILE, offset: 0, isEstimated: false, t: START, speed: 30 },
  new TripLedger(), new PaceModel(), START);
const onRoad = (plan, road) => plan.exits.filter((e) => e.highways.includes(road));

test('freeways.eax: OpenStreetMap provenance, no interstate exits, services without drive data', () => {
  const fw = data.freeways;
  assert.equal(fw.metadata.kind, 'freeways');
  assert.equal(fw.metadata.license, 'ODbL-1.0');
  assert.match(fw.metadata.attribution, /OpenStreetMap/);
  assert.match(fw.metadata.osm_extract_date, /^\d{4}-\d\d-\d\d$/);
  assert.ok(fw.exits.length > 10000, `${fw.exits.length} exits`);
  const interstate = new Set(data.interstates.exits.map((e) => e.osmNodeID));
  assert.equal(fw.exits.filter((e) => interstate.has(e.osmNodeID)).length, 0, 'no exit is in both files');
  for (const e of fw.exits) {
    assert.ok(e.bearings.length >= 1 && e.bearings.length <= 2, `exit ${e.osmNodeID} bearings`);
    assert.ok(e.label || e.name, `exit ${e.osmNodeID} has a number or a name`);
    const perCategory = new Map();
    for (const l of fw.links(e)) {
      const c = l.place.category;
      perCategory.set(c, (perCategory.get(c) ?? 0) + 1);
      assert.equal(l.driveMeters, null);
      assert.equal(l.driveSeconds, null);
      assert.equal(l.reachable, null, 'reachability unknown, never "unreachable"');
      assert.ok(l.straightLineMeters <= (c === 6 || c === 7 ? 1600 : 800), `${l.straightLineMeters} m`);
      assert.notEqual(c, 4, 'rest areas are rows of their own, not exit services');
      assert.ok(l.rank >= 1 && l.rank <= 12);
      assert.ok(l.place.name || c === 7, 'places are named (a dog park may not be)');
    }
    for (const n of perCategory.values()) assert.ok(n <= 12);
  }
});

test('the combined dataset leaves the interstate exits as they were', () => {
  for (const name of ['miami_to_manhattan', 'richmond_to_nyc_turnpike', 'yonkers_to_orlando', 'yonkers_to_lenox_taconic']) {
    const only = planFor(name, data.interstates).exits;
    const fromInterstates = planFor(name).exits.filter((e) => e.records.every((r) => r.part === 0));
    const key = (e) => `${e.id} ${e.label} ${e.distanceAlongRoute.toFixed(1)} ${e.name}`;
    assert.deepEqual(fromInterstates.map(key), only.map(key), name);
    // Services of an interstate exit come from interstates.eax, with its drive times.
    for (const e of fromInterstates.slice(0, 40)) assert.deepEqual(servicesForExit(data.exits, e), servicesForExit(data.interstates, e), name);
  }
});

// MARK: Taconic State Parkway (Yonkers to Lenox, OSRM's Sprain Brook and Taconic alternative)

test('Taconic: every freeway exit the route passes through matches, in order, none from the other carriageway', () => {
  const r = route('yonkers_to_lenox_taconic');
  const truth = load('yonkers_to_lenox_taconic').expected.freeway_exits_on_route;
  assert.ok(truth.length >= 40);
  const found = new ExitMatcher(optionsForSource(r.source)).encounters(r.polyline, data.freeways).map((e) => e.record.osmNodeID);
  assert.deepEqual([...new Set(found)], truth);
  // The southbound carriageway's exits, met driving the route backwards, are never matched going north.
  const back = new ExitMatcher(MatchingOptions.osmGeometry).encounters(new RoutePolyline(r.polyline.points.reverse()), data.freeways);
  const forward = new Set(truth);
  assert.equal(back.filter((e) => forward.has(e.record.osmNodeID)).length, 0);
});

test('Taconic: numbered exits in order with their names, where the interstate data alone had none', () => {
  assert.equal(onRoad(planFor('yonkers_to_lenox_taconic', data.interstates), 'Taconic State Parkway').length, 0);
  const plan = planFor('yonkers_to_lenox_taconic');
  const taconic = onRoad(plan, 'Taconic State Parkway');
  assert.ok(taconic.length >= 30, `${taconic.length} Taconic exits`);
  const numbered = taconic.filter((e) => e.label);
  const numbers = numbered.map((e) => parseInt(e.label, 10));
  for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i] >= numbers[i - 1], `exit ${numbered[i].label} after ${numbered[i - 1].label}`);
  assert.deepEqual(numbered.slice(0, 6).map((e) => e.label), ['2', '4', '5', '6', '8', '9']);
  const byLabel = (l) => taconic.find((e) => e.label === l);
  assert.equal(byLabel('47A').name, 'NY 55 East / Pawling');
  assert.equal(byLabel('47B').name, 'NY 55 West / Poughkeepsie');
  assert.ok(byLabel('47A').distanceAlongRoute < byLabel('47B').distanceAlongRoute);
  assert.equal(byLabel('91').name, 'NY 217 / CR 21C / Philmont / Harlemville');
  // The Sprain Brook's exits are not numbered in OSM: shown by their names.
  const sprain = onRoad(plan, 'Sprain Brook Parkway');
  assert.ok(sprain.length >= 5 && sprain.every((e) => !e.label && e.name));
  // Services near an exit, as straight line estimates.
  const s = servicesForExit(data.exits, byLabel('17B'));
  assert.ok(s.length > 0 && s.every((x) => x.detourBasis === 'estimate' && x.detourSeconds === null));
});

test('Taconic: the next exit and Road Ahead move on as exits are passed', () => {
  const plan = planFor('yonkers_to_lenox_taconic');
  let passed = 0;
  for (const miles of [5, 16.5, 29, 45, 59.2, 80, 104]) {
    const s = at(plan, miles);
    const d = miles * MILE;
    const ahead = plan.exits.filter((e) => e.distanceAlongRoute > d);
    assert.equal(s.nextExit?.exit.id ?? null, ahead[0]?.id ?? null, `mile ${miles}: next exit`);
    assert.deepEqual(s.upcomingExits.map((u) => u.exit.id), ahead.filter((e) => e.distanceAlongRoute <= d + 100 * MILE).map((e) => e.id));
    assert.ok(s.upcomingExits.every((u) => u.distance > 0), 'nothing passed is ahead');
    const behind = plan.exits.length - ahead.length;
    assert.ok(behind >= passed, 'passed exits only add up');
    passed = behind;
    // The state line card counts them too.
    if (s.current?.segment.code === 'NY') assert.equal(s.current.exitsRemaining, ahead.filter((e) => e.distanceAlongRoute < s.current.segment.endDistance).length);
  }
  assert.equal(at(plan, 59.2).nextExit.exit.label, '47B');
  assert.equal(at(plan, 104).nextExit, null, 'none left after Exit 91');
});

test('Taconic: the Drive screen names the parkway, and local roads stay local roads', () => {
  for (const exits of [data.exits, data.interstates]) {
    const plan = planFor('yonkers_to_lenox_taconic', exits);
    const s = at(plan, 50);
    assert.deepEqual(s.highway.ref, { kind: 'named', prefix: '', number: 'Taconic State Parkway' });
    assert.equal(s.highway.direction, 'N');
    assert.equal(highwayLabel(s.highway.ref), 'Taconic State Pkwy');
    assert.equal(highwayLabel(at(plan, 8).highway.ref), 'Sprain Brook Pkwy');
    assert.equal(at(plan, 0.3).highway, null, 'Nepperhan Avenue');
    assert.equal(highwayLabel(at(plan, 2).highway.ref), 'NY-9A');
  }
});

// MARK: Garden State Parkway (Paramus to Toms River)

test('Garden State Parkway: southbound exits only, in order', () => {
  const r = route('paramus_to_toms_river_gsp');
  const truth = load('paramus_to_toms_river_gsp').expected.freeway_exits_on_route;
  const found = new ExitMatcher(optionsForSource(r.source)).encounters(r.polyline, data.freeways).map((e) => e.record.osmNodeID);
  assert.deepEqual([...new Set(found)], truth);
  const gsp = onRoad(planFor('paramus_to_toms_river_gsp'), 'Garden State Parkway').filter((e) => /^\d+/.test(e.label));
  const numbers = gsp.map((e) => parseInt(e.label, 10));
  for (let i = 1; i < numbers.length; i++) assert.ok(numbers[i] <= numbers[i - 1], `exit ${gsp[i].label} after ${gsp[i - 1].label}`);
  assert.equal(gsp[0].label, '159');
  assert.equal(gsp[gsp.length - 1].label, '81');
  assert.equal(highwayLabel(at(planFor('paramus_to_toms_river_gsp'), 20).highway.ref), 'Garden State Pkwy');
});

test('Garden State Parkway: guidance names Exit 81', () => {
  const plan = planFor('paramus_to_toms_river_gsp');
  const exit81 = plan.exits.find((e) => e.label === '81');
  const m = nextManeuver(plan.route, exit81.distanceAlongRoute - 3 * MILE, { exits: plan.exits });
  assert.equal(m.kind, 'exit');
  assert.equal(m.exitLabel, '81');
  assert.equal(m.text, 'Take Exit 81 toward CR-527 E');
  assert.ok(Math.abs(m.at - exit81.distanceAlongRoute) < 600);
});

test('voice: the exit number and its name a mile before, on both parkways', () => {
  const settings = { voice: true, announceExits: true, announceStateLines: false, announceRestAreas: false, announceGasGaps: false, announceTimeZones: false };
  for (const [name, label, words] of [['yonkers_to_lenox_taconic', '47A', 'Exit 47A in 1 mile, NY 55 East / Pawling.'],
    ['paramus_to_toms_river_gsp', '100B', 'Exit 100B in 1 mile, NJ 33 West / Freehold.']]) {
    const plan = planFor(name);
    const exit = plan.exits.find((e) => e.label === label);
    const spoken = [];
    const announcer = new Announcer((text) => spoken.push(text));
    announcer.consider(at(plan, exit.distanceAlongRoute / MILE - 0.95), settings);
    announcer.consider(at(plan, exit.distanceAlongRoute / MILE - 0.5), settings);
    assert.deepEqual(spoken, [words], name);
  }
});

// MARK: Road names

test('named freeways by their full name, with the ref OSRM puts before it dropped, shown short', () => {
  const names = (t) => parseHighways(t).map((r) => r.number);
  const labels = (t) => parseHighways(t).map(highwayLabel);
  assert.deepEqual(names('Taconic State Parkway new name straight'), ['Taconic State Parkway']);
  assert.deepEqual(labels('Taconic State Parkway new name straight'), ['Taconic State Pkwy']);
  assert.deepEqual(labels('GSP Garden State Parkway merge slight left'), ['Garden State Pkwy']);
  assert.deepEqual(labels('SO Southern State Parkway'), ['Southern State Pkwy']);
  assert.deepEqual(names('NJTP New Jersey Turnpike'), ['New Jersey Turnpike']);
  assert.deepEqual(labels('NJTP'), ['New Jersey Tpke']);
  assert.deepEqual(labels('Cross County Parkway (express lanes)'), ['Cross County Pkwy']);
  assert.deepEqual(labels('I 495 Long Island Expressway'), ['I-495', 'Long Island Expy']);
  // Highways with a number keep it first, so the road shown and its direction are as before.
  assert.deepEqual(labels('I 95;NJTP New Jersey Turnpike'), ['I-95', 'New Jersey Tpke']);
  assert.deepEqual(labels('I 87 New York State Thruway'), ['I-87', 'New York State Thruway']);
  assert.deepEqual(labels('CT 15 Merritt Parkway'), ['CT-15', 'Merritt Pkwy']);
  assert.deepEqual(labels('US 78;GA 410 Stone Mountain Freeway'), ['US-78', 'GA-410', 'Stone Mountain Freeway']);
  // Two parkways are two roads: a fork from one to the other is not "stay on".
  assert.notDeepEqual(parseHighways('Sprain Brook Parkway')[0], parseHighways('Taconic State Parkway')[0]);
});

test('guidance names each parkway: Merge onto Sprain Brook Pkwy, not onto Parkway', () => {
  const texts = (name) => {
    const r = route(name), out = [];
    for (let m = nextManeuver(r, 0, { exits: planFor(name).exits }); m; m = nextManeuver(r, m.at + 1, { exits: planFor(name).exits })) out.push(m.text);
    return out;
  };
  const taconic = texts('yonkers_to_lenox_taconic');
  assert.ok(taconic.includes('Take the ramp onto Sprain Brook Pkwy'), taconic.join(' | '));
  assert.ok(taconic.includes('Merge onto Sprain Brook Pkwy'), taconic.join(' | '));
  const gsp = texts('paramus_to_toms_river_gsp');
  for (const t of ['Take the exit on the right toward Garden State Pkwy', 'Merge onto Garden State Pkwy', 'Keep left to stay on Garden State Pkwy',
    'Take Exit 81 toward CR-527 E']) assert.ok(gsp.includes(t), `${t}: ${gsp.join(' | ')}`);
  for (const t of [...taconic, ...gsp]) assert.doesNotMatch(t, /onto Parkway|on Parkway/);
});

test('a freeway whose name has no road word is named from the exits on it', () => {
  const pts = [{ lat: 40.70, lon: -73.97 }, { lat: 40.75, lon: -73.96 }, { lat: 40.80, lon: -73.93 }];
  const polyline = new RoutePolyline(pts);
  const half = polyline.length / 2;
  const r = new PlannedRoute({
    source: 'osrm', polyline, timeProfile: TravelTimeProfile.uniform(polyline.length, 600),
    steps: [makeStep(0, half, 'depart', 'Water Street'), makeStep(half, polyline.length - half, 'merge slight left', 'FDR FDR Drive')],
    origin: { name: 'A', coordinate: pts[0] }, destination: { name: 'B', coordinate: pts[2] },
  });
  const plan = { route: r, exitRoads: new Set(['FDR Drive', 'I-95']) };
  const road = TripPlan.prototype.freewayAt.call(plan, half + 100);
  assert.deepEqual(road.ref, { kind: 'named', prefix: '', number: 'FDR Drive' });
  assert.equal(road.direction, 'N');
  assert.equal(TripPlan.prototype.freewayAt.call(plan, 100), null, 'Water Street is no exit road');
  assert.equal(TripPlan.prototype.freewayAt.call({ route: r, exitRoads: new Set() }, half + 100), null);
});
