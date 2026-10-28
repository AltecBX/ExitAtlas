// Geodesy, spatial grid and route polyline. Port of Sources/ExitAtlasCore/Geo.
// Coordinates are {lat, lon} in degrees. Distances are meters on the WGS84 ellipsoid.

export const METERS_PER_MILE = 1609.344;
export const SEMI_MAJOR = 6378137.0;
export const FLATTENING = 1 / 298.257223563;
export const SEMI_MINOR = SEMI_MAJOR * (1 - FLATTENING);
export const ECC2 = FLATTENING * (2 - FLATTENING);
const D2R = Math.PI / 180;

export function isValid(c) {
  return Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;
}

export function sameCoord(a, b) {
  return a.lat === b.lat && a.lon === b.lon;
}

/// Ellipsoidal distance (Vincenty inverse, haversine fallback for non convergence).
export function distance(a, b) {
  if (a.lat === b.lat && a.lon === b.lon) return 0;
  const v = vincenty(a.lat, a.lon, b.lat, b.lon);
  return v ?? haversine(a, b);
}

export function haversine(a, b) {
  const r = 6371008.8;
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const dp = p2 - p1, dl = (b.lon - a.lon) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function vincenty(lat1, lon1, lat2, lon2) {
  const a = SEMI_MAJOR, b = SEMI_MINOR, f = FLATTENING;
  const L = (lon2 - lon1) * D2R;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * D2R));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * D2R));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, iterations = 0;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
  for (;;) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    const t1 = cosU2 * sinLambda;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha : 0;
    const C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda = L + (1 - C) * f * sinAlpha
      * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    iterations += 1;
    if (Math.abs(lambda - previous) < 1e-12) break;
    if (iterations > 200) return null;
  }
  const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
    - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * A * (sigma - deltaSigma);
}

/// Initial bearing in degrees clockwise from true north, in [0, 360).
export function initialBearing(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizedDegrees(Math.atan2(y, x) / D2R);
}

export function normalizedDegrees(v) {
  const r = v % 360;
  return r < 0 ? r + 360 : r;
}

/// Smallest absolute difference between two bearings, in [0, 180].
export function angleDifference(a, b) {
  const d = Math.abs(normalizedDegrees(a) - normalizedDegrees(b));
  return d > 180 ? 360 - d : d;
}

export function metersPerDegreeLatitude(lat) {
  const s = Math.sin(lat * D2R);
  const w = 1 - ECC2 * s * s;
  const m = SEMI_MAJOR * (1 - ECC2) / (w * Math.sqrt(w));
  return m * D2R;
}

export function metersPerDegreeLongitude(lat) {
  const phi = lat * D2R;
  const s = Math.sin(phi);
  const n = SEMI_MAJOR / Math.sqrt(1 - ECC2 * s * s);
  return n * Math.cos(phi) * D2R;
}

/// Point at a distance and bearing from a start point (local plane, short distances).
export function offset(c, bearing, meters) {
  const theta = bearing * D2R;
  const north = meters * Math.cos(theta), east = meters * Math.sin(theta);
  return { lat: c.lat + north / metersPerDegreeLatitude(c.lat), lon: c.lon + east / metersPerDegreeLongitude(c.lat) };
}

export function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// MARK: Bounding boxes ({minLat, minLon, maxLat, maxLon})

export function boxOf(points) {
  if (!points.length) return null;
  const box = { minLat: points[0].lat, minLon: points[0].lon, maxLat: points[0].lat, maxLon: points[0].lon };
  for (const c of points) includeInBox(box, c);
  return box;
}

export function includeInBox(box, c) {
  if (c.lat < box.minLat) box.minLat = c.lat;
  if (c.lat > box.maxLat) box.maxLat = c.lat;
  if (c.lon < box.minLon) box.minLon = c.lon;
  if (c.lon > box.maxLon) box.maxLon = c.lon;
}

export function boxContains(box, c) {
  return c.lat >= box.minLat && c.lat <= box.maxLat && c.lon >= box.minLon && c.lon <= box.maxLon;
}

export function boxIntersects(a, b) {
  return !(b.minLat > a.maxLat || b.maxLat < a.minLat || b.minLon > a.maxLon || b.maxLon < a.minLon);
}

