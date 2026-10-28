// Discover ahead: notable places near the route (discover.json from tools/data-pipeline/build_discover.py,
// Wikidata, CC0). Port target: Discovery/DiscoverAhead.swift.
import { SpatialGrid, expandBox } from './geo.js';

export const DISCOVER_CATEGORIES = {
  nationalPark: { title: 'National park', icon: '🏞️', near: 16000 },
  nationalMonument: { title: 'National monument', icon: '🗿', near: 16000 },
  statePark: { title: 'State park', icon: '🌲', near: 16000 },
  waterfall: { title: 'Waterfall', icon: '💧', near: 16000 },
  cave: { title: 'Cave', icon: '🕳️', near: 16000 },
  viewpoint: { title: 'Scenic viewpoint', icon: '🔭', near: 8000 },
  museum: { title: 'Museum', icon: '🏛️', near: 8000 },
  zoo: { title: 'Zoo', icon: '🦒', near: 8000 },
  amusementPark: { title: 'Amusement park', icon: '🎢', near: 8000 },
  historicSite: { title: 'Historic site', icon: '🏚️', near: 8000 },
  landmark: { title: 'Landmark', icon: '📍', near: 8000 },
};

export class DiscoverDataset {
  constructor(json) {
    if (json?.meta?.kind !== 'discover') throw new Error('not a discover dataset');
    this.metadata = json.meta;
    this.items = json.items.map((it, index) => ({ ...it, index, coordinate: { lat: it.lat, lon: it.lon } }));
    this.grid = new SpatialGrid(0.1);
    for (const it of this.items) this.grid.insertPoint(it.index, it.lat, it.lon);
  }
}

/// Places within their category's distance of the route, in route order, each with the exit nearest
/// along the route. Distances off the route are straight lines (labeled so in the app).
export function matchDiscover(polyline, dataset, exits = []) {
  const out = [];
  const ids = new Set(dataset.grid.query(expandBox(polyline.box, 16000)));
  for (const i of ids) {
    const item = dataset.items[i];
    const near = DISCOVER_CATEGORIES[item.cat]?.near ?? 8000;
    const p = polyline.nearestProjection(item.coordinate, near);
    if (!p) continue;
    let exit = null, best = Infinity;
    for (const e of exits) {
      const d = Math.abs(e.distanceAlongRoute - p.distanceAlong);
      if (d < best) { best = d; exit = e; }
      if (e.distanceAlongRoute > p.distanceAlong + best) break;
    }
    out.push({ item, distanceAlongRoute: p.distanceAlong, offMeters: p.offset, exit: best <= 5000 ? exit : null });
  }
  out.sort((a, b) => a.distanceAlongRoute - b.distanceAlongRoute);
  return out;
}
