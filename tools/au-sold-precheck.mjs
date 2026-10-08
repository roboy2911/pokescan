// Nightly AU sold pre-check: looks up the Australian sold price (eBay.com.au, Australian
// sellers, last 90 days) of every single worth at least MIN_AUD on TCGplayer, a share each
// night so each one is re-checked about every REFRESH_DAYS. Results go to data/au-sold.json,
// which the app reads, so those cards open with their AU sold price instantly (and offline).
//
// Run by .github/workflows/au-sold.yml with the SoldComps key in the SOLDCOMPS_API_KEY secret.
//   BUDGET=270        searches tonight (default: list size / REFRESH_DAYS)
//   MIN_AUD=50        cheapest card (per finish) to pre-check
//   RATE=60           searches started per minute (default: 6 at a time, unpaced)
//   DRY_RUN=1         print what would be checked, no searches
//
// data/au-sold.json: { asOf, minAud, items: { "<query>|<number>": [aud, sales, low, high, date] |
//   [null, 0, null, null, date] (too few sales) } } — keys match the app's AU sold cache keys.
import { readFile, writeFile } from 'node:fs/promises';
import { summarise, ebayKeyword, OTHER_LANG, SOLDCOMPS_PARAMS } from './au-sold-filter.mjs';

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
// card.printed: for a Classic Collection reprint, the original it copies (its number is printed).
function ebaySoldQuery(card, variant) {
  const printed = card.printed ?? card;
  const raw = String(printed.number);
  const coded = /^[A-Z]/i.test(raw) || /promo/i.test(printed.setName || '');
  const digits = raw.replace(/^0+(?=\d)/, '');
  const num = !coded && (printed.releaseDate || '') >= '2020' && /^\d+$/.test(digits) ? digits.padStart(3, '0') : digits;
  const total = num !== digits ? String(printed.setTotal).padStart(3, '0') : printed.setTotal;
  const n = coded || !printed.setTotal ? raw : `${num}/${total}`;
  // Sellers write "Gold Star", not ★ (and often leave out δ).
  let q = `${card.name.replace(/★/g, ' Gold Star').replace(/δ/g, '')} ${n}`;
  const finish = variant?.startsWith('x:') ? variant.slice(2).replace(/\bPattern\b/i, '').trim() : EBAY_FINISH_WORDS[variant];
  if (finish) q += ` ${finish}`;
  return { q: q.replace(/\s+/g, ' ').trim(), n, t: card.t || '' };
}
const cacheKey = (q, n, t = '') => `${q.toLowerCase()}|${(n || '').toLowerCase()}${t ? `|${t}` : ''}`;

