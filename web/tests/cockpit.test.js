// The cockpit's data rules (engine/cockpit.js): every gauge reads a real channel or is labeled calculated, statuses
// say why a gauge has no value, and the plan asks the scanner only for what is on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAUGES, MODES, PORSCHE, porscheKey, inputsOf, requestOf, buildPlan, readGauge, needleAngle, zoneOf, updatePeaks, warmup, linkQuality, channelGauge, niceStep, STOICH } from '../js/engine/cockpit.js';
import { channelsFor, setStandardSignals } from '../js/engine/obdpids.js';
import { indexSignalsets, decodeSignal, OBDB_UNITS, porscheRequests } from '../js/engine/obdb.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/obdb/${f}`, import.meta.url), 'utf8'));
const index = { ...indexSignalsets({ standard: load('SAEJ1979.json'), porsche: load('Porsche-911.json') }), decode: decodeSignal, unitOf: (u) => OBDB_UNITS[u] ?? '' };
setStandardSignals(index);

test('every gauge input is a real channel: standard PIDs in the table or OBDb, Porsche signals in the 2021 set', () => {
  const reqs = new Map(porscheRequests(index, 2021).map((r) => [r.key, r]));
  for (const [id, g] of Object.entries(GAUGES)) {
    for (const key of inputsOf(g)) {
      const r = requestOf(key);
      assert.ok(r, `${id}: ${key} names a request`);
      if (r.kind === '01') assert.ok(channelsFor(r.pid).some((c) => c.key === key), `${id}: channel ${key} exists`);
      else {
        const req = reqs.get(r.key);
        assert.ok(req, `${id}: Porsche request ${r.key} applies to 2021`);
        assert.ok(req.signals.some((s) => key.endsWith(`_${s.id}`)), `${id}: signal ${key}`);
      }
    }
    if (g.calc) assert.ok(g.calculated, `${id} is labeled calculated`);
  }
  for (const m of Object.values(MODES)) for (const [id] of m.gauges) assert.ok(GAUGES[id], id);
  assert.equal(porscheKey(PORSCHE.oilPressure), '227E01503_911_EOP');
});

const live = (entries, t = 10000) => (key) => (key in entries ? { value: entries[key], t, dt: 200 } : null);
const units = { '0170_BP_A_ACT': 'kPa', '0133': 'kPa', '010C': 'rpm', '015C': '°C', '010D': 'km/h' };

test('boost is calculated: boost pressure sensor minus barometric, in psi', () => {
  const r = readGauge(GAUGES.boost, { get: live({ '0170_BP_A_ACT': 201.3, '0133': 101.3 }), unitOf: (k) => units[k], now: 10500 });
  assert.equal(r.status, 'live');
  assert.ok(Math.abs(r.value - 100 * 0.145038) < 1e-9);
  assert.equal(GAUGES.afr.calc.f([1]), STOICH);
  // Barometric pressure is read once a minute: an older reading of it does not make boost stale.
  const mixed = (key) => ({ '0170_BP_A_ACT': { value: 201.3, t: 10000, dt: 200 }, '0133': { value: 101.3, t: 1000, dt: null } })[key];
  assert.equal(readGauge(GAUGES.boost, { get: mixed, unitOf: (k) => units[k], now: 10500 }).status, 'live');
  assert.equal(readGauge(GAUGES.boost, { get: mixed, unitOf: (k) => units[k], now: 15000 }).status, 'stale');
});

test('statuses: not listed by the car, no answer, waiting, live, stale; never a made up value', () => {
  const supported = new Set([0x0c, 0x5c]);
  const opts = (entries, extra = {}) => ({ get: live(entries), unitOf: (k) => units[k], supported, now: 10500, ...extra });
  assert.deepEqual(readGauge(GAUGES.speed, opts({})), { value: null, status: 'unsupported' });
  assert.deepEqual(readGauge(GAUGES.rpm, opts({}, { status: new Map([[0x0c, 'noData']]) })), { value: null, status: 'noAnswer' });
  assert.deepEqual(readGauge(GAUGES.rpm, opts({})), { value: null, status: 'waiting' });
  assert.equal(readGauge(GAUGES.rpm, opts({ '010C': 2500 })).value, 2500);
  assert.equal(readGauge(GAUGES.oilTemp, opts({ '015C': 100 })).value, 212);       // °C to °F
  assert.equal(readGauge(GAUGES.rpm, { ...opts({ '010C': 2500 }), now: 20000 }).status, 'stale');
  assert.deepEqual(readGauge(GAUGES.oilPressure, opts({})), { value: null, status: 'notProbed' });
  assert.deepEqual(readGauge(GAUGES.oilPressure, opts({}, { porsche: true, porscheResults: new Map([['22:7E0:1503', 'noData']]) })), { value: null, status: 'unsupported' });
});

