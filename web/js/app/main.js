// ExitAtlas web controller: feeds GPS (or simulated) fixes to the engine, publishes snapshots,
// reroutes when the driver leaves the route, and runs discovery mode. Mirrors TripController.swift.
import { METERS_PER_MILE as MILE, distance } from '../engine/geo.js';
import { TripPlan, TripSession } from '../engine/trip.js';
import { HighwayDiscovery, GPSSimulator, stopSuggestions } from '../engine/discovery.js';
import { planStop, gasCandidates, chargerCandidates, projectChargers, rangeLeft, fullTankRange } from '../engine/fuel.js';
import { servicesForExit, searchAlongRoute, exitTitle } from '../engine/exits.js';
import { gasGaps, restAreaTitle } from '../engine/restareas.js';
import { placeDisplayName } from '../engine/datasets.js';
import { drawTripCard, shareCanvas } from './sharecard.js';
import { TripLedger, PaceModel } from '../engine/tracking.js';
import { routeFromJSON, serializeRoute, deserializeRoute } from '../engine/osrm.js';
import { buildRouteMap } from './map.js';
import { SpeedLimits } from './limits.js';
import { GasPrices, GRADES, pacificDay } from './prices.js';
import { PriceBook, SIMULATED_SOURCE } from './pricebook.js';
import { benchmarkFor } from '../engine/gasprices.js';
import { smartStop, evaluateStop, lastOpenBeforeGap } from '../engine/smartstop.js';
import { fuelCandidates, aheadCandidates, liveFor } from './smartstops.js';
import { RoadAlerts } from './roadalerts.js';
import { LiveWeather } from './weather.js';
import { roadIntel } from '../engine/roadintel.js';
import { FocusStabilizer } from '../engine/dashboard.js';
import { NavMap } from './navmap.js';
import { fetchChargers, DEMO_KEY } from './chargers.js';
import { miles, clock, spokenMiles } from './format.js';
import {
  loadCoreData, loadCorridors, loadDemoRouteJSON, loadVehicles, fetchRoutes, searchPlaces, currentPosition,
  LocationService, ScreenWake, Announcer, store, dataStatus, serviceSwitches,
} from './services.js';
import { loadProxy, switchedOff } from './proxy.js';
import * as V from './views.js';
import {
  loadProfile, writeProfile, settingsFromProfile, placesFromProfile, applyToProfile, profileVehicle, webVehicle,
  exportProfile, importProfile, PROFILE_KEY,
} from './profilestore.js';
import { defaultProfile } from '../engine/profile.js';

const VERSION = '2026.10.28';
const TITLES = { drive: 'Drive', ahead: 'Road Ahead', trip: 'Trip', settings: 'Settings' };

// The driver's profile (profilestore.js): loaded once, written on every change and read back. When the
// browser blocks storage (some private modes) a stand-in keeps the profile for this visit only, and
// Settings says so.
const browserStorage = (() => { try { localStorage.getItem(PROFILE_KEY); return localStorage; } catch { return null; } })();
const profileStorage = browserStorage ?? (() => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: () => { throw new Error('blocked'); } };
})();
const loaded = loadProfile(profileStorage);

