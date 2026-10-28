// Fuel and charging stop planning from the car's own range reading.
//
// The driver enters the range the dashboard shows (or a fill up or charge resets it). Range left
// counts down with miles actually driven (the trip ledger, which includes off route driving). The
// planner picks the last stop reached with about the chosen buffer still left, preferring the
// driver's favorite gas brands anywhere in range.
import { METERS_PER_MILE as MILE } from './geo.js';
import { simplified } from './exits.js';

export const GAS = 1;

/// fuel: {rangeMeters, drivenAtEntry} where drivenAtEntry is the driven total when it was entered.
export function rangeLeft(fuel, drivenTotal) {
  if (!fuel) return null;
  return Math.max(0, fuel.rangeMeters - Math.max(0, drivenTotal - fuel.drivenAtEntry));
}

/// Full tank (or full charge) range in meters, or null when unknown.
export function fullTankRange(vehicle) {
  if (vehicle?.ev) return vehicle.rangeMiles > 0 ? vehicle.rangeMiles * MILE : null;
  if (!vehicle?.tankGallons || !vehicle?.mpg) return null;
  return vehicle.tankGallons * vehicle.mpg * MILE;
}

/// True when a station name or brand matches one of the favorites ("Shell", "Costco", "Casey's").
export function matchesFavorite(nameOrBrand, favorites) {
  const n = simplified(nameOrBrand || '');
  return n !== '' && favorites.some((f) => {
    const s = simplified(f);
    return s !== '' && (n.includes(s) || s.includes(n));
  });
}

/// Gas candidates: route exits with gas stations, from the offline exit services.
export function gasCandidates(plan, d, range, servicesFor, favorites = []) {
  const out = [];
  for (const exit of plan.exitsBetween(d, d + range)) {
    const gas = servicesFor(exit).filter((s) => s.place.category === GAS);
    if (!gas.length) continue;
    out.push({
      kind: 'gas', key: exit.id, exit, along: exit.distanceAlongRoute,
      detourMeters: Math.min(...gas.map((s) => s.detourMeters)), gas,
      favorite: favorites.length > 0 && gas.some((s) => matchesFavorite(s.place.brand || s.place.name, favorites)),
    });
  }
  return out;
}

/// Places chargers (from the AFDC station list) on the route: distance along it and straight line offset.
/// stations: [{id, name, lat, lon, ...}]. Stations farther than maxOffset from the route are dropped.
export function projectChargers(polyline, stations, maxOffset = 4500) {
  const out = [];
  for (const st of stations) {
    const p = polyline.nearestProjection({ lat: st.lat, lon: st.lon }, maxOffset);
    if (p) out.push({ ...st, along: p.distanceAlong, offset: p.offset });
  }
  return out.sort((a, b) => a.along - b.along);
}

/// Charging candidates ahead. The detour is estimated from the straight line offset (times 1.3, both ways).
export function chargerCandidates(projected, d, range) {
  return projected.filter((c) => c.along > d && c.along <= d + range).map((c) => ({
    kind: 'charge', key: `charger-${c.id}`, charger: c, along: c.along, detourMeters: 2 * 1.3 * c.offset, favorite: false,
  }));
}

/// Plans where to stop.
///   candidates: from gasCandidates or chargerCandidates, in route order.
///   options: {bufferMeters, hasDestination, favorites}
/// Returns {status, range, buffer, recommended, earlier, lastChance, stations, destinationSpare,
///          favoriteMissing, nextFavorite, closestToTarget}
///   status: 'destination' (enough to arrive with the buffer), 'planned', 'low' (no stop keeps the buffer),
///           'none' (nothing listed before empty).
export function planStop(plan, snapshot, range, candidates, { bufferMeters = 50 * MILE, hasDestination = true, favorites = [] } = {}) {
  const d = snapshot.progress;
  const remaining = plan.route.length - d;
  const stations = [];
  for (const c of candidates) {
    const ahead = c.along - d;
    if (ahead <= 0) continue;
    const rangeOnArrival = range - ahead - c.detourMeters / 2;
    if (rangeOnArrival < 0) continue;
    stations.push({ ...c, ahead, rangeOnArrival, preferred: c.favorite, eta: snapshot.etaTo(c.along) });
  }
  const result = {
    status: 'none', range, buffer: bufferMeters, recommended: null, earlier: [], lastChance: null, stations,
    destinationSpare: null, favoriteMissing: false, nextFavorite: null, closestToTarget: null,
  };
  if (hasDestination && range - remaining >= bufferMeters) {
    result.status = 'destination';
    result.destinationSpare = range - remaining;
    return result;
  }
  const keeps = stations.filter((s) => s.rangeOnArrival >= bufferMeters);
  if (keeps.length) {
    const latest = keeps[keeps.length - 1];
    let pick = latest;
    if (favorites.length) {
      const fav = keeps.filter((s) => s.favorite);
      if (fav.length) {
        pick = fav[fav.length - 1];
        if (pick !== latest) result.closestToTarget = latest;
      } else {
        result.favoriteMissing = true;
        result.nextFavorite = stations.find((s) => s.favorite) ?? null;
      }
    }
    result.status = 'planned';
    result.recommended = pick;
    const i = stations.indexOf(pick);
    result.earlier = stations.slice(Math.max(0, i - 2), i).reverse();
    const last = stations[stations.length - 1];
    if (last !== pick && last.rangeOnArrival < bufferMeters) result.lastChance = last;
  } else if (stations.length) {
    result.status = 'low';
    result.recommended = (favorites.length && stations.find((s) => s.favorite)) || stations[0];
    result.lastChance = stations.length > 1 ? stations[stations.length - 1] : null;
  }
  return result;
}

/// Gas stop plan from exit services (kept for callers that do not build candidates themselves).
export function planFuelStop(plan, snapshot, range, { bufferMeters = 50 * MILE, servicesFor, favorites = [], preferredBrands = [], hasDestination = true } = {}) {
  const favs = favorites.length ? favorites : preferredBrands;
  const candidates = gasCandidates(plan, snapshot.progress, range, servicesFor, favs);
  return planStop(plan, snapshot, range, candidates, { bufferMeters, hasDestination, favorites: favs });
}
