// eBay Australia "for sale now" — part of the Cloudflare Worker (tools/au-sold-worker.js).
//
// eBay's Browse API (free with a developer key; it shows what's listed, not what sold): the
// Buy It Now listings for a card from Australian sellers, run through the same checks as the
// AU sold prices (the right card and number, ungraded, near mint, no lots / proxies), cheapest
// first (price + postage).
//
// Secrets (Cloudflare dashboard): EBAY_CLIENT_ID (App ID), EBAY_CLIENT_SECRET (Cert ID).
// GET /listings?q=<search words>&n=<number>[&t=<mode>][&s=<set>][&e=<English set name>]
//   → { ok, count, cheapest: [{ title, aud, price, ship, url, img }], median, asOf }
//   | { ok: false, reason: 'no-ebay-key' | 'daily-limit' | … }
// Answers are kept 6 hours; at most EBAY_DAILY_LIMIT (default 3000) searches a day (eBay
// allows 5,000). Each card lookup is 2 eBay searches (language-marked + unmarked).
import { matching, OTHER_LANG } from './au-sold-filter.mjs';

const KEEP_HOURS = 6;
// Signs a listing is a Japanese card: Japanese writing, Japanese set codes (sv2a, s8b, sm12a,
// SV-P, S-P), Japanese-only rarity codes (SAR, CHR, CSR, AR), "Japan(ese)".
const JP_SIGNS = /[\u3040-\u30ff\u3400-\u9fff]|\b(sv\d{1,2}[a-z]|s\d{1,2}[a-z]|sm\d{1,2}[a-z+]|sv-p|s-p|sm-p|sar|chr|csr|ar)\b|\bjapan(ese)?\b|\bjpn?\b/i;

async function ebayToken(env) {
  const saved = await env.AU_KV.get('ebay:token');
  if (saved) return saved;
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) {
    // eBay's own reason (e.g. invalid_client), never the keys themselves.
    const why = await res.json().catch(() => ({}));
    throw new Error(`ebay-auth-${res.status}${why.error ? `: ${why.error}${why.error_description ? ` — ${why.error_description}` : ''}` : ''}`.slice(0, 200));
  }
  const j = await res.json();
  await env.AU_KV.put('ebay:token', j.access_token, { expirationTtl: Math.max(60, (j.expires_in || 7200) - 300) });
  return j.access_token;
}

export async function handleListings(request, env, url, reply) {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return reply({ ok: false, reason: 'no-ebay-key', listings: 1 });
  if (!env.AU_KV) return reply({ ok: false, reason: 'no-storage' }, 500);
  const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const n = (url.searchParams.get('n') || '').trim().slice(0, 20);
  const t = ['o', 'r25', 'r30', 'ja'].includes(url.searchParams.get('t')) ? url.searchParams.get('t') : '';
  const set = (url.searchParams.get('s') || '').trim().slice(0, 60);
  if (q.length < 3) return reply({ ok: false, reason: 'query', listings: 1 }, 400);
  const key = `ls:v4:${q.toLowerCase()}|${n.toLowerCase()}|${t}|${set.toLowerCase()}`;
  const cached = await env.AU_KV.get(key, 'json');
  if (cached) return reply({ ...cached, cached: true });

  const day = new Date().toISOString().slice(0, 10);
  const countKey = `ebaycount:${day}`;
  const used = Number(await env.AU_KV.get(countKey)) || 0;
  if (used >= (Number(env.EBAY_DAILY_LIMIT) || 3000)) return reply({ ok: false, reason: 'daily-limit' });
  await env.AU_KV.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });

  // The card's language: eBay's own "Language" item detail. Sellers often leave it out, so two
  // searches: copies marked with the language, plus unmarked ones that the title shows are
  // that language (for English: names the English set or says English, and no Japanese signs).
  const japanese = OTHER_LANG.test(q) || t === 'ja';
  const setName = (url.searchParams.get('e') || '').trim().slice(0, 60);
  let items;
  try {
    const token = await ebayToken(env);
    const search = async (lang) => {
      const api = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
      api.search = new URLSearchParams({
        q: `pokemon ${q}`,
        limit: '100',
        sort: 'price',
        filter: 'buyingOptions:{FIXED_PRICE},itemLocationCountry:AU,deliveryCountry:AU',
        ...(lang && { category_ids: '183454', aspect_filter: `categoryId:183454,Language:{${lang}}` }),
      });
      const res = await fetch(api, {
        headers: { authorization: `Bearer ${token}`, 'x-ebay-c-marketplace-id': 'EBAY_AU', 'x-ebay-c-enduserctx': 'contextualLocation=country=AU' },
      });
      if (res.status === 401) await env.AU_KV.delete('ebay:token');
      if (!res.ok) throw new Error(`ebay-${res.status}`);
      return (await res.json()).itemSummaries ?? [];
    };
    if (!n) {
      items = await search(null); // sealed product: no language detail on those listings
    } else {
      const [marked, all] = await Promise.all([search(japanese ? 'Japanese' : 'English'), search(null)]);
      const ids = new Set(marked.map((it) => it.itemId));
      const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ');
      const unmarkedOk = (title) => (japanese
        ? JP_SIGNS.test(title) || OTHER_LANG.test(title)
        : !JP_SIGNS.test(title) && (/\b(english|eng)\b/i.test(title) || (setName.length >= 3 && norm(title).includes(norm(setName)))));
      items = [...marked.filter((it) => japanese || !JP_SIGNS.test(it.title || '')),
        ...all.filter((it) => !ids.has(it.itemId) && unmarkedOk(it.title || ''))];
    }
  } catch (err) {
    return reply({ ok: false, reason: err.message }, 502);
  }
  // Into the shape the sold-price checks use, then the same checks.
  const shaped = items
    .filter((it) => it.price?.currency === 'AUD' && (/ungraded/i.test(it.condition || '') || !/graded/i.test(it.condition || '')))
    .map((it) => {
      const price = Number(it.price.value);
      const ship = Number(it.shippingOptions?.[0]?.shippingCost?.value ?? 0) || 0;
      return { title: it.title || '', soldPrice: price + ship, soldCurrency: 'AUD', condition: it.condition || '', url: it.itemWebUrl, img: it.image?.imageUrl || '', price, ship };
    });
  const real = matching(shaped, n, OTHER_LANG.test(q), q, t, set).sort((a, b) => a.soldPrice - b.soldPrice);
  // Drop suspiciously cheap ones (fakes / proxies / wrong card): under 35% of the middle price.
  const prices = real.map((r) => r.soldPrice);
  const mid = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  const keep = real.filter((r) => prices.length < 4 || r.soldPrice >= mid * 0.35);
  const out = {
    ok: true,
    count: keep.length,
    raw: items.length,
    median: keep.length ? Math.round(keep[Math.floor(keep.length / 2)].soldPrice * 100) / 100 : null,
    cheapest: keep.slice(0, 5).map((r) => ({ title: r.title, aud: Math.round(r.soldPrice * 100) / 100, price: r.price, ship: r.ship, url: r.url, img: r.img })),
    asOf: new Date().toISOString(),
  };
  await env.AU_KV.put(key, JSON.stringify(out), { expirationTtl: KEEP_HOURS * 3600 });
  return reply(out);
}
