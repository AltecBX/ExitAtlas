// SmartStop: one recommended stop and up to two alternatives, each with short reasons, from the stations
// and service plazas ahead. Deterministic and explainable: the same inputs always give the same order,
// and every step of the order is a rule the driver can read in docs/12 (12.7). Same rules as
// Sources/ExitAtlasCore/Planning/SmartStop.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/smartstop.
//
// Stop confidence is a status, never a score. Hours and restrooms are only what a source lists:
//   Google Places business hours for the arrival day          "Verified open at estimated arrival"
//   OpenStreetMap hours (community mapped, with a check date) "Reported open, verification limited"
//   or the brand's own store listing (All the Places, with the date it was collected)
//   a source closed at the arrival time (and none open)       "Reported closed at estimated arrival"
//   nothing listed, hours that do not parse, or OpenStreetMap
//   and the brand listing disagree at the arrival time        "Hours unavailable"
// A restroom is "listed" only when tagged or listed by a source. It is "open at arrival" only
// where its own hours are known: at rest areas and service plazas, whose listed hours are the
// building's. A 24 hour gas station can still lock its restroom overnight, so a station restroom is
// never shown as open at arrival.
import { parseOpeningHours, weekFromPeriods, openAt, localTime } from './openinghours.js';
import { inOvernightWindow } from './profile.js';
import { matchesFavorite } from './fuel.js';
import { fillCost, compareStops } from './gasprices.js';

export const HOURS_LABELS = Object.freeze({
  verified: 'Verified open at estimated arrival',
  reported: 'Reported open, verification limited',
  unknown: 'Hours unavailable',
  closed: 'Reported closed at estimated arrival',
});

export const RESTROOM_LABELS = Object.freeze({
  accessible: 'Restroom listed, open at arrival per listed hours',
  available: 'Restroom listed, access hours unknown',
  unknown: 'Restroom availability unknown',
  none: 'Listed without a restroom',
});

const HOURS_RANK = { verified: 0, reported: 1, unknown: 2, closed: 3 };
const RESTROOM_RANK = { accessible: 0, available: 1, unknown: 2, none: 3 };

/// The hours status of one facility from a parsed weekly table at a local time.
function hoursStatus(hours, local, kind) {
  if (!hours) return { status: 'unknown', closesIn: null };
  const r = openAt(hours, local.weekday, local.minute);
  if (!r.open) return { status: 'closed', closesIn: null };
  return { status: kind, closesIn: r.closesIn };
}

/// A check or collection date ("2025", "2025-03", "2025-03-14") more than a year before the arrival: the
/// hours are still shown, with "may be out of date".
export function isStale(date, arrival) {
  const m = /^(\d{4})(?:-(\d\d))?(?:-(\d\d))?/.exec(date ?? '');
  if (!m) return false;
  return arrival - Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1)) / 1000 > 365 * 86400;
}

/// The pumps' hours from OpenStreetMap and the brand's listing: one source when only one lists them; when
/// both do and agree, the more recently dated one (the listing unless a mapper checked the hours after it
/// was collected); when they disagree at the arrival time, unknown, with a note saying so.
function pumpsFrom(osm, local) {
  const o = parseOpeningHours(osm.hours ?? null), b = parseOpeningHours(osm.brandHours ?? null);
  const fromOsm = { ...hoursStatus(o, local, 'reported'), source: 'OpenStreetMap', checked: osm.checked ?? null, parsed: o };
  const listing = `Listed by ${osm.listedBy ?? 'the brand'}`;
  const fromBrand = { ...hoursStatus(b, local, 'reported'), source: listing, checked: osm.collected ?? null, parsed: b, listing: true };
  if (!o && !b) return { status: 'unknown', closesIn: null, source: null, checked: null, parsed: null };
  if (!b) return fromOsm;
  if (!o) return fromBrand;
  if (fromOsm.status !== fromBrand.status) {
    return { status: 'unknown', closesIn: null, source: null, checked: null, parsed: null,
      note: `OpenStreetMap and the ${osm.listedBy ?? 'brand'} listing disagree` };
  }
  return osm.checked && osm.collected && osm.checked > osm.collected ? fromOsm : fromBrand;
}

