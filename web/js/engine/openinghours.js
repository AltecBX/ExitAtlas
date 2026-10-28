// Opening hours: the OpenStreetMap format (the common subset) and Google Places periods, read into one
// weekly table, and whether a place is open at a local time. Same rules as
// Sources/ExitAtlasCore/Planning/OpeningHours.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/smartstop.
//
// Read: "24/7"; weekday lists and ranges (Mo-Fr, Sa,Su, Fr-Mo); times with a closing time after
// midnight (22:00-02:00, 06:00-24:00); "off" or "closed"; rules separated by ";" (a later rule replaces
// earlier ones on its days) or by "," before a weekday (an added rule). Public and school holidays
// (PH, SH) are not known here: a rule only for them is skipped and the hours are marked as having
// holiday exceptions. Anything else (months, dates, weeks, sunrise, open ends like "18:00+", comments)
// does not parse, and the hours count as unknown rather than guessed.

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_TOKEN = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)';
const SELECTOR = new RegExp(`^(${DAY_TOKEN}(?:-${DAY_TOKEN})?(?:\\s*,\\s*${DAY_TOKEN}(?:-${DAY_TOKEN})?)*)(?:\\s+|$)`, 'i');
const TIME = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

const dayIndex = (t) => DAYS.findIndex((d) => d.toLowerCase() === t.toLowerCase());

/// {week: 7 lists of [startMinute, endMinute] (end may pass 1440: open past midnight), holidays: bool}
/// with Monday first, or null when the text does not parse.
export function parseOpeningHours(text) {
  if (typeof text !== 'string') return null;
  const src = text.trim().replace(/\s+/g, ' ');
  if (!src) return null;
  const week = DAYS.map(() => []);
  let holidays = false;
  for (const ruleText of src.split(';').map((r) => r.trim()).filter(Boolean)) {
    let first = true;
    for (const part of addedRules(ruleText)) {
      const rule = parseRule(part);
      if (rule === null) return null;
      if (rule.holidayOnly) { holidays = true; first = false; continue; }
      for (const d of rule.days) {
        if (first) week[d] = rule.intervals.map((x) => [...x]);
        else week[d].push(...rule.intervals.map((x) => [...x]));
      }
      first = false;
    }
  }
  for (const day of week) day.sort((a, b) => a[0] - b[0]);
  return { week, holidays };
}

/// "Mo-Fr 08:00-17:00, Sa 09:00-12:00" is two rules, the second added to the first; "Sa,Su 07:00-19:00"
/// is one. A comma starts an added rule only after a time or "off" and before a weekday.
function addedRules(text) {
  const out = [];
  let start = 0;
  const comma = /,\s*/g;
  let m;
  while ((m = comma.exec(text)) !== null) {
    const before = text.slice(start, m.index).trim();
    const after = text.slice(m.index + m[0].length);
    if (/(\d|off|closed)$/i.test(before) && new RegExp(`^${DAY_TOKEN}\\b`, 'i').test(after)) {
      out.push(before);
      start = m.index + m[0].length;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

function parseRule(rule) {
  if (/^24\/7$/.test(rule)) return { days: [0, 1, 2, 3, 4, 5, 6], intervals: [[0, 1440]] };
  let days = [0, 1, 2, 3, 4, 5, 6];
  let rest = rule;
  const m = SELECTOR.exec(rule);
  if (m) {
    days = [];
    for (const item of m[1].split(',').map((s) => s.trim())) {
      const [a, b] = item.split('-').map((s) => s.trim());
      if (/^(PH|SH)$/i.test(a)) {
        if (b) return null;
        continue; // holidays share these hours; nothing to add for the weekdays
      }
      const i = dayIndex(a);
      if (i < 0) return null;
      if (!b) { days.push(i); continue; }
      const j = dayIndex(b);
      if (j < 0) return null;
      for (let k = i; ; k = (k + 1) % 7) { days.push(k); if (k === j) break; }
    }
    rest = rule.slice(m[0].length).trim();
    if (!days.length) return { holidayOnly: true };
  }
  days = [...new Set(days)];
  if (rest === '') return { days, intervals: [[0, 1440]] };
  if (/^(off|closed)$/i.test(rest)) return { days, intervals: [] };
  const intervals = [];
  for (const span of rest.split(',').map((s) => s.trim())) {
    const t = TIME.exec(span);
    if (!t) return null;
    const [h1, m1, h2, m2] = t.slice(1).map(Number);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
    const start = h1 * 60 + m1;
    let end = h2 * 60 + m2;
    if (start >= 1440) return null;
    if (end <= start) end += 1440; // closes after midnight (00:00-00:00 is the whole day)
    intervals.push([start, end]);
  }
  return { days, intervals };
}

/// Google Places currentOpeningHours or regularOpeningHours periods ({open: {day (0 = Sunday), hour,
/// minute}, close?}) as the same weekly table. A period without a close is open around the clock.
export function weekFromPeriods(periods) {
  if (!Array.isArray(periods) || !periods.length) return null;
  const week = DAYS.map(() => []);
  for (const p of periods) {
    const o = p?.open;
    if (!o || !Number.isInteger(o.day)) return null;
    const day = (o.day + 6) % 7;
    const start = (o.hour ?? 0) * 60 + (o.minute ?? 0);
    if (!p.close) return { week: DAYS.map(() => [[0, 1440]]), holidays: false };
    const c = p.close;
    const cday = (c.day + 6) % 7;
    let end = (c.hour ?? 0) * 60 + (c.minute ?? 0) + ((cday - day + 7) % 7) * 1440;
    if (end <= start) end += 7 * 1440;
    week[day].push([start, end]);
  }
  for (const d of week) d.sort((a, b) => a[0] - b[0]);
  return { week, holidays: false };
}

/// Whether the hours say open on `weekday` (0 = Monday) at `minute` (0 to 1439), and how many minutes
/// until it closes (null when open around the clock for the next seven days).
export function openAt(hours, weekday, minute) {
  const t = weekday * 1440 + minute;
  const spans = [];
  for (let d = 0; d < 7; d++) {
    for (const [s, e] of hours.week[d]) {
      // Each span as absolute minutes in a two week line so spans past Sunday midnight wrap around.
      spans.push([d * 1440 + s, d * 1440 + e], [(d + 7) * 1440 + s, (d + 7) * 1440 + e]);
      if (d * 1440 + e > 7 * 1440) spans.push([(d - 7) * 1440 + s, (d - 7) * 1440 + e]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const at = spans.find(([s, e]) => s <= t && t < e);
  if (!at) return { open: false, closesIn: null };
  // Follow touching or overlapping spans to the real closing time.
  let end = at[1];
  for (const [s, e] of spans) if (s <= end && e > end) end = e;
  return { open: true, closesIn: end - t >= 7 * 1440 ? null : end - t };
}

/// Weekday (0 = Monday) and minute of the day at a time (epoch seconds) in an IANA time zone.
const formatters = new Map();

export function localTime(epochSeconds, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { weekday, minute: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}
