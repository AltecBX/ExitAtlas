// Offline cache. App files: network first, cache fallback, so updates arrive when online.
// Datasets (versioned URLs): cache first, since they only change with a new version string.
const CACHE = 'exitatlas-v7';
const APP_FILES = [
  './', 'index.html', 'css/tokens.css', 'css/app.css', 'fonts/overpass-var.woff2', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png',
  'js/app/main.js', 'js/app/views.js', 'js/app/services.js', 'js/app/format.js', 'js/app/map.js', 'js/app/limits.js', 'js/app/prices.js', 'js/app/chargers.js', 'js/app/announcer.js', 'js/app/sharecard.js',
  'js/engine/geo.js', 'js/engine/datasets.js', 'js/engine/exits.js', 'js/engine/route.js',
  'js/engine/tracking.js', 'js/engine/trip.js', 'js/engine/discovery.js', 'js/engine/osrm.js', 'js/engine/fuel.js', 'js/engine/restareas.js', 'js/engine/discover.js', 'js/engine/passport.js',
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
  if (isData) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
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
