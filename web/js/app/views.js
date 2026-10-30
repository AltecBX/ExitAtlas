// Screen templates. Pure functions of app state that return HTML strings.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { highwayLabel, DIRECTION_WORDS } from '../engine/route.js';
import { CATEGORY_NAMES, placeDisplayName } from '../engine/datasets.js';
import { exitTitle } from '../engine/exits.js';
import { miles, milesValue, duration, clock, escapeHTML as h } from './format.js';
import { renderRouteMap } from './map.js';
import { GRADES, GOOGLE_DAILY_LIMIT, pricedForGrade, priceText, ageText } from './prices.js';
import { GRADE_NAMES, PRICE_GRADES, PRICE_RULES, SORTS, SORT_NAMES, sortStations, stationPrice, dollars } from '../engine/gasprices.js';
import { evaluateStop, brandIndex } from '../engine/smartstop.js';
import { stopPrice, liveFor } from './smartstops.js';
import { googleMapsLink, gasBuddyLink } from '../engine/pricecheck.js';
import { matchesFavorite } from '../engine/fuel.js';
import { KIND_TITLES, restAreaTitle, amenityBadges, hoursText } from '../engine/restareas.js';
import { DISCOVER_CATEGORIES } from '../engine/discover.js';
import { travelStats } from '../engine/travels.js';
import { nextManeuver } from '../engine/guidance.js';
import { routeBearing } from './navmap.js';
import { localTime } from '../engine/openinghours.js';
import { inOvernightWindow } from '../engine/profile.js';
import { ALERT_KINDS, ALERT_GROUPS, freshnessText, alertTier, alertHeadline } from '../engine/roadintel.js';
import { WZDX_FEEDS } from '../engine/alertsources.js';
import { BASIS_LABELS } from '../engine/traffic.js';
import { weatherLabel, windText } from '../engine/weather.js';
import { weatherIcon, skyColors } from './weathericons.js';
import { wazeLink } from '../engine/handoff.js';

export const CATEGORY_ICONS = ['📍', '⛽', '🍴', '🛏️', '🚻', '⚡', '🌳', '🐾', '🚛'];
export const FILTER_CATEGORIES = [1, 2, 3, 4, 5, 7];
export const WINDOWS = [5, 10, 25, 50, 100];

// MARK: Components

export function shield(ref, size = 50) {
  if (ref && ref.kind === 'interstate') {
    const n = ref.number;
    const fs = n.length > 2 ? 30 : 38;
    return `<svg class="shield" style="width:${size}px;height:${size}px" viewBox="0 0 100 100" aria-label="Interstate ${h(n)}">
      <defs><clipPath id="shtop"><rect x="0" y="0" width="100" height="29"/></clipPath></defs>
      <path d="M8 6 Q30 14 50 8 Q70 14 92 6 C104 55 80 90 50 100 C20 90 -4 55 8 6Z" fill="var(--shield-blue)"/>
      <path d="M8 6 Q30 14 50 8 Q70 14 92 6 C104 55 80 90 50 100 C20 90 -4 55 8 6Z" fill="var(--shield-red)" clip-path="url(#shtop)"/>
      <path d="M12 11 Q31 18 50 13 Q69 18 88 11 C98 55 77 85 50 95 C23 85 2 55 12 11Z" fill="none" stroke="#fff" stroke-width="4"/>
      <text x="50" y="${n.length > 2 ? 72 : 76}" style="font-size:${fs}px">${h(n)}</text></svg>`;
  }
  return `<span class="road-badge">${ref ? h(highwayLabel(ref)) : '—'}</span>`;
}

/// Exit number tab, as on a guide sign: "EXIT 119" in sign lettering on green with a white border.
export function exitSign(label, compact = false) {
  return `<span class="exit-sign${compact ? ' compact' : ''}" role="img" aria-label="${label ? `Exit ${h(label)}` : 'Unnumbered exit'}"><span class="e">EXIT</span><span class="n">${label ? h(label) : '—'}</span></span>`;
}

/// Sign words per service category. Blue for motorist services, brown for parks (as on real signs).
const PLAQUE_WORDS = { 1: 'GAS', 2: 'FOOD', 3: 'LODGING', 5: 'EV', 4: 'REST AREA', 6: 'PARK', 7: 'DOG PARK', 8: 'TRAVEL CENTER' };
const PLAQUE_ORDER = [1, 2, 3, 5, 8, 4, 6, 7];
const BROWN = new Set([6, 7]);

/// Service plaques: one tile per category with the nearest named places. Text only (no brand logos).
export function servicePlaques(services, { names = 2, compact = false, max = Infinity } = {}) {
  const tiles = [];
  for (const cat of PLAQUE_ORDER) {
    if (tiles.length >= max) break;
    const items = services.filter((x) => x.place.category === cat).sort((a, b) => a.detourMeters - b.detourMeters);
    if (!items.length) continue;
    const named = [...new Set(items.map((x) => x.place.brand || x.place.name).filter((n) => n && n !== CATEGORY_NAMES[cat]))];
    const shown = named.slice(0, compact ? 1 : names);
    const more = items.length - shown.length;
    const word = PLAQUE_WORDS[cat];
    const label = `${CATEGORY_NAMES[cat]}: ${shown.length ? shown.join(', ') : `${items.length} ${items.length === 1 ? 'place' : 'places'}`}${shown.length && more > 0 ? ` and ${more} more` : ''}`;
    const body = compact
      ? `${shown.length ? `<span class="pn">${h(shown[0])}</span>` : ''}${more > 0 ? `<span class="pm">${shown.length ? '+' : ''}${more}</span>` : ''}`
      : `${shown.map((n) => `<span class="pn">${h(n)}</span>`).join('')}${more > 0 ? `<span class="pm">${shown.length ? `+${more} more` : `${more}`}</span>` : ''}`;
    tiles.push(`<span class="plaque ${BROWN.has(cat) ? 'brown' : 'blue'}" aria-label="${h(label)}"><b>${word}</b>${body}</span>`);
  }
  return tiles.length ? `<div class="plaques${compact ? ' compact' : ''}">${tiles.join('')}</div>` : '';
}

/// Advance guide sign for the next exit: exit tab, the exit's name, and the distance in sign lettering.
function guideSign(exit, distance, seconds, services = []) {
  // Most exits have no name in the source data; the sign then lists the services, as a real
  // "next exit" services sign would.
  const words = PLAQUE_ORDER.filter((c) => c <= 5 && services.some((x) => x.place.category === c)).map((c) => PLAQUE_WORDS[c]);
  const name = exit.name || (words.length ? words.join(' · ') : 'No services listed');
  const mi = distance / MILE;
  const value = mi < 10 ? mi.toFixed(1) : String(Math.round(mi));
  return `<div class="gsign" role="group" aria-label="${h(name)}, ${h(value)} miles, ${duration(seconds)}">
    <div class="gsign-tab">${exitSign(exit.label)}</div>
    <div class="gsign-name">${h(name)}</div>
    <div class="gsign-dist"><span class="v">${value}</span><span class="u">${value === '1.0' ? 'MILE' : 'MILES'}</span><span class="t">${duration(seconds)}</span></div>
  </div>`;
}

/// Rest area sign: blue with white lettering, as on the road. Two lines so it matches the exit tab width.
const REST_WORDS = { rest: ['REST', 'AREA'], welcome: ['WELCOME', 'CENTER'], plaza: ['SERVICE', 'PLAZA'], parking: ['PARKING', 'AREA'] };

export function restSign(kind, compact = false) {
  const [a, b] = REST_WORDS[kind] ?? REST_WORDS.rest;
  return `<span class="ra-sign${compact ? ' compact' : ''}" role="img" aria-label="${h(KIND_TITLES[kind] ?? 'Rest Area')}"><span>${a}</span><span>${b}</span></span>`;
}

const AMENITY_ICONS = {
  hours: '🕐', toilets: '🚻', accessible: '♿', water: '🚰', vending: '🥤', picnic: '🧺', pets: '🐾',
  wifi: '📶', info: 'ℹ️', shower: '🚿', dump: '🚐', trucks: '🚛',
};

/// Verified amenity chips. A "no" reads "No restrooms". Plazas list their gas and food by name.
function amenityChips(r, { max = 6 } = {}) {
  const chips = amenityBadges(r).map((b) => `<span class="am${b.value ? '' : ' no'}">${AMENITY_ICONS[b.key] ?? ''} ${b.value ? h(b.label) : `No ${h(b.label.toLowerCase())}`}</span>`);
  const named = (icon, list) => (list.length ? `<span class="am">${icon} ${h(list.slice(0, 2).join(', '))}${list.length > 2 ? ` +${list.length - 2}` : ''}</span>` : '');
  const plaza = r.kind === 'plaza' ? [named('⛽', r.gas), named('🍴', r.food), named('⚡', r.ev)].filter(Boolean) : [];
  const all = [...plaza, ...chips];
  if (!all.length) return '<div class="muted tiny ra-unknown">Amenities not listed in OpenStreetMap</div>';
  return `<div class="ams">${all.slice(0, max).join('')}${all.length > max ? `<span class="am more">+${all.length - max}</span>` : ''}</div>`;
}

/// Short title for a gas stop: "Exit 12" or the plaza name.
function gasStopTitle(stop) {
  return stop.exit ? exitTitle(stop.exit) : restAreaTitle(stop.restArea);
}

export function badge(code, on = false, sm = false) {
  return `<span class="badge${on ? ' on' : ''}${sm ? ' sm' : ''}">${h(code ?? '—')}</span>`;
}

function metric(title, value, { unit = '', caption = '', size = '' } = {}) {
  return `<div class="metric"><div class="eyebrow">${h(title)}</div><div class="value num ${size}">${h(value)}${unit ? `<span class="unit">${h(unit)}</span>` : ''}</div>${caption ? `<div class="caption">${h(caption)}</div>` : ''}</div>`;
}

function progress(fraction, thick = false) {
  return `<div class="progress${thick ? ' thick' : ''}"><div style="width:${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%"></div></div>`;
}

// MARK: Weather

/// The weather pill in the top bar: symbol, temperature and the condition, with "Forecast" when no station
/// near you reported recently. Compact (symbol and temperature) when the title is a highway name.
export function weatherPill(app, { compact = false } = {}) {
  const w = app.weatherNow();
  if (!w || w.temperatureF == null) return '';
  const label = weatherLabel(w.kind, w.isDay) ?? w.condition ?? '';
  const said = `${w.temperatureF} degrees, ${label}${w.source === 'forecast' ? ', forecast' : ''}`;
  return `<button class="wx-pill${compact ? ' compact' : ''}" data-act="sheet" data-arg="weather" aria-label="Weather: ${h(said)}. Details">
    ${weatherIcon(w.kind, w.isDay)}<span class="wx-temp num">${w.temperatureF}°</span>${label ? `<span class="wx-cond">${h(label)}</span>` : ''}${w.source === 'forecast' ? '<span class="wx-tag">Forecast</span>' : ''}</button>`;
}

/// "11 PM" in the time zone of the place.
function hourText(t, zone) {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', ...(zone ? { timeZone: zone } : {}) }).format(new Date(t * 1000));
  } catch { return clock(t); }
}

/// The weather sheet: the sky card, the next hours and where the numbers come from.
export function weatherSheet(app) {
  const head = '<div class="sheet-head"><h2>Weather</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>';
  const w = app.weatherNow();
  if (!w || w.temperatureF == null) {
    return `${head}<p class="muted">No current weather for where you are. ExitAtlas asks the National Weather Service while a trip runs, about every 10 minutes; nothing is shown when the answer is old or the service cannot be reached.</p>`;
  }
  const now = Date.now() / 1000;
  const [top, bottom] = skyColors(w.kind, w.isDay);
  const label = weatherLabel(w.kind, w.isDay) ?? w.condition ?? '';
  const wind = windText(w);
  const metrics = [
    w.feelsLikeF != null && w.feelsLikeF !== w.temperatureF ? ['Feels like', `${w.feelsLikeF}°`] : null,
    wind ? ['Wind', wind] : null,
    w.humidity != null ? ['Humidity', `${w.humidity}%`] : null,
  ].filter(Boolean);
  // Chance of rain under an hour when it is 20% or more (NWS forecasts say "slight chance" from 20%).
  const next = w.next.filter((x) => x.temperatureF != null);
  const rainy = next.some((x) => x.rainChance >= 20);
  const hours = next.map((x) => `<div class="wx-hour">
      <span class="wx-h">${h(hourText(x.at, w.timeZone))}</span>${weatherIcon(x.kind, x.isDay)}
      <b class="num">${x.temperatureF}°</b>${rainy ? `<span class="wx-rain">${x.rainChance >= 20 ? `${x.rainChance}%` : ''}</span>` : ''}</div>`).join('');
  const minutes = Math.max(0, Math.round((now - w.at) / 60));
  const source = w.source === 'observed'
    ? `Observed ${minutes < 1 ? 'just now' : `${minutes} min ago`} at ${h(w.station.name)}, ${miles(w.station.distance)} away. Next hours from the hourly forecast.`
    : 'No weather station near you reported in the last 90 minutes, so this is the forecast for this hour.';
  return `${head}<div class="wx-card" style="--sky-top:${top};--sky-bottom:${bottom}">
    <div class="wx-place">${h(w.place ?? 'Where you are')}</div>
    <div class="wx-hero"><div><div class="wx-big num">${w.temperatureF}°</div>
      <div class="wx-cond-lg">${h(label)}${w.source === 'forecast' ? ' <span class="wx-tag">Forecast</span>' : ''}</div>
      ${w.condition && w.condition.toLowerCase() !== label.toLowerCase() ? `<div class="wx-said">${h(w.condition)}</div>` : ''}</div>
      ${weatherIcon(w.kind, w.isDay, 'wx-icon wx-hero-icon')}</div>
    ${metrics.length ? `<div class="wx-metrics">${metrics.map(([k, v]) => `<div><span>${k}</span><b>${h(v)}</b></div>`).join('')}</div>` : ''}
    ${hours ? `<div class="wx-hours">${hours}</div>` : ''}
  </div>
  <p class="note">${source} National Weather Service.</p>`;
}

/// "Waze" next to the Apple Maps and Google Maps buttons: the official Waze deep link, which opens the Waze
/// app when it is installed and the Waze website otherwise.
function wazeButton(c) {
  const link = wazeLink(c, 'exitatlas-web');
  return link ? `\n      <a class="btn sm" href="${h(link)}" target="_blank" rel="noopener">Waze</a>` : '';
}

export function statusPill(app) {
  if (app.isRerouting) return '<span class="pill warn"><span class="dot"></span>Rerouting</span>';
  const m = app.snapshot?.match;
  if (app.mode === 'idle') return '';
  if (app.gps === 'simulation') return '<span class="pill sim"><span class="dot"></span>Simulation</span>';
  if (app.mode === 'discovery' && !m) return '<span class="pill"><span class="dot"></span>Searching</span>';
  if (!m || m.status === 'acquiring') return '<span class="pill"><span class="dot"></span>Acquiring GPS</span>';
  if (m.status === 'offRoute') return '<span class="pill bad"><span class="dot"></span>Off route</span>';
  if (m.status === 'signalLost') return '<span class="pill bad"><span class="dot"></span>Signal lost</span>';
  if (m.isEstimated) return '<span class="pill warn"><span class="dot"></span>Estimating</span>';
  return '<span class="pill ok"><span class="dot"></span>On route</span>';
}

export function attribution() {
  return '<div class="attrib">Routing and map data © OpenStreetMap contributors (ODbL); navigation map tiles OpenFreeMap and OpenMapTiles. Exits and places: OpenInterstate. Rest area truck parking: FHWA. Discover places: Wikidata (CC0). State lines: U.S. Census TIGER/Line. Not affiliated with iExit.</div>';
}

// MARK: Drive

export function driveView(app) {
  const s = app.snapshot;
  if (s) return dashboard(app, s);
  if (app.mode === 'discovery') {
    return `<div class="stack"><div class="card lg"><div class="eyebrow">Discovery mode</div>
      <div class="title-md">${h(app.discoveryStatus)}</div>
      <p class="muted small">ExitAtlas matches your GPS position and heading to interstate corridors. Once it locks on, exits, state lines and mileage appear here. No destination needed.</p>
      ${app.corridors ? '' : '<p class="muted small">Loading interstate corridors…</p>'}
      ${app.lastError ? `<p class="amber-text small">${h(app.lastError)}</p>` : ''}</div>${screenNote(app)}</div>`;
  }
  return idleCards(app);
}

function screenNote(app) {
  if (app.gps !== 'device') return '';
  return `<p class="note">Keep this screen on and Safari in front while driving. iPhone pauses web page GPS when the screen locks or you switch apps; ExitAtlas estimates through short gaps and catches up when you return.${app.wake.supported ? '' : ' This browser cannot keep the screen awake, so set Auto Lock to Never for the drive.'}</p>`;
}

function idleCards(app) {
  let resume = '';
  const r = app.resumable;
  if (r) {
    resume = `<div class="card lg"><div class="eyebrow amber">Trip in progress</div>
      <div class="title-md">Resume your trip to ${h(r.destination?.name ?? 'your destination')}</div>
      <p class="muted small">${miles(r.drivenMeters)} driven so far. Your route and miles per state were saved on this phone.</p>
      <div class="btn-row"><button class="btn primary" data-act="resume">Resume</button><button class="btn" data-act="discard-resume">Discard</button></div></div>`;
  }
  const quick = quickPlaces(app);
  return `<div class="stack">${resume}${quick}
    <div class="card lg"><div class="eyebrow">Plan a trip</div><div class="title-lg">Where are you headed?</div>
      <p class="muted small">Every state on your route, miles in each state, exits before each state line, and services at every exit.</p>
      <button class="btn primary block" data-act="tab" data-arg="trip">Plan a route</button></div>
    <div class="card lg"><div class="eyebrow">Just driving</div><div class="title-md">Follow the interstate you are on</div>
      <p class="muted small">Discovery mode finds your highway and direction from GPS and shows what is ahead.</p>
      <button class="btn block" data-act="discovery">Start discovery mode</button></div>
    <div class="card lg"><div class="eyebrow">Try it parked</div><div class="title-md">Simulated demo: Miami to Manhattan</div>
      <p class="muted small">Plays a real OSRM route with simulated GPS at 30× speed. Clearly marked as a simulation.</p>
      <button class="btn block" data-act="demo">Run the demo</button></div>
  </div>`;
}

function quickPlaces(app) {
  const { home, saved, recent, plans } = app.places;
  const rows = [];
  plans.slice(0, 3).forEach((t, i) => {
    rows.push(`<button class="item" data-act="open-plan" data-arg="${i}"><span style="font-size:20px">🗺️</span><div class="main"><div class="t">${h(t.name)}</div><div class="muted tiny">${h(t.from?.name ?? 'Current location')} to ${h(t.to.name)}${t.stops.length ? `, ${t.stops.length} stop${t.stops.length === 1 ? '' : 's'}` : ''}</div></div><span class="chev">›</span></button>`);
  });
  if (home) rows.push(`<button class="item" data-act="go-to" data-arg="home"><span style="font-size:22px">🏠</span><div class="main"><div class="t">Home</div><div class="muted tiny">${h(home.name)}</div></div><span class="chev">›</span></button>`);
  saved.slice(0, 4).forEach((p, i) => {
    rows.push(`<button class="item" data-act="go-to" data-arg="saved:${i}"><span style="font-size:20px">★</span><div class="main"><div class="t">${h(p.name)}</div></div><span class="chev">›</span></button>`);
  });
  recent.filter((r) => (!home || r.name !== home.name) && !saved.some((p) => p.name === r.name)).slice(0, 3).forEach((r) => {
    const i = recent.indexOf(r);
    rows.push(`<button class="item" data-act="go-to" data-arg="${i}"><span style="font-size:20px">🕘</span><div class="main"><div class="t">${h(r.name)}</div></div><span class="chev">›</span></button>`);
  });
  return rows.length ? `<div><div class="section-title">Where to?</div><div class="list">${rows.join('')}</div></div>` : '';
}

/// The Drive screen in the driver's presentation (profile driving.drivePresentation): the Navigation View, map
/// first, or the Focus View, the compact dashboard. Both share the guidance, the instruments, the state line,
/// one adaptive card (engine/dashboard.js, held steady by FocusStabilizer) and the trip strip, and both fit a
/// phone screen without scrolling.
function dashboard(app, s) {
  const f = app.focusStabilizer.choose(focusSignals(app, s), s.t);
  const extras = [];
  if (s.match.status === 'offRoute' && !app.isRerouting && app.mode === 'trip') {
    extras.push(`<div class="banner warn">You are off the planned route.${app.gps === 'device' ? ' A new route is requested automatically when online.' : ''}</div>`);
  }
  if (app.lastError) extras.push(`<p class="amber-text small">${h(app.lastError)}</p>`);
  return app.settings.drivePresentation === 'focus' ? focusView(app, s, f, extras) : navView(app, s, f, extras);
}

const ICONS = {
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 13l4-5"/><circle cx="12" cy="13" r="1.5" fill="currentColor"/></svg>',
  recenter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l7 19-7-4-7 4z" fill="currentColor"/></svg>',
  fuel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"/><path d="M3 21h13"/><path d="M6 9h8"/><path d="M15 8l3 2v8a1.5 1.5 0 0 0 3 0v-7l-3-3"/></svg>',
  restroom: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="7" cy="4.5" r="2"/><path d="M5 8h4a1 1 0 0 1 1 1v6H8.6v6.5H5.4V15H4V9a1 1 0 0 1 1-1z"/><circle cx="17" cy="4.5" r="2"/><path d="M15.2 8h3.6a1 1 0 0 1 .96.73L21.5 15h-2.6v6.5h-3.8V15h-2.6l1.74-6.27A1 1 0 0 1 15.2 8z"/><rect x="11.5" y="3" width="1" height="18.5" rx=".5"/></svg>',
};

/// The small switch between the two presentations.
function viewToggle(app) {
  const v = app.settings.drivePresentation === 'focus' ? 'focus' : 'map';
  const b = (k, label) => `<button class="${v === k ? 'on' : ''}" data-act="drive-view" data-arg="${k}" aria-label="${label}" aria-pressed="${v === k}">${ICONS[k === 'map' ? 'map' : 'gauge']}</button>`;
  return `<div class="view-toggle" role="group" aria-label="Drive view">${b('map', 'Navigation view')}${b('focus', 'Focus view')}</div>`;
}

function roundButton(act, icon, label, extra = '') {
  return `<button class="round-btn" data-act="${act}" ${extra} aria-label="${label}">${ICONS[icon]}</button>`;
}

/// Speed, the posted limit, how far over it is, and the next change.
function speedInfo(app, s) {
  const mph = app.speedNow();
  const onRoute = s.match.status === 'onRoute';
  const limits = app.limits;
  const limit = onRoute && limits ? limits.at(s.progress) : null;
  const limitState = !onRoute ? 'unknown' : limits ? limits.state(s.progress) : 'loading';
  const over = mph !== null && limit !== null ? mph - limit : null;
  const level = over === null || over <= 0 ? 'ok' : over <= app.settings.speedAlertOver ? 'warn' : 'over';
  const next = onRoute && limits ? limits.nextChange(s.progress) : null;
  return { mph, limit, limitState, level, next };
}

