// Road Intelligence: road incidents, closures, work zones, weather alerts and (when an authorized source
// exists) enforcement reports from several providers, in one schema, matched to the route ahead by road,
// direction and position, deduplicated and expired, with an honest status for every kind of alert.
// Same rules as Sources/ExitAtlasCore/Alerts/RoadIntel.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/roadintel.
//
// An incident (the common schema every provider converts to):
//   {id, category, description, source: {id, name}, verification: 'official' | 'community' | 'mapped',
//    reportedAt, updatedAt, startsAt, endsAt, expiresAt (unix seconds or null),
//    geometry: {type: 'point', coordinate} | {type: 'line', coordinates} | {type: 'polygon', rings} |
//              {type: 'points', coordinates} (an area alert known only at sample points on the route),
//    road: 'I-95' | null, direction: 'N' | 'S' | 'E' | 'W' | 'both' | null, lanes: text | null,
//    severity: 'minor' | 'moderate' | 'major' | 'severe' | 'unknown'}
// Matching never trusts distance alone: a point near the route must be on the same road and in the same
// direction, so the other carriageway and parallel roads do not raise warnings.
import { METERS_PER_MILE as MILE, angleDifference, initialBearing } from './geo.js';
import { parseHighways } from './route.js';

/// Kinds of alert, most serious first. `group` is the Settings switch that controls it.
export const ALERT_KINDS = Object.freeze({
  closure: { label: 'Road closed', group: 'closures', rank: 1 },
  crash: { label: 'Crash', group: 'incidents', rank: 2 },
  flooding: { label: 'Flooding', group: 'weather', rank: 3 },
  weather: { label: 'Weather alert', group: 'weather', rank: 4 },
  hazard: { label: 'Hazard on the road', group: 'incidents', rank: 5 },
  disabledVehicle: { label: 'Disabled vehicle', group: 'incidents', rank: 6 },
  construction: { label: 'Work zone', group: 'closures', rank: 7 },
  congestion: { label: 'Major delay', group: 'incidents', rank: 8 },
  police: { label: 'Police reported', group: 'police', rank: 9 },
  speedCamera: { label: 'Speed camera', group: 'cameras', rank: 10 },
  other: { label: 'Road incident', group: 'incidents', rank: 11 },
});

/// Settings switches, each covering some kinds.
export const ALERT_GROUPS = Object.freeze({
  closures: { label: 'Closures and work zones', kinds: ['closure', 'construction'] },
  incidents: { label: 'Crashes, hazards and delays', kinds: ['crash', 'hazard', 'disabledVehicle', 'congestion', 'other'] },
  weather: { label: 'Weather and flooding', kinds: ['weather', 'flooding'] },
  police: { label: 'Police reports', kinds: ['police'] },
  cameras: { label: 'Speed cameras', kinds: ['speedCamera'] },
});

export const STATUS_LABELS = Object.freeze({
  ok: 'Alerts on your route',
  noRelevant: 'No relevant reports',
  unavailable: 'Data unavailable',
  notConfigured: 'No source connected',
  unsupported: 'Coverage not supported on this route',
  expired: 'Reports expired',
  off: 'Off in Settings',
  loading: 'Checking',
});

export const MATCH_RULES = Object.freeze({
  /// How far ahead alerts are kept.
  window: 150 * MILE,
  /// A point on the same road, in the same direction, may sit this far from the route line.
  sameRoadOffset: 200,
  /// A point with no road name must be this close (route lines run down the carriageway).
  unnamedOffset: 40,
  /// With no direction given, a point this far left of the route is on the other carriageway.
  otherCarriageway: 15,
  /// Line geometry: points farther than this from the route are not on it.
  lineOffset: 120,
  /// Bearing agreement for lines without a direction field.
  lineBearing: 60,
  /// Weather polygons are tested every this many meters along the route.
  areaStep: 1000,
  /// Two reports of the same kind within this distance (same direction) are one event.
  duplicate: 800,
});

/// "I-95", "Interstate 95", "I 95 N" as {kind, prefix, number}, or null.
export function roadRef(text) {
  if (!text) return null;
  return parseHighways(String(text).toUpperCase().replace(/INTERSTATE/g, 'I'))[0] ?? null;
}

export function sameRoad(a, b) {
  return Boolean(a && b) && a.kind === b.kind && a.prefix === b.prefix && a.number === b.number;
}

/// Every highway named in the text ("I 95 / J F K Memorial Hwy" names I-95).
export function roadRefs(text) {
  return text ? parseHighways(String(text).toUpperCase().replace(/INTERSTATE/g, 'I')) : [];
}

