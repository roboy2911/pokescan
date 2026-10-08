// Japanese card prices: TCGplayer's Japanese market prices (TCGCSV category 85) for the cards in
// data/cards-ja.json, written to data/prices-ja.json in the same row shape as prices.json
// ({ h, n, r, 1h, …, v: { label: usd }, p: productId }). Kept apart from prices.json so the
// English app doesn't download it until a Japanese card is shown.
// Run by tools/update-prices.mjs (daily); also on its own: node tools/prices-ja.mjs
import { readFile, writeFile } from 'node:fs/promises';

const TCGCSV = 'https://tcgcsv.com/tcgplayer/85';
const HEADERS = { 'User-Agent': 'PokeScan/1.0 (+https://github.com/roboy2911/pokescan)' };
const SUBTYPE = { Holofoil: 'h', Normal: 'n', 'Reverse Holofoil': 'r', '1st Edition Holofoil': '1h', '1st Edition': '1n' };
const dataFile = (name) => new URL(`../data/${name}`, import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(1000 * i);
  }
  return null;
}

export async function updateJapanesePrices() {
  const t0 = Date.now();
  const map = JSON.parse(await readFile(dataFile('ja-tcgmap.json'), 'utf8')).cards;
  const groups = (await getJson(`${TCGCSV}/groups`))?.results;
  if (!groups?.length) { console.warn('Japanese prices: TCGCSV groups unavailable, keeping the old file'); return; }

  // productId → [{ sub, usd }]
  const byProduct = new Map();
  const queue = [...groups];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const g = queue.shift();
      for (const p of (await getJson(`${TCGCSV}/${g.groupId}/prices`))?.results ?? []) {
        const usd = p.marketPrice ?? p.midPrice;
        if (usd == null) continue;
        if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
        byProduct.get(p.productId).push({ sub: p.subTypeName, usd });
      }
    }
  }));

  const cards = {};
  const one = (pid) => byProduct.get(pid)?.reduce((m, x) => Math.max(m, x.usd), -Infinity);
  for (const [id, finishes] of Object.entries(map)) {
    const row = {};
    for (const [finish, pid] of Object.entries(finishes)) {
      if (finish === 'base') {
        for (const { sub, usd } of byProduct.get(pid) ?? []) {
          const k = SUBTYPE[sub] ?? 'n';
          row[k] = Math.max(row[k] ?? 0, usd);
        }
        row.p = pid;
      } else if (finish === 'r' || finish === '1') {
        const usd = one(pid);
        if (usd > 0) row[finish === 'r' ? 'r' : '1h'] = usd;
      } else if (finish.startsWith('x:')) {
        const usd = one(pid);
        if (usd > 0) (row.v ??= {})[finish.slice(2)] = usd;
      }
    }
    if (Object.keys(row).some((k) => k !== 'p')) cards[id] = row;
  }
  if (Object.keys(cards).length < 5000) {
    console.warn(`Japanese prices: only ${Object.keys(cards).length} priced — keeping the old file`);
    return;
  }
  await writeFile(dataFile('prices-ja.json'), JSON.stringify({ built: new Date().toISOString(), currency: 'USD', cards }));
  console.log(`Wrote data/prices-ja.json: ${Object.keys(cards).length} Japanese cards (${Math.round((Date.now() - t0) / 1000)} s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await updateJapanesePrices();
