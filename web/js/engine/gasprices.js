// Gas prices from reports with a source and a time (docs/17): the driver's own reports on this device,
// optional shared reports from other ExitAtlas drivers, and open station feeds licensed for reuse. Never a
// regional average shown as a station's price, never a price made up to fill a gap, never one grade compared
// with another. Same rules as Sources/ExitAtlasCore/Planning/GasPrices.swift, tested on
// Tests/ExitAtlasCoreTests/Fixtures/prices (simulated prices).
//
// A record: {id, stationId, lat, lon, brand, grade: 'R' | 'M' | 'P' | 'D', price (USD per gallon),
//   currency: 'USD', payment: 'cash' | 'credit' | null (not said), member (loyalty or member price),
//   reportedAt (unix seconds, when the price was seen), reporter (an opaque id, or null),
//   source: {id, name, kind: 'own' | 'community' | 'open' | 'google'}}
import { METERS_PER_MILE as MILE } from './geo.js';

export const PRICE_GRADES = Object.freeze(['R', 'M', 'P', 'D']);
export const GRADE_NAMES = Object.freeze({ R: 'Regular', M: 'Midgrade', P: 'Premium', D: 'Diesel' });

export const PRICE_RULES = Object.freeze({
  /// US pump prices outside this range (dollars per gallon) are typing mistakes or jokes.
  minPrice: 1.5,
  maxPrice: 9.99,
  /// Reports older than this are dropped altogether.
  keepDays: 7,
  /// The same station, grade, payment and price again within this time is the same report.
  duplicateMinutes: 30,
  /// Two current reports for the same station, grade and payment this far apart (dollars) conflict.
  conflictDollars: 0.1,
  /// A report this far from the regional average (as a share of it) is not accepted.
  benchmarkShare: 0.5,
  /// A driver may correct their own report for this long.
  correctMinutes: 30,
});

/// Checks a report before it is saved. input: {stationId, grade, price, payment, member, reportedAt}.
/// options: {now, benchmark (the regional average for the grade, or null)}.
/// Returns {ok, problems: [...], record (normalized, when ok)}.
export function validateReport(input, { now, benchmark = null } = {}, rules = PRICE_RULES) {
  const problems = [];
  if (!input || typeof input.stationId !== 'string' || !input.stationId) problems.push('station');
  if (!PRICE_GRADES.includes(input?.grade)) problems.push('grade');
  const price = typeof input?.price === 'number' && Number.isFinite(input.price) ? Math.round(input.price * 1000) / 1000 : NaN;
  if (!(price >= rules.minPrice && price <= rules.maxPrice)) problems.push('price out of range');
  else if (benchmark > 0 && Math.abs(price - benchmark) / benchmark > rules.benchmarkShare) problems.push('far from the regional average');
  if (input?.payment != null && input.payment !== 'cash' && input.payment !== 'credit') problems.push('payment');
  const at = input?.reportedAt ?? now;
  if (!(typeof at === 'number' && at <= now + 60 && now - at <= rules.keepDays * 86400)) problems.push('time');
  if (problems.length) return { ok: false, problems, record: null };
  return {
    ok: true, problems,
    record: {
      ...input, price, currency: 'USD', payment: input.payment ?? null, member: Boolean(input.member), reportedAt: at,
    },
  };
}

/// How current a record is: 'current' (seen within maxAgeHours: compared), 'old' (shown greyed, never
/// compared), 'expired' (past keepDays: dropped). text: "Reported 18 minutes ago".
export function freshness(record, now, maxAgeHours = 24, rules = PRICE_RULES) {
  const age = Math.max(0, now - record.reportedAt);
  const state = age > rules.keepDays * 86400 ? 'expired' : age > maxAgeHours * 3600 ? 'old' : 'current';
  return { state, age, text: reportedText(age) };
}

