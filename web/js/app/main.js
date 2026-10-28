// ExitAtlas web controller: feeds GPS (or simulated) fixes to the engine, publishes snapshots,
// reroutes when the driver leaves the route, and runs discovery mode. Mirrors TripController.swift.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { TripPlan, TripSession } from '../engine/trip.js';
import { HighwayDiscovery, GPSSimulator, stopSuggestions } from '../engine/discovery.js';
import { planStop, gasCandidates, chargerCandidates, projectChargers, rangeLeft, fullTankRange } from '../engine/fuel.js';
import { servicesForExit, searchAlongRoute, exitTitle } from '../engine/exits.js';
import { gasGaps } from '../engine/restareas.js';
import { placeDisplayName } from '../engine/datasets.js';
import { TripLedger, PaceModel } from '../engine/tracking.js';
import { routeFromJSON, serializeRoute, deserializeRoute } from '../engine/osrm.js';
import { buildRouteMap } from './map.js';
import { SpeedLimits } from './limits.js';
import { GasPrices } from './prices.js';
import { fetchChargers, DEMO_KEY } from './chargers.js';
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
  announceRestAreas: true, announceGasGaps: true, announceTimeZones: true, gasGapMiles: 40,
  theme: 'auto', vehicle: null, mpgBasis: 'highway', customMpg: null, customRange: null, bufferMiles: 50,
  preferredBrands: '', favoriteBrands: [], chargerNetwork: 'Tesla',
  speedAlertOver: 5,
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
  planner: { from: null, to: null, stops: [], results: [], busy: false, error: null },
  places: loadPlaces(),
  placeSearch: { field: 'to', index: null, query: '', results: [], busy: false, error: null },
  exitsUI: { window: store.get('ea.window', 25), category: null },
  alongRoute: { categories: [], brand: '', window: 100, results: null },
  fuel: store.get('ea.fuel', null),
  fuelUI: { mode: 'dashboard', gaugeEighths: 4, error: null },
  fuelAnnounced: new Set(),
  vehicles: null, vehiclesError: null, vehiclesLoading: null,
  vehiclePick: null,
  recentVehicles: store.get('ea.vehicles', []),
  prices: new GasPrices({ getKey: () => store.get('ea.googleKey', ''), onCall: countPriceCall }),
  chargers: { routeId: null, projected: [], loading: false, error: null, retryAt: 0 },
  stopQuery: { category: 3, hours: 3, brand: '', results: null },
  sheet: null,
  serviceCache: new Map(),
  limits: null,
  lastSpeed: null,
  mapCache: null,
  sim: null,
  location: new LocationService(),
  wake: new ScreenWake(),
  announcer: new Announcer(),

  /// Gas along the route in order: exits with a gas station and service plazas that list one.
  gasStops(plan = this.plan) {
    if (!plan) return [];
    if (this.gasStopCache?.id !== plan.route.id) {
      const stops = [];
      for (const e of plan.exits) {
        if (this.servicesFor(e).some((x) => x.place.category === 1)) stops.push({ distance: e.distanceAlongRoute, exit: e });
      }
      for (const r of plan.restAreas) if (r.gas.length) stops.push({ distance: r.distanceAlongRoute, restArea: r });
      stops.sort((a, b) => a.distance - b.distance);
      this.gasStopCache = { id: plan.route.id, stops };
    }
    return this.gasStopCache.stops;
  },

  /// Stretches without gas in the next `window` meters, longer than the driver's setting. None for EVs.
  gasGapsAhead(s, window = 150 * MILE) {
    if (!this.plan || !s || this.settings.vehicle?.ev) return [];
    const end = Math.min(this.plan.route.length, s.progress + window);
    return gasGaps(this.gasStops(), s.progress, end, this.settings.gasGapMiles * MILE, this.plan.route.length);
  },

  /// A stop can be added mid-trip when a reroute is possible: a planned trip on live GPS.
  canAddStop() {
    return this.mode === 'trip' && this.gps === 'device' && Boolean(this.lastSample) && this.remainingWaypoints.length > 0;
  },

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

  /// Current speed in mph from the latest fix, or null when there is no recent fix.
  speedNow() {
    if (this.lastSpeed === null) return null;
    if (this.gps === 'device' && (!this.lastFixAt || Date.now() - this.lastFixAt > 5000)) return null;
    return Math.max(0, Math.round(this.lastSpeed * 2.23694));
  },

  /// The selected vehicle with the MPG used for range (EPA highway, combined, or the driver's own).
  vehicleProfile() {
    const v = this.settings.vehicle;
    if (!v) return null;
    const st = this.settings;
    if (v.ev) {
      const rangeMiles = st.mpgBasis === 'custom' && st.customRange > 0 ? st.customRange
        : st.mpgBasis === 'combined' ? v.rangeMiles : (v.rangeHwyMiles || v.rangeMiles);
      return { ...v, rangeMiles, mpg: null };
    }
    const mpg = st.mpgBasis === 'custom' && st.customMpg > 0 ? st.customMpg : st.mpgBasis === 'combined' ? v.comb : v.hwy;
    return { ...v, mpg };
  },

  rangeNow() {
    return this.fuel ? rangeLeft(this.fuel, this.snapshot ? this.snapshot.drivenTotal : 0) : null;
  },

  fuelPlan() {
    if (!this.fuel || !this.plan || !this.snapshot) return null;
    const st = this.settings;
    const ev = Boolean(st.vehicle?.ev);
    const charged = ev && this.chargers.routeId === this.plan.route.id;
    const key = `${this.snapshot.t}|${this.fuel.enteredAt}|${st.bufferMiles}|${st.favoriteBrands.join()}|${this.plan.route.id}|${this.mode}|${ev}|${charged}`;
    if (this.fuelKey !== key) {
      this.fuelKey = key;
      const range = this.rangeNow(), d = this.snapshot.progress;
      const candidates = ev
        ? (charged ? chargerCandidates(this.chargers.projected, d, range) : [])
        : gasCandidates(this.plan, d, range, (e) => this.servicesFor(e), st.favoriteBrands);
      const fp = planStop(this.plan, this.snapshot, range, candidates, {
        bufferMeters: st.bufferMiles * MILE, hasDestination: this.mode === 'trip', favorites: ev ? [] : st.favoriteBrands,
      });
      fp.ev = ev;
      fp.chargersLoading = ev && !charged;
      this.fuelPlanCache = fp;
    }
    return this.fuelPlanCache;
  },

  secret(key) { return store.get(key, ''); },

  priceCalls() {
    const c = store.get('ea.priceCalls', null);
    return c && c.month === new Date().toISOString().slice(0, 7) ? c.n : 0;
  },

  /// Gas grade key for prices, from the vehicle's EPA fuel type.
  gradeCode() {
    const f = this.settings.vehicle?.fuel;
    return f === 'P' || f === 'M' || f === 'D' ? f : 'R';
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
  if (kind === 'exit') loadPrices([app.plan?.exits.find((e) => e.id === arg)]);
  if (kind === 'fuel') {
    ensureChargers();
    const fp = app.fuelPlan();
    if (fp) loadPrices([fp.recommended, ...fp.earlier, fp.lastChance].map((x) => x?.exit));
  }
  renderSheet();
  $('#sheet-backdrop').classList.add('open');
  $('#sheet').classList.add('open');
}

