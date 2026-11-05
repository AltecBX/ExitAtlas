// Live car data helpers for the diagnostics screen (app/carlink.js, app/views.js): several PIDs in one request,
// which PIDs to read each round, threshold alerts, and recordings (CSV export and playback). Pure functions.
//
// Several PIDs per request: SAE J1979 lets a CAN request carry up to six Mode 01 PIDs; the ELM327 sends them as one
// request ("010C0D05") and prints the answer, with the mode echoed once and each PID followed by its data bytes,
// in one frame or in several ("00A", "0:...", "1:..."). This is only used once the adapter has answered one such
// request correctly (carlink.js probes at connect); everything else reads one PID per request.
import { PIDS01, toUS } from './obdpids.js';

export const MULTI_MAX = 6;

/// PIDs that change slowly (temperatures, levels, distances, fixed facts): read every SLOW_EVERY rounds.
export const SLOW_PIDS = new Set([0x05, 0x1c, 0x1f, 0x21, 0x2f, 0x30, 0x31, 0x33, 0x3c, 0x3d, 0x3e, 0x3f, 0x42, 0x46,
  0x4d, 0x4e, 0x51, 0x5c, 0x7f, 0xa6]);
export const SLOW_EVERY = 5;

/// The PIDs to read in round `round`: the fast ones every round, the slow ones in round 0 and every SLOW_EVERY
/// rounds. With `only` (a Set of PIDs: the pinned items), just those, every round.
export function roundPIDs(pids, round, { only = null } = {}) {
  if (only?.size) return pids.filter((p) => only.has(p));
  return pids.filter((p) => !SLOW_PIDS.has(p) || round % SLOW_EVERY === 0);
}

