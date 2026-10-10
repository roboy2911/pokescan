// Downloads TCGplayer market prices for every card and writes data/prices.json, a compact
// snapshot the app reads instead of calling an API per card.
// Run daily by .github/workflows/prices.yml (Node 20+). Usage: node tools/update-prices.mjs
//
// Two sources, merged:
//   1. pokemontcg.io's API — TCGplayer prices per card id. Doesn't price the newest sets.
//   2. TCGCSV (tcgcsv.com) — a daily dump of TCGplayer itself, per set ("group"). Fills in
//      cards pokemontcg.io has no price for (e.g. 30th Celebration) and adds the extra
//      printings TCGplayer lists as their own products, like Poké Ball / Master Ball
//      pattern reverse holos. Matched to our card ids by set name and card number.
import { readFile, writeFile } from 'node:fs/promises';
import { updateMarket } from './market.mjs';
import { sealedType } from './sealed-types.mjs';

const API = 'https://api.pokemontcg.io/v2/cards';
const PAGE_SIZE = 250;
// pokemontcg.io can be slow and error-prone; stop asking it after this long (the Action has
// 30 minutes in all) and use TCGCSV and the previous snapshot for the rest.
const PTCG_BUDGET_MS = 8 * 60 * 1000;
const PTCG_PARALLEL = 6;
const SETS_URL = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json';
const CARDS_URL = (setId) => `https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/${setId}.json`;
const TCGCSV = 'https://tcgcsv.com/tcgplayer/3'; // 3 = Pokémon (English)

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
// TCGCSV's subTypeName → short key.
const SUBTYPE = {
  'Holofoil': 'h',
  'Normal': 'n',
  'Reverse Holofoil': 'r',
  '1st Edition Holofoil': '1h',
  '1st Edition': '1n',
  '1st Edition Normal': '1n',
  'Unlimited Holofoil': 'uh',
  'Unlimited': 'u',
  'Unlimited Normal': 'u',
};

// Our set id → TCGplayer group name, where the names don't line up on their own.
const GROUP_ALIASES = {
  base1: 'Base Set',
  sm1: 'SM Base Set',
  sv3pt5: 'SV: Scarlet & Violet 151',
  basep: 'WoTC Promo',
  bp: 'Best of Promos',
  dpp: 'Diamond and Pearl Promos',
  bwp: 'Black and White Promos',
  swshp: 'SWSH: Sword & Shield Promo Cards',
  ru1: 'Rumble',
  tk1a: 'EX Trainer Kit 1: Latias & Latios',
  tk1b: 'EX Trainer Kit 1: Latias & Latios',
  tk2a: 'EX Trainer Kit 2: Plusle & Minun',
  tk2b: 'EX Trainer Kit 2: Plusle & Minun',
  mcd21: "McDonald's 25th Anniversary Promos",
  ...Object.fromEntries([11, 12, 14, 15, 16, 17, 18, 19, 22].map((y) => [`mcd${y}`, `McDonald's Promos 20${y}`])),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (usd) => Math.round(usd * 100) / 100;

// TCGCSV blocks generic user agents (like Node's default), so name the app.
const USER_AGENT = 'PokeScan/1.0 (+https://github.com/roboy2911/pokescan)';

// Both APIs return occasional errors, so retry generously.
async function getJson(url, { attempts = 8, headers = {} } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
      if (res.ok) return await res.json();
      console.warn(`HTTP ${res.status} (attempt ${i}) ${url}`);
    } catch (err) {
      console.warn(`${err.message} (attempt ${i}) ${url}`);
    }
    await sleep(1000 * i);
  }
  throw new Error(`Gave up on ${url}`);
}

