// Caches the app and the card index so it opens fast (and works offline) as a phone app.
const CACHE = 'pokescan-v52';
const SHELL = ['./', 'index.html', 'style.css', 'cardprint.js', 'dev.js', 'detect.js', 'matcher.js', 'worker.js', 'prices.js', 'account.js', 'app.js', 'wants.js', 'backups.js', 'grade-core.js', 'grade.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Card images (other sites): cache-first, so the collection and sets show pictures
// offline. Fetched with CORS — these hosts allow it — because browsers count each opaque
// (no-CORS) cached response as several MB of quota. TCGplayer's product images don't allow
// CORS, so sealed product pictures aren't cached. Kept to the most recent IMG_MAX images.
const IMG_CACHE = 'pokescan-img-v1';
// Card and price data (data/…): kept in their own cache, which app updates don't clear, so
// the app always has a copy to fall back on — even right after an update, offline.
const DATA_CACHE = 'pokescan-data-v1';
// A data download slower than this (with a saved copy to use) gets the saved copy.
const DATA_TIMEOUT = 6000;
const IMG_MAX = 600;
const IMG_HOSTS = ['images.pokemontcg.io', 'images.scrydex.com'];

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

/* Data files: the network (revalidated, so updates show up), saved to DATA_CACHE; the saved copy
 * when the network fails, or is slow and there is one. */
async function dataFile(request) {
  const cache = await caches.open(DATA_CACHE);
  const saved = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (!saved) return network.catch(() => caches.match(request)); // older caches, else the error
  network.catch(() => {}); // a late failure after the saved copy was used isn't an error
  const slow = new Promise((resolve) => setTimeout(() => resolve(null), DATA_TIMEOUT));
  try {
    const res = await Promise.race([network, slow]);
    if (res && res.ok) return res;
    return saved.clone();
  } catch {
    return saved.clone();
  }
}

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
  if (url.pathname.includes('/data/')) {
    e.respondWith(dataFile(e.request));
    return;
  }
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