export function expandBox(box, meters) {
  const midLat = (box.minLat + box.maxLat) / 2;
  const dLat = meters / metersPerDegreeLatitude(midLat);
  const lonScale = metersPerDegreeLongitude(Math.max(Math.abs(box.minLat), Math.abs(box.maxLat)));
  const dLon = meters / Math.max(lonScale, 1);
  return { minLat: box.minLat - dLat, minLon: box.minLon - dLon, maxLat: box.maxLat + dLat, maxLon: box.maxLon + dLon };
}

export function pointBox(c) {
  return { minLat: c.lat, minLon: c.lon, maxLat: c.lat, maxLon: c.lon };
}

function segmentBox(aLat, aLon, bLat, bLon) {
  return {
    minLat: Math.min(aLat, bLat), minLon: Math.min(aLon, bLon),
    maxLat: Math.max(aLat, bLat), maxLon: Math.max(aLon, bLon),
  };
}

// MARK: Spatial grid

/// Uniform latitude/longitude grid mapping cells to item indices.
export class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  cc(v) { return Math.floor(v / this.cellSize); }

  static key(x, y) { return (x + 50000) * 100000 + (y + 50000); }

  push(key, item) {
    const list = this.cells.get(key);
    if (list) list.push(item); else this.cells.set(key, [item]);
  }

  insertBox(item, box) {
    const x0 = this.cc(box.minLon), x1 = this.cc(box.maxLon), y0 = this.cc(box.minLat), y1 = this.cc(box.maxLat);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) this.push(SpatialGrid.key(x, y), item);
  }

  insertPoint(item, lat, lon) {
    this.push(SpatialGrid.key(this.cc(lon), this.cc(lat)), item);
  }

  /// Inserts a straight segment into only the cells it passes through.
  insertSegment(item, aLat, aLon, bLat, bLon) {
    const dx = bLon - aLon, dy = bLat - aLat;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (this.cellSize * 0.5)));
    if (steps === 1) {
      this.insertBox(item, segmentBox(aLat, aLon, bLat, bLon));
      return;
    }
    const seen = new Set();
    let pLat = aLat, pLon = aLon;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const nLat = aLat + dy * t, nLon = aLon + dx * t;
      const box = segmentBox(pLat, pLon, nLat, nLon);
      const x0 = this.cc(box.minLon), x1 = this.cc(box.maxLon), y0 = this.cc(box.minLat), y1 = this.cc(box.maxLat);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = SpatialGrid.key(x, y);
          if (!seen.has(key)) { seen.add(key); this.push(key, item); }
        }
      }
      pLat = nLat; pLon = nLon;
    }
  }

  /// Items in cells touched by a straight segment. May contain duplicates.
  querySegment(aLat, aLon, bLat, bLon, padding = 0, out = []) {
    const dx = bLon - aLon, dy = bLat - aLat;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (this.cellSize * 0.5)));
    const seen = steps > 1 || padding > 0 ? new Set() : null;
    let pLat = aLat, pLon = aLon;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const nLat = aLat + dy * t, nLon = aLon + dx * t;
      let box = segmentBox(pLat, pLon, nLat, nLon);
      if (padding > 0) box = expandBox(box, padding);
      const x0 = this.cc(box.minLon), x1 = this.cc(box.maxLon), y0 = this.cc(box.minLat), y1 = this.cc(box.maxLat);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = SpatialGrid.key(x, y);
          if (seen) {
            if (seen.has(key)) continue;
            seen.add(key);
          }
          const items = this.cells.get(key);
          if (items) for (let i = 0; i < items.length; i++) out.push(items[i]);
        }
      }
      pLat = nLat; pLon = nLon;
    }
    return out;
  }

  /// Items in cells overlapping the box. May contain duplicates.
  query(box, out = []) {
    const x0 = this.cc(box.minLon), x1 = this.cc(box.maxLon), y0 = this.cc(box.minLat), y1 = this.cc(box.maxLat);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const items = this.cells.get(SpatialGrid.key(x, y));
        if (items) for (let i = 0; i < items.length; i++) out.push(items[i]);
      }
    }
    return out;
  }
}

