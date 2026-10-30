// SmartStop and opening hours on the shared fixtures (the same expectations as SmartStopTests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseOpeningHours, weekFromPeriods, openAt, localTime } from '../js/engine/openinghours.js';
import { evaluateStop, smartStop, lastOpenBeforeGap, brandIndex } from '../js/engine/smartstop.js';
import { defaultProfile } from '../js/engine/profile.js';
import { TripPlan } from '../js/engine/trip.js';
import { TripLedger, PaceModel } from '../js/engine/tracking.js';
import { servicesForExit } from '../js/engine/exits.js';
import { StationFacts, fuelCandidates, aheadCandidates, stationName } from '../js/app/smartstops.js';
import { writeFileSync } from 'node:fs';
import { data, route, START } from './support.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/smartstop');
const load = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const DAY = { Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 };
const minute = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const MILE = 1609.344;

test('opening hours: the OpenStreetMap subset, Google periods and local time', () => {
  const f = load('opening_hours');
  for (const c of f.osm) {
    const h = parseOpeningHours(c.hours);
    assert.equal(h !== null, c.parses, `parses: ${c.hours}`);
    if (!h) continue;
    assert.equal(h.holidays, Boolean(c.holidays), `holidays: ${c.hours}`);
    for (const [d, t, open, closesIn] of c.checks) {
      assert.deepEqual(openAt(h, DAY[d], minute(t)), { open, closesIn }, `${c.hours} at ${d} ${t}`);
    }
  }
  for (const c of f.google) {
    const h = weekFromPeriods(c.periods);
    for (const [d, t, open, closesIn] of c.checks) assert.deepEqual(openAt(h, DAY[d], minute(t)), { open, closesIn }, `periods at ${d} ${t}`);
  }
  for (const c of f.localTime) {
    assert.deepEqual(localTime(Date.parse(c.at) / 1000, c.zone), { weekday: DAY[c.day], minute: minute(c.time) }, `${c.at} in ${c.zone}`);
  }
});

function setup(f, overrides = {}) {
  const p = defaultProfile();
  for (const src of [f.profile, overrides]) {
    for (const [k, v] of Object.entries(src ?? {})) p[k] = { ...p[k], ...v };
  }
  return p;
}

function candidate(f, c) {
  const x = { ...f.defaults, ...c };
  return {
    ...x, arrival: Date.parse(x.arrival) / 1000,
    ahead: x.aheadMiles != null ? x.aheadMiles * MILE : null,
    along: (x.alongMiles ?? x.aheadMiles ?? 0) * MILE,
    rangeOnArrival: x.rangeOnArrivalMiles != null ? x.rangeOnArrivalMiles * MILE : null,
    price: x.price != null ? { value: x.price, payment: x.pricePayment ?? null, text: x.priceText ?? null, source: x.priceSource ?? null } : null,
  };
}

test('D, E, O. stop confidence at the arrival time, in the station\'s own time zone', () => {
  const f = load('cases');
  for (const c of f.evaluations) {
    const e = evaluateStop(candidate(f, c.candidate), setup(f));
    const x = c.expect;
    if (x.day) assert.deepEqual(e.local, { weekday: DAY[x.day], minute: minute(x.time) }, c.name);
    if (x.overnight !== undefined) assert.equal(e.overnight, x.overnight, c.name);
    if (x.hours) assert.equal(e.hours.status, x.hours, c.name);
    if (x.hoursLabel) assert.equal(e.hours.label, x.hoursLabel, c.name);
    if (x.closesIn !== undefined) assert.equal(e.hours.closesIn, x.closesIn, c.name);
    if (x.checked) assert.equal(e.hours.checked, x.checked, c.name);
    if (x.restroom) assert.equal(e.restroom.status, x.restroom, c.name);
    if (x.restroomLabel) assert.equal(e.restroom.label, x.restroomLabel, c.name);
    if (x.store) assert.equal(e.facilities.find((y) => y.name === 'Store').status, x.store, c.name);
    if (x.pumps) assert.equal(e.facilities.find((y) => y.name === 'Pumps').status, x.pumps, c.name);
    if (x.hoursSource) assert.equal(e.hours.source, x.hoursSource, c.name);
    if (x.stale !== undefined) assert.equal(e.hours.stale, x.stale, c.name);
    if (x.note) assert.equal(e.hours.note, x.note, c.name);
    if (x.pumpsSource) assert.equal(e.facilities.find((y) => y.name === 'Pumps').source, x.pumpsSource, c.name);
    if (x.restroomSource) assert.equal(e.facilities.find((y) => y.name === 'Restroom').source, x.restroomSource, c.name);
    // O: an unknown business is never shown as open, and no station restroom is shown open at arrival.
    if (!c.candidate.osm?.hours && !c.candidate.osm?.brandHours && !c.candidate.live && !c.candidate.plaza) assert.equal(e.hours.status, 'unknown', c.name);
    if ((c.candidate.kind ?? 'station') === 'station') assert.notEqual(e.restroom.status, 'accessible', c.name);
  }
});