test('the plan: fast gauges every pass, slow ones every 5 s, fixed facts every minute, only what the car lists', () => {
  const supported = new Set([0x0c, 0x0d, 0x5c, 0x62, 0x63, 0x2f, 0x33]);
  const plan = buildPlan([GAUGES.rpm, GAUGES.speed, GAUGES.oilTemp, GAUGES.torque, GAUGES.boost, GAUGES.oilPressure], { supported });
  const by = Object.fromEntries(plan.map((p) => [p.id, p.period]));
  assert.equal(by['01:12'], 0);
  assert.equal(by['01:13'], 0);
  assert.equal(by['01:92'], 5000);
  assert.equal(by['01:99'], 60000);      // reference torque does not change
  assert.equal(by['01:51'], 60000);      // barometric pressure
  assert.equal(by['01:112'], undefined); // 0x70 not listed by this car
  assert.equal(by['01:47'], 10000);      // fuel level for the range
  assert.ok(!plan.some((p) => p.kind === '22')); // Porsche data off
  const reqs = new Map(porscheRequests(index, 2021).map((r) => [r.key, r]));
  const withP = buildPlan([GAUGES.oilPressure, GAUGES.pdkTemp], { supported, porsche: true, porscheReqs: reqs, porscheResults: new Map([['22:7E1:38BF', 'noData']]) });
  assert.deepEqual(withP.filter((p) => p.kind === '22').map((p) => p.id), ['22:7E0:1503']);
});

test('needles, zones, redline, peaks, warm up, link quality, custom gauges', () => {
  assert.equal(needleAngle(0, 0, 8000), -120);
  assert.equal(needleAngle(8000, 0, 8000), 120);
  assert.equal(needleAngle(4000, 0, 8000), 0);
  assert.equal(needleAngle(99999, 0, 8000), 120);
  assert.equal(needleAngle(null, 0, 8000), -120);
  assert.equal(zoneOf(7100, [], 7000), 'red');
  assert.equal(zoneOf(250, GAUGES.coolant.zones), 'red');
  assert.equal(zoneOf(11.5, GAUGES.voltage.zones), 'warn');
  assert.equal(zoneOf(13, GAUGES.voltage.zones), null);
  const p = updatePeaks({}, { boost: { value: 12, status: 'live' }, rpm: { value: null, status: 'waiting' } }, 5);
  assert.deepEqual(p, { boost: { value: 12, t: 5 } });
  assert.deepEqual(updatePeaks(p, { boost: { value: 9, status: 'live' } }, 6), p);
  assert.deepEqual(updatePeaks(p, { boost: { value: 20, status: 'stale' } }, 6), p); // stale readings are not peaks
  assert.deepEqual(warmup(150), { cold: true, toGo: 26 });
  assert.deepEqual(warmup(200), { cold: false });
  assert.equal(linkQuality({ latency: 200, requests: 4.5, timeouts: 0, answers: 100 }), 'good');
  assert.equal(linkQuality({ latency: 500, requests: 2, timeouts: 0, answers: 100 }), 'fair');
  assert.equal(linkQuality({ latency: 200, timeouts: 20, answers: 80 }), 'poor');
  assert.equal(linkQuality({}), null);
  const g = channelGauge({ key: '0170_BP_A_ACT', name: 'Boost pressure sensor A', unit: 'kPa', range: [0, 2047.96875] });
  assert.equal(g.unit, 'psi');
  assert.ok(Math.abs(g.max - 2047.96875 * 0.145038) < 1e-6);
  assert.equal(niceStep(8000), 1000);
  assert.equal(niceStep(45), 10);
});
