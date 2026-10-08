// Which eBay sales count towards a card's AU sold price, shared by the Cloudflare worker
// (live lookups, tools/au-sold-worker.js) and the nightly pre-check (tools/au-sold-precheck.mjs).

export const SOLDCOMPS_PARAMS = {
  ebaySite: 'ebay.com.au', itemLocation: 'domestic', daysToScrape: '90',
  count: '60', // newest 60 sales: enough for a median, and much faster
};

const MIN_SALES = 3;

// Listings that aren't a single raw copy of the card.
const JUNK = /\b(psa|cgc|bgs|beckett|ace\s?\d|tag\s?\d|sgc|graded|slab|gem\s?mint\s?10|lot|bundle|bulk|mystery|repack|custom|proxy|replica|fake|orica|metal|gold\s?(card|plated|foil)|coin|sticker|poster|art\s?print|digital|code\s?card|choose|pick\s?(your|a|one)|you\s?pick|empty|case\s?only|toploader\s?only)\b/i;
// More than one item: "x 2", "2x", "x3", "set of", "pair".
const MULTI = /(\bx\s?[2-9]\d?\b|\b[2-9]\d?\s?x\b|\bset of\b|\bpair\b|\b[2-9]\d? (packs|boxes|bundles|etbs|tins)\b)/i;
export const OTHER_LANG = /\b(japanese|japan|jpn|chinese|korean|kor|thai|indonesian|german|french|italian|spanish|portuguese)\b|\bjp\b/i;

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

// Classic Collection reprints (Celebrations 2021, 30th Celebration 2026) carry the original card's
// name and number, so their sales and the original's look alike. mode: 'o' = an original that
// was reprinted (ignore reprint sales), 'r25' / 'r30' = the reprint itself (only its sales).
const REPRINT_WORDS = /celebrations?|classic collection|\b(25th|30th)\b|anniversary|reprint|cel25/i;
const MODES = {
  o: (t) => !REPRINT_WORDS.test(t),
  r25: (t) => /celebrations|25th|cel25/i.test(t) && !/30th/i.test(t),
  r30: (t) => /30th/i.test(t),
  ja: (t) => /japanese|japan|\bjpn?\b/i.test(t),
};

export function summarise(items, n, wantsOtherLang, q = '', mode = '') {
  const hasNumber = numberMatcher(n);
  const inMode = MODES[mode] ?? (() => true);
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
    .filter((it) => !isJunk(it.title) && (wantsOtherLang || !OTHER_LANG.test(it.title)) && hasNumber(it.title) && hasWords(it.title) && inMode(it.title))
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
