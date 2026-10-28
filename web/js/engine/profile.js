// The driver's profile: vehicles, fuel and overnight preferences, places, display and voice. One JSON
// format for the website, the iOS app and profile files moved between them. Same rules as
// Sources/ExitAtlasCore/Profile/ProfileRules.swift, tested on the shared fixtures in
// Tests/ExitAtlasCoreTests/Fixtures/profiles.
//
// Every field is checked on its own: a damaged value falls back to its default (and is reported) without
// touching the others. Keys this version does not know are kept, so a newer app's settings survive.

export const PROFILE_SCHEMA = 2;
export const FUEL_CODES = ['R', 'M', 'P', 'D', 'E'];
export const SERVICE_CATEGORIES = ['gas', 'food', 'lodging', 'evCharging', 'restArea', 'travelCenter'];
const WHEN = ['overnight', 'always', 'off'];

export function defaultProfile() {
  return {
    kind: 'exitatlas-profile',
    schema: PROFILE_SCHEMA,
    updatedAt: null,
    vehicles: [],
    defaultVehicleId: null,
    fuel: {
      brands: ['Shell'], grade: null, reserveMiles: 50, maxDetourMinutes: 8,
      require24Hours: 'overnight', requireRestroom: 'overnight', priceOverBrand: false, chargerNetwork: 'Tesla',
    },
    overnight: { mode: 'auto', start: '00:00', end: '04:00' },
    places: { home: null, saved: [], recent: [], plans: [] },
    favorites: { hotels: [], restaurants: [] },
    driving: {
      speedAlertOver: 5, exitLookaheadMiles: 25, gasGapMiles: 40, favoriteCategories: [],
      avoidTolls: false, keepAwake: true, liveActivity: true, theme: 'auto',
    },
    voice: { enabled: true, stateLines: true, exits: false, fuel: true, restAreas: true, gasGaps: true, timeZones: true },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const str = (v, max = 200) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const oneOf = (v, list) => (list.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const clock = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined);

/// A place {name, lat, lon}, or undefined.
export function validPlace(p) {
  if (!isObj(p)) return undefined;
  const name = str(p.name), lat = num(p.lat, -90, 90), lon = num(p.lon, -180, 180);
  if (name === undefined || lat === undefined || lon === undefined) return undefined;
  const out = { name, lat, lon };
  if (str(p.id, 80)) out.id = p.id;
  return out;
}

/// A saved trip plan {name, from (null starts at the current location), stops, to}, or undefined.
export function validPlan(p) {
  if (!isObj(p)) return undefined;
  const name = str(p.name, 80), to = validPlace(p.to);
  if (!name || !to) return undefined;
  const stops = Array.isArray(p.stops) ? p.stops.map(validPlace).filter(Boolean).slice(0, 10) : [];
  const out = { name, from: validPlace(p.from) ?? null, stops, to };
  if (str(p.id, 80)) out.id = p.id;
  return out;
}

/// A stable id for a vehicle without one: same vehicle, same id, on every platform.
export function vehicleId(v) {
  return [v.year, v.make, v.model, v.version].join('|').toLowerCase().replace(/[^a-z0-9|.]+/g, '-');
}

/// A vehicle in the profile format, or undefined when a required field is missing or wrong.
export function validVehicle(v) {
  if (!isObj(v)) return undefined;
  const year = Number.isInteger(v.year) ? num(v.year, 1984, 2100) : undefined;
  const make = str(v.make, 80), model = str(v.model, 120), fuel = oneOf(v.fuel, FUEL_CODES);
  if (year === undefined || !make || !model || !fuel) return undefined;
  const out = {
    id: '', year, make, model, version: str(v.version, 200) ?? '',
    epaId: Number.isInteger(v.epaId) && v.epaId > 0 ? v.epaId : null, fuel,
    city: num(v.city, 0, 300) ?? 0, highway: num(v.highway, 0, 300) ?? 0, combined: num(v.combined, 0, 300) ?? 0,
    tankGallons: fuel === 'E' ? null : num(v.tankGallons, 1, 100) ?? null,
    tankSource: null,
    evRangeMiles: num(v.evRangeMiles, 0, 1500) ?? 0, evRangeHighwayMiles: num(v.evRangeHighwayMiles, 0, 1500) ?? 0,
    mpgBasis: oneOf(v.mpgBasis, ['highway', 'combined', 'custom']) ?? 'highway',
    customMpg: num(v.customMpg, 5, 250) ?? null, customRangeMiles: num(v.customRangeMiles, 10, 1500) ?? null,
  };
  if (out.tankGallons !== null) out.tankSource = oneOf(v.tankSource, ['verified', 'entered']) ?? 'entered';
  out.id = str(v.id, 120) ?? vehicleId(out);
  return out;
}

function brandList(v, max) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const b of v) {
    const s = str(b, 40);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, max);
}

