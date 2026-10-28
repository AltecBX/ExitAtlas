// Screen templates. Pure functions of app state that return HTML strings.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { highwayLabel, DIRECTION_WORDS } from '../engine/route.js';
import { CATEGORY_NAMES, placeDisplayName } from '../engine/datasets.js';
import { exitTitle } from '../engine/exits.js';
import { miles, milesValue, duration, clock, escapeHTML as h } from './format.js';
import { renderRouteMap } from './map.js';

export const CATEGORY_ICONS = ['📍', '⛽', '🍴', '🛏️', '🚻', '⚡', '🌳', '🐾'];
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

export function exitSign(label, compact = false) {
  return `<span class="exit-sign${compact ? ' compact' : ''}" aria-label="${label ? `Exit ${h(label)}` : 'Unnumbered exit'}"><span class="e">EXIT</span><span class="n">${label ? h(label) : '—'}</span></span>`;
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

export function serviceSummary(services) {
  const counts = new Map();
  for (const s of services) counts.set(s.place.category, (counts.get(s.place.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0])
    .map(([cat, n]) => `<span class="svc" title="${CATEGORY_NAMES[cat]}">${CATEGORY_ICONS[cat]} ${n}</span>`).join('');
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
  return '<div class="attrib">Routing and map data © OpenStreetMap contributors (ODbL). Exits and places: OpenInterstate. State lines: U.S. Census TIGER/Line. Not affiliated with iExit.</div>';
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
  return `<div class="stack">${resume}
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

function dashboard(app, s) {
  const discovery = app.mode === 'discovery';
  const parts = [cluster(app, s)];
  if (s.current) parts.push(borderCard(s));
  if (s.nextExit) parts.push(nextExitCard(app, s));
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
  return `<div class="card lg">${body}
    <div style="margin-top:14px">${progress(cur.fractionComplete)}
    <div class="row muted tiny" style="margin-top:6px"><span>${miles(cur.drivenMeters)} of ${miles(cur.totalMeters)} in ${h(cur.segment.displayName)}</span><span class="spacer"></span><span>${cur.exitCount} exits total</span></div></div></div>`;
}

function nextExitCard(app, s) {
  const ne = s.nextExit;
  const services = app.servicesFor(ne.exit);
  return `<button class="card row" style="width:100%;text-align:left;cursor:pointer" data-act="exit" data-arg="${h(ne.exit.id)}">
    ${exitSign(ne.exit.label)}
    <div style="flex:1;min-width:0"><div class="eyebrow">Next exit</div>
      ${ne.exit.name ? `<div style="font-weight:700">${h(ne.exit.name)}</div>` : ''}
      ${services.length ? `<div class="services">${serviceSummary(services)}</div>` : '<div class="muted small">No services listed</div>'}</div>
    <div style="text-align:right"><div class="num" style="font-weight:800;font-size:30px;line-height:1">${milesValue(ne.distance)}</div>
      <div class="muted tiny">mi · ${duration(ne.eta - s.t)}</div></div></button>`;
}

function fuelCard(app, s) {
  const fp = app.fuelPlan();
  if (!fp) {
    return `<button class="card row" style="width:100%;text-align:left;cursor:pointer" data-act="sheet" data-arg="fuel">
      <span style="font-size:26px">⛽</span><div style="flex:1"><div class="eyebrow">Fuel</div><div style="font-weight:700">Enter miles to empty</div>
      <div class="muted small">From your dashboard. ExitAtlas finds the exit where you will have about ${app.settings.bufferMiles} mi left.</div></div><span class="chev">›</span></button>`;
  }
  const rec = fp.recommended;
  let body;
  if (fp.status === 'destination') {
    body = `<div style="font-weight:700">No stop needed</div><div class="muted small">You reach your destination with about ${miles(fp.destinationSpare)} left.</div>`;
  } else if (fp.status === 'none') {
    body = `<div style="font-weight:700;color:var(--danger)">No interstate gas listed before empty</div><div class="muted small">Leave the highway for gas. Turnpikes and US routes have no exit data yet.</div>`;
  } else {
    const low = fp.status === 'low';
    body = `<div class="row" style="gap:10px;margin-top:2px">${exitSign(rec.exit.label, true)}<div style="flex:1;min-width:0">
        <div style="font-weight:700${low ? ';color:var(--amber)' : ''}">${low ? 'Fuel low: nearest gas' : 'Fuel stop'} · ${milesValue(rec.ahead)} mi</div>
        <div class="muted small">${h(stationNames(rec))}</div>
        <div class="muted tiny">${clock(rec.eta, app.plan.timeZoneIDAt(rec.exit.distanceAlongRoute), s.t)} · about ${miles(rec.rangeOnArrival)} left when you get there</div></div></div>`;
  }
  return `<button class="card" style="width:100%;text-align:left;cursor:pointer;display:block" data-act="sheet" data-arg="fuel">
    <div class="row"><div class="eyebrow" style="flex:1">⛽ Fuel</div><div class="num" style="font-weight:800">${milesValue(fp.range)}<span class="muted small"> mi to empty</span></div></div>${body}</button>`;
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
    ${metric('Destination', milesValue(s.remaining), { unit: 'mi', size: 'md' })}
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
  let bi = 0;
  const borderRow = (f) => {
    const d = f.segment.startDistance - s.progress;
    return `<div class="item border-row">${badge(f.segment.code, true)}<div class="main"><div class="t">Entering ${h(f.segment.displayName)}${f.segment.visit > 1 ? ' (again)' : ''}</div>
      <div class="muted small">${miles(f.totalMeters)} on route · ${f.exitCount} exits</div></div>
      <div class="side"><div class="big">${milesValue(d)}</div><div class="muted tiny">${f.entryTime !== null ? clock(f.entryTime, f.entryTimeZoneID, s.t) : ''}</div></div></div>`;
  };
  const fp = app.fuelPlan();
  const fuelStopID = fp && fp.status !== 'destination' ? fp.recommended?.exit.id : null;
  for (const u of s.upcomingExits) {
    if (u.distance > window) break;
    while (bi < borders.length && borders[bi].segment.startDistance <= u.exit.distanceAlongRoute) rows.push(borderRow(borders[bi++]));
    const services = app.servicesFor(u.exit);
    if (ui.category !== null && !services.some((x) => x.place.category === ui.category)) continue;
    const fuelStop = fuelStopID === u.exit.id;
    rows.push(`<button class="item" data-act="exit" data-arg="${h(u.exit.id)}">${exitSign(u.exit.label, true)}
      <div class="main"><div class="t">${h(u.exit.name || exitTitle(u.exit))}</div>
      ${fuelStop ? '<div class="amber-text tiny">⛽ Planned fuel stop</div>' : ''}
      ${services.length ? `<div class="services">${serviceSummary(services)}</div>` : '<div class="muted small">No services listed</div>'}
      ${u.exit.confidence === 'medium' ? '<div class="muted tiny">Direction not verified in source data</div>' : ''}</div>
      <div class="side"><div class="big">${milesValue(u.distance)}</div><div class="muted tiny">${duration(u.eta - s.t)}</div></div></button>`);
  }
  while (bi < borders.length) rows.push(borderRow(borders[bi++]));
  const list = rows.length ? `<div class="list">${rows.join('')}</div>`
    : `<div class="card empty"><div class="t">No exits in the next ${ui.window} miles</div>${ui.category === null ? 'Try a longer window.' : `No exits with ${CATEGORY_NAMES[ui.category]} in this window.`}</div>`;
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
    groups += `<div class="section-title">${CATEGORY_ICONS[cat]} ${CATEGORY_NAMES[cat]}</div><div class="list">${items.map((x) => serviceRow(x)).join('')}</div>`;
  }
  const c = exit.coordinate;
  return `<div class="sheet-head">${exitSign(exit.label)}<h2>${h(exit.name || exitTitle(exit))}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin-top:0">${ahead !== null && ahead > 0 ? `${miles(ahead)} ahead · ${duration(s.etaTo(exit.distanceAlongRoute) - s.t)} · ` : ''}${exit.highways.length ? h(exit.highways.join(' · ')) : ''}</p>
    <div class="btn-row"><a class="btn sm" href="https://maps.apple.com/?ll=${c.lat},${c.lon}&q=${encodeURIComponent(exitTitle(exit))}" target="_blank" rel="noopener">Apple Maps</a>
      <a class="btn sm" href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}" target="_blank" rel="noopener">Google Maps</a></div>
    ${groups || '<div class="card empty">No services are linked to this exit in the offline data.</div>'}
    <p class="note">Detours are round trip estimates from the exit. Routed values come from OpenStreetMap drive times (OpenInterstate reachability); others are straight line estimates and are labeled. Hours, ratings, prices and amenities are not in the offline data.</p>${attribution()}`;
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
    ${discovery ? '' : metric('Arrive', clock(s.eta, null, s.t), { size: 'sm' })}</div>`;
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
      <div class="muted tiny">${f.entryTime !== null ? `Enter ${clock(f.entryTime, f.entryTimeZoneID, s.t)}` : ''}${f.plannedDuration !== null ? ` · ${duration(f.plannedDuration)}` : ''} · ${f.exitCount} exits</div>
      ${f.segment.isBrief ? '<div class="amber-text tiny">Brief crossing</div>' : ''}</div>
      <div class="side num" style="font-weight:800">${miles(f.totalMeters)}</div></div>`).join('')}</div></div>`;
  }
  html += `<div class="stack">${app.mode === 'trip' ? '<button class="btn block" data-act="sheet" data-arg="stop">🛏️ Plan a stop ahead</button>' : ''}
    <button class="btn block" data-act="share">Share itinerary</button>
    <button class="btn danger block" data-act="end">End ${discovery ? 'discovery mode' : 'trip'}</button></div>${attribution()}</div>`;
  return html;
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
    <div class="btn-row"><button class="btn sm" data-act="add-stop">＋ Add stop</button><button class="btn sm primary" data-act="find-routes" ${p.to && !p.busy ? '' : 'disabled'}>${p.busy ? 'Finding routes…' : 'Find routes'}</button></div>`;
  if (p.error) html += `<p class="amber-text small">${h(p.error)}</p>`;
  if (p.results.length) {
    html += `<div class="section-title">Routes</div>${p.results.map((r, i) => routeCard(r, i, p.results.length, app)).join('')}
      <p class="note">Travel times come from the free OSRM routing server and do not include live traffic. ExitAtlas learns your actual pace as you drive and updates every arrival time. Avoid tolls is not available on this server.</p>`;
  }
  if (!p.results.length && p.recent.length) {
    html += `<div class="section-title">Recent destinations</div><div class="list">${p.recent.map((w, i) => `<button class="item" data-act="recent" data-arg="${i}"><div class="main"><div class="t">${h(w.name)}</div></div><span class="chev">›</span></button>`).join('')}</div>`;
  }
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
  const life = app.lifetime();
  const meta = (m) => (m ? h(`${m.source ?? ''}${m.generated_at ? `, built ${m.generated_at.slice(0, 10)}` : ''}`) : 'not loaded');
  return `<div class="stack">
    <div><div class="section-title">Voice</div><div class="list">
      ${toggle('voice', 'Spoken announcements', app.announcer.supported ? '' : 'Not supported in this browser')}
      ${toggle('announceStateLines', 'State lines', '5 miles before, and on entry')}
      ${toggle('announceExits', 'Exits', '1 mile before each exit')}
      <div class="field"><span style="flex:1">Test the voice</span><button class="btn sm" data-act="test-voice">Speak</button></div></div></div>
    <div><div class="section-title">Screen</div><div class="list">
      ${toggle('keepAwake', 'Keep screen awake while driving', app.wake.supported ? (app.wake.active ? 'Active now' : 'Turns on when a drive starts') : 'Not supported here. Set Auto Lock to Never for the drive.')}
      <div class="field"><span style="flex:1">Appearance</span><div class="seg" style="width:200px">${['auto', 'light', 'dark'].map((t) => `<button class="${st.theme === t ? 'on' : ''}" data-act="theme" data-arg="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Speedometer</div><div class="list">
      <div class="field"><span style="flex:1">Turn red when over the limit by<div class="muted tiny">Amber from 1 mph over. Limits are OpenStreetMap posted speeds via Valhalla; not every road has one.</div></span>
        <div class="seg" style="width:190px">${[0, 5, 10, 15].map((v) => `<button class="${st.speedAlertOver === v ? 'on' : ''}" data-act="speed-alert" data-arg="${v}">${v}</button>`).join('')}</div></div></div></div>
    <div><div class="section-title">Vehicle and fuel</div>${vehicleSettings(app)}</div>
    <div><div class="section-title">Arrival times</div><div class="card small">${paceSettings(app)}</div></div>
    <div><div class="section-title">Lifetime</div><div class="card"><div class="metrics two">${metric('Miles tracked', Math.round(life.meters / MILE).toLocaleString('en-US'), { size: 'md' })}${metric('States driven', String(life.states.length), { caption: life.states.join(' · '), size: 'md' })}</div>
      <p class="note" style="margin:10px 0 0">Real GPS trips only, saved on this phone.</p></div></div>
    <div><div class="section-title">Data and licenses</div><div class="card small">
      <p style="margin-top:0"><b>State lines:</b> ${meta(app.data?.states.metadata)}</p>
      <p><b>Time zones:</b> ${meta(app.data?.zoneIndex.metadata)}</p>
      <p><b>Exits and places:</b> ${meta(app.data?.interstates.metadata)}. © OpenStreetMap contributors, ODbL 1.0.</p>
      <p><b>Routing:</b> OSRM demo server (router.project-osrm.org) on OpenStreetMap data. Light personal use only.</p>
      <p><b>Place search:</b> Nominatim (nominatim.openstreetmap.org), searched only when you tap Search.</p>
      <p style="margin-bottom:0" class="muted">No fuel prices: there is no licensed price source yet, so none are shown. Exit and services data are from July 2026 OpenStreetMap and can be out of date.</p></div></div>
    <button class="btn danger block" data-act="clear-data">Erase saved trips and settings</button>
    <p class="note">ExitAtlas web ${h(app.version)}. Not affiliated with iExit or Nexit.</p></div>`;
}

// MARK: Sheets

export function placeSearchSheet(app) {
  const ps = app.placeSearch;
  const label = ps.field === 'from' ? 'Start' : ps.field === 'to' ? 'Destination' : 'Stop';
  return `<div class="sheet-head"><h2>${label}</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <form class="row" data-form="place-search"><input type="search" name="q" placeholder="City, address or place" value="${h(ps.query)}" autocomplete="off" style="flex:1;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card)" enterkeyhint="search">
      <button class="btn primary sm" type="submit" ${ps.busy ? 'disabled' : ''}>${ps.busy ? '…' : 'Search'}</button></form>
    ${ps.field === 'from' ? '<div class="list" style="margin-top:12px"><button class="item" data-act="use-current"><div class="main"><div class="t">📍 Current location</div></div></button></div>' : ''}
    ${ps.error ? `<p class="amber-text small">${h(ps.error)}</p>` : ''}
    ${ps.results.length ? `<div class="list" style="margin-top:12px">${ps.results.map((r, i) => `<button class="item" data-act="choose-place" data-arg="${i}"><div class="main"><div class="t">${h(r.name)}</div><div class="muted tiny">${h(r.detail)}</div></div></button>`).join('')}</div>` : ''}
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

export function fuelSheet(app) {
  const st = app.settings;
  const ui = app.fuelUI;
  const v = app.vehicleProfile();
  const full = v?.tankGallons ? v.tankGallons * v.mpg : null;
  const fp = app.fuelPlan();
  const range = app.rangeNow();
  const vehicleLine = v
    ? `<div class="row"><div style="flex:1;min-width:0"><div style="font-weight:700">${h(`${v.year} ${v.make} ${v.model}`)}</div>
        <div class="muted tiny">${h(v.label)}</div>
        <div class="muted small">${v.mpg} mpg ${basisName(st)}${v.tankGallons ? ` · ${v.tankGallons} gal · about ${Math.round(full)} mi per tank` : ' · tank size not set'}</div></div>
        <button class="btn sm" data-act="vehicle">Change</button></div>`
    : `<div class="row"><div style="flex:1"><div style="font-weight:700">No vehicle selected</div><div class="muted small">Pick your car to get EPA MPG and tank size.</div></div><button class="btn sm primary" data-act="vehicle">Choose</button></div>`;
  const input = ui.mode === 'gauge' && v?.tankGallons
    ? `<div class="row"><input type="range" min="0" max="8" step="1" value="${ui.gaugeEighths}" data-gauge style="flex:1;accent-color:var(--sign-green)"><span class="num" style="width:110px;text-align:right;font-weight:800" data-gauge-label>${gaugeText(ui.gaugeEighths, v)}</span></div>
       <p class="muted tiny" style="margin:4px 0 0">Uses ${v.mpg} mpg ${basisName(st)}. Your dashboard's miles to empty is more accurate.</p>`
    : `<div class="row"><input type="number" name="dte" inputmode="numeric" min="0" max="1500" placeholder="Miles to empty" value="${range !== null ? Math.round(range / 1609.344) : ''}" style="flex:1;border:1px solid var(--stroke);border-radius:12px;padding:12px;background:var(--card);font-size:20px;font-weight:700"><span class="muted">mi</span></div>
       <p class="muted tiny" style="margin:4px 0 0">The range your dashboard shows. It counts down as you drive; update it any time.</p>`;
  let plan = '';
  if (fp) {
    const rec = fp.recommended;
    if (fp.status === 'destination') {
      plan = `<div class="card"><div style="font-weight:700">No fuel stop needed</div><div class="muted small">You reach your destination with about ${miles(fp.destinationSpare)} left.</div></div>`;
    } else if (fp.status === 'none') {
      plan = `<div class="banner warn" style="margin:0">No gas is listed at interstate exits before empty. Leave the highway for gas. Turnpikes and US routes have no exit data yet.</div>`;
    } else {
      const row = (x, tag) => `<button class="item" data-act="exit" data-arg="${h(x.exit.id)}">${exitSign(x.exit.label, true)}<div class="main">
          ${tag ? `<div class="eyebrow${tag.amber ? ' amber' : ''}">${tag.text}</div>` : ''}<div class="t">${h(stationNames(x))}</div>
          <div class="muted tiny">${clock(x.eta, app.plan.timeZoneIDAt(x.exit.distanceAlongRoute), app.snapshot.t)} · arrive with about ${miles(x.rangeOnArrival)}${x.preferred ? ' · preferred brand' : ''}</div></div>
          <div class="side"><div class="big">${milesValue(x.ahead)}</div><div class="muted tiny">mi</div></div></button>`;
      const items = [row(rec, { text: fp.status === 'low' ? 'Nearest gas (below your buffer)' : `Fill up here · about ${st.bufferMiles} mi left`, amber: fp.status === 'low' })];
      for (const e of fp.earlier) items.push(row(e, { text: 'Earlier option' }));
      if (fp.lastChance) items.push(row(fp.lastChance, { text: 'Last gas before empty', amber: true }));
      plan = `<div class="list">${items.join('')}</div>`;
    }
  } else if (range !== null && !app.snapshot) {
    plan = `<p class="muted small">Range saved: ${miles(range)}. Start a trip or discovery mode to see where to fill up.</p>`;
  }
  const others = fp && fp.stations.length
    ? `<div class="section-title">All gas within range (${fp.stations.length})</div><div class="list">${fp.stations.slice(0, 40).map((x) => `<button class="item" data-act="exit" data-arg="${h(x.exit.id)}">${exitSign(x.exit.label, true)}<div class="main"><div class="t">${h(stationNames(x))}</div>
        <div class="muted tiny">arrive with about ${miles(x.rangeOnArrival)}</div></div><div class="side"><div class="big">${milesValue(x.ahead)}</div><div class="muted tiny">mi</div></div></button>`).join('')}</div>` : '';
  return `<div class="sheet-head"><h2>Fuel stop</h2><button class="x" data-act="close-sheet" aria-label="Close">✕</button></div>
    <div class="stack">
    <div class="card">${vehicleLine}</div>
    <form class="card" data-form="fuel">
      <div class="row" style="margin-bottom:8px"><div class="eyebrow" style="flex:1">Range now</div>
        ${v?.tankGallons ? `<div class="seg" style="width:190px"><button type="button" class="${ui.mode !== 'gauge' ? 'on' : ''}" data-act="fuel-mode" data-arg="dashboard">Miles</button><button type="button" class="${ui.mode === 'gauge' ? 'on' : ''}" data-act="fuel-mode" data-arg="gauge">Gauge</button></div>` : ''}</div>
      ${input}
      ${ui.error ? `<p class="amber-text small">${h(ui.error)}</p>` : ''}
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" type="submit">Save range</button>
        <button class="btn" type="button" data-act="fuel-filled">I filled up</button></div>
      <div class="section-title">Fill up with about this much left</div>
      <div class="seg">${[25, 50, 75, 100].map((b) => `<button type="button" class="${st.bufferMiles === b ? 'on' : ''}" data-act="fuel-buffer" data-arg="${b}">${b} mi</button>`).join('')}</div>
    </form>
    ${plan}${others}
    <p class="note">Only gas stations linked to interstate exits in OpenStreetMap are listed. Detours count against your range. No fuel prices: there is no licensed price source yet.</p></div>`;
}

function basisName(st) {
  return st.mpgBasis === 'custom' ? '(your mpg)' : st.mpgBasis === 'combined' ? 'combined (EPA)' : 'highway (EPA)';
}

export function gaugeText(eighths, v) {
  const label = ['Empty', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', 'Full'][eighths];
  return `${label} · ${Math.round(eighths / 8 * v.tankGallons * v.mpg)} mi`;
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
  const recent = app.recentVehicles.filter((r) => !v || r.epaId !== v.epaId).slice(0, 5);
  return `<div class="list">
    <div class="field"><span style="flex:1">${v ? `<b>${h(`${v.year} ${v.make} ${v.model}`)}</b><div class="muted tiny">${h(v.label)}</div>
      <div class="muted tiny">EPA ${v.city} city · ${v.hwy} highway · ${v.comb} combined mpg${v.tankGallons ? ` · ${v.tankGallons} gal tank (${v.tankBasis === 'entered' ? 'entered by you' : 'verified'})` : ' · tank size not set'}</div>` : 'No vehicle selected'}</span>
      <button class="btn sm${v ? '' : ' primary'}" data-act="vehicle">${v ? 'Change' : 'Choose'}</button></div>
    ${recent.map((r, i) => `<button class="wp" style="width:100%;background:transparent;border-left:0;border-right:0;border-bottom:0;text-align:left" data-act="vehicle-recent" data-arg="${i}"><span class="name">${h(`${r.year} ${r.make} ${r.model}`)}<div class="muted tiny" style="font-weight:400">${h(r.label)}</div></span><span class="muted small">Switch</span></button>`).join('')}
    <div class="field"><span style="flex:1">MPG for range</span><div class="seg" style="width:220px">${[['highway', 'Highway'], ['combined', 'Combined'], ['custom', 'My MPG']].map(([k, n]) => `<button class="${st.mpgBasis === k ? 'on' : ''}" data-act="mpg-basis" data-arg="${k}">${n}</button>`).join('')}</div></div>
    ${st.mpgBasis === 'custom' ? `<label class="field"><span style="flex:1">My real MPG<div class="muted tiny">Interstate speeds often use more fuel than the EPA highway test</div></span><input type="number" inputmode="decimal" step="0.5" min="1" data-set="customMpg" value="${st.customMpg ?? ''}"></label>` : ''}
    <div class="field"><span style="flex:1">Fill up with about</span><div class="seg" style="width:220px">${[25, 50, 75, 100].map((b) => `<button class="${st.bufferMiles === b ? 'on' : ''}" data-act="fuel-buffer" data-arg="${b}">${b} mi</button>`).join('')}</div></div>
    <label class="field"><span style="flex:1">Preferred gas brands<div class="muted tiny">Comma separated, for example Wawa, Sheetz, Buc-ee's</div></span><input type="text" data-set="preferredBrands" data-kind="text" value="${h(st.preferredBrands)}" style="width:150px"></label>
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
    const [label, city, hwy, comb, , tankIdx] = ver;
    const tank = tankIdx >= 0 ? app.vehicles.tanks[tankIdx] : null;
    const query = encodeURIComponent(`${vp.year} ${vp.make} ${vp.model} ${label.split(' · ')[0]} fuel tank capacity gallons`);
    let tankUI;
    if (tank && tank.gallons.length === 1) {
      tankUI = `<div class="field"><span style="flex:1">Tank<div class="muted tiny">Verified: ${tank.sources.map((u, i) => `<a href="${h(u)}" target="_blank" rel="noopener">source ${i + 1}</a>`).join(', ')}</div></span><b class="num">${tank.gallons[0]} gal</b></div>`;
    } else if (tank) {
      tankUI = `<div class="field" style="flex-wrap:wrap"><span style="flex:1">Tank<div class="muted tiny">This model came with different tanks. Verified: ${tank.sources.map((u, i) => `<a href="${h(u)}" target="_blank" rel="noopener">source ${i + 1}</a>`).join(', ')}</div></span>
        <div class="chips">${tank.gallons.map((g) => `<button class="chip${Number(vp.tank) === g ? ' on' : ''}" data-act="vehicle-tank" data-arg="${g}">${g} gal</button>`).join('')}</div></div>`;
    } else {
      tankUI = `<label class="field"><span style="flex:1">Tank size (gallons)<div class="muted tiny">Not in the verified list yet. <a href="https://www.google.com/search?q=${query}" target="_blank" rel="noopener">Look it up</a> or check the owner's manual.</div></span>
        <input type="number" inputmode="decimal" step="0.1" min="1" max="60" data-vp="tank" value="${vp.tank ?? ''}"></label>`;
    }
    detail = `<div class="list" style="margin-top:12px">
      <div class="field"><span style="flex:1">EPA fuel economy<div class="muted tiny"><a href="https://www.fueleconomy.gov/feg/noframes/${ver[4]}.shtml" target="_blank" rel="noopener">fueleconomy.gov</a></div></span><span class="num"><b>${city}</b> city · <b>${hwy}</b> hwy · <b>${comb}</b> comb</span></div>
      ${tankUI}</div>
      <button class="btn primary block" style="margin-top:14px" data-act="vehicle-save">Use this vehicle</button>`;
  }
  return `${head}<div class="list">
    ${select('year', 'Year', years, vp.year)}
    ${select('make', 'Make', makes, vp.make)}
    ${select('model', 'Model', models, vp.model)}
    ${select('version', 'Version', versions, vp.version, (o) => `${o[0]} · ${o[2]} mpg hwy`)}
  </div>${detail}
  <p class="note">Fuel economy for every gasoline, diesel and hybrid vehicle since 2000 from the U.S. EPA (fueleconomy.gov). Tank sizes are included only where verified from the manufacturer or two reputable sources.</p>`;
}

export function stopSheet(app) {
  const q = app.stopQuery;
  const kinds = [[3, 'Hotel'], [2, 'Food'], [1, 'Gas'], [4, 'Rest area'], [5, 'EV charging']];
  let results = '';
  if (q.results) {
    results = q.results.length
      ? `<div class="list" style="margin-top:12px">${q.results.slice(0, 12).map((r) => `<button class="item" data-act="exit" data-arg="${h(r.match.exit.id)}">${exitSign(r.match.exit.label, true)}<div class="main">
          <div class="t">${h(r.match.matchesPerRequirement[0].slice(0, 3).map((x) => placeDisplayName(x.place)).join(', '))}</div>
          <div class="muted tiny">Arrive ${clock(r.eta, app.plan.timeZoneIDAt(r.match.exit.distanceAlongRoute), app.snapshot.t)} · ${r.match.exit.highways.join(' ') || ''}</div></div>
          <div class="side"><div class="big">${milesValue(r.distanceAhead)}</div><div class="muted tiny">mi</div></div></button>`).join('')}</div>`
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
