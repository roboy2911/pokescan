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
//   Optional variables: PAUSED_UNTIL ("YYYY-MM-DD": no searches before then), DAILY_LIMIT (default 400; set to 50 in wrangler.jsonc), CACHE_DAYS (default 3; set to 14 in wrangler.jsonc)
//
// Also grader tuning samples: /grade-sample (tools/grade-samples.mjs).
// Also accounts and collection sync: /auth/signup, /auth/login, /auth/logout, /sync, /backups — see
// tools/account-worker.mjs.
//
// GET /?q=<search words>&n=<card number as printed, e.g. 161/131>[&t=<mode>][&s=<set name>][&w=1]
//   → { ok: true, aud, n, low, high, asOf, recent: [{ title, aud, date, url }], wide?, few? }
// Australian sellers first; with fewer than 3 of their sales, every seller on eBay.com.au
// (wide: true), and 1–2 sales are still an answer (few: true, the app shows "last sold").
// w=1 skips the Australian-only search (the nightly pre-check already found too few).
//   → { ok: false, reason: 'few-sales' | 'daily-limit' | … }

import { summarise, ebayKeyword, OTHER_LANG, SOLDCOMPS_PARAMS } from './au-sold-filter.mjs';
import { handleAccount } from './account-worker.mjs';
import { handleGradeSample } from './grade-samples.mjs';

const ALLOWED_ORIGINS = ['https://roboy2911.github.io', 'http://localhost:8080', 'http://localhost:8765'];
// The Cloudflare Pages copy of the app (pokescan.pages.dev, and its preview links).
const PAGES_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?pokescan[a-z0-9-]*\.pages\.dev$/;
const isAllowed = (origin) => ALLOWED_ORIGINS.includes(origin) || PAGES_ORIGIN.test(origin);
const json = (body, origin, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'cache-control': 'no-store',
  },
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const allow = isAllowed(origin) ? origin : ALLOWED_ORIGINS[0];
    if (request.method === 'OPTIONS') return json({}, allow);
    if (origin && !isAllowed(origin)) return json({ ok: false, reason: 'origin' }, allow, 403);
    const url = new URL(request.url);
    // Accounts and collection sync (tools/account-worker.mjs).
    if (url.pathname === '/grade-sample') {
      return handleGradeSample(request, env, url, (body, status = 200) => json(body, allow, status));
    }
    if (url.pathname.startsWith('/auth/') || url.pathname === '/sync' || url.pathname === '/backups') {
      return handleAccount(request, env, url, (body, status = 200) => json(body, allow, status));
    }
    if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, allow, 405);

    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const n = (url.searchParams.get('n') || '').trim().slice(0, 20);
    const t = ['o', 'r25', 'r30', 'ja'].includes(url.searchParams.get('t')) ? url.searchParams.get('t') : '';
    const set = (url.searchParams.get('s') || '').trim().slice(0, 60);
    const wideOnly = url.searchParams.get('w') === '1' && !!n;
    if (q.length < 3) return json({ ok: false, reason: 'query' }, allow, 400);

    const cacheDays = Number(env.CACHE_DAYS) || 3;
    const key = `v5:${q.toLowerCase()}|${n.toLowerCase()}|${t}|${set.toLowerCase()}`;
    const cached = env.AU_KV && await env.AU_KV.get(key, 'json');
    if (cached) return json({ ...cached, cached: true }, allow);

    // Owner's pause (PAUSED_UNTIL in wrangler.jsonc, e.g. "2026-10-23"): saved answers only,
    // no SoldComps searches.
    const day = new Date().toISOString().slice(0, 10);
    if (env.PAUSED_UNTIL && day < env.PAUSED_UNTIL) return json({ ok: false, reason: 'paused' }, allow);

    // Daily cap, counted per SoldComps search (approximate: KV counters are eventually
    // consistent, which is fine here).
    const limit = Number(env.DAILY_LIMIT) || 400;
    const countKey = `count:${day}`;
    let used = Number(env.AU_KV && await env.AU_KV.get(countKey)) || 0;
    const search = async (itemLocation) => {
      if (used >= limit) return null;
      used++;
      if (env.AU_KV) await env.AU_KV.put(countKey, String(used), { expirationTtl: 2 * 86400 });
      const api = new URL('https://api.sold-comps.com/v1/scrape');
      api.search = new URLSearchParams({ ...SOLDCOMPS_PARAMS, keyword: ebayKeyword(q, t), itemLocation });
      const res = await fetch(api, { headers: { Authorization: `Bearer ${env.SOLDCOMPS_API_KEY}` } });
      if (!res.ok) throw new Error(`upstream-${res.status}`);
      return (await res.json()).items || [];
    };
    const other = OTHER_LANG.test(q);
    let result;
    try {
      const local = wideOnly ? null : await search('domestic');
      if (local === null && !wideOnly) return json({ ok: false, reason: 'daily-limit' }, allow);
      result = local && summarise(local, n, other, q, t, { set });
      // Single cards only: overseas sealed product is mostly shipping.
      if (!result?.ok && n) {
        const all = await search('worldwide');
        // Out of searches for today: answer "try tomorrow" and save nothing.
        if (all === null) return json({ ok: false, reason: 'daily-limit' }, allow);
        const wide = summarise(all, n, other, q, t, { set, min: 1 });
        result = wide.ok ? { ...wide, wide: true } : result ?? wide;
      }
    } catch (err) {
      return json({ ok: false, reason: err.message }, allow, 502);
    }
    result = { ...result, asOf: day };
    // Cards with too few sales are remembered too, so they don't cost a search every view.
    if (env.AU_KV) await env.AU_KV.put(key, JSON.stringify(result), { expirationTtl: cacheDays * 86400 });
    return json(result, allow);
  },
};
