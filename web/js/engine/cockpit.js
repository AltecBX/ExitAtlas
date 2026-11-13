// The Porsche 911 Turbo S cockpit (app/cockpit.js draws it): which gauges exist, what feeds each one, how a reading
// becomes a needle position, and what the scanner is asked for while the cockpit is open. Pure functions.
//
// Every gauge reads a channel the car reported (engine/obdpids.js keys: "010C" engine speed; OBDb keys
// "0170_BP_A_ACT"; Porsche Mode 22 keys "227E01503_911_EOP"), or is CALCULATED from such channels and labeled so
// (boost = boost pressure sensor minus barometric pressure). Nothing is ever filled in: a gauge without its data says
// why (not reported by this car, not answered, stale, not probed yet).
import { toUS, digitsFor } from './obdpids.js';

const KPA_PSI = 0.145038;
const NM_LBFT = 0.737562;
/// Gasoline's stoichiometric air fuel ratio for the AFR readout (lambda x 14.7). E10 is about 14.1: the readout is
/// labeled calculated, and lambda itself is shown beside it.
export const STOICH = 14.7;

/// Porsche Mode 22 requests the cockpit uses (OBDb Porsche-911, Experimental; key "22:<module>:<DID>", signal id).
export const PORSCHE = Object.freeze({
  oilPressure: { req: '22:7E0:1503', signal: '911_EOP' },
  pdkTemp: { req: '22:7E1:38BF', signal: '911_ATF_T_2' },
  engineTorque: { req: '22:7E0:1010', signal: '911_ENGINE_TORQUE' },
  knock2: { req: '22:7E0:10E6', signal: '911_KNOCK_RETARD_2' },
  egt1: { req: '22:7E0:166F', signal: '911_EXH_GAS_T_SENS_1' },
  chargeActual: { req: '22:7E0:202A', signal: '911_CHARGE_AIR_P_ACTUAL' },
  chargeSpec: { req: '22:7E0:2029', signal: '911_CHARGE_AIR_P_SPECIFIED' },
});

/// The channel key of a Porsche signal (carlink.js enhancedChannels: "22" + module + DID + "_" + signal id).
export const porscheKey = ({ req, signal }) => { const [, hdr, did] = req.split(':'); return `22${hdr}${did}_${signal}`; };

