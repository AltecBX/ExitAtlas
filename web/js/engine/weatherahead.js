// Weather ahead on the route: the National Weather Service hourly forecast for each point ahead, at the time
// the driver gets there. Rain or showers from a 40% chance, any thunder, snow, sleet or freezing rain, and fog
// become warnings; a 20 to 39% chance of rain is a quiet line. A point whose forecast could not be read, was
// fetched more than 2 hours ago, or has no hour for the arrival time is "unavailable", never clear. This is a
// forecast for a 2.5 km grid cell and an hour, not radar: it cannot see a passing shower cell.
// Pure functions on NWS responses; fetching lives in app/weatherahead.js.
import { METERS_PER_MILE as MILE } from './geo.js';
import { weatherKind } from './weather.js';

export const AHEAD_RULES = Object.freeze({
  /// One forecast point every 12 miles along the route, at fixed route positions so a point is looked up once.
  spacing: 12 * MILE,
  /// Up to 150 miles ahead, or 3 hours, whichever comes first.
  window: 150 * MILE,
  maxHours: 3,
  /// Rain or showers are a warning from this chance (percent), a quiet line from quietChance (NWS says
  /// "slight chance" from 20%).
  warnChance: 40,
  quietChance: 20,
  /// A forecast fetched longer ago than this is not used (it is fetched again every 20 minutes).
  maxCopyAge: 2 * 3600,
  /// Nor one whose grid NWS last updated longer ago than this (offices update every few hours; older means
  /// something is wrong at NWS).
  maxUpdateAge: 12 * 3600,
  /// The Drive screen shows a warning starting within this distance.
  chipWindow: 60 * MILE,
});

/// Kinds that can be flagged, worst first.
const RANK = { severe: 6, thunder: 5, sleet: 4, snow: 3, rain: 2, showers: 1, fog: 0 };
const NAMES = { severe: 'Severe weather', thunder: 'Storms', sleet: 'Wintry mix', snow: 'Snow', rain: 'Rain', showers: 'Showers', fog: 'Fog' };

const seconds = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t / 1000 : null; };

/// The route positions to look up: every `spacing` meters, from the one whose stretch includes the driver to
/// `window` ahead, the route's end, or `maxHours` of driving. etaAt(d): arrival time (epoch seconds) at d.
/// [{along, coordinate, eta}]
export function samplePoints(route, progress, etaAt, now, rules = AHEAD_RULES) {
  const out = [];
  const end = Math.min(route.length, progress + rules.window);
  for (let k = Math.max(0, Math.floor((progress + rules.spacing / 2) / rules.spacing)); ; k++) {
    const along = Math.min(k * rules.spacing, route.length);
    if (along > end || (out.length && along === out[out.length - 1].along)) break;
    const eta = Math.max(now, along <= progress ? now : etaAt(along));
    if (eta - now > rules.maxHours * 3600) break;
    out.push({ along, coordinate: route.polyline.coordinateAt(along), eta });
    if (along >= route.length) break;
  }
  return out;
}

/// The forecast at one point for its arrival time: {status: 'ok', kind, chance, text, start, end, updated} or
/// {status: 'unavailable', reason}. hourly: the NWS hourly forecast (or null); fetchedAt: when it was fetched.
export function forecastAt(hourly, eta, now, fetchedAt, rules = AHEAD_RULES) {
  const props = hourly?.properties;
  if (!props?.periods) return { status: 'unavailable', reason: 'no forecast' };
  if (!(fetchedAt > 0) || now - fetchedAt > rules.maxCopyAge) return { status: 'unavailable', reason: 'forecast too old' };
  const updated = seconds(props.updateTime);
  if (updated !== null && now - updated > rules.maxUpdateAge) return { status: 'unavailable', reason: 'forecast too old' };
  const t = Math.max(eta, now);
  for (const p of props.periods) {
    const start = seconds(p.startTime), end = seconds(p.endTime);
    if (start === null || end === null || !(start <= t && t < end) || end <= now) continue;
    const chance = Number.isFinite(p.probabilityOfPrecipitation?.value) ? p.probabilityOfPrecipitation.value : null;
    // The icon first, then the words: "Areas Of Fog" can come with a rain icon at a low chance.
    const byIcon = weatherKind(p.icon, null).kind ?? weatherKind(null, p.shortForecast).kind;
    const byText = weatherKind(null, p.shortForecast).kind;
    const kind = levelOf(byText, chance, rules) && !levelOf(byIcon, chance, rules) ? byText : byIcon;
    const isDay = weatherKind(p.icon, null).isDay ?? (typeof p.isDaytime === 'boolean' ? p.isDaytime : null);
    return { status: 'ok', kind, chance, isDay, text: p.shortForecast ?? null, start, end, updated };
  }
  return { status: 'unavailable', reason: 'no hour for the arrival time' };
}