function limitSign(si, sm = false) {
  return si.limit !== null
    ? `<div class="limit-sign${sm ? ' sm' : ''}" aria-label="Speed limit ${si.limit}"><span class="t">SPEED<br>LIMIT</span><span class="v num">${si.limit}</span></div>`
    : `<div class="limit-sign dim${sm ? ' sm' : ''}" aria-label="Speed limit not available"><span class="t">SPEED<br>LIMIT</span><span class="v num">${si.limitState === 'loading' ? '…' : '—'}</span></div>`;
}

/// The next maneuver within 10 miles from the route's own steps (engine/guidance.js), or null.
function maneuverAhead(app, s) {
  if (app.mode !== 'trip' || !app.plan) return null;
  const route = app.plan.route;
  return nextManeuver(route, s.progress, { within: 10 * MILE, destinationName: route.destination?.name ?? null, exits: app.plan.exits });
}

const ARROWS = {
  straight: 'M12 21V5M6 10l6-6 6 6',
  left: 'M17 21v-8a4 4 0 0 0-4-4H6M10 5L6 9l4 4',
  right: 'M7 21v-8a4 4 0 0 1 4-4h7M14 5l4 4-4 4',
  uturn: 'M8 21V9a4 4 0 0 1 8 0v4M12 10l4 4 4-4',
  keepLeft: 'M14 21v-6L8 9V4M4 8l4-4 4 4M14 15l4-4',
  keepRight: 'M10 21v-6l6-6V4M12 8l4-4 4 4M10 15L6 11',
  exitRight: 'M8 21V8M8 13c0-4 3-7 8-7M12 3l4 3-4 3',
  exitLeft: 'M16 21V8M16 13c0-4-3-7-8-7M12 3L8 6l4 3',
  merge: 'M8 21v-5l8-8V4M12 8l4-4 4 4M16 21v-6',
  arrive: 'M6 21V4M6 4h11l-2 4 2 4H6',
  roundabout: 'M12 21v-5M12 10a3 3 0 1 0 0-.01M15 7l2-3M17 4h-3',
};

function arrowPath(m) {
  if (m.kind === 'arrive') return ARROWS.arrive;
  if (m.kind === 'roundabout') return ARROWS.roundabout;
  if (m.kind === 'merge') return ARROWS.merge;
  if (m.kind === 'exit') return m.side === 'left' ? ARROWS.exitLeft : ARROWS.exitRight;
  if (m.kind === 'fork' || m.kind === 'ramp') return m.side === 'left' ? ARROWS.keepLeft : m.side === 'right' ? ARROWS.keepRight : ARROWS.straight;
  return ARROWS[m.side] ?? ARROWS.straight;
}