export function reportedText(age) {
  const min = Math.floor(age / 60);
  if (min < 1) return 'Reported just now';
  if (min < 60) return `Reported ${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Reported ${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  if (h < 48) return 'Reported yesterday';
  return `Reported ${Math.floor(h / 24)} days ago`;
}

const samePrice = (a, b) => Math.abs(a - b) < 0.0005;

/// True when `r` repeats a report already in `records`: same station, grade, payment, member flag and
/// price within duplicateMinutes, from the same reporter (or either has none).
export function isDuplicate(records, r, rules = PRICE_RULES) {
  return records.some((x) => x.stationId === r.stationId && x.grade === r.grade && x.payment === r.payment
    && Boolean(x.member) === Boolean(r.member) && samePrice(x.price, r.price)
    && Math.abs(x.reportedAt - r.reportedAt) <= rules.duplicateMinutes * 60
    && (x.reporter == null || r.reporter == null || x.reporter === r.reporter));
}

/// Adds a report, or replaces the reporter's own report for the same station, grade, payment and member
/// flag made within correctMinutes (a correction). Drops expired ones. Returns the new list.
export function addReport(records, r, now, rules = PRICE_RULES) {
  const kept = records.filter((x) => now - x.reportedAt <= rules.keepDays * 86400);
  if (isDuplicate(kept, r, rules)) return kept;
  const correcting = (x) => x.reporter != null && x.reporter === r.reporter && x.stationId === r.stationId && x.grade === r.grade
    && x.payment === r.payment && Boolean(x.member) === Boolean(r.member) && r.reportedAt - x.reportedAt <= rules.correctMinutes * 60;
  return [...kept.filter((x) => !correcting(x)), r];
}

/// The price to show for one station and grade. Exactly the preferred payment first, then unspecified, then
/// the other payment (labeled as such). Member prices only when asked. The latest current report wins;
/// with none current, the latest old one is shown as old.
/// Returns null (price unavailable) or {record, state, text, paymentMatch: 'exact' | 'unspecified' | 'other',
///   confirmations (other current reports of the same price), conflict (a current report of the same kind
///   differs by more than conflictDollars)}.
export function stationPrice(records, stationId, grade, { now, payment = 'credit', maxAgeHours = 24, member = false } = {}, rules = PRICE_RULES) {
  const mine = records.filter((r) => r.stationId === stationId && r.grade === grade && Boolean(r.member) === member
    && freshness(r, now, maxAgeHours, rules).state !== 'expired');
  if (!mine.length) return null;
  const match = (r) => (r.payment === payment ? 'exact' : r.payment == null ? 'unspecified' : 'other');
  const RANK = { exact: 0, unspecified: 1, other: 2 };
  const fresh = (r) => freshness(r, now, maxAgeHours, rules).state === 'current';
  const order = (a, b) => (fresh(b) - fresh(a)) || (RANK[match(a)] - RANK[match(b)]) || (b.reportedAt - a.reportedAt);
  const best = [...mine].sort(order)[0];
  const f = freshness(best, now, maxAgeHours, rules);
  const peers = mine.filter((r) => r !== best && fresh(r) && match(r) === match(best));
  return {
    record: best, state: f.state, text: f.text, paymentMatch: match(best),
    confirmations: f.state === 'current' ? peers.filter((r) => samePrice(r.price, best.price)).length : 0,
    conflict: f.state === 'current' && peers.some((r) => Math.abs(r.price - best.price) > rules.conflictDollars),
  };
}

/// The price a station competes with: only a current one. Old prices are shown but never compared.
export function comparablePrice(sp) {
  return sp && sp.state === 'current' ? sp.record.price : null;
}

/// The cost of filling up at a stop. price: dollars per gallon; rangeOnArrival and detourMeters (both
/// ways) in meters; tankGallons and mpg from the vehicle. Null when a value needed is unknown.
/// Returns {gallons (bought to fill the tank), detourGallons (burned on the detour), total (both, at this
/// pump's price), perGallon (total / gallons bought)}.
export function fillCost({ price, rangeOnArrival, tankGallons, mpg, detourMeters = 0 }) {
  if (!(price > 0 && tankGallons > 0 && mpg > 0) || rangeOnArrival == null) return null;
  const onArrival = Math.max(0, rangeOnArrival) / MILE / mpg;
  const gallons = Math.max(0, tankGallons - onArrival);
  if (!(gallons > 0)) return null;
  const detourGallons = Math.max(0, detourMeters) / MILE / mpg;
  const total = price * (gallons + detourGallons);
  return { gallons, detourGallons, total, perGallon: total / gallons };
}

export const SAVINGS_RULES = Object.freeze({
  /// A cheaper stop is worth mentioning when it saves at least this on a fill (the driver can change it)...
  minDollars: 2,
  /// ...and at least this much per gallon.
  minPerGallon: 0.05,
});

/// What another stop saves over the preferred one, for the same fill: both prices current, the same grade
/// (the caller passes one grade) and the same kind of payment (or one unspecified). a and b:
/// {price: stationPrice result, cost: fillCost result, detourMeasured}.
/// Returns null (not comparable) or {savings (dollars, positive when b is cheaper), perGallon, estimate
///   (a detour was not measured), meaningful}.
export function compareStops(a, b, { minDollars = SAVINGS_RULES.minDollars, minPerGallon = SAVINGS_RULES.minPerGallon } = {}) {
  const pa = comparablePrice(a?.price), pb = comparablePrice(b?.price);
  if (pa == null || pb == null || !a.cost || !b.cost) return null;
  const ka = a.price.record.payment, kb = b.price.record.payment;
  if (ka && kb && ka !== kb) return null;
  // The same gallons bought at either stop (the fill at b), each with its own detour fuel.
  const g = b.cost.gallons;
  const savings = pa * (g + a.cost.detourGallons) - pb * (g + b.cost.detourGallons);
  const perGallon = pa - pb;
  return {
    savings, perGallon, estimate: !a.detourMeasured || !b.detourMeasured,
    meaningful: savings >= minDollars && perGallon >= minPerGallon,
  };
}

export const SORTS = Object.freeze(['recommended', 'price', 'closest', 'detour', 'brand']);
export const SORT_NAMES = Object.freeze({ recommended: 'Recommended', price: 'Lowest price', closest: 'Closest', detour: 'Shortest detour', brand: 'Favorite brand first' });

/// Orders stations for the Fuel comparison. rows: [{id, ahead (m), detourMinutes (or null), brandRank (0 is
/// the first favorite, null none), recommendedRank (SmartStop order, or null), price (stationPrice result or
/// null)}]. A station without a current price never sorts as cheaper than one with a price.
export function sortStations(rows, sort = 'recommended') {
  const inf = Number.POSITIVE_INFINITY;
  const keys = {
    recommended: (r) => [r.recommendedRank ?? inf, r.ahead],
    price: (r) => [comparablePrice(r.price) ?? inf, r.ahead],
    closest: (r) => [r.ahead],
    detour: (r) => [r.detourMinutes ?? inf, r.ahead],
    brand: (r) => [r.brandRank ?? inf, r.ahead],
  };
  const key = keys[sort] ?? keys.recommended;
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/// EIA's weekly retail price regions (PADD) by state, for the regional average shown as context.
const PADD = {
  '1A': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
  '1B': ['DE', 'DC', 'MD', 'NJ', 'NY', 'PA'],
  '1C': ['FL', 'GA', 'NC', 'SC', 'VA', 'WV'],
  2: ['IL', 'IN', 'IA', 'KS', 'KY', 'MI', 'MN', 'MO', 'NE', 'ND', 'SD', 'OH', 'OK', 'TN', 'WI'],
  3: ['AL', 'AR', 'LA', 'MS', 'NM', 'TX'],
  4: ['CO', 'ID', 'MT', 'UT', 'WY'],
  5: ['AK', 'AZ', 'CA', 'HI', 'NV', 'OR', 'WA'],
};
export function paddFor(state) {
  for (const [p, states] of Object.entries(PADD)) if (states.includes(state)) return String(p);
  return null;
}
