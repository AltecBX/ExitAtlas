// Formatting for distances, durations and local clock times. Mirrors App/ExitAtlas/Views/Components/Format.swift.
import { METERS_PER_MILE } from '../engine/geo.js';

export function miles(meters) {
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.1) return '0 mi';
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi).toLocaleString('en-US')} mi`;
}

/// Number only, for big dashboard digits.
export function milesValue(meters) {
  const mi = Math.max(meters / METERS_PER_MILE, 0);
  return mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString('en-US');
}

export function spokenMiles(meters) {
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.35) return 'a quarter mile';
  if (mi < 0.75) return 'half a mile';
  const whole = Math.round(mi);
  return whole === 1 ? '1 mile' : `${whole} miles`;
}

export function duration(seconds) {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  if (total === 0) return 'under 1 min';
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const formatters = new Map();
function formattersFor(zone) {
  const key = zone ?? 'local';
  let f = formatters.get(key);
  if (!f) {
    const opts = zone ? { timeZone: zone } : {};
    f = {
      time: new Intl.DateTimeFormat('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }),
      day: new Intl.DateTimeFormat('en-US', { ...opts, year: 'numeric', month: '2-digit', day: '2-digit' }),
      weekday: new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'short' }),
      date: new Intl.DateTimeFormat('en-US', { ...opts, month: 'short', day: 'numeric' }),
      abbr: new Intl.DateTimeFormat('en-US', { ...opts, timeZoneName: 'short' }),
    };
    formatters.set(key, f);
  }
  return f;
}

/// Clock time in the time zone of a place on the route ("4:32 PM EDT"), with the weekday
/// when it is not today in that zone. Times are epoch seconds.
export function clock(t, zone = null, now = Date.now() / 1000) {
  const f = formattersFor(zone);
  const date = new Date(t * 1000);
  let text = f.time.format(date);
  // Another day: its weekday within the coming week, else its date ("Dec 31"), never a weekday weeks away.
  if (f.day.format(date) !== f.day.format(new Date(now * 1000))) {
    text = `${Math.abs(t - now) < 6 * 86400 ? f.weekday.format(date) : f.date.format(date)} ${text}`;
  }
  if (zone) {
    const part = f.abbr.formatToParts(date).find((p) => p.type === 'timeZoneName');
    if (part) text += ` ${part.value}`;
  }
  return text;
}

/// When a range reading was entered, for one that may be out of date: more than 6 hours ago or on an earlier
/// day ("today 7:05 AM", "yesterday 9:40 PM", "Tue 9:40 PM", "Oct 21 9:40 PM"), in the phone's time zone. Null
/// for a recent reading. Times are epoch seconds.
export function readingAge(t, now = Date.now() / 1000, zone = null) {
  if (!(t > 0)) return null;
  const f = formattersFor(zone);
  const at = new Date(t * 1000);
  const day = f.day.format(at);
  const today = day === f.day.format(new Date(now * 1000));
  if (today && now - t <= 6 * 3600) return null;
  const time = f.time.format(at);
  if (today) return `today ${time}`;
  if (day === f.day.format(new Date((now - 86400) * 1000))) return `yesterday ${time}`;
  return `${now - t < 6 * 86400 ? f.weekday.format(at) : f.date.format(at)} ${time}`;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
