// ExitAtlas web controller: feeds GPS (or simulated) fixes to the engine, publishes snapshots,
// reroutes when the driver leaves the route, and runs discovery mode. Mirrors TripController.swift.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { TripPlan, TripSession } from '../engine/trip.js';
import { HighwayDiscovery, GPSSimulator, stopSuggestions } from '../engine/discovery.js';
import { planFuelStop, rangeLeft, fullTankRange } from '../engine/fuel.js';
import { servicesForExit, searchAlongRoute, exitTitle } from '../engine/exits.js';
import { TripLedger, PaceModel } from '../engine/tracking.js';
import { routeFromJSON, serializeRoute, deserializeRoute } from '../engine/osrm.js';
import { buildRouteMap } from './map.js';
import { miles, clock, spokenMiles } from './format.js';
import {
  loadCoreData, loadCorridors, loadDemoRouteJSON, loadVehicles, fetchRoutes, searchPlaces, currentPosition,
  LocationService, ScreenWake, Announcer, store,
} from './services.js';
import * as V from './views.js';

const VERSION = '2026.10.28';
const TITLES = { drive: 'Drive', exits: 'Exits Ahead', trip: 'Trip', settings: 'Settings' };
const DEFAULT_SETTINGS = {
  voice: true, announceStateLines: true, announceExits: false, keepAwake: true,
  theme: 'auto', vehicle: null, mpgBasis: 'highway', customMpg: null, bufferMiles: 50, preferredBrands: '',
};

const app = {
  version: VERSION,
  data: null, corridors: null, corridorsLoading: null,
  tab: 'drive', mode: 'idle', gps: 'device',
  plan: null, session: null, snapshot: null,
  discovery: null, discoveryStatus: 'Waiting for highway speed',
  isRerouting: false, lastError: null, lastFixAt: null,
  remainingWaypoints: [], tripStartedAt: null,
  lastRerouteAt: null, lastPersistAt: null,
  settings: { ...DEFAULT_SETTINGS, ...store.get('ea.settings', {}) },
  history: store.get('ea.history', []),
  resumable: null,
  planner: { from: null, to: null, stops: [], results: [], busy: false, error: null, recent: store.get('ea.recent', []) },
  placeSearch: { field: 'to', index: null, query: '', results: [], busy: false, error: null },
  exitsUI: { window: store.get('ea.window', 25), category: null },
  alongRoute: { categories: [], brand: '', window: 100, results: null },
  fuel: store.get('ea.fuel', null),
  fuelUI: { mode: 'dashboard', gaugeEighths: 4, error: null },
  fuelAnnounced: new Set(),
  vehicles: null, vehiclesError: null, vehiclesLoading: null,
  vehiclePick: null,
  recentVehicles: store.get('ea.vehicles', []),
  stopQuery: { category: 3, hours: 3, brand: '', results: null },
  sheet: null,
  serviceCache: new Map(),
  mapCache: null,
  sim: null,
  location: new LocationService(),
  wake: new ScreenWake(),
  announcer: new Announcer(),

  servicesFor(exit) {
    let s = this.serviceCache.get(exit.id);
    if (!s) {
      s = this.data ? servicesForExit(this.data.interstates, exit) : [];
      this.serviceCache.set(exit.id, s);
    }
    return s;
  },

  routeMap(plan) {
    if (!this.mapCache || this.mapCache.id !== plan.route.id) {
      this.mapCache = { id: plan.route.id, map: buildRouteMap(plan, this.data.states) };
    }
    return this.mapCache.map;
  },

  lifetime() {
    let meters = 0;
    const states = [];
    for (const t of this.history) {
      meters += t.totalMeters;
      for (const s of t.states) if (s.code && !states.includes(s.code)) states.push(s.code);
    }
    return { meters, states };
  },

  /// The selected vehicle with the MPG used for range (EPA highway, combined, or the driver's own).
  vehicleProfile() {
    const v = this.settings.vehicle;
    if (!v) return null;
    const st = this.settings;
    const mpg = st.mpgBasis === 'custom' && st.customMpg > 0 ? st.customMpg : st.mpgBasis === 'combined' ? v.comb : v.hwy;
    return { ...v, mpg };
  },

  rangeNow() {
    return this.fuel ? rangeLeft(this.fuel, this.snapshot ? this.snapshot.drivenTotal : 0) : null;
  },

  fuelPlan() {
    if (!this.fuel || !this.plan || !this.snapshot) return null;
    const st = this.settings;
    const key = `${this.snapshot.t}|${this.fuel.enteredAt}|${st.bufferMiles}|${st.preferredBrands}|${this.plan.route.id}|${this.mode}`;
    if (this.fuelKey !== key) {
      this.fuelKey = key;
      this.fuelPlanCache = planFuelStop(this.plan, this.snapshot, this.rangeNow(), {
        bufferMeters: st.bufferMiles * MILE, servicesFor: (e) => this.servicesFor(e),
        preferredBrands: st.preferredBrands.split(',').map((b) => b.trim()).filter(Boolean),
        hasDestination: this.mode === 'trip',
      });
    }
    return this.fuelPlanCache;
  },
};
window.exitAtlas = app; // for debugging from the console

