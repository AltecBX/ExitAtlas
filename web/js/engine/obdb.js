// Signals from the OBDb community signal sets (web/data/obdb, CC BY-SA 4.0, see NOTICE.md): the standard Mode 01
// PIDs ExitAtlas has no formula of its own for (SAEJ1979.json), and Porsche 911 manufacturer data (Mode 22, "read
// data by identifier", Porsche-911.json). Pure functions: decoding a signal from the data bytes, which requests apply
// to a model year, and how sure each one is.
//
// OBDb format (fmt): the value is `len` bits starting `bix` bits into the data (first bit = most significant bit of
// the first data byte), most significant byte first unless `blsb`; `sign` is two's complement; then
// value = raw * mul / div + add. `nullmin` / `nullmax`: values at or below / at or above mean "no value". `map`
// names raw values. `min` / `max` is the documented range.

/// OBDb units: the unit shown, before engine/obdpids.js toUS converts it to US units.
export const OBDB_UNITS = Object.freeze({
  celsius: '°C', fahrenheit: '°F', kilopascal: 'kPa', psi: 'psi', bars: 'bar', percent: '%', rpm: 'rpm', kilometersPerHour: 'km/h',
  newtonMeters: 'Nm', gramsPerSecond: 'g/s', kilogramsPerHour: 'kg/h', degrees: '°', radians: 'rad', volts: 'V', millivolts: 'mV',
  milliamps: 'mA', amps: 'A', seconds: 's', minutes: 'min', hours: 'h', milliseconds: 'ms', kilometers: 'km', miles: 'mi',
  liters: 'L', litersPerHour: 'L/h', kilowatts: 'kW', watts: 'W', kilowattHours: 'kWh', ampereHours: 'Ah', millimeters: 'mm',
  centimeters: 'cm', metersPerSecondSquared: 'm/s²', gravity: 'g', milliohms: 'mΩ', gramsPerLiter: 'g/L', milligramsPerStroke: 'mg/stroke',
  scalar: '', unknown: '', hex: 'hex', noyes: 'yes/no', yesno: 'yes/no', offon: 'on/off', kilowattHoursPer100Miles: 'kWh/100 mi',
});

/// One signal from the data bytes (after the service echo and PID or DID). Returns { value, text, outOfRange } or
/// null when the bytes are too short or the value means "no value".
export function decodeSignal(fmt, data) {
  const bix = fmt.bix ?? 0;
  const len = fmt.len;
  if (!len || bix + len > data.length * 8) return null;
  let bytesOrder = data;
  if (fmt.blsb && bix % 8 === 0 && len % 8 === 0) {
    const first = bix / 8;
    const n = len / 8;
    bytesOrder = Uint8Array.from(data);
    const field = [...data.slice(first, first + n)].reverse();
    for (let i = 0; i < n; i++) bytesOrder[first + i] = field[i];
  }
  let raw = 0;
  for (let i = bix; i < bix + len; i++) raw = raw * 2 + ((bytesOrder[i >> 3] >> (7 - (i & 7))) & 1);
  if (fmt.sign && raw >= 2 ** (len - 1)) raw -= 2 ** len;
  if (fmt.map) {
    const m = fmt.map[String(raw)];
    return { value: raw, text: m?.value ?? m?.description ?? String(raw), outOfRange: false };
  }
  const value = (raw * (fmt.mul ?? 1)) / (fmt.div ?? 1) + (fmt.add ?? 0);
  if (fmt.nullmax !== undefined && value >= fmt.nullmax) return null;
  if (fmt.nullmin !== undefined && value <= fmt.nullmin) return null;
  const outOfRange = (fmt.min !== undefined && value < fmt.min - 1e-9) || (fmt.max !== undefined && value > fmt.max + 1e-9);
  return { value, text: null, outOfRange };
}