/// "1.6 mi", "0.3 mi", "Now".
function guideMiles(meters) {
  const mi = meters / MILE;
  if (mi < 0.1) return 'Now';
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)}<span> mi</span>`;
}

/// The words on the next exit's sign: its name, else the services there.
function exitWords(app, exit, max = Infinity) {
  const services = app.servicesFor(exit);
  const words = PLAQUE_ORDER.filter((c) => c <= 5 && services.some((x) => x.place.category === c)).slice(0, max)
    .map((c) => (c === 5 ? 'EV' : PLAQUE_WORDS[c].charAt(0) + PLAQUE_WORDS[c].slice(1).toLowerCase()));
  return { name: exit.name || null, services: words.join(' · '), html: words.length ? `<span class="svc-words">${words.map((x) => `<span>${h(x)}</span>`).join('')}</span>` : '' };
}

/// The guidance banner: the next maneuver when one comes within 10 miles, else the next exit, as a green
/// guide sign. A second line keeps the other in view.
function guidanceBanner(app, s) {
  const m = maneuverAhead(app, s);
  const ne = s.nextExit;
  const hw = s.highway ? `${highwayLabel(s.highway.ref)} ${s.highway.direction}` : null;
  if (m) {
    const nextExit = ne && ne.distance < m.distance - 50 && m.kind !== 'exit'
      ? `<button class="guide-sub" data-act="exit" data-arg="${h(ne.exit.id)}">Next exit · ${h(exitTitle(ne.exit))} · ${miles(ne.distance)}</button>` : '';
    return `<div class="guide maneuver" role="status" aria-label="${h(m.text)} in ${h(miles(m.distance))}">
      <svg class="guide-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${arrowPath(m)}"/></svg>
      <div class="guide-main"><div class="guide-dist num">${guideMiles(m.distance)}</div><div class="guide-text">${h(m.text)}</div></div></div>${nextExit}`;
  }
  if (!ne) {
    return hw ? `<div class="guide quiet" role="status"><div class="guide-main"><div class="guide-text">${h(hw)}</div><div class="guide-meta">No exits listed ahead on this road</div></div></div>` : '';
  }
  const w = exitWords(app, ne.exit);
  const far = app.mode === 'trip' ? nextManeuver(app.plan.route, s.progress, { exits: [] }) : null;
  const stay = hw ? `${h(hw)}${far ? ` for ${miles(far.distance)}` : ''}` : '';
  return `<button class="guide exit" data-act="exit" data-arg="${h(ne.exit.id)}" aria-label="Next exit, ${h(exitTitle(ne.exit))}, ${h(miles(ne.distance))}">
    <div class="guide-main">
      <div class="guide-row">${exitSign(ne.exit.label, true)}<span class="guide-dist num">${guideMiles(ne.distance)}</span><span class="guide-time">${duration(ne.eta - s.t)}</span></div>
      <div class="guide-text">${w.name ? h(w.name) : w.html || 'No services listed'}</div>
      ${w.name && w.html ? `<div class="guide-meta">${w.html}</div>` : ''}
    </div></button>${stay ? `<div class="guide-sub static">${stay}</div>` : ''}`;
}

/// The state line in one line: the next state, the miles and exits to it, the crossing time, the share of
/// this state driven. Emphasized when the line is close (adaptive card "border").
function stateLine(s, { emphasis = false, compact = false } = {}) {
  const cur = s.current, next = s.next;
  if (!cur) return '';
  const pct = Math.round(Math.max(0, Math.min(1, cur.fractionComplete)) * 100);
  if (!next) {
    return `<div class="state-line${compact ? ' compact' : ''}"><div class="sl-head">${badge(cur.segment.code, true, true)}<span class="sl-name">Final state: ${h(cur.segment.displayName)}</span>
      <span class="sl-miles num">${milesValue(cur.remainingMeters)}<span> mi</span></span></div>
      <div class="sl-facts">${cur.exitsRemaining} exits left · ${pct}% driven</div>${progress(cur.fractionComplete)}</div>`;
  }
  const crossing = cur.exitTime !== null ? clock(cur.exitTime, cur.exitTimeZoneID, s.t) : null;
  return `<div class="state-line${emphasis ? ' near' : ''}${compact ? ' compact' : ''}">
    <div class="sl-head">${badge(cur.segment.code, true, true)}<span class="sl-arrow" aria-hidden="true">→</span>${badge(next.segment.code, false, true)}
      <span class="sl-name">${h(next.segment.displayName)}${next.segment.isBrief ? ' <span class="amber-text tiny">brief</span>' : ''}</span>
      <span class="sl-miles num">${milesValue(cur.remainingMeters)}<span> mi</span></span></div>
    <div class="sl-facts"><b class="num">${cur.exitsRemaining}</b> exit${cur.exitsRemaining === 1 ? '' : 's'} left in ${h(cur.segment.code ?? 'this state')}${crossing ? ` · crossing ${crossing}` : ''} · ${pct}% of ${h(cur.segment.code ?? cur.segment.displayName)}</div>
    ${progress(cur.fractionComplete)}</div>`;
}

/// Miles left, arrival and states left (or the corridor in discovery mode), opening the Trip tab.
function tripStrip(app, s) {
  const discovery = app.mode === 'discovery';
  const left = discovery
    ? `<span><b class="num">${milesValue(s.remaining)}</b> mi of corridor ahead</span>`
    : `<span><b class="num">${milesValue(s.remaining)}</b> mi left</span><span><b class="num">${clock(s.eta, null, s.t)}</b> arrival</span><span><b class="num">${s.statesAhead.length}</b> state${s.statesAhead.length === 1 ? '' : 's'}</span>`;
  return `<button class="trip-strip" data-act="tab" data-arg="${discovery ? 'ahead' : 'trip'}" aria-label="Trip">${left}</button>`;
}

/// The journey panel, the same in both presentations: the state line over the trip strip.
function journey(app, s, f, { ribbon = false } = {}) {
  if (!s.current) return `<div class="journey">${tripStrip(app, s)}</div>`;
  return `<div class="journey${f.focus === 'border' ? ' near' : ''}">${ribbon ? `<div class="journey-ribbon">${stateRibbon(s)}</div>` : ''}${stateLine(s, { emphasis: f.focus === 'border', compact: !ribbon })}${tripStrip(app, s)}</div>`;
}

/// Fuel and the one tap restroom stop, labeled (Focus View).
function actionRow() {
  return `<div class="fv-actions"><button class="btn" data-act="sheet" data-arg="fuel">${ICONS.fuel}Fuel</button><button class="btn" data-act="sheet" data-arg="restroom">${ICONS.restroom}Restroom</button></div>`;
}

/// One adaptive card: the focus, or, when the focus already has its own place on screen (the next exit, the
/// state line), the first strip item worth a card.
function adaptiveCard(app, s, f, { exitShown }) {
  const own = exitShown ? ['exit', 'border', 'none'] : ['border', 'none'];
  let kind = f.focus;
  if (own.includes(kind)) kind = f.strip.find((k) => ['alert', 'fuel', 'stop', 'gap', 'restArea'].includes(k)) ?? null;
  if (!kind) return '';
  return focusCard(app, s, kind);
}

/// Navigation View: the map fills the screen; guidance at the top, speed on the left, controls on the right,
/// one adaptive card and the trip strip at the bottom. The map itself lives outside the view (navmap.js) so
/// it survives re-renders; main.js feeds it navMapState().
function navView(app, s, f, extras) {
  const si = speedInfo(app, s);
  const following = app.navMap?.following !== false;
  const offline = app.navMap?.failed ? `<div class="nav-note">Map unavailable: ${h(app.navMap.failed)}</div>`
    : app.navMap?.offline ? '<div class="nav-note">Map offline: your route and stops still show</div>' : '';
  // The map status sits under the speed, beside the controls, so it never pushes the bottom panel into them.
  // Near a state line the journey panel carries it (amber); the card shows the next item.
  const card = adaptiveCard(app, s, f, { exitShown: true });
  return `<div class="nav-view" data-focus="${f.focus}">
    <div class="nav-top">${guidanceBanner(app, s)}</div>
    <div class="nav-mid">
      <div class="nav-left"><div class="nav-speed"><div class="speed-chip ${si.level}" aria-label="${si.mph === null ? 'Speed unavailable' : `${si.mph} miles per hour`}"><span class="num">${si.mph === null ? '—' : si.mph}</span><small>MPH</small></div>${limitSign(si, true)}</div>${offline}</div>
      <div class="nav-right">${viewToggle(app)}${following ? '' : roundButton('nav-recenter', 'recenter', 'Follow my position')}
        ${roundButton('sheet', 'fuel', 'Fuel', 'data-arg="fuel"')}${roundButton('sheet', 'restroom', 'Restroom stop', 'data-arg="restroom"')}</div>
    </div>
    <div class="nav-bottom">${extras.join('')}${card ? `<div class="nav-card">${card}</div>` : ''}
      ${journey(app, s, f)}</div>
  </div>`;
}

/// Focus View: everything a driver needs on one screen, no map: instruments, the state line, the next exit,
/// one adaptive card and the trip strip.
function focusView(app, s, f, extras) {
  const si = speedInfo(app, s);
  const hw = s.highway;
  const instruments = `<section class="card fv-instruments ${si.level}">
    ${speedo(si.mph, si.limit, si.level)}
    <div class="limit-col">${limitSign(si)}${si.next ? `<div class="limit-next"><b class="num">${si.next.mph}</b> in ${miles(si.next.distance)}</div>` : si.limit === null && si.limitState === 'unknown' ? '<div class="limit-next">No limit data</div>' : ''}</div>
    <div class="road-col">${shield(hw?.ref, 40)}<div class="road-name">${hw ? h(highwayLabel(hw.ref)) : 'Local'}</div>
      <div class="road-dir">${hw ? DIRECTION_WORDS[hw.direction] : 'roads'}</div></div>
    ${viewToggle(app)}</section>`;
  const ne = s.nextExit;
  const m = maneuverAhead(app, s);
  const exitRow = m ? `<div class="fv-guide">${guidanceBanner(app, s)}</div>` : ne ? compactExit(app, s, ne) : '';
  const card = adaptiveCard(app, s, f, { exitShown: Boolean(exitRow) });
  return `<div class="focus-view" data-focus="${f.focus}">
    ${instruments}
    ${journey(app, s, f, { ribbon: true })}
    ${exitRow}
    ${card ? `<div class="fv-card">${card}</div>` : ''}
    ${actionRow()}
    ${extras.length ? `<div class="stack">${extras.join('')}</div>` : ''}
    ${screenNote(app)}
  </div>`;
}

/// The next exit as a compact green guide sign: number, name or services, distance and time on one panel.
function compactExit(app, s, ne) {
  const services = app.servicesFor(ne.exit);
  const w = exitWords(app, ne.exit);
  return `<button class="card exit-card fv-exit" data-act="exit" data-arg="${h(ne.exit.id)}">
    <div class="gsign compact" role="group" aria-label="Next exit ${h(exitTitle(ne.exit))}, ${h(miles(ne.distance))}">
      <div class="gs-row">${exitSign(ne.exit.label, true)}<span class="gs-dist num">${guideMiles(ne.distance)}</span><span class="gs-time">${duration(ne.eta - s.t)}</span></div>
      <div class="gsign-name">${w.name ? h(w.name) : w.html || 'No services listed'}</div></div>
    ${services.length ? servicePlaques(services, { compact: true, max: 2 }) : ''}</button>`;
}

/// What the Navigation View map shows: the route, the vehicle, and the few places the screen points at.
export function navMapState(app, s) {
  const plan = app.plan;
  const poly = plan.route.polyline;
  const pos = poly.coordinateAt(Math.min(s.progress, poly.length));
  const bearing = routeBearing(poly, s.progress);
  const markers = [{ id: 'you', lat: pos.lat, lon: pos.lon, cls: 'you', rotate: bearing,
    html: '<span class="puck"><svg viewBox="0 0 24 24"><path d="M12 2.5l7.5 18-7.5-4.2-7.5 4.2z" fill="var(--route)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></span>' }];
  const ne = s.nextExit;
  if (ne?.exit.coordinate) markers.push({ id: `exit-${ne.exit.id}`, lat: ne.exit.coordinate.lat, lon: ne.exit.coordinate.lon, cls: 'exit', anchor: 'bottom', html: exitSign(ne.exit.label, true) });
  const a = focusAlertItem(app, s);
  if (a && a.start - s.progress <= 50 * MILE) {
    const c = poly.coordinateAt(Math.max(a.start, s.progress));
    markers.push({ id: `alert-${a.incident.id}`, lat: c.lat, lon: c.lon, cls: `alert ${alertTier(a.incident)}`, html: `<span>${ALERT_ICONS[a.incident.category] ?? '⚠️'}</span>` });
  }
  const p = app.smartStop()?.primary;
  const pc = p ? (p.place?.coordinate ?? p.exit?.coordinate ?? p.restArea?.coordinate) : null;
  if (pc) markers.push({ id: `stop-${p.id}`, lat: pc.lat, lon: pc.lon, cls: 'stop', anchor: 'bottom', html: `<span>⛽ ${h(p.name)}</span>` });
  if (s.nextStop) {
    const c = s.nextStop.stop.waypoint.coordinate;
    markers.push({ id: `planned-${s.nextStop.stop.id}`, lat: c.lat, lon: c.lon, cls: 'planned', anchor: 'bottom', html: `<span>📍 ${h(s.nextStop.stop.waypoint.name)}</span>` });
  }
  if (s.next?.segment.entryCoordinate) {
    const c = s.next.segment.entryCoordinate;
    markers.push({ id: `line-${s.next.segment.index}`, lat: c.lat, lon: c.lon, cls: 'line', html: `<span>${h(s.next.segment.code ?? '')}</span>` });
  }
  const mph = app.speedNow() ?? 60;
  return { key: plan.route.id, poly, progress: s.progress, position: pos, bearing, zoom: mph > 45 ? 12.4 : 13.6, markers };
}

/// The one tap restroom stop: the best stop with a restroom listed in the next 60 miles and two alternatives,
/// with what is known about its hours and its restroom (never "open" from a 24 hour listing alone).
export function restroomSheet(app) {
  const head = '<div class="sheet-head"><h2>🚻 Restroom stop</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>';
  const r = app.bestStopAhead(60, { restrooms: true });
  const note = '<p class="note">Restrooms: rest areas and service plazas list theirs; at stations, a restroom listed by the brand has unknown hours. A station listed open 24 hours can still lock its restroom overnight.</p>';
  if (!r?.primary) return `${head}<div class="card empty"><div class="t">No stop with a listed restroom in the next 60 miles</div>Stops without a listing may still have one; check Road Ahead for the exits and rest areas coming up.</div>${note}${attribution()}`;
  const go = (x) => {
    const c = x.place?.coordinate ?? x.exit?.coordinate ?? x.restArea?.coordinate;
    if (!c) return '';
    return `<div class="btn-row" style="margin-top:10px"><a class="btn sm" href="https://maps.apple.com/?daddr=${c.lat},${c.lon}&dirflg=d" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a>${wazeButton(c)}</div>`;
  };
  const one = (x, best) => `<div class="card stop-card${best ? ' best' : ''}">
    ${best ? '<div class="eyebrow success-text">Best restroom stop ahead</div>' : ''}
    <div class="row" style="gap:12px;margin-top:${best ? 8 : 0}px">${smartSign(x)}<div style="flex:1;min-width:0"><div class="title-md">${h(x.name)}</div>
      <div class="muted small">${h(smartWhere(x))} · ${h(smartArrival(app, x))}</div></div></div>
    <div style="margin-top:6px">${confLine(x.evaluation.hours.status, x.evaluation.hours.label)}${confLine(x.evaluation.restroom.status, x.evaluation.restroom.label)}</div>
    ${go(x)}</div>`;
  return `${head}${r.notice ? `<div class="banner warn" style="margin:0 0 10px">${h(r.notice)}</div>` : ''}
    <div class="stack">${one(r.primary, true)}${r.alternatives.slice(0, 2).map((x) => one(x, false)).join('')}</div>${note}${attribution()}`;
}

/// What the focus rule needs from the trip.
function focusSignals(app, s) {
  const st = app.settings;
  const fp = app.fuelPlan();
  const sm = app.smartStop();
  const gap = app.gasGapsAhead(s).find((g) => g.to > s.progress) ?? null;
  let fuel = { reading: false };
  if (fp) {
    const needed = fp.status !== 'destination';
    fuel = {
      reading: true, range: fp.range, reserve: st.bufferMiles * MILE,
      stopAhead: needed ? (sm?.primary?.ahead ?? fp.recommended?.ahead ?? null) : null,
      low: needed && (Boolean(sm?.lowRange) || fp.status === 'low'),
    };
  }
  const zone = app.plan?.timeZoneIDAt(s.progress) ?? 'America/New_York';
  return {
    nextExit: s.nextExit ? { distance: s.nextExit.distance } : null,
    restArea: s.nextRestArea ? { distance: s.nextRestArea.distance } : null,
    gap: gap ? { startsIn: Math.max(0, gap.from - s.progress), length: gap.to - Math.max(gap.from, s.progress) } : null,
    plannedStop: s.nextStop ? { distance: s.nextStop.distance } : null,
    fuel, overnight: inOvernightWindow(app.profile, localTime(s.t, zone).minute),
    lastOpen: app.lastOpenAhead()?.stop.ahead ?? null,
    alert: focusAlert(app, s),
    border: s.next && s.current ? { distance: s.current.remainingMeters } : null,
  };
}

/// The alert the focus rule considers: the first serious one within 50 miles, else the nearest.
function focusAlertItem(app, s) {
  // Work zones that leave the travel lanes open stay in Road Ahead.
  const alerts = (app.roadIntel()?.alerts ?? []).filter((a) => a.notable);
  return alerts.find((a) => a.serious && a.start - s.progress <= 50 * MILE) ?? alerts[0] ?? null;
}

function focusAlert(app, s) {
  const a = focusAlertItem(app, s);
  return a ? { distance: Math.max(0, a.start - s.progress), serious: a.serious, id: a.incident.id } : null;
}

const ALERT_ICONS = { closure: '⛔', crash: '⚠️', flooding: '🌊', weather: '⛈️', hazard: '⚠️', disabledVehicle: '🚗', construction: '🚧', congestion: '🐢', police: '🚓', speedCamera: '📷', other: '⚠️' };

/// "Source: National Weather Service · Updated 6 minutes ago", "starts 8:00 PM" for scheduled work that has
/// not begun, and "until 8:45 PM" for timed events.
function alertMeta(app, a, s) {
  const i = a.incident;
  const now = Date.now() / 1000;
  const parts = [`Source: ${a.sources.map((x) => h(x.name)).join(', ')}`, h(freshnessText(i, now))];
  if (i.startsAt && i.startsAt > now) parts.push(`starts ${clock(i.startsAt, app.plan.timeZoneIDAt(a.start), s.t)}`);
  if (i.endsAt) parts.push(`until ${clock(i.endsAt, app.plan.timeZoneIDAt(a.start), s.t)}`);
  return parts.join(' · ');
}

/// A road alert ahead: the headline in its tier color (red urgent, amber caution, blue information), the road,
/// the details, how old and whose. Driver reports say they are unconfirmed. Tap for the detail sheet.
function alertCard(app, s) {
  const a = focusAlertItem(app, s);
  if (!a) return nextExitCard(app, s);
  const i = a.incident;
  const tier = alertTier(i);
  const road = alertRoad(app, a);
  const sub = i.category === 'weather' || i.category === 'flooding' ? (i.area ?? i.description) : (i.lanes ?? (i.description !== ALERT_KINDS[i.category].label ? i.description : ''));
  return `<button class="card focus-card alert-card tier-${tier}" data-act="alert" data-arg="${h(i.id)}">
    <div class="row" style="gap:12px;align-items:flex-start"><span class="al-icon" aria-hidden="true">${ALERT_ICONS[i.category] ?? '⚠️'}</span>
      <div style="flex:1;min-width:0"><div class="al-head">${h(alertHeadline(i))}</div>${road ? `<div class="title-md">${h(road)}</div>` : ''}
      ${sub ? `<div class="small">${h(sub)}</div>` : ''}
      ${i.verification === 'community' ? '<div class="small amber-text">Reported by drivers, not confirmed</div>' : ''}
      ${a.directionKnown ? '' : '<div class="muted tiny">Direction not reported</div>'}
      <div class="muted tiny" style="margin-top:4px">${alertMeta(app, a, s)}</div></div>
      ${tlDist(a.start - s.progress, null)}</div></button>`;
}

function focusCard(app, s, kind) {
  switch (kind) {
    case 'alert': return alertCard(app, s);
    case 'fuel': return fuelCard(app, s);
    case 'stop': return plannedStopCard(app, s);
    case 'gap': return gasGapCard(app, s);
    case 'lastOpen': return lastOpenCard(app, s);
    case 'overnight': return app.fuel ? fuelCard(app, s) : overnightCard(app, s);
    case 'restArea': return restAreaCard(s);
    // The state line card above already carries the approach to the border.
    case 'exit': case 'border': return nextExitCard(app, s);
    default: return '';
  }
}

/// Approaching a planned stop: the stop and the exit to leave at.
function plannedStopCard(app, s) {
  const ns = s.nextStop;
  const at = ns.stop.distanceAlongRoute;
  const exit = app.plan.exits.filter((e) => e.distanceAlongRoute > s.progress)
    .reduce((best, e) => (!best || Math.abs(e.distanceAlongRoute - at) < Math.abs(best.distanceAlongRoute - at) ? e : best), null);
  return `<div class="card focus-card"><div class="eyebrow">Planned stop</div>
    <div class="row" style="gap:12px;margin-top:8px">${exit ? exitSign(exit.label, true) : ''}<div style="flex:1;min-width:0"><div class="title-md">${h(ns.stop.waypoint.name)}</div>
      <div class="muted small">${clock(ns.eta, app.plan.timeZoneIDAt(at), s.t)}${exit ? ` · leave at ${h(exitTitle(exit))}` : ''}</div></div>
      <div class="side" style="text-align:right"><div class="num" style="font:800 28px/1 var(--num)">${milesValue(ns.distance)}<span class="muted small"> mi</span></div></div></div></div>`;
}

/// Overnight without a range reading: the best restroom stop in the next 60 miles, with its confidence.
function overnightCard(app, s) {
  const r = app.bestStopAhead(60, { restrooms: true });
  const p = r?.primary;
  if (!p) return s.nextRestArea ? restAreaCard(s) : '';
  const act = p.exit ? `data-act="exit" data-arg="${h(p.exit.id)}"` : p.restArea ? `data-act="rest" data-arg="${h(p.restArea.id)}"` : '';
  return `<button class="card focus-card" style="width:100%;text-align:left;display:block" ${act}>
    <div class="eyebrow">🌙 Overnight · restroom stop</div>
    <div class="row" style="gap:12px;margin-top:8px">${smartSign(p)}<div style="flex:1;min-width:0"><div class="title-md">${h(p.name)}</div>
      ${smartConfidence(p, r)}<div class="muted tiny">${h(smartWhere(p))} · ${h(smartArrival(app, p))}</div></div></div>
    ${r.notice ? `<div class="muted tiny" style="margin-top:6px">${h(r.notice)}</div>` : ''}</button>`;
}

/// Overnight, before a long stretch where no stop is listed open at its arrival time: the last one that is.
function lastOpenCard(app, s) {
  const lo = app.lastOpenAhead();
  if (!lo) return nextExitCard(app, s);
  const p = { ...lo.stop, evaluation: lo.evaluation };
  const act = p.exit ? `data-act="exit" data-arg="${h(p.exit.id)}"` : p.restArea ? `data-act="rest" data-arg="${h(p.restArea.id)}"` : '';
  const one = lo.unlisted === 1;
  const after = `${one ? 'The next stop' : `The next ${lo.unlisted} stops`}, ${lo.openEnded ? 'in the next' : 'over'} ${miles(lo.length)}, ${one ? 'has' : 'have'} no hours listed open at your arrival time.`;
  return `<button class="card focus-card" style="width:100%;text-align:left;display:block" ${act}>
    <div class="eyebrow">🌙 Last stop listed open for ${miles(lo.length)}${lo.openEnded ? '+' : ''}</div>
    <div class="row" style="gap:12px;margin-top:8px">${smartSign(p)}<div style="flex:1;min-width:0"><div class="title-md">${h(p.name)}</div>
      ${confLine(p.evaluation.hours.status, p.evaluation.hours.label)}<div class="muted tiny">${h(smartWhere(p))} · ${h(smartArrival(app, p))}</div></div></div>
    <div class="muted tiny" style="margin-top:6px">${after}</div></button>`;
}



/// Ring speedometer: 270 degree arc, value arc colored by the limit, tick at the posted limit.
function speedo(mph, limit, level) {
  const max = mph !== null && mph > 112 ? 140 : 120;
  const r = 84, c = 2 * Math.PI * r, arc = c * 0.75;
  const frac = mph === null ? 0 : Math.min(1, mph / max);
  let tick = '';
  if (limit !== null) {
    const a = (135 + 270 * Math.min(1, limit / max)) * Math.PI / 180;
    const p = (rad) => `${(100 + rad * Math.cos(a)).toFixed(1)} ${(100 + rad * Math.sin(a)).toFixed(1)}`;
    tick = `<path d="M${p(70)} L${p(98)}" class="speedo-tick"/>`;
  }
  return `<div class="speedo ${level}" aria-label="${mph === null ? 'Speed unavailable' : `${mph} miles per hour`}">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r="${r}" class="speedo-track" stroke-dasharray="${arc.toFixed(1)} ${c.toFixed(1)}" transform="rotate(135 100 100)"/>
      <circle cx="100" cy="100" r="${r}" class="speedo-value" stroke-dasharray="${(arc * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(135 100 100)"/>
      ${tick}
    </svg>
    <div class="speedo-num num">${mph === null ? '—' : mph}</div><div class="speedo-unit">MPH</div></div>`;
}

/// The state ledger: the whole route as one bar split into states in proportion to their miles,
/// with the driven part filled and a marker where you are. ExitAtlas's signature element.
function stateRibbon(s) {
  const items = s.itinerary;
  const total = items.reduce((t, f) => t + f.segment.length, 0);
  if (!(total > 0) || items.length < 2) return '';
  const pos = Math.max(0, Math.min(1, (s.progress - items[0].segment.startDistance) / total));
  let colorIndex = 0;
  const parts = items.map((f) => {
    const seg = f.segment;
    const w = (seg.length / total) * 100;
    const color = seg.code ? `var(--seg${colorIndex++ % 4})` : 'var(--map-line)';
    const done = f.status === 'completed' ? 1 : f.status === 'current' ? Math.max(0, Math.min(1, (s.progress - seg.startDistance) / seg.length)) : 0;
    return { seg, w, color, done, status: f.status };
  });
  const bar = parts.map((p) => `<span class="rseg ${p.status}" style="width:${p.w.toFixed(3)}%;--c:${p.color};--done:${(p.done * 100).toFixed(1)}%"></span>`).join('');
  const labels = parts.map((p) => `<span class="rlab ${p.status}" style="width:${p.w.toFixed(3)}%">${p.w >= 5 && p.seg.code ? h(p.seg.code) : ''}</span>`).join('');
  const spoken = parts.filter((p) => p.seg.code).map((p) => `${p.seg.displayName} ${Math.round(p.seg.length / MILE)} miles`).join(', ');
  return `<div class="ribbon" role="img" aria-label="Route by state: ${h(spoken)}. You are ${Math.round(pos * 100)} percent of the way.">
    <div class="ribbon-bar">${bar}</div><span class="ribbon-pin" style="left:${(pos * 100).toFixed(2)}%"></span>
    <div class="ribbon-labels">${labels}</div></div>`;
}


function nextExitCard(app, s) {
  const ne = s.nextExit;
  const services = app.servicesFor(ne.exit);
  return `<button class="card exit-card" data-act="exit" data-arg="${h(ne.exit.id)}">
    <div class="eyebrow">Next exit</div>
    ${guideSign(ne.exit, ne.distance, ne.eta - s.t, services)}
    ${servicePlaques(services)}</button>`;
}

function restAreaCard(s) {
  const u = s.nextRestArea, r = u.restArea;
  const then = s.upcomingRestAreas.find((x) => x.restArea.id !== r.id);
  return `<button class="card exit-card ra-card" data-act="rest" data-arg="${h(r.id)}">
    <div class="eyebrow">Next ${h((KIND_TITLES[r.kind] ?? 'rest area').toLowerCase())}</div>
    <div class="row" style="gap:12px;margin-top:8px">${restSign(r.kind)}<div style="flex:1;min-width:0"><div class="title-md">${h(restAreaTitle(r))}</div>
      <div class="muted small">${r.side === 'both' ? 'Serves both directions · ' : ''}${h(r.road)}</div></div>
      <div class="side" style="text-align:right"><div class="num" style="font:800 28px/1 var(--num)">${milesValue(u.distance)}<span class="muted small"> mi</span></div><div class="muted small">${duration(u.eta - s.t)}</div></div></div>
    ${amenityChips(r)}
    ${then ? `<div class="muted tiny" style="margin-top:8px">Then ${h(restAreaTitle(then.restArea))}, ${miles(then.distance)}</div>` : ''}</button>`;
}

/// Amber card when the next stretch without gas starts within 25 miles, or the driver is in one.
function gasGapCard(app, s) {
  const g = app.gasGapsAhead(s).find((x) => x.from - s.progress <= 25 * MILE);
  if (!g) return '';
  const inside = !g.before || g.before.distance <= s.progress;
  const title = inside ? `No gas for the next ${miles(g.to - s.progress)}${g.open ? '+' : ''}`
    : `Last gas for ${miles(g.length)}${g.open ? '+' : ''}: ${h(gasStopTitle(g.before))}`;
  const sub = inside ? (g.after ? `Next gas at ${h(gasStopTitle(g.after))}` : 'None listed ahead on this route')
    : `In ${miles(g.before.distance - s.progress)}${g.after ? `, then next gas at ${h(gasStopTitle(g.after))}` : ''}`;
  return `<div class="card gap-card" role="status"><span class="gap-icon" aria-hidden="true">⛽</span><div><div style="font-weight:800">${title}</div><div class="small">${sub}</div></div></div>`;
}

// MARK: SmartStop

const CONF_CLASS = { verified: 'ok', reported: 'lim', unknown: 'unk', closed: 'bad', accessible: 'ok', available: 'lim', none: 'bad' };

/// One status line with a colored dot: hours or restroom confidence (labels only, never a score).
function confLine(status, label) {
  return `<div class="conf ${CONF_CLASS[status] ?? 'unk'}"><span class="dot" aria-hidden="true"></span>${h(label)}</div>`;
}

function smartSign(x) {
  return x.exit ? exitSign(x.exit.label, true) : restSign(x.kind === 'rest' ? 'rest' : 'plaza', true);
}

/// Distance line (the sign beside it shows the exit number).
function smartWhere(x) {
  return `${x.exit ? '' : 'On the highway · '}${milesValue(x.ahead)} mi ahead`;
}

/// "12:00 AM" from "00:00".
function clockText(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

/// Hours and restroom lines for a pick: the restroom only when it is known or needed.
function smartConfidence(x, sm) {
  const e = x.evaluation;
  let html = confLine(e.hours.status, e.hours.label);
  if (e.restroom.status !== 'unknown' || sm.overnight) html += confLine(e.restroom.status, e.restroom.label);
  return html;
}

function smartArrival(app, x) {
  const parts = [`Arrive ${clock(x.arrival, x.timeZone, app.snapshot?.t)}`];
  if (x.rangeOnArrival != null) parts.push(`about ${miles(x.rangeOnArrival)} left`);
  return parts.join(' · ');
}

/// Facility rows: pumps, store, restroom, restroom hours, plaza hours, parking, each with its source.
function facilityRows(x) {
  return x.evaluation.facilities.map((f) => `<div class="fac"><span class="fn">${h(f.name)}</span><span class="fv">${confLine(f.status, f.label)}
    <span class="muted tiny">${f.source ? h(f.source) : 'No source lists it'}${f.checked ? `, checked ${h(f.checked)}` : ''}${f.closesIn != null && f.closesIn <= 120 ? `, closes ${f.closesIn} min after arrival` : ''}</span></span></div>`).join('');
}

function overnightRow(app) {
  const st = app.settings;
  const modes = [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']];
  return `<div class="field"><span style="flex:1">🌙 Overnight Drive Mode<div class="muted tiny">${st.overnightMode === 'auto' ? `Auto: ${clockText(st.overnightStart)} to ${clockText(st.overnightEnd)}, by each stop's local arrival time` : st.overnightMode === 'on' ? 'On now: open hours and restrooms rank first' : 'Off: hours and restrooms do not change the ranking'}</div></span>
    <div class="seg" style="width:170px">${modes.map(([k, n]) => `<button class="${st.overnightMode === k ? 'on' : ''}" data-act="overnight-mode" data-arg="${k}">${n}</button>`).join('')}</div></div>`;
}

/// SmartStop in the fuel sheet: the recommendation, alternatives, why the favorite lost, what was passed.
function smartSection(app, sm) {
  const p = sm.primary;
  const pass = Object.entries(sm.passed);
  const fav = sm.favorite
    ? `<p class="small" style="margin:0">${h(sm.favorite.name)}${sm.favorite.exitId ? `, ${h(exitTitle(app.plan.exits.find((e) => e.id === sm.favorite.exitId) ?? {}))}` : ''}: ${h(sm.favorite.reason.charAt(0).toUpperCase() + sm.favorite.reason.slice(1))}.</p>` : '';
  const alt = (x) => `<div class="item">${smartSign(x)}<div class="main"><div class="t">${h(x.name)}</div><div class="muted tiny">${h(smartWhere(x))} · ${h(smartArrival(app, x))}</div>
      ${smartConfidence(x, sm)}<div class="muted tiny">${h(x.reasons.filter((r) => !r.startsWith(x.evaluation.hours.label) && r !== x.evaluation.restroom.label).join(' · '))}</div></div>
      <button class="btn sm" data-act="skip-stop" data-arg="${h(x.id)}" aria-label="Not this one: ${h(x.name)}">Skip</button></div>`;
  return `<div class="section-title">${sm.lowRange ? 'Nearest stop, fuel below your reserve' : 'Recommended stop'}</div>
    ${sm.notice ? `<div class="banner warn" style="margin:0 0 10px">${h(sm.notice)}</div>` : ''}
    <div class="card smart${sm.lowRange ? ' low' : ''}">
      <div class="row" style="gap:12px">${smartSign(p)}<div style="flex:1;min-width:0"><div class="title-md">${p.brandRank !== null ? '★ ' : ''}${h(p.name)}</div>
        <div class="muted small">${h(smartWhere(p))} · ${h(smartArrival(app, p))}</div></div></div>
      ${priceLine(app, p)}
      <ul class="smart-reasons">${p.reasons.map((r) => `<li>${h(r)}</li>`).join('')}${p.nextOption != null ? `<li>Next option ${miles(p.nextOption)} later</li>` : ''}</ul>
      ${cheaperNote(app, sm)}
      <details class="facilities"><summary>What is known at arrival</summary>${facilityRows(p)}</details>
      <div class="btn-row">${p.exit ? `<button class="btn sm" data-act="exit" data-arg="${h(p.exit.id)}">Exit details</button>` : p.restArea ? `<button class="btn sm" data-act="rest" data-arg="${h(p.restArea.id)}">Plaza details</button>` : ''}
        ${app.priceOptions() ? `<button class="btn sm" data-act="station" data-arg="${h(p.id)}">Prices</button>` : ''}
        <button class="btn sm" data-act="skip-stop" data-arg="${h(p.id)}">Not this one</button></div>
      ${fav}
    </div>
    ${sm.alternatives.length ? `<div class="section-title">Alternatives</div><div class="list">${sm.alternatives.map(alt).join('')}</div>` : ''}
    ${pass.length ? `<p class="muted tiny" style="margin:4px 0 0">Passed over: ${h(pass.map(([r, n]) => `${n} ${r.charAt(0).toLowerCase() + r.slice(1)}`).join(', '))}.${app.rejectedStops.length ? ' <button class="linkish" data-act="unskip-stops">Offer skipped stops again</button>' : ''}</p>` : ''}
    <div class="list" style="margin-top:10px">${overnightRow(app)}</div>
    <p class="note">Hours: Google Maps business hours when you check Google prices (live), else OpenStreetMap (mapped by volunteers; the check date shows when). A station listed open 24 hours can still lock its restroom overnight, so restrooms show as open at arrival only at rest areas and service plazas with listed hours.</p>`;
}

// MARK: Gas prices (docs/17)

/// Brand colors for the small brand tag on price rows, so a favorite like Shell is found at a glance. A
/// colored name only, not the brand's logo.
const BRAND_TAGS = [
  [/shell/i, '#fbce07', '#dd1d21', 'SHELL'], [/\bbp\b/i, '#009b3a', '#fff', 'BP'], [/exxon/i, '#e4002b', '#fff', 'EXXON'],
  [/mobil/i, '#e4002b', '#fff', 'MOBIL'], [/wawa/i, '#c8102e', '#fff', 'WAWA'], [/pilot/i, '#d71920', '#fff', 'PILOT'],
  [/flying j/i, '#d71920', '#fff', 'FLY J'], [/love'?s/i, '#ffd100', '#e31837', "LOVE'S"], [/sunoco/i, '#003da5', '#ffd100', 'SUNOCO'],
  [/chevron/i, '#0054a4', '#fff', 'CHEVRON'], [/sheetz/i, '#d71920', '#fff', 'SHEETZ'], [/racetrac/i, '#003da5', '#fff', 'RACETRAC'],
  [/circle k/i, '#da291c', '#fff', 'CIRCLE K'], [/speedway/i, '#d71920', '#fff', 'SPEEDWAY'], [/marathon/i, '#003da5', '#fff', 'MARATHON'],
  [/quiktrip|\bqt\b/i, '#d71920', '#fff', 'QT'], [/buc-?ee'?s/i, '#ffd100', '#d71920', "BUC-EE'S"], [/costco/i, '#005daa', '#fff', 'COSTCO'],
  [/citgo/i, '#e31837', '#fff', 'CITGO'], [/valero/i, '#005a9c', '#ffc72c', 'VALERO'], [/7-?eleven/i, '#008061', '#fff', '7-ELEVEN'],
  [/murphy/i, '#0055a5', '#fff', 'MURPHY'], [/\bgulf\b/i, '#f47b20', '#fff', 'GULF'], [/texaco/i, '#e2231a', '#fff', 'TEXACO'],
  [/phillips 66/i, '#d71920', '#fff', 'P66'], [/conoco/i, '#d71920', '#fff', 'CONOCO'], [/casey'?s/i, '#d71920', '#fff', "CASEY'S"],
  [/cumberland/i, '#00703c', '#fff', 'CUMB FARMS'], [/\bhess\b/i, '#00843d', '#fff', 'HESS'], [/sinclair/i, '#00843d', '#fff', 'SINCLAIR'],
];

function brandTag(x) {
  const name = `${x.brand ?? ''} ${x.name ?? ''}`;
  const hit = BRAND_TAGS.find(([re]) => re.test(name));
  const [bg, fg, label] = hit ? hit.slice(1) : ['var(--stroke)', 'var(--text)', (x.brand || x.name || '?').slice(0, 6).toUpperCase()];
  return `<span class="brand-tag" style="background:${bg};color:${fg}" aria-hidden="true">${h(label)}</span>`;
}

/// Where a price came from, in a few words: "you", "ExitAtlas drivers (3)", "Google Maps".
function priceSourceText(sp) {
  const src = sp.record.source;
  if (src.kind === 'own') return 'you';
  if (src.kind === 'simulated') return 'SIMULATED test data';
  if (src.kind === 'community') return `${src.name}${sp.confirmations ? ` (${sp.confirmations + 1})` : ''}`;
  return src.name;
}

/// The line under a price: when it was reported, by whom, and anything that limits it.
function priceMeta(sp) {
  if (!sp) return '';
  const parts = [sp.text, priceSourceText(sp)];
  if (sp.paymentMatch === 'other') parts.push(`${sp.record.payment} price`);
  else if (sp.paymentMatch === 'unspecified') parts.push('cash or credit not said');
  if (sp.record.member) parts.push('member price');
  if (sp.conflict) parts.push('reports differ');
  if (sp.state !== 'current') parts.push('old, not compared');
  return parts.join(' · ');
}

/// "$3.09 Regular" on the right of a row, greyed when old; "Price unavailable" without a report.
function priceTag(sp, grade) {
  if (!sp) return '<div class="ptag none">Price<br>unavailable</div>';
  return `<div class="ptag${sp.state === 'current' ? '' : ' old'}"><div class="pv">${h(dollars(sp.record.price))}</div><div class="muted tiny">${h(GRADE_NAMES[grade])}</div></div>`;
}

/// One line for a stop's price in cards: the price and its source, or "Price unavailable". On the Drive
/// screen (onMap) a Google Maps price is not shown: Google's terms keep its data off non-Google maps.
function priceLine(app, x, { onMap = false } = {}) {
  const o = app.priceOptions();
  if (!o || !x || x.kind === 'charge') return '';
  const sp = x.priceInfo ?? null;
  if (onMap && sp?.record.source.kind === 'google') return '<div class="price-line muted tiny">Google Maps price: see Road Ahead</div>';
  if (!sp) return `<div class="price-line muted tiny">${h(GRADE_NAMES[o.grade])}: price unavailable</div>`;
  return `<div class="price-line${sp.state === 'current' ? '' : ' old'}"><b>${h(dollars(sp.record.price))}</b> <span class="muted tiny">${h(GRADE_NAMES[o.grade])} · ${h(priceMeta(sp))}</span></div>`;
}

/// SmartStop's note when another stop saves at least the driver's minimum on a fill. A note only: the pick
/// and the favorite brands stay as they are.
function cheaperNote(app, sm, { onMap = false } = {}) {
  const ch = sm?.cheaper, p = sm?.primary;
  if (!ch || !p || (onMap && (ch.price.kind === 'google' || p.priceInfo?.record.source.kind === 'google'))) return '';
  const o = app.priceOptions();
  const where = `${ch.name}${ch.exit ? `, ${exitTitle(ch.exit)}` : ''}, ${ch.farther >= 0 ? `${milesValue(ch.farther)} mi farther` : `${milesValue(-ch.farther)} mi sooner`}`;
  const keep = p.brandRank !== null ? `Your ${p.brand || p.name} preference stays as it is.` : 'Your favorite brands stay as they are.';
  return `<div class="cheaper" data-testid="cheaper-note"><div class="small"><b class="amber-text">Cheaper stop:</b> ${h(where)}</div>
    <div class="muted tiny">${h(dollars(ch.price.value))} ${h(GRADE_NAMES[o?.grade ?? 'R'].toLowerCase())}, ${h(ch.price.text.toLowerCase())} (${h(ch.price.source)}). Estimate: about $${ch.savings.toFixed(2)} less for a ${ch.gallons.toFixed(1)} gal fill, detour fuel included${ch.estimate ? ' (a detour was not measured)' : ''}. ${h(keep)}</div></div>`;
}

/// Road Ahead, Fuel: every station and fuel plaza in the window with its price for the driver's grade,
/// sorted as asked. Unknown and old prices never sort as cheaper.
function compareCard(app, s) {
  const o = app.priceOptions();
  if (!o) return '';
  const r = app.bestStopAhead(Math.max(60, app.exitsUI.window));
  const win = app.exitsUI.window * MILE;
  const list = (r?.stations ?? []).filter((c) => c.ahead > 0 && c.ahead <= win);
  const favorites = app.profile.fuel.brands ?? [];
  const sort = SORTS.includes(app.priceUI.sort) ? app.priceUI.sort : 'recommended';
  const rows = list.map((c) => ({ id: c.id, c, ahead: c.ahead, detourMinutes: c.detourMinutes, brandRank: brandIndex(c, favorites),
    recommendedRank: r.order.includes(c.id) ? r.order.indexOf(c.id) : null, price: c.priceInfo }));
  const sorted = sortStations(rows, sort);
  const label = (k) => (k === 'brand' && favorites[0] ? `${favorites[0]} first` : SORT_NAMES[k]);
  const chips = `<div class="chips wrap" role="group" aria-label="Sort stations">${SORTS.map((k) => `<button class="chip${k === sort ? ' on' : ''}" data-act="price-sort" data-arg="${k}" aria-pressed="${k === sort}">${h(label(k))}</button>`).join('')}</div>`;
  const row = ({ c, price }) => {
    const e = evaluateStop(c, app.profile);
    const detour = c.kind === 'plaza' ? 'On the highway' : c.detourMinutes != null ? `${c.detourMinutes < 1 ? 'under 1' : Math.round(c.detourMinutes)} min detour` : 'Detour not measured';
    return `<button class="item pr-row" data-act="station" data-arg="${h(c.id)}">${brandTag(c)}<div class="main">
      <div class="t">${h(c.name)} ${c.exit ? exitSign(c.exit.label, true) : ''} <span class="muted small">${milesValue(c.ahead)} mi</span></div>
      <div class="tiny pr-facts">${confLine(e.hours.status, e.hours.label)}${confLine(e.restroom.status, e.restroom.label)}<span class="muted">${h(detour)}</span></div>
      ${price ? `<div class="tiny ${price.state === 'current' ? 'muted' : 'amber-text'}">${h(priceMeta(price))}</div>` : ''}</div>${priceTag(price, o.grade)}</button>`;
  };
  const google = app.settings.prices?.google && app.prices.enabled
    ? `<button class="btn sm block" style="margin-top:10px" data-act="google-ahead">Check Google Maps prices for the next 3 exits</button>
      <p class="muted tiny" style="margin:6px 2px 0">Paid, on your own key (keep it capped in Google Cloud). This month: ${app.priceCalls()} lookups. Shown here with Google's name, never on the map, not saved.</p>` : '';
  const shared = app.priceBook.sharedState === 'unavailable' ? '<p class="muted tiny" style="margin:6px 4px 0">Shared driver reports could not load just now; stations without your own report show as unavailable.</p>' : '';
  const any = list.some((c) => c.priceInfo);
  const sim = app.priceBook.simulated.length ? '<div class="sim-tag">SIMULATED PRICES · test data, not real</div>' : '';
  return `<div class="card compare" data-testid="price-compare">${sim}<div class="row"><b style="flex:1">${h(GRADE_NAMES[o.grade])} · ${o.payment}</b><span class="muted tiny">${list.length} ${list.length === 1 ? 'stop' : 'stops'} in ${app.exitsUI.window} mi</span></div>${chips}${google}</div>
    ${list.length ? `<div class="list">${sorted.slice(0, 20).map(row).join('')}</div>` : `<div class="card empty">No gas listed in the next ${app.exitsUI.window} miles. Try a longer window.</div>`}
    ${shared}${benchmarkLine(app, o.grade)}<p class="muted tiny" style="margin:6px 4px 0">${any ? 'Prices are reports with their time and source, not verified pump prices.' : 'No current reports for these stations. Tap a station to add the price you see.'} Reports older than ${o.maxAgeHours} h show greyed and are not compared.</p>`;
}

