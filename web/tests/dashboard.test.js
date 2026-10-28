// The adaptive Drive screen on the shared fixtures (the same expectations as DashboardFocusTests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dashboardFocus } from '../js/engine/dashboard.js';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/dashboard/focus.json');

/// Fixture signals (miles) as engine signals (meters).
export function signals(x) {
  const m = (v) => (v == null ? null : v * MILE);
  return {
    nextExit: x.nextExit != null ? { distance: m(x.nextExit) } : null,
    restArea: x.restArea != null ? { distance: m(x.restArea) } : null,
    gap: x.gap ? { startsIn: m(x.gap.startsIn), length: m(x.gap.length) } : null,
    plannedStop: x.plannedStop != null ? { distance: m(x.plannedStop) } : null,
    fuel: x.fuel ? { reading: true, range: m(x.fuel.range), reserve: m(x.fuel.reserve), stopAhead: m(x.fuel.stopAhead), low: Boolean(x.fuel.low) } : { reading: false },
    overnight: Boolean(x.overnight),
  };
}

test('Q. one focus card and at most two strip items, by a fixed priority', () => {
  for (const c of JSON.parse(readFileSync(file, 'utf8')).cases) {
    const r = dashboardFocus(signals(c.signals));
    assert.equal(r.focus, c.expect.focus, `${c.name}: focus`);
    assert.deepEqual(r.strip, c.expect.strip, `${c.name}: strip`);
    assert.ok(r.strip.length <= 2 && !r.strip.includes(r.focus), `${c.name}: no clutter, no repeats`);
  }
});
