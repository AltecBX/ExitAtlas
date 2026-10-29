// SmartStop candidates from the trip: gas stations at exits (with what OpenStreetMap says about them
// today, from stations.json), service plazas with fuel and rest areas on the highway, and Google's live
// hours and restroom field where prices were already looked up. The ranking is in engine/smartstop.js.
import { METERS_PER_MILE as MILE, distance } from '../engine/geo.js';
import { gasCandidates, matchesFavorite } from '../engine/fuel.js';
import { placeDisplayName } from '../engine/datasets.js';
import { restAreaTitle } from '../engine/restareas.js';

/// stations.json: {meta, items: {placeId: {h, hc, t, b, gone, ah, at, ab}}} (build_stations.py).
export class StationFacts {
  constructor(json) {
    if (json?.meta?.kind !== 'stations') throw new Error('not a station dataset');
    this.metadata = json.meta;
    this.items = json.items ?? {};
  }

  get(id) { return this.items[id] ?? null; }
}

/// Google's record for an OpenStreetMap station near an exit: within 50 m, or within 150 m with a
/// matching name or brand. Null when prices were not looked up there or nothing matches.
export function liveFor(prices, exit, place, brand) {
  const c = prices?.peek(exit.id);
  if (!c || c.error) return null;
  let best = null, bestD = Infinity;
  for (const g of c.stations) {
    if (!g.location) continue;
    const d = distance(place.coordinate, { lat: g.location.latitude, lon: g.location.longitude });
    const named = [brand, place.name].some((n) => n && matchesFavorite(g.name, [n]));
    if ((d <= 50 || (d <= 150 && named)) && d < bestD) { best = g; bestD = d; }
  }
  return best;
}

/// What OpenStreetMap and the brand's own listing (All the Places) say about a station.
function osmFacts(stations, id) {
  const f = stations?.get(id);
  return f ? { hours: f.h ?? null, checked: f.hc ?? null, toilets: f.t ?? null, gone: f.gone ?? null,
    brandHours: f.ah ?? null, brandToilets: f.at ?? null, listedBy: f.ab ?? null,
    collected: f.ah || f.at ? stations.metadata.brand_collected ?? null : null } : {};
}

/// Gas stations at exits from `d` to `d + window`, one candidate per station.
///   rangeLeft: meters of range now (null when unknown), gradeKey: Google fuel type for prices
export function stationCandidates({ plan, snapshot, servicesFor, stations, prices }, d, window, { rangeLeft = null, gradeKey = null } = {}) {
  const out = [];
  for (const x of gasCandidates(plan, d, window, servicesFor)) {
    const ahead = x.along - d;
    const zone = plan.timeZoneIDAt(x.along) ?? 'America/New_York';
    const eta = snapshot.etaTo(x.along);
    for (const g of x.gas) {
      const facts = osmFacts(stations, g.place.id);
      const brand = stations?.get(g.place.id)?.b ?? g.place.brand;
      const live = liveFor(prices, x.exit, g.place, brand);
      const price = gradeKey && live?.prices?.[gradeKey] ? { value: live.prices[gradeKey].value, updated: live.prices[gradeKey].updated } : null;
      out.push({
        id: g.place.id, name: placeDisplayName(g.place), brand, kind: 'station', exitId: x.exit.id, exit: x.exit,
        along: x.along, ahead, arrival: eta + (g.detourSeconds ?? 0) / 2, timeZone: zone,
        detourMinutes: g.detourBasis === 'routed' && g.detourSeconds != null ? g.detourSeconds / 60 : null,
        detourMeters: g.detourMeters,
        rangeOnArrival: rangeLeft != null ? rangeLeft - ahead - g.detourMeters / 2 : null,
        price, osm: facts,
        live: live ? { periods: live.periods ?? null, restroom: live.restroom ?? null, source: 'Google Maps' } : null,
      });
    }
  }
  return onePerStation(out);
}

/// A station linked to two exits (a split interchange, or the next exit) is one stop: the exit with the
/// shorter detour, or the first one when they are equal. Same rule in SmartStopCandidates.swift.
function onePerStation(list) {
  const best = new Map();
  for (const c of list) {
    const b = best.get(c.id);
    if (!b || c.detourMeters < b.detourMeters) best.set(c.id, c);
  }
  return list.filter((c) => best.get(c.id) === c);
}

/// Service plazas with fuel (fuel stops) or every rest area and plaza (restroom stops) on the route.
export function plazaCandidates({ plan, snapshot }, d, window, { rangeLeft = null, withFuelOnly = true } = {}) {
  const out = [];
  for (const r of plan.restAreasBetween(d, d + window)) {
    const fuel = r.kind === 'plaza' && r.gas.length > 0;
    if (withFuelOnly ? !fuel : !(r.kind === 'rest' || r.kind === 'welcome' || r.kind === 'plaza')) continue;
    const ahead = r.distanceAlongRoute - d;
    out.push({
      id: r.id, name: restAreaTitle(r), brand: r.gas[0] ?? '', otherNames: r.gas, kind: fuel ? 'plaza' : 'rest', restArea: r,
      along: r.distanceAlongRoute, ahead, arrival: snapshot.etaTo(r.distanceAlongRoute),
      timeZone: plan.timeZoneIDAt(r.distanceAlongRoute) ?? 'America/New_York', detourMinutes: null, detourMeters: 0,
      rangeOnArrival: rangeLeft != null ? rangeLeft - ahead : null, price: null, osm: {},
      plaza: { hours: r.hours ?? null, toilets: r.amenities.toilets ?? null, truckSpaces: r.fhwaTruckSpaces ?? null },
    });
  }
  return out;
}

/// Fuel stop candidates: stations and fuel plazas a little past the range, so a favorite just out of
/// reach can be explained rather than silently missing.
export function fuelCandidates(ctx, rangeLeft, gradeKey) {
  const d = ctx.snapshot.progress;
  const window = rangeLeft + 50 * MILE;
  return [...stationCandidates(ctx, d, window, { rangeLeft, gradeKey }), ...plazaCandidates(ctx, d, window, { rangeLeft })]
    .sort((a, b) => a.along - b.along);
}

/// Stops in the next `miles`: stations and fuel plazas, plus rest areas when the stop is for a restroom.
export function aheadCandidates(ctx, miles, { rangeLeft = null, gradeKey = null, restrooms = false } = {}) {
  const d = ctx.snapshot.progress;
  const window = miles * MILE;
  const list = [...stationCandidates(ctx, d, window, { rangeLeft, gradeKey }), ...plazaCandidates(ctx, d, window, { rangeLeft })];
  if (restrooms) list.push(...plazaCandidates(ctx, d, window, { rangeLeft, withFuelOnly: false }).filter((c) => c.kind === 'rest'));
  return list.sort((a, b) => a.along - b.along);
}
