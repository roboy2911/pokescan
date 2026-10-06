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

/* Expand a snapshot row ({ h: 12.3, r: 4.5 }) into TCGplayer-style prices. */
function expandRow(row) {
  const prices = {};
  for (const [key, short] of VARIANTS) if (row[short] != null) prices[key] = { market: row[short] };
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
        url: `https://prices.pokemontcg.io/tcgplayer/${id}`,
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

/* The finishes a card has a price for: [{ key, label, usd }], main one first. */
function priceVariants(prices) {
  if (!prices) return [];
  return VARIANTS
    .filter(([key]) => prices[key] && (prices[key].market ?? prices[key].mid) != null)
    .map(([key, , label]) => ({ key, label, usd: prices[key].market ?? prices[key].mid }));
}

const audFormat = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
function formatAud(usd, rate) {
  return audFormat.format(usd * rate);
}
