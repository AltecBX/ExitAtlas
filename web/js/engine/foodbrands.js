// Chain restaurants near exits that the exit data misses, from the chains' own store locators as collected by
// All the Places (CC0): foodbrands.json, built by tools/data-pipeline/build_food_brands.py. OpenInterstate keeps
// the 12 nearest food places within 1,600 m of an exit, and OpenStreetMap does not map every restaurant, so a busy
// exit could list a Taco Bell and miss the Chick-fil-A and Wendy's next to it. A store list is what the chain
// publishes, not a visit: the place is labeled as coming from it, with a straight line round trip estimate.
import { PlaceCategory } from './datasets.js';

/// Round trips without drive data: twice the straight line distance, times 1.4 for roads (as servicesForExit).
const ROAD_FACTOR = 1.4;

export class FoodBrands {
  constructor(json) {
    if (json?.kind !== 'foodbrands' || json.schema !== 1) throw new Error('not a foodbrands file');
    this.meta = json.meta ?? {};
    this.brands = json.brands;
    this.places = json.places;
    this.exits = json.exits;
  }

  /// The added restaurants at one exit record (an OpenStreetMap exit node), as services like servicesForExit's.
  servicesFor(record, exitID) {
    const flat = this.exits[String(record.osmNodeID)];
    if (!flat) return [];
    const out = [];
    for (let k = 0; k + 1 < flat.length; k += 2) {
      const i = flat[k], meters = flat[k + 1];
      const p = this.places[i];
      if (!p) continue;
      const brand = this.brands[p[0]] ?? '';
      out.push({
        place: { id: `storelist:food:${i}`, coordinate: { lat: p[1], lon: p[2] }, name: brand, brand, category: PlaceCategory.food, source: 'storeList' },
        exitID, straightLineMeters: meters, detourMeters: 2 * ROAD_FACTOR * meters, detourSeconds: null,
        detourBasis: 'estimate', reachable: null, rank: null,
      });
    }
    return out;
  }
}

/// An exit's services with the store list restaurants added, each place once (its shortest round trip), sorted by
/// category, then round trip, like servicesForExit.
export function withFoodBrands(services, foodBrands, exit) {
  if (!foodBrands) return services;
  const extra = new Map();
  for (const record of exit.records ?? []) {
    for (const s of foodBrands.servicesFor(record, exit.id)) {
      const had = extra.get(s.place.id);
      if (!had || s.detourMeters < had.detourMeters) extra.set(s.place.id, s);
    }
  }
  if (!extra.size) return services;
  return [...services, ...extra.values()].sort((a, b) => (a.place.category !== b.place.category
    ? a.place.category - b.place.category
    : a.detourMeters - b.detourMeters));
}