test('F, G, H, P. SmartStop rankings on the shared fixtures', () => {
  const f = load('cases');
  for (const c of f.rankings) {
    const profile = setup(f, c.profile);
    const r = smartStop(c.candidates.map((x) => candidate(f, x)), profile, {
      context: c.options.context, purpose: c.options.purpose ?? 'fuel', rejected: c.options.rejected ?? [], reserveMeters: profile.fuel.reserveMiles * MILE,
      vehicle: c.options.vehicle ?? null,
    });
    const x = c.expect;
    assert.equal(r.primary?.id ?? null, x.primary, `${c.name}: primary`);
    assert.deepEqual(r.alternatives.map((a) => a.id), x.alternatives ?? r.alternatives.map((a) => a.id), `${c.name}: alternatives`);
    if (x.passed) assert.deepEqual(r.passed, x.passed, `${c.name}: passed`);
    if (x.relaxed) assert.deepEqual(r.relaxed, x.relaxed, `${c.name}: relaxed`);
    if (x.lowRange !== undefined) assert.equal(r.lowRange, x.lowRange, `${c.name}: low range`);
    if (x.cheaper === null) assert.equal(r.cheaper, null, `${c.name}: cheaper`);
    if (x.cheaper) {
      assert.equal(r.cheaper?.id, x.cheaper.id, `${c.name}: cheaper`);
      assert.ok(Math.abs(r.cheaper.savings - x.cheaper.savings) < 0.001, `${c.name}: savings ${r.cheaper.savings}`);
      assert.equal(r.cheaper.estimate, x.cheaper.estimate, `${c.name}: estimate`);
    }
    if (x.favorite !== undefined) assert.deepEqual(r.favorite && { id: r.favorite.id, reason: r.favorite.reason }, x.favorite, `${c.name}: favorite`);
    if (x.notice !== undefined) assert.equal(r.notice, x.notice, `${c.name}: notice`);
    if (x.primaryHours) assert.equal(r.primary.evaluation.hours.status, x.primaryHours, `${c.name}: hours`);
    if (x.primaryRestroom) assert.equal(r.primary.evaluation.restroom.status, x.primaryRestroom, `${c.name}: restroom`);
    for (const reason of x.reasonsInclude ?? []) assert.ok(r.primary.reasons.includes(reason), `${c.name}: reason "${reason}" in ${JSON.stringify(r.primary.reasons)}`);
    // H: a stop is offered as keeping the reserve only when it does.
    if (!r.lowRange && r.primary?.rangeOnArrival != null && c.options.context === 'fuel') {
      assert.ok(r.primary.rangeOnArrival >= profile.fuel.reserveMiles * MILE, `${c.name}: reserve kept`);
    }
  }
});

test('a rebranded station shows its current brand and never ranks as its old one (Shell first)', () => {
  for (const c of load('cases').stationNames) {
    const brand = c.current ?? c.brand;
    const name = stationName({ name: c.name, brand: c.brand, category: 1 }, brand);
    assert.equal(name, c.expect, `${c.name} (${c.brand}) now ${c.current}`);
    assert.equal(brandIndex({ name, brand }, ['Shell']), c.shell ? 0 : null, `${c.name} (${c.brand}) now ${c.current}: Shell`);
  }
});

