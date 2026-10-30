// Speed limit loader with a fake Valhalla server: chunking, mapping back to the route, backoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from './support.js';
import { SpeedLimits, LIMIT_STEP } from '../js/app/limits.js';

const MILE = 1609.344;

function fakeValhalla(limitForPoint) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const req = JSON.parse(opts.body);
    calls.push(req);
    const edges = [{ speed_limit: 70 }, { speed_limit: 55 }, { speed_limit: 0 }];
    const matched = req.shape.map((p, k) => {
      const v = limitForPoint(k, calls.length);
      if (v === 'unmatched') return { type: 'unmatched', edge_index: 4294967295 };
      return { type: 'matched', edge_index: v === 70 ? 0 : v === 55 ? 1 : 2 };
    });
    return { ok: true, status: 200, json: async () => ({ edges, matched_points: matched }) };
  };
  return { calls, fetchImpl };
}

test('fetches the chunk ahead, maps limits back to the route, and finds the next change', async () => {
  const r = route('atlanta_to_nashville');
  // First 300 points (30 km) at 70, then 55, with one unmatched point.
  const fake = fakeValhalla((k) => (k === 10 ? 'unmatched' : k < 300 ? 70 : 55));
  const limits = new SpeedLimits(r, { fetchImpl: fake.fetchImpl });
  assert.equal(limits.state(0), 'loading');
  await limits.ensureAhead(0);
  assert.equal(fake.calls.length, 1);
  const req = fake.calls[0];
  assert.equal(req.units, 'miles');
  assert.equal(req.shape.length, 801);
  assert.equal(limits.at(5 * LIMIT_STEP), 70);
  assert.equal(limits.at(10 * LIMIT_STEP), null);
  assert.equal(limits.state(10 * LIMIT_STEP), 'unknown');
  assert.equal(limits.at(400 * LIMIT_STEP), 55);
  const change = limits.nextChange(29000, 2 * MILE);
  assert.equal(change.mph, 55);
  assert.equal(change.distance, 30000 - 29000);
  // The second chunk loads next; nothing is fetched twice.
  await limits.ensureAhead(0);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].shape.length, 801);
  await limits.ensureAhead(0);
  assert.equal(fake.calls.length, 2, 'prefetch window already loaded');
  await limits.ensureAhead(100000);
  assert.equal(fake.calls.length, 3);
});

test('a failed request backs off instead of retrying on every fix', async () => {
  const r = route('atlanta_to_nashville');
  let now = 0;
  let calls = 0;
  const limits = new SpeedLimits(r, {
    now: () => now,
    fetchImpl: async () => { calls += 1; throw new Error('offline'); },
  });
  await limits.ensureAhead(0);
  assert.equal(calls, 1);
  now += 5000;
  await limits.ensureAhead(0);
  assert.equal(calls, 1, 'still backing off');
  now += 20000;
  await limits.ensureAhead(0);
  assert.equal(calls, 2);
  assert.equal(limits.state(0), 'loading');
});

test('a shape the server cannot match is marked unknown and not requested again', async () => {
  const r = route('atlanta_to_nashville');
  let calls = 0;
  const limits = new SpeedLimits(r, {
    fetchImpl: async () => { calls += 1; return { ok: false, status: 400, json: async () => ({ error_code: 444, error: 'Map Match algorithm failed' }) }; },
  });
  await limits.ensureAhead(0);
  assert.equal(limits.state(0), 'unknown');
  await limits.ensureAhead(0);
  assert.equal(calls, 2, 'moves on to the next chunk');
  assert.equal(limits.at(0), null);
});

test('a speed limit server that keeps failing shows the limit as unknown, not loading for the whole trip', async () => {
  const r = route('atlanta_to_nashville');
  let now = 0;
  let up = false;
  const fake = fakeValhalla(() => 70);
  const limits = new SpeedLimits(r, {
    now: () => now,
    fetchImpl: async (...a) => { if (!up) throw new Error('offline'); return fake.fetchImpl(...a); },
  });
  await limits.ensureAhead(0);
  assert.equal(limits.state(0), 'loading', 'one failure: still trying');
  now += 20000;
  await limits.ensureAhead(0);
  assert.equal(limits.state(0), 'loading', 'two failures: still trying');
  now += 40000;
  await limits.ensureAhead(0);
  assert.equal(limits.state(0), 'unknown', 'three in a row: unknown for now');
  assert.equal(limits.at(0), null, 'never a made up limit');
  // The server answers again: the limit shows.
  up = true;
  now += 120000;
  await limits.ensureAhead(0);
  assert.equal(limits.state(0), 'known');
  assert.equal(limits.at(0), 70);
});