// MARK: Rendering

const $ = (sel) => document.querySelector(sel);
let renderQueued = false;
let lastViewHTML = '';
let lastExitsRender = 0;
let exitsTimer = null;

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  applyTheme();
  $('#title').textContent = app.tab === 'drive' && app.mode === 'discovery' && app.plan?.route.title ? app.plan.route.title : TITLES[app.tab];
  $('#status').innerHTML = V.statusPill(app);
  $('#end').hidden = app.mode === 'idle';
  $('#banner').innerHTML = app.gps === 'simulation' && app.mode !== 'idle'
    ? `<div class="banner">▶︎ Simulated drive at ${app.sim?.speedup ?? 30}× · sample route, not your GPS
        <span class="spacer"></span><button class="btn sm" data-act="sim-speed">${app.sim?.speedup === 120 ? '30×' : '120×'}</button></div>` : '';
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.arg === app.tab);
  if (!app.data) return;
  if (app.tab === 'exits' && app.mode !== 'idle') {
    // The exits list is long: refresh it at most every 1.5 s so scrolling stays smooth.
    const now = performance.now();
    if (now - lastExitsRender < 1500 && lastViewHTML) {
      if (!exitsTimer) exitsTimer = setTimeout(() => { exitsTimer = null; render(); }, 1600 - (now - lastExitsRender));
      return;
    }
    lastExitsRender = now;
  }
  let html;
  switch (app.tab) {
    case 'exits': html = V.exitsView(app); break;
    case 'trip': html = V.tripView(app); break;
    case 'settings': html = V.settingsView(app); break;
    default: html = V.driveView(app);
  }
  if (html !== lastViewHTML) {
    $('#view').innerHTML = html;
    lastViewHTML = html;
  }
}

