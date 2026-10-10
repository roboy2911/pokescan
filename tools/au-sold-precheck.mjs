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
import { targets, audRate } from './au-sold-keys.mjs';

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
const all = targets(cardsMeta, pricesFile.cards, rate, MIN_AUD);
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
// Owner's rule: never on a schedule. It only searches when run by hand with a budget.
if (!Number(process.env.BUDGET)) {
  console.log('No budget given — nothing checked, no credits used. (Run it by hand with a budget.)');
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
