// Answers RECORDED from a real sensor: Jerry's BlueDriver (LemurMonitors LSB3-180DF9768F30, firmware BGX220P.2.4-3-0,
// OSAPI v3.16) on his 2021 Porsche 911 Turbo S, ignition on and engine off, through Safari with the beacio extension
// on iOS 18.7, Nov 6 2026 (the session log he copied from Diagnostics, Log). Wire bytes and decoded text as logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPID, parseAnswer, supports, bluedriverCodec, parseIdentity } from '../js/engine/obd.js';
import { parseDTCs, readiness } from '../js/engine/obddiag.js';
import { protocolName } from '../js/app/carlink.js';

const wire = (hex) => new Uint8Array(hex.split(' ').map((x) => parseInt(x, 16)));
const text = (hex) => new TextDecoder().decode(bluedriverCodec(wire(hex)));

test('real sensor: the scramble decodes its answers', () => {
  assert.equal(text('69 75 67 76 6f 06 50 15 08 17 10 0d 69 6d 0d 3e'), 'OSAPI v3.16\rOK\r>');
  assert.equal(text('11 60 06 0d 3e'), '7F \r>');
  assert.equal(text('68 69 06 62 67 72 67 0d 3e'), 'NO DATA\r>');
  // Our requests as they went out.
  assert.deepEqual([...bluedriverCodec(new TextEncoder().encode('012F\r'))], [...wire('16 17 14 60 0d')]);
  assert.deepEqual([...bluedriverCodec(new TextEncoder().encode('LMI\r'))], [...wire('6a 6b 6f 0d')]);
});

test('real sensor: identity and protocol', () => {
  assert.equal(parseIdentity('OSAPI v3.16\rOK\r'), 'OSAPI v3.16');
  assert.equal(protocolName('6\rOK\r'), 'ISO 15765-4 CAN (11 bit ID, 500 kbaud), protocol 6');
  assert.equal(protocolName('A6\r'), 'ISO 15765-4 CAN (11 bit ID, 500 kbaud), protocol 6');
  assert.equal(protocolName('AUTO, ISO 15765-4 (CAN 11/500)\r'), 'AUTO, ISO 15765-4 (CAN 11/500)');
});

test('real sensor: the PIDs a 2021 911 Turbo S lists', () => {
  const masks = { 0x00: 'BF 9C A8 93 \r', 0x20: '80 07 B1 19 \r', 0x40: 'FE D0 85 11 \r', 0x60: '61 09 82 01 \r', 0x80: '02 04 00 0D \r', 0xa0: '14 00 00 00 \r' };
  const listed = [];
  for (const [base, answer] of Object.entries(masks)) {
    const bytes = parseAnswer(answer, Number(base), 1, { bare: true }).bytes;
    for (let pid = Number(base) + 1; pid <= Number(base) + 32; pid++) if (supports(bytes, Number(base), pid)) listed.push(pid.toString(16).padStart(2, '0'));
  }
  assert.equal(listed.join(' '), '01 03 04 05 06 07 08 09 0c 0d 0e 11 13 15 19 1c 1f 20 21 2e 2f 30 31 33 34 38 3c 3d 40 41 42 43 44 45 46 47 49 4a 4c 51 56 58 5c 60 62 63 68 6d 70 71 77 80 87 8e 9d 9e a0 a4 a6');
});

test('real sensor: fuel level, voltage, live values', () => {
  assert.ok(Math.abs(readPID('fuelLevel', '7F \r', { bare: true }).value - 49.804) < 0.001);
  assert.equal(readPID('voltage', '32 A5 \r', { bare: true }).value, 12.965);
  assert.equal(readPID('voltage', '32 AA \r', { bare: true }).value, 12.97);
  assert.equal(readPID('speed', '00 \r', { bare: true }).value, 0);
  assert.equal(parseAnswer('00 00 \r', 0x0c, 1, { bare: true }).bytes.length, 2); // engine speed 0
  assert.deepEqual(parseAnswer('4B \r', 0x05, 1, { bare: true }).bytes, [0x4b]); // coolant 75 - 40 = 35 °C
});

test('real sensor: trouble codes and readiness', () => {
  assert.deepEqual(parseDTCs('NO DATA\r', 3), { codes: [] });
  assert.deepEqual(parseDTCs('24 50 \r', 7), { codes: ['P2450'] });
  assert.deepEqual(parseDTCs('NO DATA\r', 0x0a), { codes: [] });
  const r = readiness([0x00, 0x07, 0xe4, 0x00]);
  assert.equal(r.checkEngine, false);
  assert.equal(r.codes, 0);
  assert.deepEqual(r.monitors.filter((m) => m.supported).map((m) => `${m.name} ${m.ready ? 'ready' : 'not ready'}`),
    ['Misfire ready', 'Fuel system ready', 'Components ready', 'Evaporative system ready', 'Oxygen sensor ready', 'Oxygen sensor heater ready', 'EGR/VVT ready']);
});
