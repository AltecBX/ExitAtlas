// The Navigation View map: MapLibre GL JS (BSD 3 clause, bundled in web/vendor) over OpenFreeMap vector tiles
// (OpenStreetMap data, no key or account, attribution shown on the map). Only the route, the vehicle and the
// few things the Drive screen points at are drawn: the next exit, the alert in the adaptive card, the
// recommended stop, a planned stop and the next state line. Loaded on first use. Offline, or when the tiles
// fail, the route and the markers still draw on a plain background and `offline` says so. Tiles are never
// stored by the app (the service worker leaves other origins alone).

const VERSION = '5.24.0';
const LIB = `vendor/maplibre-gl-${VERSION}/maplibre-gl.js`;
const LIB_CSS = `vendor/maplibre-gl-${VERSION}/maplibre-gl.css`;
const STYLES = { dark: 'https://tiles.openfreemap.org/styles/dark', light: 'https://tiles.openfreemap.org/styles/positron' };
/// The route drawn ahead of the vehicle and behind it (meters).
const AHEAD = 160000;
const BEHIND = 40000;

let library = null;

/// Loads MapLibre once (script and stylesheet from the site itself).
export function loadMapLibrary() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  library ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LIB_CSS;
    document.head.append(css);
    const js = document.createElement('script');
    js.src = LIB;
    js.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('map library did not start')));
    js.onerror = () => { library = null; reject(new Error('map library did not load')); };
    document.head.append(js);
  });
  return library;
}

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/// A style with no tiles at all: the background, for offline use.
function plainStyle() {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': token('map-bg') } }] };
}

/// OpenFreeMap's style in the ExitAtlas palette: calm land and water, roads quiet, interstates a step
/// brighter, labels muted. Nothing is added; only colors change.
function tunedStyle(style) {
  const bg = token('map-bg'), water = token('map-water'), road = token('map-road'), motorway = token('map-motorway'), label = token('map-label');
  for (const l of style.layers) {
    const id = l.id;
    l.paint ??= {};
    if (l.type === 'background') l.paint['background-color'] = bg;
    else if (id === 'water') l.paint['fill-color'] = water;
    else if (id === 'waterway') l.paint['line-color'] = water;
    else if (l.type === 'fill' && /landuse|landcover|park|building|aeroway/.test(id)) l.paint['fill-opacity'] = 0.35;
    else if (l.type === 'line' && /motorway/.test(id) && !/casing/.test(id)) l.paint['line-color'] = motorway;
    else if (l.type === 'line' && /highway_(major|minor)/.test(id) && !/casing/.test(id)) l.paint['line-color'] = road;
    else if (l.type === 'line' && /railway/.test(id)) l.paint['line-opacity'] = 0.35;
    if (l.type === 'symbol') {
      l.paint['text-color'] = label;
      l.paint['text-halo-color'] = bg;
      if (/road_oneway/.test(id)) l.layout = { ...(l.layout ?? {}), visibility: 'none' };
    }
  }
  return style;
}

