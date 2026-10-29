// Gas price engine on the shared SIMULATED fixtures (the same expectations as GasPricesTests.swift): report
// checks, freshness, duplicates and corrections, the price shown per station and grade, fill cost, savings
// against the preferred stop and sorting. No real prices are used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { validateReport, freshness, addReport, stationPrice, fillCost, compareStops, sortStations, paddFor } from '../js/engine/gasprices.js';

const f = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../Tests/ExitAtlasCoreTests/Fixtures/prices/cases.json'), 'utf8'));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} is not ${b}`);
const byId = Object.fromEntries(f.records.map((r) => [r.id, r]));

test('reports are checked: price range, grade, payment, time, regional sanity', () => {
  for (const c of f.validate) {
    const out = validateReport(c.input, { now: f.now, benchmark: c.benchmark });
    assert.equal(out.ok, c.ok, c.name);
    if (c.ok) assert.equal(out.record.price, c.price, c.name);
    else assert.deepEqual(out.problems, c.problems, c.name);
  }
});

test('every price says when it was seen; old ones are not compared, expired ones are dropped', () => {
  for (const c of f.freshness) {
    const out = freshness({ reportedAt: f.now - c.age }, f.now, c.maxAgeHours);
    assert.equal(out.state, c.state, `${c.age}`);
    assert.equal(out.text, c.text, `${c.age}`);
  }
});

test('repeats are not added, corrections replace, other drivers confirm', () => {
  for (const c of f.addReport) {
    const out = addReport(c.start.map((id) => byId[id]), c.add, f.now);
    assert.deepEqual(out.map((r) => r.id), c.expect, c.name);
  }
});

test('one price per station and grade: payment kind, member prices, old reports and conflicts', () => {
  for (const c of f.stationPrice) {
    const out = stationPrice(f.records, c.station, c.grade, { now: f.now, payment: c.payment, member: Boolean(c.member) });
    if (c.expect === null) { assert.equal(out, null, c.name); continue; }
    assert.equal(out.record.id, c.expect.id, c.name);
    for (const k of ['state', 'paymentMatch', 'confirmations', 'conflict']) assert.equal(out[k], c.expect[k], `${c.name}: ${k}`);
  }
});

test('fill cost: gallons bought plus detour fuel, at that pump', () => {
  for (const c of f.fill) {
    const out = fillCost({ price: c.price, rangeOnArrival: c.rangeOnArrivalMiles * MILE, tankGallons: c.tankGallons, mpg: c.mpg, detourMeters: c.detourMiles * MILE });
    if (c.expect === null) { assert.equal(out, null, c.name); continue; }
    for (const k of ['gallons', 'detourGallons', 'total']) near(out[k], c.expect[k], 0.001, `${c.name}: ${k}`);
  }
});

test('savings against the preferred stop: same grade and payment kind, current prices only', () => {
  const side = (s) => ({ price: { record: { price: s.price, payment: s.payment }, state: s.state }, cost: { gallons: s.gallons, detourGallons: s.detourGallons }, detourMeasured: s.detourMeasured });
  for (const c of f.compare) {
    const out = compareStops(side(c.a), side(c.b));
    if (c.expect === null) { assert.equal(out, null, c.name); continue; }
    near(out.savings, c.expect.savings, 0.001, `${c.name}: savings`);
    near(out.perGallon, c.expect.perGallon, 0.0001, `${c.name}: per gallon`);
    assert.equal(out.estimate, c.expect.estimate, `${c.name}: estimate`);
    assert.equal(out.meaningful, c.expect.meaningful, `${c.name}: meaningful`);
  }
});

test('sorting: a station without a current price never sorts as cheaper', () => {
  const rows = f.sort.rows.map((r) => ({ ...r, ahead: r.aheadMiles * MILE,
    price: r.price ? stationPrice(f.records, r.price, 'R', { now: f.now, payment: 'credit' }) : null }));
  for (const [sort, ids] of Object.entries(f.sort.expect)) assert.deepEqual(sortStations(rows, sort).map((r) => r.id), ids, sort);
});

test('regional average areas by state', () => {
  for (const [state, padd] of Object.entries(f.padd)) assert.equal(paddFor(state), padd, state);
});
