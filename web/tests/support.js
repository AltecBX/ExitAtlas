// Loads the bundled datasets and the route fixtures shared with the Swift tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RegionIndex, InterstateDataset, CombinedExitDataset, CorridorDataset, TimeZoneResolver } from '../js/engine/datasets.js';
import { routeFromJSON } from '../js/engine/osrm.js';
import { RestAreaDataset } from '../js/engine/restareas.js';
import { DiscoverDataset } from '../js/engine/discover.js';
import { decodePolyline, encodePolyline, distance } from '../js/engine/geo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.join(root, 'App/ExitAtlas/Resources/Data');
const fixtureDir = path.join(root, 'Tests/ExitAtlasCoreTests/Fixtures');

function buffer(file) {
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

let cache = {};
export const data = {
  get states() { return (cache.states ??= new RegionIndex(buffer(path.join(dataDir, 'states.eab')))); },
  get timeZoneIndex() { return (cache.tz ??= new RegionIndex(buffer(path.join(dataDir, 'timezones.eab')))); },
  get timeZones() { return (cache.tzr ??= new TimeZoneResolver(this.timeZoneIndex)); },
  get interstates() { return (cache.ix ??= new InterstateDataset(buffer(path.join(dataDir, 'interstates.eax')))); },
  get freeways() { return (cache.fw ??= new InterstateDataset(buffer(path.join(dataDir, 'freeways.eax')))); },
  /// What the app routes with: interstate exits and the other freeways' exits as one dataset.
  get exits() { return (cache.ex ??= new CombinedExitDataset([this.interstates, this.freeways])); },
  get corridors() { return (cache.cx ??= new CorridorDataset(buffer(path.join(dataDir, 'corridors.eac')))); },
  get discover() { return (cache.dc ??= new DiscoverDataset(JSON.parse(readFileSync(path.join(dataDir, 'discover.json'), 'utf8')))); },
  get restAreas() { return (cache.ra ??= new RestAreaDataset(JSON.parse(readFileSync(path.join(dataDir, 'restareas.json'), 'utf8')))); },
};

export function load(name) {
  return {
    fixture: JSON.parse(readFileSync(path.join(fixtureDir, `${name}.route.json`), 'utf8')),
    expected: JSON.parse(readFileSync(path.join(fixtureDir, `${name}.expected.json`), 'utf8')),
  };
}

export function route(name) {
  return routeFromJSON(load(name).fixture, { source: 'testFixture', createdAt: 1793000000000 });
}

export const START = 1793000000;

export function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`);
  }
}

/// A recorded OSRM answer (raw response, trimmed to the fields ExitAtlas reads) from Fixtures/reroute.
export function loadOSRM(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, 'reroute', `${name}.osrm.json`), 'utf8'));
}

/// A recorded OSRM answer as if asked from `start`, a point on its routes a little after where it was asked
/// from: each route from its point nearest to `start` on, with its own durations and steps from there. For
/// faking a reroute request from wherever the simulated driver is.
export function osrmAnswerFrom(answer, start) {
  const routes = answer.routes.map((r) => {
    const pts = decodePolyline(r.geometry, 6);
    const leg = r.legs[0], durations = leg.annotation.duration;
    let k = 0, best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) { const d = distance(start, pts[i]); if (d < best) { best = d; k = i; } }
    const first = distance(start, pts[k + 1]), span = distance(pts[k], pts[k + 1]);
    let cut = -first;
    for (let i = 0; i <= k; i++) cut += distance(pts[i], pts[i + 1]);
    const steps = [];
    let at = 0;
    for (const s of leg.steps) {
      const end = at + s.distance;
      if (end > cut || s === leg.steps[leg.steps.length - 1]) steps.push({ ...s, distance: end - Math.max(at, cut) });
      at = end;
    }
    const duration = [span > 0 ? durations[k] * first / span : 0, ...durations.slice(k + 1)];
    const total = duration.reduce((a, b) => a + b, 0);
    return { ...r, geometry: encodePolyline([start, ...pts.slice(k + 1)], 6), duration: total, weight: total,
      legs: [{ ...leg, duration: total, annotation: { duration }, steps }] };
  });
  return { ...answer, waypoints: [{ name: answer.waypoints[0].name, location: [start.lon, start.lat] }, ...answer.waypoints.slice(1)], routes };
}