/// EIA's regional average as context: never a station's price, always with its week.
function benchmarkLine(app, grade) {
  const b = app.benchmark(grade);
  if (!b) return '';
  const week = new Date(`${b.weekOf}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `<p class="muted tiny" style="margin:6px 4px 0" data-testid="benchmark">${h(b.name)} average, ${h(GRADE_NAMES[grade].toLowerCase())}: ${h(dollars(b.price))} (EIA, week of ${h(week)}). Context only, never a station's price.</p>`;
}

/// A station's prices for every grade, with their sources, and the driver's own reports there.
export function stationSheet(app, id) {
  const x = app.findStation(id);
  if (!x) return '<div class="empty">Station not found on this route.</div>';
  const o = app.priceOptions() ?? { grade: app.gradeCode(), payment: app.settings.prices?.payment ?? 'credit', maxAgeHours: app.settings.prices?.maxAgeHours ?? 24, now: Math.floor(Date.now() / 1000) };
  const ctx = { ...app.stopContext(), priceOptions: o };
  const rows = PRICE_GRADES.map((g) => {
    const sp = stopPrice({ ...ctx, priceOptions: { ...o, grade: g } }, id, x.live ?? null);
    return `<div class="field"><span style="flex:1">${h(GRADE_NAMES[g])}${g === o.grade ? ' <span class="muted tiny">your grade</span>' : ''}${sp ? `<div class="muted tiny">${h(priceMeta(sp))}${sp.record.payment ? ` · ${h(sp.record.payment)}` : ''}</div>` : ''}</span>
      ${sp ? `<b class="${sp.state === 'current' ? '' : 'muted'}" style="font-size:18px">${h(dollars(sp.record.price))}</b>` : '<span class="muted small">Price unavailable</span>'}</div>`;
  }).join('');
  const now = Math.floor(Date.now() / 1000);
  const mine = app.priceBook.own().filter((r) => r.stationId === id).sort((a, b) => b.reportedAt - a.reportedAt);
  const mineRows = mine.map((r) => `<div class="field"><span style="flex:1">${h(GRADE_NAMES[r.grade])} ${h(dollars(r.price))}<div class="muted tiny">${h(r.payment ?? 'cash or credit not said')}${r.member ? ' · member price' : ''} · ${h(new Date(r.reportedAt * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${r.sharedId ? ' · shared' : ''}</div></span>
    ${now - r.reportedAt <= PRICE_RULES.correctMinutes * 60 ? `<button class="btn sm" data-act="report-price" data-arg="${h(id)}|${h(r.grade)}">Correct</button>` : ''}<button class="btn sm" data-act="price-delete" data-arg="${h(r.id)}" aria-label="Delete this report">✕</button></div>`).join('');
  const google = app.settings.prices?.google && x.exit && app.prices.enabled
    ? `<button class="btn sm" data-act="google-prices" data-arg="${h(x.exit.id)}">Check Google Maps prices</button>` : '';
  const gNote = x.live ? '<p class="attrib">Google prices: <span class="gattr">Google Maps</span>, looked up when you asked. Not stored or shared.</p>' : '';
  const place = app.stationPlace(x);
  const gb = gasBuddyLink(place);
  const check = x.coordinate ? `<div class="section-title">Check the posted price</div>
    <div class="btn-row"><a class="btn sm" data-testid="check-google" href="${h(googleMapsLink(x))}" target="_blank" rel="noopener">Google Maps ↗</a>${gb ? `<a class="btn sm" data-testid="check-gasbuddy" href="${h(gb)}" target="_blank" rel="noopener">GasBuddy ↗</a>` : ''}</div>
    <p class="muted tiny" style="margin:6px 4px 0">Opens ${h(x.brand || x.name)} on Google Maps${gb ? `, or the ${h(place.city ?? place.state)} price page on GasBuddy` : ''}. ExitAtlas does not read or copy prices from those sites; report the one you see.</p>` : '';
  return `<div class="sheet-head">${brandTag(x)}<h2>${h(x.name)}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0">${x.exit ? `${h(exitTitle(x.exit))} · ` : x.kind === 'plaza' ? 'Service plaza · ' : ''}<span data-along="${x.along}">${aheadText(app.snapshot, x.along)}</span></p>
    <div class="section-title">Prices here</div><div class="list">${rows}</div>
    ${check}
    <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="report-price" data-arg="${h(id)}">Report a price</button>${google}${x.exit ? `<button class="btn sm" data-act="exit" data-arg="${h(x.exit.id)}">Exit details</button>` : ''}</div>
    ${gNote}
    ${mine.length ? `<div class="section-title">Your reports here</div><div class="list">${mineRows}</div>` : ''}
    <p class="note">Prices are what drivers reported, with the time and source of each, not verified pump prices. Your reports stay on this device${app.priceBook.sharedOn ? '; ones you share go to other ExitAtlas drivers without your name or location and expire after 7 days' : ''}. Reports older than ${o.maxAgeHours} h are shown but not compared; after 7 days they are dropped. Grades are never mixed.</p>`;
}

const REPORT_PROBLEMS = {
  station: 'Pick a station', grade: 'Pick a grade', 'price out of range': 'Enter the price per gallon, for example 3.099',
  'far from the regional average': 'That price is far from the regional average; check it', payment: 'Pick cash or credit', time: 'The time is off', storage: 'This browser did not let ExitAtlas save it',
};

/// Report a price: a few taps, no photo, no account. Saved on this device; shared only when the driver
/// turned shared reports on and the location check places them at the station.
export function reportSheet(app) {
  const r = app.report;
  if (!r) return '';
  const moving = app.gps === 'device' && (app.lastSpeed ?? 0) > 4.5; // about 10 mph
  const blocked = moving && !r.passenger;
  const shareRow = app.priceBook.sharedOn
    ? `<label class="field"><span style="flex:1">Share with other ExitAtlas drivers<div class="muted tiny">${
      r.near === true ? 'You are at this station (location checked)' : r.checking ? 'Checking your location…' : r.near === false ? h(r.nearNote ?? 'Not at this station: saved on this device only') : 'Needs a location check at the station'}</div></span>
      <input type="checkbox" class="toggle" data-report="share" ${r.share ? 'checked' : ''}></label>` : '';
  const done = r.result
    ? `<div class="banner ${r.result.ok ? '' : 'warn'}" style="margin:10px 0 0">${r.result.ok ? `${r.result.duplicate ? 'Already saved: the same price within 30 minutes.' : 'Saved on this device.'}${r.result.shared ? ` Shared: ${h(r.result.shared)}.` : ''}` : h(r.result.problems.map((p) => REPORT_PROBLEMS[p] ?? p).join('. '))}</div>` : '';
  return `<div class="sheet-head"><h2>Report a price</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <div class="card"><div class="row" style="gap:10px">${brandTag(r)}<div style="flex:1;min-width:0"><b>${h(r.name)}</b><div class="muted tiny">${h(r.place ?? '')}</div></div></div></div>
    <div class="seg report-seg" style="margin-top:10px">${PRICE_GRADES.map((g) => `<button class="${r.grade === g ? 'on' : ''}" data-act="report-grade" data-arg="${g}">${h(GRADE_NAMES[g])}</button>`).join('')}</div>
    <label class="report-price"><span class="sr-only">Price per gallon in dollars</span>$<input type="text" inputmode="decimal" autocomplete="off" data-report="price" placeholder="3.099" value="${h(r.priceText ?? '')}" maxlength="6"></label>
    <div class="seg report-seg">${[['credit', 'Credit'], ['cash', 'Cash']].map(([k, n]) => `<button class="${r.payment === k ? 'on' : ''}" data-act="report-pay" data-arg="${k}">${n}</button>`).join('')}</div>
    <div class="list" style="margin-top:10px"><label class="field"><span style="flex:1">Member or loyalty price</span><input type="checkbox" class="toggle" data-report="member" ${r.member ? 'checked' : ''}></label>
      ${shareRow}
      ${moving ? `<label class="field"><span style="flex:1"><b class="amber-text">You are moving.</b><div class="muted tiny">Report only when parked, or let a passenger do it.</div></span><span class="muted tiny" style="margin-right:6px">I'm a passenger</span><input type="checkbox" class="toggle" data-report="passenger" ${r.passenger ? 'checked' : ''}></label>` : ''}</div>
    <button class="btn primary block" style="margin-top:12px" data-act="report-save" ${blocked ? 'disabled' : ''}>Save price</button>${done}
    <p class="note">Saved on this device${app.priceBook.sharedOn ? ', and shared only when the switch above is on: no account, no name, no location, just the station, grade, price, payment and time' : ''}. You can correct it for 30 minutes. Enter the price on the pump, for example 3.099.</p>`;
}

function priceSettings(app) {
  const pr = app.settings.prices ?? {};
  const toggle = (key, label, note, on) => `<label class="field"><span style="flex:1">${h(label)}${note ? `<div class="muted tiny">${note}</div>` : ''}</span><input type="checkbox" class="toggle" data-price="${key}" ${on ? 'checked' : ''}></label>`;
  const own = app.priceBook.own().length;
  const proxyOffers = Boolean(app.proxy?.community);
  const sharedNote = !app.proxy ? 'Needs the ExitAtlas server below (free plan, off until the owner sets it up)'
    : !proxyOffers ? 'The server does not offer shared reports' : app.priceBook.sharedState === 'unavailable' ? 'On, but the last lookup failed' : 'From other ExitAtlas drivers: no account, reports expire after 7 days';
  const calls = app.priceCalls();
  const google = pr.google
    ? `<div class="card small" style="margin-top:8px"><p style="margin-top:0"><b>Google Maps prices are on.</b> Google bills each lookup to the key's owner ($40 per 1,000 after 1,000 free a month at the Enterprise + Atmosphere tier; check Google's current pricing). ExitAtlas looks up an exit only when you tap "Check Google Maps prices", never by itself, and stops at ${GOOGLE_DAILY_LIMIT} a day on this device. Today: ${app.priceCallsToday()} of ${GOOGLE_DAILY_LIMIT}. This month: ${calls} lookups.</p>
      <label class="row" style="gap:8px"><span style="flex:1">Google Maps API key</span><input type="password" autocomplete="off" data-secret="ea.googleKey" placeholder="Paste key" value="${h(app.secret('ea.googleKey'))}" style="width:150px;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"></label>
      <p class="muted tiny">Restrict the key to this website and to Places API (New), and set the project's daily Nearby Search quota to ${GOOGLE_DAILY_LIMIT} in Google Cloud (the hard cap, 930 a month at most, under the 1,000 free). Prices show with Google Maps attribution, never on the map, and are not saved or shared.</p></div>` : '';
  return `<div class="list">
      ${toggle('compare', 'Compare prices', 'In Road Ahead, the fuel stop and station details', pr.compare !== false)}
      <div class="field"><span style="flex:1">I usually pay</span>${seg('price-pay', [['credit', 'Credit'], ['cash', 'Cash']], pr.payment ?? 'credit', 150)}</div>
      <div class="field"><span style="flex:1">Compare reports up to<div class="muted tiny">Older ones show greyed, never as the cheapest</div></span>${seg('price-age', [['6', '6 h'], ['12', '12 h'], ['24', '24 h']], String(pr.maxAgeHours ?? 24), 170)}</div>
      ${toggle('tellCheaper', 'Tell me when another stop is cheaper', `By $${pr.minSavingsDollars ?? 2} or more on a fill; your favorite brands stay first`, pr.tellCheaper !== false)}
      <div class="field"><span style="flex:1">Only when it saves at least</span>${seg('price-min', [['1', '$1'], ['2', '$2'], ['3', '$3'], ['5', '$5']], String(pr.minSavingsDollars ?? 2), 190)}</div></div>
    <div class="section-title">Price sources</div><div class="list">
      ${toggle('ownReports', 'Your reports', `On this device · ${own} saved`, pr.ownReports !== false)}
      ${toggle('community', 'Shared driver reports', h(sharedNote), pr.community === true)}
      ${toggle('google', 'Google Maps prices', 'Paid, billed to your own key. Off: never called', pr.google === true)}</div>
    ${google}
    <label class="field" style="margin-top:8px;border-radius:14px"><span style="flex:1">ExitAtlas server<div class="muted tiny">${app.proxy ? `Connected: shared reports ${app.proxy.community ? 'on' : 'off'}, Google prices ${app.proxy.prices ? 'on' : 'off'}, chargers ${app.proxy.chargers ? 'on' : 'off'}${app.proxy.disabled.length ? `; switched off: ${h(app.proxy.disabled.join(', '))}` : ''}.` : 'Optional. The owner\'s Cloudflare Worker (infra/worker) on the free plan, with daily limits.'}</div></span><input type="url" autocomplete="off" data-secret="ea.proxyURL" placeholder="https://" value="${h(app.secret('ea.proxyURL'))}" style="width:150px;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"></label>
    <p class="note">No free, licensed source publishes station prices for the US (docs/17), so prices come from reports: yours, and other drivers' when shared reports are on. A station without a current report says "Price unavailable" and never ranks as cheaper. Regional averages are never shown as a station's price.</p>`;
}

function fuelCard(app, s) {
  const fp = app.fuelPlan();
  const ev = Boolean(app.settings.vehicle?.ev);
  const icon = ev ? '⚡' : '⛽';
  if (!fp) {
    return `<button class="card row" style="width:100%;text-align:left;cursor:pointer" data-act="sheet" data-arg="fuel">
      <span style="font-size:26px">${icon}</span><div style="flex:1"><div class="eyebrow">${ev ? 'Charge' : 'Fuel'}</div><div style="font-weight:700">Enter ${ev ? 'range left' : 'miles to empty'}</div>
      <div class="muted small">From your dashboard. ExitAtlas finds the ${ev ? 'charger' : 'exit'} where you will have about ${app.settings.bufferMiles} mi left.</div></div><span class="chev">›</span></button>`;
  }
  const rec = fp.recommended;
  let body;
  if (fp.status === 'destination') {
    body = `<div style="font-weight:700">No stop needed</div><div class="muted small">You reach your destination with about ${miles(fp.destinationSpare)} left.</div>`;
  } else if (fp.chargersLoading && !rec) {
    body = `<div class="muted small">${app.chargers.error ? h(`Chargers unavailable: ${app.chargers.error}`) : 'Finding Superchargers along your route…'}</div>`;
  } else if (fp.status === 'none' && !app.smartStop()?.primary) {
    body = ev ? '<div style="font-weight:700;color:var(--danger)">No charger listed before empty</div><div class="muted small">Within 2.5 miles of the route, on the network chosen in Settings.</div>'
      : '<div style="font-weight:700;color:var(--danger)">No interstate gas listed before empty</div><div class="muted small">Leave the highway for gas. Turnpikes and US routes have no exit data yet.</div>';
  } else if (app.smartStop()?.primary) {
    const sm = app.smartStop(), p = sm.primary;
    body = `<div class="row" style="gap:10px;margin-top:2px">${smartSign(p)}<div style="flex:1;min-width:0">
        <div style="font-weight:700${sm.lowRange ? ';color:var(--amber)' : ''}">${sm.lowRange ? 'Fuel low: nearest' : 'Fuel stop'} · ${h(p.name)} · ${milesValue(p.ahead)} mi${p.brandRank !== null ? ' · ★' : ''}</div>
        ${smartConfidence(p, sm)}${priceLine(app, p, { onMap: true })}
        <div class="muted tiny">${h(smartArrival(app, p))}${p.detourMinutes != null ? ` · ${Math.round(p.detourMinutes)} min detour` : ''}</div></div></div>
        ${sm.notice ? `<div class="muted tiny" style="margin-top:6px">${h(sm.notice)}</div>` : ''}${cheaperNote(app, sm, { onMap: true })}`;
  } else {
    const low = fp.status === 'low';
    const sign = rec.kind === 'charge' ? '<span class="charge-sign">⚡</span>' : exitSign(rec.exit.label, true);
    body = `<div class="row" style="gap:10px;margin-top:2px">${sign}<div style="flex:1;min-width:0">
        <div style="font-weight:700${low ? ';color:var(--amber)' : ''}">${low ? `${ev ? 'Charge' : 'Fuel'} low: nearest` : ev ? 'Charge stop' : 'Fuel stop'} · ${milesValue(rec.ahead)} mi${rec.favorite ? ' · ★' : ''}</div>
        <div class="muted small">${h(stopName(rec))}</div>
        ${rec.exit ? priceInfo(app, rec.exit) : ''}
        <div class="muted tiny">${clock(rec.eta, app.plan.timeZoneIDAt(rec.along), s.t)} · about ${miles(rec.rangeOnArrival)} left when you get there</div></div></div>`;
  }
  return `<button class="card" style="width:100%;text-align:left;cursor:pointer;display:block" data-act="sheet" data-arg="fuel">
    <div class="row"><div class="eyebrow" style="flex:1">${icon} ${ev ? 'Charge' : 'Fuel'}${app.smartStop()?.overnight ? ' · 🌙 Overnight' : ''}</div><div class="num" style="font-weight:800">${milesValue(fp.range)}<span class="muted small"> mi ${ev ? 'range' : 'to empty'}</span></div></div>${body}</button>`;
}

/// Name line for a gas exit or a charger.
function stopName(x) {
  if (x.kind === 'charge') {
    const c = x.charger;
    return `${c.name.replace(/ - Tesla Supercharger$/, '')} · ${c.stalls} stalls${c.network === 'Tesla' && c.openToOthers ? ' · open to other EVs' : ''}`;
  }
  return stationNames(x);
}

/// Google price line for an exit the driver checked (Google Maps prices on): favorite brand first, then the
/// cheapest. Nothing until the driver taps to check.
function priceInfo(app, exit) {
  if (!exit || !app.prices.enabled || app.settings.vehicle?.ev) return '';
  const c = app.prices.peek(exit.id);
  if (!c) return '';
  if (c.error) return '<div class="muted tiny">Google Maps prices unavailable</div>';
  const g = GRADES[app.gradeCode()];
  const priced = pricedForGrade(c.stations, g.key);
  if (!priced.length) return `<div class="muted tiny">No ${g.name.toLowerCase()} prices reported near this exit</div>`;
  const fav = priced.find((x) => matchesFavorite(x.name, app.settings.favoriteBrands));
  const cheap = priced[0];
  const parts = [];
  if (fav) parts.push(`<b>${h(fav.name)} ${priceText(fav.prices[g.key])}</b>`);
  if (!fav || cheap !== fav) parts.push(`${fav ? 'cheapest ' : ''}${h(cheap.name)} <b>${priceText(cheap.prices[g.key])}</b>`);
  return `<div class="price-line">${parts.join(' · ')} <span class="muted tiny">${g.name} · ${ageText((fav ?? cheap).prices[g.key].updated)} · Google Maps</span></div>`;
}

function stationNames(st) {
  const names = [];
  for (const g of st.gas) {
    const n = placeDisplayName(g.place);
    if (!names.includes(n)) names.push(n);
  }
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
}


function paceNote(app, s) {
  let text;
  if (s.recentSpeed) text = `Times follow your driving: ${Math.round(s.recentSpeed * 2.23694)} mph average over the last few minutes, blending into your trip pace for later stretches.`;
  else if (Math.abs(s.paceFactor - 1) > 0.02) text = 'Times use your usual pace from earlier trips until you have driven a few minutes.';
  else text = 'Times use routing road speeds until you have driven a few minutes, then follow your pace.';
  // What the arrival time is based on, always said (docs/16): never presented as traffic aware when it is not.
  const basis = `<span class="pill basis${s.traffic ? ' ok' : ''}" data-basis="${s.arrivalBasis}"><span class="dot"></span>${h(BASIS_LABELS[s.arrivalBasis])}</span>`;
  return `<div style="margin-top:10px">${basis}</div><p class="muted tiny" style="margin:8px 0 0">${text}</p>`;
}

// MARK: Road Ahead

/// The filters: everything, then one kind at a time; then exits by a service they list.
const AHEAD_FILTERS = [['all', 'All'], ['alerts', 'Alerts'], ['fuel', 'Fuel'], ['rest', 'Rest'], ['states', 'States']];
const SERVICE_FILTERS = { food: 2, lodging: 3, ev: 5, dog: 7 };
const FILTER_NAMES = { all: 'All', alerts: 'Alerts', fuel: 'Fuel', rest: 'Rest', states: 'States', food: 'Food', lodging: 'Lodging', ev: 'EV', dog: 'Dog parks' };

