// The next maneuver for the guidance banner, on the shared fixtures (the same cases as GuidanceTests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nextManeuver, parseInstruction } from '../js/engine/guidance.js';
import { PlannedRoute, makeStep } from '../js/engine/route.js';
import { TripPlan } from '../js/engine/trip.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { route, data } from './support.js';

const fixture = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../Tests/ExitAtlasCoreTests/Fixtures/guidance/next_maneuver.json'), 'utf8'));

test('the next maneuver on the real Miami to Manhattan route', () => {
  const r = route(fixture.route);
  const plan = new TripPlan(r, { states: data.states, timeZones: data.timeZones, interstates: data.interstates, restAreas: data.restAreas });
  for (const c of fixture.cases) {
    const x = nextManeuver(r, c.atMiles * MILE, { destinationName: fixture.destination, exits: plan.exits,
      within: c.withinMiles != null ? c.withinMiles * MILE : Infinity });
    if (c.expect === null) { assert.equal(x, null, `mile ${c.atMiles}: nothing within ${c.withinMiles} mi`); continue; }
    assert.ok(x, `mile ${c.atMiles}: a maneuver`);
    assert.ok(Math.abs(x.distance / MILE - c.expect.miles) <= 0.06, `mile ${c.atMiles}: ${x.distance / MILE} mi`);
    for (const k of ['kind', 'side', 'road', 'exitLabel', 'text']) assert.equal(x[k], c.expect[k], `mile ${c.atMiles}: ${k}`);
  }
});

test('MapKit sentences are shown as given', () => {
  const s = fixture.sentences;
  const r = new PlannedRoute({ source: 'appleMapKit', polyline: route(fixture.route).polyline,
    steps: s.steps.map(([start, length, instruction, road]) => makeStep(start, length, instruction, road)), timeProfile: null });
  for (const c of s.cases) {
    const x = nextManeuver(r, c.atMeters);
    for (const k of ['kind', 'side', 'text']) assert.equal(x[k], c.expect[k], `${c.atMeters} m: ${k}`);
  }
  assert.deepEqual(parseInstruction('off ramp slight right'), { type: 'off ramp', modifier: 'slight right' });
  assert.equal(parseInstruction('Take exit 51'), null);
});
