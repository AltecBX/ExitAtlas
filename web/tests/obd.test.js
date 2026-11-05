// The car connection's decoding (engine/obd.js). The answers below are written in the ELM327's documented answer
// format (echo, spaces, line feeds and headers off: hex bytes, a carriage return per line, ">" when ready); they
// are not recorded from a car or an adapter, which this repository has not been connected to yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { command, parseAnswer, readPID, supports, monitorStatus, parseVoltage, parseIdentity, steadyFuel, rangeFromFuel, SETUP_COMMANDS } from '../js/engine/obd.js';

test('commands: mode and PID as four hex digits; setup turns echo, spaces and headers off and picks the protocol', () => {
  assert.equal(command(0x2f), '012F');
  assert.equal(command(0x00), '0100');
  assert.equal(command(0x0d), '010D');
  assert.deepEqual(SETUP_COMMANDS, ['ATD', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']);
});

test('fuel level: 0x9A is 60.4%, 0xFF is 100%, 0 is 0%', () => {
  assert.ok(Math.abs(readPID('fuelLevel', '412F9A\r\r').value - 60.392) < 0.01);
  assert.equal(readPID('fuelLevel', '412FFF\r\r>').value, 100);
  assert.equal(readPID('fuelLevel', '412F00').value, 0);
  // With spaces left on, and after the protocol search.
  assert.ok(Math.abs(readPID('fuelLevel', 'SEARCHING...\r41 2F 9A\r\r>').value - 60.392) < 0.01);
});

test('several control units answer: the first complete answer wins', () => {
  assert.equal(readPID('speed', '410D41\r410D41\r\r').value, 65);
});

test('no data, ignition off and bus errors are problems, never a value', () => {
  assert.deepEqual(readPID('fuelLevel', 'NO DATA\r\r>'), { problem: 'noData' });
  assert.deepEqual(readPID('fuelLevel', 'SEARCHING...\rUNABLE TO CONNECT\r\r>'), { problem: 'noEngine' });
  assert.deepEqual(readPID('fuelLevel', 'CAN ERROR\r\r>'), { problem: 'busError' });
  assert.deepEqual(readPID('fuelLevel', '?\r\r>'), { problem: 'unknownCommand' });
  assert.deepEqual(readPID('fuelLevel', 'OK\r\r>'), { problem: 'unreadable' });
  // An answer to another PID is not this one's.
  assert.deepEqual(readPID('fuelLevel', '410D41\r\r>'), { problem: 'unreadable' });
});

test('supported PIDs: bit masks for 01 to 20 and 21 to 40', () => {
  const first = parseAnswer('4100BE3EB811\r\r', 0x00).bytes;
  assert.deepEqual(first, [0xbe, 0x3e, 0xb8, 0x11]);
  assert.equal(supports(first, 0x00, 0x01), true);   // 0xBE: 1011 1110, PID 01 is the first bit
  assert.equal(supports(first, 0x00, 0x02), false);
  assert.equal(supports(first, 0x00, 0x20), true);   // last bit of 0x11: the next range is supported
  const second = parseAnswer('4120A007B011\r\r', 0x20).bytes;
  assert.equal(supports(second, 0x20, 0x2f), true);  // PID 2F is bit 15 of the range: 0x07 has 0x02 set
  assert.equal(supports(parseAnswer('4120A005B011', 0x20).bytes, 0x20, 0x2f), false);
  assert.equal(supports(second, 0x20, 0x20), false); // outside the range
});

test('check engine light and stored codes, voltage and adapter identity', () => {
  assert.deepEqual(monitorStatus([0x83, 0x07, 0x65, 0x00]), { checkEngine: true, codes: 3 });
  assert.deepEqual(monitorStatus([0x00, 0x07, 0x65, 0x00]), { checkEngine: false, codes: 0 });
  assert.equal(parseVoltage('12.6V\r\r>'), 12.6);
  assert.equal(parseVoltage('?\r'), null);
  assert.equal(parseIdentity('\rELM327 v1.5\r\r>'), 'ELM327 v1.5');
});

test('steady fuel: the median of the last 90 seconds, so slosh does not swing the range', () => {
  const r = [{ t: 0, percent: 61 }, { t: 5, percent: 55 }, { t: 10, percent: 60 }, { t: 15, percent: 66 }, { t: 20, percent: 60.4 }];
  assert.equal(steadyFuel(r, 20), 60.4);
  assert.equal(steadyFuel([{ t: 0, percent: 50 }], 200), null); // too old
  assert.equal(steadyFuel([], 0), null);
  assert.equal(steadyFuel([{ t: 0, percent: 40 }, { t: 5, percent: 42 }], 5), 41);
});

test('range from the fuel level: share of the tank times tank size times mpg; nothing without a tank size', () => {
  assert.ok(Math.abs(rangeFromFuel(60.4, 15, 30) - 271.8) < 1e-9);
  assert.equal(rangeFromFuel(60, null, 30), null);
  assert.equal(rangeFromFuel(null, 15, 30), null);
  assert.equal(rangeFromFuel(120, 10, 20), 200);
});