/// Distance and time on the right of a timeline row.
function tlDist(meters, seconds) {
  if (meters <= 0) return '<div class="tl-dist"><b>Now</b></div>';
  return `<div class="tl-dist"><b>${milesValue(meters)}</b><span>mi</span>${seconds != null ? `<small>${seconds < 60 ? 'under 1 min' : duration(seconds)}</small>` : ''}</div>`;
}

function tlRow(kind, inner, extra = '') {
  return `<li class="tl-row tl-${kind}${extra}"><span class="tl-dot" aria-hidden="true"></span>${inner}</li>`;
}

/// "I-95 North" for an alert's position, from the route.
function alertRoad(app, a) {
  const hw = app.plan.route.highwayAt(a.start);
  return hw ? `${highwayLabel(hw.ref)} ${DIRECTION_WORDS[hw.direction] ?? ''}`.trim() : null;
}

/// An alert in the timeline: the headline in its tier color, the road, the details, and how old and whose it is.
function alertTimelineRow(app, a, s) {
  const i = a.incident;
  const tier = alertTier(i);
  const road = alertRoad(app, a);
  const len = !a.approximate && a.end - a.start > 0.5 * MILE ? ` for ${miles(a.end - a.start)}` : '';
  const detail = i.category === 'weather' || i.category === 'flooding' ? i.description : (i.lanes ?? (i.description !== ALERT_KINDS[i.category].label ? i.description : ''));
  const flags = [i.verification === 'community' ? 'Reported by drivers, not confirmed' : null, a.directionKnown ? null : 'Direction not reported', a.approximate ? 'Area alert, position approximate' : null].filter(Boolean).join(' · ');
  return tlRow('alert', `<button class="tl-card al tier-${tier}" data-act="alert" data-arg="${h(i.id)}">
    <div class="tl-head"><span class="al-icon" aria-hidden="true">${ALERT_ICONS[i.category] ?? '⚠️'}</span>
      <div class="main"><div class="al-head">${h(alertHeadline(i))}</div>${road || len ? `<div class="t">${h(road ?? 'On your route')}${len}</div>` : ''}
        ${detail ? `<div class="small">${h(detail)}</div>` : ''}${flags ? `<div class="small al-flag">${h(flags)}</div>` : ''}
        <div class="muted tiny">${alertMeta(app, a, s)}</div></div>
      ${tlDist(a.start - s.progress, a.start > s.progress ? s.etaTo(a.start) - s.t : null)}</div></button>`, ` tier-${tier}`);
}

function exitTimelineRow(app, u, s, services, tag) {
  const w = exitWords(app, u.exit, 3);
  const title = w.name ? `<div class="t">${h(w.name)}</div>` : services.length ? `<div class="t svc-title">${w.html || h(w.services)}</div>` : '<div class="t muted">No services listed</div>';
  return tlRow('exit', `<button class="tl-card" data-act="exit" data-arg="${h(u.exit.id)}">
    <div class="tl-head">${exitSign(u.exit.label, true)}<div class="main">${title}${tag}
      ${u.exit.confidence === 'medium' ? '<div class="muted tiny">Direction not verified in source data</div>' : ''}</div>
      ${tlDist(u.distance, u.eta - s.t)}</div>
    ${services.length ? servicePlaques(services, { compact: true, max: 3 }) : ''}</button>`, tag ? ' best' : '');
}

function restTimelineRow(u, s, tag) {
  const r = u.restArea;
  const sub = [r.side === 'both' ? 'Serves both directions' : null, r.road].filter(Boolean).join(' · ');
  return tlRow('rest', `<button class="tl-card" data-act="rest" data-arg="${h(r.id)}">
    <div class="tl-head">${restSign(r.kind, true)}<div class="main"><div class="t">${h(restAreaTitle(r))}</div>${sub ? `<div class="muted small">${h(sub)}</div>` : ''}${tag}</div>
      ${tlDist(u.distance, u.eta - s.t)}</div>${amenityChips(r, { max: 4 })}</button>`, tag ? ' best' : '');
}

function stateTimelineRow(f, s) {
  const d = f.segment.startDistance - s.progress;
  const when = f.entryTime !== null ? `cross ${clock(f.entryTime, f.entryTimeZoneID, s.t)}` : null;
  return tlRow('state', `<div class="tl-card state">
    <div class="tl-head">${badge(f.segment.code, true)}<div class="main"><div class="eyebrow">State line</div>
      <div class="t">Entering ${h(f.segment.displayName)}${f.segment.visit > 1 ? ' (again)' : ''}</div>
      <div class="muted small">${[`${miles(f.totalMeters)} on route`, `${f.exitCount} ${f.exitCount === 1 ? 'exit' : 'exits'}`, when].filter(Boolean).join(' · ')}</div></div>
      ${tlDist(d, null)}</div></div>`);
}

function gapTimelineRow(g, s) {
  const where = g.before ? `After ${h(gasStopTitle(g.before))}` : 'From here';
  const next = g.after ? `, next gas at ${h(gasStopTitle(g.after))}` : g.open ? ', none listed beyond' : ', none before your destination';
  return tlRow('gap', `<div class="tl-card gap"><div class="tl-head"><span class="al-icon" aria-hidden="true">⛽</span>
    <div class="main"><div class="t">No gas for ${miles(g.length)}${g.open ? '+' : ''}</div><div class="muted small">${where}${next}</div></div>
    ${tlDist(Math.max(0, g.from - s.progress), null)}</div></div>`);
}

function stopTimelineRow(st, s) {
  const d = st.distanceAlongRoute - s.progress;
  return tlRow('stop', `<button class="tl-card" data-act="tab" data-arg="trip"><div class="tl-head"><span class="al-icon" aria-hidden="true">📍</span>
    <div class="main"><div class="t">${h(st.waypoint.name)}</div><div class="muted small">Planned stop</div></div>
    ${tlDist(d, s.etaTo(st.distanceAlongRoute) - s.t)}</div></button>`);
}

/// What is known about getting off the highway and back: rest areas and plazas are on it; an exit's round trip
/// is twice the drive from the ramp (an estimate) when it was measured.
function detourText(x) {
  if (!x.exit) return 'On the highway, no exit needed';
  if (x.detourMinutes == null) return 'Detour not estimated';
  return x.detourMinutes < 1 ? 'Estimated detour: under 1 min' : `Estimated detour: about ${Math.round(x.detourMinutes)} min round trip`;
}

/// The best stop ahead (SmartStop): one recommendation with what is known about its hours, its restroom and
/// the detour, the reasons and up to two alternatives behind a disclosure. Shell first by default; overnight,
/// open stations with a listed restroom first.
function bestStopCard(app, s, { restroom = false } = {}) {
  const fuel = restroom ? null : app.smartStop();
  const r = fuel?.primary ? fuel : app.bestStopAhead(Math.max(60, app.exitsUI.window), { restrooms: restroom });
  const p = r?.primary;
  if (!p) return '';
  const title = restroom ? 'Best restroom stop ahead' : fuel?.primary ? (fuel.lowRange ? 'Fuel low: nearest stop' : 'Recommended fuel stop') : 'Best stop ahead';
  const alts = r.alternatives.slice(0, 2);
  const altRow = (x) => `<div class="bs-alt">${smartSign(x)}<div class="main"><div class="t">${h(x.name)}</div><div class="muted tiny">${h(smartWhere(x))} · ${h(detourText(x))}</div>
      ${confLine(x.evaluation.hours.status, x.evaluation.hours.label)}${confLine(x.evaluation.restroom.status, x.evaluation.restroom.label)}${restroom ? '' : priceLine(app, x)}</div>
      <button class="btn sm" data-act="skip-stop" data-arg="${h(x.id)}" aria-label="Not this one: ${h(x.name)}">Skip</button></div>`;
  const priceButtons = !restroom && app.priceOptions() && p.kind !== 'rest'
    ? `${app.exitsUI.filter === 'fuel' ? '' : '<button class="btn sm" data-act="ahead-filter" data-arg="fuel">Compare prices</button>'}<button class="btn sm" data-act="report-price" data-arg="${h(p.id)}">Report a price</button>` : '';
  return `<div class="card best-stop${fuel?.lowRange ? ' low' : ''}">
    <div class="row"><div class="eyebrow success-text" style="flex:1">${r.overnight ? '🌙 ' : ''}${h(title)}</div>${p.brandRank !== null ? '<span class="muted tiny">★ Favorite brand</span>' : ''}</div>
    <div class="row bs-main">${smartSign(p)}<div class="main"><div class="title-md">${h(p.name)}</div><div class="muted small">${h(smartArrival(app, p))}</div></div>${tlDist(p.ahead, null)}</div>
    ${confLine(p.evaluation.hours.status, p.evaluation.hours.label)}${confLine(p.evaluation.restroom.status, p.evaluation.restroom.label)}
    <div class="muted tiny bs-detour">${h(detourText(p))}</div>${restroom ? '' : priceLine(app, p)}
    ${r.notice ? `<div class="small amber-text" style="margin-top:6px">${h(r.notice)}</div>` : ''}${restroom ? '' : cheaperNote(app, r)}
    <details class="bs-why"><summary>Why this stop${alts.length ? ` · ${alts.length} ${alts.length === 1 ? 'alternative' : 'alternatives'}` : ''}</summary>
      <ul class="smart-reasons">${p.reasons.map((x) => `<li>${h(x)}</li>`).join('')}${p.nextOption != null ? `<li>Next option ${miles(p.nextOption)} later</li>` : ''}</ul>
      ${alts.map(altRow).join('')}</details>
    <div class="btn-row">${priceButtons}${p.exit ? `<button class="btn sm" data-act="exit" data-arg="${h(p.exit.id)}">Exit details</button>` : p.restArea ? `<button class="btn sm" data-act="rest" data-arg="${h(p.restArea.id)}">${p.kind === 'rest' ? 'Rest area' : 'Plaza'} details</button>` : ''}
      <button class="btn sm" data-act="skip-stop" data-arg="${h(p.id)}">Not this one</button></div></div>`;
}

/// The States filter: every state ahead, however far, with miles, exits and crossing times; urgent alerts
/// stay in route order among them.
function statesTimeline(app, s, alerts) {
  const events = [];
  if (s.current) {
    const c = s.current;
    const dist = s.next ? `<div class="tl-dist"><b>${milesValue(c.remainingMeters)}</b><span>mi</span><small>to the line</small></div>` : '<div class="tl-dist"><small>Final state</small></div>';
    events.push({ d: s.progress, html: tlRow('state', `<div class="tl-card state now"><div class="tl-head">${badge(c.segment.code, true)}<div class="main"><div class="eyebrow">You are in</div>
      <div class="t">${h(c.segment.displayName)}</div><div class="muted small">${c.exitsRemaining} ${c.exitsRemaining === 1 ? 'exit' : 'exits'} left · ${Math.round(Math.min(1, Math.max(0, c.fractionComplete)) * 100)}% driven</div></div>
      ${dist}</div></div>`) });
  }
  for (const f of s.itinerary.filter((x) => x.status === 'upcoming')) events.push({ d: f.segment.startDistance, html: stateTimelineRow(f, s) });
  for (const a of alerts) events.push({ d: Math.max(a.start, s.progress) + 0.1, html: alertTimelineRow(app, a, s) });
  return events.sort((x, y) => x.d - y.d).map((e) => e.html);
}

export function exitsView(app) {
  const s = app.snapshot;
  if (!s) {
    return `<div class="card empty"><div class="t">No active trip</div>Plan a trip or start discovery mode to see the road ahead.</div>`;
  }
  const ui = app.exitsUI;
  const f = FILTER_NAMES[ui.filter] ? ui.filter : 'all';
  const win = ui.window * MILE;
  const intel = app.roadIntel();
  const alerts = (intel?.alerts ?? []).filter((a) => a.start - s.progress <= win);
  const windowSeg = `<div class="seg">${WINDOWS.map((w) => `<button class="${w === ui.window ? 'on' : ''}" data-act="exits-window" data-arg="${w}">${w} mi</button>`).join('')}</div>`;
  const pill = (k, label) => `<button class="chip${f === k ? ' on' : ''}" data-act="ahead-filter" data-arg="${k}" aria-pressed="${f === k}">${label}</button>`;
  const urgentCount = alerts.filter((a) => alertTier(a.incident) === 'urgent').length;
  const filters = `<div class="chips ahead-filters">${AHEAD_FILTERS.map(([k, n]) => pill(k, k === 'alerts' && alerts.length ? `${n} <span class="count${urgentCount ? ' urgent' : ''}">${alerts.length}</span>` : n)).join('')}
    <span class="chip-sep" aria-hidden="true"></span>${Object.keys(SERVICE_FILTERS).map((k) => pill(k, `${CATEGORY_ICONS[SERVICE_FILTERS[k]]} ${FILTER_NAMES[k]}`)).join('')}</div>`;
  const tools = `<div class="chips wrap"><button class="chip" data-act="sheet" data-arg="search">🔎 Find along route</button><button class="chip" data-act="sheet" data-arg="fuel">⛽ Fuel stop</button><button class="chip" data-act="sheet" data-arg="restroom">🚻 Restroom stop</button></div>`;
  const ev = Boolean(app.settings.vehicle?.ev);
  const service = SERVICE_FILTERS[f] ?? null;

  // Urgent alerts stay in the timeline under every filter; the line above says what the filter hides.
  const showAlert = (a) => f === 'all' || f === 'alerts' || alertTier(a.incident) === 'urgent';
  const hidden = alerts.filter((a) => !showAlert(a)).length;
  const kept = f === 'all' || f === 'alerts' ? 0 : alerts.length - hidden;
  let note = '';
  if (kept || hidden) {
    const parts = [kept ? `${kept} urgent ${kept === 1 ? 'alert stays' : 'alerts stay'} in view` : null, hidden ? `${hidden} other ${hidden === 1 ? 'alert' : 'alerts'} hidden by the ${FILTER_NAMES[f]} filter` : null].filter(Boolean);
    note = `<div class="filter-note${kept ? ' urgent' : ''}">⚠️ ${h(parts.join('. '))}. <button class="linkish" data-act="ahead-filter" data-arg="alerts">Show alerts</button></div>`;
  }

  let rows;
  let top = '';
  // Under Fuel, the price comparison comes after the timeline, so urgent alerts and gas gaps stay at the top.
  let after = '';
  if (f === 'states') {
    rows = statesTimeline(app, s, alerts.filter(showAlert));
    top = '<p class="muted tiny" style="margin:0 4px">Every state ahead on this route, whatever the distance window.</p>';
  } else {
    const fp = app.fuelPlan();
    const sm = fp && fp.status !== 'destination' ? app.smartStop() : null;
    const fuelStopID = fp && fp.status !== 'destination' ? (sm?.primary?.exitId ?? fp.recommended?.exit?.id) : null;
    const pickTag = (p) => `<div class="rec-tag">${f === 'rest' ? '🚻 Best restroom stop' : sm?.primary ? '⛽ Recommended fuel stop' : '★ Best stop ahead'}</div>${confLine(p.evaluation.hours.status, p.evaluation.hours.label)}`;
    const best = f === 'all' || f === 'fuel' || f === 'rest' ? (f === 'rest' ? app.bestStopAhead(Math.max(60, ui.window), { restrooms: true }) : sm?.primary ? sm : app.bestStopAhead(Math.max(60, ui.window))) : null;
    const bp = best?.primary ?? null;
    // Fuel with prices compared: stations get their own sortable list (compareCard); the timeline keeps
    // the gas gaps and alerts.
    const compare = f === 'fuel' && !ev && Boolean(app.priceOptions());
    const events = [];
    const add = (d, o, html) => events.push({ d, o, html });
    if (f === 'all') {
      for (const x of s.itinerary) if (x.status === 'upcoming' && x.segment.startDistance - s.progress <= win) add(x.segment.startDistance, 0, stateTimelineRow(x, s));
    }
    for (const u of compare ? [] : s.upcomingExits) {
      if (u.distance > win) break;
      const services = app.servicesFor(u.exit);
      const has = (c) => services.some((x) => x.place.category === c);
      const isPick = bp?.exitId === u.exit.id;
      const show = f === 'all' || (f === 'fuel' && (has(ev ? 5 : 1) || has(8) || isPick)) || (f === 'rest' && (has(4) || isPick)) || (service !== null && has(service));
      if (!show) continue;
      const tag = isPick ? pickTag(bp) : fuelStopID === u.exit.id ? '<div class="rec-tag">⛽ Planned fuel stop</div>' : '';
      add(u.exit.distanceAlongRoute, 1, exitTimelineRow(app, u, s, services, tag));
    }
    for (const u of compare ? [] : s.upcomingRestAreas) {
      if (u.distance > win) continue;
      const r = u.restArea;
      const show = f === 'all' || f === 'rest' || (f === 'fuel' && (ev ? r.ev.length : r.gas.length) > 0) || (f === 'food' && r.food.length > 0) || (f === 'ev' && r.ev.length > 0);
      if (show) add(r.distanceAlongRoute, 1, restTimelineRow(u, s, bp?.restArea?.id === r.id ? pickTag(bp) : ''));
    }
    if (f === 'all') {
      for (const st of app.plan.route.stops ?? []) {
        const d = st.distanceAlongRoute - s.progress;
        if (d > 0 && d <= win) add(st.distanceAlongRoute, 1, stopTimelineRow(st, s));
      }
    }
    if (f === 'all' || f === 'fuel') for (const g of app.gasGapsAhead(s, win)) add(g.from, 2, gapTimelineRow(g, s));
    for (const a of alerts) if (showAlert(a)) add(Math.max(a.start, s.progress), 0, alertTimelineRow(app, a, s));
    events.sort((x, y) => x.d - y.d || x.o - y.o);
    rows = events.map((e) => e.html);
    if (f === 'all' || f === 'fuel' || f === 'rest') top = bestStopCard(app, s, { restroom: f === 'rest' });
    if (compare) after = compareCard(app, s);
  }
  const status = alertStatus(intel, { open: f === 'alerts' });
  let list;
  if (rows.length) list = `<ol class="tl" aria-label="Road ahead, in route order">${rows.join('')}</ol>`;
  else if (after) list = '';
  else if (f === 'alerts') list = `<div class="card empty"><div class="t">${alertEmptyTitle(intel, ui.window)}</div>${h(alertEmptyText(intel))}</div>`;
  else list = `<div class="card empty"><div class="t">Nothing in the next ${ui.window} miles</div>${f === 'all' ? 'Try a longer window.' : `Nothing matches ${FILTER_NAMES[f]} in this window. Try a longer one.`}</div>`;
  return `<div class="stack ahead">${f === 'states' ? '' : windowSeg}${filters}${note}${status}${top}${list}${after}${tools}${attribution()}</div>`;
}

/// The Alerts filter with nothing in the window: never "all clear" when a source failed or none is connected.
function alertEmptyTitle(intel, window) {
  if (!intel) return 'Road alerts are off';
  const on = Object.values(intel.status).filter((st) => st.state !== 'off');
  if (on.some((st) => st.state === 'unavailable')) return 'Some alert sources are unavailable';
  return `No reports from connected sources in the next ${window} miles`;
}

function alertEmptyText(intel) {
  if (!intel) return 'Turn road alerts on in Settings.';
  const failing = Object.values(intel.status).some((st) => st.state === 'unavailable');
  return failing ? 'This does not mean the road is clear. The sources that answered have nothing on your route here.'
    : 'Only the sources listed below are checked. Not hearing of an event does not mean there is none.';
}

/// One line on what the alert sources say, with each group's state in a details list: "no relevant
/// reports" and "data unavailable" are different things and both are shown as such.
function alertStatus(intel, { open = false } = {}) {
  if (!intel) return '';
  const n = intel.alerts.length;
  const on = Object.entries(intel.status).filter(([, st]) => st.state !== 'off');
  const failing = on.filter(([, st]) => st.state === 'unavailable').length;
  const summary = n ? `${n} road ${n === 1 ? 'alert' : 'alerts'} on your route` : failing ? 'Some road alert sources are unavailable' : 'Road alerts: none from connected sources';
  const rows = on.map(([g, st]) => `<div class="fac"><span class="fn">${h(ALERT_GROUPS[g].label)}</span><span class="fv">${h(st.label)}${st.note ? ` · ${h(st.note)}` : ''}</span></div>`).join('');
  return `<details class="facilities alert-status"${open ? ' open' : ''}><summary>${h(summary)}</summary>${rows}</details>`;
}

/// An alert's detail sheet: everything the source said, where it is, how sure, and whether the Drive screen shows it.
export function alertSheet(app, id) {
  const head = (icon, title, tier) => `<div class="sheet-head"><h2 class="al-sheet-title${tier ? ` tier-${tier}` : ''}">${icon} ${h(title)}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>`;
  const s = app.snapshot;
  const intel = app.roadIntel();
  const a = (intel?.alerts ?? []).find((x) => x.incident.id === id);
  if (!a || !s) return `${head('⚠️', 'Road alert')}<div class="card empty"><div class="t">This alert is no longer current</div>It expired, ended, or is now behind you.</div>`;
  const i = a.incident;
  const tier = alertTier(i);
  const now = Date.now() / 1000;
  const zone = app.plan.timeZoneIDAt(a.start);
  const road = alertRoad(app, a);
  const row = (name, value) => (value ? `<div class="fac"><span class="fn">${h(name)}</span><span class="fv">${value}</span></div>` : '');
  const verification = { official: 'Official source', measured: 'Measured by a traffic provider on your route', community: 'Reported by drivers, not confirmed', mapped: 'Mapped work zone schedule' }[i.verification] ?? 'Not stated';
  const drive = !a.notable ? 'Road Ahead only: lanes open or not stated' : a.serious ? 'Shown from 50 mi ahead, before routine stops' : 'Shown within 10 mi';
  const time = [i.startsAt ? `${i.startsAt > now ? 'Starts' : 'Started'} ${clock(i.startsAt, zone, s.t)}` : null, i.endsAt ? `until ${clock(i.endsAt, zone, s.t)}` : null,
    i.expiresAt ? `report expires ${clock(i.expiresAt, zone, s.t)}` : null].filter(Boolean).join(' · ');
  const police = intel.status.police ? `${ALERT_GROUPS.police.label}: ${intel.status.police.label}.` : '';
  return `${head(ALERT_ICONS[i.category] ?? '⚠️', alertHeadline(i), tier)}
    <div class="card al-detail tier-${tier}">
      <div class="row"><div class="main"><div class="eyebrow tier-text">${tier === 'urgent' ? 'Urgent' : tier === 'caution' ? 'Caution' : 'Information'}${road ? ` · ${h(road)}` : ''}</div>
        <div class="title-md">${h(i.description || ALERT_KINDS[i.category].label)}</div></div></div>
      ${i.lanes ? `<div class="small" style="margin-top:6px">${h(i.lanes)}</div>` : ''}
    </div>
    <div class="list facilities-list">
      ${row('Where', `<span data-along="${a.start}">${aheadText(s, a.start)}</span>${a.approximate ? 'area alert, position approximate' : a.end - a.start > 0.5 * MILE ? `for ${miles(a.end - a.start)}` : 'at one location'}`)}
      ${row('Direction', a.directionKnown ? 'Your direction of travel' : 'Not reported by the source')}
      ${row('Severity', h(i.severity === 'unknown' ? 'Not stated' : i.severity.charAt(0).toUpperCase() + i.severity.slice(1)))}
      ${row('Status', h(verification))}
      ${row('Reported', h(freshnessText(i, now)))}
      ${row('Times', h(time))}
      ${row('Source', a.sources.map((x) => h(x.name)).join(', '))}
      ${row('Drive screen', h(drive))}
    </div>
    <p class="note">ExitAtlas shows what the listed sources report and does not confirm events on the road. Expired and ended reports are removed. ${h(police)}</p>${attribution()}`;
}

