// Road Intelligence on the shared fixtures (the same expectations as RoadIntelTests.swift): direction and
// road aware matching on the real I-95 route, deduplication, expiry and source status. Events are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { route } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { matchIncident, roadIntel, directionCode, roadRef, freshnessText, isSerious, alertTier, alertHeadline } from '../js/engine/roadintel.js';

const f = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel/cases.json'), 'utf8'));
const r = route(f.route);
const progress = f.progressMiles * MILE;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} is not within ${tol} of ${b}`);

test('matching: same road and direction only, never the other carriageway or a parallel road', () => {
  for (const [key, x] of Object.entries(f.matches)) {
    const m = matchIncident(r, f.incidents[key], progress);
    if (x.why) {
      assert.equal(m.why, x.why, key);
    } else {
      near((m.start - progress) / MILE, x.aheadMiles, 0.3, `${key} ahead`);
      if (x.endMiles != null) near((m.end - progress) / MILE, x.endMiles, 0.3, `${key} end`);
    }
  }
});

test('scenarios: deduplication, expiry, and a status that never turns a failure into all clear', () => {
  for (const s of f.scenarios) {
    const providers = s.providers.map((p) => ({ ...p, incidents: p.incidents.map((k) => f.incidents[k]) }));
    const etaAt = (d) => f.now + (d - progress) / f.speedMetersPerSecond;
    const out = roadIntel(r, progress, providers, { now: f.now, enabled: s.enabled ?? {}, etaAt });
    assert.equal(out.alerts.length, s.expect.alerts.length, `${s.name}: ${out.alerts.map((a) => a.incident.id).join(', ')}`);
    s.expect.alerts.forEach(([key, ahead, sources], i) => {
      const a = out.alerts[i];
      assert.equal(a.incident.id, f.incidents[key].id, `${s.name}: alert ${i}`);
      near(a.ahead / MILE, ahead, 0.3, `${s.name}: ${key} ahead`);
      assert.deepEqual(a.sources.map((x) => x.id), sources, `${s.name}: ${key} sources`);
    });
    for (const [group, state] of Object.entries(s.expect.status)) assert.equal(out.status[group].state, state, `${s.name}: ${group}`);
  }
});

test('normalizing provider text: roads and directions', () => {
  assert.deepEqual(roadRef('Interstate 95'), roadRef('I-95'));
  assert.deepEqual(roadRef('I 95 N'), roadRef('I-95'));
  assert.equal(roadRef('Main Street'), null);
  for (const [text, code] of [['Northbound', 'N'], ['SB', 'S'], ['east', 'E'], ['Westbound', 'W'], ['Both directions', 'both'], ['', null], ['unknown', null]]) {
    assert.equal(directionCode(text), code, text);
  }
});

test('freshness and seriousness', () => {
  assert.equal(freshnessText({ reportedAt: f.now - 360, updatedAt: f.now - 360 }, f.now), 'Reported 6 minutes ago');
  assert.equal(freshnessText({ reportedAt: f.now - 7200, updatedAt: f.now - 120 }, f.now), 'Updated 2 minutes ago');
  assert.equal(freshnessText({}, f.now), 'Time not reported');
  assert.ok(isSerious(f.incidents.crashA));
  assert.ok(!isSerious(f.incidents.workZone));
  assert.ok(isSerious({ category: 'closure' }));
});

test('NWS: road relevant alerts from a real captured response, polygons kept, zone alerts placed at the query points', async () => {
  const { nwsIncidents } = await import('../js/engine/alertsources.js');
  const sample = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel/nws_sample.json'), 'utf8'));
  const a = { lat: 61.1, lon: -149.7 }, b = { lat: 61.2, lon: -149.6 };
  const out = nwsIncidents([{ point: a, features: sample.features }, { point: b, features: [sample.features[1]] }]);
  // The Small Craft Advisory (marine) is left out.
  assert.deepEqual(out.map((i) => i.description), ['Severe Thunderstorm Warning', 'Wind Advisory']);
  const [storm, wind] = out;
  assert.equal(storm.geometry.type, 'polygon');
  assert.equal(storm.severity, 'major');
  assert.equal(storm.category, 'weather');
  assert.equal(storm.verification, 'official');
  assert.equal(storm.endsAt, Date.parse(sample.features[0].properties.ends) / 1000);
  // No polygon: placed where NWS returned it, once per alert even when two points return it.
  assert.deepEqual(wind.geometry, { type: 'points', coordinates: [a, b] });
  assert.equal(wind.startsAt, Date.parse(sample.features[1].properties.onset) / 1000);
  assert.equal(wind.direction, 'both');
});

test('WZDx: real work zone feeds converted, and matched on the real route by road and direction', async () => {
  const { wzdxIncidents, zonedSeconds } = await import('../js/engine/alertsources.js');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel');
  const x = JSON.parse(readFileSync(path.join(dir, 'wzdx_expect.json'), 'utf8'));
  const wr = route(x.route);
  const from = x.progressMiles * MILE;
  const all = new Map();
  for (const [state, want] of Object.entries(x.states)) {
    const list = wzdxIncidents(readFileSync(path.join(dir, `wzdx_${state.toLowerCase()}.json`), 'utf8'), state);
    const tally = {};
    for (const i of list) tally[`${i.category}/${i.severity}`] = (tally[`${i.category}/${i.severity}`] ?? 0) + 1;
    assert.equal(list.length, want.count, state);
    assert.deepEqual(tally, want.tally, state);
    const rejected = {};
    for (const i of list) {
      all.set(i.id, i);
      assert.equal(i.verification, 'official');
      assert.equal(i.source.id, `wzdx-${state}`);
      const m = matchIncident(wr, i, from);
      if (m.why) rejected[m.why] = (rejected[m.why] ?? 0) + 1;
      else assert.ok(i.id in x.matches, `${i.id} matched at ${(m.start - from) / MILE}`);
    }
    assert.deepEqual(rejected, x.rejected[state], state);
  }
  for (const [id, want] of Object.entries(x.incidents)) {
    const i = all.get(id);
    assert.ok(i, id);
    for (const k of ['road', 'direction', 'category', 'severity', 'lanes', 'startsAt', 'endsAt', 'updatedAt']) {
      if (k in want) assert.equal(i[k], want[k], `${id} ${k}`);
    }
    assert.equal(i.geometry.type, want.geometry, `${id} geometry`);
  }
  for (const [id, ahead] of Object.entries(x.matches)) near((matchIncident(wr, all.get(id), from).start - from) / MILE, ahead, 0.15, id);
  for (const [id, why] of Object.entries(x.rejectedByID)) assert.equal(matchIncident(wr, all.get(id), from).why, why, id);
  // Local time to UTC across the end of daylight saving time (November 1, 2026 in New York).
  assert.equal(zonedSeconds(2026, 9, 31, 20, 0, 'America/New_York'), Date.UTC(2026, 10, 1, 0, 0) / 1000);
  assert.equal(zonedSeconds(2026, 10, 2, 20, 0, 'America/New_York'), Date.UTC(2026, 10, 3, 1, 0) / 1000);
});

test('road names: a street or county road beside the highway is never the highway', () => {
  const at = r.polyline.coordinateAt(progress + 5 * MILE);
  const base = { id: 't', category: 'construction', source: { id: 't', name: 't' }, verification: 'official', direction: 'N', severity: 'moderate' };
  const point = { type: 'point', coordinate: { lat: at.lat, lon: at.lon } };
  assert.ok(matchIncident(r, { ...base, road: 'I 95 / Some Memorial Hwy', geometry: point }, progress).start != null);
  assert.equal(matchIncident(r, { ...base, road: 'Showalter Rd', geometry: point }, progress).why, 'other road');
  assert.equal(matchIncident(r, { ...base, road: 'MD 3BU', geometry: point }, progress).why, 'other road');
  assert.ok(matchIncident(r, { ...base, road: null, geometry: point }, progress).start != null);
});

test('work zone fetching: only states ahead, only during a trip, honest about coverage, failures and stale feeds', async () => {
  const { RoadAlerts } = await import('../js/app/roadalerts.js');
  const { TripPlan } = await import('../js/engine/trip.js');
  const { data } = await import('./support.js');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel');
  const md = readFileSync(path.join(dir, 'wzdx_md.json'), 'utf8');
  const de = readFileSync(path.join(dir, 'wzdx_de.json'), 'utf8');
  const plan = new TripPlan(r, { states: data.states });
  const now = 1793231600; // when the feeds were captured
  const calls = [];
  let feed = () => ({ status: 200, body: md });
  const fetchFn = async (url) => {
    calls.push(String(url));
    const u = String(url);
    const reply = u.includes('weather.gov') ? { status: 200, body: '{"features":[]}' } : u.includes('del_dot') ? { status: 200, body: de } : feed(url);
    return { ok: reply.status === 200, status: reply.status, text: async () => reply.body, json: async () => JSON.parse(reply.body) };
  };
  let proxy = null;
  const ra = new RoadAlerts({ fetchFn, clock: () => now, proxyBase: () => proxy });
  const status = (at) => roadIntel(r, at, ra.providers(), { now }).status.closures;
  const wz = () => calls.filter((u) => !u.includes('weather.gov'));
  const mdCalls = () => wz().filter((u) => /mdot|wzdx\/MD/.test(u));

  assert.equal(await ra.refresh(null, 0), false, 'no trip, no fetching');
  assert.equal(calls.length, 0);
  // Florida only within 150 miles: no feed there.
  await ra.refresh(plan, 136 * MILE);
  assert.equal(status(136 * MILE).state, 'unsupported');
  assert.deepEqual(wz(), []);
  // Maryland ahead, but its feed has no CORS and no proxy is set: said so, not fetched.
  ra.reset();
  await ra.refresh(plan, 1000 * MILE);
  assert.ok(ra.providers().find((p) => p.id === 'wzdx').uncovered.includes('MD (needs the key proxy)'));
  assert.deepEqual(mdCalls(), []);
  // Delaware, also ahead, allows browsers: read directly.
  assert.deepEqual(wz(), ['https://wzdx.e-dot.com/del_dot_feed_wzdx_v4.1.geojson']);
  // With the proxy: fetched through it, and the I-95 work zones ahead appear.
  proxy = 'https://p.example/';
  ra.reset();
  await ra.refresh(plan, 1000 * MILE);
  assert.ok(wz().includes('https://p.example/v1/wzdx/MD'), wz().join());
  const out = roadIntel(r, 1000 * MILE, ra.providers(), { now });
  assert.ok(out.alerts.some((a) => a.incident.id === 'wzdx:MD:09026375763a00c9006ad32ec4235c0a_N'));
  assert.equal(out.status.closures.state, 'ok');
  // Shoulder work leaves the travel lanes open: listed, but not for the Drive screen or voice.
  assert.ok(out.alerts.filter((a) => a.incident.source.id === 'wzdx-MD').every((a) => !a.notable));
  // Switched off in Settings: not fetched again.
  calls.length = 0;
  ra.reset();
  await ra.refresh(plan, 1000 * MILE, { enabled: { closures: false } });
  assert.deepEqual(wz(), []);
  // A failed feed is unavailable, never an all clear.
  feed = () => ({ status: 500, body: 'oops' });
  ra.reset();
  await ra.refresh(plan, 1000 * MILE);
  assert.equal(ra.wzdx.MD.state, 'error');
  assert.equal(status(1000 * MILE).state, 'unavailable');
  // A feed its publisher stopped updating is unavailable too, not current.
  feed = () => ({ status: 200, body: md.replace('"update_date":"2026-10-28T23:53:28Z"', '"update_date":"2026-10-20T00:00:00Z"') });
  assert.ok(feed().body !== md, 'fixture has the feed update date');
  ra.reset();
  await ra.refresh(plan, 1000 * MILE);
  assert.equal(ra.wzdx.MD.error, 'feed not updated for over a day');
  assert.equal(status(1000 * MILE).state, 'unavailable');
});

// Found by the tracking agent on the real Yonkers to Orlando route (simulated events): the New Jersey Turnpike
// reads "W" on the map while the state signs and reports it as south, and NJDOT writes "NEW JERSEY TURNPIKE".
const yo = route('yonkers_to_orlando');
const { offset } = await import('../js/engine/geo.js');
const event = (road, direction, geometry) => ({ id: 't', category: 'construction', source: { id: 't', name: 't' }, verification: 'official', severity: 'moderate', road, direction, geometry });
/// A point on the route at `mi`, `side` meters to the right (negative: left, the other carriageway).
const spot = (mi, side = 0) => { const d = mi * MILE; const c = yo.polyline.coordinateAt(d); return { type: 'point', coordinate: side ? offset(c, yo.polyline.bearingAt(d) + 90, side) : c }; };
const where = (i, fromMi) => { const m = matchIncident(yo, i, fromMi * MILE); return m.why ?? Math.round((m.start - fromMi * MILE) / MILE * 10) / 10; };

test('direction: the way the route runs decides where its signed name does not (the Turnpike is south, not west)', () => {
  assert.equal(yo.highwayAt(100 * MILE).direction, 'W', 'the map reads west here');
  for (const dir of ['Southbound', 'southbound', 'SB', 'S', '200', 'Both directions', null]) assert.equal(where(event('New Jersey Turnpike', dir, spot(100, 3)), 90), 10, `${dir}`);
  for (const dir of ['Northbound', 'NB', '20']) assert.equal(where(event('New Jersey Turnpike', dir, spot(100, -30)), 90), 'other direction', `${dir}`);
  assert.equal(where(event('New Jersey Turnpike', null, spot(100, -30)), 90), 'other direction', 'no direction, left of the route');
  // A work zone line on each carriageway.
  const line = (from, to, side) => ({ type: 'line', coordinates: [from, (from + to) / 2, to].map((mi) => spot(mi, side).coordinate) });
  assert.equal(where(event('NJTP', 'Southbound', line(100, 101, 3)), 90), 10);
  assert.equal(where(event('NJTP', 'Northbound', line(101, 100, -30)), 90), 'other direction');
});

test('direction: a road signed north and south that runs east and west keeps its sign (I-95 in Delaware, I-295, I-695)', () => {
  // Every interstate mile of three real routes: a report for the route's own signed direction on its side is
  // kept; one for the opposite direction on the other carriageway is never shown.
  const word = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };
  const back = { N: 'S', S: 'N', E: 'W', W: 'E' };
  for (const name of ['yonkers_to_orlando', 'richmond_to_nyc_turnpike']) {
    const r = route(name);
    let n = 0;
    for (let mi = 2; mi < r.polyline.length / MILE - 2; mi++) {
      const d = mi * MILE, hw = r.highwayAt(d);
      if (hw?.ref.kind !== 'interstate') continue;
      const c = r.polyline.coordinateAt(d), b = r.polyline.bearingAt(d);
      const road = `I ${hw.ref.number}`;
      const mine = matchIncident(r, event(road, word[hw.direction], { type: 'point', coordinate: offset(c, b + 90, 3) }), d - MILE);
      const theirs = matchIncident(r, event(road, word[back[hw.direction]], { type: 'point', coordinate: offset(c, b - 90, 30) }), d - MILE);
      assert.equal(mine.why, undefined, `${name} mi ${mi}: ${road} ${word[hw.direction]} missed (${mine.why})`);
      assert.equal(theirs.why, 'other direction', `${name} mi ${mi}: ${road} ${word[back[hw.direction]]} shown on the other carriageway`);
      n++;
    }
    assert.ok(n > 150, `${name}: ${n} interstate miles`);
  }
});

test('road names: case, punctuation and short forms on either side, never a parallel road', async () => {
  // The Turnpike alone (mile 100) and I-95 on the Turnpike's western spur (mile 30).
  for (const road of ['NEW JERSEY TURNPIKE', 'New Jersey Turnpike', 'N.J. Turnpike', 'NJTP', 'NJ Tpke', 'n.j. turnpike']) {
    assert.equal(where(event(road, 'Southbound', spot(100, 3)), 90), 10, road);
  }
  for (const road of ['I-95', 'I 95', 'Interstate 95', 'interstate 95', 'i-95', 'I-95 / NJ Turnpike', 'NJ Turnpike Western Spur']) {
    assert.equal(where(event(road, 'Southbound', spot(30, 3)), 25), 5, road);
  }
  // Parallel roads within 200 m are other roads: US 1 and US 9 beside I-95, the Garden State Parkway, the
  // Turnpike's other spur, and other parkways beside the Henry Hudson Parkway.
  for (const [road, mi] of [['US 1', 30], ['US 9', 30], ['NJ Turnpike Eastern Spur', 30], ['US 1', 100], ['Garden State Parkway', 100], ['US 1', 150], ['US 40', 150],
    ['Saw Mill River Parkway', 5], ['Hutchinson River Pkwy', 5], ['Parkway', 5]]) {
    assert.equal(where(event(road, 'Southbound', spot(mi, 3)), mi - 5), 'other road', `${road} at mile ${mi}`);
  }
  for (const road of ['Henry Hudson Pkwy', 'HENRY HUDSON PARKWAY']) assert.equal(where(event(road, 'Southbound', spot(5, 3)), 3.5), 1.5, road);
  assert.deepEqual(roadRef('Interstate 95'), { kind: 'interstate', prefix: 'I', number: '95' });
  assert.deepEqual(roadRef('i-95'), { kind: 'interstate', prefix: 'I', number: '95' });
  assert.deepEqual(roadRef('U.S. Route 1'), { kind: 'usRoute', prefix: 'US', number: '1' });
  const { normalizeRoadText } = await import('../js/engine/roadintel.js');
  assert.equal(normalizeRoadText('N.J. Tpke'), 'NJ TURNPIKE');
  assert.equal(normalizeRoadText('Florida’s Turnpike'), 'FL TURNPIKE');
});

test('alert tiers and headlines: red only for what is serious', () => {
  const tiers = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../Tests/ExitAtlasCoreTests/Fixtures/roadintel/tiers.json'), 'utf8'));
  for (const c of tiers.cases) {
    const i = { category: c.category, severity: c.severity };
    assert.equal(alertTier(i), c.tier, `${c.category} ${c.severity}: tier`);
    assert.equal(alertHeadline(i), c.headline, `${c.category} ${c.severity}: headline`);
  }
});