/// Everything known about one stop at its arrival time.
///   c: {id, name, brand, kind ('station' or 'plaza'), arrival (epoch s), timeZone,
///       osm: {hours, checked, toilets, gone, brandHours, brandToilets, listedBy, collected},
///       live: {periods, restroom, source}, plaza: {hours, toilets, truckSpaces}}
///   profile: the driver's profile (overnight window)
export function evaluateStop(c, profile) {
  const local = localTime(c.arrival, c.timeZone);
  const overnight = inOvernightWindow(profile, local.minute);
  const osm = c.osm ?? {};
  // Service plazas and rest areas: their listed hours are the building's (fuel at a plaza, restrooms at both).
  const plaza = c.kind === 'plaza' || c.kind === 'rest' ? (c.plaza ?? {}) : null;
  const rest = c.kind === 'rest';
  const facilities = [];

  // Pumps: the station's OpenStreetMap hours and its brand listing (or a plaza's hours, which cover its fuel).
  const pumps = plaza ? pumpsFrom({ hours: plaza.hours }, local) : pumpsFrom(osm, local);
  const parsed = pumps.parsed;
  if (!rest) {
    facilities.push({ name: 'Pumps', status: pumps.status, label: HOURS_LABELS[pumps.status],
      source: pumps.note ?? (pumps.listing && pumps.checked ? `${pumps.source}, collected ${pumps.checked}` : pumps.source),
      checked: plaza || pumps.listing ? null : pumps.checked, closesIn: pumps.closesIn });
  }

  // Store: the business hours Google lists for the arrival day (live, with the driver's key or the proxy).
  const liveWeek = rest ? null : weekFromPeriods(c.live?.periods);
  const store = hoursStatus(liveWeek, local, 'verified');
  if (!rest) {
    facilities.push({ name: 'Store', status: store.status, label: HOURS_LABELS[store.status],
      source: liveWeek ? (c.live.source ?? 'Google Maps') : null, checked: null, closesIn: store.closesIn });
  }

  // The stop as a whole: open when a source says so; closed only when no source says open.
  let hours;
  const liveSource = liveWeek ? (c.live.source ?? 'Google Maps') : null;
  if (store.status === 'verified') hours = { status: 'verified', closesIn: store.closesIn, source: liveSource };
  else if (pumps.status === 'reported') hours = { status: 'reported', closesIn: pumps.closesIn, source: pumps.source };
  else if (store.status === 'closed' || pumps.status === 'closed') hours = { status: 'closed', closesIn: null, source: store.status === 'closed' ? liveSource : pumps.source };
  else hours = { status: 'unknown', closesIn: null, source: null, note: pumps.note ?? null };
  hours.label = HOURS_LABELS[hours.status];
  hours.checked = hours.source && hours.source === pumps.source && !plaza ? pumps.checked : null;
  hours.listing = Boolean(hours.source && hours.source === pumps.source && pumps.listing);
  hours.stale = isStale(hours.checked, c.arrival);
  hours.holidays = Boolean(parsed?.holidays);

  // Restroom: listed by Google, tagged in OpenStreetMap, or listed by the brand, in that order; when
  // OpenStreetMap says none and the brand lists one, unknown. Its own hours only at plazas and rest areas.
  const brandListed = !plaza && osm.brandToilets === true;
  let toilets, restroomSource;
  if (plaza) [toilets, restroomSource] = [plaza.toilets ?? null, 'OpenStreetMap'];
  else if (c.live?.restroom != null) [toilets, restroomSource] = [c.live.restroom, c.live.source ?? 'Google Maps'];
  else if (osm.toilets === false && brandListed) [toilets, restroomSource] = [null, `OpenStreetMap and the ${osm.listedBy ?? 'brand'} listing disagree`];
  else if (osm.toilets != null) [toilets, restroomSource] = [osm.toilets, 'OpenStreetMap'];
  else if (brandListed) [toilets, restroomSource] = [true, `Listed by ${osm.listedBy ?? 'the brand'}${osm.collected ? `, collected ${osm.collected}` : ''}`];
  else [toilets, restroomSource] = [null, null];
  let restroom;
  if (toilets === false) restroom = 'none';
  else if (toilets !== true) restroom = 'unknown';
  else if (plaza && pumps.status === 'reported') restroom = 'accessible';
  else restroom = 'available';
  facilities.push({ name: 'Restroom', status: restroom, label: RESTROOM_LABELS[restroom], source: toilets === null && !restroomSource?.endsWith('disagree') ? null : restroomSource });
  facilities.push({ name: 'Restroom hours', status: restroom === 'accessible' ? 'reported' : 'unknown',
    label: restroom === 'accessible' ? `Open at estimated arrival (the ${rest ? 'rest area' : 'plaza'}'s listed hours)` : 'Not listed', source: restroom === 'accessible' ? 'OpenStreetMap' : null });
  if (plaza) {
    facilities.push({ name: rest ? 'Rest area hours' : 'Plaza hours', status: pumps.status, label: HOURS_LABELS[pumps.status], source: plaza.hours ? 'OpenStreetMap' : null });
    facilities.push({ name: 'Parking', status: plaza.truckSpaces ? 'listed' : 'unknown',
      label: plaza.truckSpaces ? `${plaza.truckSpaces} truck spaces (FHWA survey, 2019)` : 'Spaces not listed', source: plaza.truckSpaces ? 'FHWA' : null });
  } else {
    facilities.push({ name: 'Parking', status: 'unknown', label: 'Not listed', source: null });
  }
  return { local, overnight, hours, restroom: { status: restroom, label: RESTROOM_LABELS[restroom] }, facilities };
}

