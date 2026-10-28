// Discover ahead on a real route, and travel statistics from trip history.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { data, route } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { TripPlan } from '../js/engine/trip.js';
import { DISCOVER_CATEGORIES } from '../js/engine/discover.js';
import { travelStats } from '../js/engine/travels.js';

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

test('travel statistics: miles and trips per state from real trips, no achievements', () => {
  const trips = [
    { title: 'A', startedAt: 100, totalMeters: 620 * MILE,
      states: [{ code: 'FL', name: 'Florida', meters: 374 * MILE }, { code: 'GA', name: 'Georgia', meters: 112 * MILE },
        { code: 'SC', name: 'South Carolina', meters: 134 * MILE }] },
    { title: 'B', startedAt: 200, totalMeters: 60 * MILE,
      states: [{ code: 'GA', name: 'Georgia', meters: 60 * MILE }, { code: null, name: 'Outside', meters: 1 }] },
  ];
  const t = travelStats(trips);
  assert.deepEqual(t.states.map((x) => x.code), ['FL', 'GA', 'SC'], 'most miles first');
  const ga = t.states.find((x) => x.code === 'GA');
  assert.equal(ga.trips, 2);
  assert.equal(ga.firstAt, 100);
  assert.equal(ga.lastAt, 200);
  assert.ok(Math.abs(ga.meters - 172 * MILE) < 1);
  assert.equal(t.tripCount, 2);
  assert.ok(Math.abs(t.totalMeters - 680 * MILE) < 1);
  assert.equal('achievements' in t, false);
  assert.deepEqual(travelStats([]), { states: [], totalMeters: 0, tripCount: 0 });
});

test('R. the games and achievements are gone from the website; trip history is kept and still shown', () => {
  const read = (f) => readFileSync(new URL(`../js/app/${f}`, import.meta.url), 'utf8');
  const ui = ['main.js', 'views.js', 'sharecard.js'].map(read).join('\n');
  for (const gone of [/Passport/, /achievement/i, /License plates/, /data-act="plate/, /'plates-reset'/, /share-passport/, /drawPassportCard/]) {
    assert.doesNotMatch(ui, gone, `${gone} is no longer in the app`);
  }
  // History stays where it was saved and feeds the travel statistics and past trips.
  assert.match(read('main.js'), /history: store\.get\('ea\.history', \[\]\)/);
  assert.match(read('views.js'), /travelStats\(app\.history\)/);
  assert.match(read('views.js'), /Past trips/);
});
