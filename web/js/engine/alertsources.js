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

/// Work zone feeds (WZDx) that need no key and state a CC0 license in their feed_info, checked 2026-10-28
/// (docs/13). `cors`: a browser can read it directly; the web app reads the others through the key proxy
/// (infra/worker /v1/wzdx/<state>). `large`: over 1 MB, refreshed less often. `quirks: 'njdot'`: road_names
/// holds the cross streets, so the road, direction, start time and lanes come from the description.
/// Left out: feeds with the key in the URL (FL, OK), a key (CO, VA, NC, PA Turnpike, TX, IL, OH, MI, MA, OR),
/// no stated license (IA, ID, the New England feed), stale (UT since 2023), down (NY, NM, KS when checked).
export const WZDX_FEEDS = Object.freeze({
  DE: { name: 'DelDOT', url: 'https://wzdx.e-dot.com/del_dot_feed_wzdx_v4.1.geojson', cors: true },
  IN: { name: 'INDOT', url: 'https://in.carsprogram.org/carsapi_v1/api/wzdx', cors: true, large: true },
  KY: { name: 'KYTC', url: 'https://storage.googleapis.com/kytc-its-2020-openrecords/public/feeds/WZDx/kytc_wzdx_v4.1.geojson', cors: false },
  LA: { name: 'LADOTD', url: 'https://wzdx.e-dot.com/la_dot_d_feed_wzdx_v4.1.geojson', cors: true },
  MD: { name: 'MDOT SHA', url: 'https://filter.ritis.org/wzdx_v4.1/mdot.geojson', cors: false },
  MN: { name: 'MnDOT', url: 'https://mn.carsprogram.org/carsapi_v1/api/wzdx', cors: false },
  MO: { name: 'MoDOT', url: 'https://traveler.modot.org/timconfig/feed/desktop/mo_wzdx.json', cors: false, large: true },
  MS: { name: 'MDOT Mississippi', url: 'https://api.mdottraffic.com/prod/v3/data/wzdx', cors: true },
  ND: { name: 'NDDOT', url: 'https://travelfiles.dot.nd.gov/geojson_nc/wzdx_geojson.json', cors: true },
  NJ: { name: 'NJDOT', url: 'https://smartworkzones.njit.edu/nj/wzdx', cors: false, quirks: 'njdot', zone: 'America/New_York' },
  WA: { name: 'WSDOT', url: 'https://wzdx.wsdot.wa.gov/api/v4/WorkZoneFeed', cors: true },
  WI: { name: 'WisDOT', url: 'https://511wi.gov/api/wzdx', cors: false, large: true },
});

export const WZDX_KINDS = Object.freeze(['closure', 'construction']);

export function wzdxSource(state) {
  return { id: `wzdx-${state}`, name: `${WZDX_FEEDS[state]?.name ?? state} work zones` };
}

/// A feed's text (or parsed body) as an object; one feed sends its JSON inside a JSON string.
export function parseWzdx(body) {
  let data = typeof body === 'string' ? JSON.parse(body) : body;
  if (typeof data === 'string') data = JSON.parse(data);
  return data;
}

/// When the publisher last updated the whole feed (feed_info.update_date), or null.
export function wzdxUpdatedAt(body) {
  const data = parseWzdx(body);
  return validSeconds((data?.feed_info ?? data?.road_event_feed_info)?.update_date);
}