function renderSheet() {
  if (!app.sheet) return;
  const { kind, arg } = app.sheet;
  let html = '';
  if (kind === 'exit') html = V.exitDetail(app, arg);
  else if (kind === 'rest') html = V.restAreaDetail(app, arg);
  else if (kind === 'place') html = V.placeSearchSheet(app);
  else if (kind === 'search') html = V.alongRouteSheet(app);
  else if (kind === 'fuel') {
    html = V.fuelSheet(app);
    const fp = app.fuelPlan();
    if (fp) loadPrices([fp.recommended, fp.closestToTarget, ...fp.earlier, fp.lastChance].map((x) => x?.exit));
  }
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
  return { states: app.data.states, timeZones: app.data.timeZones, interstates: app.data.interstates, restAreas: app.data.restAreas };
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
  const what = (x) => (x.kind === 'charge' ? x.charger.name.replace(/ - Tesla Supercharger$/, ' Supercharger') : exitTitle(x.exit));
  if (rec && fp.status === 'planned') {
    for (const [mi, tag] of [[2, 'near'], [10, 'far']]) {
      const key = `${rec.key}|${tag}`;
      if (rec.ahead <= mi * MILE && rec.ahead > 0.3 * MILE && !app.fuelAnnounced.has(key)) {
        app.fuelAnnounced.add(key);
        app.fuelAnnounced.add(`${rec.key}|far`);
        app.announcer.speak(`${fp.ev ? 'Charging stop' : 'Fuel stop'}, ${what(rec)}, in ${spokenMiles(rec.ahead)}. About ${Math.round(rec.rangeOnArrival / MILE)} miles of range left when you get there.`);
        return;
      }
    }
  }
  if (fp.status !== 'destination' && fp.range < fp.buffer && !app.fuelAnnounced.has('low')) {
    app.fuelAnnounced.add('low');
    app.announcer.speak(rec ? `${fp.ev ? 'Charge' : 'Fuel'} is low. Nearest ${fp.ev ? 'charger' : 'gas'} is ${what(rec)}, in ${spokenMiles(rec.ahead)}.`
      : `${fp.ev ? 'Charge' : 'Fuel'} is low, and nothing is listed ahead.`);
  }
}