/* Run `fn` over `items`, `n` at a time. */
async function eachLimit(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/* ------------------------------------------------------------------ */
/* Source 1: pokemontcg.io                                             */
/* ------------------------------------------------------------------ */

async function fromPokemonTcg(cards) {
  const headers = process.env.PTCG_API_KEY ? { 'X-Api-Key': process.env.PTCG_API_KEY } : {};
  const url = (page) => `${API}?page=${page}&pageSize=${PAGE_SIZE}&select=id,tcgplayer&orderBy=id`;
  let updated = '';
  const add = (json) => {
    for (const c of json.data) {
      const prices = c.tcgplayer?.prices;
      if (!prices) continue;
      const row = {};
      for (const [key, p] of Object.entries(prices)) {
        const usd = p?.market ?? p?.mid;
        if (usd != null && SHORT[key]) row[SHORT[key]] = cents(usd);
      }
      if (Object.keys(row).length) cards[c.id] = row;
      if (c.tcgplayer.updatedAt > updated) updated = c.tcgplayer.updatedAt;
    }
  };
  const deadline = Date.now() + PTCG_BUDGET_MS;
  // Page 1 gives the total; the rest are fetched several at a time.
  const first = await getJson(url(1), { headers, attempts: 5 });
  add(first);
  const pages = Array.from({ length: Math.ceil(first.totalCount / PAGE_SIZE) - 1 }, (_, i) => i + 2);
  let done = 1;
  await eachLimit(pages, PTCG_PARALLEL, async (page) => {
    if (Date.now() > deadline) {
      console.warn(`pokemontcg.io: out of time, skipped page ${page}`);
      return;
    }
    try {
      add(await getJson(url(page), { headers, attempts: 5 }));
      console.log(`pokemontcg.io: ${++done}/${pages.length + 1} pages, ${Object.keys(cards).length} priced`);
    } catch (err) {
      console.warn(`pokemontcg.io: skipped page ${page} (${err.message})`);
    }
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/* Source 2: TCGCSV                                                    */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// "SV08.5: Prismatic Evolutions", "XY - Flashfire" → the name without the code prefix.
const groupBaseName = (name) => name.replace(/^[A-Z0-9.&]{1,10}\s*(:|\s[-–—])\s*/i, '');

// Looser key for names that differ in wording: "SWSH01: Sword & Shield Base Set" and
// "Sword & Shield", "XY Black Star Promos" and "XY Promos", "HS—Unleashed" and "Unleashed".
function looseKey(name) {
  const k = norm(groupBaseName(name))
    .replace(/baseset$/, '').replace(/blackstar/, '').replace(/promo(s|cards)$/, 'promo')
    .replace(/^(ex|hs)(?=[a-z]{4})/, '').replace(/and/g, '');
  return k.length >= 2 ? k : null;
}

// "001/128", "TG01/TG30", "025" → "1", "TG1", "25" (our card numbers have no padding).
const normNumber = (n) => String(n ?? '').split('/')[0].trim().toUpperCase()
  .replace(/^([A-Z]*)0+(?=\d)/, '$1');

// "Eevee (Poke Ball Pattern)" → ['Eevee', 'Poke Ball Pattern']; "Pikachu - 025/165" → ['Pikachu', ''].
function splitProductName(name) {
  const dropNumber = (s) => s.replace(/\s+-\s+[A-Z]*\d+[A-Z]*(\/[A-Z]*\d+)?\s*$/i, '');
  let base = dropNumber(name);
  let extra = '';
  const m = base.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) [, base, extra] = m;
  return [dropNumber(base).trim(), extra.trim()];
}

const prettyLabel = (s) => s.replace(/\bPoke\b/g, 'Poké').replace(/\bPokemon\b/g, 'Pokémon');


/* Release calendar: sets coming out soon or released in the last RELEASE_WINDOW_DAYS, with
 * their sealed products (each product's own release date from TCGplayer's presale info). */
const RELEASE_WINDOW_DAYS = 45;
async function fetchReleases(groups, pairs, headers) {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - RELEASE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const setOf = new Map(pairs.map((p) => [p.group.groupId, p.set]));
  const recent = groups.filter((g) => (g.publishedOn || '').slice(0, 10) >= since);
  const out = [];
  await eachLimit(recent, 4, async (g) => {
    const set = setOf.get(g.groupId);
    const date = g.publishedOn.slice(0, 10);
    let products, prices;
    try {
      [{ results: products }, { results: prices }] = await Promise.all([
        getJson(`${TCGCSV}/${g.groupId}/products`, { headers, attempts: 3 }),
        getJson(`${TCGCSV}/${g.groupId}/prices`, { headers, attempts: 3 }),
      ]);
    } catch (err) {
      console.warn(`  releases: skipped ${g.name}: ${err.message}`);
      return;
    }
    const usdOf = new Map();
    for (const p of prices) if (!usdOf.has(p.productId)) usdOf.set(p.productId, p.marketPrice ?? p.midPrice ?? null);
    const items = products
      .filter((prod) => !(prod.extendedData ?? []).some((d) => d.name === 'Number' || d.name === 'Rarity') && !/^code card/i.test(prod.name))
      .map((prod) => ({
        id: prod.productId,
        name: prod.name.replace(/\s+/g, ' ').trim(),
        type: sealedType(prod.name),
        date: prod.presaleInfo?.releasedOn?.slice(0, 10) || date,
        presale: !!prod.presaleInfo?.isPresale,
        usd: usdOf.get(prod.productId) != null ? cents(usdOf.get(prod.productId)) : null,
      }))
      .filter((p) => p.type !== 'Case');
    // Real releases only: still to come, on presale, or a set of ours released recently.
    // (Old groups TCGplayer re-dated, like the POP series, have none of these.)
    const upcoming = date > today || items.some((p) => p.presale);
    const recentSet = set && (set.releaseDate || '').replace(/\//g, '-') >= since;
    if (!items.length || (!upcoming && !recentSet) || (g.isSupplemental && !set)) return;
    out.push({ name: groupBaseName(g.name), set: set?.id ?? null, date, products: items });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

async function fromTcgcsv(cards, sealed, setsOut, releasesOut) {
  const headers = { 'User-Agent': 'PokeScan price snapshot (github.com/roboy2911/pokescan)' };
  const [{ results: groups }, sets] = await Promise.all([
    getJson(`${TCGCSV}/groups`, { headers }),
    getJson(SETS_URL),
  ]);
  console.log(`TCGCSV: ${groups.length} groups, ${sets.length} of our sets`);
  for (const set of sets) setsOut[set.id] = { logo: set.images?.logo || '', symbol: set.images?.symbol || '' };

  // Match our sets to TCGplayer groups: exact name, then looser name, then set code
  // (only where the code is unique on both sides).
  const exact = new Map();
  const loose = new Map();
  for (const g of groups) {
    for (const key of [norm(g.name), norm(groupBaseName(g.name))]) if (!exact.has(key)) exact.set(key, g);
    const lk = looseKey(g.name);
    if (lk && !loose.has(lk)) loose.set(lk, g);
  }
  const countBy = (items, f) => items.reduce((m, x) => (f(x) ? m.set(f(x), (m.get(f(x)) || 0) + 1) : m), new Map());
  const groupCodes = countBy(groups, (g) => g.abbreviation?.toUpperCase());
  const setCodes = countBy(sets, (s) => s.ptcgoCode?.toUpperCase());
  const pairs = [];
  const unmatchedSets = [];
  const taken = new Set();
  for (const set of sets) {
    const name = GROUP_ALIASES[set.id] ?? set.name;
    const code = set.ptcgoCode?.toUpperCase();
    const g = exact.get(norm(name)) ?? exact.get(norm(groupBaseName(name))) ?? loose.get(looseKey(name))
      ?? (code && setCodes.get(code) === 1 && groupCodes.get(code) === 1
        ? groups.find((x) => x.abbreviation?.toUpperCase() === code) : null);
    if (g) {
      pairs.push({ set, group: g });
      taken.add(g.groupId);
    } else {
      unmatchedSets.push(set);
    }
  }
  console.log(`TCGCSV: matched ${pairs.length} sets to groups`);
  console.log(`  sets with no group: ${unmatchedSets.map((s) => `${s.id} "${s.name}" (${s.ptcgoCode || '-'})`).join(', ') || 'none'}`);
  const unmatchedGroups = groups.filter((g) => !taken.has(g.groupId))
    .map((g) => `"${g.name}" (${g.abbreviation || '-'})`);
  console.log(`  groups with no set: ${unmatchedGroups.join(', ') || 'none'}`);

  let filled = 0;
  let extras = 0;
  await eachLimit(pairs, 4, async ({ set, group }) => {
    let ourCards, products, prices;
    try {
      [ourCards, { results: products }, { results: prices }] = await Promise.all([
        getJson(CARDS_URL(set.id), { attempts: 4 }),
        getJson(`${TCGCSV}/${group.groupId}/products`, { headers, attempts: 4 }),
        getJson(`${TCGCSV}/${group.groupId}/prices`, { headers, attempts: 4 }),
      ]);
    } catch (err) {
      console.warn(`  skipped ${set.id}: ${err.message}`);
      return;
    }
    const pricesById = new Map();
    for (const p of prices) {
      const usd = p.marketPrice ?? p.midPrice;
      if (usd == null) continue;
      if (!pricesById.has(p.productId)) pricesById.set(p.productId, []);
      pricesById.get(p.productId).push({ sub: p.subTypeName, usd });
    }
    // Sealed product: no card number, not a code card.
    for (const prod of products) {
      const ext = prod.extendedData ?? [];
      if (ext.some((d) => d.name === 'Number' || d.name === 'Rarity') || /^code card/i.test(prod.name)) continue;
      const usd = pricesById.get(prod.productId)?.[0]?.usd;
      if (usd == null || sealed.has(prod.productId)) continue;
      sealed.set(prod.productId, {
        id: prod.productId,
        name: prod.name.replace(/\s+/g, ' ').trim(),
        set: set.id,
        type: sealedType(prod.name),
        usd: cents(usd),
      });
    }

    const productsByNumber = new Map();
    for (const prod of products) {
      const number = prod.extendedData?.find((d) => d.name === 'Number')?.value;
      if (!number || !pricesById.has(prod.productId)) continue;
      const key = normNumber(number);
      if (!productsByNumber.has(key)) productsByNumber.set(key, []);
      productsByNumber.get(key).push(prod);
    }

    for (const card of ourCards) {
      const candidates = productsByNumber.get(normNumber(card.number)) ?? [];
      if (!candidates.length) continue;
      const cardName = norm(card.name);
      const split = candidates.map((prod) => {
        const [base, extra] = splitProductName(prod.name);
        return { prod, base: norm(base), full: norm(prod.name), extra };
      });
      // The plain printing: same name as our card (or the only product with this number).
      const main = split.find((s) => s.full === cardName)
        ?? split.find((s) => s.base === cardName && !s.extra)
        ?? (split.length === 1 && (split[0].base === cardName || !split[0].extra) ? split[0] : null);
      // Extra printings: "<our name> (<something>)".
      const variants = split.filter((s) => s !== main && s.base === cardName && s.extra);
      if (!main && !variants.length) continue;

      const row = cards[card.id] ?? {};
      const hadPrice = Object.keys(row).length > 0;
      if (main) {
        for (const { sub, usd } of pricesById.get(main.prod.productId)) {
          const short = SUBTYPE[sub];
          if (short && row[short] == null) row[short] = cents(usd); // pokemontcg.io wins if it has one
        }
        row.p = main.prod.productId;
      }
      for (const v of variants) {
        const vp = pricesById.get(v.prod.productId);
        const label = prettyLabel(v.extra);
        row.v ??= {};
        // One finish is normal for these; if there are several, name each.
        for (const { sub, usd } of vp) {
          row.v[vp.length > 1 ? `${label} ${sub}` : label] = cents(usd);
          extras++;
        }
      }
      if (Object.keys(row).some((k) => k !== 'p')) {
        if (!hadPrice) filled++;
        cards[card.id] = row;
      }
    }
  });
  console.log(`TCGCSV: priced ${filled} more cards, added ${extras} extra printings, ${sealed.size} sealed products`);
  try {
    releasesOut.push(...await fetchReleases(groups, pairs, headers));
    console.log(`Releases: ${releasesOut.map((r) => `${r.name} (${r.date})`).join(', ') || 'none'}`);
  } catch (err) {
    console.warn(`Releases failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */

const SNAPSHOT = new URL('../data/prices.json', import.meta.url);
const dataFile = (name) => new URL(`../data/${name}`, import.meta.url);
const cards = {};
const sealed = new Map();
const setsInfo = {};
const releases = [];
let tcgUpdated = '';
try {
  tcgUpdated = await fromPokemonTcg(cards);
} catch (err) {
  console.warn(`pokemontcg.io failed: ${err.message}`);
}
try {
  await fromTcgcsv(cards, sealed, setsInfo, releases);
} catch (err) {
  console.warn(`TCGCSV failed: ${err.message}`);
}

// Cards no source priced today (an API having a bad day) keep their last known price.
let carried = 0;
try {
  const previous = JSON.parse(await readFile(SNAPSHOT, 'utf8')).cards || {};
  for (const [id, row] of Object.entries(previous)) {
    if (!cards[id]) {
      cards[id] = row;
      carried++;
    }
  }
} catch (err) {
  console.warn(`No previous snapshot to fall back on: ${err.message}`);
}
console.log(`Kept yesterday's price for ${carried} cards not priced today`);

// Sanity check before overwriting a good snapshot with a broken one.
if (Object.keys(cards).length < 10000) {
  throw new Error(`Only ${Object.keys(cards).length} cards priced — not writing.`);
}

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
const out = { built: new Date().toISOString(), tcgplayerUpdated: tcgUpdated || today, currency: 'USD', cards };
await writeFile(SNAPSHOT, JSON.stringify(out));
console.log(`Wrote data/prices.json: ${Object.keys(cards).length} cards`);

// Sealed product and set logos (only replaced when TCGCSV worked today).
if (sealed.size > 500) {
  const items = [...sealed.values()].sort((a, b) => a.set.localeCompare(b.set) || a.name.localeCompare(b.name));
  await writeFile(dataFile('sealed.json'), JSON.stringify({ built: out.built, currency: 'USD', items }));
  console.log(`Wrote data/sealed.json: ${items.length} products`);
}
if (Object.keys(setsInfo).length) await writeFile(dataFile('sets.json'), JSON.stringify(setsInfo));
if (releases.length) await writeFile(dataFile('releases.json'), JSON.stringify({ built: out.built, currency: 'USD', releases }));

await updateMarket(cards, sealed.size > 500 ? [...sealed.values()] : null);

// Japanese cards (data/prices-ja.json). A failure here must never cost the English prices.
try {
  const { updateJapanesePrices } = await import('./prices-ja.mjs');
  await updateJapanesePrices();
} catch (err) {
  console.warn(`Japanese prices skipped: ${err.message}`);
}
