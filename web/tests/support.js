// Loads the bundled datasets and the route fixtures shared with the Swift tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RegionIndex, InterstateDataset, CorridorDataset, TimeZoneResolver } from '../js/engine/datasets.js';
import { routeFromJSON } from '../js/engine/osrm.js';
import { RestAreaDataset } from '../js/engine/restareas.js';

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
  get corridors() { return (cache.cx ??= new CorridorDataset(buffer(path.join(dataDir, 'corridors.eac')))); },
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
