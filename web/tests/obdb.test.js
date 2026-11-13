// OBDb signal sets (engine/obdb.js, web/data/obdb): the decoder against the format's documented rules, model year
// filters, Porsche answers, and the cross-check that lets a PID be called verified by two sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSignal, appliesTo, unconfirmed, indexSignalsets, porscheRequests, mode22Data, requestKey } from '../js/engine/obdb.js';
import { PIDS01, channelsFor, TWO_SOURCES } from '../js/engine/obdpids.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../data/obdb/${f}`, import.meta.url), 'utf8'));
const standard = load('SAEJ1979.json');
const porsche = load('Porsche-911.json');
const index = indexSignalsets({ standard, porsche });

test('decoding: bits from the most significant end, mul, div, add, sign, little endian, null limits, names', () => {
  assert.equal(decodeSignal({ len: 16, div: 4 }, Uint8Array.from([0x0f, 0x80])).value, 992);          // engine speed
  assert.equal(decodeSignal({ bix: 8, len: 4 }, Uint8Array.from([0x01, 0x30])).value, 3);              // upper half of B
  assert.equal(decodeSignal({ len: 8, sign: true, mul: 3, div: 4 }, Uint8Array.from([0xfc])).value, -3); // knock retard -4 * 3/4
  assert.equal(decodeSignal({ len: 16, blsb: true }, Uint8Array.from([0x34, 0x12])).value, 0x1234);
  assert.equal(decodeSignal({ len: 16, div: 4, nullmax: 16383.5 }, Uint8Array.from([0xff, 0xff])), null);
  assert.equal(decodeSignal({ len: 8, map: { 1: { value: 'ON' } } }, Uint8Array.from([1])).text, 'ON');
  assert.equal(decodeSignal({ len: 16 }, Uint8Array.from([1])), null);                                 // too short
  assert.equal(decodeSignal({ len: 8, max: 100, mul: 100, div: 255 }, Uint8Array.from([0xff])).outOfRange, false);
});

test('two sources: every PID marked so agrees with OBDb on random bytes', () => {
  let checked = 0;
  for (const pid of TWO_SOURCES) {
    const c = index.mode01.get(pid);
    assert.ok(c, `OBDb has PID ${pid.toString(16)}`);
    const sigs = c.signals.filter((s) => !s.hidden && !s.fmt.map && !['noyes', 'yesno', 'offon'].includes(s.fmt.unit));
    const chans = channelsFor(pid).filter((ch) => !ch.raw && ch.unit !== 'gear');
    const pairs = pid === 0xa4 ? [[chans[0], sigs.find((s) => s.id === 'GEAR_RAT')], [channelsFor(pid).find((x) => x.unit === 'gear'), sigs.find((s) => s.id === 'GEAR_ACT')]]
      : chans.map((ch, i) => [ch, sigs[i]]);
    assert.ok(pairs.length && pairs.every(([a, b]) => a && b), `PID ${pid.toString(16)}: every channel has an OBDb signal to compare`);
    for (let trial = 0; trial < 200; trial++) {
      const bytes = Array.from({ length: Math.max(PIDS01.get(pid).bytes, 8) }, () => Math.floor(Math.random() * 256));
      for (const [ch, sig] of pairs) {
        const mine = ch.f(bytes);
        const theirs = decodeSignal(sig.fmt, Uint8Array.from(bytes));
        if (typeof mine !== 'number' || !theirs) continue;
        assert.ok(Math.abs(mine - theirs.value) <= 1e-6 * Math.max(1, Math.abs(mine)), `PID ${pid.toString(16)} ${ch.name}: ${mine} vs ${theirs.value}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 5000);
});

test('model years: a request applies inside its filter; unconfirmed years are marked', () => {
  const gear = porsche.commands.find((c) => c.hdr === '7E0' && c.cmd['22'] === '100D');
  assert.equal(appliesTo(gear, 2019), true);
  assert.equal(appliesTo(gear, 2021), false);                       // filter to 2019
  const oil = porsche.commands.find((c) => c.hdr === '7E0' && c.cmd['22'] === '1503');
  assert.equal(appliesTo(oil, 2021), true);
  assert.equal(unconfirmed(oil, 2021), true);                       // dbgfilter from 2018
  assert.equal(unconfirmed(oil, 2017), false);
  assert.equal(requestKey(oil), '22:7E0:1503');
});

test('Porsche requests for a 2021 car: oil pressure there, the DID shared by engine and transmission flagged', () => {
  const reqs = porscheRequests(index, 2021);
  const oil = reqs.find((r) => r.key === '22:7E0:1503');
  assert.ok(oil && oil.signals[0].name === 'Engine oil pressure' && oil.signals[0].fmt.unit === 'psi');
  assert.equal(decodeSignal(oil.signals[0].fmt, Uint8Array.from([0x41, 0x00])).value, 0x4100 / 416); // 40.0 psi
  assert.equal(reqs.find((r) => r.key === '22:7E0:1102').shared, true); // engine oil temperature vs a TCM current
  assert.ok(!reqs.some((r) => r.key === '22:7E0:100D'));                // gear engaged ends with 2019
  assert.ok(reqs.length > 300);
});

test('Mode 22 answers: with or without the echo; refusals, silence and two modules are never decoded', () => {
  assert.deepEqual(mode22Data([[0x62, 0x15, 0x03, 0x41, 0x00]], '1503'), { bytes: [0x41, 0x00], echoed: true });
  assert.deepEqual(mode22Data([[0x41, 0x00]], '1503'), { bytes: [0x41, 0x00], echoed: false });
  // An ELM327 always sends the echo: a Mode 01 answer that landed here is not decoded as oil pressure.
  assert.deepEqual(mode22Data([[0x41, 0x0c, 0x0f, 0xa0]], '1503', { requireEcho: true }), { problem: 'unreadable' });
  assert.deepEqual(mode22Data([[0x62, 0x15, 0x03, 0x41, 0x00]], '1503', { requireEcho: true }), { bytes: [0x41, 0x00], echoed: true });
  assert.deepEqual(mode22Data([[0x7f, 0x22, 0x31]], '1503'), { problem: 'refused', nrc: 0x31 });
  assert.deepEqual(mode22Data([], '1503'), { problem: 'noData' });
  assert.deepEqual(mode22Data([[0x62, 0x11, 0x02, 0x80], [0x62, 0x11, 0x02, 0x00, 0x10]], '1102'), { problem: 'several' });
});
