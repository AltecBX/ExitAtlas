// Offline cache.
// App files: one set per version, fetched when this worker installs and kept only if every file matches
// APP_HASH, then served from that set. A reload opens at once on a weak or stalled connection, and index.html,
// its scripts and styles always come from the same version. The network is used only for a file outside the
// set (kept with it). A deploy changes APP_HASH, so browsers install the new worker on their next visit
// online; it takes over when its whole set is in, and the new version shows from the next load.
// Datasets (URLs carry the file's hash from manifest.json): cache first, keeping the newest two versions of
// each file so the app can fall back to the last good one. The manifest itself: network first.
// The datasets have their own cache that an app update keeps, so a deploy never leaves the phone without
// its offline data (about 24 MB that would otherwise download again, or fail to, on the road).

/// SHA-256 over APP_FILES (each line "file sha256", web/tests/sw.test.js computes it and says the new value
/// when an app file changes). It names this version's cache.
const APP_HASH = '094599a9f583b0099f5c9f90434b3ac665274b6a8dc15fa7aa64c3029479c5e3';
const CACHE = `exitatlas-v34-${APP_HASH.slice(0, 12)}`;
const DATA_CACHE = 'exitatlas-data';
const APP_FILES = [
  './', 'index.html', 'css/tokens.css', 'css/app.css', 'fonts/overpass-var.woff2', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
  'js/app/main.js', 'js/app/views.js', 'js/app/services.js', 'js/app/format.js', 'js/app/map.js', 'js/app/limits.js', 'js/app/prices.js', 'js/app/pricebook.js', 'js/app/chargers.js', 'js/app/announcer.js', 'js/app/sharecard.js', 'js/app/proxy.js', 'js/app/profilestore.js', 'js/app/smartstops.js', 'js/app/roadalerts.js', 'js/app/weather.js', 'js/app/weathericons.js', 'js/app/navmap.js', 'js/app/net.js', 'js/app/reroute.js',
  'js/engine/geo.js', 'js/engine/datasets.js', 'js/engine/exits.js', 'js/engine/route.js',
  'js/engine/tracking.js', 'js/engine/trip.js', 'js/engine/discovery.js', 'js/engine/osrm.js', 'js/engine/fuel.js', 'js/engine/restareas.js', 'js/engine/discover.js', 'js/engine/travels.js', 'js/engine/datamanifest.js', 'js/engine/profile.js',
  'js/engine/openinghours.js', 'js/engine/smartstop.js', 'js/engine/roadintel.js', 'js/engine/alertsources.js', 'js/engine/dashboard.js', 'js/engine/weather.js', 'js/engine/handoff.js', 'js/engine/guidance.js', 'js/engine/traffic.js', 'js/engine/gasprices.js', 'js/engine/pricecheck.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

/// Fetches every app file from the server (past the browser's HTTP cache) and keeps them only when together
/// they are the set this worker was made for. Otherwise (a dropped file, a copy not yet updated on the host)
/// the install fails, the version in use stays, and the browser tries again on a later visit.
async function precache() {
  const responses = await Promise.all(APP_FILES.map(async (file) => {
    const res = await fetch(new Request(file, { cache: 'reload' }));
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res;
  }));
  const lines = [];
  for (let i = 0; i < APP_FILES.length; i++) lines.push(`${APP_FILES[i]} ${await sha256(await responses[i].clone().arrayBuffer())}`);
  if (await sha256(new TextEncoder().encode(lines.join('\n'))) !== APP_HASH) throw new Error('the app files on the server are not this version');
  const cache = await caches.open(CACHE);
  await Promise.all(APP_FILES.map((file, i) => cache.put(file, responses[i])));
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Older ExitAtlas caches go, after their datasets move to the data cache. Other caches on this host are left
// alone: github.io serves every project of an account from the same origin.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('exitatlas-') && k !== CACHE && k !== DATA_CACHE).map(async (k) => {
      await keepData(await caches.open(k));
      await caches.delete(k);
    })))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // routing and search always go to the network
  const isData = url.pathname.includes('/Resources/Data/');
  if (isData && url.pathname.endsWith('/manifest.json')) {
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA_CACHE).then((c) => c.put(url.pathname, copy)); }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || Response.error())));
    return;
  }
  if (isData) {
    event.respondWith(caches.open(DATA_CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        await cache.put(req, res.clone());
        await prune(cache, url.pathname);
      }
      return res;
    }));
    return;
  }
  event.respondWith(appFile(req));
});

/// An app file from this version's set (a page, whatever its query, is index.html). Anything else from the
/// network, kept with the set when it is an app file; offline, a page falls back to index.html.
async function appFile(req) {
  const cache = await caches.open(CACHE);
  const page = req.mode === 'navigate';
  const hit = await cache.match(req, { ignoreSearch: page, ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && await isAppFile(res.clone())) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    const fallback = page ? await cache.match('index.html') : null;
    if (fallback) return fallback;
    throw e;
  }
}

/// Some static hosts answer a page request with an interstitial; only the real app page is cached.
async function isAppFile(res) {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return true;
  return (await res.text()).includes('js/app/main.js');
}

/// Copies the datasets (and the data manifest) of an older cache into the data cache, unless already there.
async function keepData(old) {
  const data = await caches.open(DATA_CACHE);
  for (const req of await old.keys()) {
    if (!new URL(req.url).pathname.includes('/Resources/Data/') || await data.match(req)) continue;
    const res = await old.match(req);
    if (res) await data.put(req, res);
  }
}

/// Keeps the two newest cached versions of a data file (the current one and the last good one).
async function prune(cache, pathname) {
  const versions = (await cache.keys()).filter((r) => new URL(r.url).pathname === pathname && new URL(r.url).search);
  for (const old of versions.slice(0, -2)) await cache.delete(old);
}
