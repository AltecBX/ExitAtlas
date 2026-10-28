// Builds Tests/ExitAtlasCoreTests/Fixtures/roadintel/cases.json: Road Intelligence cases on the real Miami to
// Manhattan route. Positions are real: points on the route, the southbound I-95 carriageway from the bundled
// OpenInterstate corridors, and a real hotel beside the highway. The events are simulated test data.
// Run: node tests/make_roadintel_fixture.js (from web/)
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { data, route, START } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';

const r = route('miami_to_manhattan');
const at = (mi) => { const c = r.polyline.coordinateAt(mi * MILE); return [round(c.lat), round(c.lon)]; };
const round = (v) => Math.round(v * 1e6) / 1e6;
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

for (const mi of [136, 140, 150, 160, 170, 180]) assert(r.highwayAt(mi * MILE)?.ref?.number === '95', `mile ${mi} is not I-95`);
assert(r.highwayAt(150 * MILE).direction === 'N', 'route is northbound');

/// The southbound carriageway beside route mile `mi` (real OSM geometry via OpenInterstate corridors).
function southbound(mi) {
  const d = mi * MILE, c = r.polyline.coordinateAt(d);
  const m = data.corridors.matches(c, (r.polyline.bearingAt(d) + 180) % 360, 400).find((x) => x.corridor.directionCode === 'SB');
  assert(m, `no southbound corridor at mile ${mi}`);
  return [round(m.projection.point.lat), round(m.projection.point.lon)];
}

const now = START;
const pt = (lat, lon) => ({ type: 'point', coordinate: { lat, lon } });
const pointAt = (mi) => pt(...at(mi));
const base = { reportedAt: now - 600, updatedAt: now - 600, startsAt: null, endsAt: null, expiresAt: null, lanes: null, severity: 'unknown' };
const hotel = { lat: 27.6375432, lon: -80.5182521 }; // Country Inn & Suites, I-95 Exit 147 (OpenInterstate place), about 107 m from the route
const box = (lat, lon, d) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
const [wLat, wLon] = at(170);
// Where the route enters the weather box, found by walking the route (independent of the engine's polygon test).
let weatherEntry = null;
for (let mi = 136; mi <= 200 && weatherEntry === null; mi += 0.05) {
  const c = r.polyline.coordinateAt(mi * MILE);
  if (Math.abs(c.lat - wLat) <= 0.05 && Math.abs(c.lon - wLon) <= 0.05) weatherEntry = Math.round((mi - 136) * 10) / 10;
}

