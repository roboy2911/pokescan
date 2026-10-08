// Builds the Japanese card list: data/cards-ja.json (same row shape as data/cards.json) and
// data/ja-tcgmap.json (TCGplayer product ids per card and finish, for the price builder).
//
// Sources:
//   TCGCSV (tcgcsv.com, category 85 "Pokemon Japan"): TCGplayer's Japanese catalogue — the main
//   source: every set it sells, each card's English name, number, rarity and photo, and the
//   printings it prices separately (e.g. Mirror Foil = reverse holo).
//   TCGdex (api.tcgdex.net/v2/ja): adds the Japanese name (and a scan when TCGplayer has no
//   photo) for sets it covers. Its Japanese data is incomplete (many sets have no card list).
// Matched by set code (TCGCSV group abbreviation "SV8a" ↔ TCGdex "SV8a") and card number.
//
// Rows: [id, name, number, setId, rarity, image, japaneseName]. Ids and set ids are prefixed
// "ja:" so they can't clash with English ones. Sets: id → [name, series, total, releaseDate,
// 'ja', japaneseName].
//
//   node tools/build-ja.mjs
import { writeFile } from 'node:fs/promises';

const TCGDEX = 'https://api.tcgdex.net/v2/ja';
const TCGCSV = 'https://tcgcsv.com/tcgplayer/85';
const CONCURRENCY = 8;
const TCGPLAYER_IMG = 'https://tcgplayer-cdn.tcgplayer.com/product/';
// TCGCSV blocks generic user agents; name the app (their usage guidelines ask for this).
const HEADERS = { 'User-Agent': 'PokeScan/1.0 (+https://github.com/roboy2911/pokescan)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (i + 1 >= tries) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * (i + 1));
    }
  }
}
async function mapLimit(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const stripZeros = (n) => String(n).replace(/^0+(?=\d)/, '');
// "Budew (Mirror Foil) - 001/187" → finish key and plain English name.
function parseProduct(p) {
  const ext = Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value]));
  const number = ext.Number;
  if (!number) return null; // sealed product, not a card
  const variant = (p.name.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
  let finish = 'base';
  if (/mirror|reverse/i.test(variant)) finish = /master ball|poke ball|pokéball|pokeball/i.test(variant) ? `x:${variant}` : 'r';
  else if (/1st edition/i.test(variant)) finish = '1';
  else if (variant && !/^\d+$/.test(variant)) finish = `x:${variant}`;
  const name = p.name.replace(/\s*-\s*[\w/-]+\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const rarity = /^none$/i.test(ext.Rarity || '') ? '' : ext.Rarity || '';
  return { number: number.split('/')[0], finish, name, rarity, productId: p.productId };
}

// Series from the set code ("SV8a" → Scarlet & Violet), for grouping in the Sets tab.
const SERIES = [
  [/^(m\d|ma|mb|mc|m[a-z]?\d?[a-z]?$)/i, 'Mega'], [/^sv/i, 'Scarlet & Violet'], [/^sm/i, 'Sun & Moon'],
  [/^s\d|^s[a-z]/i, 'Sword & Shield'], [/^(xy|cp)/i, 'XY'], [/^bw/i, 'Black & White'],
  [/^(l\d|ll)/i, 'HeartGold & SoulSilver'], [/^(dp|pt)/i, 'Diamond & Pearl'],
  [/^(pcg|adv)/i, 'EX'], [/^(e\d|vs|web)/i, 'e-Card'], [/^(neo|pmcg)/i, 'Original'],
];
const seriesOf = (code, name) => (SERIES.find(([re]) => re.test(code)) ?? [null, /promo/i.test(name) ? 'Promos' : 'Other'])[1];

console.time('build-ja');
const [groupsRes, dexSets] = await Promise.all([getJson(`${TCGCSV}/groups`), getJson(`${TCGDEX}/sets`).catch(() => [])]);
const dexById = new Map((dexSets || []).map((d) => [d.id.toLowerCase(), d]));

const sets = {};
const cards = [];
const tcgmap = {};
let withDex = 0, withImage = 0, setsWithCards = 0;
const usedSetIds = new Set();
await mapLimit(groupsRes.results, async (g) => {
  const products = (await getJson(`${TCGCSV}/${g.groupId}/products`))?.results || [];
  const byNumber = new Map(); // "1" → { number, name, rarity, total, finishes: { base: pid, r: pid, ... } }
  for (const p of products) {
    const x = parseProduct(p);
    if (!x) continue;
    const key = stripZeros(x.number);
    const e = byNumber.get(key) ?? { number: x.number, name: x.name, rarity: x.rarity, finishes: {} };
    e.finishes[x.finish] ??= x.productId;
    if (x.finish === 'base') { e.name = x.name; e.rarity = x.rarity || e.rarity; e.number = x.number; }
    byNumber.set(key, e);
  }
  if (!byNumber.size) return; // sealed-only group
  setsWithCards++;
  let code = (g.abbreviation || '').trim() || `g${g.groupId}`;
  if (usedSetIds.has(code.toLowerCase())) code = `${code}-${g.groupId}`;
  usedSetIds.add(code.toLowerCase());
  const setId = `ja:${code}`;

  // Japanese names / scans from TCGdex for the sets it covers.
  const dexMeta = dexById.get(code.toLowerCase());
  const dex = dexMeta ? await getJson(`${TCGDEX}/sets/${encodeURIComponent(dexMeta.id)}`).catch(() => null) : null;
  const dexByNumber = new Map((dex?.cards || []).map((c) => [stripZeros(c.localId), c]));

  const name = g.name.replace(/^[^:]+:\s*/, '');
  // TCGdex has the real release date; TCGplayer's is when it listed the set.
  const date = (dex?.releaseDate || g.publishedOn || '').slice(0, 10).replace(/-/g, '/');
  for (const [key, e] of byNumber) {
    const id = `${setId}-${key.replace(/[^\w.-]+/g, "_")}`;
    const d = dexByNumber.get(key);
    if (d) withDex++;
    const image = e.finishes.base || Object.values(e.finishes)[0];
    const img = image ? `${TCGPLAYER_IMG}${image}_400w.jpg` : d?.image ? `${d.image}/low.png` : '';
    if (img) withImage++;
    tcgmap[id] = e.finishes;
    cards.push([id, e.name, key, setId, e.rarity, img, d?.name || '']);
  }
  // Printed set size: the "/187" most cards carry.
  const counts = new Map();
  for (const p of products) {
    const n = (p.extendedData || []).find((x) => x.name === 'Number')?.value || '';
    const t = n.split('/')[1];
    if (t && /^\d+$/.test(t)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const printed = Number([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || 0) || byNumber.size;
  sets[setId] = [name, seriesOf(code, g.name), printed, date, 'ja', dex?.name || ''];
});
cards.sort((a, b) => (a[3] === b[3] ? a[2].localeCompare(b[2], undefined, { numeric: true }) : a[3].localeCompare(b[3])));

const built = new Date().toISOString();
await writeFile(new URL('../data/cards-ja.json', import.meta.url),
  JSON.stringify({ version: 1, built, lang: 'ja', count: cards.length, sets, cards }));
await writeFile(new URL('../data/ja-tcgmap.json', import.meta.url), JSON.stringify({ built, cards: tcgmap }));
console.timeEnd('build-ja');
console.log(`Japanese: ${Object.keys(sets).length} sets with cards (of ${groupsRes.results.length} TCGplayer groups), `
  + `${cards.length} cards (${withImage} with a picture, ${withDex} with a Japanese name from TCGdex)`);
