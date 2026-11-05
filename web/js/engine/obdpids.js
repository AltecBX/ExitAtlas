// Every standard live data item (SAE J1979 Service 01 PIDs) the car can list, with how to decode it: name, data
// bytes, channels (a PID can carry several values, e.g. an oxygen sensor's voltage and fuel trim), units in SI as
// the standard sends them (the views convert to US units), and the group it shows under. Formulas: SAE J1979 as
// listed in https://en.wikipedia.org/wiki/OBD-II_PIDs. A PID the car lists that is not here still shows, as raw
// bytes, so nothing the car offers is hidden.

const pct = ([a]) => (a * 100) / 255;
const trim = (a) => (a * 100) / 128 - 100;
const temp = ([a]) => a - 40;
const u16 = (a, b) => (a << 8) | b;
const s16 = (a, b) => { const v = u16(a, b); return v >= 0x8000 ? v - 0x10000 : v; };
// Groups in the order the live data screen shows them.
export const GROUPS = ['Engine', 'Fuel', 'Air', 'Temperatures', 'Oxygen sensors', 'Transmission', 'Emissions', 'Electrical', 'Status', 'Other (raw)'];

const FUEL_SYSTEM = { 0: 'Engine off', 1: 'Open loop, warming up', 2: 'Closed loop', 4: 'Open loop, load or decel', 8: 'Open loop, system fault', 16: 'Closed loop, sensor fault' };
const SECONDARY_AIR = { 1: 'Upstream', 2: 'Downstream of catalyst', 4: 'Outside or off', 8: 'Pump on for diagnostics' };
const OBD_STANDARD = { 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD and OBD-II', 4: 'OBD-I', 5: 'Not OBD compliant', 6: 'EOBD', 7: 'EOBD and OBD-II', 8: 'EOBD and OBD', 9: 'EOBD, OBD and OBD-II', 10: 'JOBD', 11: 'JOBD and OBD-II', 12: 'JOBD and EOBD', 13: 'JOBD, EOBD and OBD-II',
  14: 'OBD, EOBD and KOBD', 15: 'OBD, OBD-II, EOBD and KOBD', 17: 'EMD', 18: 'EMD+', 19: 'HD OBD-C', 20: 'HD OBD', 21: 'WWH OBD', 23: 'HD EOBD-I',
  24: 'HD EOBD-I N', 25: 'HD EOBD-II', 26: 'HD EOBD-II N', 27: 'Heavy Duty ZEV', 28: 'OBDBr-1', 29: 'OBDBr-2', 30: 'KOBD', 31: 'IOBD I', 32: 'IOBD II',
  33: 'HD EOBD-IV', 34: 'OBD, OBD-II and HD OBD', 35: 'OBDBr-3' };
const FUEL_TYPE = ['Not available', 'Gasoline', 'Methanol', 'Ethanol', 'Diesel', 'LPG', 'CNG', 'Propane', 'Electric', 'Bifuel gasoline',
  'Bifuel methanol', 'Bifuel ethanol', 'Bifuel LPG', 'Bifuel CNG', 'Bifuel propane', 'Bifuel electricity', 'Bifuel electric and combustion',
  'Hybrid gasoline', 'Hybrid ethanol', 'Hybrid diesel', 'Hybrid electric', 'Hybrid electric and combustion', 'Hybrid regenerative', 'Bifuel diesel'];

/// One value from a PID: [suffix, name, unit, decode(bytes) -> number or text or null, group?].
const ch = (suffix, name, unit, f) => ({ suffix, name, unit, f });

/// PID -> { name, bytes, group, channels }. A single channel PID has one channel with suffix ''.
export const PIDS01 = new Map();
const add = (pid, name, bytes, group, ...channels) => PIDS01.set(pid, { pid, name, bytes, group, channels: channels.length ? channels : [] });
const one = (pid, name, bytes, group, unit, f) => add(pid, name, bytes, group, ch('', name, unit, f));

