/* Roadcheck IRI – Service Worker v1.3 */
const CACHE = 'roadcheck-v1';
const TILE_CACHE = 'roadcheck-tiles-v1';

const PRECACHE = [
  './index.html',
  './app.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(err => console.warn('[SW] Precache error:', err)))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // OSM tile strategy: network-first, cache tiles for offline
  if (url.includes('tile.openstreetmap.org')) {
    e.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        fetch(e.request.clone())
          .then(res => { cache.put(e.request, res.clone()); return res; })
          .catch(() => cache.match(e.request))
      )
    );
    return;
  }

  // Google Fonts: stale-while-revalidate
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fresh = fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; });
          return cached || fresh;
        })
      )
    );
    return;
  }

  // SheetJS dynamic load: network only (don't cache heavy lib on install)
  if (url.includes('sheetjs') || url.includes('xlsx')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; });
        })
      )
    );
    return;
  }

  // Default: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
