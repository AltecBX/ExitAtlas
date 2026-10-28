// Fuel stop planning from the car's own "miles to empty" reading.
//
// The driver enters the range their dashboard shows (or a fill up resets it). Range left counts
// down with miles actually driven (the trip ledger, which includes off route driving). The planner
// picks the last exit with gas that is reached with about the chosen buffer still in the tank.
import { METERS_PER_MILE as MILE } from './geo.js';

export const GAS = 1;

/// fuel: {rangeMeters, drivenAtEntry} where drivenAtEntry is the driven total when it was entered.
export function rangeLeft(fuel, drivenTotal) {
  if (!fuel) return null;
  return Math.max(0, fuel.rangeMeters - Math.max(0, drivenTotal - fuel.drivenAtEntry));
}

/// Full tank range in meters, or null when the tank size is unknown.
export function fullTankRange(vehicle) {
  if (!vehicle?.tankGallons || !vehicle?.mpg) return null;
  return vehicle.tankGallons * vehicle.mpg * MILE;
}

/// Plans where to fill up.
///   plan, snapshot: from the trip engine.
///   range: meters of range left now.
///   options: {bufferMeters, servicesFor(exit), preferredBrands: ['wawa', ...], hasDestination}
/// Returns {status, range, buffer, recommended, earlier, lastChance, stations, emptyAhead, destinationSpare}
///   status: 'destination' (enough to arrive with the buffer), 'planned', 'low' (no exit keeps the buffer),
///           'none' (no listed interstate gas before empty).
export function planFuelStop(plan, snapshot, range, { bufferMeters = 50 * MILE, servicesFor, preferredBrands = [], hasDestination = true } = {}) {
  const d = snapshot.progress;
  const remaining = plan.route.length - d;
  const pace = snapshot.paceFactor ?? 1;
  const brands = preferredBrands.map((b) => b.toLowerCase()).filter(Boolean);
  const stations = [];
  for (const exit of plan.exitsBetween(d, d + range)) {
    const gas = servicesFor(exit).filter((s) => s.place.category === GAS);
    if (!gas.length) continue;
    const ahead = exit.distanceAlongRoute - d;
    const detour = Math.min(...gas.map((s) => s.detourMeters));
    const rangeOnArrival = range - ahead - detour / 2;
    if (rangeOnArrival < 0) continue;
    const names = gas.map((s) => (s.place.brand || s.place.name || '').toLowerCase());
    stations.push({
      exit, ahead, detourMeters: detour, rangeOnArrival, gas,
      preferred: brands.length > 0 && names.some((n) => brands.some((b) => n.includes(b))),
      eta: snapshot.t + plan.route.timeProfile.secondsBetween(d, exit.distanceAlongRoute) * pace,
    });
  }
  const result = {
    status: 'none', range, buffer: bufferMeters, recommended: null, earlier: [], lastChance: null, stations,
    emptyAhead: range, destinationSpare: null,
  };
  if (hasDestination && range - remaining >= bufferMeters) {
    result.status = 'destination';
    result.destinationSpare = range - remaining;
    return result;
  }
  const keepsBuffer = stations.filter((s) => s.rangeOnArrival >= bufferMeters);
  if (keepsBuffer.length) {
    let pick = keepsBuffer[keepsBuffer.length - 1];
    // A preferred brand within 60 miles before the latest stop wins over an unknown brand.
    const preferred = keepsBuffer.filter((s) => s.preferred && pick.ahead - s.ahead <= 60 * MILE);
    if (preferred.length) pick = preferred[preferred.length - 1];
    result.status = 'planned';
    result.recommended = pick;
    const i = stations.indexOf(pick);
    result.earlier = stations.slice(Math.max(0, i - 2), i).reverse();
    const last = stations[stations.length - 1];
    if (last !== pick && last.rangeOnArrival < bufferMeters) result.lastChance = last;
  } else if (stations.length) {
    result.status = 'low';
    result.recommended = stations[0];
    result.lastChance = stations.length > 1 ? stations[stations.length - 1] : null;
  }
  return result;
}
