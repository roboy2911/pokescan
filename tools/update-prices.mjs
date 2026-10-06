// Downloads TCGplayer market prices for every card from pokemontcg.io and writes
// data/prices.json, a compact snapshot the app reads instead of calling the API per card.
// Run daily by .github/workflows/prices.yml (Node 20+). Usage: node tools/update-prices.mjs
import { writeFile } from 'node:fs/promises';

const API = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;

// Finish names → short keys (the app's prices.js uses the same mapping).
const SHORT = {
  holofoil: 'h',
  normal: 'n',
  reverseHolofoil: 'r',
  '1stEditionHolofoil': '1h',
  '1stEditionNormal': '1n',
  unlimitedHolofoil: 'uh',
  unlimited: 'u',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pokemontcg.io returns occasional 500s, so retry generously.
async function getJson(url, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const headers = process.env.PTCG_API_KEY ? { 'X-Api-Key': process.env.PTCG_API_KEY } : {};
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
      console.warn(`HTTP ${res.status} (attempt ${i}) ${url}`);
    } catch (err) {
      console.warn(`${err.message} (attempt ${i}) ${url}`);
    }
    await sleep(1000 * i);
  }
  throw new Error(`Gave up on ${url}`);
}

const cards = {};
let total = Infinity;
let tcgUpdated = '';
for (let page = 1; (page - 1) * PAGE_SIZE < total; page++) {
  const json = await getJson(`${API}?page=${page}&pageSize=${PAGE_SIZE}&select=id,tcgplayer&orderBy=id`);
  total = json.totalCount;
  for (const c of json.data) {
    const prices = c.tcgplayer?.prices;
    if (!prices) continue;
    const row = {};
    for (const [key, p] of Object.entries(prices)) {
      const usd = p?.market ?? p?.mid;
      if (usd != null && SHORT[key]) row[SHORT[key]] = Math.round(usd * 100) / 100;
    }
    if (Object.keys(row).length) cards[c.id] = row;
    if (c.tcgplayer.updatedAt > tcgUpdated) tcgUpdated = c.tcgplayer.updatedAt;
  }
  console.log(`page ${page}: ${Object.keys(cards).length} priced so far (of ${total} cards)`);
}

// Sanity check before overwriting a good snapshot with a broken one.
if (Object.keys(cards).length < 10000) {
  throw new Error(`Only ${Object.keys(cards).length} cards priced — not writing.`);
}

const out = { built: new Date().toISOString(), tcgplayerUpdated: tcgUpdated, currency: 'USD', cards };
await writeFile(new URL('../data/prices.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote data/prices.json: ${Object.keys(cards).length} cards`);
