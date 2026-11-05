// Chain restaurants from the chains' store lists (foodbrands.json, tools/data-pipeline/build_food_brands.py): only
// near exits, never a second copy of a place the exit data already lists, never from a list collected against the
// chain's robots.txt, and on I-95 (Yonkers to Orlando) many more exits with a Taco Bell or a Popeyes than
// OpenInterstate alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { data, route } from './support.js';
import { distance } from '../js/engine/geo.js';
import { servicesForExit, simplified } from '../js/engine/exits.js';
import { withFoodBrands } from '../js/engine/foodbrands.js';
import { TripPlan } from '../js/engine/trip.js';

const sameChain = (a, b) => {
  const x = simplified(a ?? ''), y = simplified(b ?? '');
  return Boolean(x && y) && (x.startsWith(y) || y.startsWith(x));
};

test('foodbrands.json: CC0 store lists, near exits that exist, within 1,600 m', () => {
  const fb = data.foodBrands;
  assert.equal(fb.meta.license, 'CC0-1.0');
  assert.match(fb.meta.source, /All the Places/);
  assert.match(fb.meta.collected, /^\d{4}-\d\d-\d\d$/);
  // Lists collected against the chain's robots.txt are left out, and none of their chains appear.
  assert.ok(fb.meta.skipped_robots_txt.includes('chick_fil_a'), fb.meta.skipped_robots_txt.join());
  for (const b of ['Chick-fil-A', 'Burger King', 'Panda Express', 'Steak n Shake', 'Bob Evans']) assert.ok(!fb.brands.some((x) => sameChain(x, b)), b);
  const nodes = new Set([...data.interstates.exits, ...data.freeways.exits].map((e) => String(e.osmNodeID)));
  const keys = Object.keys(fb.exits);
  assert.ok(keys.length > 10000, `${keys.length} exits`);
  for (const k of keys) {
    assert.ok(nodes.has(k), `exit ${k} is in the exit data`);
    const flat = fb.exits[k];
    assert.equal(flat.length % 2, 0);
    for (let i = 0; i < flat.length; i += 2) {
      assert.ok(fb.places[flat[i]], `place ${flat[i]}`);
      assert.ok(flat[i + 1] >= 0 && flat[i + 1] <= 1600, `${flat[i + 1]} m`);
    }
  }
});

test('added restaurants are labeled store list estimates and never repeat a chain the exit lists within 400 m', () => {
  const plan = new TripPlan(route('yonkers_to_orlando'), { states: data.states, timeZones: data.timeZones, interstates: data.exits });
  let before = { taco: 0, popeyes: 0 }, after = { taco: 0, popeyes: 0 }, added = 0;
  for (const exit of plan.exits) {
    const osm = servicesForExit(data.exits, exit);
    const all = withFoodBrands(osm, data.foodBrands, exit);
    const extra = all.filter((x) => x.place.source === 'storeList');
    added += extra.length;
    const has = (list, brand) => list.some((x) => x.place.category === 2 && sameChain(x.place.brand || x.place.name, brand));
    if (has(osm, 'Taco Bell')) before.taco++;
    if (has(all, 'Taco Bell')) after.taco++;
    if (has(osm, 'Popeyes')) before.popeyes++;
    if (has(all, 'Popeyes')) after.popeyes++;
    for (const x of extra) {
      assert.equal(x.place.category, 2);
      assert.equal(x.detourBasis, 'estimate');
      assert.equal(x.detourSeconds, null);
      const dup = osm.find((o) => o.place.category === 2 && sameChain(o.place.brand || o.place.name, x.place.brand)
        && distance(o.place.coordinate, x.place.coordinate) <= 400);
      assert.equal(dup, undefined, `${x.place.brand} at ${exit.label} is already listed`);
    }
    // Sorted by category, then round trip, and each place once.
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].place.category < all[i].place.category
        || (all[i - 1].place.category === all[i].place.category && all[i - 1].detourMeters <= all[i].detourMeters));
    }
    assert.equal(new Set(all.map((x) => x.place.id)).size, all.length);
  }
  assert.ok(added > 200, `${added} restaurants added on the route`);
  assert.ok(after.taco >= before.taco * 1.5, `Taco Bell exits ${before.taco} then ${after.taco}`);
  assert.ok(after.popeyes > before.popeyes, `Popeyes exits ${before.popeyes} then ${after.popeyes}`);
});