/// A model year filter. OBDb does not document `from` + `to` together; the data uses both forms, so: `from` before
/// `to` is a range ({from: 2012, to: 2019}: 2012 to 2019); `from` after `to` leaves a gap ({to: 2016, from: 2018}:
/// up to 2016 or from 2018, everything but 2017). `years` adds single years.
export function inYears(f, year) {
  if (!f) return true;
  if ((f.years ?? []).includes(year)) return true;
  const hasFrom = f.from !== undefined;
  const hasTo = f.to !== undefined;
  if (!hasFrom && !hasTo) return false;
  if (hasFrom && hasTo) return f.from <= f.to ? year >= f.from && year <= f.to : year <= f.to || year >= f.from;
  return hasFrom ? year >= f.from : year <= f.to;
}

/// Whether a request applies to a model year (`filter`; no filter: every year). Unknown year: yes.
export function appliesTo(command, year) {
  return !year || !command.filter || inYears(command.filter, year);
}

/// Whether OBDb marks a request unconfirmed for a model year (`dbg`, or the year in `dbgfilter`).
export function unconfirmed(command, year) {
  if (command.dbg) return true;
  if (!command.dbgfilter) return false;
  return !year || inYears(command.dbgfilter, year);
}

/// A request's key: "01:70" for Mode 01, "22:7E0:1503" for Mode 22 at a module.
export function requestKey(command) {
  const [service, id] = Object.entries(command.cmd)[0];
  return service === '01' ? `01:${id.toUpperCase()}` : `${service}:${command.hdr}:${id.toUpperCase()}`;
}

/// Signal sets indexed for lookups: Mode 01 by PID, Mode 22 by key, and which DIDs more than one module answers
/// (with a request to every module at once, as the BlueDriver sends, such an answer cannot be told apart).
export function indexSignalsets({ standard = null, porsche = null } = {}) {
  const mode01 = new Map();
  for (const c of standard?.commands ?? []) {
    const id = c.cmd['01'];
    if (id) mode01.set(parseInt(id, 16), c);
  }
  const mode22 = new Map();
  const modulesByDid = new Map();
  for (const c of porsche?.commands ?? []) {
    const did = c.cmd['22'];
    if (!did) continue;
    mode22.set(requestKey(c), c);
    const set = modulesByDid.get(did.toUpperCase()) ?? new Set();
    set.add(c.hdr);
    modulesByDid.set(did.toUpperCase(), set);
  }
  return { mode01, mode22, modulesByDid, ecus: porsche?.ecu ?? [] };
}

/// The Porsche requests that apply to a model year, each with how sure it is: 'community' (OBDb confirms it for
/// the year), 'unconfirmed', and whether its DID is shared with another module ('shared').
export function porscheRequests(index, year) {
  const out = [];
  for (const [key, c] of index.mode22) {
    if (!appliesTo(c, year)) continue;
    const did = c.cmd['22'].toUpperCase();
    out.push({ key, hdr: c.hdr, did, command: c, freq: c.freq ?? 1, unconfirmed: unconfirmed(c, year),
      shared: (index.modulesByDid.get(did)?.size ?? 0) > 1, signals: (c.signals ?? []).filter((s) => !s.hidden) });
  }
  return out.sort((a, b) => (a.freq - b.freq) || a.key.localeCompare(b.key));
}

/// The data bytes of a Mode 22 answer: "62 15 03 xx xx" (ELM327, or a BlueDriver that keeps the echo) or the data
/// bytes alone (as the BlueDriver answers Mode 01). A negative response ("7F 22 31") or more than one module's
/// answer is reported, never decoded. `requireEcho` (ELM327, which always sends the echo): an answer without
/// "62" and the identifier is not this request's answer and is reported unreadable.
export function mode22Data(lines, did, { requireEcho = false } = {}) {
  const d = [parseInt(did.slice(0, 2), 16), parseInt(did.slice(2, 4), 16)];
  const answers = lines.filter((l) => l.length);
  if (!answers.length) return { problem: 'noData' };
  if (answers.some((l) => l[0] === 0x7f && l[1] === 0x22)) return { problem: 'refused', nrc: answers.find((l) => l[0] === 0x7f)[2] };
  if (answers.length > 1) return { problem: 'several' };
  const l = answers[0];
  if (l[0] === 0x62 && l[1] === d[0] && l[2] === d[1]) return { bytes: l.slice(3), echoed: true };
  if (requireEcho) return { problem: 'unreadable' };
  return { bytes: l, echoed: false };
}