/// Gauges. kind: dial (needle), digit (gear), bar. src: a channel key; calc: inputs and a function of their values
/// (in the channel's own units) giving the gauge's unit. speed: 'fast' (every pass), 'slow' (every few seconds).
/// zones: [from, to, 'warn' | 'red'] in the gauge's unit, defaults the driver can change.
export const GAUGES = Object.freeze({
  speed: { label: 'Speed', unit: 'mph', kind: 'dial', min: 0, max: 220, step: 20, labelEvery: 2, src: '010D', speed: 'fast' },
  rpm: { label: 'RPM', unit: 'rpm', kind: 'dial', min: 0, max: 8000, step: 1000, scale: 1000, src: '010C', speed: 'fast', redline: true },
  boost: { label: 'Boost', unit: 'psi', kind: 'dial', min: -15, max: 30, step: 5, digits: 1, speed: 'fast', calculated: 'sensor minus barometric',
    calc: { inputs: ['0170_BP_A_ACT', '0133'], f: ([p, baro]) => (p - baro) * KPA_PSI }, dual: 'boostTarget' },
  boostTarget: { label: 'Boost target', unit: 'psi', kind: 'dial', min: -15, max: 30, step: 5, digits: 1, speed: 'fast', calculated: 'commanded minus barometric',
    calc: { inputs: ['0170_BP_A_CMD', '0133'], f: ([p, baro]) => (p - baro) * KPA_PSI } },
  gear: { label: 'Gear', unit: '', kind: 'digit', src: '01A4G', speed: 'fast', text: (v) => (v === 0 ? 'N' : String(v)) },
  oilTemp: { label: 'Oil temp', unit: '°F', kind: 'dial', min: 100, max: 320, step: 40, src: '015C', speed: 'slow', zones: [[266, 320, 'red']] },
  oilPressure: { label: 'Oil pressure', unit: 'psi', kind: 'dial', min: 0, max: 120, step: 20, digits: 0, src: porscheKey(PORSCHE.oilPressure), speed: 'fast', porsche: 'oilPressure', zones: [[0, 10, 'red']] },
  coolant: { label: 'Coolant', unit: '°F', kind: 'dial', min: 100, max: 280, step: 40, src: '0105', speed: 'slow', zones: [[230, 280, 'red']] },
  pdkTemp: { label: 'PDK temp', unit: '°F', kind: 'dial', min: 50, max: 300, step: 50, src: porscheKey(PORSCHE.pdkTemp), speed: 'slow', porsche: 'pdkTemp', zones: [[250, 300, 'red']] },
  voltage: { label: 'Battery', unit: 'V', kind: 'dial', min: 10, max: 16, step: 1, digits: 1, src: '0142', speed: 'slow', zones: [[10, 12, 'warn'], [15, 16, 'red']] },
  fuel: { label: 'Fuel', unit: '%', kind: 'bar', min: 0, max: 100, src: '012F', speed: 'slow', zones: [[0, 15, 'warn']] },
  iat: { label: 'Intake air', unit: '°F', kind: 'dial', min: 0, max: 200, step: 40, src: '01681', speed: 'slow', zones: [[150, 200, 'warn']] },
  chargeAir: { label: 'Charge air', unit: '°F', kind: 'dial', min: 0, max: 250, step: 50, src: '0177_CACT_11', speed: 'slow', zones: [[170, 250, 'warn']] },
  load: { label: 'Engine load', unit: '%', kind: 'bar', min: 0, max: 100, src: '0104', speed: 'fast' },
  throttle: { label: 'Throttle', unit: '%', kind: 'bar', min: 0, max: 100, src: '0111', speed: 'fast' },
  pedal: { label: 'Pedal', unit: '%', kind: 'bar', min: 0, max: 100, src: '0149', speed: 'fast' },
  railPressure: { label: 'Fuel rail', unit: 'psi', kind: 'dial', min: 0, max: 5000, step: 1000, scale: 1000, src: '016D_FRP_A', speed: 'fast', dual: 'railTarget' },
  railTarget: { label: 'Fuel rail target', unit: 'psi', kind: 'dial', min: 0, max: 5000, step: 1000, src: '016D_FRP_A_CMD', speed: 'fast' },
  lambda: { label: 'Lambda B1', unit: 'λ', kind: 'dial', min: 0.6, max: 1.4, step: 0.2, digits: 3, src: '0134l', speed: 'fast', dual: 'lambdaTarget' },
  lambdaTarget: { label: 'Lambda target', unit: 'λ', kind: 'dial', min: 0.6, max: 1.4, step: 0.2, digits: 3, src: '0144', speed: 'fast' },
  afr: { label: 'AFR B1', unit: ':1', kind: 'dial', min: 9, max: 20, step: 2, digits: 1, speed: 'fast', calculated: `lambda x ${STOICH}`,
    calc: { inputs: ['0134l'], f: ([l]) => l * STOICH } },
  afr2: { label: 'AFR B2', unit: ':1', kind: 'dial', min: 9, max: 20, step: 2, digits: 1, speed: 'fast', calculated: `lambda x ${STOICH}`,
    calc: { inputs: ['0138l'], f: ([l]) => l * STOICH } },
  timing: { label: 'Timing', unit: '°', kind: 'dial', min: -10, max: 50, step: 10, digits: 1, src: '010E', speed: 'fast' },
  stft1: { label: 'STFT B1', unit: '%', kind: 'bar', min: -25, max: 25, src: '0106', speed: 'fast', zones: [[-25, -10, 'warn'], [10, 25, 'warn']] },
  ltft1: { label: 'LTFT B1', unit: '%', kind: 'bar', min: -25, max: 25, src: '0107', speed: 'slow', zones: [[-25, -10, 'warn'], [10, 25, 'warn']] },
  stft2: { label: 'STFT B2', unit: '%', kind: 'bar', min: -25, max: 25, src: '0108', speed: 'fast', zones: [[-25, -10, 'warn'], [10, 25, 'warn']] },
  ltft2: { label: 'LTFT B2', unit: '%', kind: 'bar', min: -25, max: 25, src: '0109', speed: 'slow', zones: [[-25, -10, 'warn'], [10, 25, 'warn']] },
  map: { label: 'Manifold (abs)', unit: 'psi', kind: 'dial', min: 0, max: 45, step: 5, digits: 1, src: '0170_BP_A_ACT', speed: 'fast' },
  torque: { label: 'Torque', unit: 'lb·ft', kind: 'dial', min: 0, max: 700, step: 100, speed: 'fast', calculated: 'actual % x reference',
    calc: { inputs: ['0162', '0163'], f: ([pct, ref]) => (pct / 100) * ref * NM_LBFT } },
  torquePct: { label: 'Torque', unit: '%', kind: 'bar', min: 0, max: 100, src: '0162', speed: 'fast' },
  vgt: { label: 'Turbo VGT A', unit: '%', kind: 'bar', min: 0, max: 100, src: '0171_VGT_A_ACT', speed: 'fast' },
  knock: { label: 'Knock retard', unit: '°', kind: 'bar', min: 0, max: 10, src: porscheKey(PORSCHE.knock2), speed: 'fast', porsche: 'knock2' },
  egt: { label: 'EGT 1', unit: '°F', kind: 'dial', min: 0, max: 1800, step: 300, src: porscheKey(PORSCHE.egt1), speed: 'slow', porsche: 'egt1' },
  ambient: { label: 'Outside', unit: '°F', kind: 'bar', min: -20, max: 120, src: '0146', speed: 'slow' },
});

