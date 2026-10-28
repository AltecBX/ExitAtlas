// Builds PlannedRoute objects from OSRM responses and from the bundled route JSON files.
import { RoutePolyline, decodePolyline } from './geo.js';
import { PlannedRoute, TravelTimeProfile, makeStep } from './route.js';

/// Points plus per segment durations, dropping zero length segments (their time moves to the
/// previous segment) so durations stay aligned with the polyline the engine builds.
function alignedGeometry(coords, durations) {
  const pts = [coords[0]];
  const segs = [];
  const indexMap = [0];
  for (let i = 1; i < coords.length; i++) {
    const prev = pts[pts.length - 1];
    const dur = durations[i - 1] ?? 0;
    if (coords[i].lat === prev.lat && coords[i].lon === prev.lon) {
      if (segs.length) segs[segs.length - 1] += dur;
    } else {
      pts.push(coords[i]);
      segs.push(dur);
    }
    indexMap.push(pts.length - 1);
  }
  return { pts, segs, indexMap };
}

function stepsFromRaw(raw, totalLength) {
  const sum = raw.reduce((s, x) => s + x.distance, 0);
  const scale = sum > 0 ? totalLength / sum : 1;
  const steps = [];
  let cursor = 0;
  for (const s of raw) {
    const length = s.distance * scale;
    const road = s.ref ? `${s.ref} ${s.name}` : s.name;
    steps.push(makeStep(cursor, length, `${s.maneuver} ${s.modifier}`.trim(), road));
    cursor += length;
  }
  return steps;
}

/// One OSRM route (geometries=polyline6, steps=true, annotations=duration) as a PlannedRoute.
/// waypoints: [{name, coordinate}] origin, stops..., destination (same order as the request).
export function routeFromOSRM(osrmRoute, waypoints, { createdAt = Date.now(), dwellSeconds = 0 } = {}) {
  const coords = decodePolyline(osrmRoute.geometry, 6);
  if (!coords || coords.length < 2) throw new Error('OSRM returned no geometry');
  const durations = [];
  const legEnds = [];
  const raw = [];
  let hasTolls = false;
  for (const leg of osrmRoute.legs) {
    for (const d of leg.annotation?.duration ?? []) durations.push(d);
    legEnds.push(durations.length);
    for (const s of leg.steps ?? []) {
      raw.push({
        name: s.name ?? '', ref: s.ref ?? '', distance: s.distance ?? 0,
        maneuver: s.maneuver?.type ?? '', modifier: s.maneuver?.modifier ?? '',
      });
      for (const x of s.intersections ?? []) if ((x.classes ?? []).includes('toll')) hasTolls = true;
    }
  }
  const { pts, segs, indexMap } = alignedGeometry(coords, durations);
  const polyline = new RoutePolyline(pts);
  let timeProfile;
  if (durations.length === coords.length - 1 && segs.length === polyline.segmentCount) {
    timeProfile = TravelTimeProfile.fromSegments(polyline, segs);
  } else {
    timeProfile = TravelTimeProfile.uniform(polyline.length, osrmRoute.duration ?? 0);
  }
  const stops = [];
  for (let k = 0; k < legEnds.length - 1 && k + 1 < waypoints.length - 1; k++) {
    const pointIndex = indexMap[Math.min(legEnds[k], indexMap.length - 1)];
    stops.push({
      id: `stop-${k}`, waypoint: waypoints[k + 1], distanceAlongRoute: polyline.cum[pointIndex], plannedDwell: dwellSeconds,
    });
  }
  return new PlannedRoute({
    source: 'osrm', polyline, steps: stepsFromRaw(raw, polyline.length), timeProfile,
    origin: waypoints[0], destination: waypoints[waypoints.length - 1], stops, hasTolls, createdAt,
  });
}

/// Bundled route JSON (tests/fixtures and the demo trip): coordinates [[lat, lon]], segment_durations_s, steps.
export function routeFromJSON(file, { source = 'osrm', origin = null, destination = null, title = null, createdAt = Date.now() } = {}) {
  const coords = file.coordinates.map(([lat, lon]) => ({ lat, lon }));
  const polyline = new RoutePolyline(coords);
  const timeProfile = file.segment_durations_s.length === polyline.segmentCount
    ? TravelTimeProfile.fromSegments(polyline, file.segment_durations_s)
    : TravelTimeProfile.uniform(polyline.length, file.segment_durations_s.reduce((a, b) => a + b, 0));
  const steps = [];
  let cursor = 0;
  for (const s of file.steps) {
    const road = s.ref ? `${s.ref} ${s.name}` : s.name;
    steps.push(makeStep(cursor, s.distance_m, `${s.maneuver} ${s.modifier}`, road));
    cursor += s.distance_m;
  }
  return new PlannedRoute({
    source, polyline, steps, timeProfile,
    origin: origin ?? { name: 'Origin', coordinate: coords[0] },
    destination: destination ?? { name: 'Destination', coordinate: coords[coords.length - 1] },
    title, createdAt,
  });
}

/// Compact serialization of a route for resuming a trip after the page reloads.
export function serializeRoute(route) {
  const p = route.polyline;
  const lat = Array.from(p.lat, (v) => Math.round(v * 1e6) / 1e6);
  const lon = Array.from(p.lon, (v) => Math.round(v * 1e6) / 1e6);
  return {
    v: 1, id: route.id, source: route.source, lat, lon,
    tpd: Array.from(route.timeProfile.distances), tps: Array.from(route.timeProfile.seconds),
    steps: route.steps.map((s) => [s.startDistance, s.length, s.instruction, s.roadName]),
    origin: route.origin, destination: route.destination, stops: route.stops,
    hasTolls: route.hasTolls, createdAt: route.createdAt, title: route.title,
  };
}

export function deserializeRoute(json) {
  const pts = json.lat.map((lat, i) => ({ lat, lon: json.lon[i] }));
  const polyline = new RoutePolyline(pts);
  let timeProfile;
  if (json.tpd.length === polyline.pointCount) {
    // Distances were saved from the original polyline; rescale to this one exactly.
    timeProfile = new TravelTimeProfile(polyline.cum, json.tps);
  } else {
    timeProfile = new TravelTimeProfile(json.tpd, json.tps);
  }
  return new PlannedRoute({
    id: json.id, source: json.source, polyline, timeProfile,
    steps: json.steps.map(([a, b, c, d]) => makeStep(a, b, c, d)),
    origin: json.origin, destination: json.destination, stops: json.stops,
    hasTolls: json.hasTolls, createdAt: json.createdAt, title: json.title,
  });
}
