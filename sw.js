/* Arabic Scrabble service worker — bump CACHE_VERSION on every deploy. */
const CACHE_VERSION = 'v24';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const SCOPE = self.registration.scope; // works at the domain root or in a sub-folder

const SHELL_FILES = [
  './', 'manifest.webmanifest', 'favicon.ico',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'multiplayer.js', 'multiplayer.css'
].map((p) => new URL(p, SCOPE).href);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing file must never block installation, so add files individually.
    await Promise.allSettled(SHELL_FILES.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Online multiplayer: game state must always be live. Never cache the API (or the dev realtime endpoints).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dev/')) return;

  // Live Firebase API traffic is never cached.
  if (/(firestore|identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname)) return;

  // Page loads: network first; offline -> the page itself or the cached app shell.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(new URL('./', SCOPE).href, response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match(request, { ignoreSearch: true })) ||
               (await caches.match(new URL('./', SCOPE).href)) ||
               new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin && !CDN_HOSTS.includes(url.hostname)) return;

  // Same-origin files + CDN assets: cache first, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached);
    return cached || network;
  })());
});