function applyTheme() {
  const t = app.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function openSheet(kind, arg = null) {
  app.sheet = { kind, arg };
  renderSheet();
  $('#sheet-backdrop').classList.add('open');
  $('#sheet').classList.add('open');
}

function renderSheet() {
  if (!app.sheet) return;
  const { kind, arg } = app.sheet;
  let html = '';
  if (kind === 'exit') html = V.exitDetail(app, arg);
  else if (kind === 'place') html = V.placeSearchSheet(app);
  else if (kind === 'search') html = V.alongRouteSheet(app);
  else if (kind === 'fuel') html = V.fuelSheet(app);
  else if (kind === 'stop') html = V.stopSheet(app);
  else if (kind === 'vehicle') html = V.vehicleSheet(app);
  $('#sheet-body').innerHTML = html;
  if (kind === 'place') setTimeout(() => $('#sheet-body input[name="q"]')?.focus(), 250);
}

function closeSheet() {
  app.sheet = null;
  $('#sheet-backdrop').classList.remove('open');
  $('#sheet').classList.remove('open');
}

let toastTimer = null;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// MARK: Modes

function datasets() {
  return { states: app.data.states, timeZones: app.data.timeZones, interstates: app.data.interstates };
}

function nowSeconds() { return Date.now() / 1000; }

// MARK: Fuel

/// Saves the range the car shows now. Range then counts down with miles driven in this session.
function setFuelRange(meters, source) {
  app.fuel = { rangeMeters: meters, drivenAtEntry: app.snapshot ? app.snapshot.drivenTotal : 0, enteredAt: nowSeconds(), source };
  app.fuelAnnounced = new Set();
  app.fuelUI.error = null;
  store.set('ea.fuel', app.fuel);
}

/// Folds miles driven in the session that is ending into the saved range, so it carries over.
function rebaseFuel(drivenTotal = app.snapshot?.drivenTotal ?? 0) {
  if (!app.fuel) return;
  app.fuel = { ...app.fuel, rangeMeters: rangeLeft(app.fuel, drivenTotal), drivenAtEntry: 0 };
  store.set('ea.fuel', app.fuel);
}

function considerFuelVoice() {
  if (!app.settings.voice || app.snapshot?.match.status !== 'onRoute') return;
  const fp = app.fuelPlan();
  if (!fp) return;
  const rec = fp.recommended;
  if (rec && fp.status === 'planned') {
    for (const [mi, tag] of [[2, 'near'], [10, 'far']]) {
      const key = `${rec.exit.id}|${tag}`;
      if (rec.ahead <= mi * MILE && rec.ahead > 0.3 * MILE && !app.fuelAnnounced.has(key)) {
        app.fuelAnnounced.add(key);
        app.fuelAnnounced.add(`${rec.exit.id}|far`);
        app.announcer.speak(`Fuel stop, ${exitTitle(rec.exit)}, in ${spokenMiles(rec.ahead)}. About ${Math.round(rec.rangeOnArrival / MILE)} miles to empty when you get there.`);
        return;
      }
    }
  }
  if (fp.status !== 'destination' && fp.range < fp.buffer && !app.fuelAnnounced.has('low')) {
    app.fuelAnnounced.add('low');
    app.announcer.speak(rec ? `Fuel is low. Nearest gas is ${exitTitle(rec.exit)}, in ${spokenMiles(rec.ahead)}.`
      : 'Fuel is low, and no gas is listed at interstate exits ahead.');
  }
}

async function openVehicleSheet() {
  const v = app.settings.vehicle;
  app.vehiclePick = v ? { year: String(v.year), make: v.make, model: v.model, version: null, tank: v.tankGallons } : { year: '', make: '', model: '', version: null, tank: null };
  openSheet('vehicle');
  if (!app.vehicles) {
    try {
      app.vehicles = await (app.vehiclesLoading ??= loadVehicles());
      if (v) {
        const list = app.vehicles.years[v.year]?.[v.make]?.[v.model] ?? [];
        const i = list.findIndex((x) => x[4] === v.epaId);
        app.vehiclePick.version = i >= 0 ? String(i) : null;
      }
    } catch (e) {
      app.vehiclesError = `Could not load the vehicle list: ${e.message}`;
      app.vehiclesLoading = null;
    }
    if (app.sheet?.kind === 'vehicle') renderSheet();
  }
}

function useVehicle(v) {
  app.settings.vehicle = v;
  store.set('ea.settings', app.settings);
  app.recentVehicles = [v, ...app.recentVehicles.filter((r) => r.epaId !== v.epaId)].slice(0, 8);
  store.set('ea.vehicles', app.recentVehicles);
  lastViewHTML = '';
}

function beginDriveExtras(spokenStart) {
  if (app.settings.keepAwake) app.wake.request();
  if (app.settings.voice && spokenStart) app.announcer.speak(spokenStart);
}

async function startDiscovery() {
  stopSimulation();
  rebaseFuel();
  resetTripState();
  app.mode = 'discovery';
  app.gps = 'device';
  app.discoveryStatus = 'Waiting for highway speed';
  app.tab = 'drive';
  window.scrollTo(0, 0);
  app.location.start();
  beginDriveExtras('Discovery mode on.');
  render();
  try {
    app.corridors ??= await (app.corridorsLoading ??= loadCorridors());
    app.discovery = new HighwayDiscovery(app.corridors);
  } catch (e) {
    app.lastError = `Could not load interstate corridors: ${e.message}`;
  }
  render();
}

function resetTripState() {
  app.plan = null;
  app.session = null;
  app.snapshot = null;
  app.discovery = null;
  app.lastError = null;
  app.isRerouting = false;
  app.serviceCache.clear();
  app.announcer.reset();
}

/// Starts a planned trip. options: {simulate, startMeters, restoring}
function startTrip(route, { simulate = false, startMeters = 0, restoring = null } = {}) {
  stopSimulation();
  app.location.stop();
  if (!restoring) rebaseFuel();
  resetTripState();
  const now = nowSeconds();
  const plan = new TripPlan(route, datasets());
  app.plan = plan;
  if (restoring) {
    app.session = new TripSession(plan, app.data.states, now, {
      ledger: new TripLedger(restoring.ledger), pace: new PaceModel(restoring.pace),
    });
    app.tripStartedAt = restoring.startedAt;
  } else {
    app.session = new TripSession(plan, app.data.states, now);
    app.tripStartedAt = now;
  }
  app.resumable = null;
  app.lastPersistAt = null;
  app.remainingWaypoints = restoring?.remainingWaypoints ?? [...route.stops.map((s) => s.waypoint), route.destination];
  app.mode = 'trip';
  app.snapshot = app.session.snapshotAt(now);
  app.tab = 'drive';
  window.scrollTo(0, 0);
  if (simulate) {
    startSimulation(route, startMeters, 30);
  } else {
    app.gps = 'device';
    app.location.start();
  }
  beginDriveExtras(`Trip started. ${plan.states.totals.length} states, ${plan.exits.length} exits on your route.`);
  render();
}

function endTrip() {
  const session = app.session;
  if (app.mode === 'trip' && session && app.gps === 'device' && session.ledger.totalMeters > 0) {
    app.history.unshift({
      title: `${app.plan.route.origin.name} to ${app.plan.route.destination.name}`,
      startedAt: app.tripStartedAt, endedAt: nowSeconds(),
      states: session.ledger.totalsByRegion, totalMeters: session.ledger.totalMeters,
    });
    app.history = app.history.slice(0, 100);
    store.set('ea.history', app.history);
  }
  stopSimulation();
  app.location.stop();
  app.wake.release();
  window.speechSynthesis?.cancel();
  rebaseFuel();
  resetTripState();
  app.mode = 'idle';
  app.gps = 'device';
  store.remove('ea.active');
  closeSheet();
  render();
}

// MARK: Simulation

function startSimulation(route, fromMeters, speedup) {
  const simulator = new GPSSimulator(route, { interval: 1, noise: 4, reportedAccuracy: 6, seed: 7 });
  simulator.d = fromMeters;
  app.gps = 'simulation';
  app.sim = { simulator, speedup, t: nowSeconds(), timer: null };
  app.sim.timer = setInterval(() => {
    const sim = app.sim;
    if (!sim) return;
    const perTick = Math.max(1, Math.round(sim.speedup / 4));
    for (let k = 0; k < perTick; k++) {
      const r = sim.simulator.step(sim.t);
      sim.t += 1;
      if (!r) {
        stopSimulation(false);
        toast('Simulated drive finished');
        break;
      }
      if (r.sample) handleSample(r.sample, false);
    }
    render();
  }, 250);
}

function stopSimulation(resetSource = true) {
  if (app.sim?.timer) clearInterval(app.sim.timer);
  app.sim = resetSource ? null : app.sim && { ...app.sim, timer: null };
  if (resetSource) app.gps = 'device';
}

// MARK: Fixes

app.location.onSample = (sample) => {
  if (app.gps !== 'device') return;
  handleSample(sample, true);
};
app.location.onError = (message) => {
  app.lastError = message;
  app.locationError = message;
  render();
};

function handleSample(sample, shouldRender) {
  app.lastFixAt = Date.now();
  if (app.locationError) {
    if (app.lastError === app.locationError) app.lastError = null;
    app.locationError = null;
  }
  if (app.mode === 'trip' && app.session) {
    const snap = app.session.ingest(sample);
    publish(snap);
    if (app.session.needsReroute(sample.t)) reroute(sample);
    persistIfDue(sample.t);
  } else if (app.mode === 'discovery') {
    handleDiscovery(sample);
  }
  if (shouldRender) render();
}

function handleDiscovery(sample) {
  const discovery = app.discovery;
  if (!discovery) return;
  const state = discovery.ingest(sample);
  if (state.kind === 'searching') {
    app.discoveryStatus = (sample.speed ?? 0) < discovery.minimumSpeed ? 'Waiting for highway speed' : 'Looking for an interstate';
    if (app.plan?.route.source === 'corridor') {
      rebaseFuel();
      app.plan = null;
      app.session = null;
      app.snapshot = null;
    }
    return;
  }
  const match = state.match;
  app.discoveryStatus = match.corridor.displayName;
  let needsPlan = true;
  if (app.snapshot && app.plan?.route.title === match.corridor.displayName) {
    needsPlan = app.snapshot.remaining < 50 * MILE || app.snapshot.match.status === 'offRoute';
  }
  if (needsPlan) {
    const plan = new TripPlan(HighwayDiscovery.routeAhead(match, undefined, sample.t * 1000), datasets());
    app.plan = plan;
    app.serviceCache.clear();
    if (app.session) app.session.replacePlan(plan, sample.t);
    else app.session = new TripSession(plan, app.data.states, sample.t);
  }
  publish(app.session.ingest(sample));
}

function publish(snap) {
  app.snapshot = snap;
  app.announcer.consider(snap, app.settings);
  considerFuelVoice();
}

/// Keeps the dashboard moving through tunnels and dead zones by dead reckoning.
setInterval(() => {
  if (!app.session || app.gps !== 'device' || app.mode === 'idle') return;
  if (app.lastFixAt && Date.now() - app.lastFixAt > 4000) {
    app.snapshot = app.session.snapshotAt(nowSeconds());
    render();
  }
}, 5000);

// MARK: Reroute and persistence

function remainingWaypoints() {
  const plan = app.plan, s = app.snapshot;
  if (!plan || !s) return app.remainingWaypoints;
  const passed = plan.route.stops.filter((st) => st.distanceAlongRoute <= s.progress).map((st) => st.waypoint.name);
  return app.remainingWaypoints.filter((w) => !passed.includes(w.name));
}

async function reroute(sample) {
  if (app.mode !== 'trip' || app.isRerouting || !app.remainingWaypoints.length || app.gps !== 'device') return;
  if (app.lastRerouteAt && sample.t - app.lastRerouteAt < 20) return;
  app.lastRerouteAt = sample.t;
  app.isRerouting = true;
  render();
  const waypoints = remainingWaypoints();
  const here = { name: 'Current location', coordinate: sample.coordinate };
  try {
    const [route] = await fetchRoutes([here, ...waypoints], { alternatives: false });
    if (!route || !app.session || app.mode !== 'trip') return;
    route.origin = app.plan.route.origin;
    const plan = new TripPlan(route, datasets());
    app.session.replacePlan(plan, nowSeconds());
    app.plan = plan;
    app.serviceCache.clear();
    app.remainingWaypoints = waypoints;
    app.lastError = null;
    if (app.settings.voice) app.announcer.speak('New route.');
  } catch (e) {
    app.lastError = `Reroute failed: ${e.message}. Will retry.`;
  } finally {
    app.isRerouting = false;
    render();
  }
}

function persistIfDue(t, force = false) {
  if (app.mode !== 'trip' || app.gps !== 'device' || !app.session) return;
  if (!force && app.lastPersistAt && t - app.lastPersistAt < 30) return;
  app.lastPersistAt = t;
  store.set('ea.active', {
    route: serializeRoute(app.plan.route), ledger: app.session.ledger.toJSON(), pace: app.session.pace.toJSON(),
    startedAt: app.tripStartedAt, savedAt: t, remainingWaypoints: remainingWaypoints(),
  });
}

function loadResumable() {
  const rec = store.get('ea.active');
  if (!rec?.route || nowSeconds() - rec.savedAt > 48 * 3600) return null;
  const ledger = new TripLedger(rec.ledger);
  return { ...rec, destination: rec.route.destination, drivenMeters: ledger.totalMeters };
}

// MARK: Planner

async function findRoutes() {
  const p = app.planner;
  if (!p.to) return;
  p.busy = true;
  p.error = null;
  p.results = [];
  render();
  try {
    const from = p.from ?? { name: 'Current location', coordinate: await currentPosition() };
    const waypoints = [from, ...p.stops.filter(Boolean), p.to];
    const routes = await fetchRoutes(waypoints, { alternatives: true });
    p.results = routes.map((route) => ({ route, plan: new TripPlan(route, datasets()) }));
    p.recent = [p.to, ...p.recent.filter((w) => w.name !== p.to.name)].slice(0, 6);
    store.set('ea.recent', p.recent);
  } catch (e) {
    p.error = e.name === 'AbortError' ? 'Request cancelled.' : `Could not find a route: ${e.message}`;
  } finally {
    p.busy = false;
    render();
  }
}

async function runDemo() {
  try {
    const json = await loadDemoRouteJSON();
    const route = routeFromJSON(json, {
      source: 'osrm', origin: null, destination: null, title: 'Sample route (OSRM, OpenStreetMap)',
    });
    route.origin = { name: 'Miami, FL', coordinate: route.polyline.point(0) };
    route.destination = { name: 'Manhattan, NY', coordinate: route.polyline.point(route.polyline.pointCount - 1) };
    startTrip(route, { simulate: true, startMeters: 355 * MILE });
  } catch (e) {
    toast(`Demo failed: ${e.message}`);
  }
}

function itineraryText() {
  const s = app.snapshot, plan = app.plan;
  const lines = [`ExitAtlas trip: ${plan.route.origin.name} to ${plan.route.destination.name}`,
    `${miles(s.remaining)} to go, arriving ${clock(s.eta, null, s.t)}`];
  for (const f of s.itinerary) {
    if (f.status === 'completed') continue;
    let line = `${f.segment.displayName}: ${miles(f.status === 'current' ? f.remainingMeters : f.totalMeters)}`;
    if (f.status === 'current' && f.exitTime !== null && s.next) line += `, leaving ${clock(f.exitTime, f.exitTimeZoneID, s.t)}`;
    if (f.status === 'upcoming' && f.entryTime !== null) line += `, entering ${clock(f.entryTime, f.entryTimeZoneID, s.t)}`;
    lines.push(line);
  }
  return lines.join('\n');
}

// MARK: Events

const actions = {
  tab(arg) { app.tab = arg; lastViewHTML = ''; window.scrollTo(0, 0); render(); },
  discovery() { startDiscovery(); },
  demo() { runDemo(); },
  end() { endTrip(); },
  resume() {
    const rec = app.resumable;
    if (!rec) return;
    try {
      startTrip(deserializeRoute(rec.route), { restoring: rec });
    } catch (e) {
      toast(`Could not resume: ${e.message}`);
    }
  },
  'discard-resume'() { rebaseFuel(app.resumable?.drivenMeters ?? 0); app.resumable = null; store.remove('ea.active'); render(); },
  exit(arg) { openSheet('exit', arg); },
  sheet(arg) {
    if (arg === 'search') app.alongRoute.results = null;
    if (arg === 'stop') app.stopQuery.results = null;
    openSheet(arg);
  },
  'close-sheet'() { closeSheet(); },
  'exits-window'(arg) { app.exitsUI.window = Number(arg); store.set('ea.window', app.exitsUI.window); lastExitsRender = 0; render(); },
  'exits-cat'(arg) { app.exitsUI.category = arg === '' ? null : Number(arg); lastExitsRender = 0; render(); },
  share() {
    const text = itineraryText();
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else navigator.clipboard?.writeText(text).then(() => toast('Itinerary copied'), () => toast('Could not copy'));
  },
  pick(arg) {
    const [field, idx] = arg.split(':');
    app.placeSearch = { field, index: idx !== undefined ? Number(idx) : null, query: '', results: [], busy: false, error: null };
    openSheet('place');
  },
  'add-stop'() {
    app.placeSearch = { field: 'stop', index: app.planner.stops.length, query: '', results: [], busy: false, error: null };
    openSheet('place');
  },
  'remove-stop'(arg) { app.planner.stops.splice(Number(arg), 1); app.planner.results = []; render(); },
  'reset-from'() { app.planner.from = null; app.planner.results = []; render(); },
  'use-current'() { app.planner.from = null; app.planner.results = []; closeSheet(); render(); },
  'choose-place'(arg) {
    const place = app.placeSearch.results[Number(arg)];
    const ps = app.placeSearch, p = app.planner;
    const w = { name: place.name, coordinate: place.coordinate };
    if (ps.field === 'from') p.from = w;
    else if (ps.field === 'to') p.to = w;
    else p.stops[ps.index] = w;
    p.stops = p.stops.filter(Boolean);
    p.results = [];
    closeSheet();
    render();
  },
  recent(arg) { app.planner.to = app.planner.recent[Number(arg)]; app.planner.results = []; render(); },
  'find-routes'() { findRoutes(); },
  'start-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) { app.planner.results = []; startTrip(r.route); } },
  'simulate-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) startTrip(r.route, { simulate: true }); },
  'sim-speed'() { if (app.sim) app.sim.speedup = app.sim.speedup === 120 ? 30 : 120; render(); },
  'test-voice'() {
    if (!app.announcer.supported) { toast('Voice is not supported in this browser'); return; }
    app.announcer.speak('Georgia state line in 3 miles. 4 exits remain in Florida.');
  },
  theme(arg) { app.settings.theme = arg; store.set('ea.settings', app.settings); lastViewHTML = ''; render(); },
  'clear-data'() {
    if (!confirm('Erase saved trips, recent destinations and settings on this phone?')) return;
    for (const k of ['ea.settings', 'ea.history', 'ea.recent', 'ea.active', 'ea.window']) store.remove(k);
    app.settings = { ...DEFAULT_SETTINGS };
    app.history = [];
    app.planner.recent = [];
    app.resumable = null;
    lastViewHTML = '';
    render();
  },
  'ar-cat'(arg) {
    const c = Number(arg), q = app.alongRoute;
    q.categories = q.categories.includes(c) ? q.categories.filter((x) => x !== c) : [...q.categories, c];
    renderSheet();
  },
  'ar-window'(arg) { app.alongRoute.window = Number(arg); renderSheet(); },
  'stop-cat'(arg) { app.stopQuery.category = Number(arg); renderSheet(); },
  vehicle() { openVehicleSheet(); },
  'vehicle-recent'(arg) {
    const list = app.recentVehicles.filter((r) => r.epaId !== app.settings.vehicle?.epaId);
    const v = list[Number(arg)];
    if (v) { useVehicle(v); toast(`Using ${v.year} ${v.make} ${v.model}`); render(); }
  },
  'vehicle-tank'(arg) { app.vehiclePick.tank = Number(arg); renderSheet(); },
  'vehicle-save'() {
    const vp = app.vehiclePick;
    const ver = app.vehicles?.years[vp.year]?.[vp.make]?.[vp.model]?.[Number(vp.version)];
    if (!ver) return;
    const tank = ver[5] >= 0 ? app.vehicles.tanks[ver[5]] : null;
    let gallons = null, basis = null;
    if (tank && tank.gallons.length === 1) { gallons = tank.gallons[0]; basis = 'verified'; }
    else if (tank) { gallons = tank.gallons.includes(Number(vp.tank)) ? Number(vp.tank) : null; basis = 'verified'; }
    else if (Number(vp.tank) > 0) { gallons = Number(vp.tank); basis = 'entered'; }
    if (tank && tank.gallons.length > 1 && gallons === null) { toast('Choose which tank this one has'); return; }
    useVehicle({
      year: Number(vp.year), make: vp.make, model: vp.model, label: ver[0], city: ver[1], hwy: ver[2], comb: ver[3],
      epaId: ver[4], tankGallons: gallons, tankBasis: basis, tankSources: tank?.sources ?? [],
    });
    closeSheet();
    toast(gallons ? `About ${Math.round(gallons * app.vehicleProfile().mpg)} mi per tank` : 'Vehicle saved. Add the tank size any time.');
    render();
  },
  'mpg-basis'(arg) { app.settings.mpgBasis = arg; store.set('ea.settings', app.settings); lastViewHTML = ''; render(); },
  'fuel-buffer'(arg) {
    app.settings.bufferMiles = Number(arg);
    store.set('ea.settings', app.settings);
    lastViewHTML = '';
    if (app.sheet) renderSheet();
    render();
  },
  'fuel-mode'(arg) { app.fuelUI.mode = arg; renderSheet(); },
  'fuel-filled'() {
    const full = fullTankRange(app.vehicleProfile());
    if (!full) {
      app.fuelUI.error = 'Enter the miles to empty your car shows now. Choose your vehicle with its tank size to make this one tap.';
      renderSheet();
      return;
    }
    setFuelRange(full, 'fullTank');
    renderSheet();
    render();
    toast(`Full tank: about ${Math.round(full / MILE)} mi. Your dashboard reading is more accurate if it differs.`);
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  ev.preventDefault();
  ev.stopPropagation();
  fn(el.dataset.arg ?? '');
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  ev.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'place-search') {
    const ps = app.placeSearch;
    ps.query = form.q.value.trim();
    if (!ps.query) return;
    ps.busy = true;
    ps.error = null;
    renderSheet();
    try {
      const near = app.snapshot ? app.plan.route.polyline.coordinateAt(app.snapshot.progress) : null;
      ps.results = await searchPlaces(ps.query, near);
      if (!ps.results.length) ps.error = 'No places found. Try adding the city or state.';
    } catch (e) {
      ps.error = `Search failed: ${e.message}`;
    } finally {
      ps.busy = false;
      renderSheet();
    }
  } else if (kind === 'along-route') {
    const q = app.alongRoute;
    q.brand = form.brand.value.trim();
    const reqs = q.categories.map((c) => ({ category: c }));
    if (q.brand) reqs.push({ nameOrBrand: q.brand });
    if (!reqs.length) { toast('Choose a category or type a brand'); return; }
    const d = app.snapshot.progress;
    q.results = searchAlongRoute(app.data.interstates, app.plan.exits, reqs, d, d + q.window * MILE, (e) => app.servicesFor(e));
    renderSheet();
  } else if (kind === 'fuel') {
    const v = app.vehicleProfile();
    if (app.fuelUI.mode === 'gauge' && v?.tankGallons) {
      setFuelRange(app.fuelUI.gaugeEighths / 8 * v.tankGallons * v.mpg * MILE, 'gauge');
    } else {
      const mi = parseFloat(form.dte.value);
      if (!(mi >= 0 && mi <= 1500)) { app.fuelUI.error = 'Enter the miles to empty from your dashboard.'; renderSheet(); return; }
      setFuelRange(mi * MILE, 'dashboard');
    }
    renderSheet();
    render();
    toast('Range saved');
  } else if (kind === 'stop') {
    const q = app.stopQuery;
    q.brand = form.brand.value.trim();
    const req = { category: q.category };
    if (q.brand) req.nameOrBrand = q.brand;
    q.results = stopSuggestions(app.data.interstates, app.plan, app.snapshot, app.session.pace, [req],
      { kind: 'time', seconds: q.hours * 3600, tolerance: 1800 }, (e) => app.servicesFor(e));
    renderSheet();
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  const vp = el.dataset?.vp;
  if (vp) {
    const pick = app.vehiclePick;
    if (vp === 'tank') { pick.tank = parseFloat(el.value) || null; return; }
    pick[vp] = el.value;
    const order = ['year', 'make', 'model', 'version'];
    for (const k of order.slice(order.indexOf(vp) + 1)) pick[k] = k === 'version' ? null : '';
    if (vp !== 'version') pick.tank = null;
    const versions = app.vehicles?.years[pick.year]?.[pick.make]?.[pick.model];
    if (vp === 'model' && versions?.length === 1) pick.version = '0';
    renderSheet();
    return;
  }
  const key = el.dataset?.set;
  if (!key) return;
  if (el.type === 'checkbox') app.settings[key] = el.checked;
  else if (el.dataset.kind === 'text') app.settings[key] = el.value.trim();
  else {
    const v = parseFloat(el.value);
    if (Number.isFinite(v) && v > 0) app.settings[key] = v;
  }
  store.set('ea.settings', app.settings);
  if (key === 'keepAwake') { if (el.checked && app.mode !== 'idle') app.wake.request(); else if (!el.checked) app.wake.release(); }
  lastViewHTML = '';
  render();
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.matches('[data-gauge]')) {
    app.fuelUI.gaugeEighths = Number(el.value);
    const label = $('[data-gauge-label]');
    const v = app.vehicleProfile();
    if (label && v?.tankGallons) label.textContent = V.gaugeText(app.fuelUI.gaugeEighths, v);
  } else if (el.matches('[data-stop-hours]')) {
    app.stopQuery.hours = parseFloat(el.value);
    const label = $('[data-stop-hours-label]');
    if (label) label.textContent = `${app.stopQuery.hours} h`;
  }
});

