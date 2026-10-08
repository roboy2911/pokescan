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
//   Optional variables: DAILY_LIMIT (default 400), CACHE_DAYS (default 3)
//
// GET /?q=<search words>&n=<card number as printed, e.g. 161/131>
//   → { ok: true, aud, n, low, high, asOf, recent: [{ title, aud, date, url }] }
//   → { ok: false, reason: 'few-sales' | 'daily-limit' | … }

const ALLOWED_ORIGINS = ['https://roboy2911.github.io', 'http://localhost:8080', 'http://localhost:8765'];
const MIN_SALES = 3;

// Listings that aren't a single raw copy of the card.
const JUNK = /\b(psa|cgc|bgs|beckett|ace\s?\d|tag\s?\d|sgc|graded|slab|gem\s?mint\s?10|lot|bundle|bulk|mystery|repack|custom|proxy|replica|fake|orica|metal|gold\s?(card|plated|foil)|coin|sticker|poster|art\s?print|digital|code\s?card|choose|pick\s?(your|a|one)|you\s?pick|empty|case\s?only|toploader\s?only)\b/i;
// More than one item: "x 2", "2x", "x3", "set of", "pair".
const MULTI = /(\bx\s?[2-9]\d?\b|\b[2-9]\d?\s?x\b|\bset of\b|\bpair\b|\b[2-9]\d? (packs|boxes|bundles|etbs|tins)\b)/i;
const OTHER_LANG = /\b(japanese|japan|jpn|chinese|korean|kor|thai|indonesian|german|french|italian|spanish|portuguese)\b|\bjp\b/i;

const json = (body, origin, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': origin,
    'cache-control': 'no-store',
  },
});

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// "161/131" → ["161", "131"]; "SWSH020" → ["swsh020"]. The title must contain the number.
function numberMatcher(n) {
  if (!n) return () => true;
  const parts = n.toLowerCase().split('/');
  const strip = (x) => x.replace(/^0+(?=\d)/, '');
  if (parts.length === 2) {
    const re = new RegExp(`(^|[^0-9])0*${strip(parts[0])}\\s*/\\s*0*${strip(parts[1])}([^0-9]|$)`);
    return (title) => re.test(title.toLowerCase());
  }
  return (title) => title.toLowerCase().replace(/[\s-]/g, '').includes(parts[0].replace(/[\s-]/g, ''));
}

function summarise(items, n, wantsOtherLang, q = '') {
  const hasNumber = numberMatcher(n);
  // Words searched for don't count as junk ("Booster Bundle" is a product, not a lot).
  const qWords = new RegExp(`\\b(${q.toLowerCase().split(/\s+/).filter((w) => /^[a-z]+$/.test(w)).join('|') || '$^'})\\b`, 'gi');
  const isJunk = (title) => JUNK.test(title.replace(qWords, ' ')) || MULTI.test(title);
  // Without a card number (sealed product) every searched word must be in the title.
  const words = n ? [] : q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 || /\d/.test(w))
    .map((w) => w.normalize('NFD').replace(/[^a-z0-9]/g, '').replace(/(.{4})s$/, '$1')).filter(Boolean); // "evolutions" ~ "evolution"
  const hasWords = (title) => {
    const t = title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ');
    return words.every((w) => t.includes(w));
  };
  let sales = items
    .filter((it) => it.soldCurrency === 'AUD' && Number(it.soldPrice) > 0)
    .filter((it) => !isJunk(it.title) && (wantsOtherLang || !OTHER_LANG.test(it.title)) && hasNumber(it.title) && hasWords(it.title))
    .map((it) => ({ title: it.title, aud: Number(it.soldPrice), date: (it.endedAt || '').slice(0, 10), url: it.url }));
  if (sales.length >= 4) {
    // Drop outliers: outside 0.5×–2× the median (mislabelled lots, damaged copies, typos).
    const m = median(sales.map((s) => s.aud));
    sales = sales.filter((s) => s.aud >= m * 0.5 && s.aud <= m * 2);
  }
  if (sales.length < MIN_SALES) return { ok: false, reason: 'few-sales', n: sales.length };
  const prices = sales.map((s) => s.aud);
  sales.sort((a, b) => b.date.localeCompare(a.date));
  return {
    ok: true,
    aud: Math.round(median(prices) * 100) / 100,
    n: sales.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    recent: sales.slice(0, 5),
  };
}

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
    api.search = new URLSearchParams({
      keyword: q, ebaySite: 'ebay.com.au', itemLocation: 'domestic', daysToScrape: '90', count: '240',
    });
    const res = await fetch(api, { headers: { Authorization: `Bearer ${env.SOLDCOMPS_API_KEY}` } });
    if (!res.ok) return json({ ok: false, reason: `upstream-${res.status}` }, allow, 502);
    const body = await res.json();

    const result = { ...summarise(body.items || [], n, OTHER_LANG.test(q), q), asOf: day };
    // Cards with too few sales are remembered too, so they don't cost a search every view.
    if (env.AU_KV) await env.AU_KV.put(key, JSON.stringify(result), { expirationTtl: cacheDays * 86400 });
    return json(result, allow);
  },
};