/// Index of the first favorite brand the stop matches (0 is the driver's first choice), or null.
export function brandIndex(c, favorites) {
  for (let i = 0; i < favorites.length; i++) {
    if ([c.brand, c.name, ...(c.otherNames ?? [])].some((n) => n && matchesFavorite(n, [favorites[i]]))) return i;
  }
  return null;
}

const ORDINAL = ['1st', '2nd', '3rd'];
const ordinal = (i) => ORDINAL[i] ?? `${i + 1}th`;

/// Picks the stop.
///   candidates: stops in route order, each {id, name, brand, kind, exitId, along (m), ahead (m), arrival,
///     timeZone, detourMinutes (measured round trip, null when not measured), rangeOnArrival (m, null
///     when no range is known), detourMeters (both ways, for detour fuel), price (a current reported price
///     for the driver's grade: {value, payment: 'cash' | 'credit' | null, text: "Reported 20 minutes ago",
///     source: name}, or null; old prices are never passed in to compete), osm, live, plaza}
///   profile: the driver's profile (fuel and overnight sections)
///   options: {context: 'fuel' (use the range: later is better) or 'ahead' (nearer is better),
///             purpose: 'fuel' (open pumps rank before restrooms) or 'restroom' (the restroom first),
///             reserveMeters, rejected: ids the driver turned down on this trip,
///             vehicle: {tankGallons, mpg} for the cost of a fill (null: no cost comparison)}
/// Returns {primary, alternatives, considered, passed: {reason: count}, overnight, relaxed, lowRange,
///          favorite: why the first choice brand was not picked (or null), notice: what no stop offers,
///          cheaper: a stop that saves at least prices.minSavingsDollars on a fill over the primary, or null}.
export function smartStop(candidates, profile, { context = 'fuel', purpose = 'fuel', reserveMeters = 0, rejected = [], vehicle = null } = {}) {
  const f = profile.fuel;
  const favorites = f.brands ?? [];
  const evaluated = candidates.map((c) => ({ c, e: evaluateStop(c, profile), brand: brandIndex(c, favorites) }));
  const overnightAny = evaluated.some((x) => x.e.overnight);
  const passed = {};
  const pass = (reason) => { passed[reason] = (passed[reason] ?? 0) + 1; };

  const needs = (setting, x) => setting === 'always' || (setting === 'overnight' && x.e.overnight);
  const usable = [];
  const why = new Map(); // candidate -> why it was passed over
  const drop = (x, reason) => { pass(reason); why.set(x, reason); };
  for (const x of evaluated) {
    if (x.c.ahead != null && x.c.ahead <= 0) { drop(x, 'Already passed'); continue; }
    if (rejected.includes(x.c.id)) { drop(x, 'You skipped it'); continue; }
    if (x.c.osm?.gone) { drop(x, 'No longer listed as a gas station'); continue; }
    if (x.e.hours.status === 'closed') { drop(x, 'Reported closed at arrival'); continue; }
    if (x.c.rangeOnArrival != null && x.c.rangeOnArrival < 0) { drop(x, 'Out of range'); continue; }
    usable.push(x);
  }
  // Soft limits: kept unless nothing would be left.
  const soft = [
    ['Below your reserve', (x) => context === 'fuel' && x.c.rangeOnArrival != null && x.c.rangeOnArrival < reserveMeters],
    ['Detour over your limit', (x) => x.c.detourMinutes != null && x.c.detourMinutes > f.maxDetourMinutes],
    ['Listed without a restroom', (x) => needs(f.requireRestroom, x) && x.e.restroom.status === 'none'],
  ];
  let pool = usable;
  const relaxed = [];
  for (const [reason, fails] of soft) {
    const kept = pool.filter((x) => !fails(x));
    if (kept.length) {
      for (const x of pool) if (fails(x)) drop(x, reason);
      pool = kept;
    } else if (pool.length) {
      relaxed.push(reason);
    }
  }

  const anyPrice = pool.some((x) => x.c.price?.value != null);
  // Every stop is below the reserve: the nearest comes first (open ones first when hours matter).
  const lowRange = relaxed.includes('Below your reserve');
  const key = (x) => {
    if (lowRange) return [needs(f.require24Hours, x) ? HOURS_RANK[x.e.hours.status] : 0, x.c.along];
    const hoursRank = needs(f.require24Hours, x) ? HOURS_RANK[x.e.hours.status] : 0;
    const restroomRank = needs(f.requireRestroom, x) ? RESTROOM_RANK[x.e.restroom.status] : 0;
    const brandRank = x.brand ?? favorites.length;
    const priceRank = f.priceOverBrand && anyPrice ? (x.c.price?.value ?? Infinity) : 0;
    const detour = x.c.detourMinutes ?? f.maxDetourMinutes + 1;
    const order = context === 'fuel' ? -x.c.along : x.c.along;
    const [first, second] = purpose === 'restroom' ? [restroomRank, hoursRank] : [hoursRank, restroomRank];
    return context === 'fuel'
      ? [first, second, priceRank, brandRank, order, detour]
      : [first, second, priceRank, brandRank, detour, order];
  };
  const ranked = pool.map((x) => ({ x, k: key(x) })).sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] < b.k[i] ? -1 : 1;
    return a.x.c.id < b.x.c.id ? -1 : a.x.c.id > b.x.c.id ? 1 : 0;
  }).map((r) => r.x);

  // Alternatives at other exits first, so they offer a different place to stop.
  const primary = ranked[0] ?? null;
  const alternatives = [];
  const used = new Set(primary ? [primary.c.exitId ?? primary.c.id] : []);
  for (const x of ranked.slice(1)) {
    if (alternatives.length === 2) break;
    const place = x.c.exitId ?? x.c.id;
    if (!used.has(place)) { alternatives.push(x); used.add(place); }
  }
  for (const x of ranked.slice(1)) {
    if (alternatives.length === 2) break;
    if (!alternatives.includes(x)) alternatives.push(x);
  }
  const out = (x) => (x ? { ...x.c, evaluation: x.e, brandRank: x.brand, reasons: reasons(x, profile, { needs, lowRange, reserveMeters }) } : null);
  const result = {
    primary: out(primary), alternatives: alternatives.map(out), considered: candidates.length, passed,
    overnight: overnightAny, relaxed, lowRange, favorite: null, notice: null, cheaper: null,
  };
  if (!primary) return result;
  result.cheaper = cheaperStop(primary, pool, profile, vehicle, { needs });

  // The next usable stop after the primary, so the driver knows what skipping it means.
  const after = usable.filter((x) => x.c.along > primary.c.along).sort((a, b) => a.c.along - b.c.along)[0];
  if (after) result.primary.nextOption = after.c.along - primary.c.along;

  // Why the driver's first choice brand did not win (closed, out of range, over the detour limit...).
  const top = evaluated.filter((x) => x.brand !== null && !(x.c.ahead != null && x.c.ahead <= 0))
    .sort((a, b) => a.brand - b.brand || a.c.along - b.c.along)[0];
  if (top && (primary.brand === null || top.brand < primary.brand)) {
    const reason = why.get(top) ?? (needs(f.require24Hours, top) && HOURS_RANK[top.e.hours.status] > HOURS_RANK[primary.e.hours.status]
      ? `${top.e.hours.label.toLowerCase()}, and the recommended stop is better confirmed`
      : needs(f.requireRestroom, top) && RESTROOM_RANK[top.e.restroom.status] > RESTROOM_RANK[primary.e.restroom.status]
        ? `${top.e.restroom.label.toLowerCase()}, and the recommended stop is better confirmed`
        : lowRange ? 'farther, with fuel below your reserve' : f.priceOverBrand && anyPrice ? 'cheaper fuel was preferred' : 'ranked lower');
    result.favorite = { id: top.c.id, name: top.c.name, brand: f.brands[top.brand], exitId: top.c.exitId ?? null, reason };
  }

  // Overnight or restroom stops: say so when nothing ahead is confirmed.
  if (needs(f.requireRestroom, primary) && primary.e.restroom.status !== 'accessible') {
    result.notice = primary.e.restroom.status === 'available'
      ? 'No stop ahead has a restroom confirmed open at your arrival time. These list a restroom; its hours are not known.'
      : 'No stop ahead has a confirmed restroom. Restroom availability is unknown at these stops.';
  } else if (needs(f.require24Hours, primary) && primary.e.hours.status !== 'verified' && primary.e.hours.status !== 'reported') {
    result.notice = 'No stop ahead has hours listed for your arrival time. These are the best available; check before you rely on them.';
  }
  return result;
}