const app = {
  version: VERSION,
  data: null, corridors: null, corridorsLoading: null,
  tab: 'drive', mode: 'idle', gps: 'device',
  // The adaptive Drive card, held steady between readings; the Navigation View map (created on first use).
  focusStabilizer: new FocusStabilizer(), navMap: null,
  plan: null, session: null, snapshot: null,
  discovery: null, discoveryStatus: 'Waiting for highway speed',
  isRerouting: false, lastError: null, lastFixAt: null,
  remainingWaypoints: [], tripStartedAt: null,
  lastRerouteAt: null, lastPersistAt: null,
  profile: loaded.profile,
  settings: settingsFromProfile(loaded.profile),
  /// Where the profile came from, fields that could not be read, and the last save error.
  profileStatus: {
    source: loaded.source, problems: loaded.problems, persisted: null,
    saveError: !browserStorage ? 'browser storage is blocked' : loaded.wrote && !loaded.wrote.ok ? loaded.wrote.error : null,
  },
  history: store.get('ea.history', []),
  resumable: null,
  planner: { from: null, to: null, stops: [], results: [], busy: false, error: null },
  places: placesFromProfile(loaded.profile),
  placeSearch: { field: 'to', index: null, query: '', results: [], busy: false, error: null },
  exitsUI: { window: loaded.profile.driving.exitLookaheadMiles, filter: 'all' },
  alongRoute: { categories: [], brand: '', window: 100, results: null },
  fuel: store.get('ea.fuel', null),
  fuelUI: { mode: 'dashboard', gaugeEighths: 4, error: null },
  fuelAnnounced: new Set(),
  /// Stations the driver turned down on this trip ("Not this one"): SmartStop does not offer them again.
  rejectedStops: [],
  vehicles: null, vehiclesError: null, vehiclesLoading: null,
  vehiclePick: null,
  /// Google Maps prices: paid, off unless the driver turns them on, and looked up only on a tap (docs/17).
  prices: new GasPrices({ getKey: () => store.get('ea.googleKey', ''), getProxy: () => proxyFor('prices'), allowed: () => app.settings.prices?.google === true, onCall: countPriceCall, usedToday: () => app.priceCallsToday() }),
  /// Reported prices: the driver's own on this device, and shared driver reports when on (app/pricebook.js).
  priceBook: new PriceBook({ store, getProxy: () => proxyFor('community'), sources: () => ({ own: app.settings.prices?.ownReports !== false, shared: app.settings.prices?.community === true }) }),
  /// Road Ahead price comparison sort, and the price report sheet's state.
  priceUI: { sort: 'recommended' },
  /// EIA's weekly averages through the proxy (context only): {summary, at, error}.
  benchmarks: { summary: null, at: 0, error: null },
  report: null,
  /// The owner's key proxy when set in Settings and reachable: { base, prices, chargers, disabled }.
  proxy: null,
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
  /// Road alert sources for the active trip (app/roadalerts.js).
  roadAlerts: new RoadAlerts({ proxyBase: () => proxyFor('wzdx') }),
  weather: new LiveWeather(),

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
  /// Stations no longer listed, and stops reported closed at the arrival time, do not count as gas.
  gasGapsAhead(s, window = 150 * MILE) {
    if (!this.plan || !s || this.settings.vehicle?.ev) return [];
    const end = Math.min(this.plan.route.length, s.progress + window);
    const key = `${this.plan.route.id}|${s.t}|${s.progress}|${end}|${this.settings.gasGapMiles}`;
    if (this.gapKey !== key) {
      this.gapKey = key;
      const stops = this.gasStops().filter((st) => st.distance <= s.progress || st.distance > end || this.gasStopUsable(st, s));
      this.gapCache = gasGaps(stops, s.progress, end, this.settings.gasGapMiles * MILE, this.plan.route.length);
    }
    return this.gapCache;
  },

  /// A gas stop counts unless every station there is no longer listed or reported closed when the driver gets there.
  gasStopUsable(stop, s) {
    const zone = this.plan.timeZoneIDAt(stop.distance) ?? 'America/New_York';
    const arrival = s.etaTo(stop.distance);
    if (stop.restArea) {
      const c = { id: stop.restArea.id, kind: 'plaza', arrival, timeZone: zone, plaza: { hours: stop.restArea.hours ?? null, toilets: null } };
      return evaluateStop(c, this.profile).hours.status !== 'closed';
    }
    const stations = this.data?.stations;
    return this.servicesFor(stop.exit).some((g) => {
      if (g.place.category !== 1) return false;
      const f = stations?.get(g.place.id);
      if (f?.gone) return false;
      if (!f?.h && !f?.ah) return true;
      const c = { id: g.place.id, kind: 'station', arrival: arrival + (g.detourSeconds ?? 0) / 2, timeZone: zone,
        osm: { hours: f.h ?? null, checked: f.hc ?? null, brandHours: f.ah ?? null, listedBy: f.ab ?? null, collected: stations.metadata.brand_collected ?? null } };
      return evaluateStop(c, this.profile).hours.status !== 'closed';
    });
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


  /// The next stop or the destination still ahead on a planned trip, for handing off to Waze.
  nextWaypoint() {
    return this.mode === 'trip' ? remainingWaypoints()[0] ?? null : null;
  },

  /// The weather where you are now (app/weather.js), only while a trip runs.
  weatherNow() {
    if (this.mode === 'idle' || !this.lastSample) return null;
    return this.weather.current(this.lastSample.coordinate);
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

  /// What SmartStop needs from the trip.
  stopContext() {
    return { plan: this.plan, snapshot: this.snapshot, servicesFor: (e) => this.servicesFor(e), stations: this.data?.stations ?? null, prices: this.prices,
      priceBook: this.priceBook, priceOptions: this.priceOptions() };
  },

  /// What prices are compared on: the driver's grade and payment, reports up to their age limit. Null when
  /// comparing prices is off or the vehicle is electric.
  priceOptions() {
    const pr = this.settings.prices;
    if (!pr || pr.compare === false || this.settings.vehicle?.ev) return null;
    return { grade: this.gradeCode(), payment: pr.payment ?? 'credit', maxAgeHours: pr.maxAgeHours ?? 24, now: Math.floor(Date.now() / 1000) };
  },

  /// A station or fuel plaza on the route by id, for its price sheet: from the stops ahead, else any exit or
  /// plaza on the route. With `live`, Google's record when the driver checked Google prices there.
  findStation(id) {
    if (!this.plan) return null;
    const near = this.snapshot ? this.bestStopAhead(Math.max(60, this.exitsUI.window))?.stations?.find((c) => c.id === id) : null;
    let x = near ? { ...near } : null;
    if (!x) {
      for (const e of this.plan.exits) {
        const g = this.servicesFor(e).find((y) => y.place.id === id && y.place.category === 1);
        if (g) { x = { id, name: placeDisplayName(g.place), brand: this.data?.stations?.get(id)?.b ?? g.place.brand, kind: 'station', exit: e, exitId: e.id, along: e.distanceAlongRoute, coordinate: g.place.coordinate }; break; }
      }
    }
    if (!x) {
      const r = this.plan.restAreas.find((y) => y.id === id && y.gas.length);
      if (r) x = { id, name: restAreaTitle(r), brand: r.gas[0] ?? '', kind: 'plaza', restArea: r, along: r.distanceAlongRoute, coordinate: r.coordinate };
    }
    if (x?.exit) x.live = liveFor(this.prices, x.exit, { coordinate: x.coordinate, name: x.name }, x.brand);
    return x;
  },

  /// EIA's average for the state the driver is in and the grade, when known and at most two weeks old:
  /// context and a sanity check only, never a station's price.
  benchmark(grade = this.gradeCode()) {
    const s = this.snapshot, sum = this.benchmarks.summary;
    if (!s?.current || !sum || Date.now() - Date.parse(sum.weekOf) > 14 * 86400000) return null;
    return benchmarkFor(sum, s.current.segment.code, grade);
  },

  /// The city and state of a station, for the GasBuddy link: the state from the route at once, the city
  /// from one OpenStreetMap reverse lookup (Nominatim) when the station's sheet opens.
  stationPlace(x) {
    const hit = this.placeCache.get(x.id);
    if (hit && !hit.pending) return hit;
    const code = x.along != null ? this.plan?.states.segmentAt(x.along)?.code ?? null : null;
    return { city: null, state: code };
  },
  placeCache: new Map(),

  /// Tank and mpg for the cost of a fill (gas vehicles with both known), else null.
  fillVehicle() {
    const v = this.vehicleProfile();
    return v && !v.ev && v.tankGallons > 0 && v.mpg > 0 ? { tankGallons: v.tankGallons, mpg: v.mpg } : null;
  },

  /// Changes whenever a price, a price setting or a Google lookup changes (cache keys below).
  priceKey() {
    const looked = [...this.prices.cache.values()].filter((c) => !c.pending).length;
    return `${this.priceBook.version}|${looked}|${JSON.stringify(this.settings.prices)}|${this.gradeCode()}|${Math.floor(Date.now() / 60000)}`;
  },

  /// SmartStop for the fuel stop: gas vehicles with a range reading, when a stop is needed. One
  /// recommendation and up to two alternatives, with the stop confidence of each.
  smartStop() {
    const fp = this.fuelPlan();
    if (!fp || fp.ev || fp.status === 'destination') return null;
    const st = this.settings;
    const key = `${this.fuelKey}|${this.rejectedStops.join()}|${JSON.stringify(this.profile.fuel)}|${JSON.stringify(this.profile.overnight)}|${this.priceKey()}`;
    if (this.smartKey !== key) {
      this.smartKey = key;
      const candidates = fuelCandidates(this.stopContext(), fp.range);
      this.smartCache = smartStop(candidates, this.profile, { context: 'fuel', reserveMeters: st.bufferMiles * MILE, rejected: this.rejectedStops, vehicle: this.fillVehicle() });
    }
    return this.smartCache;
  },

  /// The best stop in the next `miles` (any vehicle; restroom stops add rest areas).
  bestStopAhead(miles, { restrooms = false } = {}) {
    if (!this.plan || !this.snapshot) return null;
    // Recomputed every quarter mile or minute (Road Ahead and the restroom sheet ask on every render).
    const s = this.snapshot;
    const key = `${miles}|${restrooms}|${Math.floor(s.progress / 400)}|${Math.floor(s.t / 60)}|${this.rejectedStops.join()}|${this.fuelKey}|${JSON.stringify(this.profile.fuel)}|${JSON.stringify(this.profile.overnight)}|${this.plan.route.length}|${this.priceKey()}`;
    this.bestStopCache ??= new Map();
    if (this.bestStopCache.has(key)) return this.bestStopCache.get(key);
    if (this.bestStopCache.size > 8) this.bestStopCache.clear();
    const result = this.bestStopUncached(miles, restrooms);
    this.bestStopCache.set(key, result);
    return result;
  },

  bestStopUncached(miles, restrooms) {
    const range = this.settings.vehicle?.ev ? null : this.rangeNow();
    const candidates = aheadCandidates(this.stopContext(), miles, { rangeLeft: range, restrooms });
    const profile = restrooms ? { ...this.profile, fuel: { ...this.profile.fuel, requireRestroom: 'always' } } : this.profile;
    const result = smartStop(candidates, profile, {
      context: 'ahead', purpose: restrooms ? 'restroom' : 'fuel', reserveMeters: this.settings.bufferMiles * MILE, rejected: this.rejectedStops,
      vehicle: restrooms ? null : this.fillVehicle(),
    });
    // Every station and fuel plaza in the window, for the price comparison (Road Ahead, Fuel).
    result.stations = restrooms ? [] : candidates.filter((c) => c.kind !== 'rest');
    return result;
  },

  /// Overnight: the last stop listed open before a long stretch where the stops ahead are not, within
  /// 150 miles (docs/12, 12.10). Recomputed every half mile or five minutes.
  lastOpenAhead() {
    const s = this.snapshot;
    if (!this.plan || !s) return null;
    const key = `${Math.floor(s.progress / 800)}|${Math.floor(s.t / 300)}|${this.rejectedStops.join()}|${JSON.stringify(this.profile.overnight)}|${this.settings.gasGapMiles}|${this.plan.route.length}`;
    if (this.lastOpenKey !== key) {
      this.lastOpenKey = key;
      const candidates = aheadCandidates(this.stopContext(), 150, { rangeLeft: null });
      this.lastOpenCache = lastOpenBeforeGap(candidates, this.profile, {
        minLength: this.settings.gasGapMiles * MILE, windowEnd: Math.min(s.progress + 150 * MILE, this.plan.route.length), rejected: this.rejectedStops,
      });
    }
    return this.lastOpenCache;
  },

  /// Road alerts on the route ahead and a status per Settings group (engine/roadintel.js). Expiry and
  /// freshness use the real clock; arrival times come from the trip.
  roadIntel() {
    const s = this.snapshot;
    if (!this.plan || !s) return null;
    const now = Date.now() / 1000;
    const providers = this.roadAlerts.providers();
    const key = `${Math.floor(s.progress / 320)}|${Math.floor(now / 60)}|${providers.map((p) => `${p.id}:${p.state}:${p.fetchedAt}`).join()}|${JSON.stringify(this.settings.alerts)}|${this.plan.route.length}`;
    if (this.intelKey !== key) {
      this.intelKey = key;
      this.intelCache = roadIntel(this.plan.route, s.progress, providers, {
        now, enabled: this.settings.alerts ?? {}, etaAt: (d) => now + (s.etaTo(d) - s.t),
      });
    }
    return this.intelCache;
  },

  secret(key) { return store.get(key, ''); },

  priceCalls() {
    const c = store.get('ea.priceCalls', null);
    return c && c.month === new Date().toISOString().slice(0, 7) ? c.n : 0;
  },

  /// Google lookups on this device today, by the Pacific day when Google's daily quota resets.
  priceCallsToday() {
    const d = store.get('ea.priceCallsDay', null);
    return d && d.day === pacificDay() ? d.n : 0;
  },

  /// Gas grade key for prices: the grade chosen in Settings, else the vehicle's EPA fuel type.
  gradeCode() {
    if (GRADES[this.settings.fuelGrade]) return this.settings.fuelGrade;
    const f = this.settings.vehicle?.fuel;
    return f === 'P' || f === 'M' || f === 'D' ? f : 'R';
  },
};
window.exitAtlas = app; // for debugging from the console

// MARK: Rendering

const $ = (sel) => document.querySelector(sel);
let renderQueued = false;
let lastViewHTML = '';
let lastWeatherHTML = '';
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
  if (app.demoPrices && app.snapshot) seedSimulatedPrices();
  applyTheme();
  const highway = app.tab === 'drive' && app.mode === 'discovery' && app.plan?.route.title;
  $('#title').textContent = highway || TITLES[app.tab];
  // On the Drive screen the weather takes the place of the "Drive" title; next to a highway name it is compact.
  const wx = app.tab === 'drive' ? V.weatherPill(app, { compact: Boolean(highway) }) : '';
  if (wx !== lastWeatherHTML) { $('#weather').innerHTML = wx; lastWeatherHTML = wx; }
  // The condition goes when it does not fit next to the status pill (the sheet always shows it).
  const cond = $('#weather .wx-cond');
  if (cond) { cond.parentNode.classList.remove('tight'); cond.parentNode.classList.toggle('tight', cond.scrollWidth > cond.clientWidth + 1); }
  $('#title').hidden = Boolean(wx) && !highway;
  $('#status').innerHTML = V.statusPill(app);
  const along = $('#sheet.open [data-along]');
  if (along) along.textContent = V.aheadText(app.snapshot, Number(along.dataset.along));
  $('#end').hidden = app.mode === 'idle';
  $('#banner').innerHTML = app.gps === 'simulation' && app.mode !== 'idle'
    ? `<div class="banner">▶︎ Simulated drive at ${app.sim?.speedup ?? 30}× · sample route, not your GPS
        <span class="spacer"></span><button class="btn sm" data-act="sim-speed">${app.sim?.speedup === 120 ? '30×' : '120×'}</button></div>` : '';
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.arg === app.tab);
  $('#settings-btn').classList.toggle('on', app.tab === 'settings');
  if (!app.data) return;
  if (app.tab === 'ahead' && app.mode !== 'idle') {
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
    case 'ahead': html = V.exitsView(app); break;
    case 'trip': html = V.tripView(app); break;
    case 'settings': html = V.settingsView(app); break;
    default: html = V.driveView(app);
  }
  if (html !== lastViewHTML) {
    $('#view').innerHTML = html;
    lastViewHTML = html;
  }
  syncNavMap();
}

