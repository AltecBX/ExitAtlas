// The car connection (app/carlink.js) against a SIMULATED adapter (tests/support/fakeadapter.js): what happens when
// answers come late, writes fail, the link drops, and screens start and stop live data. Each case was a defect found
// in the November 2026 audit: wrong values shown as live, a connection that never read again, doubled polling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CarLink, makeAdapter, carAnswers, sleep } from './support/fakeadapter.js';
import { CAR_RULES } from '../js/app/carlink.js';
import { parseAnswer } from '../js/engine/obd.js';
import { parseDTCs } from '../js/engine/obddiag.js';
import { channelsFor, setStandardSignals, PIDS01 } from '../js/engine/obdpids.js';
import { indexSignalsets, decodeSignal, OBDB_UNITS, porscheRequests } from '../js/engine/obdb.js';
import { recordingCSV } from '../js/engine/obdlive.js';
import { buildPlan, readGauge, GAUGES, MODES } from '../js/engine/cockpit.js';

const PIDS = { '05': '7B', '0C': '0FA0', '0D': '32', '11': '40' };   // coolant 83 °C, 1,000 rpm, 50 km/h, throttle 25.1 %
const PLAN = [{ id: '01:5', kind: '01', pid: 5, period: 0 }, { id: '01:12', kind: '01', pid: 0x0c, period: 0 }, { id: '01:13', kind: '01', pid: 0x0d, period: 0 }, { id: '01:17', kind: '01', pid: 0x11, period: 0 }];
const truth = (link, why) => {
  const v = (k) => link.live.values.get(k)?.value;
  assert.equal(v('0105'), 83, `coolant ${why}`);
  assert.equal(v('010C'), 1000, `rpm ${why}`);
  assert.equal(v('010D'), 50, `speed ${why}`);
  assert.ok(Math.abs(v('0111') - 25.098) < 0.01, `throttle ${why}`);
};
const fresh = (link, key, ms = 1500) => Date.now() - (link.live.values.get(key)?.t ?? 0) < ms;

for (const kind of ['bluedriver', 'elm']) {
  test(`${kind}: an answer that comes after its time limit is dropped, never taken for the next request's`, async () => {
    let slow = false;
    const ad = makeAdapter({ kind, answer: carAnswers({ kind, pids: PIDS,
      extra: (cmd) => { if (slow && cmd === '010C') { slow = false; return { text: kind === 'bluedriver' ? '0F A0 ' : '410C0FA0', delay: CAR_RULES.commandTimeout + 300 }; } return undefined; } }) });
    const link = new CarLink({ bluetooth: ad.bluetooth });
    await link.connect();
    link.setPlan(PLAN);
    link.startLive();
    await sleep(300);
    truth(link, 'before');
    slow = true;
    await sleep(CAR_RULES.commandTimeout + 1500);
    truth(link, 'after the late answer');
    for (const k of ['0105', '010C', '010D', '0111']) assert.ok(fresh(link, k), `${k} is being read again`);
    assert.equal(link.live.timeouts, 1);
    assert.ok(link.log.some((l) => /late answer dropped/.test(l.text)));
    link.disconnect();
  });
}

test('a write that fails leaves no half request behind: later answers still belong to their requests', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', answer: carAnswers({ kind: 'bluedriver', pids: PIDS }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  link.setPlan(PLAN);
  link.startLive();
  await sleep(300);
  let failed = false;
  ad.writeChar.failWrite = () => { if (failed) return null; failed = true; return new Error('GATT operation failed for unknown reason.'); };
  await sleep(3500);
  assert.ok(failed);
  truth(link, 'after the failed write');
  for (const k of ['0105', '010C', '010D', '0111']) assert.ok(fresh(link, k), `${k} is being read again`);
  link.disconnect();
});

test('a dropped link ends the request in the air, and live data runs again after the reconnect', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', answer: carAnswers({ kind: 'bluedriver', pids: { ...PIDS, '2F': '80' } }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  link.setPlan(PLAN);
  link.startLive();
  await sleep(300);
  ad.drop();
  await sleep(50);
  assert.equal(link.state, 'disconnected');
  assert.equal(link.waiting, null);
  assert.equal(link.live.on, false, 'the live loop ended instead of waiting forever');
  await sleep(CAR_RULES.reconnectAfter[0] * 1000 + 1200);
  assert.equal(link.state, 'connected');
  assert.equal(link.live.on, true, 'live data came back by itself');
  const before = ad.sent.length;
  await sleep(600);
  assert.ok(ad.sent.length - before > 10, `requests go out again (${ad.sent.length - before})`);
  truth(link, 'after the reconnect');
  link.disconnect();
});