// MARK: Route polyline

/// Ordered route geometry with cumulative ellipsoidal distances and a segment index.
/// Every "miles along the route" value comes from `cum`, never from straight lines.
export class RoutePolyline {
  constructor(rawPoints, gridCellDegrees = 0.01) {
    const lat = [], lon = [];
    for (const p of rawPoints) {
      if (!isValid(p)) continue;
      const n = lat.length;
      if (n && lat[n - 1] === p.lat && lon[n - 1] === p.lon) continue;
      lat.push(p.lat);
      lon.push(p.lon);
    }
    if (!lat.length) throw new Error('a route polyline needs at least one valid coordinate');
    this.lat = Float64Array.from(lat);
    this.lon = Float64Array.from(lon);
    const n = lat.length;
    const cum = new Float64Array(n);
    const grid = new SpatialGrid(gridCellDegrees);
    for (let i = 0; i < n - 1; i++) {
      const d = vincenty(lat[i], lon[i], lat[i + 1], lon[i + 1]);
      cum[i + 1] = cum[i] + (d ?? haversine({ lat: lat[i], lon: lon[i] }, { lat: lat[i + 1], lon: lon[i + 1] }));
      grid.insertSegment(i, lat[i], lon[i], lat[i + 1], lon[i + 1]);
    }
    this.cum = cum;
    this.grid = grid;
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (let i = 0; i < n; i++) {
      if (lat[i] < minLat) minLat = lat[i];
      if (lat[i] > maxLat) maxLat = lat[i];
      if (lon[i] < minLon) minLon = lon[i];
      if (lon[i] > maxLon) maxLon = lon[i];
    }
    this.box = { minLat, minLon, maxLat, maxLon };
  }

  get pointCount() { return this.lat.length; }
  get length() { return this.cum[this.cum.length - 1]; }
  get segmentCount() { return Math.max(this.lat.length - 1, 0); }
  point(i) { return { lat: this.lat[i], lon: this.lon[i] }; }
  get points() {
    const out = new Array(this.lat.length);
    for (let i = 0; i < out.length; i++) out[i] = { lat: this.lat[i], lon: this.lon[i] };
    return out;
  }