test('Overnight: the last stop listed open before a long stretch', () => {
  const f = load('cases');
  for (const c of f.lastOpen) {
    const o = c.options;
    const r = lastOpenBeforeGap(c.candidates.map((x) => candidate(f, x)), setup(f), {
      minLength: o.minLengthMiles * MILE, windowEnd: o.windowEndMiles * MILE, rejected: o.rejected ?? [],
    });
    const got = r && { stop: r.stop.id, lengthMiles: Math.round(r.length / MILE), unlisted: r.unlisted, openEnded: r.openEnded };
    assert.deepEqual(got, c.expect, c.name);
    if (r) assert.ok(['verified', 'reported'].includes(r.evaluation.hours.status), `${c.name}: only a stop listed open is named`);
  }
});

// P on real data: the Miami to Manhattan route with the bundled exits, rest areas and stations.json. The
// expected picks are in Fixtures/smartstop/route_expectations.json; SmartStopTests.swift checks the
// same file, so both engines must agree on real stations, not only on the hand written cases.


function realRoute() {
  const plan = new TripPlan(route('miami_to_manhattan'), {
    states: data.states, timeZones: data.timeZones, interstates: data.interstates, restAreas: data.restAreas,
  });
  const stations = new StationFacts(JSON.parse(readFileSync(path.resolve(dir, '../../../../App/ExitAtlas/Resources/Data/stations.json'), 'utf8')));
  return {
    plan,
    context: (miles, t = START) => {
      const s = plan.snapshot({ status: 'onRoute', distanceAlongRoute: miles * MILE, offset: 0, isEstimated: false, t, speed: 30 },
        new TripLedger(), new PaceModel(), t);
      return { plan, snapshot: s, servicesFor: (e) => servicesForExit(data.interstates, e), stations, prices: null };
    },
  };
}

function routeCases() {
  const real = realRoute();
  const cases = load('route_expectations').cases;
  return cases.map((c) => {
    const ctx = real.context(c.atMiles);
    const profile = defaultProfile();
    profile.overnight.mode = c.overnight;
    profile.fuel.brands = c.brands;
    let r;
    if (c.context === 'fuel') {
      r = smartStop(fuelCandidates(ctx, c.rangeMiles * MILE, null), profile, { context: 'fuel', reserveMeters: 50 * MILE });
    } else {
      if (c.restrooms) profile.fuel.requireRestroom = 'always';
      r = smartStop(aheadCandidates(ctx, c.miles, { restrooms: c.restrooms }), profile, { context: 'ahead', purpose: c.restrooms ? 'restroom' : 'fuel' });
    }
    const pick = (x) => x && { id: x.id, hours: x.evaluation.hours.status, restroom: x.evaluation.restroom.status };
    return { ...c, result: { primary: pick(r.primary), alternatives: r.alternatives.map(pick), considered: r.considered, passed: r.passed, lowRange: r.lowRange, notice: r.notice } };
  });
}

test('P. SmartStop on the real route gives the recorded picks', () => {
  const got = routeCases();
  if (process.env.UPDATE_SMARTSTOP) {
    const f = load('route_expectations');
    f.cases = got;
    writeFileSync(path.join(dir, 'route_expectations.json'), `${JSON.stringify(f, null, 1)}\n`);
  }
  const expected = load('route_expectations').cases;
  for (let i = 0; i < expected.length; i++) assert.deepEqual(got[i].result, expected[i].result, expected[i].name);
});

test('P. Overnight on the real route: the last stop listed open before a long stretch, through each time window', () => {
  const x = load('route_expectations').lastOpen;
  const real = realRoute();
  const profile = defaultProfile();
  profile.overnight.mode = 'on';
  const midnight = Date.parse(x.midnight) / 1000;
  const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
  for (const w of x.windows) {
    const from = minutes(w.from), to = minutes(w.to) < from ? minutes(w.to) + 1440 : minutes(w.to);
    for (let m = from; m <= to; m = m === to ? to + 1 : Math.min(m + 15, to)) {
      const ctx = real.context(w.atMiles, midnight + m * 60);
      const r = lastOpenBeforeGap(aheadCandidates(ctx, 150), profile, {
        minLength: x.gasGapMiles * MILE, windowEnd: Math.min(ctx.snapshot.progress + 150 * MILE, real.plan.route.length),
      });
      const at = `mile ${w.atMiles} at ${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
      assert.ok(r, `${at}: no last open stop`);
      assert.deepEqual([r.stop.id, Math.round(r.stop.ahead / MILE), Math.round(r.length / MILE), r.unlisted],
        [w.stop, w.aheadMiles, w.lengthMiles, w.unlisted], at);
    }
  }
});