one(0x03, 'Fuel system status', 2, 'Fuel', '', ([a]) => FUEL_SYSTEM[a] ?? `Code ${a}`);
one(0x04, 'Engine load', 1, 'Engine', '%', pct);
one(0x05, 'Coolant temperature', 1, 'Temperatures', '°C', temp);
one(0x06, 'Short term fuel trim, bank 1', 1, 'Fuel', '%', ([a]) => trim(a));
one(0x07, 'Long term fuel trim, bank 1', 1, 'Fuel', '%', ([a]) => trim(a));
one(0x08, 'Short term fuel trim, bank 2', 1, 'Fuel', '%', ([a]) => trim(a));
one(0x09, 'Long term fuel trim, bank 2', 1, 'Fuel', '%', ([a]) => trim(a));
one(0x0a, 'Fuel pressure', 1, 'Fuel', 'kPa', ([a]) => 3 * a);
one(0x0b, 'Intake manifold pressure', 1, 'Air', 'kPa', ([a]) => a);
one(0x0c, 'Engine speed', 2, 'Engine', 'rpm', ([a, b]) => u16(a, b) / 4);
one(0x0d, 'Vehicle speed', 1, 'Engine', 'km/h', ([a]) => a);
one(0x0e, 'Timing advance', 1, 'Engine', '° BTDC', ([a]) => a / 2 - 64);
one(0x0f, 'Intake air temperature', 1, 'Temperatures', '°C', temp);
one(0x10, 'Mass air flow', 2, 'Air', 'g/s', ([a, b]) => u16(a, b) / 100);
one(0x11, 'Throttle position', 1, 'Engine', '%', pct);
one(0x12, 'Secondary air status', 1, 'Emissions', '', ([a]) => SECONDARY_AIR[a] ?? `Code ${a}`);
one(0x13, 'Oxygen sensors present', 1, 'Oxygen sensors', '', ([a]) => `${[...Array(8).keys()].filter((i) => a & (1 << i)).map((i) => `B${(i >> 2) + 1}S${(i & 3) + 1}`).join(', ') || 'None'}`);
const o2Name = (i) => `B${(i >> 2) + 1}S${(i & 3) + 1}`;
for (let i = 0; i < 8; i++) {
  add(0x14 + i, `Oxygen sensor ${o2Name(i)}`, 2, 'Oxygen sensors',
    ch('v', `O2 ${o2Name(i)} voltage`, 'V', ([a]) => a / 200),
    ch('t', `O2 ${o2Name(i)} fuel trim`, '%', ([, b]) => (b === 0xff ? null : trim(b))));
}
one(0x1c, 'OBD standard', 1, 'Status', '', ([a]) => OBD_STANDARD[a] ?? `Code ${a}`);
one(0x1d, 'Oxygen sensors present (4 banks)', 1, 'Oxygen sensors', '', ([a]) => `${[...Array(8).keys()].filter((i) => a & (1 << i)).map((i) => `B${(i >> 1) + 1}S${(i & 1) + 1}`).join(', ') || 'None'}`);
one(0x1e, 'Power take off', 1, 'Status', '', ([a]) => (a & 1 ? 'Active' : 'Inactive'));
one(0x1f, 'Run time since start', 2, 'Engine', 's', ([a, b]) => u16(a, b));
one(0x21, 'Distance with check engine light on', 2, 'Status', 'km', ([a, b]) => u16(a, b));
one(0x22, 'Fuel rail pressure (vs manifold)', 2, 'Fuel', 'kPa', ([a, b]) => 0.079 * u16(a, b));
one(0x23, 'Fuel rail pressure', 2, 'Fuel', 'kPa', ([a, b]) => 10 * u16(a, b));
for (let i = 0; i < 8; i++) {
  add(0x24 + i, `Wide range O2 ${o2Name(i)}`, 4, 'Oxygen sensors',
    ch('l', `O2 ${o2Name(i)} lambda`, 'λ', ([a, b]) => (2 / 65536) * u16(a, b)),
    ch('v', `O2 ${o2Name(i)} voltage`, 'V', ([, , c, d]) => (8 / 65536) * u16(c, d)));
}
one(0x2c, 'Commanded EGR', 1, 'Emissions', '%', pct);
one(0x2d, 'EGR error', 1, 'Emissions', '%', ([a]) => trim(a));
one(0x2e, 'Commanded evaporative purge', 1, 'Emissions', '%', pct);
one(0x2f, 'Fuel level', 1, 'Fuel', '%', pct);
one(0x30, 'Warm ups since codes cleared', 1, 'Status', '', ([a]) => a);
one(0x31, 'Distance since codes cleared', 2, 'Status', 'km', ([a, b]) => u16(a, b));
one(0x32, 'Evap system vapor pressure', 2, 'Emissions', 'Pa', ([a, b]) => s16(a, b) / 4);
one(0x33, 'Barometric pressure', 1, 'Air', 'kPa', ([a]) => a);
for (let i = 0; i < 8; i++) {
  add(0x34 + i, `Wide range O2 ${o2Name(i)} current`, 4, 'Oxygen sensors',
    ch('l', `O2 ${o2Name(i)} lambda`, 'λ', ([a, b]) => (2 / 65536) * u16(a, b)),
    ch('c', `O2 ${o2Name(i)} current`, 'mA', ([, , c, d]) => u16(c, d) / 256 - 128));
}
one(0x3c, 'Catalyst temperature B1S1', 2, 'Temperatures', '°C', ([a, b]) => u16(a, b) / 10 - 40);
one(0x3d, 'Catalyst temperature B2S1', 2, 'Temperatures', '°C', ([a, b]) => u16(a, b) / 10 - 40);
one(0x3e, 'Catalyst temperature B1S2', 2, 'Temperatures', '°C', ([a, b]) => u16(a, b) / 10 - 40);
one(0x3f, 'Catalyst temperature B2S2', 2, 'Temperatures', '°C', ([a, b]) => u16(a, b) / 10 - 40);
one(0x42, 'Control module voltage', 2, 'Electrical', 'V', ([a, b]) => u16(a, b) / 1000);
one(0x43, 'Absolute load', 2, 'Engine', '%', ([a, b]) => (100 / 255) * u16(a, b));
one(0x44, 'Commanded air fuel ratio', 2, 'Fuel', 'λ', ([a, b]) => (2 / 65536) * u16(a, b));
one(0x45, 'Relative throttle position', 1, 'Engine', '%', pct);
one(0x46, 'Outside air temperature', 1, 'Temperatures', '°C', temp);
one(0x47, 'Throttle position B', 1, 'Engine', '%', pct);
one(0x48, 'Throttle position C', 1, 'Engine', '%', pct);
one(0x49, 'Accelerator pedal D', 1, 'Engine', '%', pct);
one(0x4a, 'Accelerator pedal E', 1, 'Engine', '%', pct);
one(0x4b, 'Accelerator pedal F', 1, 'Engine', '%', pct);
one(0x4c, 'Commanded throttle actuator', 1, 'Engine', '%', pct);
one(0x4d, 'Time with check engine light on', 2, 'Status', 'min', ([a, b]) => u16(a, b));
one(0x4e, 'Time since codes cleared', 2, 'Status', 'min', ([a, b]) => u16(a, b));
add(0x4f, 'Maximum values', 4, 'Status',
  ch('l', 'Max lambda', 'λ', ([a]) => a), ch('v', 'Max O2 voltage', 'V', ([, b]) => b), ch('c', 'Max O2 current', 'mA', ([, , c]) => c),
  ch('m', 'Max manifold pressure', 'kPa', ([, , , d]) => d * 10));
