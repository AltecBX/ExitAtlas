// Live traffic engine on the shared SIMULATED fixtures (the same expectations as TrafficTests.swift): arrival
// times from route matched provider times without double counting, the stabilizer, slowdowns as Road
// Intelligence alerts, and when a faster route is worth offering. No real traffic data is used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readingProblem, trafficSecondsTo, etaBasis, stabilizeReading, slowdownIncidents, adviseAlternative, snoozeAlternative }
  from '../js/engine/traffic.js';
import { alertHeadline, alertTier, matchIncident } from '../js/engine/roadintel.js';

const f = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../Tests/ExitAtlasCoreTests/Fixtures/traffic/cases.json'), 'utf8'));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 0.01, `${msg}: ${a} is not ${b}`);

/// The fixture's modeled road speeds as seconds between two distances.
function modelSeconds(a, b) {
  let t = 0, start = 0;
  for (const s of f.model) {
    const lo = Math.max(a, start), hi = Math.min(b, s.to);
    if (hi > lo) t += (hi - lo) / s.mps;
    start = s.to;
  }
  return t;
}
const timing = (pace) => ({ modelSeconds, paceSeconds: (m) => pace * m });

test('arrival seconds: provider times where measured, the driver\'s pace beyond, nothing counted twice', () => {
  for (const c of f.seconds) near(trafficSecondsTo(c.reading, c.progress, c.target, timing(c.pace)), c.expect, c.name);
});

test('a reading is used only on its own route, while fresh and ahead of the driver', () => {
  for (const c of f.problems) {
    assert.equal(readingProblem(c.reading, { routeId: c.routeId, progress: c.progress, now: c.now }), c.expect, c.name);
  }
});

test('every arrival time names its basis', () => {
  for (const c of f.basis) {
    const reading = { checkpoints: [{ along: c.lastAlong, seconds: 1 }] };
    assert.equal(etaBasis(reading, c.usable, c.target, c.paceKnown), c.expect, JSON.stringify(c));
  }
});

test('stabilizer: small moves at once, a big jump only once a second reading confirms it', () => {
  let state = { shown: null, pending: null };
  for (const [i, s] of f.stability.steps.entries()) {
    const context = { routeId: f.stability.routeId, progress: s.progress, now: s.now, ...timing(1) };
    const out = stabilizeReading(state, s.reading, context);
    state = out.state;
    assert.equal(out.changed, s.changed, `step ${i} changed`);
    near(trafficSecondsTo(out.reading, s.progress, 70000, context), s.expectSeconds, `step ${i} seconds`);
  }
});

test('slowdowns ahead become Road Intelligence alerts on the route itself', () => {
  const s = f.slowdowns;
  const out = slowdownIncidents(s.sections, { routeId: s.routeId, progress: s.progress, measuredAt: s.measuredAt, source: s.source });
  assert.deepEqual(out.map((i) => i.id), s.expect.map((x) => x.id));
  out.forEach((i, k) => {
    const x = s.expect[k];
    assert.equal(i.severity, x.severity);
    assert.equal(i.description, x.description);
    assert.equal(i.delaySeconds, x.delaySeconds);
    assert.equal(i.verification, 'measured');
    assert.equal(i.expiresAt, s.measuredAt + 900);
    assert.equal(alertHeadline(i), x.headline);
    assert.equal(alertTier(i), x.tier);
    const m = matchIncident({ id: s.routeId }, i, s.progress);
    assert.equal(m.start, Math.max(x.from, s.progress), `${x.id} start`);
    assert.equal(m.end, x.to, `${x.id} end`);
    assert.equal(matchIncident({ id: 'r2' }, i, s.progress).why, 'other route', `${x.id} after a reroute`);
  });
});

test('faster routes: offered only for a real, repeated saving that keeps the plan', () => {
  for (const c of f.alternatives) {
    let state = {};
    const prefs = { minSavingSeconds: 600, avoidTolls: false, ...c.prefs };
    for (const [i, s] of c.steps.entries()) {
      const out = adviseAlternative({ current: s.current, alternative: s.alternative, prefs, state, now: s.now });
      state = out.state;
      const label = `${c.name}, step ${i}`;
      if (s.expect.offer) {
        assert.ok(out.offer, `${label}: ${out.reason}`);
        assert.equal(out.offer.savedSeconds, s.expect.savedSeconds, label);
        assert.equal(out.offer.extraMeters, s.expect.extraMeters, label);
        assert.deepEqual(out.offer.notes, s.expect.notes, label);
      } else {
        assert.equal(out.offer, null, label);
        assert.equal(out.reason, s.expect.reason, label);
      }
      if (s.then === 'snooze') state = snoozeAlternative(state, out.offer, s.now);
    }
  }
});
