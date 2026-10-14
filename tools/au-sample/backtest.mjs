// Backtest of AU sold price estimators on real sales (raw.json): for each card with 6+ sales, hide each of the
// last 3 and estimate it from the earlier ones. Run: node tools/au-sample/backtest.mjs (no searches).
import { readFileSync } from 'node:fs';
const N = await import('../au-sold-filter.mjs');
const list = JSON.parse(readFileSync(new URL('list.json', import.meta.url)));
const raw = JSON.parse(readFileSync(new URL('raw.json', import.meta.url)));
const day = (d) => Date.parse(d) / 864e5;
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const wmed = (xs, ws) => { const o = xs.map((x, i) => [x, ws[i]]).sort((a, b) => a[0] - b[0]); const tot = ws.reduce((a, b) => a + b, 0); let acc = 0; for (const [x, w] of o) { acc += w; if (acc >= tot / 2) return x; } return o.at(-1)[0]; };
const outl = (s) => { if (s.length < 4) return s; const m = med(s.map((x) => x.p)); return s.filter((x) => x.p >= m * 0.5 && x.p <= m * 2); };
const METHODS = {
  median: (s) => med(outl(s).map((x) => x.p)),
  median_noOutlier: (s) => med(s.map((x) => x.p)),
  last3median: (s) => med(s.slice(-3).map((x) => x.p)),
  last5median: (s) => med(s.slice(-5).map((x) => x.p)),
  recency_hl14: (s, t) => { s = outl(s); return wmed(s.map((x) => x.p), s.map((x) => 0.5 ** ((t - x.d) / 14))); },
  recency_hl30: (s, t) => { s = outl(s); return wmed(s.map((x) => x.p), s.map((x) => 0.5 ** ((t - x.d) / 30))); },
  recency_hl60: (s, t) => { s = outl(s); return wmed(s.map((x) => x.p), s.map((x) => 0.5 ** ((t - x.d) / 60))); },
  trimmedMean: (s) => { const v = outl(s).map((x) => x.p).sort((a, b) => a - b); const k = Math.floor(v.length * 0.2); const u = v.slice(k, v.length - k || undefined); return u.reduce((a, b) => a + b, 0) / u.length; },
  geoMean: (s) => { const v = outl(s).map((x) => x.p); return Math.exp(v.reduce((a, b) => a + Math.log(b), 0) / v.length); },
  trend: (s, t) => { s = outl(s); if (s.length < 5) return med(s.map((x) => x.p)); const xs = s.map((x) => x.d), ys = s.map((x) => Math.log(x.p)); const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length; let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; }); let b = den ? num / den : 0; b = Math.max(-0.01, Math.min(0.01, b)); // cap ±1%/day
    const resid = ys.map((y, i) => y - b * (xs[i] - mx)); return Math.exp(med(resid) + b * (t - mx)); },
  regime3: (s) => { s = outl(s); const all = med(s.map((x) => x.p)); const last = s.slice(-3).map((x) => x.p); if (s.length >= 6 && (last.every((p) => p > all * 1.3) || last.every((p) => p < all / 1.3))) return med(last); return all; },
  regime2: (s, t) => { const raw = s; s = outl(s); const all = med(s.map((x) => x.p)); const last = raw.slice(-3).map((x) => x.p); if (raw.length >= 5 && (last.every((p) => p > all * 1.3) || last.every((p) => p < all / 1.3))) return med(last); return all; },
  blend: (s, t) => { const a = METHODS.recency_hl30(s, t), b = METHODS.median(s), c = METHODS.last3median(s); return (a + b + c) / 3; },
};
const err = {}; let cards = 0, tests = 0;
for (const t of list) {
  const items = (raw[t.key] || []).map(([title, p, c, d]) => ({ title, soldPrice: p, soldCurrency: 'AUD', condition: c, endedAt: d }));
  const m = N.matching(items, t.n, N.OTHER_LANG.test(t.q), t.q, t.t, t.set);
  const seen = new Set();
  const sales = m.map((x) => ({ p: Number(x.soldPrice), d: day(x.endedAt), k: `${x.title.toLowerCase()}|${x.soldPrice}` })).filter((x) => x.d && !seen.has(x.k) && seen.add(x.k)).sort((a, b) => a.d - b.d);
  if (sales.length < 6) continue;
  cards++;
  // Hold out each of the last 3 sales in turn; estimate from everything before it.
  for (let h = sales.length - 3; h < sales.length; h++) {
    const past = sales.slice(0, h), target = sales[h];
    if (past.length < 4) continue;
    tests++;
    for (const [name, f] of Object.entries(METHODS)) { const e = Math.abs(Math.log(f(past, target.d) / target.p)); (err[name] ??= []).push(e); }
  }
}
console.log('cards', cards, 'tests', tests);
const rows = Object.entries(err).map(([n, e]) => { const s = [...e].sort((a, b) => a - b); return [n, (Math.exp(med(s)) - 1) * 100, (Math.exp(s[Math.floor(s.length * 0.8)]) - 1) * 100, (e.filter((x) => x < Math.log(1.15)).length / e.length * 100)]; }).sort((a, b) => a[1] - b[1]);
for (const r of rows) console.log(r[0].padEnd(18), 'median error', r[1].toFixed(1) + '%', '| 80th pct', r[2].toFixed(1) + '%', '| within 15%:', r[3].toFixed(0) + '%');
// Worst misses (median method): show the held-out sale and the past sales.
const worst = [];
for (const t of list) {
  const items = (raw[t.key] || []).map(([title, p, c, d]) => ({ title, soldPrice: p, soldCurrency: 'AUD', condition: c, endedAt: d }));
  const m = N.matching(items, t.n, N.OTHER_LANG.test(t.q), t.q, t.t, t.set);
  const seen = new Set();
  const sales = m.map((x) => ({ p: Number(x.soldPrice), d: day(x.endedAt), title: x.title, c: x.condition, k: `${x.title.toLowerCase()}|${x.soldPrice}` })).filter((x) => x.d && !seen.has(x.k) && seen.add(x.k)).sort((a, b) => a.d - b.d);
  if (sales.length < 6) continue;
  for (let h = sales.length - 3; h < sales.length; h++) {
    const past = sales.slice(0, h), target = sales[h]; if (past.length < 4) continue;
    const est = METHODS.median(past); worst.push({ q: t.q, est, target, r: target.p / est });
  }
}
worst.sort((a, b) => Math.abs(Math.log(b.r)) - Math.abs(Math.log(a.r)));
for (const w of worst.slice(0, 22)) console.log(w.r.toFixed(2), '| est', w.est.toFixed(0), '| sold', w.target.p, '|', w.q, '|', w.target.title.slice(0, 90), '|', w.target.c);