function levelOf(kind, chance, rules) {
  switch (kind) {
    case 'severe': case 'thunder': case 'sleet': case 'snow': case 'fog': return 'warn';
    case 'rain': case 'showers':
      if (chance === null) return 'warn';
      return chance >= rules.warnChance ? 'warn' : chance >= rules.quietChance ? 'quiet' : null;
    default: return null;
  }
}

/// 'warn', 'quiet', 'unavailable', or null (nothing to flag) for a point's forecast.
export function weatherLevel(w, rules = AHEAD_RULES) {
  if (!w || w.status !== 'ok') return 'unavailable';
  return levelOf(w.kind, w.chance, rules);
}

/// "Showers likely", "Storms", "Chance of rain", "Fog".
export function aheadPhrase(kind, chance) {
  const name = NAMES[kind] ?? 'Weather';
  if (kind === 'fog' || kind === 'severe' || chance === null || chance >= 80) return name;
  if (chance >= 55) return `${name} likely`;
  return `Chance of ${name.toLowerCase()}`;
}

/// Consecutive points with the same level as stretches of the route, in order:
/// [{level, kind, chance, phrase, start, end, eta, etaEnd, updated, points}]. points: [{along, eta, w}] in
/// route order (w from forecastAt). Points with nothing to flag end a stretch. A warning merges different
/// kinds and keeps the worst; its chance is the highest.
export function weatherStretches(points, progress, rules = AHEAD_RULES) {
  const out = [];
  let cur = null;
  for (const p of points) {
    const level = weatherLevel(p.w, rules);
    const from = Math.max(progress, p.along - rules.spacing / 2);
    const to = p.along + rules.spacing / 2;
    if (to <= progress) continue;
    if (!level) { cur = null; continue; }
    if (cur && cur.level === level) {
      cur.end = to;
      cur.etaEnd = p.eta;
      cur.points += 1;
      if (level !== 'unavailable') {
        if ((RANK[p.w.kind] ?? -1) > (RANK[cur.kind] ?? -1)) cur.kind = p.w.kind;
        if (p.w.chance !== null && (cur.chance === null || p.w.chance > cur.chance)) cur.chance = p.w.chance;
        if (p.w.updated !== null && (cur.updated === null || p.w.updated < cur.updated)) cur.updated = p.w.updated;
      }
      continue;
    }
    cur = { level, kind: level === 'unavailable' ? null : p.w.kind, chance: level === 'unavailable' ? null : p.w.chance, isDay: p.w?.isDay ?? null,
      start: from, end: to, eta: p.eta, etaEnd: p.eta, updated: level === 'unavailable' ? null : p.w.updated, points: 1 };
    out.push(cur);
  }
  for (const s of out) {
    s.phrase = s.level === 'unavailable' ? 'Weather ahead unavailable' : aheadPhrase(s.kind, s.chance);
    s.name = s.level === 'unavailable' ? null : NAMES[s.kind] ?? 'Weather';
  }
  return out;
}

/// NWS warnings already on the route as road alerts cover these kinds: a forecast stretch they overlap is not
/// shown again on the Drive screen or spoken (the alert says it, officially).
const ALERT_COVERS = [[/fog/i, ['fog']], [/thunderstorm|tornado/i, ['thunder', 'rain', 'showers']],
  [/winter|ice storm|blizzard|snow squall/i, ['snow', 'sleet']], [/hurricane|tropical storm/i, Object.keys(RANK)]];

export function coveredByAlert(stretch, alerts = []) {
  if (!stretch.kind) return false;
  return alerts.some((a) => {
    const i = a.incident;
    if (!i || (i.category !== 'weather' && i.category !== 'flooding') || a.start > stretch.end || (a.end ?? a.start) < stretch.start) return false;
    return ALERT_COVERS.some(([re, kinds]) => re.test(i.description ?? '') && kinds.includes(stretch.kind));
  });
}

/// Everything the apps show: {stretches, warnings, quiet, unavailable, coveredTo, checked, updated}.
/// coveredTo: how far ahead the forecast was read; checked: the points looked up.
export function weatherAhead(points, progress, rules = AHEAD_RULES) {
  const stretches = weatherStretches(points, progress, rules);
  const last = points[points.length - 1];
  const updated = points.map((p) => p.w?.status === 'ok' ? p.w.updated : null).filter((u) => u !== null);
  return {
    stretches,
    warnings: stretches.filter((s) => s.level === 'warn'),
    quiet: stretches.filter((s) => s.level === 'quiet'),
    unavailable: stretches.filter((s) => s.level === 'unavailable'),
    coveredTo: last ? last.along + rules.spacing / 2 : progress,
    checked: points.length,
    updated: updated.length ? Math.min(...updated) : null,
  };
}