/// Short reasons, most important first.
function reasons(x, profile, { needs, lowRange, reserveMeters }) {
  const f = profile.fuel;
  const out = [];
  if (lowRange && x.c.rangeOnArrival != null) {
    out.push(`Arrive with about ${Math.round(x.c.rangeOnArrival / 1609.344)} mi, below your ${Math.round(reserveMeters / 1609.344)} mi reserve`);
  }
  if (x.brand !== null) out.push(`${f.brands[x.brand]}, your ${ordinal(x.brand)} choice`);
  const h = x.e.hours;
  if (h.status === 'verified') out.push(`${h.label} (${h.source})`);
  else if (h.status === 'reported' && h.listing) out.push(`${h.label} (${h.source.replace('Listed', 'listed')}${h.checked ? `, ${h.checked.slice(0, 7)}` : ''}${h.stale ? ', may be out of date' : ''})`);
  else if (h.status === 'reported') out.push(`${h.label}${h.checked ? ` (OpenStreetMap, checked ${h.checked.slice(0, 7)}${h.stale ? ', may be out of date' : ''})` : ' (OpenStreetMap)'}`);
  else out.push(`${h.label}${h.note ? ` (${h.note})` : ''}`);
  if (h.closesIn != null && h.closesIn <= 60) out.push(`Closes ${h.closesIn} min after you arrive`);
  if (x.e.restroom.status !== 'unknown' || needs(f.requireRestroom, x)) out.push(x.e.restroom.label);
  if (x.c.detourMinutes != null) out.push(x.c.detourMinutes < 1 ? 'No detour' : `About ${Math.round(x.c.detourMinutes)} min detour (twice the drive from the exit)`);
  else if (x.c.kind === 'plaza' || x.c.kind === 'rest') out.push('On the highway, no exit needed');
  else out.push('Detour not measured');
  if (x.c.price?.value != null) out.push(priceReason(x.c.price));
  return out;
}