/// Is the incident's road the route's road at `d`? A highway must be one the route is on there (all its
/// names count, as where I-95 runs on the New Jersey Turnpike). A named road that is not a highway (a
/// street, a county road) is never the route's road while the route is on a highway there. No name: unknown.
function onSameRoad(route, i, d) {
  if (!i.road) return true;
  const here = route.stepAt?.(d)?.highways ?? (route.highwayAt(d) ? [route.highwayAt(d).ref] : []);
  const refs = roadRefs(i.road);
  if (refs.length) return refs.some((r) => here.some((h) => sameRoad(r, h)));
  return here.length === 0;
}

/// "Northbound", "NB", "north", "both directions" as 'N' | 'S' | 'E' | 'W' | 'both', else null.
export function directionCode(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  if (/both|all|two.?way|\band\b/.test(t)) return 'both';
  if (/^(n|nb|north|northbound)$/.test(t)) return 'N';
  if (/^(s|sb|south|southbound)$/.test(t)) return 'S';
  if (/^(e|eb|east|eastbound)$/.test(t)) return 'E';
  if (/^(w|wb|west|westbound)$/.test(t)) return 'W';
  return null;
}

/// Is the incident current at `now`? Expired, ended or not yet started events are not.
export function isCurrent(i, now) {
  if (i.expiresAt != null && i.expiresAt <= now) return false;
  if (i.endsAt != null && i.endsAt <= now) return false;
  return true;
}

/// Where a point incident sits on the route ahead, or why it does not.
function matchPoint(route, c, i, progress, rules) {
  const radius = roadRefs(i.road).length ? rules.sameRoadOffset : rules.unnamedOffset;
  let best = null, why = 'off route';
  for (const p of route.polyline.projections(c, radius)) {
    if (p.distanceAlong < progress) { why = 'behind'; continue; }
    const hw = route.highwayAt(p.distanceAlong);
    if (!onSameRoad(route, i, p.distanceAlong)) { why = 'other road'; continue; }
    const dir = directionCode(i.direction);
    const travel = hw?.direction ?? cardinalOf(route.polyline.bearingAt(p.distanceAlong));
    if (dir && dir !== 'both' && dir !== travel) { why = 'other direction'; continue; }
    if (!dir && p.signedOffset < -rules.otherCarriageway) { why = 'other direction'; continue; }
    if (!best || p.distanceAlong < best.distanceAlong) best = { distanceAlong: p.distanceAlong, directionKnown: Boolean(dir) };
  }
  return best ? { start: best.distanceAlong, end: best.distanceAlong, directionKnown: best.directionKnown } : { why };
}

/// A line (work zone, closure extent): its vertices must run along the route in the travel direction.
function matchLine(route, coords, i, progress, rules) {
  const along = [];
  for (const c of coords) {
    const p = route.polyline.nearestProjection(c, rules.lineOffset);
    if (p) along.push(p.distanceAlong);
  }
  if (along.length < Math.min(2, coords.length)) return { why: 'off route' };
  const start = Math.min(...along), end = Math.max(...along);
  if (end < progress) return { why: 'behind' };
  const mid = (start + end) / 2;
  const hw = route.highwayAt(mid);
  if (!onSameRoad(route, i, mid)) return { why: 'other road' };
  const travel = hw?.direction ?? cardinalOf(route.polyline.bearingAt(mid));
  const dir = directionCode(i.direction);
  if (dir && dir !== 'both' && dir !== travel) return { why: 'other direction' };
  if (!dir && coords.length >= 2) {
    // No direction field: the line drawn in the travel direction agrees with the route's bearing.
    const bearing = initialBearing(coords[0], coords[coords.length - 1]);
    if (angleDifference(bearing, route.polyline.bearingAt(mid)) > rules.lineBearing) return { why: 'other direction' };
  }
  return { start: Math.max(start, progress), end, directionKnown: Boolean(dir) || coords.length >= 2 };
}

/// An area (weather polygon): the stretch of route ahead inside it, its edges refined to about 10 m.
function matchArea(route, rings, progress, window, rules) {
  const inside = (d) => rings.some((ring) => inRing(route.polyline.coordinateAt(d), ring));
  // Bisects between an outside and an inside position.
  const edge = (out, inn) => {
    while (Math.abs(inn - out) > 10) { const mid = (out + inn) / 2; if (inside(mid)) inn = mid; else out = mid; }
    return inn;
  };
  let start = null, end = null, last = progress;
  const stop = Math.min(route.polyline.length, progress + window);
  for (let d = progress; d <= stop; d += rules.areaStep) {
    if (inside(d)) {
      if (start === null) start = d === progress ? d : edge(last, d);
      end = d;
    } else if (start !== null) { end = edge(d, end); break; }
    last = d;
  }
  return start === null ? { why: 'off route' } : { start, end, directionKnown: true };
}

