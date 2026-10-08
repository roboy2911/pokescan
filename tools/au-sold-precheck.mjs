// Nightly AU sold pre-check: looks up the Australian sold price (eBay.com.au, Australian
// sellers, last 90 days) of every single worth at least MIN_AUD on TCGplayer, a share each
// night so each one is re-checked about every REFRESH_DAYS. Results go to data/au-sold.json,
// which the app reads, so those cards open with their AU sold price instantly (and offline).
//
// Run by .github/workflows/au-sold.yml with the SoldComps key in the SOLDCOMPS_API_KEY secret.
//   BUDGET=270        searches tonight (default: list size / REFRESH_DAYS)
//   MIN_AUD=50        cheapest card (per finish) to pre-check
//   DRY_RUN=1         print what would be checked, no searches
//
// data/au-sold.json: { asOf, minAud, items: { "<query>|<number>": [aud, sales, low, high, date] |
//   [null, 0, null, null, date] (too few sales) } } — keys match the app's AU sold cache keys.
import { readFile, writeFile } from 'node:fs/promises';
import { summarise, OTHER_LANG, SOLDCOMPS_PARAMS } from './au-sold-filter.mjs';

const MIN_AUD = Number(process.env.MIN_AUD) || 50;
const REFRESH_DAYS = 14;
const KEEP_DAYS = 45; // drop answers older than this (cards that fell under MIN_AUD)
const CONCURRENCY = 6;
const DRY_RUN = !!process.env.DRY_RUN;

const dataFile = (name) => new URL(`../data/${name}`, import.meta.url);
const readJson = async (name, fallback) => {
  try { return JSON.parse(await readFile(dataFile(name), 'utf8')); } catch { return fallback; }
};
const today = new Date().toISOString().slice(0, 10);
const ageDays = (d) => (Date.parse(today) - Date.parse(d)) / 86400000;

// Same as the app's ebaySoldQuery (app.js) — keep the two in step.
const EBAY_FINISH_WORDS = { reverseHolofoil: 'reverse holo', '1stEditionHolofoil': '1st edition', '1stEditionNormal': '1st edition' };
function ebaySoldQuery(card, variant) {
  const raw = String(card.number);
  const coded = /^[A-Z]/i.test(raw) || /promo/i.test(card.setName || '');
  const digits = raw.replace(/^0+(?=\d)/, '');
  const num = !coded && (card.releaseDate || '') >= '2020' && /^\d+$/.test(digits) ? digits.padStart(3, '0') : digits;
  const total = num !== digits ? String(card.setTotal).padStart(3, '0') : card.setTotal;
  const n = coded || !card.setTotal ? raw : `${num}/${total}`;
  let q = `${card.name} ${n}`;
  const finish = variant?.startsWith('x:') ? variant.slice(2).replace(/\bPattern\b/i, '').trim() : EBAY_FINISH_WORDS[variant];
  if (finish) q += ` ${finish}`;
  return { q: q.replace(/\s+/g, ' ').trim(), n };
}
const cacheKey = (q, n) => `${q.toLowerCase()}|${(n || '').toLowerCase()}`;

async function audRate() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD');
    const rate = (await r.json()).rates?.AUD;
    if (rate > 0.5 && rate < 5) return rate;
  } catch { /* fall back */ }
  return 1.5;
}

// Every card + finish (one search per distinct query) worth at least MIN_AUD.
function targets(cardsMeta, prices, rate) {
  const list = new Map();
  for (const [id, name, number, setId] of cardsMeta.cards) {
    const row = prices[id];
    if (!row) continue;
    const [setName, , setTotal, releaseDate] = cardsMeta.sets[setId] ?? [];
    const card = { name, number, setName, setTotal, releaseDate };
    const add = (variant, usd) => {
      if (usd == null || usd * rate < MIN_AUD) return;
      const { q, n } = ebaySoldQuery(card, variant);
      const key = cacheKey(q, n);
      const aud = usd * rate;
      if (!list.has(key) || list.get(key).aud < aud) list.set(key, { key, q, n, aud, id });
    };
    // Holo / normal / unlimited share one search (no finish word); the rest have their own.
    const plain = ['h', 'n', 'u', 'uh'].map((k) => row[k]).filter((v) => v != null);
    if (plain.length) add(null, Math.max(...plain));
    add('1stEditionHolofoil', row['1h'] ?? row['1n']);
    add('reverseHolofoil', row.r);
    for (const [label, usd] of Object.entries(row.v || {})) add(`x:${label}`, usd);
  }
  return [...list.values()];
}

async function lookup(t) {
  const url = new URL('https://api.sold-comps.com/v1/scrape');
  url.search = new URLSearchParams({ keyword: t.q, ...SOLDCOMPS_PARAMS });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SOLDCOMPS_API_KEY}` } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.fatal = [401, 402, 403, 429].includes(res.status); // bad key, out of credits, rate limited
    throw err;
  }
  const body = await res.json();
  return summarise(body.items || [], t.n, OTHER_LANG.test(t.q), t.q);
}

const [cardsMeta, pricesFile, store] = await Promise.all([
  readJson('cards.json', null), readJson('prices.json', null), readJson('au-sold.json', { items: {} }),
]);
if (!cardsMeta || !pricesFile) throw new Error('cards.json / prices.json missing');
const rate = await audRate();
const all = targets(cardsMeta, pricesFile.cards, rate);
for (const [k, v] of Object.entries(store.items)) if (ageDays(v[4]) > KEEP_DAYS) delete store.items[k];

// Never checked first (most valuable first), then the oldest answers.
const due = all.filter((t) => !store.items[t.key] || ageDays(store.items[t.key][4]) >= REFRESH_DAYS)
  .sort((a, b) => (store.items[a.key]?.[4] ?? '').localeCompare(store.items[b.key]?.[4] ?? '') || b.aud - a.aud);
const budget = Number(process.env.BUDGET) || Math.ceil(all.length / REFRESH_DAYS);
const tonight = due.slice(0, budget);
console.log(`AU sold pre-check: ${all.length} singles ≥ A$${MIN_AUD} (rate ${rate}), ${due.length} due, checking ${tonight.length}`);
if (DRY_RUN) {
  for (const t of tonight.slice(0, 15)) console.log(`  A$${t.aud.toFixed(0)}  ${t.q}`);
  process.exit(0);
}
if (!process.env.SOLDCOMPS_API_KEY) throw new Error('SOLDCOMPS_API_KEY is not set');

let done = 0, priced = 0, failed = 0, stop = null;
const queue = [...tonight];
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length && !stop) {
    const t = queue.shift();
    try {
      const r = await lookup(t);
      store.items[t.key] = r.ok ? [r.aud, r.n, r.low, r.high, today] : [null, r.n ?? 0, null, null, today];
      done++;
      if (r.ok) priced++;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.q}: ${err.message}`);
      if (err.fatal) stop = err.message;
    }
  }
}));
store.asOf = today;
store.minAud = MIN_AUD;
await writeFile(dataFile('au-sold.json'), JSON.stringify(store));
console.log(`Checked ${done} (${priced} priced, ${done - priced} too few sales), ${failed} failed, `
  + `${Math.round((Date.now() - started) / 1000)} s. File holds ${Object.keys(store.items).length}.`);
if (stop) console.log(`Stopped early: ${stop}`);
