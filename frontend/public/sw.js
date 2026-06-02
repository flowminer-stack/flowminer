// FlowMiner service worker — network-first with static-asset caching.
// Never caches /api routes; never intercepts navigation to broken pages.

const CACHE_VERSION = 'flowminer-v1';

// Assets worth caching locally (Vite-generated bundles, fonts, etc.)
const STATIC_EXTENSIONS = ['.js', '.css', '.woff2', '.woff', '.ttf', '.svg', '.png', '.webp', '.ico'];

function isStaticAsset(url) {
  const { pathname } = new URL(url);
  return STATIC_EXTENSIONS.some((ext) => pathname.endsWith(ext));
}

function isApiRequest(url) {
  return new URL(url).pathname.startsWith('/api');
}

// Install — activate immediately, no pre-caching so we stay minimal.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove stale caches from previous versions.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  // Never intercept API calls — always go to the network.
  if (isApiRequest(request.url)) return;

  if (isStaticAsset(request.url)) {
    // Stale-while-revalidate for immutable static assets (Vite hashes them).
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request)
            .then((response) => {
              if (response.ok) {
                cache.put(request, response.clone());
              }
              return response;
            })
            .catch(() => cached); // offline fallback to cache

          return cached || networkFetch;
        }),
      ),
    );
    return;
  }

  // For HTML / navigation requests: network-first, no caching.
  // This keeps SPA routing intact and avoids stale shells.
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch {
        // If offline and we have a cached shell, return it.
        const cached = await caches.match('/');
        return cached || Response.error();
      }
    })(),
  );
});
