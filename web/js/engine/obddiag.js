// Car diagnostics from an OBD2 adapter or a BlueDriver (app/carlink.js): trouble codes (Mode 03 stored, 07 pending,
// 0A permanent), readiness monitors (Mode 01 PID 01), the VIN and other vehicle information (Mode 09). Pure
// functions on the adapter's text answers, in both formats the connection meets: ELM327 (mode and PID echoed,
// "43 02 01 33 04 20") and BlueDriver's data bytes only. Formulas and bit meanings: SAE J1979 as listed in
// https://en.wikipedia.org/wiki/OBD-II_PIDs. Live data decoding is engine/obdpids.js. Every answer is also kept in
// the session log (carlink.js) so a real sensor's answers can become test fixtures; nothing here is checked against
// a real car until then.

/// Hex bytes of each answer line: ISO-TP line numbers ("0:", "1:") and the byte count line ("014") dropped,
/// whitespace removed. Lines that are not hex (NO DATA, SEARCHING...) are skipped.
export function answerLines(text) {
  const out = [];
  for (const raw of String(text ?? '').toUpperCase().replace(/>/g, '').split(/[\r\n]+/)) {
    const t = raw.trim();
    if (/^0[0-9A-F]{2}$/.test(t)) continue;
    const line = t.replace(/^SEARCHING\.*/, '').replace(/^[0-9A-F]:\s*/, '').replace(/\s+/g, '');
    if (!line || !/^[0-9A-F]+$/.test(line) || line.length % 2) continue;
    const bytes = [];
    for (let i = 0; i < line.length; i += 2) bytes.push(parseInt(line.slice(i, i + 2), 16));
    out.push(bytes);
  }
  return out;
}

export function answerBytes(text) {
  return answerLines(text).flat();
}

/// "P0133" from two bytes (SAE J2012 layout: system letter, then four digits).
export function dtcCode(a, b) {
  const letter = 'PCBU'[a >> 6];
  return `${letter}${(a >> 4) & 3}${(a & 0xf).toString(16).toUpperCase()}${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

export const DTC_SYSTEMS = Object.freeze({ P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network' });

/// Trouble codes from a Mode 03, 07 or 0A answer. ELM327 answers start with the mode's echo (0x43, 0x47, 0x4A): on
/// CAN once, followed by a count byte; on older buses every line of three pairs repeats it. A BlueDriver answer may
/// carry the data bytes only. Pairs of zero bytes are padding. Returns { codes } or { problem }.
export function parseDTCs(text, mode) {
  const echo = 0x40 + mode;
  const upper = String(text ?? '').toUpperCase();
  if (/UNABLE ?TO ?CONNECT/.test(upper)) return { problem: 'noEngine' };
  const lines = answerLines(text);
  if (!lines.length) return /NO ?DATA/.test(upper) ? { codes: [] } : { problem: 'unreadable' };
  // Several lines that each start with the echo and are no numbered frames: every line is one answer of its own.
  // Older buses send the echo and three pairs per line; on CAN each control unit that answers sends its own line
  // (the echo, a count, then that many pairs), as a car whose engine and transmission both answer does.
  const framed = /^\s*[0-9A-F]:/m.test(upper);
  const perLine = lines.length > 1 && !framed && lines.every((l) => l[0] === echo);
  let bytes = perLine
    ? lines.flatMap((l) => { const b = l.slice(1); return b.length % 2 === 1 && b.length === 1 + 2 * b[0] ? b.slice(1) : b; })
    : lines.flat();
  // A multi frame CAN answer states its length first ("00A"); the last frame is padded past it.
  const declared = upper.match(/^\s*0([0-9A-F]{2})\s*$/m);
  if (!perLine && declared) bytes = bytes.slice(0, parseInt(declared[1], 16));
  if (!perLine && bytes[0] === echo) bytes = bytes.slice(1);
  // CAN: a count byte, then exactly that many pairs.
  if (bytes.length % 2 === 1 && bytes.length === 1 + 2 * bytes[0]) bytes = bytes.slice(1);
  if (bytes.length % 2) return { problem: 'unreadable' };
  const codes = [];
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) continue;
    const c = dtcCode(bytes[i], bytes[i + 1]);
    if (!codes.includes(c)) codes.push(c);
  }
  return { codes };
}

/// Readiness monitors from PID 01 01 (four bytes A B C D). Spark ignition (B bit 3 clear) and compression
/// ignition name the C/D bits differently. Each monitor: { name, supported, ready }.
export function readiness([a, b, c, d]) {
  const diesel = Boolean(b & 0x08);
  const continuous = [['Misfire', 0], ['Fuel system', 1], ['Components', 2]]
    .map(([name, bit]) => ({ name, supported: Boolean(b & (1 << bit)), ready: !(b & (1 << (bit + 4))) }));
  const names = diesel
    ? ['NMHC catalyst', 'NOx/SCR', null, 'Boost pressure', null, 'Exhaust gas sensor', 'PM filter', 'EGR/VVT']
    : ['Catalyst', 'Heated catalyst', 'Evaporative system', 'Secondary air', 'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR/VVT'];
  const tests = names.map((name, bit) => (name ? { name, supported: Boolean(c & (1 << bit)), ready: !(d & (1 << bit)) } : null)).filter(Boolean);
  return { checkEngine: Boolean(a & 0x80), codes: a & 0x7f, diesel, monitors: [...continuous, ...tests] };
}

/// The VIN from a Mode 09 PID 02 answer: the last 17 characters that can be in a VIN, from the ASCII bytes.
export function parseVIN(text) {
  const bytes = answerBytes(text);
  const chars = bytes.map((x) => String.fromCharCode(x)).join('').replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return chars.length >= 17 ? chars.slice(-17) : null;
}

/// Text from a Mode 09 answer (calibration IDs, ECU name): the bytes after the echo (0x49), the PID and, on CAN,
/// the item count, as printable characters; items padded with zeros are split. Null when there is none.
export function parseInfoText(text, pid) {
  let bytes = answerBytes(text);
  if (bytes[0] === 0x49 && bytes[1] === pid) bytes = bytes.slice(2);
  if (bytes.length && bytes[0] > 0 && bytes[0] <= 0x10) bytes = bytes.slice(1);
  const parts = String.fromCharCode(...bytes).split('\u0000').map((t) => t.replace(/[^\x20-\x7E]/g, '').trim()).filter(Boolean);
  // An ECU name is "ECM" and "-EngineControl" in two padded fields: one name.
  const joined = parts.reduce((out, t) => (t.startsWith('-') && out.length ? [...out.slice(0, -1), out[out.length - 1] + t] : [...out, t]), []);
  return joined.length ? joined.join(', ') : null;
}