test('Disconnect while the first request waits, then Connect again: the old attempt cannot break the new connection', async () => {
  let hang = true;
  const ad = makeAdapter({ kind: 'elm', answer: carAnswers({ kind: 'elm', pids: PIDS, extra: (cmd) => (hang && cmd === '0100' ? null : undefined) }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  const first = link.connect();
  await sleep(400);
  link.disconnect();
  await first;
  hang = false;
  await link.connect();
  assert.equal(link.state, 'connected');
  const errors = () => link.log.filter((l) => /open failed/.test(l.text)).length;
  await sleep(600);
  assert.equal(link.state, 'connected');
  assert.equal(errors(), 0);
  link.disconnect();
});

test('stopping and starting live data in the same moment leaves one loop, not two', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', answer: carAnswers({ kind: 'bluedriver', pids: PIDS }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  link.setPlan(PLAN.slice(1));
  link.startLive();
  await sleep(200);
  for (let i = 0; i < 3; i++) { link.stopLive(); link.startLive(); await sleep(150); }
  const from = ad.sent.length;
  await sleep(400);
  const seq = ad.sent.slice(from).map((x) => x.cmd).filter((c) => /^01(0C|0D|11)$/.test(c));
  assert.ok(seq.length > 9);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `no PID is asked twice in a row (${seq.slice(0, 12).join(' ')})`);
  link.disconnect();
});

test('pauseLive keeps a recording (the Porsche probe must not end one)', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', answer: carAnswers({ kind: 'bluedriver', pids: PIDS }) });
  let saved = 0;
  const link = new CarLink({ bluetooth: ad.bluetooth, onRecorded: () => { saved += 1; } });
  await link.connect();
  link.startRecording();
  await sleep(200);
  link.pauseLive();
  assert.ok(link.rec, 'still recording');
  assert.equal(saved, 0);
  link.startLive();
  await sleep(200);
  assert.equal(link.live.on, true);
  link.disconnect();
});

test('an item that keeps answering NO DATA is asked every 15 s, not on every pass', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', latency: 5, answer: carAnswers({ kind: 'bluedriver', pids: PIDS, extra: (cmd) => (cmd === '010E' ? { text: 'NO DATA', delay: 200 } : undefined) }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  link.supported.add(0x0e);
  link.setPlan([...PLAN.slice(1), { id: '01:14', kind: '01', pid: 0x0e, period: 0 }]);
  link.startLive();
  await sleep(2500);
  const asked = ad.sent.filter((x) => x.cmd === '010E').length;
  assert.equal(asked, 2, 'asked twice (one miss is retried at once), then set aside');
  const from = ad.sent.length;
  await sleep(500);
  assert.ok(ad.sent.length - from > 15, 'the gauges that answer are read at full speed');
  link.disconnect();
});

