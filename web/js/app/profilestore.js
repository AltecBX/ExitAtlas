// Where the web version keeps the driver's profile, and how the rest of the app reads it.
//
//   ea.profile           the profile (web/js/engine/profile.js), written on every change
//   ea.profile.previous  the copy before the last change, used if ea.profile is ever unreadable
//   ea.profile.corrupt   an unreadable copy, kept as is so nothing is lost silently
//
// The older keys (ea.settings, ea.places, ea.recent, ea.vehicles, ea.window) are read once to migrate
// and then left untouched. Trip state, history, datasets and API keys use their own keys.

import { normalizeProfile, migrateWebV1, defaultProfile, defaultVehicle, validVehicle } from '../engine/profile.js';

export const PROFILE_KEY = 'ea.profile';
const PREVIOUS_KEY = 'ea.profile.previous';
const CORRUPT_KEY = 'ea.profile.corrupt';
const LEGACY_KEYS = ['ea.settings', 'ea.places', 'ea.recent', 'ea.vehicles', 'ea.window'];

function read(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function parse(text) {
  if (text === null) return { missing: true };
  try { return { value: JSON.parse(text) }; } catch { return { broken: true }; }
}

/// Loads the profile. Returns { profile, problems, source, wrote } where source is 'stored',
/// 'recovered' (from the previous copy), 'migrated' (from the older keys) or 'new'. Nothing is written
/// when the stored profile was fine, so loading never overwrites a profile with defaults.
export function loadProfile(storage) {
  const stored = parse(read(storage, PROFILE_KEY));
  if (stored.value !== undefined && stored.value !== null && typeof stored.value === 'object') {
    const { profile, problems } = normalizeProfile(stored.value);
    if (problems.length) {
      keepCorrupt(storage, read(storage, PROFILE_KEY));
      return { profile, problems, source: 'stored', wrote: writeProfile(storage, profile, { keepPrevious: false }) };
    }
    return { profile, problems, source: 'stored', wrote: null };
  }
  if (stored.broken || (!stored.missing && stored.value !== undefined)) {
    keepCorrupt(storage, read(storage, PROFILE_KEY));
    const prev = parse(read(storage, PREVIOUS_KEY));
    if (prev.value && typeof prev.value === 'object') {
      const { profile, problems } = normalizeProfile(prev.value);
      return { profile, problems: ['profile', ...problems], source: 'recovered', wrote: writeProfile(storage, profile, { keepPrevious: false }) };
    }
  }
  const legacy = {};
  let any = false;
  for (const key of LEGACY_KEYS) {
    const v = parse(read(storage, key));
    if (v.value !== undefined) { legacy[key] = v.value; any = true; }
  }
  if (any) {
    const profile = migrateWebV1({ settings: legacy['ea.settings'], places: legacy['ea.places'], recent: legacy['ea.recent'],
      vehicles: legacy['ea.vehicles'], window: legacy['ea.window'] });
    return { profile, problems: stored.broken ? ['profile'] : [], source: 'migrated', wrote: writeProfile(storage, profile, { keepPrevious: false }) };
  }
  return { profile: defaultProfile(), problems: stored.broken ? ['profile'] : [], source: 'new', wrote: null };
}

function keepCorrupt(storage, text) {
  if (text === null) return;
  try { storage.setItem(CORRUPT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), text })); } catch { /* best effort */ }
}

/// Writes the profile and reads it back. Returns { ok, error }: ok is false when the browser refused
/// (storage full, blocked or private mode), so the app never says "saved" when it was not.
export function writeProfile(storage, profile, { keepPrevious = true, now = () => new Date() } = {}) {
  const text = JSON.stringify({ ...profile, updatedAt: now().toISOString() });
  try {
    if (keepPrevious) {
      const current = storage.getItem(PROFILE_KEY);
      if (current !== null) storage.setItem(PREVIOUS_KEY, current);
    }
    storage.setItem(PROFILE_KEY, text);
    if (storage.getItem(PROFILE_KEY) !== text) return { ok: false, error: 'the browser did not keep the change' };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e?.name === 'QuotaExceededError' ? 'browser storage is full' : 'browser storage is blocked' };
  }
}

// MARK: The app's flat settings object, read from and written to the profile

/// Profile vehicle -> the shape the fuel planner and views use.
export function webVehicle(v) {
  if (!v) return null;
  return {
    id: v.id, year: v.year, make: v.make, model: v.model, label: v.version, city: v.city, hwy: v.highway, comb: v.combined,
    epaId: v.epaId, fuel: v.fuel, ev: v.fuel === 'E', rangeMiles: v.evRangeMiles, rangeHwyMiles: v.evRangeHighwayMiles,
    tankGallons: v.tankGallons, tankBasis: v.tankSource, tankSources: [],
  };
}

/// The app's vehicle shape -> profile vehicle (with the MPG basis, which the app keeps in settings).
export function profileVehicle(w, s = {}) {
  if (!w) return undefined;
  return validVehicle({
    id: w.id, year: w.year, make: w.make, model: w.model, version: w.label, epaId: w.epaId, fuel: w.fuel,
    city: w.city, highway: w.hwy, combined: w.comb, tankGallons: w.tankGallons, tankSource: w.tankBasis,
    evRangeMiles: w.rangeMiles, evRangeHighwayMiles: w.rangeHwyMiles,
    mpgBasis: s.mpgBasis, customMpg: s.customMpg ?? undefined, customRangeMiles: s.customRange ?? undefined,
  });
}

