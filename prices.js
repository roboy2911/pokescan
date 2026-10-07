/* Card prices: TCGplayer market prices (USD) converted to AUD.
 *
 * Prices come from data/prices.json, a daily snapshot of every card's TCGplayer prices
 * (built by tools/update-prices.mjs via GitHub Actions). Cards missing from it are looked
 * up live on pokemontcg.io (with retries — it often returns errors) and cached on the device.
 */

const PRICE_API = 'https://api.pokemontcg.io/v2/cards';
const PRICE_CACHE_KEY = 'pokescan.prices.v1';
const RATE_CACHE_KEY = 'pokescan.audRate.v1';
const PRICE_MAX_AGE = 12 * 3600 * 1000;
const RATE_MAX_AGE = 12 * 3600 * 1000;
const FALLBACK_AUD_RATE = 1.5;

/* TCGplayer finishes, in the order a card's "main" price is picked.
 * [api key, snapshot short key, label] — short keys match tools/update-prices.mjs. */
const VARIANTS = [
  ['holofoil', 'h', 'Holo'],
  ['normal', 'n', 'Normal'],
  ['1stEditionHolofoil', '1h', '1st Ed. Holo'],
  ['unlimitedHolofoil', 'uh', 'Unlimited Holo'],
  ['1stEditionNormal', '1n', '1st Edition'],
  ['unlimited', 'u', 'Unlimited'],
  ['reverseHolofoil', 'r', 'Reverse Holo'],
];

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function readCache(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/unavailable */ }
}

/* fetch → JSON, retrying (pokemontcg.io fails roughly 1 request in 4). */
async function fetchJsonRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleepMs(400 * (i + 1));
  }
  throw lastErr;
}

/* USD → AUD rate: { rate, date, approx }. */
let ratePromise = null;
function getAudRate() {
  const cached = readCache(RATE_CACHE_KEY);
  if (cached && Date.now() - cached.at < RATE_MAX_AGE) return Promise.resolve(cached);
  ratePromise ??= (async () => {
    const sources = [
      async () => {
        const j = await fetchJsonRetry('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD', 2);
        return { rate: j.rates.AUD, date: j.date };
      },
      async () => {
        const j = await fetchJsonRetry('https://open.er-api.com/v6/latest/USD', 2);
        return { rate: j.rates.AUD, date: (j.time_last_update_utc || '').slice(5, 16) };
      },
    ];
    for (const source of sources) {
      try {
        const r = await source();
        if (r.rate > 0.5 && r.rate < 5) {
          const value = { ...r, at: Date.now(), approx: false };
          writeCache(RATE_CACHE_KEY, value);
          return value;
        }
      } catch { /* try the next one */ }
    }
    // Offline: use the last known rate, or a rough fixed one.
    return cached ? { ...cached, approx: true } : { rate: FALLBACK_AUD_RATE, date: '', approx: true };
  })().finally(() => { ratePromise = null; });
  return ratePromise;
}

/* The daily snapshot (loaded once). */
let snapshotPromise = null;
function getSnapshot() {
  snapshotPromise ??= fetch('data/prices.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return snapshotPromise;
}

/* Extra printings TCGplayer sells as their own product (Poké Ball pattern, Master Ball
 * pattern, ...) are keyed 'x:<label>' — e.g. 'x:Poké Ball Pattern'. */
const EXTRA_PREFIX = 'x:';

/* Expand a snapshot row ({ h: 12.3, r: 4.5, v: { 'Poké Ball Pattern': 2.1 } }) into
 * TCGplayer-style prices. */
function expandRow(row) {
  const prices = {};
  for (const [key, short] of VARIANTS) if (row[short] != null) prices[key] = { market: row[short] };
  for (const [label, usd] of Object.entries(row.v || {})) prices[EXTRA_PREFIX + label] = { market: usd };
  return prices;
}

/* Live lookup of one card (used when the snapshot doesn't have it). */
async function livePrice(id) {
  const { data } = await fetchJsonRetry(`${PRICE_API}/${encodeURIComponent(id)}?select=id,tcgplayer`);
  return {
    prices: data.tcgplayer?.prices || null,
    url: data.tcgplayer?.url || '',
    updatedAt: data.tcgplayer?.updatedAt || '',
  };
}

/* TCGplayer data for card ids: { [id]: { prices, url, updatedAt } }. */
async function getTcgPrices(ids) {
  const snap = await getSnapshot();
  const cache = readCache(PRICE_CACHE_KEY) || {};
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const id of ids) {
    const row = snap?.cards?.[id];
    if (row) {
      out[id] = {
        prices: expandRow(row),
        url: row.p ? `https://www.tcgplayer.com/product/${row.p}` : `https://prices.pokemontcg.io/tcgplayer/${id}`,
        updatedAt: snap.tcgplayerUpdated || '',
      };
    } else if (cache[id] && now - cache[id].at < PRICE_MAX_AGE) {
      out[id] = cache[id];
    } else {
      missing.push(id);
    }
  }
  // Live lookups, 4 at a time.
  let changed = false;
  const queue = [...missing];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        out[id] = cache[id] = { at: now, ...(await livePrice(id)) };
        changed = true;
      } catch (err) {
        console.warn('Price lookup failed', id, err);
        if (cache[id]) out[id] = cache[id]; // stale is better than nothing
      }
    }
  }));
  if (changed) {
    const entries = Object.entries(cache);
    writeCache(PRICE_CACHE_KEY, entries.length > 2000
      ? Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, 1500))
      : cache);
  }
  return out;
}

