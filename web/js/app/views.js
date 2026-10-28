// Screen templates. Pure functions of app state that return HTML strings.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { highwayLabel, DIRECTION_WORDS } from '../engine/route.js';
import { CATEGORY_NAMES, placeDisplayName } from '../engine/datasets.js';
import { exitTitle } from '../engine/exits.js';
import { miles, milesValue, duration, clock, escapeHTML as h } from './format.js';
import { renderRouteMap } from './map.js';
import { GRADES, pricedForGrade, priceText, ageText } from './prices.js';
import { matchesFavorite } from '../engine/fuel.js';
import { KIND_TITLES, restAreaTitle, amenityBadges, hoursText } from '../engine/restareas.js';
import { DISCOVER_CATEGORIES } from '../engine/discover.js';
import { passport, STATE_CODES } from '../engine/passport.js';

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
export function servicePlaques(services, { names = 2, compact = false } = {}) {
  const tiles = [];
  for (const cat of PLAQUE_ORDER) {
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

function gapRow(g, s) {
  const where = g.before ? `After ${h(gasStopTitle(g.before))}` : 'From here';
  const next = g.after ? `, next gas at ${h(gasStopTitle(g.after))}` : g.open ? ', and none listed beyond' : ', and none before your destination';
  return `<div class="item gap-row"><span class="gap-icon" aria-hidden="true">⛽</span><div class="main"><div class="t">No gas for ${miles(g.length)}${g.open ? '+' : ''}</div>
    <div class="muted small">${where}${next}</div></div><div class="side"><div class="big">${milesValue(Math.max(0, g.from - s.progress))}</div></div></div>`;
}

function restRow(u, s) {
  const r = u.restArea;
  const sub = [r.side === 'both' ? 'Serves both directions' : null, r.road].filter(Boolean).join(' · ');
  return `<button class="item exit-row ra-row" data-act="rest" data-arg="${h(r.id)}">
    <div class="er-head">${restSign(r.kind, true)}<div class="main"><div class="t">${h(restAreaTitle(r))}</div><div class="muted small">${h(sub)}</div></div>
      <div class="side"><div class="big">${milesValue(u.distance)}</div><div class="muted small">${duration(u.eta - s.t)}</div></div></div>
    ${amenityChips(r, { max: 4 })}</button>`;
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
  return '<div class="attrib">Routing and map data © OpenStreetMap contributors (ODbL). Exits and places: OpenInterstate. Rest area truck parking: FHWA. Discover places: Wikidata (CC0). State lines: U.S. Census TIGER/Line. Not affiliated with iExit.</div>';
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

function dashboard(app, s) {
  const discovery = app.mode === 'discovery';
  const parts = [cluster(app, s)];
  if (s.current) parts.push(borderCard(s));
  if (s.nextExit) parts.push(nextExitCard(app, s));
  const gap = gasGapCard(app, s);
  if (gap) parts.push(gap);
  if (s.nextRestArea && s.nextRestArea.distance <= 150 * MILE) parts.push(restAreaCard(s));
  parts.push(fuelCard(app, s));
  parts.push(destinationCard(app, s, discovery));
  const extras = [];
  if (s.match.status === 'offRoute' && !app.isRerouting && app.mode === 'trip') {
    extras.push(`<div class="banner warn">You are off the planned route. ${app.gps === 'device' ? 'A new route is requested automatically when online.' : ''}</div>`);
  }
  if (app.lastError) extras.push(`<p class="amber-text small">${h(app.lastError)}</p>`);
  extras.push(screenNote(app));
  return `<div class="dash">${parts.join('')}<div class="dash-extras">${extras.join('')}</div></div>`;
}

/// The instrument cluster: speedometer, posted limit, highway and state.
function cluster(app, s) {
  const mph = app.speedNow();
  const onRoute = s.match.status === 'onRoute';
  const limits = app.limits;
  const limit = onRoute && limits ? limits.at(s.progress) : null;
  const limitState = !onRoute ? 'unknown' : limits ? limits.state(s.progress) : 'loading';
  const over = mph !== null && limit !== null ? mph - limit : null;
  const level = over === null || over <= 0 ? 'ok' : over <= app.settings.speedAlertOver ? 'warn' : 'over';
  const next = onRoute && limits ? limits.nextChange(s.progress) : null;
  const hw = s.highway;
  const sign = limit !== null
    ? `<div class="limit-sign" aria-label="Speed limit ${limit}"><span class="t">SPEED<br>LIMIT</span><span class="v num">${limit}</span></div>`
    : `<div class="limit-sign dim" aria-label="Speed limit not available"><span class="t">SPEED<br>LIMIT</span><span class="v num">${limitState === 'loading' ? '…' : '—'}</span></div>`;
  const nextLine = next ? `<div class="limit-next"><b class="num">${next.mph}</b> in ${miles(next.distance)}</div>`
    : limit === null && limitState === 'unknown' ? '<div class="limit-next">No limit data</div>' : '';
  return `<section class="card cluster ${level}">
    ${speedo(mph, limit, level)}
    <div class="limit-col">${sign}${nextLine}</div>
    <div class="road-col">${shield(hw?.ref, 46)}
      <div class="road-name">${hw ? h(highwayLabel(hw.ref)) : 'Local'}</div>
      <div class="road-dir">${hw ? DIRECTION_WORDS[hw.direction] : 'roads'}</div>
      <div class="road-state">${badge(s.current?.segment.code, true, true)}<span class="muted tiny">${app.mode === 'discovery' ? 'Discovery' : h(s.current?.segment.displayName ?? '')}</span></div>
    </div></section>`;
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

function borderCard(s) {
  const cur = s.current, next = s.next;
  let body;
  if (next) {
    const crossing = cur.exitTime !== null ? clock(cur.exitTime, cur.exitTimeZoneID, s.t) : '—';
    const inTime = cur.exitTime !== null ? `in ${duration(cur.exitTime - s.t)}` : '';
    body = `<div class="row top"><div style="flex:1;min-width:0"><div class="eyebrow">Next state</div><div class="title-xl">${h(next.segment.displayName)}</div></div>
      ${next.segment.isBrief ? '<span class="amber-text small">Brief crossing</span>' : ''}</div>
      <div class="metrics" style="margin-top:14px">
        ${metric('To state line', milesValue(cur.remainingMeters), { unit: 'mi' })}
        ${metric('Exits left', String(cur.exitsRemaining), { caption: `in ${cur.segment.code ?? 'this state'}` })}
        ${metric('Crossing', crossing, { caption: inTime, size: 'sm' })}
      </div>
      ${cur.remainingMeters < 5 * MILE ? `<p class="amber-text" style="margin:12px 0 0">🏁 Entering ${h(next.segment.displayName)} in ${miles(cur.remainingMeters)}</p>` : ''}
      <p class="muted small" style="margin:10px 0 0">You will drive ${miles(next.totalMeters)} in ${h(next.segment.displayName)}${next.plannedDuration !== null ? `, about ${duration(next.plannedDuration)}` : ''}.</p>`;
  } else {
    body = `<div class="eyebrow">Final state</div><div class="title-lg">${h(cur.segment.displayName)}</div>
      <div class="metrics two" style="margin-top:12px">${metric(`Left in ${cur.segment.code ?? 'state'}`, milesValue(cur.remainingMeters), { unit: 'mi' })}
      ${metric('Exits left', String(cur.exitsRemaining))}</div>`;
  }
  const pct = Math.round(Math.max(0, Math.min(1, cur.fractionComplete)) * 100);
  return `<div class="card lg state-card">${stateRibbon(s)}${body}
    <div class="state-progress"><div class="row"><span class="pct num">${pct}%</span><span class="muted small">of ${h(cur.segment.displayName)} driven</span><span class="spacer"></span><span class="muted small num">${miles(cur.drivenMeters)} of ${miles(cur.totalMeters)}</span></div>
    ${progress(cur.fractionComplete)}
    <div class="row muted small" style="margin-top:6px"><span>${miles(cur.remainingMeters)} left in ${h(cur.segment.code ?? cur.segment.displayName)}</span><span class="spacer"></span><span>${cur.exitCount} exits in ${h(cur.segment.code ?? 'state')}</span></div></div></div>`;
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
      <ul class="smart-reasons">${p.reasons.map((r) => `<li>${h(r)}</li>`).join('')}${p.nextOption != null ? `<li>Next option ${miles(p.nextOption)} later</li>` : ''}</ul>
      <details class="facilities"><summary>What is known at arrival</summary>${facilityRows(p)}</details>
      <div class="btn-row">${p.exit ? `<button class="btn sm" data-act="exit" data-arg="${h(p.exit.id)}">Exit details</button>` : p.restArea ? `<button class="btn sm" data-act="rest" data-arg="${h(p.restArea.id)}">Plaza details</button>` : ''}
        <button class="btn sm" data-act="skip-stop" data-arg="${h(p.id)}">Not this one</button></div>
      ${fav}
    </div>
    ${sm.alternatives.length ? `<div class="section-title">Alternatives</div><div class="list">${sm.alternatives.map(alt).join('')}</div>` : ''}
    ${pass.length ? `<p class="muted tiny" style="margin:4px 0 0">Passed over: ${h(pass.map(([r, n]) => `${n} ${r.charAt(0).toLowerCase() + r.slice(1)}`).join(', '))}.${app.rejectedStops.length ? ' <button class="linkish" data-act="unskip-stops">Offer skipped stops again</button>' : ''}</p>` : ''}
    <div class="list" style="margin-top:10px">${overnightRow(app)}</div>
    <p class="note">Hours: Google Maps business hours when prices load (live), else OpenStreetMap (mapped by volunteers; the check date shows when). A station listed open 24 hours can still lock its restroom overnight, so restrooms show as open at arrival only at rest areas and service plazas with listed hours.</p>`;
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
        ${smartConfidence(p, sm)}
        <div class="muted tiny">${h(smartArrival(app, p))}${p.detourMinutes != null ? ` · ${Math.round(p.detourMinutes)} min detour` : ''}</div></div></div>
        ${sm.notice ? `<div class="muted tiny" style="margin-top:6px">${h(sm.notice)}</div>` : ''}`;
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

/// Live price line for an exit (gas cars with a Google key): favorite brand first, then the cheapest.
function priceInfo(app, exit) {
  if (!exit || !app.prices.enabled || app.settings.vehicle?.ev) return '';
  const c = app.prices.peek(exit.id);
  if (!c) return '<div class="muted tiny">Loading prices…</div>';
  if (c.error) return '<div class="muted tiny">Prices unavailable</div>';
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

function destinationCard(app, s, discovery) {
  if (discovery) {
    return `<div class="card"><div class="metrics two">${metric('Corridor ahead', milesValue(s.remaining), { unit: 'mi', size: 'md' })}
      ${metric('State lines', String(s.borderCrossingsRemaining), { caption: 'within lookahead', size: 'md' })}</div></div>`;
  }
  const stop = s.nextStop ? `<p class="muted small" style="margin:10px 0 0">Next stop: ${h(s.nextStop.stop.waypoint.name)}, ${miles(s.nextStop.distance)}, ${clock(s.nextStop.eta, null, s.t)}</p>` : '';
  return `<div class="card"><div class="metrics">
    ${metric('Remaining', milesValue(s.remaining), { unit: 'mi', size: 'md' })}
    ${metric('Arrival', clock(s.eta, null, s.t), { caption: duration(s.timeRemaining), size: 'sm' })}
    ${metric('States left', String(s.statesAhead.length), { caption: s.statesAhead.slice(0, 4).join(' · '), size: 'md' })}
  </div>${stop}${paceNote(app, s)}</div>`;
}

function paceNote(app, s) {
  let text;
  if (s.recentSpeed) text = `Times follow your driving: ${Math.round(s.recentSpeed * 2.23694)} mph average over the last few minutes, blending into your trip pace for later stretches.`;
  else if (Math.abs(s.paceFactor - 1) > 0.02) text = 'Times use your usual pace from earlier trips until you have driven a few minutes.';
  else text = 'Times use routing road speeds until you have driven a few minutes, then follow your pace.';
  return `<p class="muted tiny" style="margin:10px 0 0">${text}</p>`;
}

// MARK: Exits

export function exitsView(app) {
  const s = app.snapshot;
  if (!s) {
    return `<div class="card empty"><div class="t">No active trip</div>Plan a trip or start discovery mode to see the exits ahead.</div>`;
  }
  const ui = app.exitsUI;
  const window = ui.window * MILE;
  const windowSeg = `<div class="seg">${WINDOWS.map((w) => `<button class="${w === ui.window ? 'on' : ''}" data-act="exits-window" data-arg="${w}">${w} mi</button>`).join('')}</div>`;
  const chips = `<div class="chips"><button class="chip${ui.category === null ? ' on' : ''}" data-act="exits-cat" data-arg="">All</button>${FILTER_CATEGORIES.map((c) => `<button class="chip${ui.category === c ? ' on' : ''}" data-act="exits-cat" data-arg="${c}">${CATEGORY_ICONS[c]} ${CATEGORY_NAMES[c]}</button>`).join('')}</div>`;
  const tools = `<div class="btn-row"><button class="btn sm" data-act="sheet" data-arg="search">🔎 Find along route</button><button class="btn sm" data-act="sheet" data-arg="fuel">⛽ Fuel stop</button></div>`;
  const rows = [];
  const borders = s.itinerary.filter((f) => f.status === 'upcoming' && f.segment.startDistance - s.progress <= window);
  const borderRow = (f) => {
    const d = f.segment.startDistance - s.progress;
    return `<div class="item border-row">${badge(f.segment.code, true)}<div class="main"><div class="t">Entering ${h(f.segment.displayName)}${f.segment.visit > 1 ? ' (again)' : ''}</div>
      <div class="muted small">${miles(f.totalMeters)} on route · ${f.exitCount} exits</div></div>
      <div class="side"><div class="big">${milesValue(d)}</div><div class="muted tiny">${f.entryTime !== null ? clock(f.entryTime, f.entryTimeZoneID, s.t) : ''}</div></div></div>`;
  };
  const fp = app.fuelPlan();
  const fuelStopID = fp && fp.status !== 'destination' ? (app.smartStop()?.primary?.exitId ?? fp.recommended?.exit?.id) : null;
  // Rows in route order: state lines, exits, rest areas and stretches without gas. At the same mile a
  // state line comes first and a gas gap comes after the exit it starts at.
  const events = borders.map((f) => ({ d: f.segment.startDistance, o: 0, html: borderRow(f) }));
  for (const u of s.upcomingExits) {
    if (u.distance > window) break;
    const services = app.servicesFor(u.exit);
    if (ui.category !== null && !services.some((x) => x.place.category === ui.category)) continue;
    const fuelStop = fuelStopID === u.exit.id;
    events.push({ d: u.exit.distanceAlongRoute, o: 1, html: `<button class="item exit-row" data-act="exit" data-arg="${h(u.exit.id)}">
      <div class="er-head">${exitSign(u.exit.label, true)}<div class="main">${u.exit.name ? `<div class="t">${h(u.exit.name)}</div>` : ''}
        ${services.length ? '' : '<div class="muted small">No services listed</div>'}
        ${fuelStop ? '<div class="amber-text small">⛽ Planned fuel stop</div>' : ''}
        ${u.exit.confidence === 'medium' ? '<div class="muted small">Direction not verified in source data</div>' : ''}</div>
        <div class="side"><div class="big">${milesValue(u.distance)}</div><div class="muted small">${duration(u.eta - s.t)}</div></div></div>
      ${servicePlaques(services, { compact: true })}</button>` });
  }
  const restShown = (r) => ui.category === null || ui.category === 4 || (ui.category === 1 && r.gas.length > 0)
    || (ui.category === 2 && r.food.length > 0) || (ui.category === 5 && r.ev.length > 0);
  for (const u of s.upcomingRestAreas) {
    if (u.distance <= window && restShown(u.restArea)) events.push({ d: u.restArea.distanceAlongRoute, o: 1, html: restRow(u, s) });
  }
  if (ui.category === null || ui.category === 1) {
    for (const g of app.gasGapsAhead(s, window)) events.push({ d: g.from, o: 2, html: gapRow(g, s) });
  }
  events.sort((x, y) => x.d - y.d || x.o - y.o);
  for (const e of events) rows.push(e.html);
  const list = rows.length ? `<div class="list">${rows.join('')}</div>`
    : `<div class="card empty"><div class="t">Nothing in the next ${ui.window} miles</div>${ui.category === null ? 'Try a longer window.' : `No exits or rest areas with ${CATEGORY_NAMES[ui.category]} in this window.`}</div>`;
  return `<div class="stack">${windowSeg}${chips}${tools}${list}${attribution()}</div>`;
}

export function exitDetail(app, exitId) {
  const plan = app.plan;
  const exit = plan?.exits.find((e) => e.id === exitId);
  if (!exit) return '<div class="empty">Exit not found on this route.</div>';
  const s = app.snapshot;
  const services = app.servicesFor(exit);
  const ahead = s ? exit.distanceAlongRoute - s.progress : null;
  let groups = '';
  for (let cat = 1; cat < CATEGORY_NAMES.length; cat++) {
    const items = services.filter((x) => x.place.category === cat);
    if (!items.length) continue;
    groups += `<div class="section-title"><span class="plaque ${BROWN.has(cat) ? 'brown' : 'blue'} tag"><b>${PLAQUE_WORDS[cat] ?? CATEGORY_NAMES[cat].toUpperCase()}</b></span> ${items.length}</div><div class="list">${items.map((x) => serviceRow(x)).join('')}</div>`;
  }
  const c = exit.coordinate;
  return `<div class="sheet-head">${exitSign(exit.label)}<h2>${h(exit.name || (exit.label ? 'Exit services' : exitTitle(exit)))}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0">${ahead !== null && ahead > 0 ? `${miles(ahead)} ahead · ${duration(s.etaTo(exit.distanceAlongRoute) - s.t)} · ` : ''}${exit.highways.length ? h(exit.highways.join(' · ')) : ''}</p>
    <div class="btn-row"><a class="btn sm" href="https://maps.apple.com/?ll=${c.lat},${c.lon}&q=${encodeURIComponent(exitTitle(exit))}" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a></div>
    ${priceSection(app, exit)}
    ${groups || '<div class="card empty">No services are linked to this exit in the offline data.</div>'}
    <p class="note">Detours are round trip estimates from the exit. Routed values come from OpenStreetMap drive times (OpenInterstate reachability); others are straight line estimates and are labeled. Hours, ratings, prices and amenities are not in the offline data.</p>${attribution()}`;
}

export function restAreaDetail(app, id) {
  const r = app.plan?.restAreas.find((x) => x.id === id);
  if (!r) return '<div class="empty">Rest area not found on this route.</div>';
  const s = app.snapshot;
  const ahead = s ? r.distanceAlongRoute - s.progress : null;
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
    <p class="muted small" style="margin-top:0">${ahead !== null && ahead > 0 ? `${miles(ahead)} ahead · ${duration(s.etaTo(r.distanceAlongRoute) - s.t)} · ` : ''}${h(r.road)} · ${r.side === 'both' ? 'In the median or on an undivided road: serves both directions' : 'On your side of the highway'}</p>
    <div class="btn-row"><a class="btn sm" href="https://maps.apple.com/?ll=${c.lat},${c.lon}&q=${encodeURIComponent(restAreaTitle(r))}" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a></div>
    <div class="section-title">Amenities listed</div>${am}
    ${hours ? `<div class="section-title">🕐 Hours</div><div class="card small">${h(hours)}</div>` : ''}
    ${names('Gas', '⛽', r.gas)}${names('Food', '🍴', r.food)}${names('EV charging', '⚡', r.ev)}
    ${trucks ? `<div class="section-title">🚛 Truck parking</div><div class="card small">${h(trucks)}</div>` : ''}
    <p class="note">Source: OpenStreetMap ${osm}${r.checked ? `, last checked by a mapper ${h(r.checked)}` : ''}${r.nameSource === 'fhwa' ? '. Name from the FHWA truck parking survey' : ''}. ExitAtlas cannot see closures; check state DOT notices for long trips.</p>${attribution()}`;
}

function priceSection(app, exit) {
  if (app.settings.vehicle?.ev) return '';
  if (!app.prices.enabled) return '<p class="muted tiny">Live gas prices: add a Google Maps key in Settings.</p>';
  const c = app.prices.peek(exit.id);
  if (!c) return '<div class="section-title">⛽ Gas prices near this exit</div><div class="card empty">Loading prices…</div>';
  if (c.error) return `<div class="section-title">⛽ Gas prices near this exit</div><div class="card small">Prices unavailable: ${h(c.error)}</div>`;
  const g = GRADES[app.gradeCode()];
  const rows = [...c.stations].sort((a, b) => (a.prices[g.key]?.value ?? 99) - (b.prices[g.key]?.value ?? 99)).map((st) => {
    const p = st.prices[g.key];
    const others = Object.entries(GRADES).filter(([, x]) => x.key !== g.key && st.prices[x.key]).map(([, x]) => `${x.name} ${priceText(st.prices[x.key])}`).join(' · ');
    const fav = matchesFavorite(st.name, app.settings.favoriteBrands);
    return `<div class="item"><div class="main"><div class="t">${fav ? '★ ' : ''}${h(st.name)}</div><div class="muted tiny">${p ? `${g.name} · ${ageText(p.updated)}` : 'No price reported'}${others ? ` · ${others}` : ''}</div></div>
      <div class="side"><div class="big">${p ? priceText(p) : '—'}</div></div></div>`;
  });
  return `<div class="section-title">⛽ Gas prices near this exit</div>${rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="card empty">No gas stations found by Google near this exit.</div>'}
    <p class="attrib">Prices: <span class="gattr">Google Maps</span>, within 1 mile of the exit. Not stored.</p>`;
}

function serviceRow(x) {
  const p = x.place;
  const detour = x.detourBasis === 'routed'
    ? `Detour ${miles(x.detourMeters)} round trip${x.detourSeconds !== null ? ` · about ${duration(x.detourSeconds)}` : ''}`
    : `Roughly ${miles(x.detourMeters)} round trip (straight line estimate)`;
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
  let html = `<div class="stack"><div class="card" style="padding:8px">${map}</div><div class="card">${summary}</div>`;
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
  html += `<div class="stack">${app.mode === 'trip' ? '<button class="btn block" data-act="sheet" data-arg="stop">🛏️ Plan a stop ahead</button>' : ''}
    <div class="btn-row"><button class="btn" data-act="share-card">🖼️ Share trip card</button><button class="btn" data-act="sheet" data-arg="plates">🚗 License plates</button></div>
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
      <a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${it.lat},${it.lon}" target="_blank" rel="noopener">Google Maps</a>
      ${it.wiki ? `<a class="btn sm" href="${h(it.wiki)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}</div>
    ${app.canAddStop() ? `<button class="btn primary block" style="margin-top:12px" data-act="add-place-stop" data-arg="${h(it.id)}">Add to trip</button>` : '<p class="muted tiny">Adding it to the trip reroutes through it, which needs live GPS (not the demo).</p>'}
    <p class="note">From Wikidata (${h(it.id)}, CC0): linked from ${it.sitelinks} Wikimedia sites (Wikipedia editions and sister projects). Hours, fees and closures are not in this data.</p>`;
}

/// Passenger game: tap the plates you spot. Kept for the current trip on this phone.
export function platesSheet(app) {
  const seen = new Set(app.plates.seen);
  return `<div class="sheet-head"><h2>License plates</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0">For passengers: tap each state's plate when you spot it. <b>${seen.size}</b> of ${STATE_CODES.length} on this trip.</p>
    <div class="plates">${STATE_CODES.map((c) => `<button class="plate${seen.has(c) ? ' on' : ''}" data-act="plate" data-arg="${c}" aria-pressed="${seen.has(c)}">${c}</button>`).join('')}</div>
    <button class="btn block" style="margin-top:14px" data-act="plates-reset">Start over</button>`;
}

/// Road Trip Passport: states and achievements from real GPS trips.
function passportSection(app) {
  const p = passport(app.history);
  const earned = p.achievements.filter((a) => a.earned);
  const next = p.achievements.filter((a) => !a.earned).sort((a, b) => b.progress - a.progress).slice(0, 3);
  return `<div class="card"><div class="metrics two">${metric('States driven', String(p.states.size), { caption: `of ${STATE_CODES.length}`, size: 'md' })}${metric('Miles tracked', Math.round(p.totalMeters / MILE).toLocaleString('en-US'), { caption: `${p.tripCount} ${p.tripCount === 1 ? 'trip' : 'trips'}`, size: 'md' })}</div>
    <div class="plates passport">${STATE_CODES.map((c) => `<span class="plate${p.states.has(c) ? ' on' : ''}" title="${p.states.has(c) ? h(`${p.states.get(c).name}: ${miles(p.states.get(c).meters)}`) : ''}">${c}</span>`).join('')}</div>
    ${earned.length ? `<div class="section-title">Earned</div>${earned.map((a) => `<div class="ach on">★ ${h(a.title)}</div>`).join('')}` : ''}
    ${next.length ? `<div class="section-title">Next up</div>${next.map((a) => `<div class="ach"><div class="row"><span style="flex:1">${h(a.title)}</span><span class="muted tiny">${h(a.detail)}</span></div>${progress(a.progress)}</div>`).join('')}` : ''}
    <button class="btn block" style="margin-top:12px" data-act="share-passport" ${p.tripCount ? '' : 'disabled'}>🖼️ Share passport</button>
    <p class="note" style="margin:10px 0 0">Real GPS trips only, saved on this phone. Simulated drives and discovery mode are not counted.</p></div>`;
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
      <div class="field"><span style="flex:1">Appearance</span><div class="seg" style="width:200px">${['auto', 'light', 'dark'].map((t) => `<button class="${st.theme === t ? 'on' : ''}" data-act="theme" data-arg="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Speedometer</div><div class="list">
      <div class="field"><span style="flex:1">Turn red when over the limit by<div class="muted tiny">Amber from 1 mph over. Limits are OpenStreetMap posted speeds via Valhalla; not every road has one.</div></span>
        <div class="seg" style="width:190px">${[0, 5, 10, 15].map((v) => `<button class="${st.speedAlertOver === v ? 'on' : ''}" data-act="speed-alert" data-arg="${v}">${v}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Vehicle and fuel</div>${vehicleSettings(app)}</div>
    <div><div class="section-title">Stretches without gas</div><div class="list">
      <div class="field"><span style="flex:1">Warn when the next gas is more than<div class="muted tiny">Counts exits with a gas station listed and service plazas with gas. Shown in Exits and on the Drive screen.</div></span>
        <div class="seg" style="width:190px">${[25, 40, 60, 80].map((v) => `<button class="${st.gasGapMiles === v ? 'on' : ''}" data-act="gas-gap" data-arg="${v}">${v}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Favorite gas</div>${fuelPreferences(app)}</div>
    <div><div class="section-title">Overnight driving</div>${overnightSettings(app)}</div>
    <div><div class="section-title">Gas prices</div><div class="card small">${priceSettings(app)}</div></div>
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
    <div><div class="section-title">Road Trip Passport</div>${passportSection(app)}</div>
    <div><div class="section-title">Your profile</div>${profileSection(app)}</div>
    <div><div class="section-title">Data and licenses</div><div class="card small">
      ${dataVersionLine(app.dataStatus)}
      <p><b>State lines:</b> ${meta(app.data?.states.metadata)}</p>
      <p><b>Time zones:</b> ${meta(app.data?.zoneIndex.metadata)}</p>
      <p><b>Exits and places:</b> ${meta(app.data?.interstates.metadata)}. © OpenStreetMap contributors, ODbL 1.0.</p>
      <p><b>Rest areas and service plazas:</b> ${app.data?.restAreas ? h(`OpenStreetMap, tags checked ${app.data.restAreas.metadata.tags_fetched}; truck parking from the FHWA survey (2019, public domain)`) : 'not loaded'}. Amenities show only what mappers have tagged.</p>
      <p><b>Gas station hours and restrooms:</b> ${app.data?.stations ? h(`OpenStreetMap, tags checked ${app.data.stations.metadata.tags_fetched}: hours for ${app.data.stations.metadata.with_hours.toLocaleString('en-US')} and restroom tags for ${app.data.stations.metadata.with_toilets} of ${app.data.stations.metadata.count.toLocaleString('en-US')} stations; ${app.data.stations.metadata.gone} no longer listed as gas stations are never recommended`) : 'not loaded'}. Shown as reported, not verified. With a Google key, Google's business hours and restroom field for the stations whose prices load.</p>
      <p><b>Discover ahead:</b> ${app.data?.discover ? h(`${app.data.discover.metadata.count.toLocaleString('en-US')} places from Wikidata (CC0), fetched ${app.data.discover.metadata.fetched}`) : 'not loaded'}. Hours, fees and closures are not included.</p>
      <p><b>Routing:</b> OSRM demo server (router.project-osrm.org) on OpenStreetMap data. Light personal use only.</p>
      <p><b>Place search:</b> Nominatim (nominatim.openstreetmap.org), searched only when you tap Search.</p>
      <p><b>Gas prices:</b> Google Maps Places API with your key (Settings, Gas prices). Off without a key.</p>
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
  const prices = !ev && fp?.stations.length && app.prices.enabled ? '<p class="attrib">Prices: <span class="gattr">Google Maps</span>. Not stored.</p>' : '';
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
    <p class="note">${ev ? `DC fast chargers within 2.5 miles of the route from the U.S. DOE Alternative Fuels Data Center (${st.chargerNetwork === 'Tesla' ? 'Tesla Superchargers' : 'all networks'}). Detours are straight line estimates.` : 'Gas stations linked to interstate exits in OpenStreetMap. Detours count against your range.'}${!ev && !app.prices.enabled ? ' Live prices: add a Google Maps key in Settings.' : ''}</p></div>`;
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

function priceSettings(app) {
  const calls = app.priceCalls();
  return `<p style="margin-top:0">Live prices per station come from Google Maps (Places API), using your own key. Without a key, ExitAtlas shows stations but no prices.</p>
    <label class="row" style="gap:8px"><span style="flex:1">Google Maps API key</span><input type="password" autocomplete="off" data-secret="ea.googleKey" placeholder="Paste key" value="${h(app.secret('ea.googleKey'))}" style="width:150px;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"></label>
    <p class="muted tiny">Get one at console.cloud.google.com: create a project, enable "Places API (New)", add billing, create an API key, and restrict it to the website altecbx.github.io and to Places API (New). Google bills each price lookup at $40 per 1,000 after 1,000 free a month (Enterprise + Atmosphere tier). ExitAtlas looks up one exit at a time, at most every 15 minutes per exit. This month: ${calls} lookups.</p>
    <p class="muted tiny">Prices are shown with Google Maps attribution, never on the map, and are not saved.</p>
    <label class="row" style="gap:8px"><span style="flex:1">ExitAtlas key proxy<div class="muted tiny">${app.proxy ? `Connected: prices ${app.proxy.prices ? 'on' : 'off'}, chargers ${app.proxy.chargers ? 'on' : 'off'}${app.proxy.disabled.length ? `; switched off: ${h(app.proxy.disabled.join(', '))}` : ''}.` : 'Optional. The owner\'s Cloudflare Worker (infra/worker) with its own keys and daily limits.'}</div></span><input type="url" autocomplete="off" data-secret="ea.proxyURL" placeholder="https://" value="${h(app.secret('ea.proxyURL'))}" style="width:150px;border:1px solid var(--stroke);border-radius:10px;padding:9px;background:var(--bg)"></label>`;
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