/// The Navigation View map: shown on the Drive tab during a trip unless the driver chose the Focus View. The
/// map element stays outside #view so it survives re-renders; the camera keeps the vehicle between the
/// guidance banner and the bottom card, a little low so more road ahead shows.
function syncNavMap() {
  const on = Boolean(app.tab === 'drive' && app.snapshot && app.plan && app.settings.drivePresentation !== 'focus');
  document.body.classList.toggle('nav-mode', on);
  if (!on) return;
  const top = Math.max($('.appbar').getBoundingClientRect().bottom, $('#banner').getBoundingClientRect().bottom);
  document.documentElement.style.setProperty('--chrome-top', `${Math.round(top)}px`);
  // Portrait: the card and trip strip sit across the bottom. Landscape: they fill a right hand column, so the
  // map's open area is to their left.
  const panel = $('.nav-bottom')?.getBoundingClientRect() ?? null;
  const side = Boolean(panel && panel.left > window.innerWidth * 0.4);
  const tabTop = $('.tabbar').getBoundingClientRect().top;
  const bottom = side ? tabTop : panel?.top ?? window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--attr-bottom', `${Math.round(window.innerHeight - bottom + 4)}px`);
  root.setProperty('--attr-right', `${side ? Math.round(window.innerWidth - panel.left + 8) : 4}px`);
  if (!app.navMap) {
    app.navMap = new NavMap($('#navmap'));
    app.navMap.onChange = () => { lastViewHTML = ''; render(); };
  }
  const theme = document.documentElement.getAttribute('data-theme');
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  app.navMap.ensure(dark ? 'dark' : 'light');
  const st = V.navMapState(app, app.snapshot);
  const guideBottom = $('.nav-top')?.getBoundingClientRect().bottom ?? top;
  const visible = Math.max(80, bottom - guideBottom);
  st.padding = {
    top: Math.round(guideBottom + visible * 0.3), bottom: Math.round(window.innerHeight - bottom + 16),
    left: 24, right: side ? Math.round(window.innerWidth - panel.left + 16) : 24,
  };
  st.duration = app.gps === 'simulation' ? 260 : 900;
  app.navMap.update(st);
}

