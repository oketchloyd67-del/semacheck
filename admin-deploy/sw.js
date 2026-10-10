// v2 — cache-first for HTML/JS was serving a stale dashboard.html against a
// newer admin.js (which then threw on a missing element), so the panel broke.
// Now: network first, cache only as the offline fallback, purge old versions.
const CACHE_NAME = 'semacheck-admin-v2';
const STATIC_ASSETS = [
  '/login',
  '/login.html',
  '/dashboard',
  '/dashboard.html',
  '/css/style.css',
  '/js/admin.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // All-settled: one missing asset must not abort the whole install.
      Promise.allSettled(STATIC_ASSETS.map((asset) => cache.add(asset)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls: always real network. Only a genuine network failure becomes the
  // offline response — a 503/500 from the server passes through untouched so
  // the app can show the real server error.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Offline — please check your connection.' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 503,
        });
      })
    );
    return;
  }

  // Everything else: network first, cache as fallback when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
  );
});
