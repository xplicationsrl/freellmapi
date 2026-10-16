// Service worker: makes the dashboard installable and lets it open offline.
//
//  - API traffic (/api, /v1, /v1beta, /mcp) is never touched: always live.
//  - Page loads are network-first; the last good index.html is the offline
//    fallback (every route is the same SPA shell).
//  - /assets/* is content-hashed, so cache-first is always correct.
//  - Requests made with cache: 'no-store' (the new-build check) bypass it.
const VERSION = 'v1';
const SHELL_CACHE = `freellmapi-shell-${VERSION}`;
const ASSET_CACHE = `freellmapi-assets-${VERSION}`;
const MAX_ASSETS = 200;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png'];
const LIVE_PATH = /^\/(?:api|v1|v1beta|mcp)(?:\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('freellmapi-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((k) => cache.delete(k)));
}

async function pageNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get('content-type') ?? '').includes('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/', response.clone());
    }
    return response;
  } catch {
    return (await caches.match('/', { cacheName: SHELL_CACHE })) ?? Response.error();
  }
}

async function assetCacheFirst(request) {
  const cached = await caches.match(request, { cacheName: ASSET_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
    trimAssets();
  }
  return response;
}

async function shellStaleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached ?? Response.error());
  return cached ?? fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.cache === 'no-store') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || LIVE_PATH.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(pageNetworkFirst(request));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetCacheFirst(request));
  } else if (SHELL.includes(url.pathname) && url.pathname !== '/') {
    event.respondWith(shellStaleWhileRevalidate(request));
  }
});
