// Gas price engine on the shared SIMULATED fixtures (the same expectations as GasPricesTests.swift): report
// checks, freshness, duplicates and corrections, the price shown per station and grade, fill cost, savings
// against the preferred stop and sorting. No real prices are used here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { METERS_PER_MILE as MILE } from '../js/engine/geo.js';
import { validateReport, freshness, addReport, stationPrice, fillCost, compareStops, sortStations, paddFor, dollars, parseEiaSummary, benchmarkFor, autoLookups, lookupCohort, AUTO_LOOKUP_RULES } from '../js/engine/gasprices.js';

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

test('price text keeps the tenths of a cent a pump posts', () => {
  for (const [v, text] of Object.entries(f.dollars)) assert.equal(dollars(Number(v)), text, v);
});

test('regional average areas by state', () => {
  for (const [state, padd] of Object.entries(f.padd)) assert.equal(paddFor(state), padd, state);
});

test('EIA weekly summary: regions and states by grade, context for a state, nothing else', () => {
  // Shape of eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml (values from the 10/26/26 release).
  const rss = `<item><title>Data For 10/26/26</title><description><![CDATA[<br/>\t\tSummary Excerpt:<br/>Regular Gasoline Retail Price\t<br/>(Dollars per Gallon)<br/>
    4.269  .. U.S.  <br/>4.022  ... East Coast  <br/>3.832  .... Lower Atlantic\t<br/>4.269 ... Midwest<br/> <br/>States<br/>4.017 .... Florida\t<br/>4.249 .... New York<br/>
    Cities<br/>4.077 .... Miami<br/>4.178 .... New York City<br/><br/>On-Highway Diesel Fuel Retail Price  <br/>6.352  .. U.S.  <br/>5.890 ....  Lower Atlantic\t<br/>8.155 .... California\t\t]]></description></item>`;
  const s = parseEiaSummary(rss);
  assert.equal(s.weekOf, '2026-10-26');
  assert.deepEqual(s.regular, { US: 4.269, 1: 4.022, '1C': 3.832, 2: 4.269, FL: 4.017, NY: 4.249 });
  assert.deepEqual(s.diesel, { US: 6.352, '1C': 5.89, CA: 8.155 });
  assert.deepEqual(benchmarkFor(s, 'GA', 'R'), { area: '1C', name: 'Lower Atlantic', price: 3.832, weekOf: '2026-10-26' });
  assert.equal(benchmarkFor(s, 'FL', 'R').name, 'Florida', 'a state of its own first');
  assert.equal(benchmarkFor(s, 'GA', 'P'), null, 'no premium in the summary: nothing, not the regular price');
  assert.equal(parseEiaSummary('<html>not it</html>'), null);
});

test('automatic Google lookups: the top exits on screen only, each once an hour, within the daily budget', () => {
  const now = 10 * 3600 * 1000;
  const seen = new Map();
  const at = (id) => seen.get(id) ?? null;
  const exits = [{ id: 'a', ahead: 5 * MILE }, { id: 'a', ahead: 5 * MILE }, { id: 'behind', ahead: -MILE }, { id: 'b', ahead: 9 * MILE },
    { id: 'c', ahead: 20 * MILE }, { id: 'd', ahead: 30 * MILE }, { id: 'e', ahead: 40 * MILE }];
  assert.deepEqual(AUTO_LOOKUP_RULES, { perPass: 4, dailyBudget: 24, refreshMinutes: 60, cohortMiles: 5 });
  assert.deepEqual(autoLookups(exits, { now, usedToday: 0, lastLookup: at }), ['a', 'b', 'c', 'd'], 'repeats and exits behind are skipped');
  for (const id of ['a', 'b', 'c', 'd']) seen.set(id, now);
  assert.deepEqual(autoLookups(exits, { now: now + 59 * 60000, usedToday: 4, lastLookup: at }), [], 'not again within the hour, and e is not in the top 4');
  assert.deepEqual(autoLookups(exits, { now: now + 60 * 60000, usedToday: 4, lastLookup: at }), ['a', 'b', 'c', 'd'], 'again after an hour');
  assert.deepEqual(autoLookups(exits, { now: now + 60 * 60000, usedToday: 22, lastLookup: at }), ['a', 'b'], 'only what is left of the 24');
  assert.deepEqual(autoLookups(exits, { now, usedToday: 24, lastLookup: () => null }), []);
  assert.deepEqual(autoLookups(exits, { now, usedToday: 30, lastLookup: () => null }), [], 'never a negative budget');
});

test('the exits looked up stay the same on a screen until the driver moves on, whatever Google answers', () => {
  // Google lists the first stations closed, so the ranking that picks the exits now starts lower down.
  let ranking = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  let built = 0;
  const build = () => { built += 1; return ranking.map((id, i) => ({ id, ahead: (i + 1) * MILE })); };
  let cohort = lookupCohort(null, 'ahead|0', build);
  assert.deepEqual(cohort.exits.map((e) => e.id), ['a', 'b', 'c', 'd']);
  const seen = new Map(cohort.exits.map((e) => [e.id, 0]));
  ranking = ['e', 'f', 'g', 'h', 'a', 'b', 'c', 'd'];
  cohort = lookupCohort(cohort, 'ahead|0', build);
  assert.deepEqual(cohort.exits.map((e) => e.id), ['a', 'b', 'c', 'd'], 'same screen, same exits');
  assert.equal(built, 1, 'not ranked again');
  assert.deepEqual(autoLookups(cohort.exits, { now: 60000, usedToday: 4, lastLookup: (id) => seen.get(id) ?? null }), [], 'so nothing more is asked');
  cohort = lookupCohort(cohort, 'ahead|1', build);
  assert.deepEqual(cohort.exits.map((e) => e.id), ['e', 'f', 'g', 'h'], 'five miles on, the new ranking');
  assert.deepEqual(lookupCohort(null, 'k', () => [{ id: 'x', ahead: -5 }, { id: 'y', ahead: 5 }, { id: 'y', ahead: 5 }]).exits.map((e) => e.id), ['y']);
});