/* The finishes a card has a price for: [{ key, label, usd }], main one first, then any
 * extra printings (pattern reverse holos etc.). */
function priceVariants(prices) {
  if (!prices) return [];
  const usdOf = (p) => p?.market ?? p?.mid;
  const out = VARIANTS
    .filter(([key]) => usdOf(prices[key]) != null)
    .map(([key, , label]) => ({ key, label, usd: usdOf(prices[key]) }));
  for (const [key, p] of Object.entries(prices)) {
    if (key.startsWith(EXTRA_PREFIX) && usdOf(p) != null) {
      out.push({ key, label: key.slice(EXTRA_PREFIX.length), usd: usdOf(p) });
    }
  }
  return out;
}

/* Display name of a finish key (also for keys with no price). */
function variantLabel(key) {
  if (!key) return '';
  if (key.startsWith(EXTRA_PREFIX)) return key.slice(EXTRA_PREFIX.length);
  return VARIANTS.find(([k]) => k === key)?.[2] ?? key;
}

const audFormat = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
function formatAud(usd, rate) {
  return audFormat.format(usd * rate);
}

/* ------------------------------------------------------------------ */
/* Sealed product                                                       */
/* ------------------------------------------------------------------ */

/* Australian RRP (AUD) by product type — the types tools/update-prices.mjs assigns.
 * Edit freely. Pack, bundle, ETB and booster box are the owner's current prices;
 * entries marked "estimate" are rough guesses to correct. Types left out (cases,
 * displays, "Other") have no single RRP. */
const SEALED_RRP_AUD = {
  'Booster Pack': 8.5,
  'Sleeved Booster Pack': 8.5,
  'Booster Bundle': 50,
  'Elite Trainer Box': 100,
  'Booster Box': 300,
  'Pokémon Center Elite Trainer Box': 130, // estimate
  'Booster Pack Art Bundle': 34, // estimate (4 packs)
  '2-Pack Blister': 20, // estimate
  '3-Pack Blister': 30, // estimate
  'Blister': 12, // estimate (1 pack + promo)
  'Mini Tin': 18, // estimate
  'Tin': 40, // estimate
  'Collection Box': 40, // estimate
  'Premium Collection': 80, // estimate
  'Super-Premium Collection': 150, // estimate
  'Ultra-Premium Collection': 250, // estimate
  'Build & Battle Box': 35, // estimate
  'Build & Battle Stadium': 90, // estimate
  'Deck': 30, // estimate
  'Surprise Box': 40, // estimate
};
const SEALED_RRP_ESTIMATE = new Set(Object.keys(SEALED_RRP_AUD)
  .filter((t) => !['Booster Pack', 'Sleeved Booster Pack', 'Booster Bundle', 'Elite Trainer Box', 'Booster Box'].includes(t)));

const sealedImage = (productId, size = 200) => `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_${size}w.jpg`;

/* data/sealed.json, loaded on first use: { items: [{ id, name, set, type, usd }] } with each
 * item also given key ('s' + id), kind 'sealed' and image. */
let sealedPromise = null;
function getSealed() {
  sealedPromise ??= fetch('data/sealed.json')
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .catch(() => ({ items: [] }))
    .then((j) => {
      const items = j.items.map((s) => ({ ...s, key: `s${s.id}`, kind: 'sealed', image: sealedImage(s.id) }));
      return { built: j.built, items, byKey: new Map(items.map((s) => [s.key, s])) };
    });
  return sealedPromise;
}

/* "+35% over RRP" / "12% under RRP" for a sealed product's market price, or null. */
function rrpCompare(type, usd, rate) {
  const rrp = SEALED_RRP_AUD[type];
  if (!rrp || usd == null) return null;
  const pct = Math.round(((usd * rate) / rrp - 1) * 100);
  return {
    rrp,
    estimate: SEALED_RRP_ESTIMATE.has(type),
    text: pct === 0 ? 'at RRP' : pct > 0 ? `+${pct}% over RRP` : `${-pct}% under RRP`,
    up: pct > 0,
  };
}

/* data/sets.json (logos/symbols per set id), loaded on first use. */
let setsInfoPromise = null;
function getSetsInfo() {
  setsInfoPromise ??= fetch('data/sets.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return setsInfoPromise;
}

/* data/market.json (movers and highs/lows), loaded when the Market tab opens. */
let marketPromise = null;
function getMarket() {
  marketPromise ??= fetch('data/market.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return marketPromise;
}
