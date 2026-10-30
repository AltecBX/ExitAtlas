// Voice announcements across a reroute: real route geometry, simulated GPS, the trip session and a
// captured speaker in place of speech synthesis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route, START } from './support.js';
import { TripPlan, TripSession } from '../js/engine/trip.js';
import { PlannedRoute, TravelTimeProfile } from '../js/engine/route.js';
import { GPSSimulator } from '../js/engine/discovery.js';
import { Announcer } from '../js/app/announcer.js';
import { offset } from '../js/engine/geo.js';

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

  // Overnight: the last stop listed open before a long stretch, once per stop, and not again for the
  // exit whose last gas was just announced.
  const lastOpen = (ahead, id = 'shell', exitId = 'x9') => ({ stop: { id, name: 'Shell', exitId, exit: { id: exitId, label: '94' }, ahead },
    length: 74 * MILE, unlisted: 3, openEnded: false });
  const heard = [];
  const a3 = new Announcer((t) => heard.push(t));
  a3.consider(fake(100 * MILE), all, { lastOpen: lastOpen(9 * MILE) });
  a3.consider(fake(100 * MILE), all, { lastOpen: lastOpen(5 * MILE) });
  a3.consider(fake(100 * MILE), all, { lastOpen: lastOpen(4 * MILE) });
  assert.deepEqual(heard, ['Overnight, Shell at Exit 94 in 5 miles is the last stop listed open for 74 miles.']);
  a3.consider(fake(100 * MILE), { ...all, announceGasGaps: false }, { lastOpen: lastOpen(4 * MILE, 'other') });
  a3.consider(fake(100 * MILE), all, { lastOpen: lastOpen(4 * MILE, 'third', 'g1'), gasGap: { length: 50 * MILE, before: { distance: 0, exit: { id: 'g1', label: '7' } } } });
  assert.equal(heard.length, 1, heard.join(' | '));
  // Google Maps hours are never spoken (Google's terms forbid text to speech of its content).
  a3.consider(fake(100 * MILE), all, { lastOpen: { ...lastOpen(4 * MILE, 'google'), evaluation: { hours: { status: 'verified', source: 'Google Maps' } } } });
  assert.equal(heard.length, 1, heard.join(' | '));

  // Road alerts (same cases as VoiceAnnouncements in RoadIntelTests.swift): serious from 10 miles, others from
  // 2, once each, never within 0.3 mile, and not at all when alert voice is off. Simulated test alerts.
  const alert = (id, category, startMiles, serious, extra = {}) => ({ incident: { id, category, description: 'Severe Thunderstorm Warning', lanes: null, verification: 'official', ...extra }, start: startMiles * MILE, serious });
  const crash = alert('c1', 'crash', 109, true, { lanes: 'Right lane blocked' });
  const police = alert('p1', 'police', 102, false, { verification: 'community' });
  const said2 = [];
  const a4 = new Announcer((t) => said2.push(t));
  for (const at of [97, 99.1, 99.5]) a4.consider(fake(at * MILE), all, { alerts: [crash] });
  assert.deepEqual(said2, ['Crash ahead, in 10 miles. Right lane blocked.']);
  a4.consider(fake(99.5 * MILE), all, { alerts: [police] });
  a4.consider(fake(100.2 * MILE), all, { alerts: [police] });
  assert.equal(said2[1], 'Police reported ahead, in 2 miles. Reported by drivers, not confirmed.');
  a4.consider(fake(101.8 * MILE), all, { alerts: [alert('p2', 'police', 102, false)] });
  a4.consider(fake(100 * MILE), { ...all, alerts: { voice: false } }, { alerts: [alert('w1', 'weather', 101, true)] });
  assert.equal(said2.length, 2, said2.join(' | '));
  a4.consider(fake(100 * MILE), all, { alerts: [alert('w1', 'weather', 101, true)] });
  assert.equal(said2[2], 'Severe Thunderstorm Warning on your route, in 1 mile.');
});