function applyTheme() {
  const t = app.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function openSheet(kind, arg = null) {
  app.sheet = { kind, arg };
  if (kind === 'fuel') ensureChargers();
  renderSheet();
  $('#sheet').scrollTop = 0;
  $('#sheet-backdrop').classList.add('open');
  $('#sheet').classList.add('open');
}

function renderSheet() {
  if (!app.sheet) return;
  const { kind, arg } = app.sheet;
  let html = '';
  if (kind === 'exit') html = V.exitDetail(app, arg);
  else if (kind === 'rest') html = V.restAreaDetail(app, arg);
  else if (kind === 'discover') html = V.discoverSheet(app, arg);
  else if (kind === 'place') html = V.placeSearchSheet(app);
  else if (kind === 'search') html = V.alongRouteSheet(app);
  else if (kind === 'fuel') html = V.fuelSheet(app);
  else if (kind === 'station') { html = V.stationSheet(app, arg); lookupStationPlace(arg); }
  else if (kind === 'report') html = V.reportSheet(app);
  else if (kind === 'stop') html = V.stopSheet(app);
  else if (kind === 'vehicle') html = V.vehicleSheet(app);
  else if (kind === 'weather') html = V.weatherSheet(app);
  else if (kind === 'restroom') html = V.restroomSheet(app);
  else if (kind === 'alert') html = V.alertSheet(app, arg);
  $('#sheet-body').innerHTML = html;
  if (kind === 'place') setTimeout(() => $('#sheet-body input[name="q"]')?.focus(), 250);
}

function closeSheet() {
  app.sheet = null;
  app.report = null;
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
  return { states: app.data.states, timeZones: app.data.timeZones, interstates: app.data.interstates, restAreas: app.data.restAreas, discover: app.data.discover };
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
  // Gas: the SmartStop pick (station and exit); electric: the charging stop.
  const sp = app.smartStop()?.primary;
  const rec = sp ? { key: sp.id, ahead: sp.ahead, rangeOnArrival: sp.rangeOnArrival, smart: sp } : fp.recommended;
  const what = (x) => (x.smart ? `${x.smart.name}${x.smart.exit ? `, ${exitTitle(x.smart.exit)}` : ''}`
    : x.kind === 'charge' ? x.charger.name.replace(/ - Tesla Supercharger$/, ' Supercharger') : exitTitle(x.exit));
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

// MARK: Profile

/// Writes the settings, places and lookahead into the profile and saves it. Returns false (and says so)
/// when the browser did not keep the change.
function saveProfile() {
  app.profile = applyToProfile(app.profile, app.settings, app.places, app.exitsUI.window);
  return persistProfile();
}

/// Saves app.profile as it is and refreshes the settings and places read from it.
function persistProfile() {
  const r = writeProfile(profileStorage, app.profile);
  app.profileStatus.saveError = r.ok ? null : (browserStorage ? r.error : 'browser storage is blocked');
  app.settings = settingsFromProfile(app.profile);
  app.places = placesFromProfile(app.profile);
  if (!r.ok) toast(`Not saved: ${app.profileStatus.saveError}`);
  else if (app.profileStatus.persisted === null) requestPersistence();
  lastViewHTML = '';
  return r.ok;
}

/// Asks the browser to keep this site's storage under storage pressure (Chrome, Firefox, Edge; Safari
/// keeps Home Screen web apps' data instead).
async function requestPersistence() {
  try {
    app.profileStatus.persisted = await navigator.storage?.persist?.() ?? false;
  } catch {
    app.profileStatus.persisted = false;
  }
}

/// Replaces the profile with one from a file (exported here or from the iOS app), after asking.
async function importProfileFile(file) {
  try {
    const { profile, problems } = importProfile(await file.text());
    const what = `${profile.vehicles.length} vehicle${profile.vehicles.length === 1 ? '' : 's'}, ${profile.fuel.brands.length} favorite brand${profile.fuel.brands.length === 1 ? '' : 's'}, ${profile.places.saved.length + (profile.places.home ? 1 : 0)} saved place${profile.places.saved.length + (profile.places.home ? 1 : 0) === 1 ? '' : 's'}`;
    if (!confirm(`Replace the profile on this device with this one (${what})?${problems.length ? ` ${problems.length} unreadable field(s) will use defaults.` : ''}`)) return;
    app.profile = profile;
    app.exitsUI.window = profile.driving.exitLookaheadMiles;
    if (persistProfile()) toast('Profile imported');
    render();
  } catch (e) {
    toast(e.message);
  }
}

/// Saved vehicles other than the one in use, most recent first, in the shape the views use.
function garage() {
  return app.profile.vehicles.filter((v) => v.id !== app.profile.defaultVehicleId).map(webVehicle);
}
app.garage = garage;

function samePlace(a, b) {
  return a && b && (a.name === b.name || (Math.abs(a.coordinate.lat - b.coordinate.lat) < 0.001 && Math.abs(a.coordinate.lon - b.coordinate.lon) < 0.001));
}

function recordPlace(w) {
  if (!w?.coordinate || w.name === 'Current location') return;
  app.places.recent = [w, ...app.places.recent.filter((r) => !samePlace(r, w))].slice(0, 10);
  saveProfile();
}

function setHome(w) {
  app.places.home = { name: w.name, coordinate: w.coordinate };
  if (saveProfile()) toast(`Home set: ${w.name}`);
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

/// Saves the planner's places as a trip plan (start, stops, destination) in the profile.
function savePlan() {
  const p = app.planner;
  if (!p.to) return;
  const stops = p.stops.filter(Boolean);
  const name = stops.length ? `${p.to.name} via ${stops.map((x) => x.name.split(',')[0]).join(', ')}` : p.to.name;
  const same = (t) => samePlace(t.to, p.to) && (t.from?.name ?? null) === (p.from?.name ?? null)
    && t.stops.length === stops.length && t.stops.every((x, i) => samePlace(x, stops[i]));
  app.places.plans = [{ name: name.slice(0, 80), from: p.from ?? null, stops, to: p.to }, ...app.places.plans.filter((t) => !same(t))].slice(0, 20);
  if (saveProfile()) toast(`Trip saved: ${name}`);
  render();
}

/// Fills the planner from a saved plan and finds routes.
function openPlan(t) {
  const p = app.planner;
  p.from = t.from ?? null;
  p.stops = [...t.stops];
  goTo(t.to);
}

// MARK: Prices and chargers

/// Shared driver reports for the stations SmartStop and the price comparison look at (free, budgeted on
/// the owner's server; only when the driver turned them on). Re-renders when new ones arrive.
function loadSharedPrices() {
  loadBenchmarks();
  if (!app.priceBook.sharedOn || !app.plan || !app.snapshot) return;
  const ids = new Set();
  const sm = app.smartStop();
  for (const x of [sm?.primary, ...(sm?.alternatives ?? [])]) if (x) ids.add(x.id);
  for (const c of app.bestStopAhead(Math.max(60, app.exitsUI.window))?.stations ?? []) ids.add(c.id);
  app.priceBook.loadShared([...ids]).then((changed) => { if (changed) { lastViewHTML = ''; render(); if (app.sheet) renderSheet(); } }).catch(() => {});
}

function countPriceCall() {
  const month = new Date().toISOString().slice(0, 7);
  const c = store.get('ea.priceCalls', { month, n: 0 });
  store.set('ea.priceCalls', c.month === month ? { month, n: c.n + 1 } : { month, n: 1 });
  const day = pacificDay();
  const d = store.get('ea.priceCallsDay', { day, n: 0 });
  store.set('ea.priceCallsDay', d.day === day ? { day, n: d.n + 1 } : { day, n: 1 });
}

/// EIA's weekly averages, through the proxy when it offers them (EIA sends no CORS header), every 6 hours.
function loadBenchmarks() {
  const base = proxyFor('benchmarks');
  const b = app.benchmarks;
  if (!base || b.pending || Date.now() - b.at < (b.error ? 30 * 60000 : 6 * 3600000)) return;
  b.pending = true;
  fetch(new URL('v1/fuel-benchmarks', base)).then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((json) => {
      if (typeof json?.weekOf !== 'string' || typeof json.regular !== 'object') throw new Error('not a summary');
      Object.assign(b, { summary: { weekOf: json.weekOf, regular: json.regular, diesel: json.diesel ?? {} }, error: null });
      lastViewHTML = '';
      render();
    })
    .catch((e) => { b.error = e.message; })
    .finally(() => { b.pending = false; b.at = Date.now(); });
}

/// One reverse lookup per station (only when its sheet opens; Nominatim's usage policy allows light use).
function lookupStationPlace(id) {
  const x = app.findStation(id);
  if (!x?.coordinate || app.placeCache.has(id)) return;
  app.placeCache.set(id, { pending: true });
  const q = new URLSearchParams({ format: 'jsonv2', lat: x.coordinate.lat, lon: x.coordinate.lon, zoom: 10, addressdetails: 1 });
  fetch(`https://nominatim.openstreetmap.org/reverse?${q}`, { headers: { 'Accept-Language': 'en-US' } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((json) => {
      const a = json?.address ?? {};
      app.placeCache.set(id, { city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null, state: a.state ?? app.stationPlace(x).state });
      if (app.sheet?.kind === 'station' && app.sheet.arg === id) renderSheet();
    })
    .catch(() => app.placeCache.delete(id));
}

/// Changes price settings (saved in the profile).
function setPrices(patch) {
  app.settings.prices = { ...app.settings.prices, ...patch };
  saveProfile();
  lastViewHTML = '';
  render();
  if (app.sheet) renderSheet();
}

/// Shared reports need the driver at the station: one location reading, compared with the station, never
/// sent anywhere. Simulated GPS cannot pass.
function checkReportLocation() {
  const r = app.report;
  if (!r) return;
  const fail = (note) => { if (app.report === r) { r.near = false; r.checking = false; r.nearNote = note; renderSheet(); } };
  if (app.gps === 'simulation') return fail('Simulated GPS: sharing needs your real location at the station');
  if (!navigator.geolocation || !r.coordinate) return fail('Location not available: saved on this device only');
  r.checking = true;
  renderSheet();
  navigator.geolocation.getCurrentPosition((pos) => {
    if (app.report !== r) return;
    const d = distance({ lat: pos.coords.latitude, lon: pos.coords.longitude }, r.coordinate);
    if (pos.coords.accuracy > 150) return fail('Your location is too rough to check: saved on this device only');
    if (d > 250) return fail(`About ${miles(d)} from this station: saved on this device only`);
    r.near = true; r.checking = false; r.nearNote = null;
    renderSheet();
  }, () => fail('Location not allowed: saved on this device only'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

/// Google Maps prices for exits, only when the driver taps "Check Google Maps prices" (paid; off unless
/// turned on in Settings). Re-renders when they arrive.
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
  fetchChargers(route.polyline, { apiKey: store.get('ea.nrelKey', DEMO_KEY), network: app.settings.chargerNetwork, proxy: proxyFor('chargers') })
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
/// Home Screen web app (its storage is kept by Safari) and iPhone Safari (storage removed after 7 idle days).
app.standalone = (() => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; } })();
app.isIOSSafari = /iPhone|iPad|iPod/.test(navigator.userAgent);

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

/// Makes a vehicle the one in use. Each saved vehicle keeps its own MPG or range choice.
function useVehicle(v) {
  app.profile = applyToProfile(app.profile, app.settings, app.places, app.exitsUI.window);
  const picked = profileVehicle(v, {});
  if (!picked) return;
  // The same car chosen again (same id, or same EPA id) replaces the saved one and keeps its id.
  const prev = app.profile.vehicles.find((x) => x.id === (v.id ?? picked.id) || (x.epaId && x.epaId === picked.epaId));
  const keep = prev ? { mpgBasis: prev.mpgBasis, customMpg: prev.customMpg, customRangeMiles: prev.customRangeMiles } : {};
  const merged = { ...picked, ...keep, id: prev?.id ?? picked.id };
  app.profile.vehicles = [merged, ...app.profile.vehicles.filter((x) => x.id !== merged.id)].slice(0, 10);
  app.profile.defaultVehicleId = merged.id;
  persistProfile();
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
  app.rejectedStops = [];
  app.smartKey = null;
  app.bestStopCache = null;
  app.announcer.reset();
  app.roadAlerts.reset();
  app.weather.reset();
  app.intelKey = null;
  app.limits = null;
  app.lastSpeed = null;
  app.focusStabilizer.reset();
  if (app.navMap) app.navMap.following = true;
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
  app.announcer.consider(snap, app.settings, {
    zoneID: app.plan?.timeZoneIDAt(snap.progress) ?? null, gasGap: gap, lastOpen: app.lastOpenAhead(), alerts: app.roadIntel()?.alerts ?? [],
  });
  // Road alert sources: fetched only while a trip runs, when due (app/roadalerts.js).
  app.roadAlerts.refresh(app.plan, snap.progress, { online: navigator.onLine !== false, enabled: app.settings.alerts ?? {} })
    .then((changed) => { if (changed) { lastViewHTML = ''; render(); } })
    .catch(() => {});
  // Current weather where you are: also only while a trip runs, when due (app/weather.js).
  app.weather.refresh(app.lastSample?.coordinate, { online: navigator.onLine !== false })
    .then((changed) => { if (changed) { render(); if (app.sheet?.kind === 'weather') renderSheet(); } })
    .catch(() => {});
  considerFuelVoice();
  ensureLimits();
  ensureChargers();
  loadSharedPrices();
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
  const exit = app.plan?.exits.find((e) => e.id === exitID);
  const place = exit && app.servicesFor(exit).find((x) => x.place.id === placeID)?.place;
  if (!place) return;
  await addWaypointStop({ name: placeDisplayName(place), coordinate: place.coordinate }, exit.distanceAlongRoute);
}

/// Inserts a stop before the first remaining stop farther along the route, then reroutes.
async function addWaypointStop(waypoint, alongRoute) {
  if (!app.canAddStop()) { toast('Adding a stop needs live GPS'); return; }
  const along = (w) => app.plan.route.stops.find((st) => st.waypoint.name === w.name)?.distanceAlongRoute ?? Infinity;
  const list = remainingWaypoints();
  const at = list.findIndex((w) => along(w) > alongRoute);
  list.splice(at < 0 ? list.length - 1 : at, 0, waypoint);
  app.remainingWaypoints = list;
  closeSheet();
  toast(`Adding ${waypoint.name}`);
  await reroute(app.lastSample, { force: true, spoken: `Stop added: ${waypoint.name}.` });
}

/// The proxy's base URL for a service it offers and has not switched off, else null.
function proxyFor(service) {
  return app.proxy?.[service] && !switchedOff(app.proxy, service) ? app.proxy.base : null;
}

/// Reads the proxy's switches (Settings URL); without a reachable proxy everything works as before.
async function refreshProxy() {
  app.proxy = await loadProxy(store.get('ea.proxyURL', ''));
  serviceSwitches.disabled = app.proxy?.disabled ?? [];
  app.chargers.retryAt = 0;
  lastViewHTML = '';
  render();
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

/// The simulated demo. For screenshots and checks: ?demo=<mile> starts at that mile, ?demo&alert adds one
/// SIMULATED crash 6 miles ahead, labeled as a simulated test alert everywhere it shows, and ?demo&prices adds
/// SIMULATED gas prices at the first stations ahead, labeled "Simulated test data" (memory only).
async function runDemo({ mile = 355, alert = false, prices = false } = {}) {
  try {
    const json = await loadDemoRouteJSON();
    const route = routeFromJSON(json, {
      source: 'osrm', origin: null, destination: null, title: 'Sample route (OSRM, OpenStreetMap)',
    });
    route.origin = { name: 'Miami, FL', coordinate: route.polyline.point(0) };
    route.destination = { name: 'Manhattan, NY', coordinate: route.polyline.point(route.polyline.pointCount - 1) };
    startTrip(route, { simulate: true, startMeters: mile * MILE });
    // Seeded at render time, for the stations ahead then (the demo moves).
    app.demoPrices = prices;
    if (alert) {
      const d = (mile + 6) * MILE;
      const hw = route.highwayAt(d);
      const now = Date.now() / 1000;
      app.roadAlerts.demoIncidents = [{
        id: 'demo:crash', category: 'crash', description: 'Crash (SIMULATED TEST ALERT)', source: { id: 'demo', name: 'Simulated test alert' },
        verification: 'official', reportedAt: now - 360, updatedAt: now - 360, startsAt: null, endsAt: null, expiresAt: null,
        geometry: { type: 'point', coordinate: route.polyline.coordinateAt(d) }, road: hw ? `${hw.ref.prefix}-${hw.ref.number}` : null,
        direction: hw?.direction ?? null, lanes: 'Right lane blocked', severity: 'major',
      }];
      app.intelKey = null;
      render();
    }
  } catch (e) {
    toast(`Demo failed: ${e.message}`);
  }
}

/// SIMULATED prices for the demo: a current one, a current one three drivers agree on, an old one, and
/// stations without any, so every state shows. Never saved or sent.
function seedSimulatedPrices() {
  const ahead = (app.bestStopAhead(60)?.stations ?? []).filter((c) => c.kind === 'station' && c.ahead > 0).sort((a, b) => a.ahead - b.ahead);
  // The fuel stop pick (when a range is entered) gets a price too, so the cheaper stop note can show.
  const pick = app.smartStop()?.primary;
  const plan = [[3.099, 20 * 60, 1], [2.899, 2 * 3600, 3], [3.189, 30 * 3600, 1], [3.299, 40 * 60, 1]];
  const stations = ahead.slice(0, 3);
  if (pick && !stations.some((c) => c.id === pick.id)) stations.push(pick);
  const have = new Set(app.priceBook.simulated.map((r) => r.stationId));
  if (stations.every((c) => have.has(c.id))) return;
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  stations.forEach((c, i) => {
    const [price, age, n] = plan[i];
    for (let k = 0; k < n; k++) {
      out.push({ id: `sim:${c.id}:${k}`, stationId: c.id, grade: app.gradeCode(), price, currency: 'USD', payment: 'credit', member: false,
        reportedAt: now - age - k * 600, reporter: `sim${k}`, source: SIMULATED_SOURCE });
    }
  });
  app.priceBook.simulated = out;
  app.priceBook.version++;
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
  tab(arg) { app.tab = arg === 'exits' ? 'ahead' : arg; lastViewHTML = ''; window.scrollTo(0, 0); render(); },
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
  discover(arg) { openSheet('discover', arg); },
  'add-place-stop'(arg) {
    const x = app.plan?.discover.find((d) => d.item.id === arg);
    if (x) addWaypointStop({ name: x.item.name, coordinate: x.item.coordinate }, x.distanceAlongRoute);
  },
  async 'share-card'() {
    const s = app.snapshot, plan = app.plan;
    if (!s || !plan) return;
    const totals = new Map();
    for (const st of s.drivenStints) {
      const e = totals.get(st.code ?? st.name) ?? { code: st.code, name: st.name, meters: 0 };
      e.meters += st.meters;
      totals.set(st.code ?? st.name, e);
    }
    const title = app.mode === 'discovery' ? plan.route.title : `${plan.route.origin.name} to ${plan.route.destination.name}`;
    const canvas = document.createElement('canvas');
    drawTripCard(canvas, { title, date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      // The total is the sum of the states shown (the demo starts partway, which is not driving).
      totalMeters: [...totals.values()].reduce((a, e) => a + e.meters, 0), states: [...totals.values()], simulated: app.gps === 'simulation' });
    try {
      const how = await shareCanvas(canvas, 'exitatlas-trip.png', `${title} on ExitAtlas`);
      if (how === 'downloaded') toast('Trip card saved');
    } catch (e) { toast(e.message); }
  },
  'gas-gap'(arg) { app.settings.gasGapMiles = Number(arg); saveProfile(); render(); },
  sheet(arg) {
    if (arg === 'search') app.alongRoute.results = null;
    if (arg === 'stop') app.stopQuery.results = null;
    openSheet(arg);
  },
  'close-sheet'() { closeSheet(); },
  'exits-window'(arg) { app.exitsUI.window = Number(arg); saveProfile(); lastExitsRender = 0; render(); },
  'ahead-filter'(arg) { app.exitsUI.filter = arg || 'all'; lastExitsRender = 0; render(); },
  alert(arg) { openSheet('alert', arg); },
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
    const place = src === 'home' ? app.places.home : src === 'saved' ? app.places.saved[Number(i)]
      : src === 'recent' ? app.places.recent[Number(i)] : app.placeSearch.results[Number(i)];
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
  'go-to'(arg) {
    const w = arg === 'home' ? app.places.home : arg.startsWith('saved:') ? app.places.saved[Number(arg.slice(6))] : app.places.recent[Number(arg)];
    if (w) goTo(w);
  },
  'set-home'(arg) {
    const [src, i] = arg.split(':');
    const w = src === 'recent' ? app.places.recent[Number(i)] : app.placeSearch.results[Number(i)];
    if (w) { setHome(w); renderSheet(); lastViewHTML = ''; render(); }
  },
  'clear-home'() { app.places.home = null; saveProfile(); render(); },
  'clear-recent'() { app.places.recent = []; saveProfile(); render(); },
  'fav-brand'(arg) {
    const st = app.settings;
    st.favoriteBrands = st.favoriteBrands.includes(arg) ? st.favoriteBrands.filter((b) => b !== arg) : [...st.favoriteBrands, arg];
    saveProfile();
    render();
    if (app.sheet) renderSheet();
  },
  'charger-network'(arg) { app.settings.chargerNetwork = arg; saveProfile(); app.chargers.routeId = null; render(); },
  'find-routes'() { findRoutes(); },
  'start-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) { app.planner.results = []; startTrip(r.route); } },
  'simulate-route'(arg) { const r = app.planner.results[Number(arg)]; if (r) startTrip(r.route, { simulate: true }); },
  'sim-speed'() { if (app.sim) app.sim.speedup = app.sim.speedup === 120 ? 30 : 120; render(); },
  'drive-view'(arg) { app.settings.drivePresentation = arg === 'focus' ? 'focus' : 'map'; saveProfile(); window.scrollTo(0, 0); render(); },
  'nav-recenter'() { app.navMap?.recenter(); },
  'speed-alert'(arg) { app.settings.speedAlertOver = Number(arg); saveProfile(); render(); },
  'reset-pace'() { store.remove('ea.paceHistory'); lastViewHTML = ''; render(); toast('Pace history cleared'); },
  'test-voice'() {
    if (!app.announcer.supported) { toast('Voice is not supported in this browser'); return; }
    app.announcer.speak('Georgia state line in 3 miles. 4 exits remain in Florida.');
  },
  theme(arg) { app.settings.theme = arg; saveProfile(); render(); },
  'clear-data'() {
    if (!confirm('Erase your profile (vehicles, preferences, places and saved trips) and trip history on this device? API keys stay.')) return;
    for (const k of [PROFILE_KEY, `${PROFILE_KEY}.previous`, 'ea.settings', 'ea.history', 'ea.recent', 'ea.active', 'ea.window',
      'ea.paceHistory', 'ea.places', 'ea.fuel', 'ea.vehicles', 'ea.plates']) store.remove(k);
    app.profile = defaultProfile();
    app.settings = settingsFromProfile(app.profile);
    app.places = placesFromProfile(app.profile);
    app.exitsUI.window = app.profile.driving.exitLookaheadMiles;
    app.fuel = null;
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
    const v = garage()[Number(arg)];
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
  'mpg-basis'(arg) { app.settings.mpgBasis = arg; saveProfile(); render(); },
  'vehicle-remove'(arg) {
    const v = garage()[Number(arg)];
    if (!v || !confirm(`Remove ${v.year} ${v.make} ${v.model} from your vehicles?`)) return;
    app.profile.vehicles = app.profile.vehicles.filter((x) => x.id !== v.id);
    persistProfile();
    render();
  },
  'brand-move'(arg) {
    const [i, d] = arg.split(',').map(Number), list = [...app.settings.favoriteBrands];
    if (i + d < 0 || i + d >= list.length) return;
    [list[i], list[i + d]] = [list[i + d], list[i]];
    app.settings.favoriteBrands = list;
    saveProfile();
    render();
  },
  'brand-remove'(arg) { app.settings.favoriteBrands = app.settings.favoriteBrands.filter((_, i) => i !== Number(arg)); saveProfile(); render(); },
  'list-remove'(arg) {
    const [key, i] = arg.split(',');
    app.settings[key] = app.settings[key].filter((_, j) => j !== Number(i));
    saveProfile();
    render();
  },
  'fuel-grade'(arg) { app.settings.fuelGrade = arg || null; saveProfile(); render(); },
  'require'(arg) { const [key, v] = arg.split(','); app.settings[key] = v; saveProfile(); render(); },
  'detour'(arg) { app.settings.maxDetourMinutes = Number(arg); saveProfile(); render(); },
  'overnight-mode'(arg) { app.settings.overnightMode = arg; saveProfile(); render(); if (app.sheet) renderSheet(); },
  'fav-category'(arg) {
    const c = app.settings.favoriteCategories;
    app.settings.favoriteCategories = c.includes(arg) ? c.filter((x) => x !== arg) : [...c, arg];
    saveProfile();
    render();
  },
  'save-place'(arg) {
    const w = app.places.recent[Number(arg)];
    if (!w) return;
    app.places.saved = [w, ...app.places.saved.filter((p) => !samePlace(p, w))].slice(0, 50);
    if (saveProfile()) toast(`Saved: ${w.name}`);
    render();
  },
  'save-plan'() { savePlan(); },
  'open-plan'(arg) { const t = app.places.plans[Number(arg)]; if (t) openPlan(t); },
  'remove-plan'(arg) { app.places.plans = app.places.plans.filter((_, i) => i !== Number(arg)); saveProfile(); render(); },
  'price-sort'(arg) { app.priceUI.sort = arg; lastViewHTML = ''; render(); },
  station(arg) { openSheet('station', arg); },
  'price-pay'(arg) { setPrices({ payment: arg }); },
  'price-age'(arg) { setPrices({ maxAgeHours: Number(arg) }); },
  'price-min'(arg) { setPrices({ minSavingsDollars: Number(arg) }); },
  'report-price'(arg) {
    const [id, grade] = arg.split('|');
    const x = app.findStation(id);
    if (!x) return;
    // Correcting: the driver's latest report for that grade, within the 30 minutes a correction is allowed.
    const last = grade ? app.priceBook.own().filter((r) => r.stationId === id && r.grade === grade).sort((a, b) => b.reportedAt - a.reportedAt)[0] : null;
    app.report = {
      stationId: id, name: x.name, brand: x.brand, coordinate: x.coordinate,
      place: x.exit ? exitTitle(x.exit) : x.kind === 'plaza' ? 'Service plaza' : '',
      grade: grade || app.gradeCode(), payment: last?.payment ?? app.settings.prices?.payment ?? 'credit', member: Boolean(last?.member),
      priceText: last ? String(last.price) : '', share: app.priceBook.sharedOn, near: null, checking: false, passenger: false, result: null,
    };
    openSheet('report');
    if (app.report.share) checkReportLocation();
  },
  'report-grade'(arg) { if (app.report) { app.report.grade = arg; app.report.result = null; renderSheet(); } },
  'report-pay'(arg) { if (app.report) { app.report.payment = arg; app.report.result = null; renderSheet(); } },
  async 'report-save'() {
    const r = app.report;
    if (!r) return;
    const text = ($('#sheet-body [data-report="price"]')?.value ?? r.priceText ?? '').replace(/[$\s]/g, '');
    r.priceText = text;
    const out = await app.priceBook.report({ stationId: r.stationId, grade: r.grade, price: text === '' ? NaN : Number(text), payment: r.payment, member: r.member, stationName: r.name, place: r.place },
      { share: r.share, near: r.near === true, benchmark: app.benchmark(r.grade)?.price ?? null });
    r.result = out;
    if (out.ok && !out.duplicate) toast(out.shared === 'sent' ? 'Price saved and shared' : 'Price saved on this device');
    lastViewHTML = '';
    render();
    renderSheet();
  },
  'price-delete'(arg) { app.priceBook.remove(arg); toast('Report deleted'); lastViewHTML = ''; render(); renderSheet(); },
  'google-ahead'() {
    // The next three exits in the comparison whose Google prices were not looked up in the last 15 minutes.
    const r = app.bestStopAhead(Math.max(60, app.exitsUI.window));
    const win = app.exitsUI.window * MILE;
    const seen = new Set(), exits = [];
    for (const c of (r?.stations ?? []).filter((x) => x.exit && x.ahead > 0 && x.ahead <= win).sort((a, b) => a.ahead - b.ahead)) {
      if (seen.has(c.exit.id)) continue;
      seen.add(c.exit.id);
      const cached = app.prices.cache.get(c.exit.id);
      if (!cached || (!cached.pending && Date.now() - cached.at >= 15 * 60 * 1000)) exits.push(c.exit);
      if (exits.length === 3) break;
    }
    if (!exits.length) { toast('Google prices for these exits were checked in the last 15 minutes'); return; }
    loadPrices(exits);
    toast(`Checking Google Maps prices at ${exits.length} ${exits.length === 1 ? 'exit' : 'exits'}`);
  },
  'google-prices'(arg) {
    const exit = app.plan?.exits.find((e) => e.id === arg);
    if (!exit || !app.prices.enabled) return;
    loadPrices([exit]);
    renderSheet();
  },
  'skip-stop'(arg) {
    if (!app.rejectedStops.includes(arg)) app.rejectedStops.push(arg);
    toast('Skipped for this trip');
    lastViewHTML = '';
    render();
    renderSheet();
  },
  'unskip-stops'() { app.rejectedStops = []; lastViewHTML = ''; render(); renderSheet(); },
  'remove-saved'(arg) { app.places.saved = app.places.saved.filter((_, i) => i !== Number(arg)); saveProfile(); render(); },
  'export-profile'() {
    const blob = new Blob([exportProfile(app.profile)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `exitatlas-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'fuel-buffer'(arg) {
    app.settings.bufferMiles = Number(arg);
    saveProfile();
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
    if (el.dataset.secret === 'ea.proxyURL') {
      refreshProxy().then(() => toast(!v ? 'Proxy removed' : app.proxy ? 'Proxy connected' : 'Proxy not reachable; using your own keys'));
      return;
    }
    toast(v ? 'Key saved on this phone' : 'Key removed');
    lastViewHTML = '';
    render();
    return;
  }
  if (el.dataset?.import !== undefined) {
    const file = el.files?.[0];
    el.value = '';
    if (file) importProfileFile(file);
    return;
  }
  if (el.dataset?.list) {
    // Favorite hotel or restaurant brands: one entry per return.
    const key = el.dataset.list, v = el.value.trim();
    if (v && !app.settings[key].some((b) => b.toLowerCase() === v.toLowerCase())) {
      app.settings[key] = [...app.settings[key], v];
      saveProfile();
    }
    el.value = '';
    render();
    return;
  }
  if (el.dataset?.brand !== undefined) {
    const v = el.value.trim();
    if (v && !app.settings.favoriteBrands.some((b) => b.toLowerCase() === v.toLowerCase())) {
      app.settings.favoriteBrands = [...app.settings.favoriteBrands, v];
      saveProfile();
    }
    el.value = '';
    lastViewHTML = '';
    render();
    return;
  }
  if (el.dataset?.price) {
    setPrices({ [el.dataset.price]: el.checked });
    if (el.dataset.price === 'community' && el.checked) loadSharedPrices();
    return;
  }
  if (el.dataset?.report && app.report) {
    const k = el.dataset.report;
    if (k === 'price') { app.report.priceText = el.value; return; }
    app.report[k] = el.checked;
    if (k === 'share' && el.checked && app.report.near == null) checkReportLocation();
    renderSheet();
    return;
  }
  if (el.dataset?.alert) {
    app.settings.alerts = { ...app.settings.alerts, [el.dataset.alert]: el.checked };
    saveProfile();
    lastViewHTML = '';
    render();
    return;
  }
  const key = el.dataset?.set;
  if (!key) return;
  if (el.type === 'checkbox') app.settings[key] = el.checked;
  else if (el.type === 'time') { if (/^\d\d:\d\d$/.test(el.value)) app.settings[key] = el.value; }
  else if (el.dataset.kind === 'text') app.settings[key] = el.value.trim();
  else {
    const v = parseFloat(el.value);
    if (Number.isFinite(v) && v > 0) app.settings[key] = v;
  }
  saveProfile();
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

// Swipe down to close, like an iOS sheet: a downward pull that starts with the sheet scrolled to the top
// moves the sheet with the finger; letting go past a third of the way (or with a quick flick) closes it,
// anything less springs back. Sideways swipes, scrolling and the form fields keep working as before.
{
  const sheet = $('#sheet'), backdrop = $('#sheet-backdrop');
  let start = null, dragging = false, dy = 0, samples = [];
  const release = (e, close) => {
    if (!dragging) { start = null; return; }
    start = null;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    backdrop.style.opacity = '';
    const a = samples[0], b = samples[samples.length - 1];
    const speed = b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
    const flick = dy > 40 && speed > 0.5 && e.timeStamp - b.t < 100;
    if (close && (dy > sheet.offsetHeight / 3 || flick)) closeSheet();
  };
  sheet.addEventListener('touchstart', (e) => {
    // A second finger cancels the pull: the sheet springs back, and nothing moves until the fingers lift.
    if (dragging) { release(e, false); return; }
    start = e.touches.length === 1 && !e.target.closest('input, select, textarea')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    dragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (dragging && e.touches.length > 1) { release(e, false); return; }
    if (!start) return;
    const t = e.touches[0], mx = t.clientX - start.x, my = t.clientY - start.y;
    if (!dragging) {
      if (mx === 0 && my === 0) return;
      // Decided on the first move: once the browser starts scrolling, the move can no longer be taken over.
      if (my <= 0 || Math.abs(mx) > 2 * my || sheet.scrollTop > 0 || !e.cancelable) { start = null; return; }
      dragging = true;
      sheet.style.transition = 'none';
      samples = [];
    }
    e.preventDefault();
    dy = Math.max(0, my);
    // The last 100 ms of the pull give the release speed for a flick.
    samples.push({ y: my, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > 100) samples.shift();
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(1 - Math.min(dy / sheet.offsetHeight, 1));
  }, { passive: false });
  sheet.addEventListener('touchend', (e) => release(e, true));
  sheet.addEventListener('touchcancel', (e) => release(e, false));
}

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
    app.data = await loadCoreData((f, total) => {
      bar.style.width = `${(f * 100).toFixed(0)}%`;
      label.textContent = `Loading offline data ${(f * total / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`;
    });
    app.dataStatus = dataStatus;
    refreshProxy();
  } catch (e) {
    label.innerHTML = `Could not load the offline data: ${e.message}. <button class="btn sm" onclick="location.reload()">Retry</button>`;
    return;
  }
  app.resumable = loadResumable();
  if (app.fuel?.drivenAtEntry > 0 && !app.resumable) rebaseFuel(app.fuel.drivenAtEntry);
  $('#loading').remove();
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    const mile = Number(params.get('demo'));
    runDemo({ mile: Number.isFinite(mile) && mile > 0 && mile < 1280 ? mile : 355, alert: params.has('alert'), prices: params.has('prices') });
  }
  render();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