/// The four modes' gauges, in order, with their size (L large, M medium, S small).
export const MODES = Object.freeze({
  drive: { name: 'Driving', gauges: [['rpm', 'L'], ['speed', 'L'], ['boost', 'M'], ['gear', 'M'], ['oilTemp', 'S'], ['oilPressure', 'S'], ['coolant', 'S'], ['pdkTemp', 'S']] },
  performance: { name: 'Performance', gauges: [['boost', 'L'], ['rpm', 'L'], ['torque', 'M'], ['timing', 'M'], ['afr', 'M'], ['lambda', 'M'], ['railPressure', 'M'], ['throttle', 'S'], ['pedal', 'S'], ['load', 'S'], ['vgt', 'S'], ['chargeAir', 'S'], ['knock', 'S']] },
  health: { name: 'Engine health', gauges: [['oilTemp', 'M'], ['oilPressure', 'M'], ['coolant', 'M'], ['iat', 'M'], ['voltage', 'M'], ['pdkTemp', 'M'], ['stft1', 'S'], ['ltft1', 'S'], ['stft2', 'S'], ['ltft2', 'S'], ['fuel', 'S'], ['ambient', 'S']] },
  custom: { name: 'Custom', gauges: [] },
});

/// A gauge for any channel (Custom mode): range from the channel's documented range or its readings so far.
export function channelGauge(channel, stats = null) {
  const [, unit] = toUS(1, channel.unit);
  const conv = (x) => (typeof x === 'number' ? toUS(x, channel.unit)[0] : null);
  let [lo, hi] = (channel.range ?? []).map(conv);
  if (lo == null || hi == null || !(hi > lo)) {
    const a = conv(stats?.min);
    const b = conv(stats?.max);
    lo = Math.min(0, a ?? 0); hi = Math.max(b != null ? b * 1.25 : 100, lo + 1);
  }
  return { label: channel.name, unit, kind: 'dial', min: lo, max: hi, step: niceStep(hi - lo), src: channel.key, speed: 'fast', custom: true };
}

