// One-off (owner allowed up to 200 SoldComps credits, 12 Oct): fetch the raw eBay.com.au sold
// listings (Australian sellers, same search as the pre-check) for the cards in list.json, so the
// AU sold filter (tools/au-sold-filter.mjs) can be tested offline. One search per card;
// stops at BUDGET. Writes raw.json: { "<key>": [[title, aud, condition, date], …] }.
import { readFile, writeFile } from 'node:fs/promises';
import { ebayKeyword, SOLDCOMPS_PARAMS } from '../au-sold-filter.mjs';

const BUDGET = Math.min(Number(process.env.BUDGET) || 0, 190);
if (!BUDGET) { console.log('No budget — nothing fetched.'); process.exit(0); }
if (!process.env.SOLDCOMPS_API_KEY) throw new Error('SOLDCOMPS_API_KEY is not set');
const here = (f) => new URL(f, import.meta.url);
const list = JSON.parse(await readFile(here('list.json'), 'utf8')).slice(0, BUDGET);
const out = {};
let used = 0, failed = 0;
const queue = [...list];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const t = queue.shift();
    if (used >= BUDGET) return;
    used++;
    try {
      const url = new URL('https://api.sold-comps.com/v1/scrape');
      url.search = new URLSearchParams({ ...SOLDCOMPS_PARAMS, keyword: ebayKeyword(t.q, t.t) });
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SOLDCOMPS_API_KEY}` } });
      if (!res.ok) { failed++; console.log(`✗ ${t.q}: HTTP ${res.status}`); if ([401, 402, 403].includes(res.status)) queue.length = 0; continue; }
      const items = (await res.json()).items || [];
      out[t.key] = items.filter((it) => it.soldCurrency === 'AUD')
        .map((it) => [it.title, Number(it.soldPrice), it.condition || '', (it.endedAt || '').slice(0, 10)]);
    } catch (err) { failed++; console.log(`✗ ${t.q}: ${err.message}`); }
  }
}));
await writeFile(here('raw.json'), JSON.stringify(out));
console.log(`Fetched ${Object.keys(out).length} cards, ${used} searches, ${failed} failed.`);
