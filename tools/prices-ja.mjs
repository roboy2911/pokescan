// Japanese card prices: TCGplayer's Japanese market prices (TCGCSV category 85) for the cards in
// data/cards-ja.json, written to data/prices-ja.json in the same row shape as prices.json
// ({ h, n, r, 1h, …, v: { label: usd }, p: productId }). Kept apart from prices.json so the
// English app doesn't download it until a Japanese card is shown.
// Also Japanese sealed product (data/sealed-ja.json: { items: [{ id, name, set, setName, date,
// type, usd, lang: 'ja' }] }, set = the Japanese set id, or null for sealed-only groups) and
// the Market tab's Japanese lists (market.mjs with suffix '-ja').
// Run by tools/update-prices.mjs (daily); also on its own: node tools/prices-ja.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { sealedType } from './sealed-types.mjs';
import { updateMarket } from './market.mjs';

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

  // Card product → Japanese set id (to put a group's sealed product in its set).
  const setOfCard = new Map(JSON.parse(await readFile(dataFile('cards-ja.json'), 'utf8')).cards.map((r) => [r[0], r[3]]));
  const setOfProduct = new Map();
  for (const [id, finishes] of Object.entries(map)) for (const pid of Object.values(finishes)) setOfProduct.set(pid, setOfCard.get(id));

  // productId → [{ sub, usd }]
  const byProduct = new Map();
  const sealed = [];
  const queue = [...groups];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const g = queue.shift();
      const [prices, products] = await Promise.all([getJson(`${TCGCSV}/${g.groupId}/prices`), getJson(`${TCGCSV}/${g.groupId}/products`)]);
      for (const p of prices?.results ?? []) {
        const usd = p.marketPrice ?? p.midPrice;
        if (usd == null) continue;
        if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
        byProduct.get(p.productId).push({ sub: p.subTypeName, usd });
      }
      // Sealed: no card number, not a code card.
      const list = products?.results ?? [];
      const set = list.map((p) => setOfProduct.get(p.productId)).find(Boolean) ?? null;
      for (const prod of list) {
        const ext = prod.extendedData ?? [];
        if (ext.some((d) => d.name === 'Number' || d.name === 'Rarity') || /^code card/i.test(prod.name)) continue;
        const usd = byProduct.get(prod.productId)?.[0]?.usd;
        if (usd == null) continue;
        sealed.push({
          id: prod.productId,
          name: prod.name.replace(/\s+/g, ' ').trim(),
          set,
          setName: g.name.replace(/^[^:]+:\s*/, ''),
          date: (g.publishedOn || '').slice(0, 10).replace(/-/g, '/'),
          type: sealedType(prod.name),
          usd: Math.round(usd * 100) / 100,
          lang: 'ja',
        });
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
  const built = new Date().toISOString();
  await writeFile(dataFile('prices-ja.json'), JSON.stringify({ built, currency: 'USD', cards }));
  console.log(`Wrote data/prices-ja.json: ${Object.keys(cards).length} Japanese cards (${Math.round((Date.now() - t0) / 1000)} s)`);
  const sealedOk = sealed.length > 200;
  if (sealedOk) {
    sealed.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
    await writeFile(dataFile('sealed-ja.json'), JSON.stringify({ built, currency: 'USD', items: sealed }));
    console.log(`Wrote data/sealed-ja.json: ${sealed.length} Japanese sealed products`);
  } else {
    console.warn(`Japanese sealed: only ${sealed.length} found — keeping the old file`);
  }
  await updateMarket(cards, sealedOk ? sealed : null, { suffix: '-ja' });
}

if (import.meta.url === `file://${process.argv[1]}`) await updateJapanesePrices();
