// Voice announcements across a reroute: real route geometry, simulated GPS, the trip session and a
// captured speaker in place of speech synthesis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START } from './support.js';
import { TripPlan, TripSession } from '../js/engine/trip.js';
import { PlannedRoute, TravelTimeProfile } from '../js/engine/route.js';
import { GPSSimulator } from '../js/engine/discovery.js';
import { Announcer } from '../js/app/announcer.js';

const MILE = 1609.344;
const settings = { voice: true, announceStateLines: true, announceExits: false };

test('state line messages keep working after a reroute renumbers the states', () => {
  const ds = { states: data.states, timeZones: null, interstates: data.interstates };
  const r = route('richmond_to_nyc_turnpike');
  const session = new TripSession(new TripPlan(r, ds), data.states, START);
  const spoken = [];
  const announcer = new Announcer((text) => spoken.push(text));
  const drive = (fromMeters, toMeters, t0) => {
    let last = null;
    for (const { sample } of new GPSSimulator(r).trace(fromMeters, toMeters, t0)) {
      announcer.consider(session.ingest(sample), settings);
      last = sample;
    }
    return last;
  };

  // The second state line after the start (the plan's segment index 2 or more), so the original
  // indexes differ from the rerouted plan's, which restart at 0.
  const segments = session.plan.states.segments;
  const k = segments.findIndex((s, i) => i >= 2 && s.startDistance > 60 * MILE && s.code);
  assert.ok(k > 0, 'route has a later state line');
  const border = segments[k].startDistance;
  const nextName = segments[k].displayName;

  let last = drive(0, border - 4 * MILE, START);
  const warnings = () => spoken.filter((t) => t.startsWith(`${nextName} state line in`));
  assert.equal(warnings().length, 1, `warned once before ${nextName}: ${spoken.join(' | ')}`);

  // Reroute onto the same road ahead (a new plan that starts here).
  const here = r.polyline.nearestProjection(last.coordinate, 50);
  const remainder = r.polyline.slice(here.distanceAlong, r.polyline.length);
  const rerouted = new PlannedRoute({
    source: 'osrm', polyline: remainder,
    timeProfile: TravelTimeProfile.uniform(remainder.length, r.timeProfile.secondsBetween(here.distanceAlong, r.length)),
    origin: { name: 'Here', coordinate: remainder.point(0) }, destination: r.destination,
  });
  session.replacePlan(new TripPlan(rerouted, ds), last.t);
  assert.notEqual(session.plan.states.segments.findIndex((s) => s.displayName === nextName), k, 'indexes changed');

  // Cross the state line on the new plan.
  last = drive(here.distanceAlong + 20, border + 2 * MILE, last.t + 1);
  assert.equal(warnings().length, 1, 'the same state line is not announced twice');
  assert.ok(spoken.some((t) => t.startsWith(`Welcome to ${nextName}.`)), `welcome after reroute: ${spoken.join(' | ')}`);

  // The following state line is still announced.
  const after = segments.slice(k + 1).find((s) => s.code && s.startDistance - border > 10 * MILE);
  if (after) {
    drive(border + 2 * MILE, after.startDistance - 4 * MILE, last.t + 1);
    assert.ok(spoken.some((t) => t.startsWith(`${after.displayName} state line in`)), `next warning: ${spoken.join(' | ')}`);
  }
});

test('voice off or off route says nothing, then resumes without a false welcome', () => {
  const ds = { states: data.states, timeZones: null, interstates: data.interstates };
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, ds), data.states, START);
  const spoken = [];
  const announcer = new Announcer((text) => spoken.push(text));
  for (const { sample } of new GPSSimulator(r).trace(0, 20 * MILE, START)) {
    announcer.consider(session.ingest(sample), { ...settings, voice: false });
  }
  assert.deepEqual(spoken, []);
  for (const { sample } of new GPSSimulator(r).trace(20 * MILE, 40 * MILE, START + 3600)) {
    announcer.consider(session.ingest(sample), settings);
  }
  assert.ok(!spoken.some((t) => t.startsWith('Welcome')), spoken.join(' | '));
});

test('rest areas, time zones and the last gas before a long stretch are spoken once each', () => {
  const ds = { states: data.states, timeZones: data.timeZones, interstates: data.interstates, restAreas: data.restAreas };
  const r = route('atlanta_to_nashville');
  const plan = new TripPlan(r, ds);
  const session = new TripSession(plan, data.states, START);
  const spoken = [];
  const announcer = new Announcer((text) => spoken.push(text));
  const all = { ...settings, announceRestAreas: true, announceTimeZones: true, announceGasGaps: true };
  for (const { sample } of new GPSSimulator(r).trace(0, r.polyline.length - 100, START)) {
    const s = session.ingest(sample);
    announcer.consider(s, all, { zoneID: plan.timeZoneIDAt(s.progress) });
  }
  // I-24 west of Chattanooga moves from Eastern to Central time.
  const zone = spoken.filter((t) => t.startsWith('Now on Central Time.'));
  assert.equal(zone.length, 1, spoken.join(' | '));
  assert.match(zone[0], /Clocks go back one hour\./);
  // Every rest area on the route is announced once, ahead of it.
  const rest = spoken.filter((t) => /^(Rest Area|Welcome Center|Service Plaza|Parking Area) in /.test(t));
  assert.equal(rest.length, plan.restAreas.length, spoken.join(' | '));
  assert.ok(rest.every((t) => /in [23] miles/.test(t)), rest.join(' | '));

  // Gas gap: spoken once when the last gas is within about 6 miles.
  const exit = plan.exits.find((e) => e.distanceAlongRoute > 30 * MILE);
  const gap = { length: 62 * MILE, before: { distance: exit.distanceAlongRoute, exit } };
  const fake = (progress) => ({ match: { status: 'onRoute' }, current: null, next: null, progress, t: START, drivenTotal: progress,
    distanceToNextBorder: null, nextRestArea: null, nextExit: null });
  const said = [];
  const a2 = new Announcer((t) => said.push(t));
  a2.consider(fake(exit.distanceAlongRoute - 10 * MILE), all, { gasGap: gap });
  a2.consider(fake(exit.distanceAlongRoute - 5 * MILE), all, { gasGap: gap });
  a2.consider(fake(exit.distanceAlongRoute - 4 * MILE), all, { gasGap: gap });
  assert.deepEqual(said, [`Last gas for 62 miles is Exit ${exit.label}, in 5 miles.`]);
  a2.consider(fake(exit.distanceAlongRoute - 3 * MILE), { ...all, announceGasGaps: false }, { gasGap: { ...gap, before: { ...gap.before, exit: { ...exit, id: 'other' } } } });
  assert.equal(said.length, 1);
});
