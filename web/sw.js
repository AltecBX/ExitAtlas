// Offline cache. App files: network first, cache fallback, so updates arrive when online.
// Datasets (URLs carry the file's hash from manifest.json): cache first, keeping the newest two versions of
// each file so the app can fall back to the last good one. The manifest itself: network first.
const CACHE = 'exitatlas-v24';
const APP_FILES = [
  './', 'index.html', 'css/tokens.css', 'css/app.css', 'fonts/overpass-var.woff2', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
  'js/app/main.js', 'js/app/views.js', 'js/app/services.js', 'js/app/format.js', 'js/app/map.js', 'js/app/limits.js', 'js/app/prices.js', 'js/app/chargers.js', 'js/app/announcer.js', 'js/app/sharecard.js', 'js/app/proxy.js', 'js/app/profilestore.js', 'js/app/smartstops.js', 'js/app/roadalerts.js', 'js/app/weather.js', 'js/app/weathericons.js', 'js/app/navmap.js',
  'js/engine/geo.js', 'js/engine/datasets.js', 'js/engine/exits.js', 'js/engine/route.js',
  'js/engine/tracking.js', 'js/engine/trip.js', 'js/engine/discovery.js', 'js/engine/osrm.js', 'js/engine/fuel.js', 'js/engine/restareas.js', 'js/engine/discover.js', 'js/engine/travels.js', 'js/engine/datamanifest.js', 'js/engine/profile.js',
  'js/engine/openinghours.js', 'js/engine/smartstop.js', 'js/engine/roadintel.js', 'js/engine/alertsources.js', 'js/engine/dashboard.js', 'js/engine/weather.js', 'js/engine/handoff.js', 'js/engine/guidance.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
      return res;
    }).catch(() => caches.match(url.pathname).then((hit) => hit || Response.error())));
    return;
  }
  if (isData) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
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
  event.respondWith(fetch(req).then(async (res) => {
    if (res.ok) {
      const copy = res.clone();
      if (await isAppFile(res.clone())) caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});

/// Some static hosts answer a page request with an interstitial; only the real app page is cached.
async function isAppFile(res) {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return true;
  return (await res.text()).includes('js/app/main.js');
}

/// Keeps the two newest cached versions of a data file (the current one and the last good one).
async function prune(cache, pathname) {
  const versions = (await cache.keys()).filter((r) => new URL(r.url).pathname === pathname && new URL(r.url).search);
  for (const old of versions.slice(0, -2)) await cache.delete(old);
}