// Classic Collection reprints ↔ the originals they copy (same as reprintInfo in app.js).
const REPRINT_SETS = { cel25c: 'r25', me55c: 'r30' };
function reprintIndex(cardsMeta) {
  const card = ([id, name, number, setId]) => {
    const [setName, , setTotal, releaseDate] = cardsMeta.sets[setId] ?? [];
    return { id, name, number, setId, setName, setTotal, releaseDate };
  };
  const earliest = new Map();
  for (const row of cardsMeta.cards) {
    const c = card(row);
    if (REPRINT_SETS[c.setId]) continue;
    const k = `${c.name}|${c.number}`;
    if (!earliest.has(k) || (c.releaseDate || '') < (earliest.get(k).releaseDate || '')) earliest.set(k, c);
  }
  const of = new Map(), originals = new Set();
  for (const row of cardsMeta.cards) {
    const c = card(row);
    const o = REPRINT_SETS[c.setId] && earliest.get(`${c.name}|${c.number}`);
    if (o && (o.releaseDate || '') < (c.releaseDate || '')) { of.set(c.id, o); originals.add(o.id); }
  }
  return { of, originals };
}

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
  const rp = reprintIndex(cardsMeta);
  for (const [id, name, number, setId] of cardsMeta.cards) {
    const row = prices[id];
    if (!row) continue;
    const [setName, , setTotal, releaseDate] = cardsMeta.sets[setId] ?? [];
    const card = { name, number, setName, setTotal, releaseDate,
      printed: rp.of.get(id), t: rp.of.has(id) ? REPRINT_SETS[setId] : rp.originals.has(id) ? 'o' : '' };
    const add = (variant, usd) => {
      if (usd == null || usd * rate < MIN_AUD) return;
      const { q, n, t } = ebaySoldQuery(card, variant);
      const key = cacheKey(q, n, t);
      const aud = usd * rate;
      // set: a reprinted original's listing must name its set (au-sold-filter.mjs).
      if (!list.has(key) || list.get(key).aud < aud) list.set(key, { key, q, n, t, aud, id, set: t === 'o' ? setName : '' });
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
  url.search = new URLSearchParams({ ...SOLDCOMPS_PARAMS, keyword: ebayKeyword(t.q, t.t) });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SOLDCOMPS_API_KEY}` } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.fatal = [401, 402, 403, 429].includes(res.status); // bad key, out of credits, rate limited
    throw err;
  }
  const body = await res.json();
  return summarise(body.items || [], t.n, OTHER_LANG.test(t.q), t.q, t.t, { set: t.set });
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
// Owner's pause: no SoldComps searches (credits) before this date.
const PAUSED_UNTIL = '2026-10-23';
if (today < PAUSED_UNTIL) {
  console.log(`AU sold searches are paused until ${PAUSED_UNTIL} — nothing checked, no credits used.`);
  process.exit(0);
}
if (!process.env.SOLDCOMPS_API_KEY) throw new Error('SOLDCOMPS_API_KEY is not set');

let done = 0, priced = 0, failed = 0, stop = null, rateLimited = 0;
const queue = [...tonight];
const started = Date.now();
const RATE = Number(process.env.RATE) || 0;
const TIME_LIMIT = (Number(process.env.TIME_LIMIT_MIN) || 100) * 60000; // stop cleanly before the job's timeout
const save = () => writeFile(dataFile('au-sold.json'), JSON.stringify({ ...store, asOf: today, minAud: MIN_AUD }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkOne(t) {
  try {
    const r = await lookup(t);
    store.items[t.key] = r.ok ? [r.aud, r.n, r.low, r.high, today] : [null, r.n ?? 0, null, null, today];
    done++;
    if (r.ok) priced++;
    if (done % 100 === 0) {
      await save();
      console.log(`  … ${done} checked (${priced} priced), ${Math.round((Date.now() - started) / 60000)} min`);
    }
  } catch (err) {
    if (/HTTP 429/.test(err.message) && ++rateLimited <= 20) { // slow down and try again later
      queue.push(t);
      await sleep(30000);
      return;
    }
    failed++;
    console.log(`  ✗ ${t.q}: ${err.message}`);
    if (err.fatal) stop = err.message;
  }
}

if (RATE) {
  // Paced: start one search every 60/RATE s (each takes ~15–20 s, so many run at once).
  const inFlight = new Set();
  while ((queue.length || inFlight.size) && !stop && Date.now() - started < TIME_LIMIT) {
    if (!queue.length || inFlight.size >= 40) { await Promise.race(inFlight); continue; }
    const p = checkOne(queue.shift()).finally(() => inFlight.delete(p));
    inFlight.add(p);
    await sleep(60000 / RATE);
  }
  await Promise.all(inFlight);
} else {
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !stop && Date.now() - started < TIME_LIMIT) await checkOne(queue.shift());
  }));
}
if (queue.length && !stop) console.log(`Time limit reached: ${queue.length} left for the next run.`);
await save();
console.log(`Checked ${done} (${priced} priced, ${done - priced} too few sales), ${failed} failed, `
  + `${Math.round((Date.now() - started) / 1000)} s. File holds ${Object.keys(store.items).length}.`);
if (stop) console.log(`Stopped early: ${stop}`);
