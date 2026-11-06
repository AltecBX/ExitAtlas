import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDTCs, dtcCode, readiness, parseVIN, parseInfoText } from '../js/engine/obddiag.js';
import { PIDS01, channelsFor, toUS, MASK_PIDS, NOT_LIVE } from '../js/engine/obdpids.js';
// Car diagnostics decoding (engine/obddiag.js, engine/obdpids.js). Answers are written in the formats the ELM327
// documents (CAN with and without line numbers, older buses) and as data bytes only (BlueDriver); they are not
// recorded from a car. Formulas: SAE J1979 as listed in https://en.wikipedia.org/wiki/OBD-II_PIDs.

test('trouble codes: SAE J2012 letters and digits, every answer format, padding dropped', () => {
  assert.equal(dtcCode(0x01, 0x33), 'P0133');
  assert.equal(dtcCode(0x44, 0x20), 'C0420');
  assert.equal(dtcCode(0xc1, 0x00), 'U0100');
  assert.deepEqual(parseDTCs('430201330420\r\r', 3), { codes: ['P0133', 'P0420'] });          // CAN, headers off
  assert.deepEqual(parseDTCs('43 01 33 04 20 00 00\r43 01 71 00 00 00 00\r', 3), { codes: ['P0133', 'P0420', 'P0171'] }); // older bus
  assert.deepEqual(parseDTCs('4700\r', 7), { codes: [] });
  assert.deepEqual(parseDTCs('NO DATA\r', 10), { codes: [] });
  assert.deepEqual(parseDTCs('02 01 33 04 20 \r', 3), { codes: ['P0133', 'P0420'] });        // data only, count byte
  assert.deepEqual(parseDTCs('01 33 04 20 \r', 3), { codes: ['P0133', 'P0420'] });           // data only
  assert.deepEqual(parseDTCs('UNABLE TO CONNECT', 3), { problem: 'noEngine' });
  assert.deepEqual(parseDTCs('00A\r0: 43 04 01 33 04 20\r1: 01 71 03 00 00 00 00\r', 3), { codes: ['P0133', 'P0420', 'P0171', 'P0300'] });
});
test('readiness', () => {
  const r = readiness([0x81, 0x07, 0x65, 0x04]);
  assert.equal(r.checkEngine, true); assert.equal(r.codes, 1); assert.equal(r.diesel, false);
  const by = Object.fromEntries(r.monitors.map((m) => [m.name, m]));
  assert.deepEqual(by.Misfire, { name: 'Misfire', supported: true, ready: true });
  assert.deepEqual(by['Evaporative system'], { name: 'Evaporative system', supported: true, ready: false });
  assert.deepEqual(by.Catalyst, { name: 'Catalyst', supported: true, ready: true });
  assert.deepEqual(by['Secondary air'], { name: 'Secondary air', supported: false, ready: true });
});
test('vin', () => {
  assert.equal(parseVIN('014\r0: 49 02 01 57 50 30\r1: 41 42 32 41 39 34 4D\r2: 53 31 32 33 34 35 36\r'), 'WP0AB2A94MS123456');
  assert.equal(parseVIN('57 50 30 41 42 32 41 39 34 4D 53 31 32 33 34 35 36 \r'), 'WP0AB2A94MS123456');
  assert.equal(parseVIN('NO DATA'), null);
});
test('vehicle information texts: ECU name halves joined, calibration IDs split', () => {
  assert.equal(parseInfoText('49 0A 01 45 43 4D 00 2D 45 6E 67 69 6E 65 00 00', 0x0a), 'ECM-Engine');
  assert.equal(parseInfoText('014\r0: 49 04 01 31 30 33 37\r1: 33 38 34 37 30 30 00\r2: 00 00 00 00 00 00 00', 4), '1037384700');
});

test('the live data table: formulas from SAE J1979 for the common items, raw bytes for the rest', () => {
  const v = (pid, bytes, k = 0) => channelsFor(pid)[k].f(bytes);
  assert.equal(v(0x0c, [0x0f, 0x80]), 992);                 // rpm (256A+B)/4
  assert.equal(v(0x05, [0x5a]), 50);                         // A-40 °C
  assert.equal(v(0x0e, [0x80]), 0);                          // A/2-64
  assert.equal(v(0x10, [0x01, 0xf4]), 5);                    // (256A+B)/100 g/s
  assert.ok(Math.abs(v(0x06, [0x80])) < 1e-9);               // 100/128 A - 100
  assert.equal(v(0x14, [0x5a, 0xff], 0), 0.45);              // O2 voltage A/200
  assert.equal(v(0x14, [0x5a, 0xff], 1), null);              // B = FF: not used for trim
  assert.equal(v(0x24, [0x80, 0x00, 0x80, 0x00], 0), 1);     // lambda 2/65536 (256A+B)
  assert.equal(v(0x24, [0x80, 0x00, 0x80, 0x00], 1), 4);     // 8/65536 (256C+D) V
  assert.equal(v(0x32, [0xff, 0xfc]), -1);                   // signed /4 Pa
  assert.equal(v(0x3c, [0x1a, 0x2c]), 630);                  // (256A+B)/10-40 °C
  assert.equal(v(0x42, [0x31, 0x2c]), 12.588);               // V
  assert.equal(v(0x5e, [0x00, 0x64]), 5);                    // L/h
  assert.equal(v(0xa4, [0x02, 0x00, 0x0b, 0xb8], 1), 3);     // gear ratio when supported
  assert.equal(v(0xa4, [0x00, 0x00, 0x0b, 0xb8], 1), null);  // not supported
  assert.equal(v(0xa4, [0x01, 0x40, 0x0b, 0xb8], 0), 4);     // actual gear: upper half of B
  assert.equal(v(0xa4, [0x02, 0x40, 0x0b, 0xb8], 0), null);  // gear not supported
  assert.equal(v(0xa6, [0x00, 0x00, 0x75, 0x30]), 3000);     // odometer km
  assert.deepEqual(channelsFor(0x78).map((c) => c.f([0x03, 0x1a, 0x2c, 0x1a, 0x90, 0, 0, 0, 0])), [630, 640, null, null]);
  const raw = channelsFor(0x9a)[0];
  assert.equal(raw.raw, true);
  assert.equal(raw.f([0x01, 0xab]), '01 AB');
  assert.ok(PIDS01.size >= 100, `${PIDS01.size} PIDs decoded`);
  for (const m of MASK_PIDS) assert.ok(NOT_LIVE.has(m));
  assert.deepEqual(toUS(100, '°C'), [212, '°F']);
  assert.ok(Math.abs(toUS(100, 'kPa')[0] - 14.5038) < 1e-6);
});