test('a road alert is spoken once even when a later answer gives the same event a new id', () => {
  const fake = (progress) => ({ match: { status: 'onRoute' }, current: null, next: null, progress, t: START, drivenTotal: progress,
    distanceToNextBorder: null, nextRestArea: null, nextExit: null });
  const alert = (id, category, startMiles, extra = {}) => ({ incident: { id, category, description: 'Work zone', lanes: null, verification: 'official', ...extra },
    start: startMiles * MILE, serious: false, notable: true });
  const said = [];
  const a = new Announcer((t) => said.push(t));
  a.consider(fake(48 * MILE), settings, { alerts: [alert('wz:1', 'construction', 50, { lanes: 'Right lane closed' })] });
  assert.deepEqual(said, ['Work zone ahead, in 2 miles. Right lane closed.']);
  // The feed updated the entry (or the other feed's copy is kept now): new id, same place. Not again.
  a.consider(fake(48.9 * MILE), settings, { alerts: [alert('wz:1b', 'construction', 50.1, { lanes: 'Right lane closed' })] });
  // A different kind at the same place, and the same kind well past it, are new events.
  a.consider(fake(49 * MILE), settings, { alerts: [alert('c:1', 'crash', 50.2)] });
  a.consider(fake(58 * MILE), settings, { alerts: [alert('wz:2', 'construction', 60)] });
  assert.deepEqual(said.slice(1), ['Crash ahead, in 1 mile.', 'Work zone ahead, in 2 miles.'], said.join(' | '));
});

test('the demo alert is spoken as a simulated test alert, never as a real event', async () => {
  const { alertWords } = await import('../js/app/announcer.js');
  const a = { incident: { id: 'demo:crash', category: 'crash', description: 'Crash (SIMULATED TEST ALERT)', lanes: 'Right lane blocked', verification: 'simulated' }, start: 6 * MILE };
  assert.equal(alertWords(a, 6 * MILE), 'Crash ahead, in 6 miles. Right lane blocked. Simulated test alert.');
});

test('the voice switch: on says so (Safari lets speech play after a tap), off stops what is queued', () => {
  const said = [];
  let cancelled = 0;
  const a = new Announcer((t) => said.push(t), { cancel: () => { cancelled += 1; } });
  a.voiceSwitched(true);
  assert.deepEqual(said, ['Voice on.']);
  a.voiceSwitched(false);
  assert.equal(cancelled, 1);
  assert.equal(said.length, 1, 'nothing said when switched off');
});

test('a state line warning is not repeated after a detour off the route and back', () => {
  // Found on a simulated Yonkers to Orlando drive: dinner 4 miles off I-95 just after the Georgia line warning
  // added 8 miles to the odometer, and the warning was given again on the way back.
  const ds = { states: data.states, timeZones: null, interstates: data.interstates };
  const r = route('atlanta_to_nashville');
  const session = new TripSession(new TripPlan(r, ds), data.states, START);
  const spoken = [];
  const announcer = new Announcer((text) => spoken.push(text));
  const border = session.plan.states.segments[1].startDistance;
  const name = session.plan.states.segments[1].displayName;
  const warnings = () => spoken.filter((t) => t.startsWith(`${name} state line in`));
  let last = null;
  for (const { sample } of new GPSSimulator(r).trace(0, border - 4 * MILE, START)) {
    announcer.consider(session.ingest(sample), settings);
    last = sample;
  }
  assert.equal(warnings().length, 1, spoken.join(' | '));
  // Out 6.4 km to the side and back at 15 m/s.
  const d = border - 4 * MILE, bearing = r.polyline.bearingAt(d);
  let t = last.t + 1;
  for (const [from, to, course] of [[0, 6400, bearing + 90], [6400, 0, bearing - 90]]) {
    for (let x = from; from < to ? x <= to : x >= to; x += from < to ? 15 : -15, t += 1) {
      const coordinate = offset(r.polyline.coordinateAt(d), bearing + 90, x);
      announcer.consider(session.ingest({ coordinate, accuracy: 8, course: (course + 360) % 360, speed: 15, t }), settings);
    }
  }
  assert.ok(session.ledger.totalMeters > d + 12000, 'the detour counts as driven');
  for (const { sample } of new GPSSimulator(r).trace(d + 30, border + 2 * MILE, t)) announcer.consider(session.ingest(sample), settings);
  assert.equal(warnings().length, 1, spoken.join(' | '));
  assert.ok(spoken.some((x) => x.startsWith(`Welcome to ${name}.`)), spoken.join(' | '));
});
