// The car connection's decoding (engine/obd.js). The answers below are written in the ELM327's documented answer
// format (echo, spaces, line feeds and headers off: hex bytes, a carriage return per line, ">" when ready); they
// are not recorded from a car or an adapter, which this repository has not been connected to yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { command, parseAnswer, readPID, supports, monitorStatus, parseVoltage, parseIdentity, steadyFuel, rangeFromFuel, SETUP_COMMANDS, BLUEDRIVER_SETUP, bluedriverCodec } from '../js/engine/obd.js';

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

// BlueDriver (unofficial): the byte scramble and answers as described by github.com/sjalkote/bluedriver-reverse-engineering
// (data bytes only, spaces on), written here in that format; not recorded from a sensor.
test('BlueDriver scramble: XOR 0x26 both ways, carriage return and > untouched', () => {
  const plain = new TextEncoder().encode('012F\r');
  const wire = bluedriverCodec(plain);
  assert.deepEqual([...wire], [0x30 ^ 0x26, 0x31 ^ 0x26, 0x32 ^ 0x26, 0x46 ^ 0x26, 0x0d]);
  assert.equal(new TextDecoder().decode(bluedriverCodec(wire)), '012F\r');
  assert.deepEqual([...bluedriverCodec(new Uint8Array([0x3e, 0x0d]))], [0x3e, 0x0d]);
});

test('BlueDriver setup: its own LM commands in its order, no AT commands', () => {
  assert.deepEqual(BLUEDRIVER_SETUP, ['LMI', 'LMD', 'LML0', 'LMI', 'LMD', 'LMDP', 'LMI', 'LMX1', 'LMX0']);
  assert.ok(BLUEDRIVER_SETUP.every((c) => !c.startsWith('AT')));
});

test('BlueDriver answers carry the data bytes only; one with the mode and PID still reads right', () => {
  assert.ok(Math.abs(readPID('fuelLevel', '9A \r', { bare: true }).value - 60.392) < 0.01);
  assert.ok(Math.abs(readPID('fuelLevel', '41 2F 9A \r', { bare: true }).value - 60.392) < 0.01);
  assert.deepEqual(parseAnswer('BE 3E B8 11 \r', 0x00, 1, { bare: true }).bytes, [0xbe, 0x3e, 0xb8, 0x11]);
  assert.equal(readPID('voltage', '31 2C \r', { bare: true }).value, 12.588);
  assert.deepEqual(readPID('fuelLevel', 'NO DATA\r', { bare: true }), { problem: 'noData' });
  assert.equal(parseIdentity('OSAPI v2.60\r'), 'OSAPI v2.60');
});

test('a failed device list: beacio setup problems (reported as NotFoundError) and timeouts get the right next step', async () => {
  const { pickerHint } = await import('../js/app/carlink.js');
  const err = (name, message) => ({ name, message });
  assert.match(pickerHint(err('NotFoundError', 'User has not enabled Web Bluetooth for this origin.')), /Allow on Every Website/);
  assert.match(pickerHint(err('NotFoundError', 'Beacio activation timed out')), /Allow on Every Website/);
  assert.match(pickerHint(err('TimeoutError', 'Request timed out')), /Open the beacio app once/);
  assert.match(pickerHint(err('NotFoundError', 'No device found')), /Show all Bluetooth devices/);
  assert.match(pickerHint(err('SecurityError', 'Must be handling a user gesture')), /Tap Connect car again/);
  assert.match(pickerHint(err('Error', 'something else')), /Copy the connection log/);
});

test('an answer longer than one CAN frame: the numbered frames joined and cut at the byte count', () => {
  // PID 70, boost pressure control: 12 bytes in two frames (ELM327 format, headers off), padding after the count.
  assert.deepEqual(parseAnswer('00C\r0:41700317C016\r1:80000000000000\r\r>', 0x70).bytes, [0x03, 0x17, 0xc0, 0x16, 0x80, 0, 0, 0, 0, 0]);
  assert.deepEqual(parseAnswer('410C2710\r', 0x0c).bytes, [0x27, 0x10]);
});