one(0x50, 'Maximum air flow', 4, 'Air', 'g/s', ([a]) => a * 10);
one(0x51, 'Fuel type', 1, 'Status', '', ([a]) => FUEL_TYPE[a] ?? `Code ${a}`);
one(0x52, 'Ethanol', 1, 'Fuel', '%', pct);
one(0x53, 'Absolute evap vapor pressure', 2, 'Emissions', 'kPa', ([a, b]) => u16(a, b) / 200);
one(0x54, 'Evap system vapor pressure', 2, 'Emissions', 'Pa', ([a, b]) => s16(a, b));
add(0x55, 'Short term secondary O2 trim, banks 1 and 3', 2, 'Oxygen sensors', ch('1', 'Short term secondary trim, bank 1', '%', ([a]) => trim(a)), ch('3', 'Short term secondary trim, bank 3', '%', ([, b]) => trim(b)));
add(0x56, 'Long term secondary O2 trim, banks 1 and 3', 2, 'Oxygen sensors', ch('1', 'Long term secondary trim, bank 1', '%', ([a]) => trim(a)), ch('3', 'Long term secondary trim, bank 3', '%', ([, b]) => trim(b)));
add(0x57, 'Short term secondary O2 trim, banks 2 and 4', 2, 'Oxygen sensors', ch('2', 'Short term secondary trim, bank 2', '%', ([a]) => trim(a)), ch('4', 'Short term secondary trim, bank 4', '%', ([, b]) => trim(b)));
add(0x58, 'Long term secondary O2 trim, banks 2 and 4', 2, 'Oxygen sensors', ch('2', 'Long term secondary trim, bank 2', '%', ([a]) => trim(a)), ch('4', 'Long term secondary trim, bank 4', '%', ([, b]) => trim(b)));
one(0x59, 'Fuel rail absolute pressure', 2, 'Fuel', 'kPa', ([a, b]) => 10 * u16(a, b));
one(0x5a, 'Relative accelerator pedal', 1, 'Engine', '%', pct);
one(0x5b, 'Hybrid battery remaining life', 1, 'Electrical', '%', pct);
one(0x5c, 'Engine oil temperature', 1, 'Temperatures', '°C', temp);
one(0x5d, 'Fuel injection timing', 2, 'Fuel', '°', ([a, b]) => u16(a, b) / 128 - 210);
one(0x5e, 'Engine fuel rate', 2, 'Fuel', 'L/h', ([a, b]) => u16(a, b) / 20);
one(0x61, "Driver's demand torque", 1, 'Engine', '%', ([a]) => a - 125);
one(0x62, 'Actual engine torque', 1, 'Engine', '%', ([a]) => a - 125);
one(0x63, 'Engine reference torque', 2, 'Engine', 'Nm', ([a, b]) => u16(a, b));
add(0x64, 'Engine percent torque data', 5, 'Engine',
  ch('i', 'Torque at idle', '%', ([a]) => a - 125), ch('1', 'Torque, engine point 1', '%', ([, b]) => b - 125),
  ch('2', 'Torque, engine point 2', '%', ([, , c]) => c - 125), ch('3', 'Torque, engine point 3', '%', ([, , , d]) => d - 125),
  ch('4', 'Torque, engine point 4', '%', ([, , , , e]) => e - 125));