function placeList(v, max) {
  if (!Array.isArray(v)) return undefined;
  return v.map(validPlace).filter(Boolean).slice(0, max);
}

/// Checks a stored profile field by field. Returns { profile, problems }: problems lists the fields
/// that were missing or invalid and now hold their defaults ("vehicles[2]" for a dropped entry).
export function normalizeProfile(raw) {
  const d = defaultProfile();
  const problems = [];
  if (!isObj(raw)) return { profile: d, problems: ['profile'] };
  const out = { ...raw, ...d };
  out.schema = Math.max(PROFILE_SCHEMA, Number.isInteger(raw.schema) ? raw.schema : 0);
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;

  // Each section: keep unknown keys, check known ones.
  const section = (name, rules) => {
    const src = raw[name];
    if (src === undefined) return;
    if (!isObj(src)) { problems.push(name); return; }
    const s = { ...src, ...d[name] };
    for (const [key, check] of Object.entries(rules)) {
      if (src[key] === undefined) continue;
      const v = check(src[key]);
      if (v === undefined) problems.push(`${name}.${key}`); else s[key] = v;
    }
    out[name] = s;
  };

  if (raw.vehicles !== undefined) {
    if (!Array.isArray(raw.vehicles)) problems.push('vehicles');
    else {
      const seen = new Set();
      out.vehicles = [];
      raw.vehicles.forEach((v, i) => {
        const ok = validVehicle(v);
        if (!ok) { problems.push(`vehicles[${i}]`); return; }
        if (seen.has(ok.id)) return;
        seen.add(ok.id);
        out.vehicles.push(ok);
      });
      out.vehicles = out.vehicles.slice(0, 10);
    }
  }
  out.defaultVehicleId = out.vehicles.some((v) => v.id === raw.defaultVehicleId) ? raw.defaultVehicleId : (out.vehicles[0]?.id ?? null);
  if (raw.defaultVehicleId != null && out.defaultVehicleId !== raw.defaultVehicleId) problems.push('defaultVehicleId');

  section('fuel', {
    brands: (v) => brandList(v, 20),
    grade: (v) => (v === null ? null : oneOf(v, ['R', 'M', 'P', 'D'])),
    reserveMiles: (v) => num(v, 0, 300),
    maxDetourMinutes: (v) => num(v, 1, 60),
    require24Hours: (v) => oneOf(v, WHEN),
    requireRestroom: (v) => oneOf(v, WHEN),
    priceOverBrand: bool,
    chargerNetwork: (v) => oneOf(v, ['Tesla', 'all']),
  });
  section('overnight', { mode: (v) => oneOf(v, ['auto', 'on', 'off']), start: clock, end: clock });
  section('places', {
    home: (v) => (v === null ? null : validPlace(v)),
    saved: (v) => placeList(v, 50),
    recent: (v) => placeList(v, 10),
    plans: (v) => (Array.isArray(v) ? v.map(validPlan).filter(Boolean).slice(0, 20) : undefined),
  });
  section('favorites', { hotels: (v) => brandList(v, 20), restaurants: (v) => brandList(v, 20) });
  section('driving', {
    speedAlertOver: (v) => num(v, 0, 30),
    exitLookaheadMiles: (v) => num(v, 5, 300),
    gasGapMiles: (v) => num(v, 10, 200),
    favoriteCategories: (v) => (Array.isArray(v) ? [...new Set(v.filter((c) => SERVICE_CATEGORIES.includes(c)))] : undefined),
    avoidTolls: bool, keepAwake: bool, liveActivity: bool,
    theme: (v) => oneOf(v, ['auto', 'light', 'dark']),
  });
  section('voice', Object.fromEntries(Object.keys(d.voice).map((k) => [k, bool])));
  return { profile: out, problems };
}

