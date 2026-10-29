// Current weather where you are, from the National Weather Service (public domain, no key): the latest
// observation from the nearest station that reported in the last 90 minutes, else the hourly forecast for
// this hour, labeled as a forecast. An old reading is never shown as current. Pure functions on NWS
// responses; fetching lives in app/weather.js. Same rules as Sources/ExitAtlasCore/Weather/CurrentWeather.swift,
// tested on Tests/ExitAtlasCoreTests/Fixtures/weather (real responses).
import { distance } from './geo.js';

export const WEATHER_RULES = Object.freeze({
  /// An observation older than this is not "now" (stations report hourly, some only every few hours).
  maxObservationAge: 90 * 60,
  /// A station farther than this does not stand for where you are.
  maxStationDistance: 50000,
  /// Stations tried, nearest first.
  stations: 3,
  /// Hours listed after this one.
  nextHours: 4,
});

/// Kinds of weather, with a short label for day and night.
export const WEATHER_KINDS = Object.freeze({
  clear: ['Sunny', 'Clear'],
  mostlyClear: ['Mostly sunny', 'Mostly clear'],
  partlyCloudy: ['Partly cloudy', 'Partly cloudy'],
  mostlyCloudy: ['Mostly cloudy', 'Mostly cloudy'],
  cloudy: ['Cloudy', 'Cloudy'],
  showers: ['Showers', 'Showers'],
  rain: ['Rain', 'Rain'],
  thunder: ['Storms', 'Storms'],
  sleet: ['Wintry mix', 'Wintry mix'],
  snow: ['Snow', 'Snow'],
  fog: ['Fog', 'Fog'],
  haze: ['Haze', 'Haze'],
  smoke: ['Smoke', 'Smoke'],
  dust: ['Dust', 'Dust'],
  wind: ['Windy', 'Windy'],
  hot: ['Hot', 'Hot'],
  cold: ['Cold', 'Cold'],
  severe: ['Severe weather', 'Severe weather'],
});

/// NWS icon codes (https://api.weather.gov/icons) as kinds.
const ICON_CODES = {
  skc: 'clear', few: 'mostlyClear', sct: 'partlyCloudy', bkn: 'mostlyCloudy', ovc: 'cloudy',
  wind_skc: 'wind', wind_few: 'wind', wind_sct: 'wind', wind_bkn: 'wind', wind_ovc: 'wind',
  snow: 'snow', blizzard: 'snow',
  rain_snow: 'sleet', rain_sleet: 'sleet', snow_sleet: 'sleet', sleet: 'sleet', fzra: 'sleet', rain_fzra: 'sleet', snow_fzra: 'sleet',
  rain: 'rain', rain_showers: 'showers', rain_showers_hi: 'showers',
  tsra: 'thunder', tsra_sct: 'thunder', tsra_hi: 'thunder',
  tornado: 'severe', hurricane: 'severe', tropical_storm: 'severe',
  dust: 'dust', smoke: 'smoke', haze: 'haze', hot: 'hot', cold: 'cold', fog: 'fog',
};

/// Words in a description, most specific first, when there is no icon.
const TEXT_KINDS = [
  [/tornado|hurricane|tropical storm/, 'severe'], [/thunder/, 'thunder'], [/freezing|sleet|ice pellets|wintry/, 'sleet'],
  [/snow|blizzard/, 'snow'], [/shower/, 'showers'], [/rain|drizzle/, 'rain'], [/fog|mist/, 'fog'], [/smoke/, 'smoke'],
  [/haze/, 'haze'], [/dust|sand/, 'dust'], [/wind|breezy/, 'wind'], [/mostly cloudy/, 'mostlyCloudy'],
  [/partly (cloudy|sunny)/, 'partlyCloudy'], [/mostly (clear|sunny)|fair/, 'mostlyClear'], [/overcast|cloudy/, 'cloudy'],
  [/clear|sunny/, 'clear'],
];

/// The kind of weather and day or night from an NWS icon URL (".../icons/land/night/bkn?size=small";
/// ".../land/day/rain_showers,30/tsra_hi,40"), else from the description. isDay is null when not given.
export function weatherKind(icon, text) {
  const m = /\/icons\/land\/(day|night)\/([^/?]+)/.exec(icon ?? '');
  const isDay = m ? m[1] === 'day' : null;
  const fromIcon = m ? ICON_CODES[m[2].split(',')[0]] : null;
  if (fromIcon) return { kind: fromIcon, isDay };
  const t = String(text ?? '').toLowerCase();
  const hit = TEXT_KINDS.find(([re]) => re.test(t));
  return { kind: hit ? hit[1] : null, isDay };
}

