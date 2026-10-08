// Caches the app and the card index so it opens fast (and works offline) as a phone app.
const CACHE = 'pokescan-v24';
const SHELL = ['./', 'index.html', 'style.css', 'fingerprint.js', 'detect.js', 'matcher.js', 'worker.js', 'prices.js', 'app.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Card images (other sites): cache-first, so the collection and sets show pictures
// offline. Fetched with CORS — these hosts allow it — because browsers count each opaque
// (no-CORS) cached response as several MB of quota. TCGplayer's product images don't allow
// CORS, so sealed product pictures aren't cached. Kept to the most recent IMG_MAX images.
const IMG_CACHE = 'pokescan-img-v1';
const IMG_MAX = 600;
const IMG_HOSTS = ['images.pokemontcg.io', 'images.scrydex.com'];

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

async function cachedImage(request) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
  if (res.ok) {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)));
  }
  return res;
}

// Network first (so updates show up), cached copy when offline or the network fails.
// The card index is large, so it's checked with the server's ETag rather than re-downloaded.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (IMG_HOSTS.includes(url.hostname)) {
    e.respondWith(cachedImage(e.request).catch(() => caches.match(e.request)));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)));
});