// MARK: Saved places

function loadPlaces() {
  const p = store.get('ea.places', null) ?? { home: null, recent: [] };
  const legacy = store.get('ea.recent', null);
  if (legacy?.length && !p.recent.length) p.recent = legacy;
  return p;
}

function samePlace(a, b) {
  return a && b && (a.name === b.name || (Math.abs(a.coordinate.lat - b.coordinate.lat) < 0.001 && Math.abs(a.coordinate.lon - b.coordinate.lon) < 0.001));
}

function recordPlace(w) {
  if (!w?.coordinate || w.name === 'Current location') return;
  app.places.recent = [w, ...app.places.recent.filter((r) => !samePlace(r, w))].slice(0, 10);
  store.set('ea.places', app.places);
}

function setHome(w) {
  app.places.home = { name: w.name, coordinate: w.coordinate };
  store.set('ea.places', app.places);
  toast(`Home set: ${w.name}`);
}

/// Sets the destination from Home or a recent place and finds routes right away.
function goTo(w) {
  const p = app.planner;
  p.to = w;
  p.results = [];
  app.tab = 'trip';
  lastViewHTML = '';
  window.scrollTo(0, 0);
  findRoutes();
}

// MARK: Prices and chargers

function countPriceCall() {
  const month = new Date().toISOString().slice(0, 7);
  const c = store.get('ea.priceCalls', { month, n: 0 });
  store.set('ea.priceCalls', c.month === month ? { month, n: c.n + 1 } : { month, n: 1 });
}

/// Loads gas prices for exits on screen (gas cars only, with a Google key). Re-renders when they arrive.
function loadPrices(exits) {
  if (!app.prices.enabled || app.settings.vehicle?.ev) return;
  for (const e of exits) {
    if (!e) continue;
    const c = app.prices.cache.get(e.id);
    if (c && (c.pending || Date.now() - c.at < 15 * 60 * 1000)) continue;
    app.prices.load(e).then(() => { lastViewHTML = ''; render(); if (app.sheet) renderSheet(); });
  }
}

/// Loads DC fast chargers along the route once per route (electric vehicles only).
function ensureChargers() {
  const c = app.chargers;
  if (!app.settings.vehicle?.ev || !app.plan || c.loading || c.routeId === app.plan.route.id || Date.now() < c.retryAt) return;
  const route = app.plan.route;
  c.loading = true;
  c.error = null;
  fetchChargers(route.polyline, { apiKey: store.get('ea.nrelKey', DEMO_KEY), network: app.settings.chargerNetwork })
    .then((stations) => {
      if (app.plan?.route !== route) return;
      c.projected = projectChargers(route.polyline, stations);
      c.routeId = route.id;
    })
    .catch((e) => { c.error = e.message; c.retryAt = Date.now() + 5 * 60 * 1000; })
    .finally(() => { c.loading = false; lastViewHTML = ''; render(); if (app.sheet) renderSheet(); });
}