/// Requests for a round: up to `max` PIDs each; a PID missing from the table (answer length unknown) goes alone.
export function batches(pids, max = 1) {
  if (max <= 1) return pids.map((p) => [p]);
  const out = [];
  let cur = [];
  for (const p of pids) {
    if (!PIDS01.has(p)) { out.push([p]); continue; }
    cur.push(p);
    if (cur.length === max) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/// The request text for one or several PIDs: "010C", "010C0D05".
export function multiCommand(pids) {
  return `01${pids.map((p) => p.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

const hexBytes = (s) => {
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
};

/// The answer split into messages (byte arrays): a single frame line is one message; a byte count line ("00A")
/// starts a multi frame message whose numbered lines ("0:", "1:") follow in order. Returns null when frames are out
/// of order (two control units' frames interleaved) or a message is shorter than it says.
export function answerMessages(text) {
  const messages = [];
  let multi = null;
  for (const raw of String(text ?? '').toUpperCase().replace(/>/g, '').split(/[\r\n]+/)) {
    const t = raw.trim().replace(/^SEARCHING\.*/, '');
    if (!t) continue;
    if (/^[0-9A-F]{3}$/.test(t)) {
      multi = { declared: parseInt(t, 16), bytes: [], next: 0 };
      messages.push(multi);
      continue;
    }
    const frame = t.match(/^([0-9A-F]):\s*([0-9A-F\s]*)$/);
    if (frame) {
      if (!multi || parseInt(frame[1], 16) !== multi.next) return null;
      multi.next = (multi.next + 1) % 16;
      multi.bytes.push(...hexBytes(frame[2].replace(/\s+/g, '')));
      continue;
    }
    const line = t.replace(/\s+/g, '');
    if (!/^[0-9A-F]+$/.test(line) || line.length % 2) continue;
    multi = null;
    messages.push({ declared: null, bytes: hexBytes(line) });
  }
  const out = [];
  for (const m of messages) {
    if (m.declared !== null) {
      if (m.bytes.length < m.declared) return null;
      out.push(m.bytes.slice(0, m.declared));
    } else out.push(m.bytes);
  }
  return out;
}

const PADDING = new Set([0x00, 0x55, 0xaa]);

/// The data bytes of each requested PID in an answer to a request for several. Returns a Map pid → bytes (a PID no
/// control unit answered is missing), or null when the answer cannot be split with certainty: a PID that was not
/// asked for, or bytes that run short.
export function parseMulti(text, pids) {
  const messages = answerMessages(text);
  if (!messages) return null;
  const out = new Map();
  for (const m of messages) {
    if (m[0] !== 0x41) continue;
    let i = 1;
    while (i < m.length) {
      const pid = m[i];
      const def = PIDS01.get(pid);
      if (!def || !pids.includes(pid)) {
        if (m.slice(i).every((b) => PADDING.has(b))) break;
        return null;
      }
      const end = i + 1 + def.bytes;
      if (end > m.length) return null;
      if (!out.has(pid)) out.set(pid, m.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/// Threshold alert on a value in the driver's units: 'high' above `high`, 'low' below `low`, else null. Once on, it
/// stays on until the value is back inside by 1% of the limit (at least 0.05), so a value on the line does not flap.
export function alertState(value, rule, was = null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !rule) return was;
  const { low = null, high = null } = rule;
  const margin = (x) => Math.max(Math.abs(x) * 0.01, 0.05);
  if (high !== null && value > high) return 'high';
  if (low !== null && value < low) return 'low';
  if (was === 'high' && high !== null && value > high - margin(high)) return 'high';
  if (was === 'low' && low !== null && value < low + margin(low)) return 'low';
  return null;
}

/// A threshold rule from the two form fields (driver's units); null when both are empty or not numbers.
export function alertRule(lowText, highText) {
  const num = (s) => (String(s ?? '').trim() === '' ? null : Number(String(s).replace(/,/g, '')));
  const low = num(lowText);
  const high = num(highText);
  const ok = (x) => x === null || Number.isFinite(x);
  if (!ok(low) || !ok(high) || (low === null && high === null)) return null;
  if (low !== null && high !== null && low >= high) return null;
  return { low, high };
}

const csvCell = (s) => {
  const t = String(s ?? '');
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/// A recording as CSV, one row per reading, in the units the app shows (°F, mph, psi...).
/// recording: { startedAt (ms), channels: { key: { pid, name, unit } }, samples: [[ms since start, key, value]] }
export function recordingCSV(rec) {
  const rows = ['time,elapsed_s,pid,sensor,value,unit'];
  for (const [dt, key, value] of rec.samples) {
    const ch = rec.channels[key];
    if (!ch) continue;
    const [v, unit] = typeof value === 'number' ? toUS(value, ch.unit) : [value, ch.unit];
    const shown = typeof v === 'number' ? String(Number(v.toFixed(4))) : csvCell(v);
    rows.push([new Date(rec.startedAt + dt).toISOString(), (dt / 1000).toFixed(3), ch.pid.toString(16).toUpperCase().padStart(2, '0'),
      csvCell(ch.name), shown, csvCell(unit)].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/// Each channel's readings in time order, for playback: Map key → { t: [ms], v: [value] }.
export function recordingSeries(rec) {
  const out = new Map();
  for (const [dt, key, value] of rec.samples) {
    let s = out.get(key);
    if (!s) { s = { t: [], v: [] }; out.set(key, s); }
    s.t.push(dt);
    s.v.push(value);
  }
  return out;
}

/// Index of the last reading at or before `t` (ms since start), or -1.
export function indexAt(ts, t) {
  let lo = 0;
  let hi = ts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/// A channel at playback time `t`: its value then, the minimum, maximum and average up to then, and the readings in
/// the `window` before it as [ms, value] pairs. Null before its first reading.
export function playbackAt(series, t, window = 120000) {
  const i = indexAt(series.t, t);
  if (i < 0) return null;
  let min = null;
  let max = null;
  let sum = 0;
  let n = 0;
  const history = [];
  for (let k = 0; k <= i; k++) {
    const v = series.v[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    min = min === null ? v : Math.min(min, v);
    max = max === null ? v : Math.max(max, v);
    sum += v;
    n++;
    if (series.t[k] >= t - window) history.push([series.t[k], v]);
  }
  return { value: series.v[i], t: series.t[i], min, max, sum, n, history };
}
