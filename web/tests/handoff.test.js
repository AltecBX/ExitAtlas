// Waze deep links on the shared cases (the same expectations as HandoffTests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { wazeLink } from '../js/engine/handoff.js';

const f = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../Tests/ExitAtlasCoreTests/Fixtures/handoff/waze.json'), 'utf8'));

test('Waze: drive to the coordinate, six decimals, the app named in utm_source', () => {
  for (const c of f.cases) assert.equal(wazeLink({ lat: c.lat, lon: c.lon }, c.source), c.url, `${c.lat},${c.lon}`);
  assert.equal(wazeLink(null, 'x'), null);
});
