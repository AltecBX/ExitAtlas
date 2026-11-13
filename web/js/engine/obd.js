// Reading the car's own data through an OBD2 adapter that speaks the ELM327 command set (OBDLink CX, vLinker and
// most Bluetooth LE adapters), or a BlueDriver sensor (unofficial, below). Pure functions: the commands to send,
// and what the adapter's text answers mean. The Bluetooth side lives in app/carlink.js.
//
// The adapter answers in text: hex bytes, a carriage return per line, and ">" when it is ready for the next
// command. With echo, line feeds, spaces and headers off (the setup below), "012F" (mode 01, PID 2F: fuel tank
// level) is answered "412F9A\r\r>": 0x41 is mode 01's answer, then the PID, then the data (0x9A = 154, so
// 154 * 100 / 255 = 60.4%). PID meanings and formulas: SAE J1979 (Mode 01), as listed in
// https://en.wikipedia.org/wiki/OBD-II_PIDs.

/// Sent once after connecting: defaults, echo off, no line feeds, no spaces, no headers, automatic protocol.
export const SETUP_COMMANDS = Object.freeze(['ATD', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']);

/// BlueDriver (unofficial; Jerry's decision, Nov 5 2026: BlueDriver does not support other apps). Its sensor talks
/// through a Silicon Labs BGX module (Xpress Streaming Service, documented by Silicon Labs) to firmware that
/// answers ELM327 style requests, with two differences recorded by github.com/sjalkote/bluedriver-reverse-engineering
/// (notes only; no code copied): every byte except carriage return and ">" is XORed with 0x26 both ways, and the
/// setup is its own "LM" commands, in this order. AT commands put it in a state where every request answers NO
/// DATA, so none are sent. Answers carry the data bytes only, with spaces ("9A \r>"), no mode and PID.
export const BLUEDRIVER_SETUP = Object.freeze(['LMI', 'LMD', 'LML0', 'LMI', 'LMD', 'LMDP', 'LMI', 'LMX1', 'LMX0']);

/// The BlueDriver's byte scramble: XOR 0x26, except carriage return (0x0D) and ">" (0x3E). The same both ways.
export function bluedriverCodec(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] === 0x0d || bytes[i] === 0x3e ? bytes[i] : bytes[i] ^ 0x26;
  return out;
}

/// The PIDs read, with how to decode their data bytes.
export const PIDS = Object.freeze({
  supported01: { pid: 0x00, bytes: 4 },
  monitor: { pid: 0x01, bytes: 4 },
  speed: { pid: 0x0d, bytes: 1, decode: ([a]) => a },
  coolant: { pid: 0x05, bytes: 1, decode: ([a]) => a - 40 },
  supported21: { pid: 0x20, bytes: 4 },
  fuelLevel: { pid: 0x2f, bytes: 1, decode: ([a]) => (a * 100) / 255 },
  /// Control module voltage (the battery while running), for adapters without ATRV (BlueDriver).
  voltage: { pid: 0x42, bytes: 2, decode: ([a, b]) => ((a << 8) | b) / 1000 },
});

/// "012F" for mode 01, PID 0x2F.
export function command(pid, mode = 1) {
  return `${mode.toString(16).padStart(2, '0')}${pid.toString(16).padStart(2, '0')}`.toUpperCase();
}

/// Answers that mean no data, with what to tell the driver.
const PROBLEMS = [
  [/UNABLE ?TO ?CONNECT/, 'noEngine'],
  [/NO ?DATA/, 'noData'],
  [/CAN ?ERROR|BUS ?ERROR|BUS ?BUSY|FB ?ERROR|DATA ?ERROR|<RX ?ERROR/, 'busError'],
  [/BUFFER ?FULL/, 'busError'],
  [/STOPPED/, 'stopped'],
  [/^\?$/, 'unknownCommand'],
];

/// The data bytes of a Mode 01 answer to `pid`, or { problem } when the adapter or car gave none. Takes the
/// adapter's whole answer up to ">". Several control units can answer: `bytes` is the first complete answer and
/// `all` every unit's (for the questions where each unit's answer counts: the PIDs listed, the check engine light).
/// `bare`: the answer is the data bytes alone (BlueDriver); a line that does carry the mode and PID still reads right.
export function parseAnswer(text, pid, mode = 1, { bare = false } = {}) {
  let lines = String(text ?? '').toUpperCase().replace(/>/g, '').split(/[\r\n]+/)
    .map((l) => l.replace(/\s+/g, '').replace(/^SEARCHING\.*/, '')).filter(Boolean);
  // An answer longer than one CAN frame (more than 4 data bytes for a PID) comes as a byte count line ("00C") and
  // numbered frames ("0:...", "1:..."): joined into one line, cut at the count (the last frame is padded).
  if (lines.length > 1 && /^[0-9A-F]{3}$/.test(lines[0]) && /^0:/.test(lines[1])) {
    const count = parseInt(lines[0], 16);
    const joined = [];
    let i = 1;
    for (let n = 0; i < lines.length && lines[i].startsWith(`${(n % 16).toString(16).toUpperCase()}:`); i++, n++) joined.push(lines[i].slice(2));
    lines = [joined.join('').slice(0, count * 2), ...lines.slice(i)];
  }
  const head = `${(mode + 0x40).toString(16)}${pid.toString(16).padStart(2, '0')}`.toUpperCase();
  if (bare) {
    for (const line of lines) {
      if (!/^[0-9A-F]+$/.test(line) || line.length % 2) continue;
      const hex = line.startsWith(head) && line.length > head.length ? line.slice(head.length) : line;
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
      return { bytes, all: [bytes] };
    }
  }
  const all = [];
  for (const line of lines) {
    const at = line.indexOf(head);
    if (at < 0 || !/^[0-9A-F]+$/.test(line.slice(at))) continue;
    const hex = line.slice(at + head.length);
    if (hex.length < 2 || hex.length % 2) continue;
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    all.push(bytes);
  }
  if (all.length) return { bytes: all[0], all };
  const whole = lines.join(' ');
  for (const [re, problem] of PROBLEMS) if (lines.some((l) => re.test(l)) || re.test(whole)) return { problem };
  return { problem: 'unreadable' };
}

/// The value of a PID from the adapter's answer: { value } or { problem }.
export function readPID(name, text, { bare = false } = {}) {
  const p = PIDS[name];
  const r = parseAnswer(text, p.pid, 1, { bare });
  if (r.problem) return r;
  if (r.bytes.length < p.bytes) return { problem: 'unreadable' };
  return { value: p.decode ? p.decode(r.bytes) : r.bytes.slice(0, p.bytes) };
}

/// Whether a "supported PIDs" answer (PID 0x00 for 0x01 to 0x20, 0x20 for 0x21 to 0x40) lists `pid`. The four
/// bytes are a bit mask, the first bit for the first PID of the range.
export function supports(maskBytes, base, pid) {
  const i = pid - base - 1;
  if (!maskBytes || i < 0 || i >= 32) return false;
  return Boolean(maskBytes[i >> 3] & (0x80 >> (i & 7)));
}

/// Check engine light and the number of stored trouble codes, from PID 0x01's first byte.
export function monitorStatus(bytes) {
  return { checkEngine: Boolean(bytes[0] & 0x80), codes: bytes[0] & 0x7f };
}

/// The adapter's battery voltage answer to "ATRV" ("12.6V"), in volts, or null.
export function parseVoltage(text) {
  const m = String(text ?? '').match(/(\d{1,2}\.\d)\s*V/i);
  return m ? Number(m[1]) : null;
}

/// The adapter's name and version from its answer to "ATI" ("ELM327 v1.5", "STN2255 v5.6.19").
export function parseIdentity(text) {
  const line = String(text ?? '').replace(/>/g, '').split(/[\r\n]+/).map((l) => l.trim()).find((l) => /v\d/i.test(l));
  return line ?? null;
}

/// The fuel level the driver sees: the median of the readings in the last `windowSeconds` (fuel sloshes; the
/// sender is noisy, about 5%), or null with none. Readings are { t, percent }.
export function steadyFuel(readings, now, windowSeconds = 90) {
  const recent = readings.filter((r) => now - r.t <= windowSeconds).map((r) => r.percent).sort((a, b) => a - b);
  if (!recent.length) return null;
  const mid = recent.length >> 1;
  return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
}

/// Miles of range from a fuel level: the share of the tank times what a full tank goes (tank size times mpg).
/// Null without a tank size.
export function rangeFromFuel(percent, tankGallons, mpg) {
  if (!(tankGallons > 0) || !(mpg > 0) || percent == null) return null;
  return (Math.max(0, Math.min(100, percent)) / 100) * tankGallons * mpg;
}

/// What a problem means for the driver.
export const PROBLEM_TEXT = Object.freeze({
  noEngine: 'The car is not answering. Turn the ignition on (engine running is best).',
  noData: 'The car did not answer this request.',
  busError: 'The adapter could not talk to the car. Check it is pushed fully into the OBD2 port.',
  stopped: 'The adapter stopped the request. Trying again.',
  unknownCommand: 'The adapter did not understand a standard command. It may not be ELM327 compatible.',
  bluedriverState: 'The BlueDriver stopped answering requests. Unplug it for a few seconds, plug it back in, then Connect car again.',
  unreadable: 'The adapter sent an answer ExitAtlas could not read.',
  noFuelPID: 'Your car does not report its fuel level over OBD2. Enter miles to empty from the dashboard instead.',
});
