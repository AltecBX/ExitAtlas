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
  if (f.day.format(date) !== f.day.format(new Date(now * 1000))) text = `${f.weekday.format(date)} ${text}`;
  if (zone) {
    const part = f.abbr.formatToParts(date).find((p) => p.type === 'timeZoneName');
    if (part) text += ` ${part.value}`;
  }
  return text;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