export function exitDetail(app, exitId) {
  const plan = app.plan;
  const exit = plan?.exits.find((e) => e.id === exitId);
  if (!exit) return '<div class="empty">Exit not found on this route.</div>';
  const s = app.snapshot;
  const services = app.servicesFor(exit);
  let groups = '';
  for (let cat = 1; cat < CATEGORY_NAMES.length; cat++) {
    const items = services.filter((x) => x.place.category === cat);
    if (!items.length) continue;
    groups += `<div class="section-title"><span class="plaque ${BROWN.has(cat) ? 'brown' : 'blue'} tag"><b>${PLAQUE_WORDS[cat] ?? CATEGORY_NAMES[cat].toUpperCase()}</b></span> ${items.length}</div><div class="list">${items.map((x) => serviceRow(x)).join('')}</div>`;
  }
  const c = exit.coordinate;
  return `<div class="sheet-head">${exitSign(exit.label)}<h2>${h(exit.name || (exit.label ? 'Exit services' : exitTitle(exit)))}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0"><span data-along="${exit.distanceAlongRoute}">${aheadText(s, exit.distanceAlongRoute)}</span>${exit.highways.length ? h(exit.highways.join(' · ')) : ''}</p>
    <div class="btn-row"><a class="btn sm" href="https://maps.apple.com/?ll=${c.lat},${c.lon}&q=${encodeURIComponent(exitTitle(exit))}" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a>${wazeButton(c)}</div>
    ${priceSection(app, exit)}
    ${groups || '<div class="card empty">No services are linked to this exit in the offline data.</div>'}
    <p class="note">Round trips are estimates: twice the drive from the exit ramp to the place (OpenStreetMap drive times from OpenInterstate reachability). The way back can be longer, for example where the entrance ramp is not at the same interchange. Others are straight line estimates and are labeled. Hours, ratings, prices and amenities are not in the offline data.</p>${attribution()}`;
}

export function restAreaDetail(app, id) {
  const r = app.plan?.restAreas.find((x) => x.id === id);
  if (!r) return '<div class="empty">Rest area not found on this route.</div>';
  const s = app.snapshot;
  const c = r.coordinate;
  const badges = amenityBadges(r);
  const am = badges.length
    ? `<div class="list">${badges.map((b) => `<div class="item"><span style="font-size:20px">${AMENITY_ICONS[b.key] ?? ''}</span><div class="main"><div class="t">${b.value ? h(b.label) : `No ${h(b.label.toLowerCase())}`}</div></div></div>`).join('')}</div>`
    : '<div class="card small">No amenities are tagged for this place in OpenStreetMap. That does not mean it has none.</div>';
  const hours = hoursText(r);
  const names = (title, icon, list) => (list.length ? `<div class="section-title">${icon} ${title}</div><div class="card small">${list.map(h).join(', ')}</div>` : '');
  const trucks = r.truckSpaces != null ? `${r.truckSpaces} truck spaces (OpenStreetMap)`
    : r.fhwaTruckSpaces != null ? `${r.fhwaTruckSpaces} truck spaces (FHWA survey, 2019)` : null;
  const osm = r.records.map((x) => `<a href="https://www.openstreetmap.org/${h(x.id)}" target="_blank" rel="noopener">${h(x.id)}</a>`).join(', ');
  return `<div class="sheet-head">${restSign(r.kind)}<h2>${h(restAreaTitle(r))}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0"><span data-along="${r.distanceAlongRoute}">${aheadText(s, r.distanceAlongRoute)}</span>${h(r.road)} · ${r.side === 'both' ? 'In the median or on an undivided road: serves both directions' : 'On your side of the highway'}</p>
    <div class="btn-row"><a class="btn sm" href="https://maps.apple.com/?ll=${c.lat},${c.lon}&q=${encodeURIComponent(restAreaTitle(r))}" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a>${wazeButton(c)}</div>
    <div class="section-title">Amenities listed</div>${am}
    ${hours ? `<div class="section-title">🕐 Hours</div><div class="card small">${h(hours)}</div>` : ''}
    ${names('Gas', '⛽', r.gas)}${names('Food', '🍴', r.food)}${names('EV charging', '⚡', r.ev)}
    ${trucks ? `<div class="section-title">🚛 Truck parking</div><div class="card small">${h(trucks)}</div>` : ''}
    <p class="note">Source: OpenStreetMap ${osm}${r.checked ? `, last checked by a mapper ${h(r.checked)}` : ''}${r.nameSource === 'fhwa' ? '. Name from the FHWA truck parking survey' : ''}. ExitAtlas cannot see closures; check state DOT notices for long trips.</p>${attribution()}`;
}

/// A sheet's distance to a place on the route: "2.4 mi ahead · 3 min · ", "Here now · " within a tenth of a
/// mile, "Passed · " behind. Kept current while the sheet is open (main.js renderNow).
export function aheadText(s, along) {
  if (!s) return '';
  const ahead = along - s.progress;
  if (ahead < -0.1 * MILE) return 'Passed · ';
  if (ahead < 0.1 * MILE) return 'Here now · ';
  const secs = s.etaTo(along) - s.t;
  return `${miles(ahead)} ahead · ${secs < 60 ? 'under 1 min' : duration(secs)} · `;
}

/// Reported prices at an exit's gas stations for the driver's grade, and Google Maps prices only when the
/// driver turned them on and taps to check (paid).
function priceSection(app, exit) {
  if (app.settings.vehicle?.ev) return '';
  const o = app.priceOptions();
  const gas = app.servicesFor(exit).filter((x) => x.place.category === 1);
  let html = '';
  if (o && gas.length) {
    const ctx = app.stopContext();
    const rows = gas.map((x) => {
      const id = x.place.id, brand = app.data?.stations?.get(id)?.b ?? x.place.brand;
      const sp = stopPrice(ctx, id, liveFor(app.prices, exit, x.place, brand));
      return `<button class="item pr-row" data-act="station" data-arg="${h(id)}">${brandTag({ name: placeDisplayName(x.place), brand })}<div class="main"><div class="t">${h(placeDisplayName(x.place))}</div>
        <div class="muted tiny">${sp ? h(priceMeta(sp)) : 'No current report'}</div></div>${priceTag(sp, o.grade)}</button>`;
    }).join('');
    html += `<div class="section-title">⛽ Gas prices here</div><div class="list">${rows}</div>
      <p class="muted tiny" style="margin:6px 4px 0">Reports with their time and source, not verified pump prices. Tap a station to report the price you see.</p>`;
  }
  if (app.settings.prices?.google) html += googleSection(app, exit);
  return html;
}

function googleSection(app, exit) {
  if (!app.prices.enabled) return '<p class="muted tiny">Google Maps prices are on, but no Google key or server is set (Settings, Gas prices).</p>';
  const c = app.prices.peek(exit.id);
  if (!c) return `<div class="btn-row" style="margin-top:8px"><button class="btn sm" data-act="google-prices" data-arg="${h(exit.id)}">${app.prices.cache.get(exit.id)?.pending ? 'Checking Google Maps…' : 'Check Google Maps prices (paid)'}</button></div>`;
  if (c.error) return `<div class="section-title">Google Maps prices</div><div class="card small">Google Maps prices unavailable: ${h(c.error)}</div>`;
  const g = GRADES[app.gradeCode()];
  const rows = [...c.stations].sort((a, b) => (a.prices[g.key]?.value ?? 99) - (b.prices[g.key]?.value ?? 99)).map((st) => {
    const p = st.prices[g.key];
    const others = Object.entries(GRADES).filter(([, x]) => x.key !== g.key && st.prices[x.key]).map(([, x]) => `${x.name} ${priceText(st.prices[x.key])}`).join(' · ');
    const fav = matchesFavorite(st.name, app.settings.favoriteBrands);
    return `<div class="item"><div class="main"><div class="t">${fav ? '★ ' : ''}${h(st.name)}</div><div class="muted tiny">${p ? `${g.name} · ${ageText(p.updated)}` : 'No price listed'}${others ? ` · ${others}` : ''}</div></div>
      <div class="side"><div class="big">${p ? priceText(p) : '—'}</div></div></div>`;
  });
  return `<div class="section-title">Google Maps prices</div>${rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="card empty">No gas stations found by Google near this exit.</div>'}
    <p class="attrib">Prices: <span class="gattr">Google Maps</span>, within 1 mile of the exit, looked up when you asked. Not stored or shared.</p>`;
}

function serviceRow(x) {
  const p = x.place;
  const detour = x.detourBasis === 'routed'
    ? `About ${miles(x.detourMeters)}${x.detourSeconds !== null ? `, ${duration(x.detourSeconds)}` : ''} round trip`
    : `Roughly ${miles(x.detourMeters)} round trip (straight line)`;
  return `<div class="item"><div class="main"><div class="t">${h(placeDisplayName(p))}</div><div class="muted small">${detour}</div></div>
    <a class="btn sm" href="https://maps.apple.com/?daddr=${p.coordinate.lat},${p.coordinate.lon}&dirflg=d" target="_blank" rel="noopener" aria-label="Directions">Go</a></div>`;
}

// MARK: Trip

export function tripView(app) {
  if (app.plan && app.snapshot) return tripOverview(app, app.plan, app.snapshot);
  return plannerView(app);
}

function tripOverview(app, plan, s) {
  const discovery = app.mode === 'discovery';
  const map = renderRouteMap(app.routeMap(plan), plan.route.polyline.coordinateAt(s.progress));
  const summary = `<div class="metrics">${metric('Driven', milesValue(s.drivenTotal), { unit: 'mi', size: 'md' })}
    ${metric(discovery ? 'Ahead' : 'Remaining', milesValue(s.remaining), { unit: 'mi', size: 'md' })}
    ${discovery ? '' : metric('Arrive', clock(s.eta, null, s.t), { caption: duration(s.timeRemaining), size: 'sm' })}</div>
    ${discovery ? '' : `<div class="muted small" style="margin-top:10px">Total trip ${miles(s.drivenTotal + s.remaining)} · ${plural(new Set(plan.states.segments.filter((x) => x.code).map((x) => x.code)).size, 'state')} on the route${plan.restAreas.length ? ` · ${plural(plan.restAreasBetween(s.progress, plan.route.length).length, 'rest stop')} ahead on the highway` : ''}</div>`}`;
  const completed = s.drivenStints.slice(0, -1);
  let html = `<div class="stack"><div class="card" style="padding:8px">${map}</div><div class="card">${summary}${discovery ? '' : paceNote(app, s)}</div>`;
  if (completed.length) {
    html += `<div><div class="section-title">Completed</div><div class="list">${completed.map((st) => `<div class="item">${badge(st.code)}<div class="main">${h(st.name)}</div><div class="side num muted">${miles(st.meters)}</div></div>`).join('')}</div></div>`;
  }
  const cur = s.current;
  if (cur) {
    html += `<div><div class="section-title">Now</div><div class="card"><div class="row">${badge(cur.segment.code, true)}<div style="flex:1;font-weight:700">${h(cur.segment.displayName)}</div><div class="num" style="font-weight:700">${miles(cur.remainingMeters)} left</div></div>
      <div style="margin:10px 0 6px">${progress(cur.fractionComplete, true)}</div>
      <div class="row muted tiny"><span>${miles(cur.drivenMeters)} of ${miles(cur.totalMeters)}</span><span class="spacer"></span><span>${cur.exitsRemaining} of ${cur.exitCount} exits left</span></div>
      ${cur.exitTime !== null && s.next ? `<div class="muted tiny" style="margin-top:4px">Leave ${h(cur.segment.code ?? 'state')} at ${clock(cur.exitTime, cur.exitTimeZoneID, s.t)}</div>` : ''}</div></div>`;
  }
  const upcoming = s.itinerary.filter((f) => f.status === 'upcoming');
  if (upcoming.length) {
    html += `<div><div class="section-title">Ahead</div><div class="list">${upcoming.map((f) => `<div class="item">${badge(f.segment.code)}<div class="main">
      <div class="t">${h(f.segment.displayName)}${f.segment.visit > 1 ? ' (again)' : ''}</div>
      <div class="muted small">${f.entryTime !== null ? `Enter ${clock(f.entryTime, f.entryTimeZoneID, s.t)}, in ${duration(f.entryTime - s.t)}` : ''}${f.plannedDuration !== null ? ` · ${duration(f.plannedDuration)} in state` : ''} · ${f.exitCount} exits</div>
      ${f.segment.isBrief ? '<div class="amber-text tiny">Brief crossing</div>' : ''}</div>
      <div class="side num" style="font-weight:800">${miles(f.totalMeters)}</div></div>`).join('')}</div></div>`;
  }
  html += discoverSection(plan, s);
  // Turn by turn in Waze to the next stop or the destination (one destination per Waze link).
  const next = app.nextWaypoint();
  const waze = next ? wazeLink(next.coordinate, 'exitatlas-web') : null;
  html += `<div class="stack">${waze ? `<a class="btn block" href="${h(waze)}" target="_blank" rel="noopener">Drive to ${h(next.name)} in Waze</a>` : ''}
    ${app.mode === 'trip' ? '<button class="btn block" data-act="sheet" data-arg="stop">🛏️ Plan a stop ahead</button>' : ''}
    <button class="btn block" data-act="share-card">🖼️ Share trip card</button>
    <button class="btn block" data-act="share">Share itinerary</button>
    <button class="btn danger block" data-act="end">End ${discovery ? 'discovery mode' : 'trip'}</button></div>${attribution()}</div>`;
  return html;
}

/// Up to five notable places in the next 200 miles, the best scored first picked, shown in route order.
function discoverSection(plan, s) {
  const ahead = plan.discover.filter((x) => x.distanceAlongRoute > s.progress && x.distanceAlongRoute - s.progress <= 200 * MILE);
  if (!ahead.length) return '';
  const top = [...ahead].sort((a, b) => b.item.score - a.item.score).slice(0, 5).sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
  return `<div><div class="section-title">Discover ahead</div><div class="list">${top.map((x) => discoverRow(x, s)).join('')}</div>
    <p class="note">Notable places from Wikidata within 5 to 10 miles of the highway. Distances off the highway are straight lines; the drive is longer. Check hours before you go.</p></div>`;
}

function discoverRow(x, s) {
  const c = DISCOVER_CATEGORIES[x.item.cat];
  const where = [c?.title, x.exit ? `near ${exitTitle(x.exit)}` : null, `${miles(x.offMeters)} off the highway`].filter(Boolean).join(' · ');
  return `<button class="item" data-act="discover" data-arg="${h(x.item.id)}"><span class="disc-icon" aria-hidden="true">${c?.icon ?? '📍'}</span>
    <div class="main"><div class="t">${h(x.item.name)}</div><div class="muted small">${h(where)}</div></div>
    <div class="side"><div class="big">${milesValue(x.distanceAlongRoute - s.progress)}</div><div class="muted tiny">${duration(s.etaTo(x.distanceAlongRoute) - s.t)}</div></div></button>`;
}