/// A feed's work zones as incidents. Detours and features without a location are left out.
export function wzdxIncidents(body, state) {
  const data = parseWzdx(body);
  const feed = WZDX_FEEDS[state] ?? {};
  const source = wzdxSource(state);
  const out = [];
  for (const f of data?.features ?? []) {
    const p = f.properties ?? {};
    const core = p.core_details ?? {};
    if (core.event_type !== 'work-zone') continue;
    const geometry = wzdxGeometry(f.geometry);
    if (!geometry) continue;
    const text = typeof core.description === 'string' ? core.description.replace(/\s+/g, ' ').trim() || null : null;
    const nj = feed.quirks === 'njdot' ? njdotDetails(text, feed.zone) : null;
    const impact = nj ? nj.impact : wzdxImpact(p);
    out.push({
      id: `wzdx:${state}:${f.id ?? out.length}`, category: impact.closed ? 'closure' : 'construction',
      description: text ?? 'Work zone', detail: null, area: null, source, verification: 'official',
      reportedAt: validSeconds(core.creation_date),
      updatedAt: validSeconds(core.update_date) ?? validSeconds(p.worker_presence?.worker_presence_last_confirmed_date),
      startsAt: nj?.startsAt ?? validSeconds(p.start_date), endsAt: validSeconds(p.end_date), expiresAt: null,
      geometry, road: nj ? nj.road : roadNames(core.road_names, state),
      direction: nj?.direction ?? (core.direction && core.direction !== 'unknown' && core.direction !== 'undefined' ? core.direction : null),
      lanes: nj ? nj.lanes : impact.lanes, severity: impact.severity,
    });
  }
  return out;
}

/// ISO 8601 with a zone, fractions of a second dropped (feeds send up to 7 digits). Dates before 2000 are
/// placeholders some feeds send ("0001-01-01").
function validSeconds(iso) {
  const m = typeof iso === 'string' ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(iso.trim()) : null;
  const t = m ? Date.parse(m[1] + m[2]) : NaN;
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) ? t / 1000 : null;
}

/// LineString as a line; MultiPoint as a point (one) or a line from start to end (two or more).
function wzdxGeometry(g) {
  const c = (a) => (Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]) ? { lat: a[1], lon: a[0] } : null);
  const list = (g?.coordinates ?? []).map(c).filter(Boolean);
  if (g?.type === 'LineString' && list.length >= 2) return { type: 'line', coordinates: list };
  if (g?.type === 'MultiPoint' && list.length === 1) return { type: 'point', coordinate: list[0] };
  if (g?.type === 'MultiPoint' && list.length >= 2) return { type: 'line', coordinates: [list[0], list[list.length - 1]] };
  return null;
}

