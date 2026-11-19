/*
 * Service worker of the installable dashboard (Cantiere 3, item 45). It keeps only the files of
 * the dashboard itself, never answers of the API: data of the organization are not stored on the
 * device. Pages open offline only as far as the empty shell, which then says the service is not
 * reachable.
 */
const CACHE = 'sinfonia-shell-v1';
const SHELL = '/app/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only the dashboard's own files; the API and everything else go to the network untouched.
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;

  if (request.mode === 'navigate') {
    // Network first: the newest dashboard when online, the cached shell otherwise.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          }
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/app/assets/')) {
    // Hashed file names never change: cache first.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