function priceReason(p) {
  return `$${p.value.toFixed(2)} a gallon${p.text ? `, ${p.text.toLowerCase()}` : ''} (${p.source ?? 'source not stated'})`;
}

/// The stop that saves the most on a fill over the primary, when it saves at least the driver's minimum:
/// both prices current and of the same payment kind, fill cost from the vehicle's tank and mpg with the
/// detour fuel at each pump's price. Only stops the ranking kept (in range, within the detour limit, with
/// the restroom asked for) are considered, and never one with worse hours or restroom confidence when the
/// driver needs them (overnight), so cheaper fuel never trades away an open pump or a restroom. The
/// driver's favorite brands are not changed: this is a note, not a new pick.
function cheaperStop(primary, pool, profile, vehicle, { needs }) {
  const pr = profile.prices ?? {};
  if (pr.tellCheaper === false || pr.compare === false || primary.c.price?.value == null || !vehicle) return null;
  const f = profile.fuel;
  const side = (x) => ({
    price: { record: { price: x.c.price.value, payment: x.c.price.payment ?? null }, state: 'current' },
    cost: fillCost({ price: x.c.price.value, rangeOnArrival: x.c.rangeOnArrival, tankGallons: vehicle.tankGallons, mpg: vehicle.mpg, detourMeters: x.c.detourMeters ?? 0 }),
    detourMeasured: x.c.detourMinutes != null || x.c.kind === 'plaza',
  });
  const base = side(primary);
  let best = null;
  for (const x of pool) {
    if (x === primary || x.c.price?.value == null) continue;
    if (needs(f.require24Hours, x) && HOURS_RANK[x.e.hours.status] > HOURS_RANK[primary.e.hours.status]) continue;
    if (needs(f.requireRestroom, x) && RESTROOM_RANK[x.e.restroom.status] > RESTROOM_RANK[primary.e.restroom.status]) continue;
    const cmp = compareStops(base, side(x), { minDollars: pr.minSavingsDollars ?? 2 });
    if (cmp?.meaningful && (!best || cmp.savings > best.cmp.savings)) best = { x, cmp };
  }
  if (!best) return null;
  const c = best.x.c;
  return {
    id: c.id, name: c.name, brand: c.brand, exitId: c.exitId ?? null, exit: c.exit ?? null, along: c.along, ahead: c.ahead, price: c.price,
    savings: best.cmp.savings, perGallon: best.cmp.perGallon, estimate: best.cmp.estimate, gallons: side(best.x).cost.gallons,
    farther: c.along - primary.c.along,
  };
}

