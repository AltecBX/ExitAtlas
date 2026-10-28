// Geometric exit matching and services at exits. Port of ExitMatcher.swift and ExitServices.swift.
import { angleDifference } from './geo.js';

export const MatchingOptions = Object.freeze({
  /// Route geometry built from OpenStreetMap (OSRM, corridors): exit nodes sit on the route.
  osmGeometry: { maxOffset: 5, maxOffsetWithoutBearing: 3, maxBearingDifference: 40, mergeSameLabelWithin: 800 },
  /// Route geometry from another vendor. Looser, with the parallel roadway risk documented in docs/08.
  thirdPartyGeometry: { maxOffset: 15, maxOffsetWithoutBearing: 6, maxBearingDifference: 40, mergeSameLabelWithin: 800 },
});

export function optionsForSource(source) {
  return source === 'appleMapKit' || source === 'googleRoutes' ? MatchingOptions.thirdPartyGeometry : MatchingOptions.osmGeometry;
}

export function normalizedLabel(label) {
  return label.toUpperCase().replace(/\s+/g, '');
}

export function exitTitle(exit) {
  return exit.label ? `Exit ${exit.label}` : 'Exit';
}

/// Finds the exits a route passes, using geometry only. Exit numbers are never used to infer
/// order or count; order comes from distance along the route.
export class ExitMatcher {
  constructor(options) { this.options = options; }

  encounters(route, dataset) {
    const o = this.options;
    const raw = [];
    for (let i = 0; i < route.segmentCount; i++) {
      dataset.exitIndicesAlongSegment(route.point(i), route.point(i + 1), o.maxOffset, raw);
    }
    const candidateIDs = new Set(raw);
    const found = [];
    for (const id of candidateIDs) {
      const record = dataset.exits[id];
      const radius = record.bearings.length ? o.maxOffset : o.maxOffsetWithoutBearing;
      for (const p of route.projections(record.coordinate, radius)) {
        if (!record.bearings.length) {
          found.push({ record, distanceAlongRoute: p.distanceAlong, offset: p.offset, confidence: 'medium' });
          continue;
        }
        const routeBearing = route.bearingAt(p.distanceAlong);
        if (record.bearings.some((b) => angleDifference(b, routeBearing) <= o.maxBearingDifference)) {
          found.push({ record, distanceAlongRoute: p.distanceAlong, offset: p.offset, confidence: 'high' });
        }
      }
    }
    found.sort((a, b) => (a.distanceAlongRoute !== b.distanceAlongRoute
      ? a.distanceAlongRoute - b.distanceAlongRoute
      : a.record.osmNodeID - b.record.osmNodeID));
    return found;
  }

  match(route, dataset) {
    return this.merge(this.encounters(route, dataset));
  }

  merge(encounters) {
    const groups = [];
    for (const e of encounters) {
      const group = groups[groups.length - 1];
      const last = group ? group[group.length - 1] : null;
      if (last) {
        const gap = e.distanceAlongRoute - last.distanceAlongRoute;
        const sameNode = e.record.osmNodeID === last.record.osmNodeID && gap < 200;
        const label = normalizedLabel(e.record.label);
        const sameLabel = label !== '' && label === normalizedLabel(last.record.label) && gap <= this.options.mergeSameLabelWithin;
        if (sameNode || sameLabel) { group.push(e); continue; }
      }
      groups.push([e]);
    }
    return groups.map((group, ordinal) => {
      const first = group[0];
      const records = [];
      for (const e of group) if (!records.some((r) => r.osmNodeID === e.record.osmNodeID)) records.push(e.record);
      const name = records.map((r) => r.name).find((n) => n) ?? '';
      const highways = [];
      for (const r of records) for (const h of r.highways) if (!highways.includes(h)) highways.push(h);
      return {
        id: `osm-node-${first.record.osmNodeID}`, ordinal, label: first.record.label,
        name: name.replaceAll(';', ' / '), highways, coordinate: first.record.coordinate,
        distanceAlongRoute: first.distanceAlongRoute, offsetFromRoute: first.offset,
        confidence: group.some((e) => e.confidence === 'high') ? 'high' : 'medium', records,
      };
    });
  }
}

/// All services linked to a route exit, deduplicated across merged exit records.
export function servicesForExit(dataset, exit) {
  const byPlace = new Map();
  for (const record of exit.records) {
    for (const link of dataset.links(record)) {
      if (link.reachable === false) continue;
      let service;
      if (link.driveMeters !== null) {
        service = {
          place: link.place, exitID: exit.id, straightLineMeters: link.straightLineMeters,
          detourMeters: 2 * link.driveMeters, detourSeconds: link.driveSeconds !== null ? 2 * link.driveSeconds : null,
          detourBasis: 'routed', reachable: link.reachable, rank: link.rank,
        };
      } else {
        service = {
          place: link.place, exitID: exit.id, straightLineMeters: link.straightLineMeters,
          detourMeters: 2 * 1.4 * link.straightLineMeters, detourSeconds: null,
          detourBasis: 'estimate', reachable: link.reachable, rank: link.rank,
        };
      }
      const existing = byPlace.get(link.place.id);
      if (existing && existing.detourMeters <= service.detourMeters) continue;
      byPlace.set(link.place.id, service);
    }
  }
  return [...byPlace.values()].sort((a, b) => (a.place.category !== b.place.category
    ? a.place.category - b.place.category
    : a.detourMeters - b.detourMeters));
}

/// Lowercases, strips accents and punctuation so "Dunkin'" matches "dunkin".
export function simplified(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
}

/// One condition an exit must satisfy: {category?, nameOrBrand?, maxDetourMeters?}.
export function requirementMatches(req, service) {
  if (req.category != null && service.place.category !== req.category) return false;
  if (req.maxDetourMeters != null && service.detourMeters > req.maxDetourMeters) return false;
  const q = (req.nameOrBrand ?? '').trim();
  if (q) {
    const nq = simplified(q);
    if (![service.place.brand, service.place.name].some((f) => simplified(f).includes(nq))) return false;
  }
  return true;
}

/// Exits in a distance window where every requirement is satisfied, in route order.
export function searchAlongRoute(dataset, exits, requirements, fromDistance, toDistance, servicesFor) {
  const out = [];
  for (const exit of exits) {
    if (exit.distanceAlongRoute < fromDistance || exit.distanceAlongRoute > toDistance) continue;
    const services = servicesFor ? servicesFor(exit) : servicesForExit(dataset, exit);
    const perRequirement = [];
    let ok = true;
    for (const req of requirements) {
      const hits = services.filter((s) => requirementMatches(req, s)).sort((a, b) => a.detourMeters - b.detourMeters);
      if (!hits.length) { ok = false; break; }
      perRequirement.push(hits);
    }
    if (ok) {
      const combined = perRequirement.reduce((sum, hits) => sum + hits[0].detourMeters, 0);
      out.push({ exit, matchesPerRequirement: perRequirement, combinedDetourMeters: combined });
    }
  }
  return out;
}
