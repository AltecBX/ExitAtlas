// DC fast chargers along the route from the U.S. DOE Alternative Fuels Data Center (AFDC) station
// API, nearby-route search: one request per route. Tesla Superchargers by default.

const AFDC = 'https://developer.nlr.gov/api/alt-fuel-stations/v1/nearby-route.json';
export const DEMO_KEY = 'DEMO_KEY';

/// Route as WKT, sampled every 2 km (the corridor is 2.5 miles wide, so this is well inside it).
export function routeWKT(polyline, step = 2000) {
  const pts = [];
  for (let d = 0; d < polyline.length; d += step) pts.push(polyline.coordinateAt(d));
  pts.push(polyline.coordinateAt(polyline.length));
  return `LINESTRING(${pts.map((p) => `${p.lon.toFixed(5)} ${p.lat.toFixed(5)}`).join(', ')})`;
}

export function parseStations(json) {
  return (json.fuel_stations ?? []).filter((s) => s.status_code === 'E' && (s.ev_dc_fast_num ?? 0) > 0).map((s) => ({
    id: s.id, name: s.station_name, lat: s.latitude, lon: s.longitude, network: s.ev_network,
    stalls: s.ev_dc_fast_num, connectors: s.ev_connector_types ?? [],
    openToOthers: /NACS partner|non-Tesla|all EV/i.test(s.access_days_time ?? ''),
    hours: s.access_days_time ?? '', pricing: s.ev_pricing ?? '', address: [s.street_address, s.city, s.state].filter(Boolean).join(', '),
    confirmed: s.date_last_confirmed ?? null,
  }));
}

/// Fetches chargers within 2.5 miles of the route. network: 'Tesla' or 'all'. With `proxy` (the owner's
/// key proxy, infra/worker) the same search goes through it and no key leaves the phone.
export async function fetchChargers(polyline, { apiKey = DEMO_KEY, network = 'Tesla', proxy = null, fetchImpl = (...a) => fetch(...a) } = {}) {
  const body = new URLSearchParams({ route: routeWKT(polyline), distance: '2.5', fuel_type: 'ELEC', ev_charging_level: 'dc_fast', status: 'E', limit: 'all' });
  if (network === 'Tesla') body.set('ev_network', 'Tesla');
  const res = proxy
    ? await fetchImpl(new URL('v1/chargers', proxy), { method: 'POST', body })
    : await fetchImpl(`${AFDC}?api_key=${encodeURIComponent(apiKey || DEMO_KEY)}`, { method: 'POST', body });
  const json = await res.json().catch(() => null);
  if (res.status === 429) {
    throw new Error(proxy ? (json?.error ?? 'the daily charger lookup budget is used up') : 'charger lookups are rate limited on the demo key; add a free NREL key in Settings');
  }
  if (!res.ok || !json) throw new Error(json?.errors?.join(', ') || (typeof json?.error === 'string' ? json.error : json?.error?.message) || `HTTP ${res.status}`);
  return parseStations(json);
}