/// Ray casting; rings are [[lon, lat], ...] as in GeoJSON.
function inRing(c, ring) {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a], [xb, yb] = ring[b];
    if ((ya > c.lat) !== (yb > c.lat) && c.lon < ((xb - xa) * (c.lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

function cardinalOf(bearing) {
  const b = ((bearing % 360) + 360) % 360;
  return b < 45 || b >= 315 ? 'N' : b < 135 ? 'E' : b < 225 ? 'S' : 'W';
}

/// One incident against the route ahead: {start, end, directionKnown} in meters along the route, or {why}.
export function matchIncident(route, i, progress, rules = MATCH_RULES) {
  const g = i.geometry;
  if (!g) return { why: 'no location' };
  if (g.type === 'point') return matchPoint(route, g.coordinate, i, progress, rules);
  if (g.type === 'points') {
    // Sample points on the route (an area alert queried by point): each is on the route by construction.
    const hits = g.coordinates.map((c) => route.polyline.nearestProjection(c, rules.unnamedOffset)).filter(Boolean)
      .map((p) => p.distanceAlong).filter((d) => d >= progress);
    // Where it starts and ends between the sample points is not known, so the extent is approximate.
    return hits.length ? { start: Math.min(...hits), end: Math.max(...hits), directionKnown: true, approximate: true } : { why: 'off route' };
  }
  if (g.type === 'line') return matchLine(route, g.coordinates, i, progress, rules);
  if (g.type === 'polygon') return matchArea(route, g.rings, progress, rules.window, rules);
  return { why: 'no location' };
}

/// Serious events take the Drive screen's focus from farther away and come before recommendations.
export function isSerious(i) {
  if (i.category === 'closure') return true;
  if (i.severity === 'severe' || i.severity === 'major') return ['crash', 'weather', 'flooding', 'hazard'].includes(i.category);
  return false;
}

/// Worth the Drive screen and a spoken warning: everything except a work zone that leaves the travel lanes
/// open or does not say (those stay in Road Ahead).
export function isNotable(i) {
  return isSerious(i) || !(i.category === 'construction' && (i.severity === 'minor' || i.severity === 'unknown'));
}

const VERIFICATION_ORDER = { official: 0, community: 1, mapped: 2 };
const SEVERITY_ORDER = { severe: 0, major: 1, moderate: 2, minor: 3, unknown: 4 };

/// Keeps one alert per real event: same group of kinds, same direction, overlapping or within `duplicate`.
/// The one kept is the best verified, then the most severe (it carries lane details), then the latest.
export function dedupe(alerts, rules = MATCH_RULES) {
  const rank = (x, table) => table[x] ?? 9;
  const sorted = [...alerts].sort((a, b) => rank(a.incident.verification, VERIFICATION_ORDER) - rank(b.incident.verification, VERIFICATION_ORDER)
    || rank(a.incident.severity, SEVERITY_ORDER) - rank(b.incident.severity, SEVERITY_ORDER)
    || (b.incident.updatedAt ?? 0) - (a.incident.updatedAt ?? 0) || (a.incident.id < b.incident.id ? -1 : 1));
  const kept = [];
  for (const a of sorted) {
    const same = kept.find((k) => sameEvent(k, a, rules));
    if (same) {
      if (!same.sources.some((s) => s.id === a.incident.source.id)) same.sources.push(a.incident.source);
      continue;
    }
    kept.push({ ...a, sources: [a.incident.source] });
  }
  return kept.sort((a, b) => a.start - b.start || ALERT_KINDS[a.incident.category].rank - ALERT_KINDS[b.incident.category].rank);
}

function sameEvent(a, b, rules) {
  const fam = (c) => (c === 'crash' || c === 'disabledVehicle' || c === 'hazard' ? 'incident' : c);
  if (fam(a.incident.category) !== fam(b.incident.category)) return false;
  const da = directionCode(a.incident.direction), db = directionCode(b.incident.direction);
  if (da && db && da !== 'both' && db !== 'both' && da !== db) return false;
  return a.start <= b.end + rules.duplicate && b.start <= a.end + rules.duplicate;
}

/// Alerts on the route ahead and a status for each Settings group.
///   route: {polyline, highwayAt(d)}; progress: meters driven along it
///   providers: [{id, name, kinds: [...], state: 'ok' | 'pending' | 'error' | 'notConfigured' | 'unsupported',
///               fetchedAt, maxAgeSeconds, incidents: [...], uncovered: ['GA', ...]}]
///   options: {now, enabled: {group: bool}, window, etaAt(meters) -> unix seconds}
/// Returns {alerts: [{incident, start, end, ahead, serious, notable, directionKnown, approximate, sources}], status: {group: {state, label, note}}}.
/// `approximate`: an area alert known only at sample points; its extent along the route is not known.
export function roadIntel(route, progress, providers, { now, enabled = {}, window = MATCH_RULES.window, etaAt = null, rules = MATCH_RULES } = {}) {
  const r = { ...rules, window };
  const matched = [];
  const expiredByGroup = {};
  const fresh = (p) => p.state === 'ok' && p.fetchedAt != null && now - p.fetchedAt <= (p.maxAgeSeconds ?? 900);
  for (const p of providers) {
    if (!fresh(p)) continue;
    for (const i of p.incidents ?? []) {
      const kind = ALERT_KINDS[i.category] ? i.category : 'other';
      const group = ALERT_KINDS[kind].group;
      if (enabled[group] === false) continue;
      const m = matchIncident(route, { ...i, category: kind }, progress, r);
      if (m.start === undefined || m.start - progress > window) continue;
      // Current at the time you get there: expired, ended, or not yet started by then is left out.
      const at = etaAt ? etaAt(m.start) : now;
      if (!isCurrent(i, now) || (i.endsAt != null && i.endsAt <= at)) { expiredByGroup[group] = true; continue; }
      if (i.startsAt != null && etaAt && i.startsAt > etaAt(m.end)) continue;
      const incident = { ...i, category: kind };
      matched.push({ incident, start: m.start, end: m.end, ahead: m.start - progress, directionKnown: m.directionKnown,
        approximate: Boolean(m.approximate), serious: isSerious(incident), notable: isNotable(incident) });
    }
  }
  const alerts = dedupe(matched, r);
  const status = {};
  for (const [group, g] of Object.entries(ALERT_GROUPS)) {
    status[group] = groupStatus(group, g, providers, alerts, expiredByGroup[group], enabled, fresh);
  }
  return { alerts, status };
}

function groupStatus(group, g, providers, alerts, expired, enabled, fresh) {
  const make = (state, note = null) => ({ state, label: STATUS_LABELS[state], note });
  if (enabled[group] === false) return make('off');
  const covering = providers.filter((p) => (p.kinds ?? []).some((k) => g.kinds.includes(k)));
  if (!covering.length || covering.every((p) => p.state === 'notConfigured')) return make('notConfigured');
  if (covering.every((p) => p.state === 'unsupported' || p.state === 'notConfigured')) return make('unsupported');
  const usable = covering.filter(fresh);
  const failed = covering.filter((p) => p.state === 'error' || (p.state === 'ok' && !fresh(p)));
  const uncovered = [...new Set(usable.flatMap((p) => p.uncovered ?? []))];
  const coverageNote = uncovered.length ? `No coverage in ${uncovered.join(', ')}` : null;
  if (alerts.some((a) => g.kinds.includes(a.incident.category))) {
    return make('ok', failed.length ? `${failed.map((p) => p.name).join(', ')} unavailable` : coverageNote);
  }
  // Never an "all clear" while a source that covers this group failed or has not answered yet.
  if (!failed.length && covering.some((p) => p.state === 'pending')) return make('loading');
  if (!usable.length || failed.length) return make('unavailable', failed.length ? `${failed.map((p) => p.name).join(', ')} unavailable` : null);
  if (expired) return make('expired');
  return make('noRelevant', coverageNote);
}

/// "Reported 6 minutes ago", "Updated 2 h ago".
export function freshnessText(i, now) {
  const t = i.updatedAt ?? i.reportedAt;
  if (t == null) return 'Time not reported';
  const min = Math.max(0, Math.round((now - t) / 60));
  const ago = min < 1 ? 'just now' : min < 60 ? `${min} ${min === 1 ? 'minute' : 'minutes'} ago` : `${Math.round(min / 60)} h ago`;
  return `${i.updatedAt != null && i.reportedAt != null && i.updatedAt !== i.reportedAt ? 'Updated' : 'Reported'} ${ago}`;
}
