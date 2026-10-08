// PokeScan "AU sold" middleman — a Cloudflare Worker (free plan).
//
// The app asks it for one card's Australian sold price when someone opens that card. It
// keeps the SoldComps key secret, asks SoldComps for eBay.com.au sales by Australian sellers
// in the last 90 days, throws out graded / other-language / lot / fake listings, and returns
// the median. Each answer is saved for CACHE_DAYS, so opening the same card again costs no
// search, and it stops at DAILY_LIMIT searches a day so your plan can't be used up.
//
// Set up (Cloudflare dashboard): see README → "AU sold prices".
//   Secret   SOLDCOMPS_API_KEY  your sc_… key
//   KV       AU_KV              a KV namespace (cache + daily counter)
//   Optional variables: DAILY_LIMIT (default 400; set to 50 in wrangler.jsonc), CACHE_DAYS (default 3; set to 14 in wrangler.jsonc)
//
// GET /?q=<search words>&n=<card number as printed, e.g. 161/131>
//   → { ok: true, aud, n, low, high, asOf, recent: [{ title, aud, date, url }] }
//   → { ok: false, reason: 'few-sales' | 'daily-limit' | … }

import { summarise, OTHER_LANG, SOLDCOMPS_PARAMS } from './au-sold-filter.mjs';

const ALLOWED_ORIGINS = ['https://roboy2911.github.io', 'http://localhost:8080', 'http://localhost:8765'];
const json = (body, origin, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': origin,
    'cache-control': 'no-store',
  },
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    if (request.method === 'OPTIONS') return json({}, allow);
    if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, allow, 405);
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, reason: 'origin' }, allow, 403);

    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const n = (url.searchParams.get('n') || '').trim().slice(0, 20);
    if (q.length < 3) return json({ ok: false, reason: 'query' }, allow, 400);

    const cacheDays = Number(env.CACHE_DAYS) || 3;
    const key = `v2:${q.toLowerCase()}|${n.toLowerCase()}`;
    const cached = env.AU_KV && await env.AU_KV.get(key, 'json');
    if (cached) return json({ ...cached, cached: true }, allow);

    // Daily cap (approximate: KV counters are eventually consistent, which is fine here).
    const day = new Date().toISOString().slice(0, 10);
    const limit = Number(env.DAILY_LIMIT) || 400;
    const used = Number(env.AU_KV && await env.AU_KV.get(`count:${day}`)) || 0;
    if (used >= limit) return json({ ok: false, reason: 'daily-limit' }, allow);
    if (env.AU_KV) await env.AU_KV.put(`count:${day}`, String(used + 1), { expirationTtl: 2 * 86400 });

    const api = new URL('https://api.sold-comps.com/v1/scrape');
    api.search = new URLSearchParams({ keyword: q, ...SOLDCOMPS_PARAMS });
    const res = await fetch(api, { headers: { Authorization: `Bearer ${env.SOLDCOMPS_API_KEY}` } });
    if (!res.ok) return json({ ok: false, reason: `upstream-${res.status}` }, allow, 502);
    const body = await res.json();

    const result = { ...summarise(body.items || [], n, OTHER_LANG.test(q), q), asOf: day };
    // Cards with too few sales are remembered too, so they don't cost a search every view.
    if (env.AU_KV) await env.AU_KV.put(key, JSON.stringify(result), { expirationTtl: cacheDays * 86400 });
    return json(result, allow);
  },
};