$('#sheet-backdrop').addEventListener('click', closeSheet);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (app.wake.wanted) app.wake.request();
    if (app.location.running && (!app.lastFixAt || Date.now() - app.lastFixAt > 10000)) app.location.restart();
    if (app.session && app.gps === 'device') app.snapshot = app.session.snapshotAt(nowSeconds());
    render();
  } else if (app.mode === 'trip') {
    persistIfDue(nowSeconds(), true);
  }
});
window.addEventListener('pagehide', () => persistIfDue(nowSeconds(), true));

// MARK: Boot

async function boot() {
  applyTheme();
  const bar = $('#load-bar'), label = $('#load-label');
  try {
    app.data = await loadCoreData((f) => {
      bar.style.width = `${(f * 100).toFixed(0)}%`;
      label.textContent = `Loading offline data ${(f * 15).toFixed(1)} of 15.0 MB`;
    });
  } catch (e) {
    label.innerHTML = `Could not load the offline data: ${e.message}. <button class="btn sm" onclick="location.reload()">Retry</button>`;
    return;
  }
  app.resumable = loadResumable();
  if (app.fuel?.drivenAtEntry > 0 && !app.resumable) rebaseFuel(app.fuel.drivenAtEntry);
  $('#loading').remove();
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) runDemo();
  render();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
