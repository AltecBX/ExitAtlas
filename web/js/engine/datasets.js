// Readers for the bundled binary datasets (tools/data-pipeline/eaformat.py) and
// state/time zone segmentation. Port of Sources/ExitAtlasCore/{Data,Boundaries,Exits}.
import {
  METERS_PER_MILE, SpatialGrid, RoutePolyline, angleDifference, boxContains, boxIntersects, expandBox, lerp, pointBox,
} from './geo.js';

const utf8 = new TextDecoder('utf-8');

/// Little-endian cursor over an ArrayBuffer.
export class BinaryReader {
  constructor(buffer, offset = 0) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = offset;
  }

  check(size) {
    if (this.offset + size > this.view.byteLength) throw new Error(`dataset truncated at byte ${this.offset}`);
  }

  u8() { this.check(1); return this.view.getUint8(this.offset++); }
  u16() { this.check(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
  u32() { this.check(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  i32() { this.check(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  i64() { this.check(8); const v = this.view.getBigInt64(this.offset, true); this.offset += 8; return Number(v); }
  f32() { this.check(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }

  bytesSlice(count) {
    this.check(count);
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  string(lengthPrefix) {
    const n = lengthPrefix === 1 ? this.u8() : lengthPrefix === 2 ? this.u16() : this.u32();
    return utf8.decode(this.bytesSlice(n));
  }

  skip(count) { this.check(count); this.offset += count; }

  header(expectedMagic, supportedVersion) {
    const magic = String.fromCharCode(...this.bytesSlice(4));
    if (magic !== expectedMagic) throw new Error(`expected ${expectedMagic} file, found ${magic}`);
    const version = this.u32();
    if (version !== supportedVersion) throw new Error(`unsupported dataset version ${version}`);
    const metaLength = this.u32();
    let meta = {};
    try { meta = JSON.parse(utf8.decode(this.bytesSlice(metaLength))); } catch { meta = {}; }
    return meta;
  }
}

/// Deduplicated UTF-8 string table, decoded lazily.
class StringTable {
  constructor(r) {
    const count = r.u32();
    const total = r.u32();
    const offsets = new Uint32Array(count + 1);
    for (let i = 0; i <= count; i++) offsets[i] = r.u32();
    if (offsets[count] !== total) throw new Error('string table size mismatch');
    this.blob = r.bytesSlice(total);
    this.offsets = offsets;
    this.cache = new Array(count);
  }

  get(index) {
    if (index === 0xffffffff || index >= this.offsets.length - 1) return null;
    let s = this.cache[index];
    if (s === undefined) {
      s = utf8.decode(this.blob.subarray(this.offsets[index], this.offsets[index + 1]));
      this.cache[index] = s;
    }
    return s;
  }
}

// MARK: Regions (states, time zones)

/// Polygon index for point-in-region queries and exact boundary crossings (EAB1).
export class RegionIndex {
  constructor(buffer) {
    const r = new BinaryReader(buffer);
    this.metadata = r.header('EAB1', 1);
    const count = r.u32();
    this.regions = [];
    this.polygons = [];
    const rings = [];
    let edgeTotal = 0;
    for (let id = 0; id < count; id++) {
      const code = r.string(1), name = r.string(2), extra = r.string(1);
      const minLat = r.i32() / 1e7, minLon = r.i32() / 1e7, maxLat = r.i32() / 1e7, maxLon = r.i32() / 1e7;
      this.regions.push({ id, code, name, extra, box: { minLat, minLon, maxLat, maxLon } });
      const polyCount = r.u32();
      const regionPolys = [];
      for (let p = 0; p < polyCount; p++) {
        const ringCount = r.u32();
        const polyRings = [];
        for (let k = 0; k < ringCount; k++) {
          const n = r.u32();
          if (n === 0) continue;
          const lat = new Float64Array(n), lon = new Float64Array(n);
          let bMinLat = Infinity, bMinLon = Infinity, bMaxLat = -Infinity, bMaxLon = -Infinity;
          for (let j = 0; j < n; j++) {
            const la = r.i32() / 1e7, lo = r.i32() / 1e7;
            lat[j] = la; lon[j] = lo;
            if (la < bMinLat) bMinLat = la;
            if (la > bMaxLat) bMaxLat = la;
            if (lo < bMinLon) bMinLon = lo;
            if (lo > bMaxLon) bMaxLon = lo;
          }
          const ring = { box: { minLat: bMinLat, minLon: bMinLon, maxLat: bMaxLat, maxLon: bMaxLon }, lat, lon };
          polyRings.push(ring);
          rings.push(ring);
          edgeTotal += n - 1;
        }
        if (polyRings.length) regionPolys.push({ box: polyRings[0].box, rings: polyRings });
      }
      this.polygons.push(regionPolys);
    }
    // Boundary edges in a grid for crossing queries.
    const edges = new Float64Array(edgeTotal * 4);
    const grid = new SpatialGrid(0.05);
    let e = 0;
    for (const ring of rings) {
      const { lat, lon } = ring;
      for (let k = 0; k < lat.length - 1; k++) {
        if (lat[k] === lat[k + 1] && lon[k] === lon[k + 1]) continue;
        grid.insertSegment(e, lat[k], lon[k], lat[k + 1], lon[k + 1]);
        edges[e * 4] = lat[k]; edges[e * 4 + 1] = lon[k]; edges[e * 4 + 2] = lat[k + 1]; edges[e * 4 + 3] = lon[k + 1];
        e++;
      }
    }
    this.edges = edges;
    this.edgeCount = e;
    this.edgeGrid = grid;
  }

  regionByCode(code) { return this.regions.find((r) => r.code === code) ?? null; }

  /// The region containing the point, or null outside every region.
  regionContaining(c) {
    for (const region of this.regions) {
      if (boxContains(region.box, c) && this.contains(region.id, c)) return region;
    }
    return null;
  }

  contains(regionIndex, c) {
    for (const polygon of this.polygons[regionIndex]) {
      if (!boxContains(polygon.box, c)) continue;
      let inside = false;
      for (const ring of polygon.rings) {
        if (boxContains(ring.box, c) && rayCrossings(ring.lat, ring.lon, c)) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  /// Parameters t in [0, 1] where the segment a to b crosses any region boundary.
  boundaryCrossings(a, b) {
    const candidates = this.edgeGrid.querySegment(a.lat, a.lon, b.lat, b.lon);
    if (!candidates.length) return [];
    const ts = [];
    const px = a.lon, py = a.lat, rx = b.lon - px, ry = b.lat - py;
    const E = this.edges;
    for (const e of candidates) {
      const s0Lat = E[e * 4], s0Lon = E[e * 4 + 1], s1Lat = E[e * 4 + 2], s1Lon = E[e * 4 + 3];
      const sx = s1Lon - s0Lon, sy = s1Lat - s0Lat;
      const denom = rx * sy - ry * sx;
      if (denom === 0) continue;
      const qx = s0Lon - px, qy = s0Lat - py;
      const t = (qx * sy - qy * sx) / denom;
      const u = (qx * ry - qy * rx) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const unique = [];
    for (const t of ts) if (!unique.length || t - unique[unique.length - 1] > 1e-12) unique.push(t);
    return unique;
  }
}

function rayCrossings(lat, lon, c) {
  let inside = false;
  const x = c.lon, y = c.lat;
  let j = lat.length - 1;
  for (let i = 0; i < lat.length; i++) {
    const xi = lon[i], yi = lat[i], xj = lon[j], yj = lat[j];
    if ((yi > y) !== (yj > y)) {
      const xCross = (xj - xi) * (y - yi) / (yj - yi) + xi;
      if (x < xCross) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/// Ordered region segments along a route.
export class RegionProfile {
  constructor(segments, routeLength) {
    this.segments = segments;
    this.routeLength = routeLength;
  }

  segmentIndexAt(distance) {
    const s = this.segments;
    if (!s.length) return null;
    if (distance <= s[0].startDistance) return 0;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].startDistance <= distance) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  segmentAt(distance) {
    const i = this.segmentIndexAt(distance);
    return i === null ? null : this.segments[i];
  }

  /// Per region totals in order of first appearance.
  get totals() {
    const order = [], lengths = new Map(), visits = new Map(), names = new Map();
    for (const s of this.segments) {
      const key = s.code ?? '-';
      if (!lengths.has(key)) { order.push(s.code); lengths.set(key, 0); visits.set(key, 0); }
      lengths.set(key, lengths.get(key) + s.length);
      visits.set(key, visits.get(key) + 1);
      names.set(key, s.displayName);
    }
    return order.map((code) => {
      const key = code ?? '-';
      return { code, name: names.get(key), length: lengths.get(key), visits: visits.get(key) };
    });
  }
}

function makeSegment(fields) {
  const s = { ...fields };
  s.length = s.endDistance - s.startDistance;
  s.displayName = s.code === null ? 'Outside U.S. states' : s.name;
  return s;
}

/// Splits a route into ordered region segments using exact boundary crossings.
export class RegionSegmenter {
  constructor({ briefThreshold = METERS_PER_MILE, noiseThreshold = 50 } = {}) {
    this.briefThreshold = briefThreshold;
    this.noiseThreshold = noiseThreshold;
  }

  segment(route, regions) {
    const pieces = [];
    const first = route.point(0);
    let current = regions.regionContaining(first)?.id ?? null;
    pieces.push({ region: current, start: 0, end: 0, entry: first, exit: first });
    for (let i = 0; i < route.segmentCount; i++) {
      const a = route.point(i), b = route.point(i + 1);
      const d0 = route.cum[i], d1 = route.cum[i + 1];
      const ts = regions.boundaryCrossings(a, b);
      if (!ts.length) {
        const last = pieces[pieces.length - 1];
        last.end = d1;
        last.exit = b;
        continue;
      }
      const bounds = [0];
      for (const t of ts) if (t > 0 && t < 1) bounds.push(t);
      bounds.push(1);
      for (let k = 0; k < bounds.length - 1; k++) {
        const t0 = bounds[k], t1 = bounds[k + 1];
        if (!(t1 > t0)) continue;
        const mid = lerp(a, b, (t0 + t1) / 2);
        const region = regions.regionContaining(mid)?.id ?? null;
        const start = d0 + (d1 - d0) * t0, end = d0 + (d1 - d0) * t1;
        const p0 = lerp(a, b, t0), p1 = lerp(a, b, t1);
        if (region === current) {
          const last = pieces[pieces.length - 1];
          last.end = end;
          last.exit = p1;
        } else {
          pieces.push({ region, start, end, entry: p0, exit: p1 });
          current = region;
        }
      }
    }
    const cleaned = this.cleaned(pieces);
    const visits = new Map();
    let outsideVisits = 0;
    const segments = cleaned.map((p, index) => {
      let visit;
      if (p.region !== null) {
        visit = (visits.get(p.region) ?? 0) + 1;
        visits.set(p.region, visit);
      } else {
        outsideVisits += 1;
        visit = outsideVisits;
      }
      const region = p.region !== null ? regions.regions[p.region] : null;
      return makeSegment({
        index, code: region ? region.code : null, name: region ? region.name : 'Outside U.S. states',
        startDistance: p.start, endDistance: p.end, visit,
        isBrief: p.end - p.start < this.briefThreshold, entryCoordinate: p.entry, exitCoordinate: p.exit,
      });
    });
    return new RegionProfile(segments, route.length);
  }

  /// Removes zero length pieces, boundary noise sandwiches and tiny gaps outside every region.
  cleaned(input) {
    let pieces = input.filter((p) => p.end - p.start > 0 || input.length === 1).map((p) => ({ ...p }));
    if (!pieces.length) pieces = input.slice(0, 1).map((p) => ({ ...p }));
    let changed = true;
    while (changed && pieces.length > 1) {
      changed = false;
      let i = 0;
      while (i < pieces.length) {
        const p = pieces[i];
        if (!(p.end - p.start < this.noiseThreshold) || pieces.length <= 1) { i += 1; continue; }
        const prev = i > 0 ? pieces[i - 1] : null;
        const next = i + 1 < pieces.length ? pieces[i + 1] : null;
        if (prev && next && prev.region === next.region) {
          prev.end = next.end;
          prev.exit = next.exit;
          pieces.splice(i, 2);
          changed = true;
        } else if (p.region === null || !prev || !next) {
          if (prev) {
            prev.end = p.end;
            prev.exit = p.exit;
          } else if (next) {
            next.start = p.start;
            next.entry = p.entry;
          }
          pieces.splice(i, 1);
          changed = true;
        } else {
          i += 1;
        }
      }
      const merged = [];
      for (const p of pieces) {
        const last = merged[merged.length - 1];
        if (last && last.region === p.region) {
          last.end = p.end;
          last.exit = p.exit;
        } else {
          merged.push(p);
        }
      }
      pieces = merged;
    }
    return pieces;
  }
}

/// IANA time zone at a location from the bundled USDOT/BTS zone polygons.
export class TimeZoneResolver {
  constructor(zones) { this.zones = zones; }

  identifier(c, stateCode) {
    const zone = this.zones.regionContaining(c);
    return zone ? TimeZoneResolver.iana(zone.code, stateCode) : null;
  }

  static iana(zone, stateCode) {
    switch (zone) {
      case 'Eastern': return 'America/New_York';
      case 'Central': return 'America/Chicago';
      case 'Mountain': return stateCode === 'AZ' ? 'America/Phoenix' : 'America/Denver';
      case 'Pacific': return 'America/Los_Angeles';
      case 'Alaska': return 'America/Anchorage';
      case 'Hawaii-Aleutian': return stateCode === 'AK' ? 'America/Adak' : 'Pacific/Honolulu';
      case 'Atlantic': return 'America/Puerto_Rico';
      default: return null;
    }
  }
}

// MARK: Interstate exits and places (EAX1)

export const PlaceCategory = Object.freeze({
  unknown: 0, gas: 1, food: 2, lodging: 3, restArea: 4, evCharging: 5, park: 6, dogPark: 7, travelCenter: 8,
});
export const CATEGORY_NAMES = ['Other', 'Gas', 'Food', 'Lodging', 'Rest Area', 'EV Charging', 'Park', 'Dog Park', 'Travel Center'];

const EXIT_SIZE = 40, PLACE_SIZE = 24, LINK_SIZE = 12;

export class InterstateDataset {
  constructor(buffer) {
    const r = new BinaryReader(buffer);
    this.metadata = r.header('EAX1', 1);
    this.strings = new StringTable(r);
    const exitCount = r.u32();
    const v = r.view;
    const exits = new Array(exitCount);
    const grid = new SpatialGrid(0.02);
    r.check(exitCount * EXIT_SIZE);
    for (let i = 0; i < exitCount; i++) {
      const o = r.offset + i * EXIT_SIZE;
      const nodeID = Number(v.getBigInt64(o, true));
      const lat = v.getInt32(o + 8, true) / 1e7, lon = v.getInt32(o + 12, true) / 1e7;
      const b1 = v.getUint16(o + 16, true), b2 = v.getUint16(o + 18, true);
      const label = v.getUint32(o + 20, true), name = v.getUint32(o + 24, true), highways = v.getUint32(o + 28, true);
      const linkStart = v.getUint32(o + 32, true), linkCount = v.getUint16(o + 36, true);
      const bearings = [];
      if (b1 !== 0xffff) bearings.push(b1 / 10);
      if (b2 !== 0xffff) bearings.push(b2 / 10);
      const hw = this.strings.get(highways) ?? '';
      exits[i] = {
        datasetIndex: i, osmNodeID: nodeID, coordinate: { lat, lon }, bearings,
        label: this.strings.get(label) ?? '', name: this.strings.get(name) ?? '',
        highways: hw ? hw.split(';') : [], linkStart, linkCount,
      };
      grid.insertPoint(i, lat, lon);
    }
    r.skip(exitCount * EXIT_SIZE);
    this.placeCount = r.u32();
    this.placeOffset = r.offset;
    r.skip(this.placeCount * PLACE_SIZE);
    this.linkCount = r.u32();
    this.linkOffset = r.offset;
    r.skip(this.linkCount * LINK_SIZE);
    this.view = v;
    this.exits = exits;
    this.grid = grid;
  }

  exitsNear(box, radius = 0) {
    const area = radius > 0 ? expandBox(box, radius) : box;
    const ids = this.grid.query(area).sort((a, b) => a - b);
    const out = [];
    let last = -1;
    for (const i of ids) {
      if (i !== last && boxContains(area, this.exits[i].coordinate)) out.push(this.exits[i]);
      last = i;
    }
    return out;
  }

  exitIndicesAlongSegment(a, b, radius, out) {
    return this.grid.querySegment(a.lat, a.lon, b.lat, b.lon, radius, out);
  }

  place(index) {
    if (index < 0 || index >= this.placeCount) return null;
    const v = this.view, o = this.placeOffset + index * PLACE_SIZE;
    return {
      datasetIndex: index,
      id: this.strings.get(v.getUint32(o + 16, true)) ?? '',
      coordinate: { lat: v.getInt32(o, true) / 1e7, lon: v.getInt32(o + 4, true) / 1e7 },
      name: this.strings.get(v.getUint32(o + 8, true)) ?? '',
      brand: this.strings.get(v.getUint32(o + 12, true)) ?? '',
      category: v.getUint8(o + 20),
    };
  }

  /// Places linked to an exit, nearest first within each category.
  links(exit) {
    const v = this.view, out = [];
    for (let k = 0; k < exit.linkCount; k++) {
      const o = this.linkOffset + (exit.linkStart + k) * LINK_SIZE;
      if (o + LINK_SIZE > v.byteLength) continue;
      const place = this.place(v.getUint32(o, true));
      if (!place) continue;
      const straight = v.getUint16(o + 4, true), driveM = v.getUint16(o + 6, true), driveS = v.getUint16(o + 8, true);
      const rank = v.getUint8(o + 10), flags = v.getUint8(o + 11);
      const hasDrive = (flags & 1) !== 0;
      out.push({
        place, straightLineMeters: straight,
        driveMeters: hasDrive && driveM !== 0xffff ? driveM : null,
        driveSeconds: hasDrive && driveS !== 0xffff ? driveS : null,
        rank, reachable: hasDrive || (flags & 2) !== 0 ? (flags & 2) !== 0 : null,
      });
    }
    return out;
  }
}

/// The interstate exits and the exits on other freeways (freeways.eax, the same EAX1 format) as one dataset with
/// the InterstateDataset API, so a route matches, counts and lists both kinds alike. Each exit remembers the file
/// it came from (`part`) and resolves its links and places there.
export class CombinedExitDataset {
  constructor(parts) {
    this.parts = parts;
    this.metadata = parts[0].metadata;
    this.exits = [];
    this.grid = new SpatialGrid(0.02);
    parts.forEach((dataset, part) => {
      for (const e of dataset.exits) {
        const i = this.exits.length;
        this.exits.push({ ...e, datasetIndex: i, part });
        this.grid.insertPoint(i, e.coordinate.lat, e.coordinate.lon);
      }
    });
  }

  exitsNear(box, radius = 0) { return InterstateDataset.prototype.exitsNear.call(this, box, radius); }

  exitIndicesAlongSegment(a, b, radius, out) { return this.grid.querySegment(a.lat, a.lon, b.lat, b.lon, radius, out); }

  links(exit) { return this.parts[exit.part ?? 0].links(exit); }
}

export function placeDisplayName(place) {
  return place.name || place.brand || CATEGORY_NAMES[place.category] || 'Place';
}

// MARK: Corridors for discovery mode (EAC1)

export class CorridorDataset {
  constructor(buffer) {
    const r = new BinaryReader(buffer);
    this.metadata = r.header('EAC1', 1);
    const strings = new StringTable(r);
    const count = r.u32();
    this.corridors = [];
    this.partBoxes = [];
    for (let id = 0; id < count; id++) {
      const highway = strings.get(r.u32()) ?? '';
      const directionCode = strings.get(r.u32()) ?? '';
      const displayName = strings.get(r.u32()) ?? highway;
      const sourceDistanceMeters = r.f32();
      const sourceDurationSeconds = r.f32();
      const partCount = r.u32();
      const parts = [];
      for (let p = 0; p < partCount; p++) {
        const n = r.u32();
        const pts = new Array(n);
        for (let j = 0; j < n; j++) pts[j] = { lat: r.i32() / 1e7, lon: r.i32() / 1e7 };
        if (n < 2) continue;
        const polyline = new RoutePolyline(pts, 0.02);
        if (polyline.segmentCount <= 0) continue;
        this.partBoxes.push({ corridor: id, part: parts.length, box: polyline.box });
        parts.push(polyline);
      }
      const averageSpeed = sourceDurationSeconds > 0 ? sourceDistanceMeters / sourceDurationSeconds : 26.8;
      this.corridors.push({ id, highway, directionCode, displayName, sourceDistanceMeters, sourceDurationSeconds, parts, averageSpeed });
    }
  }

  /// Corridor positions near a location whose direction agrees with the course of travel.
  matches(c, course, radius, maxBearingDifference = 35) {
    const out = [];
    const probe = expandBox(pointBox(c), radius);
    for (const entry of this.partBoxes) {
      if (!boxIntersects(entry.box, probe)) continue;
      const corridor = this.corridors[entry.corridor];
      const part = corridor.parts[entry.part];
      for (const p of part.projections(c, radius)) {
        const diff = angleDifference(part.bearingAt(p.distanceAlong), course);
        if (diff <= maxBearingDifference) {
          out.push({ corridor, partIndex: entry.part, part, projection: p, bearingDifference: diff });
        }
      }
    }
    return out.sort((a, b) => (a.projection.offset + a.bearingDifference) - (b.projection.offset + b.bearingDifference));
  }
}
