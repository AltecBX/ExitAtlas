// Road Intelligence on the shared fixtures (the same expectations as RoadIntelTests.swift): direction and
// road aware matching on the real I-95 route, deduplication, expiry and source status. Events are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { route } from './support.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { matchIncident, roadIntel, directionCode, roadRef, freshnessText, isSerious } from '../js/engine/roadintel.js';

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
