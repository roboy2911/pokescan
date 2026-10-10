// AU sold cache keys for cards: the same search words the app uses (app.js ebaySoldQuery), so
// data/au-sold.json and the worker's answers can be matched back to cards. Shared by
// tools/au-sold-precheck.mjs and tools/picks.mjs.

// Same as the app's ebaySoldQuery (app.js) — keep the two in step.
const EBAY_FINISH_WORDS = { reverseHolofoil: 'reverse holo', '1stEditionHolofoil': '1st edition', '1stEditionNormal': '1st edition' };
// card.printed: for a Classic Collection reprint, the original it copies (its number is printed).
export function ebaySoldQuery(card, variant) {
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
export const cacheKey = (q, n, t = '') => `${q.toLowerCase()}|${(n || '').toLowerCase()}${t ? `|${t}` : ''}`;

// Classic Collection reprints ↔ the originals they copy (same as reprintInfo in app.js).
export const REPRINT_SETS = { cel25c: 'r25', me55c: 'r30' };
export function reprintIndex(cardsMeta) {
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

// Every card + finish (one search per distinct query) worth at least MIN_AUD.
export function targets(cardsMeta, prices, rate, minAud = 0) {
  const list = new Map();
  const rp = reprintIndex(cardsMeta);
  for (const [id, name, number, setId] of cardsMeta.cards) {
    const row = prices[id];
    if (!row) continue;
    const [setName, , setTotal, releaseDate] = cardsMeta.sets[setId] ?? [];
    const card = { name, number, setName, setTotal, releaseDate,
      printed: rp.of.get(id), t: rp.of.has(id) ? REPRINT_SETS[setId] : rp.originals.has(id) ? 'o' : '' };
    const add = (variant, usd) => {
      if (usd == null || usd * rate < minAud) return;
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


export async function audRate() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD');
    const rate = (await r.json()).rates?.AUD;
    if (rate > 0.5 && rate < 5) return rate;
  } catch { /* fall back */ }
  return 1.5;
}