  /// Segment index containing a distance along the route (clamped).
  segmentIndexContaining(distance) {
    const segs = this.segmentCount;
    if (segs <= 0) return 0;
    if (distance <= 0) return 0;
    if (distance >= this.length) return segs - 1;
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= distance) lo = mid; else hi = mid;
    }
    return Math.min(lo, segs - 1);
  }

  coordinateAt(distance) {
    if (this.segmentCount <= 0) return this.point(0);
    const i = this.segmentIndexContaining(distance);
    const d0 = this.cum[i], d1 = this.cum[i + 1];
    const t = d1 > d0 ? Math.min(Math.max((distance - d0) / (d1 - d0), 0), 1) : 0;
    return {
      lat: this.lat[i] + (this.lat[i + 1] - this.lat[i]) * t,
      lon: this.lon[i] + (this.lon[i + 1] - this.lon[i]) * t,
    };
  }

  /// Bearing of travel at a distance, measured over a short window.
  bearingAt(distance, window = 25) {
    if (this.segmentCount <= 0) return 0;
    const a = this.coordinateAt(Math.max(0, distance - window));
    const b = this.coordinateAt(Math.min(this.length, distance + window));
    if (a.lat === b.lat && a.lon === b.lon) {
      const i = this.segmentIndexContaining(distance);
      return initialBearing(this.point(i), this.point(i + 1));
    }
    return initialBearing(a, b);
  }

  projectOntoSegment(c, i) {
    const aLat = this.lat[i], aLon = this.lon[i], bLat = this.lat[i + 1], bLon = this.lon[i + 1];
    const mLat = metersPerDegreeLatitude(aLat), mLon = metersPerDegreeLongitude(aLat);
    const bx = (bLon - aLon) * mLon, by = (bLat - aLat) * mLat;
    const cx = (c.lon - aLon) * mLon, cy = (c.lat - aLat) * mLat;
    const lenSq = bx * bx + by * by;
    let t = lenSq > 0 ? (cx * bx + cy * by) / lenSq : 0;
    t = Math.min(Math.max(t, 0), 1);
    const dx = cx - t * bx, dy = cy - t * by;
    const off = Math.sqrt(dx * dx + dy * dy);
    const cross = bx * cy - by * cx; // > 0 means left of travel
    const segLen = this.cum[i + 1] - this.cum[i];
    return {
      segmentIndex: i,
      fraction: t,
      distanceAlong: this.cum[i] + t * segLen,
      offset: off,
      signedOffset: cross > 0 ? -off : off,
      point: { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t },
      bearing: initialBearing({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon }),
    };
  }

  /// Sorted unique segment indices whose cells come within `radius` meters of the box.
  candidateSegments(box, radius) {
    const raw = this.grid.query(expandBox(box, radius));
    raw.sort((a, b) => a - b);
    const out = [];
    let last = -1;
    for (const i of raw) if (i !== last) { out.push(i); last = i; }
    return out;
  }

  /// Every distinct place where the route passes within `radius` meters of the point, ordered
  /// along the route. Each pass is a local minimum of the offset over consecutive segments.
  projections(c, radius) {
    if (this.segmentCount <= 0) return [];
    const hits = [];
    for (const i of this.candidateSegments(pointBox(c), radius)) {
      const p = this.projectOntoSegment(c, i);
      if (p.offset <= radius) hits.push(p);
    }
    if (!hits.length) return [];
    hits.sort((a, b) => a.segmentIndex - b.segmentIndex);
    const minima = [];
    for (let k = 0; k < hits.length; k++) {
      const p = hits[k];
      const prev = k > 0 && hits[k - 1].segmentIndex === p.segmentIndex - 1 ? hits[k - 1] : null;
      const next = k + 1 < hits.length && hits[k + 1].segmentIndex === p.segmentIndex + 1 ? hits[k + 1] : null;
      const notAbovePrevious = prev ? p.offset <= prev.offset : true;
      const belowNext = next ? p.offset < next.offset : true;
      if (notAbovePrevious && belowNext) minima.push(p);
    }
    return minima;
  }

  nearestProjection(c, radius) {
    let best = null;
    for (const p of this.projections(c, radius)) if (!best || p.offset < best.offset) best = p;
    return best;
  }

  /// The part of the route between two distances, as a new polyline starting at 0.
  slice(start, end) {
    const s = Math.min(Math.max(start, 0), this.length);
    const e = Math.min(Math.max(end, s), this.length);
    const pts = [this.coordinateAt(s)];
    if (this.segmentCount > 0) {
      const i0 = this.segmentIndexContaining(s) + 1, i1 = this.segmentIndexContaining(e);
      for (let i = i0; i <= i1; i++) {
        if (this.cum[i] > s && this.cum[i] < e) pts.push(this.point(i));
      }
    }
    pts.push(this.coordinateAt(e));
    return new RoutePolyline(pts, this.grid.cellSize);
  }
}

// MARK: Encoded polyline (Google format; OSRM polyline6 uses precision 6)

export function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let index = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0;
    while (index < encoded.length) {
      const chunk = encoded.charCodeAt(index++) - 63;
      if (chunk < 0) return null;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      if (chunk < 0x20) return (result & 1) ? ~(result >> 1) : (result >> 1);
    }
    return null;
  };
  while (index < encoded.length) {
    const dLat = next(), dLon = next();
    if (dLat === null || dLon === null) return null;
    lat += dLat;
    lon += dLon;
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

export function encodePolyline(coords, precision = 5) {
  const factor = 10 ** precision;
  let out = '', lastLat = 0, lastLon = 0;
  const append = (value) => {
    let v = value < 0 ? ~(value * 2) : value * 2;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v = Math.floor(v / 32);
    }
    out += String.fromCharCode(v + 63);
  };
  for (const c of coords) {
    const lat = Math.round(c.lat * factor), lon = Math.round(c.lon * factor);
    append(lat - lastLat);
    append(lon - lastLon);
    lastLat = lat;
    lastLon = lon;
  }
  return out;
}
