// How much Roadbeacon / Roadstr road event data actually exists (research for docs/14, not used by the
// apps): reads the Nostr kinds 1315 (reports) and 1316 (votes) from the relays Roadbeacon uses and prints
// counts only: by category, in the United States, and by age. No positions, identities or event content
// are printed or kept. Run with Node 22 or later (built in WebSocket):
//   node tools/probes/roadbeacon_coverage.mjs
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub', 'wss://nostr.mom', 'wss://relay.snort.social'];
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

/// Every event the relay returns for the filter, paging back with `until` while it keeps filling pages.
async function fetchAll(url, filter, { pages = 20, timeout = 15000 } = {}) {
  const out = new Map();
  let until = filter.until ?? now + 60;
  for (let p = 0; p < pages; p++) {
    const batch = await new Promise((resolve) => {
      const got = [];
      let ws;
      const done = (why) => { try { ws?.close(); } catch {} resolve({ got, why }); };
      const timer = setTimeout(() => done('timeout'), timeout);
      try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); return resolve({ got, why: `error ${e.message}` }); }
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'probe', { ...filter, until, limit: 500 }]));
      ws.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]) got.push(msg[2]);
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { clearTimeout(timer); done(msg[0]); }
      };
      ws.onerror = () => { clearTimeout(timer); done('error'); };
    });
    for (const e of batch.got) out.set(e.id, e);
    if (batch.got.length < 400 || batch.why !== 'EOSE') return { events: [...out.values()], status: batch.why };
    until = Math.min(...batch.got.map((e) => e.created_at)) - 1;
  }
  return { events: [...out.values()], status: 'paged' };
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function geohashCenter(g) {
  let lat = [-90, 90], lon = [-180, 180], even = true;
  for (const ch of g) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const r = even ? lon : lat, mid = (r[0] + r[1]) / 2;
      if ((v >> b) & 1) r[0] = mid; else r[1] = mid;
      even = !even;
    }
  }
  return { lat: (lat[0] + lat[1]) / 2, lon: (lon[0] + lon[1]) / 2 };
}
const tag = (e, k) => e.tags.find((t) => t[0] === k)?.[1];
function position(e) {
  const lat = Number(tag(e, 'lat')), lon = Number(tag(e, 'lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  const g = e.tags.filter((t) => t[0] === 'g').map((t) => t[1]).sort((a, b) => b.length - a.length)[0];
  return g ? geohashCenter(g) : null;
}
// Rough boxes: lower 48 states, Alaska, Hawaii.
const inUS = (p) => p && ((p.lat >= 24.4 && p.lat <= 49.5 && p.lon >= -125 && p.lon <= -66.9)
  || (p.lat >= 51 && p.lat <= 71.5 && p.lon >= -170 && p.lon <= -129) || (p.lat >= 18.8 && p.lat <= 22.4 && p.lon >= -160.5 && p.lon <= -154.7));

const reports = new Map(), votes = new Map(), status = {};
for (const url of RELAYS) {
  const r = await fetchAll(url, { kinds: [1315], since: now - 365 * DAY });
  const v = await fetchAll(url, { kinds: [1316], since: now - 365 * DAY });
  status[url] = { reports: r.events.length, votes: v.events.length, end: `${r.status}/${v.status}` };
  for (const e of r.events) reports.set(e.id, e);
  for (const e of v.events) votes.set(e.id, e);
}

const summarize = (list) => {
  const by = (f) => list.reduce((m, e) => { const k = f(e); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const age = (e) => now - e.created_at;
  return {
    total: list.length,
    authors: new Set(list.map((e) => e.pubkey)).size,
    byCategory: by((e) => tag(e, 't') ?? 'none'),
    byAge: { '24h': list.filter((e) => age(e) <= DAY).length, '7d': list.filter((e) => age(e) <= 7 * DAY).length,
      '30d': list.filter((e) => age(e) <= 30 * DAY).length, '365d': list.length },
    newestHoursAgo: list.length ? Math.round(Math.min(...list.map(age)) / 3600) : null,
  };
};
const all = [...reports.values()];
const us = all.filter((e) => inUS(position(e)));
const usPolice = us.filter((e) => tag(e, 't') === 'police');
const usIds = new Set(us.map((e) => e.id));
console.log(JSON.stringify({
  measuredAt: new Date(now * 1000).toISOString(), relays: status,
  world: summarize(all), unitedStates: summarize(us), unitedStatesPolice: summarize(usPolice),
  votes: { total: votes.size, onUSReports: [...votes.values()].filter((v) => usIds.has(tag(v, 'e'))).length },
  withoutPosition: all.filter((e) => !position(e)).length,
}, null, 2));
