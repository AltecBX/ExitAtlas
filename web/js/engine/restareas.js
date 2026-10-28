// Rest areas, welcome centers and service plazas on the mainline (restareas.json from
// tools/data-pipeline/build_rest_areas.py). Port target: Exits/RestAreas.swift.
import { SpatialGrid, angleDifference, expandBox } from './geo.js';

export const RestAreaKind = Object.freeze({ rest: 'rest', welcome: 'welcome', plaza: 'plaza', parking: 'parking' });

export const KIND_TITLES = { rest: 'Rest Area', welcome: 'Welcome Center', plaza: 'Service Plaza', parking: 'Parking Area' };

/// Amenity keys in display order with the words used on badges and in speech.
export const AMENITIES = [
  ['toilets', 'Restrooms'], ['accessible', 'Accessible'], ['water', 'Water'], ['vending', 'Vending'],
  ['picnic', 'Picnic'], ['pets', 'Pet area'], ['wifi', 'Wi-Fi'], ['info', 'Visitor info'],
  ['shower', 'Showers'], ['dump', 'RV dump'], ['trucks', 'Trucks'],
];

export class RestAreaDataset {
  /// json: {meta, items:[{id, lat, lon, kind, name, road, bearing?, amenities?, hours?, truckSpaces?, checked?, fhwa?, gas?, food?, ev?}]}
  constructor(json) {
    if (json?.meta?.kind !== 'restareas') throw new Error('not a rest area dataset');
    this.metadata = json.meta;
    this.items = json.items.map((it, index) => ({ ...it, index, coordinate: { lat: it.lat, lon: it.lon } }));
    this.grid = new SpatialGrid(0.05);
    for (const it of this.items) this.grid.insertPoint(it.index, it.lat, it.lon);
  }

  near(box, meters) {
    return [...new Set(this.grid.query(expandBox(box, meters)))].map((i) => this.items[i]);
  }
}

export const RestAreaMatching = Object.freeze({
  /// Facilities sit up to 400 m from the carriageway (pipeline cutoff), plus route geometry error.
  maxOffset: 450,
  maxBearingDifference: 50,
  /// A facility on the left of the route by more than this belongs to the other carriageway.
  maxLeftOffset: 40,
  /// Two records within this distance along the route on the same side are one facility.
  mergeWithin: 600,
});

/// Facilities the route passes on the driver's side, in route order. A facility without a bearing
/// sits in the median or on an undivided road and serves both directions.
/// highwayAt(distance) -> refs[] | null, optional: drops matches where the route is on a road
/// that is not an interstate (a frontage road or parallel highway passing within 450 m).
export function matchRestAreas(polyline, dataset, { highwayAt = null, options = RestAreaMatching } = {}) {
  const found = [];
  for (const item of dataset.near(polyline.box, options.maxOffset)) {
    for (const p of polyline.projections(item.coordinate, options.maxOffset)) {
      const routeBearing = polyline.bearingAt(p.distanceAlong);
      let side = 'both';
      if (item.bearing != null) {
        if (angleDifference(item.bearing, routeBearing) > options.maxBearingDifference) continue;
        if (p.signedOffset < -options.maxLeftOffset) continue;
        side = 'yours';
      }
      const refs = highwayAt ? highwayAt(p.distanceAlong) : null;
      if (refs && refs.length && !refs.some((r) => r.kind === 'interstate' || r.kind === 'named')) continue;
      found.push({ item, distanceAlongRoute: p.distanceAlong, offset: p.offset, side });
    }
  }
  found.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
  const merged = [];
  for (const f of found) {
    const last = merged[merged.length - 1];
    if (last && f.distanceAlongRoute - last.distanceAlongRoute <= options.mergeWithin && last.kind === kindOf(f.item)) {
      last.records.push(f.item);
      continue;
    }
    merged.push({ ...f, kind: kindOf(f.item), records: [f.item] });
  }
  return merged.map((m, ordinal) => routeRestArea(m, ordinal));
}

function kindOf(item) {
  return item.kind === 'parking' ? 'parking' : item.kind === 'plaza' ? 'plaza' : 'rest';
}

/// Combines duplicate records of one facility: first non-empty name, amenities known in any record.
function routeRestArea(m, ordinal) {
  const records = m.records;
  const welcome = records.find((r) => r.kind === 'welcome');
  const named = records.find((r) => r.name && r.nameSource !== 'fhwa') ?? records.find((r) => r.name);
  const amenities = {};
  for (const r of records) {
    for (const [k, v] of Object.entries(r.amenities ?? {})) if (amenities[k] === undefined || v === true) amenities[k] = v;
  }
  const pick = (key) => records.map((r) => r[key]).find((v) => v != null) ?? null;
  const list = (key) => [...new Set(records.flatMap((r) => r[key] ?? []))];
  return {
    id: `rest-${records[0].id}`, ordinal, kind: welcome ? 'welcome' : m.kind,
    name: named?.name ?? '', nameSource: named?.nameSource ?? 'osm', road: records[0].road,
    coordinate: records[0].coordinate, distanceAlongRoute: m.distanceAlongRoute, offsetFromRoute: m.offset,
    side: m.side, amenities, hours: pick('hours'), truckSpaces: pick('truckSpaces'),
    fhwaTruckSpaces: records.map((r) => r.fhwa?.truckSpaces).find((v) => v != null) ?? null,
    checked: records.map((r) => r.checked).filter(Boolean).sort().pop() ?? null,
    gas: list('gas'), food: list('food'), ev: list('ev'), records,
  };
}

export function restAreaTitle(r) {
  return r.name || KIND_TITLES[r.kind] || 'Rest Area';
}

/// A "no" worth showing: a rest area without restrooms or water, or one closed to trucks.
const NEGATIVES = new Set(['toilets', 'water', 'trucks']);

/// Verified amenities only: [{key, label, value:true|false}], in display order. Unknown is never shown.
export function amenityBadges(r) {
  const out = [];
  for (const [key, label] of AMENITIES) {
    const v = r.amenities[key];
    if (v === true || (v === false && NEGATIVES.has(key))) out.push({ key, label, value: v });
  }
  if (r.hours === '24/7') out.unshift({ key: 'hours', label: 'Open 24 hours', value: true });
  return out;
}

/// "Open 24 hours" or the OSM opening_hours text, or null when unknown.
export function hoursText(r) {
  if (!r.hours) return null;
  return r.hours === '24/7' ? 'Open 24 hours' : r.hours;
}

/// Stretches without gas longer than minMeters between `start` and `end`.
/// stops: [{distance, ...}] in route order (gas exits and service plazas with gas).
/// Returns [{from, to, length, before, after, open}]: `before`/`after` are the stops around the gap
/// (before is null when the gap starts at the driver). `open` means the gap reaches `end` without
/// gas, so its true length is at least `length`; `end` at the route end closes it.
export function gasGaps(stops, start, end, minMeters, routeLength = Infinity) {
  const gaps = [];
  let last = start, before = null;
  for (const s of stops) {
    if (s.distance <= start) continue;
    if (s.distance > end) break;
    if (s.distance - last >= minMeters) gaps.push({ from: last, to: s.distance, length: s.distance - last, before, after: s, open: false });
    last = s.distance;
    before = s;
  }
  if (end - last >= minMeters) gaps.push({ from: last, to: end, length: end - last, before, after: null, open: end < routeLength });
  return gaps;
}