const webPlace = (p) => (p ? { name: p.name, coordinate: { lat: p.lat, lon: p.lon }, ...(p.id ? { id: p.id } : {}) } : null);
const profilePlace = (w) => (w?.coordinate ? { name: w.name, lat: w.coordinate.lat, lon: w.coordinate.lon, ...(w.id ? { id: w.id } : {}) } : null);

export function settingsFromProfile(p) {
  const v = defaultVehicle(p);
  return {
    voice: p.voice.enabled, announceStateLines: p.voice.stateLines, announceExits: p.voice.exits, announceFuel: p.voice.fuel,
    announceRestAreas: p.voice.restAreas, announceGasGaps: p.voice.gasGaps, announceTimeZones: p.voice.timeZones,
    keepAwake: p.driving.keepAwake, gasGapMiles: p.driving.gasGapMiles, theme: p.driving.theme,
    speedAlertOver: p.driving.speedAlertOver, favoriteCategories: [...p.driving.favoriteCategories],
    vehicle: webVehicle(v), mpgBasis: v?.mpgBasis ?? 'highway', customMpg: v?.customMpg ?? null, customRange: v?.customRangeMiles ?? null,
    bufferMiles: p.fuel.reserveMiles, favoriteBrands: [...p.fuel.brands], chargerNetwork: p.fuel.chargerNetwork,
    fuelGrade: p.fuel.grade, maxDetourMinutes: p.fuel.maxDetourMinutes, require24Hours: p.fuel.require24Hours,
    requireRestroom: p.fuel.requireRestroom, priceOverBrand: p.fuel.priceOverBrand,
    overnightMode: p.overnight.mode, overnightStart: p.overnight.start, overnightEnd: p.overnight.end,
    favoriteHotels: [...p.favorites.hotels], favoriteRestaurants: [...p.favorites.restaurants],
  };
}

export function placesFromProfile(p) {
  return {
    home: webPlace(p.places.home), saved: p.places.saved.map(webPlace), recent: p.places.recent.map(webPlace),
    plans: p.places.plans.map((t) => ({ ...t, from: webPlace(t.from), stops: t.stops.map(webPlace), to: webPlace(t.to) })),
  };
}

/// The profile with the app's current settings, places and lookahead written into it. Keys the app does
/// not show (and any from a newer version) are kept as they were.
export function applyToProfile(p, settings, places, exitLookaheadMiles) {
  const s = settings;
  const out = structuredClone(p);
  const cur = profileVehicle(s.vehicle, s);
  if (cur) {
    const i = out.vehicles.findIndex((v) => v.id === cur.id);
    if (i >= 0) out.vehicles[i] = cur; else out.vehicles = [cur, ...out.vehicles].slice(0, 10);
    out.defaultVehicleId = cur.id;
  }
  Object.assign(out.voice, {
    enabled: s.voice, stateLines: s.announceStateLines, exits: s.announceExits, fuel: s.announceFuel ?? out.voice.fuel,
    restAreas: s.announceRestAreas, gasGaps: s.announceGasGaps, timeZones: s.announceTimeZones,
  });
  Object.assign(out.driving, {
    keepAwake: s.keepAwake, gasGapMiles: s.gasGapMiles, theme: s.theme, speedAlertOver: s.speedAlertOver,
    favoriteCategories: [...(s.favoriteCategories ?? out.driving.favoriteCategories)],
    exitLookaheadMiles: exitLookaheadMiles ?? out.driving.exitLookaheadMiles,
  });
  Object.assign(out.fuel, {
    reserveMiles: s.bufferMiles, brands: [...s.favoriteBrands], chargerNetwork: s.chargerNetwork,
    grade: s.fuelGrade ?? null, maxDetourMinutes: s.maxDetourMinutes ?? out.fuel.maxDetourMinutes,
    require24Hours: s.require24Hours ?? out.fuel.require24Hours, requireRestroom: s.requireRestroom ?? out.fuel.requireRestroom,
    priceOverBrand: s.priceOverBrand ?? out.fuel.priceOverBrand,
  });
  Object.assign(out.overnight, {
    mode: s.overnightMode ?? out.overnight.mode, start: s.overnightStart ?? out.overnight.start, end: s.overnightEnd ?? out.overnight.end,
  });
  out.favorites.hotels = [...(s.favoriteHotels ?? out.favorites.hotels)];
  out.favorites.restaurants = [...(s.favoriteRestaurants ?? out.favorites.restaurants)];
  if (places) {
    out.places.home = profilePlace(places.home);
    out.places.saved = (places.saved ?? []).map(profilePlace).filter(Boolean);
    out.places.recent = (places.recent ?? []).map(profilePlace).filter(Boolean);
    if (places.plans) {
      out.places.plans = places.plans.map((t) => ({
        ...t, from: profilePlace(t.from), stops: (t.stops ?? []).map(profilePlace).filter(Boolean), to: profilePlace(t.to),
      }));
    }
  }
  // Whatever the app wrote goes through the same checks as stored data.
  return normalizeProfile(out).profile;
}

// MARK: Export and import (the same file format as the iOS app; API keys are never included)

export function exportProfile(p) {
  return JSON.stringify({ ...p, exportedAt: new Date().toISOString() }, null, 2);
}

/// Reads a profile file. Returns { profile, problems } or throws with a reason.
export function importProfile(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('This file is not a profile (not JSON).'); }
  if (!raw || raw.kind !== 'exitatlas-profile') throw new Error('This file is not an ExitAtlas profile.');
  const { exportedAt, ...rest } = raw;
  return normalizeProfile(rest);
}