// MARK: Personal pace

/// Moving time against the routing model, per real GPS trip (OSRM routes only), last 20 trips.
function paceHistory() { return store.get('ea.paceHistory', {}); }

function recordPace() {
  if (app.mode !== 'trip' || app.gps !== 'device' || !app.session || app.plan?.route.source !== 'osrm') return;
  const hist = paceHistory();
  hist[String(app.tripStartedAt)] = { o: app.session.pace.observedSeconds, e: app.session.pace.expectedSeconds };
  const keys = Object.keys(hist).sort((a, b) => Number(b) - Number(a)).slice(0, 20);
  store.set('ea.paceHistory', Object.fromEntries(keys.map((k) => [k, hist[k]])));
}

/// The driver's usual pace relative to the routing model, from earlier trips; 1 without history.
function personalPace(excludeKey = String(app.tripStartedAt)) {
  let o = 0, e = 0;
  for (const [k, v] of Object.entries(paceHistory())) if (k !== excludeKey) { o += v.o; e += v.e; }
  return { factor: e >= 1800 ? Math.min(Math.max(o / e, 0.4), 2.5) : 1, hours: o / 3600 };
}
app.personalPace = () => personalPace(null);

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
  app.limits = null;
  app.lastSpeed = null;
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
    app.tripStartedAt = now;
    const prior = route.source === 'osrm' && !simulate ? personalPace().factor : 1;
    app.session = new TripSession(plan, app.data.states, now, { pace: new PaceModel(null, { priorFactor: prior }) });
  }
  app.resumable = null;
  app.lastPersistAt = null;
  app.remainingWaypoints = restoring?.remainingWaypoints ?? [...route.stops.map((s) => s.waypoint), route.destination];
  app.mode = 'trip';
  if (!simulate) { recordPlace(route.destination); for (const st of route.stops) recordPlace(st.waypoint); }
  app.chargers = { routeId: null, projected: [], loading: false, error: null, retryAt: 0 };
  app.snapshot = app.session.snapshotAt(now);
  app.tab = 'drive';
  window.scrollTo(0, 0);
  ensureLimits();
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
  recordPace();
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
  app.lastSample = sample;
  if (sample.speed !== null && sample.speed >= 0) app.lastSpeed = sample.speed;
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
  const gap = app.gasGapsAhead(snap).find((g) => g.before && g.before.distance > snap.progress) ?? null;
  app.announcer.consider(snap, app.settings, { zoneID: app.plan?.timeZoneIDAt(snap.progress) ?? null, gasGap: gap });
  considerFuelVoice();
  ensureLimits();
  ensureChargers();
  const fp = app.fuelPlan();
  if (fp?.recommended?.exit) loadPrices([fp.recommended.exit]);
}

/// Loads posted speed limits for the road just ahead (one request per about 50 miles).
function ensureLimits() {
  if (!app.plan || !app.snapshot) return;
  if (!app.limits || app.limits.route !== app.plan.route) {
    app.limits = new SpeedLimits(app.plan.route);
    app.limits.onUpdate = render;
  }
  app.limits.ensureAhead(app.snapshot.progress);
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

async function reroute(sample, { force = false, spoken = 'New route.' } = {}) {
  if (app.mode !== 'trip' || app.isRerouting || !app.remainingWaypoints.length || app.gps !== 'device') return;
  if (!force && app.lastRerouteAt && sample.t - app.lastRerouteAt < 20) return;
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
    if (app.settings.voice && spoken) app.announcer.speak(spoken);
  } catch (e) {
    app.lastError = `Reroute failed: ${e.message}. Will retry.`;
  } finally {
    app.isRerouting = false;
    render();
  }
}