/// The vehicle that plans fuel stops: the default one, or null.
export function defaultVehicle(profile) {
  return profile.vehicles.find((v) => v.id === profile.defaultVehicleId) ?? null;
}

/// True when the overnight window contains the local time "HH:MM" (windows may cross midnight).
export function inOvernightWindow(profile, minutesOfDay) {
  const o = profile.overnight;
  if (o.mode === 'on') return true;
  if (o.mode === 'off') return false;
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const start = m(o.start), end = m(o.end);
  if (start === end) return false;
  return start < end ? minutesOfDay >= start && minutesOfDay < end : minutesOfDay >= start || minutesOfDay < end;
}

// MARK: Migration from the web version's earlier storage (schema 1, separate keys)

/// Web schema 1: `ea.settings`, `ea.places` (or the older `ea.recent`), `ea.vehicles`, `ea.window`.
/// Returns a schema 2 profile; nothing in the old keys is changed.
export function migrateWebV1({ settings = null, places = null, recent = null, vehicles = null, window = null } = {}) {
  const p = defaultProfile();
  const s = isObj(settings) ? settings : {};
  const toVehicle = (v, basis) => (isObj(v) ? validVehicle({
    year: v.year, make: v.make, model: v.model, version: v.label, epaId: v.epaId, fuel: v.fuel,
    city: v.city, highway: v.hwy, combined: v.comb, tankGallons: v.tankGallons, tankSource: v.tankBasis,
    evRangeMiles: v.rangeMiles, evRangeHighwayMiles: v.rangeHwyMiles, ...basis,
  }) : undefined);
  const basis = { mpgBasis: s.mpgBasis, customMpg: s.customMpg ?? undefined, customRangeMiles: s.customRange ?? undefined };
  const current = toVehicle(s.vehicle, basis);
  const list = current ? [current] : [];
  for (const v of Array.isArray(vehicles) ? vehicles : []) {
    const ok = toVehicle(v, {});
    if (ok && !list.some((x) => x.id === ok.id)) list.push(ok);
  }
  p.vehicles = list.slice(0, 10);
  p.defaultVehicleId = current?.id ?? null;

  // Favorite brands: the list, or the older comma separated text. Empty means never chosen, so the
  // Shell default applies once, here; after this the driver's list is kept as is.
  let brands = brandList(s.favoriteBrands, 20) ?? [];
  if (!brands.length && typeof s.preferredBrands === 'string') brands = brandList(s.preferredBrands.split(','), 20) ?? [];
  if (brands.length) p.fuel.brands = brands;
  if (num(s.bufferMiles, 0, 300) !== undefined) p.fuel.reserveMiles = s.bufferMiles;
  if (oneOf(s.chargerNetwork, ['Tesla', 'all'])) p.fuel.chargerNetwork = s.chargerNetwork;

  const pl = isObj(places) ? places : {};
  const fromWeb = (w) => (isObj(w) && isObj(w.coordinate) ? validPlace({ name: w.name, lat: w.coordinate.lat, lon: w.coordinate.lon }) : undefined);
  p.places.home = fromWeb(pl.home) ?? null;
  const rec = Array.isArray(pl.recent) && pl.recent.length ? pl.recent : Array.isArray(recent) ? recent : [];
  p.places.recent = rec.map(fromWeb).filter(Boolean).slice(0, 10);

  const dr = p.driving;
  if (num(s.speedAlertOver, 0, 30) !== undefined) dr.speedAlertOver = s.speedAlertOver;
  if (num(window, 5, 300) !== undefined) dr.exitLookaheadMiles = window;
  if (num(s.gasGapMiles, 10, 200) !== undefined) dr.gasGapMiles = s.gasGapMiles;
  if (bool(s.keepAwake) !== undefined) dr.keepAwake = s.keepAwake;
  if (oneOf(s.theme, ['auto', 'light', 'dark'])) dr.theme = s.theme;
  const vo = p.voice;
  for (const [from, to] of [['voice', 'enabled'], ['announceStateLines', 'stateLines'], ['announceExits', 'exits'],
    ['announceRestAreas', 'restAreas'], ['announceGasGaps', 'gasGaps'], ['announceTimeZones', 'timeZones']]) {
    if (bool(s[from]) !== undefined) vo[to] = s[from];
  }
  return p;
}