/// "SR1 Southbound", "MD42", "US50", "I95" as "DE 1", "MD 42", "US 50", "I 95" so the highway parser reads
/// them. A two letter prefix that is not this state, US or I (a county "CO140") stays as it is, and so does a
/// lettered route ("MD3BU", business MD 3, becomes "MD 3BU", which no highway matches).
function roadNames(names, state) {
  const out = [];
  for (const raw of names ?? []) {
    let n = String(raw ?? '').replace(/\s+(north|south|east|west)bound$/i, '').trim();
    if (!n || /^no name$/i.test(n)) continue;
    n = n.replace(/^(?:SR|SH|STATE ROUTE|STATE HWY|RT|ROUTE)\s*-?\s*(\d+[A-Z]?)\b/i, `${state} $1`);
    const m = /^([A-Z]{1,2})-?(\d+)([A-Z]*)$/i.exec(n);
    if (m && [state, 'US', 'I'].includes(m[1].toUpperCase())) n = `${m[1].toUpperCase()} ${m[2]}${m[3]}`;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out.join(' / ') : null;
}

const SOME_CLOSED = new Set(['some-lanes-closed', 'some-lanes-closed-merge-left', 'some-lanes-closed-merge-right', 'some-lanes-closed-split']);

/// Closure, severity and a lane summary from vehicle_impact and the lanes list.
function wzdxImpact(p) {
  const lanes = Array.isArray(p.lanes) ? p.lanes : [];
  const general = lanes.filter((l) => l.type === 'general');
  const closed = general.filter((l) => l.status === 'closed').length;
  let text = null;
  if (general.length && closed === general.length) text = 'All lanes closed';
  else if (closed) text = `${closed} of ${general.length} lanes closed`;
  else if (lanes.some((l) => l.type === 'shoulder' && l.status === 'closed')) text = 'Shoulder closed';
  else if (lanes.some((l) => /^(shift|merge)/.test(l.status ?? ''))) text = 'Lane shift';
  const v = p.vehicle_impact;
  if (v === 'all-lanes-closed') return { closed: true, severity: 'major', lanes: 'All lanes closed' };
  // Some feeds count a closed shoulder as a closed lane; a lanes list with every travel lane open wins.
  if (SOME_CLOSED.has(v)) return { closed: false, severity: general.length && !closed ? 'minor' : 'moderate', lanes: text };
  if (v === 'alternating-one-way') return { closed: false, severity: 'moderate', lanes: 'Alternating one way traffic' };
  if (v === 'all-lanes-open') return { closed: false, severity: 'minor', lanes: text ?? 'All lanes open' };
  // Unknown impact: only what the lanes list says.
  if (general.length && closed === general.length) return { closed: true, severity: 'major', lanes: text };
  return { closed: false, severity: closed ? 'moderate' : 'unknown', lanes: text };
}

const WEEKDAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/// NJDOT text: "NJDOT - STMC: Roadwork on I-287 Northbound between A and B, Friday October 30, 2026 12:00 AM
/// thru Saturday October 31, 2026 12:00 AM, at least one lane closed". Its start_date is when the entry was
/// made, so the start comes from the text (local time in `zone`).
function njdotDetails(text, zone) {
  const s = text ?? '';
  const on = /\bon (.+?)\s+(?:(northbound|southbound|eastbound|westbound|both directions)\b|(?=(?:near|between|at)\b))/i.exec(s);
  const when = new RegExp(`${WEEKDAY} ([A-Za-z]+) (\\d{1,2}), (\\d{4}) (\\d{1,2}):(\\d\\d) ([AP]M)(?: thru (?:${WEEKDAY} [A-Za-z]+ \\d{1,2}, \\d{4} )?\\d{1,2}:\\d\\d [AP]M)?`).exec(s);
  let startsAt = null;
  if (when) {
    const month = MONTHS.indexOf(when[1].toLowerCase());
    const hour = (Number(when[4]) % 12) + (when[6] === 'PM' ? 12 : 0);
    if (month >= 0) startsAt = zonedSeconds(Number(when[3]), month, Number(when[2]), hour, Number(when[5]), zone);
  }
  // Lane details follow the schedule (or the last place name in parentheses when there is no schedule).
  const cut = when ? when.index + when[0].length : s.lastIndexOf(')') + 1;
  const after = cut > 0 ? s.slice(cut) : '';
  const tail = after.replace(/^[\s,]+/, '').trim();
  const clauses = tail ? tail.split(';').map((c) => c.trim()).filter(Boolean) : [];
  const closed = clauses.length > 0 && clauses.every((c) => /all lanes closed/i.test(c));
  const severity = closed ? 'major' : /lanes? closed|alternating/i.test(tail) ? 'moderate' : /shoulder|all lanes open/i.test(tail) ? 'minor' : 'unknown';
  return {
    road: on ? on[1].trim() : null, direction: on?.[2] ?? null, startsAt,
    lanes: tail ? (tail[0].toUpperCase() + tail.slice(1)).slice(0, 140) : null, impact: { closed, severity },
  };
}

/// Unix seconds for a wall clock time in an IANA zone (the zone's offset at that moment, DST included).
export function zonedSeconds(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  let t = wall;
  for (let k = 0; k < 2; k++) {
    const l = localParts(t, zone);
    t = wall - (Date.UTC(l.year, l.month, l.day, l.hour, l.minute) - t);
  }
  return Math.floor(t / 1000);
}

const partFormatters = new Map();
function localParts(ms, zone) {
  let f = partFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    partFormatters.set(zone, f);
  }
  const g = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { year: g.year, month: g.month - 1, day: g.day, hour: g.hour % 24, minute: g.minute };
}
