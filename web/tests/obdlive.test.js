// Live car data helpers (engine/obdlive.js). Answers are written in the ELM327's documented format for a request
// with several PIDs on CAN (mode echoed once, each PID then its data bytes; more than 7 bytes come as numbered frames
// after a byte count line); they are not recorded from a car or an adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundPIDs, batches, multiCommand, answerMessages, parseMulti, alertState, alertRule, recordingCSV, recordingSeries,
  indexAt, playbackAt, SLOW_EVERY } from '../js/engine/obdlive.js';

test('rounds: fast PIDs every round, slow ones in round 0 and every few rounds; pinned only reads just those', () => {
  const pids = [0x04, 0x05, 0x0c, 0x0d, 0x2f, 0x46];
  assert.deepEqual(roundPIDs(pids, 0), pids);
  assert.deepEqual(roundPIDs(pids, 1), [0x04, 0x0c, 0x0d]);
  assert.deepEqual(roundPIDs(pids, SLOW_EVERY), pids);
  assert.deepEqual(roundPIDs(pids, 3, { only: new Set([0x05, 0x0c]) }), [0x05, 0x0c]);
});

test('batches: up to six known PIDs per request; a PID without a known length goes alone', () => {
  assert.deepEqual(batches([0x04, 0x05, 0x0c], 1), [[0x04], [0x05], [0x0c]]);
  assert.deepEqual(batches([1, 2, 3, 4, 5, 6, 7].map((x) => x + 3), 6), [[4, 5, 6, 7, 8, 9], [10]]);
  assert.deepEqual(batches([0x0c, 0xfe, 0x0d], 6), [[0xfe], [0x0c, 0x0d]]);
  assert.equal(multiCommand([0x0c, 0x0d, 0x05]), '010C0D05');
});

test('several PIDs in one frame: each PID with its own bytes', () => {
  const m = parseMulti('410C0F800D41055A\r\r>', [0x0c, 0x0d, 0x05]);
  assert.deepEqual([...m], [[0x0c, [0x0f, 0x80]], [0x0d, [0x41]], [0x05, [0x5a]]]);
  // With spaces left on.
  assert.deepEqual(parseMulti('41 0C 0F 80 0D 41 \r', [0x0c, 0x0d]).get(0x0d), [0x41]);
});

test('several PIDs in numbered frames: joined in order, padding past the byte count dropped', () => {
  const text = '00C\r0:410C0F800D41\r1:055A11290F2E00\r\r>';
  const m = parseMulti(text, [0x0c, 0x0d, 0x05, 0x11, 0x0f]);
  assert.deepEqual([...m.keys()], [0x0c, 0x0d, 0x05, 0x11, 0x0f]);
  assert.deepEqual(m.get(0x0f), [0x2e]);
  assert.deepEqual(answerMessages(text), [[0x41, 0x0c, 0x0f, 0x80, 0x0d, 0x41, 0x05, 0x5a, 0x11, 0x29, 0x0f, 0x2e]]);
});

test('two control units: both single frame answers read, the first value of a PID wins', () => {
  const m = parseMulti('410C0F800D41\r410D42\r', [0x0c, 0x0d]);
  assert.deepEqual(m.get(0x0d), [0x41]);
  assert.equal(m.size, 2);
});

test('answers that cannot be split with certainty are refused, never guessed', () => {
  // Frames out of order (two control units interleaved).
  assert.equal(parseMulti('00C\r0:410C0F800D41\r00C\r0:410C0F800D41\r1:055A11290F2E\r', [0x0c, 0x0d]), null);
  // A PID that was not asked for.
  assert.equal(parseMulti('410C0F800D41\r', [0x0c]), null);
  // Bytes that run short.
  assert.equal(parseMulti('410C0F\r', [0x0c]), null);
  // Shorter than the byte count.
  assert.equal(parseMulti('00C\r0:410C0F800D41\r', [0x0c, 0x0d]), null);
  // No data: nothing, not an error.
  assert.equal(parseMulti('NO DATA\r', [0x0c]).size, 0);
});

test('alerts: above the high limit, below the low one, and no flapping on the line', () => {
  const rule = { low: 12, high: 230 };
  assert.equal(alertState(231, rule, null), 'high');
  assert.equal(alertState(229.5, rule, 'high'), 'high'); // within 1% of the limit: still on
  assert.equal(alertState(227, rule, 'high'), null);
  assert.equal(alertState(11.9, rule, null), 'low');
  assert.equal(alertState(12.05, rule, 'low'), 'low');
  assert.equal(alertState(12.5, rule, 'low'), null);
  assert.equal(alertState('0F80', rule, 'high'), 'high'); // not a number: unchanged
  assert.equal(alertState(500, null, null), null);
});

test('alert rule from the form: either limit may be empty; nonsense is refused', () => {
  assert.deepEqual(alertRule('', '6,500'), { low: null, high: 6500 });
  assert.deepEqual(alertRule('12', ''), { low: 12, high: null });
  assert.equal(alertRule('', ''), null);
  assert.equal(alertRule('abc', ''), null);
  assert.equal(alertRule('300', '200'), null);
});

const REC = {
  startedAt: Date.UTC(2026, 10, 5, 19, 0, 0),
  channels: {
    '010C': { pid: 0x0c, name: 'Engine speed', unit: 'rpm' },
    '0105': { pid: 0x05, name: 'Coolant temperature', unit: '°C' },
    '0100X': { pid: 0xfe, name: 'PID FE, "raw"', unit: 'hex' },
  },
  samples: [[0, '010C', 800], [100, '0105', 90], [500, '010C', 2400.5], [600, '0100X', '0A0B'], [1000, '010C', 1200]],
};

test('CSV: one row per reading, in the units the app shows, text quoted', () => {
  const csv = recordingCSV(REC).split('\n');
  assert.equal(csv[0], 'time,elapsed_s,pid,sensor,value,unit');
  assert.equal(csv[1], '2026-11-05T19:00:00.000Z,0.000,0C,Engine speed,800,rpm');
  assert.equal(csv[2], '2026-11-05T19:00:00.100Z,0.100,05,Coolant temperature,194,°F');
  assert.equal(csv[4], '2026-11-05T19:00:00.600Z,0.600,FE,"PID FE, ""raw""",0A0B,hex');
  assert.equal(csv.length, 7); // header, five readings, final newline
});

test('playback: value at a time, minimum, maximum and average up to then, recent history', () => {
  const s = recordingSeries(REC).get('010C');
  assert.deepEqual(s.t, [0, 500, 1000]);
  assert.equal(indexAt(s.t, -1), -1);
  assert.equal(indexAt(s.t, 499), 0);
  assert.equal(indexAt(s.t, 500), 1);
  assert.equal(indexAt(s.t, 99999), 2);
  assert.equal(playbackAt(s, -5), null);
  const p = playbackAt(s, 700);
  assert.equal(p.value, 2400.5);
  assert.equal(p.min, 800);
  assert.equal(p.max, 2400.5);
  assert.equal(p.n, 2);
  assert.deepEqual(playbackAt(s, 1000, 600).history, [[500, 2400.5], [1000, 1200]]);
});