/// A round step for about 5 to 8 labeled marks across a span.
export function niceStep(span) {
  const raw = span / 6;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => span / x <= 8) ?? 10 * p;
}

/// The channel keys a gauge needs.
export const inputsOf = (g) => (g.calc ? g.calc.inputs : [g.src]);

/// The request a channel key comes from: Mode 01 "01xx..." -> { kind: '01', pid }; Porsche "22hhhdddd_..." ->
/// { kind: '22', key: '22:hhh:dddd' }.
export function requestOf(key) {
  if (/^01[0-9A-F]{2}/.test(key)) return { kind: '01', pid: parseInt(key.slice(2, 4), 16) };
  const m = key.match(/^22([0-9A-F]{3})([0-9A-F]{4})_/);
  return m ? { kind: '22', key: `22:${m[1]}:${m[2]}` } : null;
}

/// How often (ms) the scanner is asked: fast gauges every pass, slow ones every 5 s, fixed facts every minute.
const FIXED = new Set([0x63, 0x33, 0x51]);
export const periodFor = (speed, pid) => (pid != null && FIXED.has(pid) ? 60000 : speed === 'slow' ? 5000 : 0);

/// What the scanner reads while these gauges are on screen: each request once, at the fastest period any gauge
/// needs. Mode 01 PIDs the car does not list are left out; Porsche requests only when Porsche data is enabled, and
/// not once a probe found they do not answer. The fuel level is always in it (the range planner uses it).
/// A gauge's second needle (its target) is read too, and so is what the screen shows or watches besides its
/// gauges (`also`: channel keys read every 5 s: the driver's alert limits, the oil temperature of the warm up line).
export function buildPlan(gauges, { supported = null, porscheResults = null, porscheReqs = null, porsche = false, also = [] } = {}) {
  const plan = new Map();
  const want = (id, item) => { const was = plan.get(id); if (!was || item.period < was.period) plan.set(id, item); };
  const add = (key, speed) => {
    const r = requestOf(key);
    if (!r) return;
    if (r.kind === '01') {
      if (supported && !supported.has(r.pid)) return;
      want(`01:${r.pid}`, { id: `01:${r.pid}`, kind: '01', pid: r.pid, period: periodFor(speed, r.pid) });
    } else if (porsche) {
      const st = porscheResults?.get(r.key);
      if (st && st !== 'ok') return;
      const req = porscheReqs?.get(r.key);
      if (!req) return;
      want(r.key, { id: r.key, kind: '22', req, period: Math.max(speed === 'slow' ? 5000 : 500, (req.freq ?? 1) * 1000 > 60000 ? 60000 : 0) });
    }
  };
  for (const g of gauges) {
    for (const key of inputsOf(g)) add(key, g.speed);
    const target = g.dual ? GAUGES[g.dual] : null;
    if (target) for (const key of inputsOf(target)) add(key, target.speed);
  }
  for (const key of also) add(key, 'slow');
  if (!supported || supported.has(0x2f)) want('01:47', { id: '01:47', kind: '01', pid: 0x2f, period: 10000 });
  return [...plan.values()];
}

