// Discover ahead on a real route, and the Road Trip Passport from trip history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { DISCOVER_CATEGORIES } from '../js/engine/discover.js';
import { passport, STATE_CODES } from '../js/engine/passport.js';

test('the Discover dataset is CC0 Wikidata with known categories and scores', () => {
  const d = data.discover;
  assert.equal(d.metadata.license, 'CC0-1.0');
  assert.ok(d.items.length > 300);
  for (const i of d.items) {
    assert.ok(DISCOVER_CATEGORIES[i.cat], i.cat);
    assert.match(i.id, /^Q\d+$/);
    assert.ok(i.score >= d.metadata.min_score);
    assert.ok(!/\b(planned|former|demolished|submerged|closed)\b/i.test(i.desc ?? ''), i.desc);
  }
});

test('places near Miami to Manhattan come in route order, near the route, with a nearby exit', () => {
  const plan = new TripPlan(route('miami_to_manhattan'),
    { states: data.states, timeZones: null, interstates: data.interstates, discover: data.discover });
  const list = plan.discover;
  // Same count as DiscoverPassportTests.swift: the two engines must agree.
  assert.equal(list.length, 173, list.map((x) => x.item.name).join(', '));
  for (let i = 1; i < list.length; i++) assert.ok(list[i].distanceAlongRoute >= list[i - 1].distanceAlongRoute);
  for (const x of list) assert.ok(x.offMeters <= DISCOVER_CATEGORIES[x.item.cat].near + 1, x.item.name);
  assert.ok(list.some((x) => x.exit), 'some places have an exit within 5 km along the route');
});

test('the passport counts states and miles from trips and earns achievements', () => {
  const trips = [
    { title: 'A', startedAt: 100, totalMeters: 620 * MILE,
      states: [{ code: 'FL', name: 'Florida', meters: 374 * MILE }, { code: 'GA', name: 'Georgia', meters: 112 * MILE },
        { code: 'SC', name: 'South Carolina', meters: 134 * MILE }] },
    { title: 'B', startedAt: 200, totalMeters: 60 * MILE,
      states: [{ code: 'GA', name: 'Georgia', meters: 60 * MILE }, { code: null, name: 'Outside', meters: 1 }] },
  ];
  const p = passport(trips);
  assert.equal(p.states.size, 3);
  assert.equal(p.states.get('GA').trips, 2);
  assert.equal(p.states.get('GA').firstAt, 100);
  assert.equal(p.states.get('GA').lastAt, 200);
  assert.ok(Math.abs(p.states.get('GA').meters - 172 * MILE) < 1);
  const a = Object.fromEntries(p.achievements.map((x) => [x.id, x]));
  assert.equal(a['first-trip'].earned, true);
  assert.equal(a['long-haul'].earned, true);
  assert.equal(a['states-5'].earned, false);
  assert.ok(Math.abs(a['states-5'].progress - 0.6) < 1e-9);
  assert.equal(a['coast-to-coast'].progress, 0.5);
  assert.equal(passport([]).achievements.every((x) => !x.earned), true);
  assert.equal(STATE_CODES.length, 51);
});