/// Adds a place as the next stop and reroutes through it. Stops already on the trip keep their order;
/// the new one goes before the first remaining stop that lies farther along the current route.
async function addStop(exitID, placeID) {
  if (!app.canAddStop()) { toast('Adding a stop needs live GPS'); return; }
  const exit = app.plan.exits.find((e) => e.id === exitID);
  const place = exit && app.servicesFor(exit).find((x) => x.place.id === placeID)?.place;
  if (!place) return;
  const waypoint = { name: placeDisplayName(place), coordinate: place.coordinate };
  const along = (w) => app.plan.route.stops.find((st) => st.waypoint.name === w.name)?.distanceAlongRoute ?? Infinity;
  const list = remainingWaypoints();
  const at = list.findIndex((w) => along(w) > exit.distanceAlongRoute);
  list.splice(at < 0 ? list.length - 1 : at, 0, waypoint);
  app.remainingWaypoints = list;
  closeSheet();
  toast(`Adding ${waypoint.name}`);
  await reroute(app.lastSample, { force: true, spoken: `Stop added: ${waypoint.name}.` });
}

function persistIfDue(t, force = false) {
  if (app.mode !== 'trip' || app.gps !== 'device' || !app.session) return;
  if (!force && app.lastPersistAt && t - app.lastPersistAt < 30) return;
  app.lastPersistAt = t;
  recordPace();
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
    recordPlace(p.to);
    for (const st of p.stops) recordPlace(st);
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
  rest(arg) { openSheet('rest', arg); },
  'add-trip-stop'(arg) { const [exitID, placeID] = arg.split('|'); addStop(exitID, placeID); },
  'gas-gap'(arg) { app.settings.gasGapMiles = Number(arg); store.set('ea.settings', app.settings); lastViewHTML = ''; render(); },
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
    const [src, i] = arg.split(':');
    const place = src === 'home' ? app.places.home : src === 'recent' ? app.places.recent[Number(i)] : app.placeSearch.results[Number(i)];
    if (!place) return;
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
  'go-to'(arg) { const w = arg === 'home' ? app.places.home : app.places.recent[Number(arg)]; if (w) goTo(w); },
  'set-home'(arg) {
    const [src, i] = arg.split(':');
    const w = src === 'recent' ? app.places.recent[Number(i)] : app.placeSearch.results[Number(i)];
    if (w) { setHome(w); renderSheet(); lastViewHTML = ''; render(); }
  },
  'clear-home'() { app.places.home = null; store.set('ea.places', app.places); lastViewHTML = ''; render(); },
  'clear-recent'() { app.places.recent = []; store.set('ea.places', app.places); lastViewHTML = ''; render(); },
  'fav-brand'(arg) {
    const st = app.settings;
    st.favoriteBrands = st.favoriteBrands.includes(arg) ? st.favoriteBrands.filter((b) => b !== arg) : [...st.favoriteBrands, arg];
    store.set('ea.settings', st);
    lastViewHTML = '';
    render();
    if (app.sheet) renderSheet();
  },
  'charger-network'(arg) { app.settings.chargerNetwork = arg; store.set('ea.settings', app.settings); app.chargers.routeId = null; lastViewHTML = ''; render(); },
  'find-routes'() { findRoutes(); },
  'start-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) { app.planner.results = []; startTrip(r.route); } },
  'simulate-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) startTrip(r.route, { simulate: true }); },
  'sim-speed'() { if (app.sim) app.sim.speedup = app.sim.speedup === 120 ? 30 : 120; render(); },
  'speed-alert'(arg) { app.settings.speedAlertOver = Number(arg); store.set('ea.settings', app.settings); lastViewHTML = ''; render(); },
  'reset-pace'() { store.remove('ea.paceHistory'); lastViewHTML = ''; render(); toast('Pace history cleared'); },
  'test-voice'() {
    if (!app.announcer.supported) { toast('Voice is not supported in this browser'); return; }
    app.announcer.speak('Georgia state line in 3 miles. 4 exits remain in Florida.');
  },
  theme(arg) { app.settings.theme = arg; store.set('ea.settings', app.settings); lastViewHTML = ''; render(); },
  'clear-data'() {
    if (!confirm('Erase saved trips, recent destinations and settings on this phone?')) return;
    for (const k of ['ea.settings', 'ea.history', 'ea.recent', 'ea.active', 'ea.window', 'ea.paceHistory', 'ea.places', 'ea.fuel', 'ea.vehicles']) store.remove(k);
    app.places = { home: null, recent: [] };
    app.fuel = null;
    app.recentVehicles = [];
    app.settings = { ...DEFAULT_SETTINGS };
    app.history = [];
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
    const ev = ver[6] === 'E';
    if (!ev && tank && tank.gallons.length > 1 && gallons === null) { toast('Choose which tank this one has'); return; }
    useVehicle({
      year: Number(vp.year), make: vp.make, model: vp.model, label: ver[0], city: ver[1], hwy: ver[2], comb: ver[3],
      epaId: ver[4], fuel: ver[6] ?? 'R', ev, rangeMiles: ver[7] || 0, rangeHwyMiles: ver[8] || 0,
      tankGallons: ev ? null : gallons, tankBasis: ev ? null : basis, tankSources: ev ? [] : tank?.sources ?? [],
    });
    app.chargers.routeId = null;
    closeSheet();
    const pv = app.vehicleProfile();
    toast(ev ? `About ${Math.round(pv.rangeMiles)} mi per charge` : gallons ? `About ${Math.round(gallons * pv.mpg)} mi per tank` : 'Vehicle saved. Add the tank size any time.');
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
      app.fuelUI.error = 'Enter the range your car shows now. Choose your vehicle (with its tank size for gas cars) to make this one tap.';
      renderSheet();
      return;
    }
    setFuelRange(full, 'fullTank');
    renderSheet();
    render();
    toast(`${app.settings.vehicle?.ev ? 'Full charge' : 'Full tank'}: about ${Math.round(full / MILE)} mi. Your dashboard reading is more accurate if it differs.`);
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
    if (app.fuelUI.mode === 'gauge' && v?.ev && v.rangeMiles) {
      setFuelRange((app.fuelUI.batteryTwentieths ?? 10) / 20 * v.rangeMiles * MILE, 'battery');
    } else if (app.fuelUI.mode === 'gauge' && v?.tankGallons) {
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
    // Rest stops: rest areas and plazas on the highway, plus rest areas and travel centers at exits.
    const rest = q.category === 4;
    const reqs = rest ? [{ category: 4 }, { category: 8 }] : [{ category: q.category }];
    if (q.brand) for (const r of reqs) r.nameOrBrand = q.brand;
    const win = { kind: 'time', seconds: q.hours * 3600, tolerance: 1800 };
    const opts = { favorites: app.settings.favoriteBrands };
    const lists = reqs.map((r, i) => stopSuggestions(app.data.interstates, app.plan, app.snapshot, app.session.pace, [r], win,
      (e) => app.servicesFor(e), { ...opts, restAreas: rest && i === 0 }));
    const seen = new Set();
    q.results = lists.flat().sort((a, b) => a.score - b.score).filter((x) => {
      const key = x.restArea?.id ?? x.match.exit.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  if (el.dataset?.secret) {
    const v = el.value.trim();
    if (v) store.set(el.dataset.secret, v); else store.remove(el.dataset.secret);
    if (el.dataset.secret === 'ea.nrelKey') app.chargers.retryAt = 0;
    toast(v ? 'Key saved on this phone' : 'Key removed');
    lastViewHTML = '';
    render();
    return;
  }
  if (el.dataset?.brand !== undefined) {
    const v = el.value.trim();
    if (v && !app.settings.favoriteBrands.some((b) => b.toLowerCase() === v.toLowerCase())) {
      app.settings.favoriteBrands = [...app.settings.favoriteBrands, v];
      store.set('ea.settings', app.settings);
    }
    el.value = '';
    lastViewHTML = '';
    render();
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
    const v = app.vehicleProfile();
    if (v?.ev) app.fuelUI.batteryTwentieths = Number(el.value); else app.fuelUI.gaugeEighths = Number(el.value);
    const label = $('[data-gauge-label]');
    if (label && v && (v.ev || v.tankGallons)) label.textContent = V.gaugeText(Number(el.value), v);
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
  if (!app.settings.favoriteBrands.length && app.settings.preferredBrands) {
    app.settings.favoriteBrands = app.settings.preferredBrands.split(',').map((b) => b.trim()).filter(Boolean);
    store.set('ea.settings', app.settings);
  }
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