/// A gauge's reading now. get(key) gives { value, t, dt } in the channel's units (or null). Returns
/// { value (gauge unit), status, age } where status is: live, stale, waiting, unsupported (the car does not list
/// it), noAnswer, notProbed, shared (Porsche data a BlueDriver cannot tell apart), or the Porsche probe result.
export function readGauge(g, { get, unitOf, supported = null, status = null, porscheResults = null, porsche = false, now = Date.now(), staleMs = 3000 }) {
  const keys = inputsOf(g);
  const values = [];
  let oldest = Infinity;
  let stale = false;
  for (const key of keys) {
    const r = requestOf(key);
    if (r?.kind === '01') {
      if (supported && !supported.has(r.pid)) return { value: null, status: 'unsupported' };
      const st = status?.get(r.pid);
      if (st && st !== 'ok' && !get(key)) return { value: null, status: 'noAnswer' };
    } else if (r?.kind === '22') {
      if (!porsche) return { value: null, status: 'notProbed' };
      const st = porscheResults?.get(r.key);
      if (st && st !== 'ok' && !get(key)) return { value: null, status: st === 'shared' ? 'shared' : 'unsupported' };
    }
    const v = get(key);
    if (!v || typeof v.value !== 'number' || !Number.isFinite(v.value)) return { value: null, status: 'waiting' };
    values.push(g.calc ? v.value : toUS(v.value, unitOf(key))[0]);
    // Stale: an input older than 3 s or 3 of its own update intervals; slow gauges allow 10 s more, and fixed facts
    // (barometric pressure, reference torque, read once a minute) 2 minutes more.
    const age = now - v.t;
    const allowed = Math.max(staleMs, 3 * (v.dt ?? 0)) + (r?.kind === '01' && FIXED.has(r.pid) ? 120000 : g.speed === 'slow' ? 10000 : 0);
    if (age > allowed) stale = true;
    if (!(r?.kind === '01' && FIXED.has(r.pid))) oldest = Math.min(oldest, v.t);
  }
  const value = g.calc ? g.calc.f(values) : values[0];
  if (!Number.isFinite(value)) return { value: null, status: 'waiting' };
  return { value, status: stale ? 'stale' : 'live', age: Number.isFinite(oldest) ? now - oldest : 0 };
}

/// The dial's sweep in degrees (from -120 to +120, 0 straight up): the bottom gap holds the digital readout.
export const SWEEP = 240;

/// Needle angle (degrees, 0 = straight up) for a value on the dial, clamped to its ends.
export function needleAngle(value, min, max, sweep = SWEEP) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return -sweep / 2;
  const f = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return -sweep / 2 + f * sweep;
}

/// The digits a gauge shows.
export const gaugeDigits = (g) => g.digits ?? digitsFor(g.unit);

/// The zone a value is in: 'red', 'warn' or null (gauge defaults, then the driver's own alert limits).
export function zoneOf(value, zones = [], redline = null) {
  if (typeof value !== 'number') return null;
  if (redline != null && value >= redline) return 'red';
  let out = null;
  for (const [a, b, kind] of zones) if (value >= a && value <= b) out = kind === 'red' ? 'red' : out ?? 'warn';
  return out;
}

/// Peaks since the cockpit opened or was reset: the highest reading of each tracked gauge, with when.
export function updatePeaks(peaks, readings, t = Date.now()) {
  const next = { ...peaks };
  for (const [id, r] of Object.entries(readings)) {
    if (r?.status !== 'live' || typeof r.value !== 'number') continue;
    if (!next[id] || r.value > next[id].value) next[id] = { value: r.value, t };
  }
  return next;
}

/// Engine warm up from the oil temperature (°F): below the threshold the driver set (default 176 °F, 80 °C, a
/// common rule of thumb; Porsche's own figure is in the owner's manual), the cockpit says the engine is cold.
export function warmup(oilTempF, threshold = 176) {
  if (typeof oilTempF !== 'number') return null;
  return oilTempF < threshold ? { cold: true, toGo: threshold - oilTempF } : { cold: false };
}

/// Connection quality from the scanner statistics: good, fair, poor; null without data.
export function linkQuality({ latency = null, requests = null, timeouts = 0, answers = 0 } = {}) {
  if (latency == null || !answers) return null;
  const dropRate = timeouts / Math.max(1, answers + timeouts);
  if (dropRate > 0.1 || latency > 800) return 'poor';
  if (dropRate > 0.02 || latency > 350 || (requests != null && requests < 2)) return 'fair';
  return 'good';
}