const incidents = {
  police2: { ...base, id: 'test:police2', category: 'police', description: 'Police reported (simulated test report)', verification: 'community',
    source: { id: 'testCommunity', name: 'Test reports' }, geometry: pointAt(138), road: 'I-95', direction: 'N', reportedAt: now - 360, updatedAt: now - 360, expiresAt: now + 1440 },
  policeExpired: { ...base, id: 'test:policeOld', category: 'police', description: 'Police reported (simulated, expired)', verification: 'community',
    source: { id: 'testCommunity', name: 'Test reports' }, geometry: pointAt(139), road: 'I-95', direction: 'N', reportedAt: now - 3600, updatedAt: now - 3600, expiresAt: now - 60 },
  oppositeS: { ...base, id: 'test511:opp', category: 'crash', description: 'Crash on the southbound side (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pt(...southbound(150)), road: 'I-95', direction: 'S', severity: 'major' },
  oppositeNoDirection: { ...base, id: 'test511:oppnodir', category: 'hazard', description: 'Debris, direction not given (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pt(...southbound(150)), road: 'I-95', direction: null },
  parallelRoad: { ...base, id: 'test511:sr60', category: 'crash', description: 'Crash on SR 60 at the hotel entrance (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pt(hotel.lat, hotel.lon), road: 'SR 60', direction: 'E' },
  unnamedNearby: { ...base, id: 'test511:unnamed', category: 'hazard', description: 'Hazard with no road name beside the highway (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pt(hotel.lat, hotel.lon), road: null, direction: null },
  behind: { ...base, id: 'test511:behind', category: 'disabledVehicle', description: 'Disabled vehicle behind you (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pointAt(133), road: 'I-95', direction: 'N' },
  workZone: { ...base, id: 'testWzdx:wz1', category: 'construction', description: 'Right lane closed (simulated work zone)', verification: 'official',
    source: { id: 'testWzdx', name: 'Test work zones' }, road: 'I-95', direction: null, lanes: 'Right lane closed',
    geometry: { type: 'line', coordinates: [145, 145.5, 146, 146.5, 147].map((mi) => { const [lat, lon] = at(mi); return { lat, lon }; }) } },
  workZoneOpposite: { ...base, id: 'testWzdx:wz2', category: 'construction', description: 'Work zone on the southbound side (simulated)', verification: 'official',
    source: { id: 'testWzdx', name: 'Test work zones' }, road: 'I-95', direction: null,
    geometry: { type: 'line', coordinates: [162, 161.5, 161, 160.5, 160].map((mi) => { const [lat, lon] = southbound(mi); return { lat, lon }; }) } },
  workZoneEndsSoon: { ...base, id: 'testWzdx:wz3', category: 'construction', description: 'Overnight lane closure ending in 10 minutes (simulated)', verification: 'official',
    source: { id: 'testWzdx', name: 'Test work zones' }, road: 'I-95', direction: 'N', endsAt: now + 600, geometry: pointAt(186) },
  weather: { ...base, id: 'testNws:w1', category: 'weather', description: 'Severe Thunderstorm Warning (simulated polygon)', verification: 'official',
    source: { id: 'testNws', name: 'Test weather' }, road: null, direction: 'both', severity: 'major', expiresAt: now + 3600,
    geometry: { type: 'polygon', rings: box(wLat, wLon, 0.05) } },
  crashA: { ...base, id: 'test511:crash', category: 'crash', description: 'Crash, 2 right lanes blocked (simulated)', verification: 'official',
    source: { id: 'test511', name: 'Test 511' }, geometry: pointAt(180), road: 'I-95', direction: 'N', severity: 'major', lanes: '2 right lanes blocked' },
  crashB: { ...base, id: 'testFeed:crash', category: 'crash', description: 'Accident (simulated second source)', verification: 'official',
    source: { id: 'testFeed', name: 'Test feed' }, geometry: pointAt(180.15), road: 'Interstate 95', direction: 'Northbound', updatedAt: now - 300 },
};

const provider = (id, name, kinds, ids, extra = {}) => ({ id, name, kinds, state: 'ok', fetchedAt: now - 60, maxAgeSeconds: 900, incidents: ids, ...extra });
const all511 = ['oppositeS', 'oppositeNoDirection', 'parallelRoad', 'unnamedNearby', 'behind', 'crashA'];
const incidentKinds = ['closure', 'crash', 'hazard', 'disabledVehicle', 'congestion', 'other'];

const file = {
  comment: 'Road Intelligence on the real Miami to Manhattan route (northbound I-95), shared by web/tests/roadintel.test.js and RoadIntelTests.swift. Positions are real (route points, the southbound carriageway from OpenInterstate corridors, a hotel beside Exit 147); every event is SIMULATED TEST DATA. Built by web/tests/make_roadintel_fixture.js. Distances in miles, times in unix seconds.',
  route: 'miami_to_manhattan', progressMiles: 136, now,
  // Arrival times for start and end checks: now plus the distance at this speed (about 67 mph).
  speedMetersPerSecond: 30,
  incidents,
  matches: {
    police2: { aheadMiles: 2 }, oppositeS: { why: 'other direction' }, oppositeNoDirection: { why: 'other direction' },
    parallelRoad: { why: 'other road' }, unnamedNearby: { why: 'off route' }, behind: { why: 'behind' },
    workZone: { aheadMiles: 9, endMiles: 11 }, workZoneOpposite: { why: 'other direction' }, weather: { aheadMiles: weatherEntry },
  },
  scenarios: [
    { name: 'All sources working: one alert per real event, in route order',
      providers: [provider('test511', 'Test 511', incidentKinds, [...all511, 'crashB'].filter((k) => k !== 'crashB')),
        provider('testFeed', 'Test feed', ['crash'], ['crashB']),
        provider('testWzdx', 'Test work zones', ['construction'], ['workZone', 'workZoneOpposite', 'workZoneEndsSoon']),
        provider('testNws', 'Test weather', ['weather', 'flooding'], ['weather']),
        provider('testCommunity', 'Test reports', ['police'], ['police2', 'policeExpired'])],
      expect: { alerts: [['police2', 2, ['testCommunity']], ['workZone', 9, ['testWzdx']], ['weather', weatherEntry, ['testNws']], ['crashA', 44, ['test511', 'testFeed']]],
        status: { closures: 'ok', incidents: 'ok', weather: 'ok', police: 'ok', cameras: 'notConfigured' } } },
    { name: 'A failed source never reads as all clear',
      providers: [provider('test511', 'Test 511', incidentKinds, [], { state: 'error', fetchedAt: null }),
        provider('testWzdx', 'Test work zones', ['construction'], ['workZoneOpposite']),
        provider('testNws', 'Test weather', ['weather', 'flooding'], [])],
      expect: { alerts: [], status: { closures: 'unavailable', incidents: 'unavailable', weather: 'noRelevant', police: 'notConfigured', cameras: 'notConfigured' } } },
    { name: 'A feed older than its limit counts as unavailable',
      providers: [provider('test511', 'Test 511', incidentKinds, ['crashA'], { fetchedAt: now - 3600, maxAgeSeconds: 600 })],
      expect: { alerts: [], status: { incidents: 'unavailable', closures: 'unavailable' } } },
    { name: 'Only expired reports: shown as expired, never as current',
      providers: [provider('testCommunity', 'Test reports', ['police'], ['policeExpired'])],
      expect: { alerts: [], status: { police: 'expired' } } },
    { name: 'Police alerts switched off in Settings',
      enabled: { police: false },
      providers: [provider('testCommunity', 'Test reports', ['police'], ['police2'])],
      expect: { alerts: [], status: { police: 'off' } } },
    { name: 'A source with no coverage on this route',
      providers: [provider('testWzdx', 'Test work zones', ['construction'], [], { state: 'unsupported', fetchedAt: null })],
      expect: { alerts: [], status: { closures: 'unsupported', incidents: 'notConfigured' } } },
    { name: 'Opposite direction only: no relevant reports',
      providers: [provider('test511', 'Test 511', incidentKinds, ['oppositeS', 'oppositeNoDirection', 'parallelRoad', 'behind'])],
      expect: { alerts: [], status: { incidents: 'noRelevant' } } },
    { name: 'A source that has not answered yet shows as checking, not as clear',
      providers: [provider('testNws', 'Test weather', ['weather', 'flooding'], [], { state: 'pending', fetchedAt: null })],
      expect: { alerts: [], status: { weather: 'loading' } } },
    { name: 'Offline: the last result ages out and becomes unavailable',
      providers: [provider('testNws', 'Test weather', ['weather', 'flooding'], ['weather'], { fetchedAt: now - 2400, maxAgeSeconds: 1800 })],
      expect: { alerts: [], status: { weather: 'unavailable' } } },
    { name: 'A work zone that ends before you get there is left out',
      providers: [provider('testWzdx', 'Test work zones', ['construction'], ['workZoneEndsSoon'])],
      expect: { alerts: [], status: { closures: 'expired' } } },
  ],
};

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'cases.json'), `${JSON.stringify(file, null, 1)}\n`);
console.log('wrote', path.join(dir, 'cases.json'));