export function weatherLabel(kind, isDay) {
  const l = WEATHER_KINDS[kind];
  return l ? l[isDay === false ? 1 : 0] : null;
}

/// The nearest stations within reach, nearest first: [{id, name, distance (m), coordinate}] from an NWS stations list.
export function nearestStations(body, position, rules = WEATHER_RULES) {
  const out = [];
  for (const f of body?.features ?? []) {
    const c = f.geometry?.coordinates;
    const id = f.properties?.stationIdentifier;
    if (!id || !Array.isArray(c)) continue;
    const d = distance(position, { lat: c[1], lon: c[0] });
    if (d <= rules.maxStationDistance) out.push({ id, name: f.properties.name ?? id, distance: d, coordinate: { lat: c[1], lon: c[0] } });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, rules.stations);
}

const seconds = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t / 1000 : null; };
const num = (q) => (q && Number.isFinite(q.value) ? q.value : null);
const fahrenheit = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => (deg == null ? null : COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);

/// The weather to show now.
///   observations: [{station: {id, name, distance}, body}] (latest observation per station, nearest first)
///   hourly: the NWS hourly forecast, or null; now: unix seconds; place: "Jacksonville, FL" or null
/// Returns null when nothing current is known.
export function currentWeather({ observations = [], hourly = null, now, place = null, rules = WEATHER_RULES }) {
  const periods = (hourly?.properties?.periods ?? []).map((p) => ({ ...p, start: seconds(p.startTime), end: seconds(p.endTime) }))
    .filter((p) => p.start != null && p.end != null);
  const thisHour = periods.find((p) => p.start <= now && now < p.end) ?? null;
  const next = periods.filter((p) => p.start >= (thisHour?.end ?? now)).slice(0, rules.nextHours).map((p) => {
    const k = weatherKind(p.icon, p.shortForecast);
    return { at: p.start, temperatureF: periodF(p), kind: k.kind, isDay: k.isDay ?? p.isDaytime ?? null,
      condition: p.shortForecast ?? null, rainChance: num(p.probabilityOfPrecipitation) };
  });

  for (const { station, body } of observations) {
    const p = body?.properties ?? {};
    const at = seconds(p.timestamp);
    const tempC = num(p.temperature);
    if (at == null || tempC == null || now - at > rules.maxObservationAge || at - now > 600) continue;
    const k = weatherKind(p.icon, p.textDescription);
    const kind = k.kind ?? (thisHour ? weatherKind(thisHour.icon, thisHour.shortForecast).kind : null);
    const isDay = k.isDay ?? thisHour?.isDaytime ?? null;
    const speed = num(p.windSpeed);
    return {
      source: 'observed', at, place, station,
      temperatureF: fahrenheit(tempC), feelsLikeF: fahrenheit(num(p.heatIndex) ?? num(p.windChill)),
      kind, isDay, condition: p.textDescription || weatherLabel(kind, isDay),
      windMph: speed == null ? null : Math.round(speed / 1.609344), windFrom: compass(num(p.windDirection)),
      gustMph: num(p.windGust) == null ? null : Math.round(num(p.windGust) / 1.609344),
      humidity: num(p.relativeHumidity) == null ? null : Math.round(num(p.relativeHumidity)),
      next,
    };
  }
  if (!thisHour) return null;
  const k = weatherKind(thisHour.icon, thisHour.shortForecast);
  const winds = String(thisHour.windSpeed ?? '').match(/\d+/g)?.map(Number) ?? [];
  return {
    source: 'forecast', at: thisHour.start, place, station: null,
    temperatureF: periodF(thisHour), feelsLikeF: null, kind: k.kind, isDay: k.isDay ?? thisHour.isDaytime ?? null,
    condition: thisHour.shortForecast || weatherLabel(k.kind, k.isDay),
    windMph: winds.length ? Math.max(...winds) : null, windFrom: thisHour.windDirection || null, gustMph: null,
    humidity: num(thisHour.relativeHumidity) == null ? null : Math.round(num(thisHour.relativeHumidity)),
    next,
  };
}

function periodF(p) {
  if (!Number.isFinite(p.temperature)) return null;
  return p.temperatureUnit === 'C' ? fahrenheit(p.temperature) : Math.round(p.temperature);
}

/// "NE 11 mph, gusts 25", "Calm", or null.
export function windText(w) {
  if (w.windMph == null) return null;
  if (w.windMph === 0) return 'Calm';
  return `${w.windFrom ? `${w.windFrom} ` : ''}${w.windMph} mph${w.gustMph ? `, gusts ${w.gustMph}` : ''}`;
}