function line(coords) {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

/// [lon, lat] points of the route between two distances.
export function routeSlice(poly, from, to) {
  from = Math.max(0, from);
  to = Math.min(poly.length, to);
  if (!(to > from)) return [];
  const a = poly.coordinateAt(from), b = poly.coordinateAt(to);
  const out = [[a.lon, a.lat]];
  const i0 = poly.segmentIndexContaining(from), i1 = poly.segmentIndexContaining(to);
  for (let i = i0 + 1; i <= i1 && i < poly.pointCount; i++) {
    const p = poly.point(i);
    out.push([p.lon, p.lat]);
  }
  out.push([b.lon, b.lat]);
  return out;
}

/// Degrees clockwise from north for the route around a distance (looking a little ahead, so curves do not
/// swing the map).
export function routeBearing(poly, at, ahead = 800) {
  const a = poly.coordinateAt(Math.max(0, Math.min(at, poly.length - 1)));
  const b = poly.coordinateAt(Math.min(poly.length, at + ahead));
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) - Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/// True when moving the camera from `a` to `b` would not visibly change the map: the center within a pixel
/// at that zoom, the bearing within half a degree, the same zoom, pitch and padding.
export function sameCamera(a, b) {
  if (!a || !b || a.zoom !== b.zoom || a.pitch !== b.pitch) return false;
  for (const k of ['top', 'bottom', 'left', 'right']) if ((a.padding?.[k] ?? 0) !== (b.padding?.[k] ?? 0)) return false;
  const turn = Math.abs(((a.bearing - b.bearing) % 360 + 540) % 360 - 180);
  if (turn > 0.5) return false;
  const lat = (a.center[1] + b.center[1]) / 2 * Math.PI / 180;
  const metersPerPixel = 78271.517 * Math.cos(lat) / 2 ** b.zoom;
  const dx = (a.center[0] - b.center[0]) * 111320 * Math.cos(lat), dy = (a.center[1] - b.center[1]) * 110540;
  return Math.hypot(dx, dy) < metersPerPixel;
}

export class NavMap {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.mode = null;
    this.offline = false;
    this.failed = null;
    this.following = true;
    this.markers = new Map();
    this.state = null;
    this.ready = false;
    this.routeKey = null;
    this.drawnAt = null;
    /// The camera last asked for while following (sameCamera()).
    this.camera = null;
    this.onChange = null;
  }

  /// Creates the map on first use; later calls only switch the light or dark style when needed.
  async ensure(mode) {
    if (this.failed) return false;
    if (!this.map) {
      let lib;
      try { lib = await loadMapLibrary(); } catch (e) { this.failed = e.message; this.onChange?.(); return false; }
      if (this.map) return true;
      try {
        this.map = new lib.Map({
          container: this.container, style: plainStyle(), center: [-80, 30], zoom: 11, pitch: 50,
          attributionControl: false, dragRotate: false, pitchWithRotate: false, maxPitch: 60, fadeDuration: 0,
        });
      } catch (e) {
        this.failed = 'this browser cannot draw the map (WebGL is off)';
        this.onChange?.();
        return false;
      }
      // The tile style carries its own credit (OpenFreeMap, OpenMapTiles, OpenStreetMap), always shown.
      this.map.addControl(new lib.AttributionControl({ compact: false }), 'bottom-right');
      this.map.on('style.load', () => { this.ready = true; this.routeKey = null; this.addLayers(); this.draw(true); });
      const stopFollowing = (e) => { if (e.originalEvent && this.following) { this.following = false; this.onChange?.(); } };
      this.map.on('dragstart', stopFollowing);
      this.map.on('zoomstart', stopFollowing);
    }
    if (this.mode !== mode) {
      this.mode = mode;
      this.loadStyle(mode);
    }
    return true;
  }

  async loadStyle(mode) {
    let style = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(STYLES[mode], { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) style = tunedStyle(await res.json());
    } catch { /* offline: the plain style below */ }
    if (mode !== this.mode) return;
    this.offline = !style;
    this.ready = false;
    this.map.setStyle(style ?? plainStyle());
    this.onChange?.();
  }

  addLayers() {
    const m = this.map;
    const empty = { type: 'geojson', data: line([]) };
    if (!m.getSource('ea-behind')) m.addSource('ea-behind', empty);
    if (!m.getSource('ea-ahead')) m.addSource('ea-ahead', { type: 'geojson', data: line([]) });
    const add = (spec) => { if (!m.getLayer(spec.id)) m.addLayer(spec); };
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    add({ id: 'ea-behind', type: 'line', source: 'ea-behind', layout: round, paint: { 'line-color': token('route-passed'), 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 14, 7] } });
    add({ id: 'ea-ahead-casing', type: 'line', source: 'ea-ahead', layout: round, paint: { 'line-color': token('route-casing'), 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 6, 14, 14] } });
    add({ id: 'ea-ahead', type: 'line', source: 'ea-ahead', layout: round, paint: { 'line-color': token('route'), 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 14, 8] } });
  }

  /// state: {key (route id), poly, progress, position {lat, lon}, bearing, zoom, padding {top, bottom, left, right},
  /// markers: [{id, lat, lon, html, cls}]}
  update(state) {
    this.state = state;
    this.draw(false);
  }

  recenter() {
    this.following = true;
    this.draw(true);
    this.onChange?.();
  }

  resize() {
    this.map?.resize();
  }

  draw(force) {
    const s = this.state, m = this.map;
    if (!s || !m || !this.ready) return;
    // The route lines: redrawn when the vehicle has moved 50 m (or the route changed).
    if (force || this.routeKey !== s.key || this.drawnAt === null || Math.abs(s.progress - this.drawnAt) > 50) {
      m.getSource('ea-ahead')?.setData(line(routeSlice(s.poly, s.progress, s.progress + AHEAD)));
      m.getSource('ea-behind')?.setData(line(routeSlice(s.poly, s.progress - BEHIND, s.progress)));
      this.routeKey = s.key;
      this.drawnAt = s.progress;
    }
    this.placeMarkers(s.markers);
    if (this.following) {
      const camera = { center: [s.position.lon, s.position.lat], bearing: s.bearing, pitch: 52, zoom: s.zoom, padding: s.padding };
      // Every camera move animates for most of a second, and the map redraws on each frame of it. Parked or
      // stuck in traffic the camera would not move at all, so it is left alone (no frames) until it would.
      if (force || !sameCamera(this.camera, camera)) {
        m.easeTo({ ...camera, duration: force ? 0 : s.duration ?? 600, easing: (t) => t });
        this.camera = camera;
      }
    }
  }

  placeMarkers(list) {
    const lib = window.maplibregl;
    const keep = new Set();
    for (const x of list) {
      keep.add(x.id);
      let entry = this.markers.get(x.id);
      if (!entry) {
        const el = document.createElement('div');
        const marker = new lib.Marker({ element: el, anchor: x.anchor ?? 'center', rotationAlignment: x.rotate != null ? 'map' : 'viewport', pitchAlignment: x.rotate != null ? 'map' : 'viewport' });
        marker.setLngLat([x.lon, x.lat]).addTo(this.map);
        entry = { marker, el, html: null, cls: null };
        this.markers.set(x.id, entry);
      }
      // MapLibre positions the marker element by its own classes, so ours go on an inner element.
      if (entry.html !== x.html || entry.cls !== x.cls) {
        entry.el.innerHTML = `<div class="nav-marker ${x.cls ?? ''}">${x.html}</div>`;
        entry.html = x.html;
        entry.cls = x.cls;
      }
      entry.marker.setLngLat([x.lon, x.lat]);
      if (x.rotate != null) entry.marker.setRotation(x.rotate);
    }
    for (const [id, entry] of this.markers) {
      if (!keep.has(id)) { entry.marker.remove(); this.markers.delete(id); }
    }
  }
}
