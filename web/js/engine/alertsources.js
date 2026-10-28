// Converters from provider formats to the Road Intelligence schema (engine/roadintel.js). Pure functions,
// tested on real captured responses; fetching, caching and retries live in app/roadalerts.js.
// Same conversions as Sources/ExitAtlasCore/Alerts/AlertSources.swift.

/// National Weather Service events that matter on the road, and the kind each becomes. Marine, beach, air
/// quality, frost and heat products are left out; watches are left out (conditions favorable, not occurring).
export const NWS_EVENTS = Object.freeze({
  'Tornado Warning': 'weather',
  'Severe Thunderstorm Warning': 'weather',
  'Snow Squall Warning': 'weather',
  'Blizzard Warning': 'weather',
  'Ice Storm Warning': 'weather',
  'Winter Storm Warning': 'weather',
  'Winter Weather Advisory': 'weather',
  'Dense Fog Advisory': 'weather',
  'Freezing Fog Advisory': 'weather',
  'High Wind Warning': 'weather',
  'Wind Advisory': 'weather',
  'Dust Storm Warning': 'weather',
  'Blowing Dust Warning': 'weather',
  'Hurricane Warning': 'weather',
  'Tropical Storm Warning': 'weather',
  'Extreme Wind Warning': 'weather',
  'Flash Flood Warning': 'flooding',
  'Flood Warning': 'flooding',
  'Coastal Flood Warning': 'flooding',
});

const NWS_SEVERITY = { Extreme: 'severe', Severe: 'major', Moderate: 'moderate', Minor: 'minor' };
export const NWS_SOURCE = Object.freeze({ id: 'nws', name: 'National Weather Service' });

const seconds = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/// NWS alerts returned by point queries along the route, as incidents. `responses` is
/// [{point: {lat, lon}, features: [...]}]; an alert returned at several points is one incident. An alert
/// with a polygon keeps it; a zone or county alert (no polygon) is placed at the points where NWS returned it.
export function nwsIncidents(responses) {
  const byId = new Map();
  for (const { point, features } of responses) {
    for (const f of features ?? []) {
      const p = f.properties ?? {};
      const kind = NWS_EVENTS[p.event];
      if (!kind || p.status !== 'Actual') continue;
      const id = `nws:${p.id ?? f.id}`;
      const known = byId.get(id);
      if (known) {
        if (known.geometry.type === 'points') known.geometry.coordinates.push(point);
        continue;
      }
      byId.set(id, {
        id, category: kind, description: p.event, detail: p.headline ?? null, area: p.areaDesc ?? null,
        source: NWS_SOURCE, verification: 'official',
        reportedAt: seconds(p.sent), updatedAt: seconds(p.sent), startsAt: seconds(p.onset ?? p.effective),
        endsAt: seconds(p.ends ?? p.expires), expiresAt: seconds(p.expires),
        geometry: nwsGeometry(f.geometry) ?? { type: 'points', coordinates: [point] },
        road: null, direction: 'both', lanes: null, severity: NWS_SEVERITY[p.severity] ?? 'unknown',
      });
    }
  }
  return [...byId.values()];
}

function nwsGeometry(g) {
  if (!g) return null;
  if (g.type === 'Polygon') return { type: 'polygon', rings: [g.coordinates[0]] };
  if (g.type === 'MultiPolygon') return { type: 'polygon', rings: g.coordinates.map((poly) => poly[0]) };
  return null;
}
