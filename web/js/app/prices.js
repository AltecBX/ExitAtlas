// Gas prices near an exit from Google Places API (New) Nearby Search with fuelOptions, using the
// driver's own API key. Google's terms: show Google attribution where these prices appear without a
// Google map, never put them on a non-Google map, and do not store them (memory only, 15 minutes).

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const FIELDS = 'places.id,places.displayName,places.location,places.fuelOptions';
const TTL = 15 * 60 * 1000;

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
    return { id: p.id, name: p.displayName?.text ?? 'Gas station', location: p.location, prices };
  });
}

export class GasPrices {
  constructor({ getKey, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), onCall = null } = {}) {
    this.getKey = getKey;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.onCall = onCall;
    this.cache = new Map(); // exit id -> {at, stations, error, pending}
  }

  get enabled() { return Boolean(this.getKey()); }

  /// Cached result for an exit: {stations, error, at} or null when not loaded yet.
  peek(exitId) {
    const c = this.cache.get(exitId);
    return c && !c.pending ? c : null;
  }

  /// Loads prices for the gas stations within 1.6 km of an exit (one request, then 15 minutes cached).
  async load(exit) {
    const key = this.getKey();
    if (!key) return null;
    const c = this.cache.get(exit.id);
    if (c && (c.pending || this.now() - c.at < TTL)) return c.pending ?? c;
    const pending = (async () => {
      let entry;
      try {
        this.onCall?.();
        const res = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
          body: JSON.stringify({
            includedTypes: ['gas_station'], maxResultCount: 10, rankPreference: 'DISTANCE',
            locationRestriction: { circle: { center: { latitude: exit.coordinate.lat, longitude: exit.coordinate.lon }, radius: 1600 } },
          }),
        });
        const json = await res.json().catch(() => null);
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

/// Stations with a price for the grade, cheapest first.
export function pricedForGrade(stations, gradeKey) {
  return stations.filter((s) => s.prices[gradeKey]).sort((a, b) => a.prices[gradeKey].value - b.prices[gradeKey].value);
}

export function priceText(p) {
  return `$${p.value.toFixed(2)}`;
}

export function ageText(updated, now = Date.now()) {
  if (!updated) return '';
  const min = Math.max(0, Math.round((now - updated) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
