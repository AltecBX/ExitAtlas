// Planned route model, highway refs and travel time profile. Port of Route/*.swift.
import { metersPerDegreeLatitude, metersPerDegreeLongitude } from './geo.js';

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'SR', 'CR', 'PR',
]);

/// Highway designations found in a string, in order of appearance, without duplicates.
/// Each ref is {kind: 'interstate'|'usRoute'|'stateRoute'|'named', prefix, number}.
export function parseHighways(text) {
  const found = [];
  const scan = (re, make) => {
    for (const m of text.matchAll(re)) {
      const ref = make(m);
      if (ref) found.push([m.index, ref]);
    }
  };
  scan(/\b(?:I|Interstate)[- ]?(\d{1,3}[A-Z]?)\b/g, (m) => ({ kind: 'interstate', prefix: 'I', number: m[1] }));
  scan(/\bUS[- ]?(\d{1,3}[A-Z]?)\b/g, (m) => ({ kind: 'usRoute', prefix: 'US', number: m[1] }));
  scan(/\b([A-Z]{2})[- ](\d{1,4}[A-Z]?)\b/g, (m) => (
    STATE_CODES.has(m[1]) && m[1] !== 'US' ? { kind: 'stateRoute', prefix: m[1], number: m[2] } : null));
  scan(/\b((?:[A-Z][\w']*\s){0,3}Turnpike|NJTP|Parkway|Expressway|Thruway)\b/gi, (m) => {
    const name = m[1].trim();
    return { kind: 'named', prefix: '', number: name === 'NJTP' ? 'New Jersey Turnpike' : name };
  });
  found.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [, ref] of found) {
    if (!out.some((r) => r.kind === ref.kind && r.prefix === ref.prefix && r.number === ref.number)) out.push(ref);
  }
  return out;
}

export function highwayLabel(ref) {
  return ref.kind === 'named' ? ref.number : `${ref.prefix}-${ref.number}`;
}

function numericValue(ref) {
  const m = /^\d+/.exec(ref.number);
  return m ? parseInt(m[0], 10) : null;
}

export const DIRECTION_WORDS = { N: 'North', S: 'South', E: 'East', W: 'West' };

/// Signed direction for a highway at a point. Odd interstates are north/south, even east/west,
/// signed by net displacement over the next 25 km so local curves do not flip it.
export function signedDirection(ref, route, distance, window = 25000) {
  let start = distance, end = Math.min(route.length, distance + window);
  if (end - start < window / 2) start = Math.max(0, end - window);
  if (end <= start) end = Math.min(route.length, start + 1);
  const a = route.coordinateAt(start), b = route.coordinateAt(end);
  const north = (b.lat - a.lat) * metersPerDegreeLatitude(a.lat);
  const east = (b.lon - a.lon) * metersPerDegreeLongitude(a.lat);
  const n = ref && ref.kind === 'interstate' ? numericValue(ref) : null;
  if (n !== null) {
    const base = n % 100;
    return base % 2 === 1 ? (north >= 0 ? 'N' : 'S') : (east >= 0 ? 'E' : 'W');
  }
  if (Math.abs(north) >= Math.abs(east)) return north >= 0 ? 'N' : 'S';
  return east >= 0 ? 'E' : 'W';
}

/// Piecewise linear model of expected elapsed seconds along the route.
export class TravelTimeProfile {
  constructor(distances, seconds) {
    if (distances.length !== seconds.length || !distances.length) throw new Error('bad travel time profile');
    this.distances = distances;
    this.seconds = seconds;
  }

  static uniform(length, totalSeconds) {
    return new TravelTimeProfile([0, Math.max(length, 0)], [0, Math.max(totalSeconds, 0)]);
  }

  /// Per polyline segment durations (OSRM annotations).
  static fromSegments(polyline, segmentDurations) {
    if (segmentDurations.length !== polyline.segmentCount) throw new Error('segment duration count mismatch');
    const secs = new Float64Array(polyline.pointCount);
    for (let i = 0; i < segmentDurations.length; i++) secs[i + 1] = secs[i] + Math.max(segmentDurations[i], 0);
    return new TravelTimeProfile(polyline.cum, secs);
  }

  get totalSeconds() { return this.seconds[this.seconds.length - 1]; }

  secondsAt(distance) {
    const d = this.distances, s = this.seconds;
    if (distance <= d[0]) return s[0];
    if (distance >= d[d.length - 1]) return s[s.length - 1];
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= distance) lo = mid; else hi = mid;
    }
    const span = d[hi] - d[lo];
    const t = span > 0 ? (distance - d[lo]) / span : 0;
    return s[lo] + (s[hi] - s[lo]) * t;
  }

  secondsBetween(start, end) {
    return Math.max(0, this.secondsAt(end) - this.secondsAt(start));
  }

  /// Distance reached after driving `elapsed` seconds from `start`.
  distanceAfter(elapsed, start) {
    const d = this.distances, s = this.seconds;
    const target = this.secondsAt(start) + elapsed;
    if (target <= s[0]) return d[0];
    if (target >= this.totalSeconds) return d[d.length - 1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= target) lo = mid; else hi = mid;
    }
    const span = s[hi] - s[lo];
    const t = span > 0 ? (target - s[lo]) / span : 0;
    return d[lo] + (d[hi] - d[lo]) * t;
  }

  /// Expected speed (m/s) at a distance.
  speedAt(distance, window = 200) {
    const d = this.distances;
    const a = Math.max(d[0], distance - window), b = Math.min(d[d.length - 1], distance + window);
    const dt = this.secondsBetween(a, b);
    return dt > 0 ? (b - a) / dt : 0;
  }
}

let routeCounter = 0;

/// The selected route: geometry, maneuvers and the travel time model.
/// steps: [{startDistance, length, instruction, roadName, highways}]
/// stops: [{id, waypoint:{name, coordinate}, distanceAlongRoute, plannedDwell}]
export class PlannedRoute {
  constructor({ source, polyline, steps = [], timeProfile, origin, destination, stops = [], hasTolls = null,
    createdAt = Date.now(), title = null, id = null }) {
    routeCounter += 1;
    this.id = id ?? `route-${Date.now().toString(36)}-${routeCounter}`;
    this.source = source;
    this.polyline = polyline;
    this.steps = steps;
    this.timeProfile = timeProfile;
    this.origin = origin;
    this.destination = destination;
    this.stops = stops;
    this.hasTolls = hasTolls;
    this.createdAt = createdAt;
    this.title = title;
  }

  get length() { return this.polyline.length; }

  stepAt(distance) {
    const s = this.steps;
    if (!s.length) return null;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].startDistance <= distance) lo = mid; else hi = mid - 1;
    }
    return s[lo];
  }

  /// The highway being driven at a distance, with signed direction: {ref, direction}.
  highwayAt(distance) {
    const step = this.stepAt(distance);
    const ref = step?.highways?.[0];
    if (!ref) return null;
    return { ref, direction: signedDirection(ref, this.polyline, distance) };
  }
}

export function makeStep(startDistance, length, instruction, roadName, highways = null) {
  return { startDistance, length, instruction, roadName, highways: highways ?? parseHighways(`${roadName} ${instruction}`) };
}