export function discoverSheet(app, id) {
  const x = app.plan?.discover.find((d) => d.item.id === id);
  if (!x) return '<div class="empty">Place not found on this route.</div>';
  const s = app.snapshot, it = x.item, c = DISCOVER_CATEGORIES[it.cat];
  const ahead = s ? x.distanceAlongRoute - s.progress : null;
  return `<div class="sheet-head"><span class="disc-icon lg" aria-hidden="true">${c?.icon ?? '📍'}</span><h2>${h(it.name)}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0">${h(c?.title ?? '')}${ahead !== null && ahead > 0 ? ` · ${miles(ahead)} ahead on the route` : ''}${x.exit ? ` · near ${h(exitTitle(x.exit))}` : ''} · ${miles(x.offMeters)} off the highway (straight line)</p>
    ${it.desc ? `<div class="card small">${h(it.desc[0].toUpperCase() + it.desc.slice(1))}</div>` : ''}
    <div class="btn-row" style="margin-top:12px"><a class="btn sm" href="https://maps.apple.com/?daddr=${it.lat},${it.lon}&dirflg=d" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lon}" target="_blank" rel="noopener">Google Maps</a>${wazeButton(it)}
      ${it.wiki ? `<a class="btn sm" href="${h(it.wiki)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}</div>
    ${app.canAddStop() ? `<button class="btn primary block" style="margin-top:12px" data-act="add-place-stop" data-arg="${h(it.id)}">Add to trip</button>` : '<p class="muted tiny">Adding it to the trip reroutes through it, which needs live GPS (not the demo).</p>'}
    <p class="note">From Wikidata (${h(it.id)}, CC0): linked from ${it.sitelinks} Wikimedia sites (Wikipedia editions and sister projects). Hours, fees and closures are not in this data.</p>`;
}

/// Your travels: miles and trips per state from real GPS trips, and the totals. Statistics only.
function travelsSection(app) {
  const t = travelStats(app.history);
  if (!t.tripCount) {
    return '<div class="card small muted">Finished trips with live GPS appear here: miles driven in each state and in total. Simulated drives and discovery mode are not counted.</div>';
  }
  return `<div class="card"><div class="metrics two">${metric('Miles tracked', Math.round(t.totalMeters / MILE).toLocaleString('en-US'), { caption: `${t.tripCount} ${t.tripCount === 1 ? 'trip' : 'trips'}`, size: 'md' })}${metric('States driven', String(t.states.length), { size: 'md' })}</div>
    <div class="list" style="margin-top:10px">${t.states.map((x) => `<div class="item">${badge(x.code)}<div class="main"><div class="t">${h(x.name)}</div><div class="muted tiny">${x.trips} ${x.trips === 1 ? 'trip' : 'trips'}</div></div><div class="side num">${miles(x.meters)}</div></div>`).join('')}</div>
    <p class="note" style="margin:10px 0 0">Real GPS trips only, saved on this device. Simulated drives and discovery mode are not counted.</p></div>`;
}

function plannerView(app) {
  const p = app.planner;
  const wp = (kind, w, idx) => {
    const dot = kind === 'to' ? 'end' : kind === 'stop' ? 'stop' : '';
    const name = w ? h(w.name) : kind === 'from' ? 'Current location' : kind === 'to' ? 'Choose destination' : 'Choose stop';
    const placeholder = !w && kind !== 'from';
    return `<div class="wp" data-act="pick" data-arg="${kind}${idx !== undefined ? `:${idx}` : ''}"><span class="dot ${dot}"></span><span class="name${placeholder ? ' placeholder' : ''}">${name}</span>
      ${kind === 'stop' ? `<button class="x" data-act="remove-stop" data-arg="${idx}" aria-label="Remove stop">✕</button>` : kind === 'from' && w ? '<button class="x" data-act="reset-from" aria-label="Use current location">✕</button>' : '<span class="chev">›</span>'}</div>`;
  };
  let html = `<div class="stack"><div class="list">${wp('from', p.from)}${p.stops.map((st, i) => wp('stop', st, i)).join('')}${wp('to', p.to)}</div>
    <div class="btn-row"><button class="btn sm" data-act="add-stop">＋ Add stop</button>${p.to ? '<button class="btn sm" data-act="save-plan">Save trip</button>' : ''}<button class="btn sm primary" data-act="find-routes" ${p.to && !p.busy ? '' : 'disabled'}>${p.busy ? 'Finding routes…' : 'Find routes'}</button></div>`;
  if (p.error) html += `<p class="amber-text small">${h(p.error)}</p>`;
  if (p.results.length) {
    html += `<div class="section-title">Routes</div>${p.results.map((r, i) => routeCard(r, i, p.results.length, app)).join('')}
      <p class="note">Travel times come from the free OSRM routing server and do not include live traffic. ExitAtlas learns your actual pace as you drive and updates every arrival time. Avoid tolls is not available on this server.</p>`;
  }
  if (!p.results.length && !p.busy) html += quickPlaces(app);
  html += `<div class="card"><div class="eyebrow">Simulated demo</div><div style="font-weight:700;margin:2px 0 8px">Miami to Manhattan, 1,281 mi, 10 states</div>
    <button class="btn block" data-act="demo">Run the demo</button></div>`;
  const hist = app.history;
  if (hist.length) {
    html += `<div class="section-title">Past trips</div><div class="list">${hist.slice(0, 8).map((t) => `<div class="item"><div class="main"><div class="t">${h(t.title)}</div>
      <div class="muted tiny">${new Date(t.endedAt * 1000).toLocaleDateString('en-US')} · ${t.states.map((x) => x.code ?? '—').join(' · ')}</div></div><div class="side num muted">${miles(t.totalMeters)}</div></div>`).join('')}</div>`;
  }
  return `${html}${attribution()}</div>`;
}

function plural(n, word) {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function routeCard(r, i, count, app) {
  const plan = r.plan;
  const totals = plan.states.totals;
  const v = app.vehicleProfile();
  const perTank = v?.tankGallons ? v.tankGallons * v.mpg * MILE : null;
  const fuelLine = perTank ? `<div class="muted tiny" style="margin-top:6px">⛽ About ${(plan.route.length / perTank).toFixed(1)} tanks for your ${h(`${v.year} ${v.make} ${v.model}`)} (${Math.round(perTank / MILE)} mi per tank at ${v.mpg} mpg)</div>` : '';
  return `<div class="card"><div class="row"><div style="flex:1"><div class="title-md num">${duration(plan.route.timeProfile.totalSeconds)}</div>
      <div class="muted small">${miles(plan.route.length)} · ${plural(totals.length, 'state')} · ${plural(plan.states.segments.length - 1, 'state line')} · ${plural(plan.exits.length, 'exit')}</div></div>
      ${i === 0 && count > 1 ? '<span class="pill ok">Fastest</span>' : ''}</div>
    <div class="strip">${totals.map((t) => `<span class="s">${badge(t.code, false, true)} ${miles(t.length)}</span>`).join('')}</div>${fuelLine}
    <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-act="start-route" data-arg="${i}">Start</button><button class="btn" data-act="simulate-route" data-arg="${i}">Simulate</button></div></div>`;
}

// MARK: Settings

export function settingsView(app) {
  const st = app.settings;
  const toggle = (key, label, note = '') => `<label class="field"><span style="flex:1">${h(label)}${note ? `<div class="muted tiny">${h(note)}</div>` : ''}</span><input type="checkbox" class="toggle" data-set="${key}" ${st[key] ? 'checked' : ''}></label>`;
  const meta = (m) => (m ? h(`${m.source ?? ''}${m.generated_at ? `, built ${m.generated_at.slice(0, 10)}` : ''}`) : 'not loaded');
  return `<div class="stack">
    <div><div class="section-title">Voice</div><div class="list">
      ${toggle('voice', 'Spoken announcements', app.announcer.supported ? '' : 'Not supported in this browser')}
      ${toggle('announceStateLines', 'State lines', '5 miles before, and on entry')}
      ${toggle('announceExits', 'Exits', '1 mile before each exit')}
      ${toggle('announceRestAreas', 'Rest areas and service plazas', 'About 2 miles before, with listed amenities')}
      ${toggle('announceGasGaps', 'Last gas before a long stretch', 'About 5 miles before the last exit with gas')}
      ${toggle('announceTimeZones', 'Time zone changes', 'When the clock changes on your route')}
      <div class="field"><span style="flex:1">Test the voice</span><button class="btn sm" data-act="test-voice">Speak</button></div></div></div>
    <div><div class="section-title">Screen</div><div class="list">
      ${toggle('keepAwake', 'Keep screen awake while driving', app.wake.supported ? (app.wake.active ? 'Active now' : 'Turns on when a drive starts') : 'Not supported here. Set Auto Lock to Never for the drive.')}
      <div class="field"><span style="flex:1">Appearance</span><div class="seg" style="width:200px">${['auto', 'light', 'dark'].map((t) => `<button class="${st.theme === t ? 'on' : ''}" data-act="theme" data-arg="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
      <div class="field"><span style="flex:1">Drive screen<div class="muted tiny">Map first, or the compact dashboard. Also on the Drive screen.</div></span><div class="seg" style="width:200px">${[['map', 'Map'], ['focus', 'Focus']].map(([k, n]) => `<button class="${(st.drivePresentation === 'focus' ? 'focus' : 'map') === k ? 'on' : ''}" data-act="drive-view" data-arg="${k}">${n}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Speedometer</div><div class="list">
      <div class="field"><span style="flex:1">Turn red when over the limit by<div class="muted tiny">Amber from 1 mph over. Limits are OpenStreetMap posted speeds via Valhalla; not every road has one.</div></span>
        <div class="seg" style="width:190px">${[0, 5, 10, 15].map((v) => `<button class="${st.speedAlertOver === v ? 'on' : ''}" data-act="speed-alert" data-arg="${v}">${v}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Vehicle and fuel</div>${vehicleSettings(app)}</div>
    <div><div class="section-title">Stretches without gas</div><div class="list">
      <div class="field"><span style="flex:1">Warn when the next gas is more than<div class="muted tiny">Counts exits with a gas station listed and service plazas with gas. Shown in Exits and on the Drive screen.</div></span>
        <div class="seg" style="width:190px">${[25, 40, 60, 80].map((v) => `<button class="${st.gasGapMiles === v ? 'on' : ''}" data-act="gas-gap" data-arg="${v}">${v}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Favorite gas</div>${fuelPreferences(app)}</div>
    <div><div class="section-title">Overnight driving</div>${overnightSettings(app)}</div>
    <div><div class="section-title">Traffic</div>${trafficSettings()}</div>
    <div><div class="section-title">Road alerts</div>${alertSettings(app)}</div>
    <div><div class="section-title">Gas prices</div>${priceSettings(app)}</div>
    <div><div class="section-title">Electric vehicles</div><div class="list">
      <div class="field"><span style="flex:1">Charging stops at</span><div class="seg" style="width:220px">${[['Tesla', 'Superchargers'], ['all', 'All DC fast']].map(([k, n]) => `<button class="${st.chargerNetwork === k ? 'on' : ''}" data-act="charger-network" data-arg="${k}">${n}</button>`).join('')}</div></div>
      <label class="field"><span style="flex:1">NREL key for charger lookups<div class="muted tiny">Optional. The built in demo key allows 10 lookups an hour; a free key from <a href="https://developer.nlr.gov/signup/" target="_blank" rel="noopener">developer.nlr.gov</a> allows far more.</div></span>
        <input type="password" autocomplete="off" data-secret="ea.nrelKey" placeholder="DEMO_KEY" value="${h(app.secret('ea.nrelKey'))}" style="width:130px;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"></label></div></div>
    <div><div class="section-title">Places</div><div class="list">
      <div class="field"><span style="flex:1">🏠 Home<div class="muted tiny">${app.places.home ? h(app.places.home.name) : 'Not set. Tap 🏠 next to any place when you search.'}</div></span>${app.places.home ? '<button class="btn sm" data-act="clear-home">Clear</button>' : ''}</div>
      ${app.places.saved.map((p, i) => `<div class="field"><span style="flex:1">★ ${h(p.name)}</span><button class="btn sm" data-act="remove-saved" data-arg="${i}" aria-label="Remove ${h(p.name)}">✕</button></div>`).join('')}
      ${app.places.recent.slice(0, 5).filter((r) => !app.places.saved.some((p) => p.name === r.name)).map((r) => `<div class="field"><span style="flex:1" class="muted">${h(r.name)}</span><button class="btn sm" data-act="save-place" data-arg="${app.places.recent.indexOf(r)}">Save</button></div>`).join('')}
      ${app.places.plans.map((t, i) => `<div class="field"><span style="flex:1">🗺️ ${h(t.name)}<div class="muted tiny">${h(t.from?.name ?? 'Current location')} to ${h(t.to.name)}</div></span><button class="btn sm" data-act="remove-plan" data-arg="${i}" aria-label="Remove ${h(t.name)}">✕</button></div>`).join('')}
      <div class="field"><span style="flex:1">Recent places<div class="muted tiny">${app.places.recent.length} kept on this device; save the ones you return to</div></span>${app.places.recent.length ? '<button class="btn sm" data-act="clear-recent">Clear</button>' : ''}</div></div></div>
    <div><div class="section-title">Favorite services</div>${favoritesSettings(app)}</div>
    <div><div class="section-title">Arrival times</div><div class="card small">${paceSettings(app)}</div></div>
    <div><div class="section-title">Your travels</div>${travelsSection(app)}</div>
    <div><div class="section-title">Your profile</div>${profileSection(app)}</div>
    <div><div class="section-title">Data and licenses</div><div class="card small">
      ${dataVersionLine(app.dataStatus)}
      <p><b>State lines:</b> ${meta(app.data?.states.metadata)}</p>
      <p><b>Time zones:</b> ${meta(app.data?.zoneIndex.metadata)}</p>
      <p><b>Exits and places:</b> ${meta(app.data?.interstates.metadata)}. © OpenStreetMap contributors, ODbL 1.0.</p>
      <p><b>Rest areas and service plazas:</b> ${app.data?.restAreas ? h(`OpenStreetMap, tags checked ${app.data.restAreas.metadata.tags_fetched}; truck parking from the FHWA survey (2019, public domain)`) : 'not loaded'}. Amenities show only what mappers have tagged.</p>
      <p><b>Gas station hours and restrooms:</b> ${app.data?.stations ? h(stationCredit(app.data.stations.metadata)) : 'not loaded'}. Shown as reported, not verified; when OpenStreetMap and a brand listing disagree at your arrival time, the hours show as unavailable. When you check Google Maps prices, Google's business hours and restroom field for those stations.</p>
      <p><b>Discover ahead:</b> ${app.data?.discover ? h(`${app.data.discover.metadata.count.toLocaleString('en-US')} places from Wikidata (CC0), fetched ${app.data.discover.metadata.fetched}`) : 'not loaded'}. Hours, fees and closures are not included.</p>
      <p><b>Routing:</b> OSRM demo server (router.project-osrm.org) on OpenStreetMap data. Light personal use only.</p>
      <p><b>Place search:</b> Nominatim (nominatim.openstreetmap.org), searched only when you tap Search.</p>
      <p><b>Gas prices:</b> reports by you (on this device) and, when turned on, by other ExitAtlas drivers through the owner's server; each shows its time and source. Google Maps prices only when you turn them on and tap to check (paid, your key). No regional average is shown as a station's price.</p>
      <p><b>EV chargers:</b> U.S. DOE Alternative Fuels Data Center (developer.nlr.gov).</p>
      <p><b>Speed limits:</b> OpenStreetMap via the FOSSGIS Valhalla server.</p>
      <p style="margin-bottom:0" class="muted">Exit and services data are from July 2026 OpenStreetMap and can be out of date.</p></div></div>
    <button class="btn danger block" data-act="clear-data">Erase profile and trip history</button>
    <p class="note">ExitAtlas web ${h(app.version)}. Not affiliated with iExit or Nexit.</p></div>`;
}

// MARK: Sheets

export function placeSearchSheet(app) {
  const ps = app.placeSearch;
  const { home, recent, saved: starred } = app.places;
  const label = ps.field === 'from' ? 'Start' : ps.field === 'to' ? 'Destination' : 'Stop';
  const homeBtn = (src) => `<button class="btn sm" data-act="set-home" data-arg="${src}" aria-label="Set as Home">🏠</button>`;
  const saved = [];
  if (ps.field === 'from') saved.push('<button class="item" data-act="use-current"><span style="font-size:20px">📍</span><div class="main"><div class="t">Current location</div></div></button>');
  if (home) saved.push(`<button class="item" data-act="choose-place" data-arg="home"><span style="font-size:20px">🏠</span><div class="main"><div class="t">Home</div><div class="muted tiny">${h(home.name)}</div></div></button>`);
  starred.slice(0, 8).forEach((p, i) => saved.push(`<button class="item" data-act="choose-place" data-arg="saved:${i}"><span style="font-size:20px">★</span><div class="main"><div class="t">${h(p.name)}</div></div></button>`));
  recent.slice(0, 8).filter((r) => !starred.some((p) => p.name === r.name)).forEach((r) => { const i = recent.indexOf(r); saved.push(`<div class="item"><button class="main" style="background:none;border:0;text-align:left;padding:0;cursor:pointer" data-act="choose-place" data-arg="recent:${i}"><div class="t">🕘 ${h(r.name)}</div></button>${home && home.name === r.name ? '' : homeBtn(`recent:${i}`)}</div>`); });
  return `<div class="sheet-head"><h2>${label}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <form class="row" data-form="place-search"><input type="search" name="q" placeholder="City, address or place" value="${h(ps.query)}" autocomplete="off" style="flex:1;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card)" enterkeyhint="search">
      <button class="btn primary sm" type="submit" ${ps.busy ? 'disabled' : ''}>${ps.busy ? '…' : 'Search'}</button></form>
    ${ps.error ? `<p class="amber-text small">${h(ps.error)}</p>` : ''}
    ${ps.results.length ? `<div class="list" style="margin-top:12px">${ps.results.map((r, i) => `<div class="item"><button class="main" style="background:none;border:0;text-align:left;padding:0;cursor:pointer" data-act="choose-place" data-arg="result:${i}"><div class="t">${h(r.name)}</div><div class="muted tiny">${h(r.detail)}</div></button>${homeBtn(`result:${i}`)}</div>`).join('')}</div>` : ''}
    ${saved.length && !ps.results.length ? `<div class="list" style="margin-top:12px">${saved.join('')}</div><p class="muted tiny">Tap 🏠 to make a place your Home.</p>` : ''}
    <p class="attrib">Search by Nominatim, © OpenStreetMap contributors.</p>`;
}

export function alongRouteSheet(app) {
  const q = app.alongRoute;
  const cats = FILTER_CATEGORIES.map((c) => `<button class="chip${q.categories.includes(c) ? ' on' : ''}" data-act="ar-cat" data-arg="${c}">${CATEGORY_ICONS[c]} ${CATEGORY_NAMES[c]}</button>`).join('');
  let results = '';
  if (q.results) {
    results = q.results.length
      ? `<div class="list" style="margin-top:12px">${q.results.map((m) => `<button class="item" data-act="exit" data-arg="${h(m.exit.id)}">${exitSign(m.exit.label, true)}<div class="main">
          <div class="t">${h(m.matchesPerRequirement.map((hits) => placeDisplayName(hits[0].place)).join(' + '))}</div>
          <div class="muted tiny">Detour about ${miles(m.combinedDetourMeters)} total</div></div><div class="side"><div class="big">${milesValue(m.exit.distanceAlongRoute - app.snapshot.progress)}</div><div class="muted tiny">mi</div></div></button>`).join('')}</div>`
      : '<div class="card empty" style="margin-top:12px"><div class="t">No exit has all of that</div>Try fewer requirements or a longer window.</div>';
  }
  return `<div class="sheet-head"><h2>Find along route</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <div class="section-title">Must all be at the same exit</div><div class="chips" style="flex-wrap:wrap">${cats}</div>
    <form data-form="along-route"><div class="section-title">Brand or name (optional)</div>
      <input type="search" name="brand" value="${h(q.brand)}" placeholder="Starbucks, Cracker Barrel, Buc-ee's" style="width:100%;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card)">
      <div class="section-title">Within the next</div><div class="seg">${[25, 50, 100, 200, 400].map((w) => `<button type="button" class="${q.window === w ? 'on' : ''}" data-act="ar-window" data-arg="${w}">${w} mi</button>`).join('')}</div>
      <button class="btn primary block" type="submit" style="margin-top:14px">Search</button></form>${results}`;
}

export const TOP_BRANDS = ['Shell', 'Chevron', 'BP', 'Exxon', 'Mobil', 'Sunoco', 'Speedway', 'Valero', 'Marathon', "Love's",
  'Circle K', 'Citgo', 'QuikTrip', 'Pilot', 'Flying J', '76', 'Phillips 66', 'Arco', '7-Eleven', 'Conoco', 'Sinclair', 'Sheetz',
  'Wawa', 'RaceTrac', "Buc-ee's", 'Costco', "Sam's Club", 'Murphy USA', "Casey's", 'Kwik Trip', 'Texaco', 'Gulf', 'Maverik',
  'Kroger', 'Holiday', 'TA', 'Royal Farms', 'GetGo', 'Thorntons', 'Cenex'];

export function fuelSheet(app) {
  const st = app.settings;
  const ui = app.fuelUI;
  const v = app.vehicleProfile();
  const ev = Boolean(v?.ev);
  const full = v ? (ev ? v.rangeMiles : v.tankGallons ? v.tankGallons * v.mpg : null) : null;
  const fp = app.fuelPlan();
  const range = app.rangeNow();
  const vehicleLine = v
    ? `<div class="row"><div style="flex:1;min-width:0"><div style="font-weight:700">${h(`${v.year} ${v.make} ${v.model}`)}</div>
        <div class="muted tiny">${h(v.label)}</div>
        <div class="muted small">${ev ? `About ${Math.round(full)} mi per charge ${basisName(st, true)}` : `${v.mpg} mpg ${basisName(st)}${v.tankGallons ? ` · ${v.tankGallons} gal · about ${Math.round(full)} mi per tank` : ' · tank size not set'}`}</div></div>
        <button class="btn sm" data-act="vehicle">Change</button></div>`
    : '<div class="row"><div style="flex:1"><div style="font-weight:700">No vehicle selected</div><div class="muted small">Pick your car for EPA MPG, tank size, or EV range.</div></div><button class="btn sm primary" data-act="vehicle">Choose</button></div>';
  const gauge = ev ? Boolean(full) : Boolean(v?.tankGallons);
  const input = ui.mode === 'gauge' && gauge
    ? `<div class="row"><input type="range" min="0" max="${ev ? 20 : 8}" step="1" value="${ev ? Math.min(20, ui.batteryTwentieths ?? 10) : ui.gaugeEighths}" data-gauge style="flex:1;accent-color:var(--sign-green)"><span class="num" style="width:120px;text-align:right;font-weight:800" data-gauge-label>${gaugeText(ev ? (ui.batteryTwentieths ?? 10) : ui.gaugeEighths, v)}</span></div>
       <p class="muted tiny" style="margin:4px 0 0">${ev ? 'Battery percent times your full charge range.' : `Uses ${v.mpg} mpg ${basisName(st)}.`} The range on your dashboard is more accurate.</p>`
    : `<div class="row"><input type="number" name="dte" inputmode="numeric" min="0" max="1500" placeholder="${ev ? 'Miles of range' : 'Miles to empty'}" value="${range !== null ? Math.round(range / 1609.344) : ''}" style="flex:1;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card);font-size:20px;font-weight:700"><span class="muted">mi</span></div>
       <p class="muted tiny" style="margin:4px 0 0">The range your dashboard shows. It counts down as you drive; update it any time.</p>`;
  let plan = '';
  const sm = ev ? null : app.smartStop();
  if (sm?.primary) {
    plan = smartSection(app, sm);
  } else if (fp) {
    const rec = fp.recommended;
    if (fp.status === 'destination') {
      plan = `<div class="card"><div style="font-weight:700">No ${ev ? 'charging' : 'fuel'} stop needed</div><div class="muted small">You reach your destination with about ${miles(fp.destinationSpare)} left.</div></div>`;
    } else if (fp.chargersLoading && !rec) {
      plan = `<div class="card small">${app.chargers.error ? h(`Chargers unavailable: ${app.chargers.error}`) : 'Finding chargers along your route…'}</div>`;
    } else if (fp.status === 'none') {
      plan = `<div class="banner warn" style="margin:0">${ev ? 'No DC fast charger is listed within 2.5 miles of the route before empty.' : 'No gas is listed at interstate exits before empty. Leave the highway for gas. Turnpikes and US routes have no exit data yet.'}</div>`;
    } else {
      const row = (x, tag) => {
        const sign = x.kind === 'charge' ? '<span class="charge-sign">⚡</span>' : exitSign(x.exit.label, true);
        const act = x.kind === 'charge' ? `href="https://maps.apple.com/?daddr=${x.charger.lat},${x.charger.lon}&dirflg=d" target="_blank" rel="noopener"` : `data-act="exit" data-arg="${h(x.exit.id)}"`;
        const el = x.kind === 'charge' ? 'a' : 'button';
        return `<${el} class="item" ${act} style="color:inherit;text-decoration:none">${sign}<div class="main">
          ${tag ? `<div class="eyebrow${tag.amber ? ' amber' : ''}">${tag.text}</div>` : ''}<div class="t">${x.favorite ? '★ ' : ''}${h(stopName(x))}</div>
          ${x.exit ? priceInfo(app, x.exit) : ''}
          <div class="muted tiny">${clock(x.eta, app.plan.timeZoneIDAt(x.along), app.snapshot.t)} · arrive with about ${miles(x.rangeOnArrival)}${x.kind === 'charge' ? ` · ${miles(x.charger.offset)} off the route` : ''}</div></div>
          <div class="side"><div class="big">${milesValue(x.ahead)}</div><div class="muted tiny">mi</div></div></${el}>`;
      };
      const items = [row(rec, { text: fp.status === 'low' ? 'Nearest (below your buffer)' : `${ev ? 'Charge' : 'Fill up'} here · about ${st.bufferMiles} mi left`, amber: fp.status === 'low' })];
      if (fp.closestToTarget) items.push(row(fp.closestToTarget, { text: 'Closest to your target, not a favorite brand' }));
      for (const e of fp.earlier) items.push(row(e, { text: 'Earlier option' }));
      if (fp.lastChance) items.push(row(fp.lastChance, { text: ev ? 'Last charger before empty' : 'Last gas before empty', amber: true }));
      const favNote = fp.favoriteMissing
        ? `<div class="banner warn" style="margin:0 0 10px">No ${h(st.favoriteBrands.join(' or '))} before your ${st.bufferMiles} mi buffer.${fp.nextFavorite ? ` Next one: ${h(stopName(fp.nextFavorite))}, ${milesValue(fp.nextFavorite.ahead)} mi, arriving with about ${miles(fp.nextFavorite.rangeOnArrival)}.` : ''}</div>` : '';
      plan = `${favNote}<div class="list">${items.join('')}</div>`;
    }
  } else if (range !== null && !app.snapshot) {
    plan = `<p class="muted small">Range saved: ${miles(range)}. Start a trip or discovery mode to see where to ${ev ? 'charge' : 'fill up'}.</p>`;
  }
  const favs = ev ? '' : `<div class="card"><div class="row"><div class="eyebrow" style="flex:1">Favorite gas</div><span class="muted tiny">${st.favoriteBrands.length ? 'Picked first when they keep your buffer' : 'None: any brand'}</span></div>
    <div class="chips" style="margin-top:8px">${[...new Set([...st.favoriteBrands, ...TOP_BRANDS])].slice(0, 16).map((b) => `<button class="chip${st.favoriteBrands.includes(b) ? ' on' : ''}" data-act="fav-brand" data-arg="${h(b)}">${h(b)}</button>`).join('')}</div></div>`;
  const prices = !ev && app.prices.cache.size && app.prices.enabled ? '<p class="attrib">Google prices: <span class="gattr">Google Maps</span>, looked up when you asked. Not stored or shared.</p>' : '';
  const others = fp && fp.stations.length
    ? `<div class="section-title">All ${ev ? 'chargers' : 'gas'} within range (${fp.stations.length})</div><div class="list">${fp.stations.slice(0, 40).map((x) => `<${x.kind === 'charge' ? `a href="https://maps.apple.com/?daddr=${x.charger.lat},${x.charger.lon}&dirflg=d" target="_blank" rel="noopener"` : `button data-act="exit" data-arg="${h(x.exit.id)}"`} class="item" style="color:inherit;text-decoration:none">${x.kind === 'charge' ? '<span class="charge-sign">⚡</span>' : exitSign(x.exit.label, true)}<div class="main"><div class="t">${x.favorite ? '★ ' : ''}${h(stopName(x))}</div>
        <div class="muted tiny">arrive with about ${miles(x.rangeOnArrival)}</div></div><div class="side"><div class="big">${milesValue(x.ahead)}</div><div class="muted tiny">mi</div></div></${x.kind === 'charge' ? 'a' : 'button'}>`).join('')}</div>` : '';
  return `<div class="sheet-head"><h2>${ev ? 'Charging stop' : 'Fuel stop'}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <div class="stack">
    ${sm?.primary ? plan : ''}
    <div class="card">${vehicleLine}</div>
    <form class="card" data-form="fuel">
      <div class="row" style="margin-bottom:8px"><div class="eyebrow" style="flex:1">Range now</div>
        ${gauge ? `<div class="seg" style="width:190px"><button type="button" class="${ui.mode !== 'gauge' ? 'on' : ''}" data-act="fuel-mode" data-arg="dashboard">Miles</button><button type="button" class="${ui.mode === 'gauge' ? 'on' : ''}" data-act="fuel-mode" data-arg="gauge">${ev ? 'Battery %' : 'Gauge'}</button></div>` : ''}</div>
      ${input}
      ${ui.error ? `<p class="amber-text small">${h(ui.error)}</p>` : ''}
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" type="submit">Save range</button>
        <button class="btn" type="button" data-act="fuel-filled">${ev ? 'I charged' : 'I filled up'}</button></div>
      <div class="section-title">${ev ? 'Charge' : 'Fill up'} with about this much left</div>
      <div class="seg">${[25, 50, 75, 100].map((b) => `<button type="button" class="${st.bufferMiles === b ? 'on' : ''}" data-act="fuel-buffer" data-arg="${b}">${b} mi</button>`).join('')}</div>
    </form>
    ${favs}${sm?.primary ? '' : plan}${prices}${others}
    <p class="note">${ev ? `DC fast chargers within 2.5 miles of the route from the U.S. DOE Alternative Fuels Data Center (${st.chargerNetwork === 'Tesla' ? 'Tesla Superchargers' : 'all networks'}). Detours are straight line estimates.` : 'Gas stations linked to interstate exits in OpenStreetMap. Detours count against your range.'}${!ev && app.priceOptions() ? ' Prices are reports with their time and source (Settings, Gas prices).' : ''}</p></div>`;
}

function basisName(st, ev = false) {
  if (ev) return st.mpgBasis === 'custom' ? '(your range)' : st.mpgBasis === 'combined' ? '(EPA combined)' : '(EPA highway)';
  return st.mpgBasis === 'custom' ? '(your mpg)' : st.mpgBasis === 'combined' ? 'combined (EPA)' : 'highway (EPA)';
}

export function gaugeText(step, v) {
  if (v.ev) return `${step * 5}% · ${Math.round(step / 20 * v.rangeMiles)} mi`;
  const label = ['Empty', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', 'Full'][step];
  return `${label} · ${Math.round(step / 8 * v.tankGallons * v.mpg)} mi`;
}

function paceSettings(app) {
  const p = app.personalPace();
  const learned = p.hours >= 0.5
    ? `Your usual pace: ${Math.round(Math.abs(1 / p.factor - 1) * 100)}% ${p.factor <= 1 ? 'faster' : 'slower'} than the routing estimates, learned from ${p.hours.toFixed(1)} h of driving. <button class="btn sm" data-act="reset-pace" style="margin-left:6px">Reset</button>`
    : 'No pace history yet. It builds from real GPS trips.';
  return `<p style="margin-top:0">Times start from OSRM road speeds (OpenStreetMap speed limits times 0.8, about 56 mph on a 70 mph interstate). While you drive, the next 30 minutes follow your speed over the last few minutes, and later stretches blend into your pace for the trip and from earlier trips. Stops are not counted as slow driving.</p><p style="margin-bottom:0">${learned}</p>`;
}

function vehicleSettings(app) {
  const st = app.settings;
  const v = app.vehicleProfile();
  const recent = app.garage();
  return `<div class="list">
    <div class="field"><span style="flex:1">${v ? `<b>${h(`${v.year} ${v.make} ${v.model}`)}</b><div class="muted tiny">${h(v.label)}</div>
      <div class="muted tiny">${v.ev ? `Electric · EPA range ${v.rangeMiles} mi used for a full charge · ${v.comb} MPGe` : `EPA ${v.city} city · ${v.hwy} highway · ${v.comb} combined mpg${v.tankGallons ? ` · ${v.tankGallons} gal tank (${v.tankBasis === 'entered' ? 'entered by you' : 'verified'})` : ' · tank size not set'}`}</div>` : 'No vehicle selected'}</span>
      <button class="btn sm${v ? '' : ' primary'}" data-act="vehicle">${v ? 'Change' : 'Choose'}</button></div>
    ${recent.map((r, i) => `<div class="field"><span style="flex:1">${h(`${r.year} ${r.make} ${r.model}`)}<div class="muted tiny">${h(r.label)}</div></span><button class="btn sm" data-act="vehicle-recent" data-arg="${i}">Use</button><button class="btn sm" data-act="vehicle-remove" data-arg="${i}" aria-label="Remove ${h(`${r.year} ${r.make} ${r.model}`)}">✕</button></div>`).join('')}
    <div class="field"><span style="flex:1">${v?.ev ? 'Range for a full charge' : 'MPG for range'}</span><div class="seg" style="width:220px">${[['highway', 'Highway'], ['combined', 'Combined'], ['custom', v?.ev ? 'My range' : 'My MPG']].map(([k, n]) => `<button class="${st.mpgBasis === k ? 'on' : ''}" data-act="mpg-basis" data-arg="${k}">${n}</button>`).join('')}</div></div>
    ${st.mpgBasis === 'custom' && !v?.ev ? `<label class="field"><span style="flex:1">My real MPG<div class="muted tiny">Interstate speeds often use more fuel than the EPA highway test</div></span><input type="number" inputmode="decimal" step="0.5" min="1" data-set="customMpg" value="${st.customMpg ?? ''}"></label>` : ''}
    ${st.mpgBasis === 'custom' && v?.ev ? `<label class="field"><span style="flex:1">My real range at 100%<div class="muted tiny">Highway speed and cold weather lower EV range</div></span><input type="number" inputmode="decimal" step="5" min="10" data-set="customRange" value="${st.customRange ?? ''}"></label>` : ''}
    <div class="field"><span style="flex:1">Fill up with about</span><div class="seg" style="width:220px">${[25, 50, 75, 100].map((b) => `<button class="${st.bufferMiles === b ? 'on' : ''}" data-act="fuel-buffer" data-arg="${b}">${b} mi</button>`).join('')}</div></div>
  </div>`;
}

export function vehicleSheet(app) {
  const vp = app.vehiclePick;
  const head = '<div class="sheet-head"><h2>Choose vehicle</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>';
  if (!app.vehicles) {
    return `${head}<div class="card empty">${app.vehiclesError ? h(app.vehiclesError) : 'Loading the EPA vehicle list…'}</div>`;
  }
  const years = Object.keys(app.vehicles.years).sort((a, b) => b - a);
  const makes = vp.year ? Object.keys(app.vehicles.years[vp.year] ?? {}).sort((a, b) => a.localeCompare(b)) : [];
  const models = vp.year && vp.make ? Object.keys(app.vehicles.years[vp.year][vp.make] ?? {}).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
  const versions = vp.year && vp.make && vp.model ? app.vehicles.years[vp.year][vp.make][vp.model] ?? [] : [];
  const select = (name, label, options, value, fmt = (x) => x) => `<label class="field"><span style="width:90px">${label}</span>
    <select data-vp="${name}" style="flex:1;min-width:0;border:1px solid var(--stroke);border-radius:10px;padding:10px;background:var(--bg)" ${options.length ? '' : 'disabled'}>
      <option value="">Select</option>${options.map((o, i) => `<option value="${name === 'version' ? i : h(o)}" ${String(name === 'version' ? i : o) === String(value) ? 'selected' : ''}>${h(fmt(o))}</option>`).join('')}</select></label>`;
  let detail = '';
  const ver = vp.version !== null && vp.version !== '' ? versions[Number(vp.version)] : null;
  if (ver) {
    const [label, city, hwy, comb, , tankIdx, fuel, evRange, evRangeHwy] = ver;
    const ev = fuel === 'E';
    const tank = tankIdx >= 0 ? app.vehicles.tanks[tankIdx] : null;
    const query = encodeURIComponent(`${vp.year} ${vp.make} ${vp.model} ${label.split(' · ')[0]} fuel tank capacity gallons`);
    let tankUI;
    if (ev) {
      tankUI = `<div class="field"><span style="flex:1">EPA range<div class="muted tiny">Full charge, combined${evRangeHwy ? `; ${evRangeHwy} mi highway` : ''}</div></span><b class="num">${evRange} mi</b></div>`;
    } else if (tank && tank.gallons.length === 1) {
      tankUI = `<div class="field"><span style="flex:1">Tank<div class="muted tiny">Verified: ${tank.sources.map((u, i) => `<a href="${h(u)}" target="_blank" rel="noopener">source ${i + 1}</a>`).join(', ')}</div></span><b class="num">${tank.gallons[0]} gal</b></div>`;
    } else if (tank) {
      tankUI = `<div class="field" style="flex-wrap:wrap"><span style="flex:1">Tank<div class="muted tiny">This model came with different tanks. Verified: ${tank.sources.map((u, i) => `<a href="${h(u)}" target="_blank" rel="noopener">source ${i + 1}</a>`).join(', ')}</div></span>
        <div class="chips">${tank.gallons.map((g) => `<button class="chip${Number(vp.tank) === g ? ' on' : ''}" data-act="vehicle-tank" data-arg="${g}">${g} gal</button>`).join('')}</div></div>`;
    } else {
      tankUI = `<label class="field"><span style="flex:1">Tank size (gallons)<div class="muted tiny">Not in the verified list yet. <a href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener">Look it up</a> or check the owner's manual.</div></span>
        <input type="number" inputmode="decimal" step="0.1" min="1" max="60" data-vp="tank" value="${vp.tank ?? ''}"></label>`;
    }
    detail = `<div class="list" style="margin-top:12px">
      <div class="field"><span style="flex:1">EPA ${ev ? 'efficiency (MPGe)' : 'fuel economy'}<div class="muted tiny"><a href="https://www.fueleconomy.gov/feg/noframes/${ver[4]}.shtml" target="_blank" rel="noopener">fueleconomy.gov</a>${fuel === 'P' ? ' · premium fuel' : fuel === 'D' ? ' · diesel' : ''}</div></span><span class="num"><b>${city}</b> city · <b>${hwy}</b> hwy · <b>${comb}</b> comb</span></div>
      ${tankUI}</div>
      <button class="btn primary block" style="margin-top:14px" data-act="vehicle-save">Use this vehicle</button>`;
  }
  return `${head}<div class="list">
    ${select('year', 'Year', years, vp.year)}
    ${select('make', 'Make', makes, vp.make)}
    ${select('model', 'Model', models, vp.model)}
    ${select('version', 'Version', versions, vp.version, (o) => (o[6] === 'E' ? o[0] : `${o[0]} · ${o[2]} mpg hwy`))}
  </div>${detail}
  <p class="note">Fuel economy and EV range for every gasoline, diesel, hybrid and electric vehicle since 2000 from the U.S. EPA (fueleconomy.gov). Tank sizes are included only where verified from the manufacturer or two reputable sources.</p>`;
}

export function stopSheet(app) {
  const q = app.stopQuery;
  const kinds = [[3, 'Hotel'], [2, 'Food'], [1, 'Gas'], [4, 'Rest stop'], [5, 'EV charging']];
  let results = '';
  if (q.results) {
    const row = (r, i) => {
      const along = r.restArea ? r.restArea.distanceAlongRoute : r.match.exit.distanceAlongRoute;
      const arrive = `Arrive ${clock(r.eta, app.plan.timeZoneIDAt(along), app.snapshot.t)}`;
      const reasons = `<div class="reasons">${i === 0 ? '<span class="reason best">Best fit</span>' : ''}${r.reasons.map((x) => `<span class="reason">${h(x)}</span>`).join('')}</div>`;
      if (r.restArea) {
        return `<button class="item" data-act="rest" data-arg="${h(r.restArea.id)}">${restSign(r.restArea.kind, true)}<div class="main">
          <div class="t">${h(restAreaTitle(r.restArea))}</div><div class="muted tiny">${arrive}</div>${reasons}</div>
          <div class="side"><div class="big">${milesValue(r.distanceAhead)}</div><div class="muted tiny">mi</div></div></button>`;
      }
      const place = r.match.matchesPerRequirement[0][0].place;
      return `<div class="item stop-result"><button class="stop-main" data-act="exit" data-arg="${h(r.match.exit.id)}">${exitSign(r.match.exit.label, true)}<div class="main">
          <div class="t">${h(r.match.matchesPerRequirement[0].slice(0, 3).map((x) => placeDisplayName(x.place)).join(', '))}</div>
          <div class="muted tiny">${arrive}</div>${reasons}</div>
          <div class="side"><div class="big">${milesValue(r.distanceAhead)}</div><div class="muted tiny">mi</div></div></button>
        ${app.canAddStop() ? `<button class="btn sm add-stop" data-act="add-trip-stop" data-arg="${h(`${r.match.exit.id}|${place.id}`)}">Add to trip</button>` : ''}</div>`;
    };
    results = q.results.length
      ? `<div class="list" style="margin-top:12px">${q.results.slice(0, 12).map(row).join('')}</div>
        ${app.canAddStop() ? '' : '<p class="muted tiny">Adding a stop reroutes the trip, which needs live GPS (not the demo).</p>'}`
      : '<div class="card empty" style="margin-top:12px"><div class="t">Nothing in that window</div>Try another time or remove the brand.</div>';
  }
  return `<div class="sheet-head"><h2>Plan a stop</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <div class="chips" style="flex-wrap:wrap">${kinds.map(([c, n]) => `<button class="chip${q.category === c ? ' on' : ''}" data-act="stop-cat" data-arg="${c}">${CATEGORY_ICONS[c]} ${n}</button>`).join('')}</div>
    <form data-form="stop"><div class="section-title">After about</div>
      <div class="row"><input type="range" min="0.5" max="12" step="0.5" value="${q.hours}" data-stop-hours style="flex:1;accent-color:var(--sign-green)"><span class="num" style="font-weight:800;width:70px;text-align:right" data-stop-hours-label>${q.hours} h</span></div>
      <p class="muted tiny" style="margin:4px 0 0">Plus or minus 30 minutes, adjusted for your actual pace.</p>
      <div class="section-title">Brand (optional)</div>
      <input type="search" name="brand" value="${h(q.brand)}" placeholder="Hampton Inn, Waffle House" style="width:100%;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card)">
      <button class="btn primary block" type="submit" style="margin-top:14px">Find stops</button></form>${results}`;
}

/// The data set in use, and any file that fell back to the previous version.
function dataVersionLine(status) {
  const m = status?.manifest;
  if (!m) return '<p style="margin-top:0"><b>Data version:</b> unknown</p>';
  const built = m.generated_at ? new Date(m.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const back = status.rolledBack.length
    ? ` <span class="warn">Using the previous version of ${h([...new Set(status.rolledBack)].join(', '))}: the new download did not match its checksum or could not be read.</span>` : '';
  const missing = status.failed.length ? ` Not loaded: ${h([...new Set(status.failed)].join(', '))}.` : '';
  return `<p style="margin-top:0"><b>Data version:</b> ${m.version}${built ? `, built ${h(built)}` : ''}. Each file is checked against its SHA-256 before use.${back}${missing}</p>`;
}

// MARK: Profile settings

const inputStyle = 'style="width:100%;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"';
const seg = (act, options, current, width = 230) => `<div class="seg" style="width:${width}px">${options.map(([k, n]) => `<button class="${current === k ? 'on' : ''}" data-act="${act}" data-arg="${h(k)}">${h(n)}</button>`).join('')}</div>`;

/// Favorite brands in priority order, and what a fuel stop must have.
function fuelPreferences(app) {
  const st = app.settings;
  const n = st.favoriteBrands.length;
  const order = n ? st.favoriteBrands.map((b, i) => `<div class="field"><span style="flex:1"><b>${i + 1}.</b> ${h(b)}</span>
    <button class="btn sm" data-act="brand-move" data-arg="${i},-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${h(b)} up">↑</button>
    <button class="btn sm" data-act="brand-move" data-arg="${i},1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${h(b)} down">↓</button>
    <button class="btn sm" data-act="brand-remove" data-arg="${i}" aria-label="Remove ${h(b)}">✕</button></div>`).join('')
    : '<div class="field"><span class="muted">No favorite brands. Fuel stops are chosen by distance and hours only.</span></div>';
  const when = [['overnight', 'Overnight'], ['always', 'Always'], ['off', 'Off']];
  return `<div class="list">${order}</div>
    <div class="card" style="margin-top:8px"><div class="muted tiny" style="margin-top:0">Add a brand: tap one, or type it and press return. The first brand that fits your range, hours and restroom needs ranks first.</div>
      <div class="chips" style="flex-wrap:wrap;margin-top:8px">${TOP_BRANDS.filter((b) => !st.favoriteBrands.includes(b)).map((b) => `<button class="chip" data-act="fav-brand" data-arg="${h(b)}">${h(b)}</button>`).join('')}</div>
      <input type="text" data-brand placeholder="Another brand, then return" ${inputStyle.replace('width:100%', 'width:100%;margin-top:10px')}></div>
    <div class="list" style="margin-top:8px">
      <div class="field"><span style="flex:1">Fuel grade<div class="muted tiny">For prices; your vehicle's fuel when not set</div></span>${seg('fuel-grade', [['', 'Vehicle'], ['R', 'Regular'], ['M', 'Mid'], ['P', 'Premium'], ['D', 'Diesel']], st.fuelGrade ?? '', 300)}</div>
      <div class="field"><span style="flex:1">Open at arrival<div class="muted tiny">Stops listed open when you get there rank first; listed closed ones are never picked</div></span>${seg('require', when.map(([k, n]) => [`require24Hours,${k}`, n]), `require24Hours,${st.require24Hours}`, 230)}</div>
      <div class="field"><span style="flex:1">Restroom<div class="muted tiny">Stops with a confirmed restroom rank first; ones listed without one are skipped</div></span>${seg('require', when.map(([k, n]) => [`requireRestroom,${k}`, n]), `requireRestroom,${st.requireRestroom}`, 230)}</div>
      <div class="field"><span style="flex:1">Longest detour<div class="muted tiny">Off the highway and back</div></span>${seg('detour', [[3, '3 min'], [5, '5'], [8, '8'], [12, '12'], [20, '20']].map(([k, n]) => [String(k), n]), String(st.maxDetourMinutes), 240)}</div>
      <label class="field"><span style="flex:1">Cheaper fuel over favorite brands<div class="muted tiny">Only when live prices are available</div></span><input type="checkbox" class="toggle" data-set="priceOverBrand" ${st.priceOverBrand ? 'checked' : ''}></label>
    </div>`;
}

function overnightSettings(app) {
  const st = app.settings;
  return `<div class="list">
    <div class="field"><span style="flex:1">Overnight Drive Mode<div class="muted tiny">Auto uses the window below, at your arrival time in the stop's own time zone</div></span>${seg('overnight-mode', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], st.overnightMode, 200)}</div>
    <label class="field"><span style="flex:1">Starts at</span><input type="time" data-set="overnightStart" value="${h(st.overnightStart)}" ${st.overnightMode !== 'auto' ? 'disabled' : ''}></label>
    <label class="field"><span style="flex:1">Ends at</span><input type="time" data-set="overnightEnd" value="${h(st.overnightEnd)}" ${st.overnightMode !== 'auto' ? 'disabled' : ''}></label>
  </div>`;
}

function favoritesSettings(app) {
  const st = app.settings;
  const cats = [['gas', 'Gas'], ['food', 'Food'], ['lodging', 'Lodging'], ['evCharging', 'EV charging'], ['restArea', 'Rest areas'], ['travelCenter', 'Travel centers']];
  const list = (key, label, placeholder) => `<div class="card" style="margin-top:8px"><div class="muted tiny" style="margin-top:0">${label}</div>
    <div class="chips" style="flex-wrap:wrap;margin-top:6px">${st[key].map((b, i) => `<button class="chip on" data-act="list-remove" data-arg="${key},${i}" aria-label="Remove ${h(b)}">${h(b)} ✕</button>`).join('') || '<span class="muted tiny">None yet</span>'}</div>
    <input type="text" data-list="${key}" placeholder="${placeholder}" ${inputStyle.replace('width:100%', 'width:100%;margin-top:8px')}></div>`;
  return `<div class="card"><div class="muted tiny" style="margin-top:0">Shown first in the exits list</div>
    <div class="chips" style="flex-wrap:wrap;margin-top:6px">${cats.map(([k, n]) => `<button class="chip${st.favoriteCategories.includes(k) ? ' on' : ''}" data-act="fav-category" data-arg="${k}">${n}</button>`).join('')}</div></div>
    ${list('favoriteHotels', 'Favorite hotel brands', 'Hotel brand, then return')}
    ${list('favoriteRestaurants', 'Favorite restaurant brands', 'Restaurant brand, then return')}`;
}

/// Where the profile is kept, whether the last change was saved, and moving it to another device.
function profileSection(app) {
  const ps = app.profileStatus;
  const updated = app.profile.updatedAt ? new Date(app.profile.updatedAt) : null;
  const status = ps.saveError
    ? `<p class="warn" style="margin-top:0">Not saved: ${h(ps.saveError)}. Changes last only until this page is closed.</p>`
    : `<p style="margin-top:0">Saved on this ${app.standalone ? 'Home Screen app' : 'browser'}${updated ? `, last change ${h(updated.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : ''}. Vehicles, favorite brands, places and preferences stay through trips, updates and new data.</p>`;
  const recovered = ps.problems.length ? `<p class="warn">${ps.problems.length} saved setting${ps.problems.length === 1 ? ' was' : 's were'} unreadable and now ${ps.problems.length === 1 ? 'uses its' : 'use their'} default (${h(ps.problems.slice(0, 4).join(', '))}${ps.problems.length > 4 ? ', ...' : ''}). The unreadable copy is kept.</p>` : '';
  const safari = app.isIOSSafari && !app.standalone
    ? '<p class="muted tiny">On iPhone, add ExitAtlas to the Home Screen (Share, Add to Home Screen): Safari deletes a website\'s storage after 7 days of Safari use without a visit to it. A Home Screen web app counts its own days of use, so opening ExitAtlas from there keeps its data.</p>' : '';
  return `<div class="card small">${status}${recovered}${safari}
    <p class="muted tiny">The website and the iOS app keep separate profiles. To use the same one, export it here and import it there (or the other way). API keys are never included.</p>
    <div class="row" style="gap:8px"><button class="btn sm" data-act="export-profile">Export profile</button>
      <label class="btn sm" style="cursor:pointer">Import profile<input type="file" accept="application/json,.json" data-import hidden></label></div></div>`;
}

/// Where the station facts come from, with counts (stations.json meta).
function stationCredit(m) {
  const n = (v) => (v ?? 0).toLocaleString('en-US');
  let text = `OpenStreetMap, tags checked ${m.tags_fetched}: hours for ${n(m.with_hours)} and restroom tags for ${n(m.with_toilets)} of ${n(m.count)} stations; ${n(m.gone)} no longer listed as gas stations are never recommended`;
  if (m.brand_collected) text += `. The brands' own store listings, collected ${m.brand_collected} by All the Places (CC0): hours for ${n(m.with_brand_hours)} and restroom listings for ${n(m.with_brand_toilets)}`;
  return text;
}

/// Traffic on the website: none is licensed for it (docs/16), so this says so instead of offering switches
/// that would do nothing. The traffic preferences stay in the profile for the iOS app.
function trafficSettings() {
  return `<div class="card small" data-testid="traffic-settings"><div style="font-weight:700">Not available on the website</div>
    <p class="muted" style="margin:6px 0 0">No traffic provider we checked licenses its data for a navigation app on this map without a separate agreement (TomTom, HERE, Apple, Google, Azure and Mapbox; docs/16). Arrival times use your pace and say so. Road alerts still come from the official feeds below. The iOS app uses Apple Maps traffic.</p></div>`;
}

/// Road alert switches by group, with each group's source and status during a trip.
function alertSettings(app) {
  const al = app.settings.alerts ?? {};
  const st = app.roadIntel()?.status ?? null;
  const sources = {
    closures: `Official state work zone feeds (WZDx, public domain): ${Object.keys(WZDX_FEEDS).join(', ')}, checked every 10 to 30 minutes during a trip.${
      app.proxy?.wzdx ? '' : ` ${Object.keys(WZDX_FEEDS).filter((k) => !WZDX_FEEDS[k].cors).join(', ')} need the key proxy here.`} Other states: none yet (docs/13)`,
    incidents: 'No source connected yet: state 511 feeds need registration (docs/13)',
    weather: 'National Weather Service, public domain, checked every 10 minutes during a trip',
    traffic: 'No licensed traffic source for the website (docs/16)',
    police: 'No authorized live source exists for ExitAtlas, so nothing is shown (docs/13)',
    cameras: 'No source connected yet',
  };
  const row = (g) => `<label class="field"><span style="flex:1">${h(ALERT_GROUPS[g].label)}<div class="muted tiny">${h(sources[g])}${st ? ` · Now: ${h(st[g].label)}` : ''}</div></span>
    <input type="checkbox" class="toggle" data-alert="${g}" ${al[g] !== false ? 'checked' : ''}></label>`;
  return `<div class="list">${Object.keys(ALERT_GROUPS).map(row).join('')}
    <label class="field"><span style="flex:1">Speak road alerts<div class="muted tiny">Serious ones about 10 miles ahead, others about 2 miles, once each</div></span>
    <input type="checkbox" class="toggle" data-alert="voice" ${al.voice !== false ? 'checked' : ''}></label></div>
    <p class="note">Alerts are matched to your road and direction, so the other side of the highway and parallel roads do not warn. A source that fails shows as unavailable, never as all clear.</p>`;
}
