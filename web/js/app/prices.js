// Gas prices, business hours and restrooms near an exit from Google Places API (New) Nearby Search, using the
// driver's own API key, or the owner's key proxy (infra/worker) when one is set. Google bills every lookup,
// so this is off by default (Settings, Gas prices, Google Maps prices). Once the driver turns it on, the exits
// they are looking at are looked up without a tap (app/main.js autoGooglePrices, AUTO_LOOKUP_RULES), a few at a
// time and at most 30 a day on the device (docs/17). Google's terms: show Google attribution where these
// prices appear without a Google map, never put them on a non-Google map, do not pre-fetch, and do not store
// them (memory only, an hour); they never go into the shared driver reports.

import { dollars } from '../engine/gasprices.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
// Hours and the restroom field ride on the same request: Google bills a Nearby Search once, at the
// highest SKU among its fields, and fuelOptions is already the highest (Enterprise + Atmosphere).
const FIELDS = 'places.id,places.displayName,places.location,places.fuelOptions,places.currentOpeningHours,places.restroom';
// Google's answer for an exit is kept in memory for an hour, then dropped (never saved); the same as
// AUTO_LOOKUP_RULES.refreshMinutes (engine/gasprices.js).
export const LOOKUP_TTL = 60 * 60 * 1000;
/// Google lookups a day on one device, matching the daily quota of 30 set on the key's Google Cloud project
/// (at most 930 a month, under the 1,000 free; docs/17). The project quota is the hard cap across devices.
export const GOOGLE_DAILY_LIMIT = 30;
const LIMIT_REACHED = `Today's ${GOOGLE_DAILY_LIMIT} Google price checks are used. They reset at midnight Pacific time.`;
const QUOTA_REACHED = "Google's daily limit for this key is reached. It resets at midnight Pacific time.";

/// The calendar day in Pacific time ("2026-10-30"), when Google's daily quotas reset.
export function pacificDay(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

export const GRADES = {
  R: { key: 'REGULAR_UNLEADED', name: 'Regular' },
  M: { key: 'MIDGRADE', name: 'Midgrade' },
  P: { key: 'PREMIUM', name: 'Premium' },
  D: { key: 'DIESEL', name: 'Diesel' },
};

export function parsePlaces(json) {
  return (json.places ?? []).map((p) => {
    const prices = {};
    for (const fp of p.fuelOptions?.fuelPrices ?? []) {
      const units = Number(fp.price?.units ?? 0), nanos = Number(fp.price?.nanos ?? 0);
      const value = units + nanos / 1e9;
      if (value > 0) prices[fp.type] = { value, currency: fp.price?.currencyCode ?? 'USD', updated: fp.updateTime ? Date.parse(fp.updateTime) : null };
    }
    return {
      id: p.id, name: p.displayName?.text ?? 'Gas station', location: p.location, prices,
      periods: Array.isArray(p.currentOpeningHours?.periods) && p.currentOpeningHours.periods.length ? p.currentOpeningHours.periods : null,
      restroom: typeof p.restroom === 'boolean' ? p.restroom : null,
    };
  });
}

export class GasPrices {
  constructor({ getKey, getProxy = () => null, allowed = () => false, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), onCall = null,
    usedToday = () => 0, dailyLimit = GOOGLE_DAILY_LIMIT } = {}) {
    this.getKey = getKey;
    this.allowed = allowed;
    this.getProxy = getProxy;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onCall = onCall;
    this.usedToday = usedToday;
    this.dailyLimit = dailyLimit;
    this.cache = new Map(); // exit id -> {at, stations, error, pending}
  }

  /// On only when the driver turned Google Maps prices on, and then through the proxy when it is set and
  /// offers them, else with the driver's key.
  get enabled() { return Boolean(this.allowed() && (this.getProxy() || this.getKey())); }

  /// The answer for an exit in the last hour: {stations, error, at}, or null when not loaded or older.
  peek(exitId) {
    const c = this.cache.get(exitId);
    return c && !c.pending && this.now() - c.at < LOOKUP_TTL ? c : null;
  }

  /// Loads prices for the gas stations within 1.6 km of an exit (one request, then kept in memory for an hour).
  async load(exit) {
    const key = this.getKey(), proxy = this.getProxy();
    if (!this.allowed() || (!key && !proxy)) return null;
    const c = this.cache.get(exit.id);
    if (c && (c.pending || this.now() - c.at < LOOKUP_TTL)) return c.pending ?? c;
    if (this.usedToday() >= this.dailyLimit) {
      const entry = { at: this.now(), stations: [], error: LIMIT_REACHED };
      this.cache.set(exit.id, entry);
      return entry;
    }
    const pending = (async () => {
      let entry;
      try {
        this.onCall?.();
        // The proxy makes the same Google request with the owner's key and answers with Google's JSON.
        const res = proxy
          ? await this.fetchImpl(new URL('v1/gas-prices', proxy), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: exit.coordinate.lat, lon: exit.coordinate.lon }),
          })
          : await this.fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
            body: JSON.stringify({
              includedTypes: ['gas_station'], maxResultCount: 10, rankPreference: 'DISTANCE',
              locationRestriction: { circle: { center: { latitude: exit.coordinate.lat, longitude: exit.coordinate.lon }, radius: 1600 } },
            }),
          });
        const json = await res.json().catch(() => null);
        // The proxy names its own daily budget in a string; Google's quota answers 429 RESOURCE_EXHAUSTED.
        if (!res.ok && typeof json?.error === 'string') throw new Error(json.error);
        if (res.status === 429 || json?.error?.status === 'RESOURCE_EXHAUSTED') throw new Error(QUOTA_REACHED);
        if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
        entry = { at: this.now(), stations: parsePlaces(json ?? {}), error: null };
      } catch (e) {
        entry = { at: this.now(), stations: [], error: e.message };
      }
      this.cache.set(exit.id, entry);
      return entry;
    })();
    this.cache.set(exit.id, { pending, at: this.now() });
    return pending;
  }
}

/// Whether a Google price is current: updated within the driver's age limit (Settings, 24 hours by default). One
/// without an update time, or older, is shown as old and is never the cheapest (docs/17, 17.4).
export function googlePriceCurrent(p, { now = Date.now(), maxAgeHours = 24 } = {}) {
  return Boolean(p?.updated) && now - p.updated <= maxAgeHours * 3600000;
}

/// Stations with a current price for the grade, cheapest first.
export function pricedForGrade(stations, gradeKey, options = {}) {
  return stations.filter((s) => googlePriceCurrent(s.prices[gradeKey], options))
    .sort((a, b) => a.prices[gradeKey].value - b.prices[gradeKey].value);
}

/// "$3.15", or "$3.099" with the tenths of a cent a pump posts.
export function priceText(p) {
  return dollars(p.value);
}

export function ageText(updated, now = Date.now()) {
  if (!updated) return '';
  const min = Math.max(0, Math.round((now - updated) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