// Multi sensor PIDs: the first byte says which sensors exist; a missing sensor reads null (shown as not supported).
add(0x66, 'Mass air flow sensors', 5, 'Air',
  ch('a', 'Air flow, sensor A', 'g/s', ([a, b, c]) => (a & 1 ? u16(b, c) / 32 : null)),
  ch('b', 'Air flow, sensor B', 'g/s', ([a, , , d, e]) => (a & 2 ? u16(d, e) / 32 : null)));
add(0x67, 'Coolant temperature sensors', 3, 'Temperatures',
  ch('1', 'Coolant, sensor 1', '°C', ([a, b]) => (a & 1 ? b - 40 : null)),
  ch('2', 'Coolant, sensor 2', '°C', ([a, , c]) => (a & 2 ? c - 40 : null)));
add(0x68, 'Intake air temperature sensors', 3, 'Temperatures',
  ch('1', 'Intake air, sensor 1', '°C', ([a, b]) => (a & 1 ? b - 40 : null)),
  ch('2', 'Intake air, sensor 2', '°C', ([a, , c]) => (a & 2 ? c - 40 : null)));
for (const [pid, bank] of [[0x78, 1], [0x79, 2]]) {
  add(pid, `Exhaust gas temperature, bank ${bank}`, 9, 'Temperatures',
    ...[0, 1, 2, 3].map((i) => ch(String(i + 1), `Exhaust gas, bank ${bank} sensor ${i + 1}`, '°C', (x) => (x[0] & (1 << i) ? u16(x[1 + 2 * i], x[2 + 2 * i]) / 10 - 40 : null))));
}
one(0x7f, 'Total engine run time', 13, 'Engine', 's', ([, b, c, d, e]) => b * 2 ** 24 + c * 2 ** 16 + d * 2 ** 8 + e);
one(0x8e, 'Engine friction torque', 1, 'Engine', '%', ([a]) => a - 125);
one(0xa2, 'Cylinder fuel rate', 2, 'Fuel', 'mg/stroke', ([a, b]) => u16(a, b) / 32);
one(0xa4, 'Transmission gear ratio', 4, 'Transmission', 'ratio', ([a, , c, d]) => (a & 2 ? u16(c, d) / 1000 : null));
one(0xa5, 'Commanded DEF dosing', 4, 'Emissions', '%', ([a, b]) => (a & 1 ? b / 2 : null));
one(0xa6, 'Odometer', 4, 'Status', 'km', ([a, b, c, d]) => (a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d) / 10);
one(0xa9, 'ABS disable switch', 4, 'Status', '', ([a, b]) => (a & 1 ? (b & 1 ? 'Yes' : 'No') : null));

/// The "supported PIDs" PIDs (00, 20, ... E0) and the bit mask ones (monitor status 01 and 41), read elsewhere.
export const MASK_PIDS = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0];
export const NOT_LIVE = new Set([...MASK_PIDS, 0x01, 0x02, 0x41]);

/// The channels to poll for a PID the car lists: its table entry, or one raw channel showing the bytes.
export function channelsFor(pid) {
  const e = PIDS01.get(pid);
  const hex = pid.toString(16).toUpperCase().padStart(2, '0');
  if (e) return e.channels.map((c) => ({ ...c, key: `01${hex}${c.suffix}`, pid, group: e.group, pidName: e.name, bytes: e.bytes }));
  return [{ key: `01${hex}`, pid, group: 'Other (raw)', pidName: `PID ${hex}`, name: `PID ${hex} (raw)`, unit: 'hex', bytes: 1, raw: true,
    f: (bytes) => bytes.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ') }];
}

/// US units for a value in the standard's units: [value, unit].
export function toUS(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return [value, unit];
  switch (unit) {
    case '°C': return [value * 1.8 + 32, '°F'];
    case 'km/h': return [value * 0.621371, 'mph'];
    case 'km': return [value * 0.621371, 'mi'];
    case 'kPa': return [value * 0.145038, 'psi'];
    case 'L/h': return [value * 0.264172, 'gal/h'];
    default: return [value, unit];
  }
}

/// Decimal places to show for a US unit.
export function digitsFor(unit) {
  return { V: 2, λ: 3, 'g/s': 1, psi: 1, 'gal/h': 2, '%': 1, mA: 2, Pa: 0 }[unit] ?? 0;
}