const listedOpen = (e) => e.hours.status === 'verified' || e.hours.status === 'reported';

/// Overnight: the last stop listed open at its arrival time before a long stretch where the stops are
/// not (the warning "before the last known suitable opportunity along a long stretch"). A stretch ends at
/// the next stop listed open, or at a stop reached after the overnight window that is not reported
/// closed, or at `windowEnd` (meters along the route). It counts when it is at least `minLength` long and
/// has stops reached overnight in it; a stretch with no stops at all is a gas gap, which has its own
/// warning, and one without overnight arrivals is not an overnight stretch.
///   candidates: stops ahead (stations and plazas with fuel), as for smartStop
/// Returns {stop, evaluation, length, unlisted: stops in the stretch, openEnded: runs to windowEnd} for
/// the first such stretch ahead, or null.
export function lastOpenBeforeGap(candidates, profile, { minLength, windowEnd, rejected = [] }) {
  const skip = new Set(rejected);
  const stops = candidates
    .filter((c) => (c.ahead == null || c.ahead > 0) && !c.gone && !skip.has(c.id))
    .map((c) => ({ c, e: evaluateStop(c, profile) }))
    .sort((a, b) => a.c.along - b.c.along || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
  const ends = (x) => listedOpen(x.e) || (!x.e.overnight && x.e.hours.status !== 'closed');
  for (let i = 0; i < stops.length; i++) {
    if (!listedOpen(stops[i].e)) continue;
    let j = i + 1;
    while (j < stops.length && !ends(stops[j])) j++;
    const end = j < stops.length ? stops[j].c.along : windowEnd;
    const unlisted = j - i - 1;
    const overnight = stops.slice(i + 1, j).some((x) => x.e.overnight);
    if (overnight && end - stops[i].c.along >= minLength) {
      return { stop: stops[i].c, evaluation: stops[i].e, length: end - stops[i].c.along, unlisted, openEnded: j >= stops.length };
    }
    i = j - 1;
  }
  return null;
}
