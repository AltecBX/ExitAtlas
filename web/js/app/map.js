// Offline route map drawn as SVG from the bundled state polygons: no map tiles, no network.

const SEGMENT_COLORS = ['var(--seg0)', 'var(--seg1)', 'var(--seg2)', 'var(--seg3)'];

/// Equirectangular projection fitted to a box, with longitude scaled by the mid latitude.
function projector(box, width, height, pad) {
  const midLat = (box.minLat + box.maxLat) / 2;
  const k = Math.cos(midLat * Math.PI / 180);
  const spanX = Math.max((box.maxLon - box.minLon) * k, 1e-6);
  const spanY = Math.max(box.maxLat - box.minLat, 1e-6);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2, offY = (height - spanY * scale) / 2;
  return (lat, lon) => [offX + (lon - box.minLon) * k * scale, offY + (box.maxLat - lat) * scale];
}

/// Path data for a list of points, skipping points closer than `minStep` pixels.
function pathData(n, get, project, minStep, close) {
  let d = '', lx = 0, ly = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const [lat, lon] = get(i);
    const [x, y] = project(lat, lon);
    if (count && i < n - 1 && Math.abs(x - lx) < minStep && Math.abs(y - ly) < minStep) continue;
    d += `${count ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    lx = x; ly = y; count += 1;
  }
  return count > 1 ? d + (close ? 'Z' : '') : '';
}

/// Static parts of the map for a plan (cached by the caller): state shapes and the route by state.
export function buildRouteMap(plan, states, width = 360, height = 300) {
  const poly = plan.route.polyline;
  const box = { ...poly.box };
  const padLat = (box.maxLat - box.minLat) * 0.06 + 0.02, padLon = (box.maxLon - box.minLon) * 0.06 + 0.02;
  box.minLat -= padLat; box.maxLat += padLat; box.minLon -= padLon; box.maxLon += padLon;
  const project = projector(box, width, height, 8);
  const codes = new Set(plan.states.segments.map((s) => s.code).filter(Boolean));
  let shapes = '';
  for (const region of states.regions) {
    const overlaps = !(region.box.minLat > box.maxLat || region.box.maxLat < box.minLat
      || region.box.minLon > box.maxLon || region.box.maxLon < box.minLon);
    if (!overlaps) continue;
    let d = '';
    for (const polygon of states.polygons[region.id]) {
      for (const ring of polygon.rings) {
        d += pathData(ring.lat.length, (i) => [ring.lat[i], ring.lon[i]], project, 1.2, true);
      }
    }
    if (d) shapes += `<path d="${d}" class="${codes.has(region.code) ? 'map-state on' : 'map-state'}"/>`;
  }
  let route = '';
  for (const seg of plan.states.segments) {
    const i0 = poly.segmentIndexContaining(seg.startDistance), i1 = Math.min(poly.segmentIndexContaining(seg.endDistance) + 1, poly.pointCount - 1);
    const pts = [poly.coordinateAt(seg.startDistance)];
    for (let i = i0 + 1; i <= i1; i++) if (poly.cum[i] > seg.startDistance && poly.cum[i] < seg.endDistance) pts.push(poly.point(i));
    pts.push(poly.coordinateAt(seg.endDistance));
    const d = pathData(pts.length, (i) => [pts[i].lat, pts[i].lon], project, 1, false);
    if (d) route += `<path d="${d}" class="map-route" style="stroke:${SEGMENT_COLORS[seg.index % SEGMENT_COLORS.length]}"/>`;
  }
  let labels = '';
  const placed = [];
  for (const seg of plan.states.segments.slice(1)) {
    const [x, y] = project(seg.entryCoordinate.lat, seg.entryCoordinate.lon);
    // Skip a badge that would cover one already drawn (short states such as DC and DE).
    if (placed.some(([px, py]) => Math.abs(px - x) < 26 && Math.abs(py - y) < 18)) continue;
    placed.push([x, y]);
    labels += `<g class="map-badge" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect x="-12" y="-8" width="24" height="16" rx="5"/><text y="4">${seg.code ?? '?'}</text></g>`;
  }
  const [ex, ey] = project(poly.lat[poly.pointCount - 1], poly.lon[poly.pointCount - 1]);
  const end = `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" class="map-end"/>`;
  return { width, height, project, base: shapes + route + end, labels };
}

export function renderRouteMap(map, position) {
  let you = '';
  if (position) {
    const [x, y] = map.project(position.lat, position.lon);
    you = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" class="map-you"/>`;
  }
  return `<svg class="route-map" viewBox="0 0 ${map.width} ${map.height}" role="img" aria-label="Route map by state">${map.base}${map.labels}${you}</svg>`;
}
