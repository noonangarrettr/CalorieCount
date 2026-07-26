/* ============================================================
   service-worker.js — offline app shell

   Strategy by request type:
     app shell (html/js/css/icons) → stale-while-revalidate
     food APIs                     → network-only (Firestore handles
                                     its own offline cache; caching
                                     search results here would serve
                                     stale nutrition data)

   Bump CACHE_VERSION whenever you change a shell file, or returning
   users will keep the old copy until their cache expires.
   ============================================================ */

const CACHE_VERSION = 'caloriecount-v3';

const SHELL = [
  './',
  './index.html',
  './store-firestore.js',
  './firebase-config.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

/* Never cache these — always go to network. */
const NETWORK_ONLY = [
  'api.nal.usda.gov',
  'world.openfoodfacts.org',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll rejects the whole batch if any single file 404s, which would
      // leave the SW uninstalled. Add individually and tolerate misses.
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // Only GET is cacheable.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (NETWORK_ONLY.some(host => url.hostname.includes(host))) return;

  // Cross-origin (fonts, the ZXing CDN): cache-first, since these are
  // versioned and immutable.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Same-origin shell: stale-while-revalidate. Instant load from cache,
  // fresh copy fetched in the background for next time.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, copy));
        }
        return res;
      }).catch(() => cached);

      return cached || network;
    })
  );
});