test('ELM327: a standard request never goes to the one module a Porsche request pointed the adapter at', async () => {
  let header = '7DF';
  const ad = makeAdapter({ kind: 'elm', answer: carAnswers({ kind: 'elm', pids: { ...PIDS, '2F': '80' },
    extra: (cmd) => { const m = cmd.match(/^ATSH(\w+)$/); if (m) { header = m[1]; return 'OK'; } if (/^22/.test(cmd)) return 'NO DATA'; if (/^01/.test(cmd) && header !== '7DF') return 'NO DATA'; return undefined; } }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  await link.readEnhanced({ key: '22:7E1:38BF', hdr: '7E1', did: '38BF', command: {} });
  assert.equal(header, '7E1');
  await link.readFuel();
  assert.equal(header, '7DF', 'set back before the fuel request');
  assert.ok(Math.abs(link.fuel - 50.2) < 0.1);
  link.disconnect();
});

test('a reconnect does not double the listeners (each answer is taken once)', async () => {
  const ad = makeAdapter({ kind: 'bluedriver', sameObjects: true, answer: carAnswers({ kind: 'bluedriver', pids: PIDS }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  ad.drop();
  await sleep(CAR_RULES.reconnectAfter[0] * 1000 + 1000);
  assert.equal(link.state, 'connected');
  link.setPlan(PLAN);
  link.startLive();
  await sleep(500);
  truth(link, 'with the same characteristic objects after a reconnect');
  assert.equal(link.log.filter((l) => /late answer dropped/.test(l.text)).length, 0);
  ad.drop();
  await sleep(30);
  assert.equal(link.log.filter((l) => l.text === 'adapter disconnected').length, 2, 'one line per drop');
  link.disconnect();
});

test('BlueDriver: a classic PID answer of the wrong length is not decoded', async () => {
  let wrong = false;
  const ad = makeAdapter({ kind: 'bluedriver', answer: carAnswers({ kind: 'bluedriver', pids: { ...PIDS, '2F': '80' }, extra: (cmd) => (wrong && cmd === '012F' ? '7F 01 12 ' : undefined) }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  wrong = true;
  assert.equal(await link.readLive(0x2f), 0);
  assert.equal(link.live.status.get(0x2f), 'unreadable');
  assert.equal(link.live.values.get('012F'), undefined);
  wrong = false;
  assert.equal(await link.readLive(0x2f), 1);
  link.disconnect();
});

test('a long pause is not counted into a sensor\'s update interval', () => {
  const link = new CarLink({ bluetooth: null });
  const ch = channelsFor(0x0c)[0];
  const t0 = 1_000_000;
  link.record(ch, 800, t0);
  link.record(ch, 810, t0 + 100);
  link.record(ch, 820, t0 + 200);
  link.record(ch, 850, t0 + 45 * 60000);
  link.record(ch, 850, t0 + 45 * 60000 + 100);
  assert.ok(link.live.values.get(ch.key).dt < 500, `dt ${link.live.values.get(ch.key).dt}`);
});

test('answers from two control units: codes from both, PIDs either lists, both monitor statuses', async () => {
  assert.deepEqual(parseDTCs('4300\r4300\r', 3), { codes: [] });
  assert.deepEqual(parseDTCs('43010133\r4300\r', 3), { codes: ['P0133'] });
  assert.deepEqual(parseDTCs('43010133\r43020420C123\r', 3).codes, ['P0133', 'P0420', 'U0123']);
  assert.deepEqual(parseDTCs('43013300000000\r43000000000000\r', 3).codes, ['P0133'], 'older buses: three pairs per line');
  const r = parseAnswer('410098180001\r4100BE1FA813\r', 0x00);
  assert.equal(r.all.length, 2);
  // The transmission answers first with a short list; the engine's longer list still counts.
  const ad = makeAdapter({ kind: 'elm', answer: carAnswers({ kind: 'elm', pids: PIDS, extra: (cmd) => (cmd === '0100' ? '410000180000\r410008180000' : cmd === '0101' ? '410100040000\r41018107E400' : undefined) }) });
  const link = new CarLink({ bluetooth: ad.bluetooth });
  await link.connect();
  assert.ok(link.supported.has(0x05) && link.supported.has(0x0c) && link.supported.has(0x0d), [...link.supported].join(' '));
  assert.equal(link.checkEngine, true, 'the light of the second unit is seen');
  assert.equal(link.codes, 1);
  link.disconnect();
});

test('a recording with Porsche channels exports as CSV', () => {
  const load = (f) => JSON.parse(readFileSync(new URL(`../data/obdb/${f}`, import.meta.url), 'utf8'));
  const index = { ...indexSignalsets({ standard: load('SAEJ1979.json'), porsche: load('Porsche-911.json') }), decode: decodeSignal, unitOf: (u) => OBDB_UNITS[u] ?? '' };
  setStandardSignals(index);
  const link = new CarLink({ bluetooth: null });
  link.enhancedIndex = index;
  const req = porscheRequests(index, 2021).find((x) => x.key === '22:7E0:1503');
  link.rec = { id: 'rec-1', startedAt: Date.now(), endedAt: null, vehicle: null, adapter: 'x', channels: {}, samples: [] };
  for (const c of link.enhancedChannels(req)) link.record(c, c.f([0x41, 0x00]), Date.now());
  link.record(channelsFor(0x0c)[0], 1000, Date.now());
  const rec = JSON.parse(JSON.stringify(link.rec));
  const rows = recordingCSV(rec).trim().split('\n');
  assert.equal(rows.length, 1 + rec.samples.length);
  assert.ok(rows.some((x) => /,221503,/.test(x)), 'the Porsche request stands in the pid column');
  assert.ok(rows.some((x) => /,0C,/.test(x)));
});

test('the cockpit plan reads what the screen shows besides its gauges: targets, alert limits, oil temperature', () => {
  const gauges = MODES.performance.gauges.map(([id]) => GAUGES[id]);
  const supported = new Set([0x05, 0x0c, 0x0d, 0x11, 0x2f, 0x33, 0x34, 0x44, 0x5c, 0x62, 0x63, 0x6d, 0x70]);
  const ids = (plan) => new Set(plan.map((p) => p.id));
  const plan = ids(buildPlan(gauges, { supported, also: ['0105', '015C'] }));
  assert.ok(plan.has(`01:${0x44}`), 'the lambda target (PID 44) is read');
  assert.ok(plan.has('01:5'), 'the coolant alert limit is watched in Performance mode');
  assert.ok(plan.has(`01:${0x5c}`), 'oil temperature for the warm up line');
  assert.ok(!ids(buildPlan(gauges, { supported })).has('01:5'));
  // A target that is no longer current reads stale, so the screen does not show it as the car's target now.
  const now = 2_000_000;
  const r = readGauge(GAUGES.lambdaTarget, { get: () => ({ value: 0.85, t: now - 1_200_000, dt: 100 }), unitOf: () => '', supported, now });
  assert.equal(r.status, 'stale');
  assert.equal(PIDS01.get(0x68).bytes, 7);
});
