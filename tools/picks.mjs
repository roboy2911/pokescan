// "Buy ideas" for the developer panel: English cards and sealed product that look likely to rise
// (or are already rising), each with its reasons and a safer / riskier label. Built daily by
// tools/update-prices.mjs (after the market data); also on its own: node tools/picks.mjs
//
// Signals (all from data the app already has, plus today's TCGplayer listings via TCGCSV):
//   - supply: the cheapest copy listed vs what it has recently sold for (TCGplayer "market").
//     Cheapest listing at / above recent sales = little cheap supply left → price tends to rise.
//   - trend: change since tracking began (data/history.json, from 6 Oct 2026), and how steady.
//     History is short at first; this counts for more as it builds up.
//   - rarity: chase cards (special illustration / hyper / gold star / vintage holo …).
//   - popular Pokémon (Charizard, Pikachu, Umbreon and the Eeveelutions, Mew, Lugia …).
//   - set age: sealed product past its print run (≈1–4 years old) — supply only shrinks; a set
//     under ~4 months old is still being printed (riskier).
//   - sealed vs Australian shop price (RRP): an older box still near RRP has room to grow.
// Output: data/picks.json { built, since, days, rate, cards: [...], sealed: [...] } — each pick
// { key, id, name, set, usd, finish?, type?, score, risk: 'safer' | 'riskier', reasons: [...] }.
// Not financial advice: these are reasons to look closer, not guarantees.
import { readFile, writeFile } from 'node:fs/promises';
import { targets, audRate } from './au-sold-keys.mjs';

const WORKER = 'https://pokescan-au-sold.minecraftfishies.workers.dev/';
const AU_EXPORT = `${WORKER}au-export`;

const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';
const HEADERS = { 'User-Agent': 'PokeScan/1.0 (+https://github.com/roboy2911/pokescan)' };
const dataFile = (name) => new URL(`../data/${name}`, import.meta.url);
const readJson = async (name, fallback = null) => { try { return JSON.parse(await readFile(dataFile(name), 'utf8')); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await sleep(800 * i);
  }
  return null;
}

/* Today's listings: productId → { [subType]: { low, market } }. */
async function listings() {
  const groups = (await getJson(`${TCGCSV}/groups`))?.results ?? [];
  const out = new Map();
  const queue = [...groups];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const g = queue.shift();
      for (const p of (await getJson(`${TCGCSV}/${g.groupId}/prices`))?.results ?? []) {
        if (!out.has(p.productId)) out.set(p.productId, {});
        out.get(p.productId)[p.subTypeName] = { low: p.lowPrice, market: p.marketPrice ?? p.midPrice };
      }
    }
  }));
  return out;
}

// prices.json finish codes → TCGplayer sub-type names.
const SUBTYPE = { h: 'Holofoil', n: 'Normal', r: 'Reverse Holofoil', '1h': '1st Edition Holofoil', '1n': '1st Edition', uh: 'Unlimited Holofoil', u: 'Unlimited' };
const MAIN_FINISH = ['h', 'n', '1h', 'uh', '1n', 'u', 'r'];
const FINISH_LABEL = { h: 'Holo', n: 'Normal', r: 'Reverse Holo', '1h': '1st Ed. Holo', '1n': '1st Edition', uh: 'Unlimited Holo', u: 'Unlimited' };

const CHASE = [
  [/special illustration|hyper rare|mega hyper|gold star|rare holo star|rare shining|amazing rare|shiny ultra|rare secret|rainbow/i, 18, 'top-rarity chase card'],
  [/illustration rare|trainer gallery|shiny|radiant|rare prism|classic collection|legend|rare prime|lv\.x/i, 12, 'sought-after rarity'],
  [/ultra|vmax|vstar|holo v\b|holo gx|holo ex|double rare|rare break|ace spec/i, 6, 'ultra rare'],
];
const TOP_MONS = /\b(charizard|pikachu|umbreon|eevee|espeon|sylveon|vaporeon|jolteon|flareon|glaceon|leafeon|mew|mewtwo|rayquaza|lugia|gengar)\b/i;
const FAN_MONS = /\b(greninja|gardevoir|lucario|dragonite|snorlax|blastoise|venusaur|giratina|arceus|gyarados|tyranitar|ho-oh|celebi|suicune|darkrai|garchomp|mimikyu|squirtle|charmander|bulbasaur|psyduck|lapras|ditto|gardevoir|zoroark|alakazam|machamp|moltres|zapdos|articuno|entei|raikou|latias|latios|kyogre|groudon|dragapult|tinkaton|pikachu)\b/i;
// Sets collectors chase (reprinted rarely, strong demand).
const HOT_SETS = /evolving skies|scarlet & violet 151|^151$|prismatic evolutions|crown zenith|hidden fates|shining fates|celebrations|brilliant stars|lost origin|silver tempest|astral radiance|fusion strike|paldean fates|surging sparks|destined rivals|twilight masquerade|obsidian flames|paradox rift|chilling reign|vivid voltage|cosmic eclipse|team up|unbroken bonds|base set|jungle|fossil|team rocket|neo genesis|neo destiny|skyridge|aquapolis|expedition|30th/i;
// Australian RRP (prices.js) → USD at about the usual rate, for sealed.
const RRP_AUD = { 'Booster Box': 300, 'Elite Trainer Box': 100, 'Pokémon Center Elite Trainer Box': 140, 'Booster Bundle': 50, 'Booster Pack': 8.5, 'Ultra-Premium Collection': 250, 'Super-Premium Collection': 150, 'Premium Collection': 80, 'Collection Box': 40, 'Tin': 40, 'Mini Tin': 18, '3-Pack Blister': 25, 'Half Booster Box': 150 };
const SEALED_TYPES = new Set(['Booster Box', 'Elite Trainer Box', 'Pokémon Center Elite Trainer Box', 'Booster Bundle', 'Ultra-Premium Collection', 'Super-Premium Collection', 'Premium Collection', 'Collection Box', 'Booster Pack', 'Half Booster Box', '3-Pack Blister', 'Tin']);

const monthsSince = (date, now) => (date ? (Date.parse(now) - Date.parse(date.replace(/\//g, '-'))) / (30.44 * 86400000) : null);
const dayName = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(v >= 10 || v <= -10 ? 0 : 1)}%`;

/* Trend from a history series (cents per day, nulls allowed). */
function trend(series) {
  const pts = (series ?? []).filter((v) => v != null);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts.at(-1);
  let up = 0, down = 0;
  for (let i = 1; i < pts.length; i++) { if (pts[i] > pts[i - 1]) up++; else if (pts[i] < pts[i - 1]) down++; }
  return { chg: ((last - first) / first) * 100, up, down, days: pts.length };
}

/* Groups of cards surging together — a rarity (e.g. every Prism Star) or a set — over the last
 * few days. A group moving together is a stronger signal than one card (which could be a few
 * odd sales): it's real demand. Returns Map(groupKey → { label, members, up, median, since }). */
const RECENT = 4; // days compared
function groupSurges(cardsMeta, prices, history) {
  const groups = new Map();
  const add = (k, label, chg) => { if (!groups.has(k)) groups.set(k, { label, chgs: [] }); groups.get(k).chgs.push(chg); };
  for (const [id, , , setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f || row[f] < 2) continue; // bulk doesn't count
    const pts = (history.items[`${id}:${f}`] ?? []).filter((v) => v != null);
    if (pts.length < 3) continue;
    const from = pts[Math.max(0, pts.length - 1 - RECENT)], now = pts.at(-1);
    const chg = ((now - from) / from) * 100;
    if (rarity) add(`r:${rarity}`, `${rarity.replace(/^Rare /, '').replace(/^Holo /, '')} cards`, chg);
    add(`s:${setId}`, `${cardsMeta.sets[setId]?.[0] ?? setId} cards`, chg);
  }
  const out = new Map();
  for (const [k, g] of groups) {
    if (g.chgs.length < 6) continue;
    const up = g.chgs.filter((c) => c >= 25).sort((a, b) => a - b);
    if (up.length < 5 || up.length / g.chgs.length < 0.35) continue;
    const median = up[Math.floor(up.length / 2)];
    if (median < 50) continue;
    out.set(k, { key: k, label: g.label, members: g.chgs.length, up: up.length, median: Math.round(median) });
  }
  return out;
}

/* ---------- Anomalies (developer panel → Anomalies) ---------- */

/* Unusual price moves in the daily data:
 *  - groups moving together (a rarity, a set, or one Pokémon across all its cards), up or down;
 *  - big single moves (cards and sealed): the last day, and over the last few days.
 * Each single move says whether it looks real (its group moved too / the cheapest listing backs
 * it up) or like a few odd sales (listings far from the new price). */
const baseName = (name) => name.replace(/\s*(◇|★|δ)\s*/g, ' ').replace(/\b(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|Prime|LEGEND|Star|& .*)$/g, '').replace(/^(Dark|Light|Shining|Radiant|Mega|M|Galarian|Alolan|Hisuian|Paldean|Team Rocket's|Rocket's|Erika's|Misty's|Brock's|Blaine's|Sabrina's|Koga's|Lt\. Surge's|Giovanni's)\s+/, '').trim();
function anomalies({ cardsMeta, prices, sealedData, history, lst }) {
  const D = history.dates;
  const n = D.length;
  if (n < 2) return { groups: [], moves: [], from: null, to: D[0] ?? null };
  const back = Math.min(RECENT, n - 1);
  const at = (series, i) => (series && series[i] != null ? series[i] : null);
  const groups = new Map();
  const add = (k, label, kind, chg, id) => {
    if (!groups.has(k)) groups.set(k, { key: k, label, kind, chgs: [], ids: [] });
    const g = groups.get(k); g.chgs.push(chg); g.ids.push([id, chg]);
  };
  const moves = [];
  const pushMove = (m) => { if (Math.abs(m.chg) >= m.min) moves.push(m); };
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f) continue;
    const series = history.items[`${id}:${f}`];
    const now = at(series, n - 1), was = at(series, n - 1 - back), prev = at(series, n - 2);
    if (now == null || was == null) continue;
    if (Math.max(now, was) < 200) continue; // under US$2: bulk, noisy
    const chg = ((now - was) / was) * 100;
    const set = cardsMeta.sets[setId]?.[0] ?? setId;
    if (rarity) add(`r:${rarity}`, `${rarity.replace(/^Rare /, '')} cards`, 'rarity', chg, id);
    add(`s:${setId}`, `${set}`, 'set', chg, id);
    const bn = baseName(name);
    if (bn.length >= 3) add(`p:${bn.toLowerCase()}`, `${bn} (every card)`, 'pokemon', chg, id);
    const base = { kind: 'card', id, name, number, set, finish: FINISH_LABEL[f], usd: now / 100, rarity };
    const big = Math.max(now, was) >= 500; // US$5+
    if (big) pushMove({ ...base, chg: Math.round(chg), days: back, from: was / 100, min: 60, window: `${back} days` });
    if (big && prev != null && n >= 2) {
      const d1 = ((now - prev) / prev) * 100;
      if (Math.abs(d1) >= 30) moves.push({ ...base, chg: Math.round(d1), days: 1, from: prev / 100, min: 30, window: '1 day' });
    }
  }
  for (const s of sealedData?.items ?? []) {
    const series = history.items[`s${s.id}`];
    const now = at(series, n - 1), was = at(series, n - 1 - back), prev = at(series, n - 2);
    if (now == null || was == null || Math.max(now, was) < 1000) continue;
    const base = { kind: 'sealed', id: `s${s.id}`, name: s.name, set: cardsMeta.sets[s.set]?.[0] ?? s.set, type: s.type, usd: now / 100 };
    pushMove({ ...base, chg: Math.round(((now - was) / was) * 100), days: back, from: was / 100, min: 35, window: `${back} days` });
    if (prev != null) { const d1 = ((now - prev) / prev) * 100; if (Math.abs(d1) >= 20) moves.push({ ...base, chg: Math.round(d1), days: 1, from: prev / 100, min: 20, window: '1 day' }); }
  }
  // Groups: most members moving the same way, strongly.
  const out = [];
  for (const g of groups.values()) {
    const min = g.kind === 'pokemon' ? 4 : 6;
    if (g.chgs.length < min) continue;
    for (const dir of [1, -1]) {
      const movers = g.ids.filter(([, c]) => dir * c >= 20);
      if (movers.length < (g.kind === 'pokemon' ? 3 : 5) || movers.length / g.chgs.length < 0.4) continue;
      const cs = movers.map(([, c]) => c).sort((a, b) => a - b);
      const median = cs[Math.floor(cs.length / 2)];
      if (dir * median < 35) continue;
      movers.sort((a, b) => dir * (b[1] - a[1]));
      out.push({ key: g.key, label: g.label, kind: g.kind, dir: dir > 0 ? 'up' : 'down', members: g.chgs.length, moved: movers.length, median: Math.round(median),
        top: movers.slice(0, 12).map(([id, c]) => [id, Math.round(c)]), all: movers.map(([id]) => id) });
    }
  }
  out.sort((a, b) => Math.abs(b.median) * b.moved - Math.abs(a.median) * a.moved);
  // Is a single move real? Its group moved too, or today's cheapest listing is near the new price.
  const inGroup = new Map();
  for (const g of out) { for (const id of g.all) if (!inGroup.has(id)) inGroup.set(id, g.label); delete g.all; }
  for (const m of moves) {
    const notes = [];
    if (inGroup.has(m.id)) notes.push(`moving with ${inGroup.get(m.id)}`);
    const pid = m.kind === 'sealed' ? Number(m.id.slice(1)) : prices.cards[m.id]?.p;
    const l = pid && Object.values(lst.get(pid) ?? {})[0];
    if (l?.low && l?.market) {
      const r = l.low / (m.usd);
      if (r > 1.6) notes.push('cheapest listing far above it — few sales, unreliable');
      else if (m.chg > 0 && r >= 0.9) notes.push('cheapest listing backs it up');
      else if (m.chg > 0 && r < 0.6) notes.push('cheap copies still listed — may not hold');
      else if (m.chg < 0 && r < 0.95) notes.push('listings dropping too');
    }
    m.note = notes.join('; ');
    delete m.min;
  }
  moves.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
  // One entry per item (the bigger window wins).
  const seen = new Set();
  const uniq = moves.filter((m) => !seen.has(m.id) && seen.add(m.id));
  return { groups: out.slice(0, 30), moves: uniq.slice(0, 120), from: D[n - 1 - back], to: D[n - 1], prev: D[n - 2] };
}

/* ---------- Research (data/catalysts.json, kept by hand with sources) ---------- */

/* 'up' research is used for 60 days after its date, supply news for 90, dated events until
 * the day. Returns { items, up, match(name, number, setName, releaseDate) → { card, set, mon, era }, cardOf }. */
async function loadResearch(date) {
  const cat = await readJson('catalysts.json', { items: [] });
  const age = (d) => (d ? (Date.parse(date) - Date.parse(d)) / 86400000 : 0);
  const items = (cat.items ?? []).filter((c) => (c.kind === 'event' ? !c.date || c.date >= date : age(c.date) <= (c.effect === 'supply' ? 90 : 60)));
  const up = items.filter((c) => c.effect === 'up');
  const cardOf = (c, name, number, setName) => (name === c.name || name.startsWith(`${c.name} `)) && (!c.set || setName === c.set) && (!c.number || number === c.number);
  const match = (name, number, setName, released) => ({
    card: up.find((c) => c.kind === 'card' && cardOf(c, name, number, setName)),
    set: up.find((c) => c.kind === 'set' && c.set === setName),
    mon: up.find((c) => c.kind === 'pokemon' && new RegExp(`\\b${c.pokemon}\\b`, 'i').test(name.replace(/-(EX|GX|V|VMAX|VSTAR)\b/g, ''))),
    era: up.find((c) => c.kind === 'era' && released && released.slice(0, 4) >= c.from && released.slice(0, 4) <= c.to),
  });
  return { items, up, match, cardOf };
}
const srcName = (c) => (/tcgplayer/.test(c.source || '') ? 'TCGplayer' : 'news');

/* ---------- Best ideas (developer panel → Best ideas) ---------- */

/* Only cards where several separate signals agree — not "maybe"s. Every pick must have:
 *   real demand (TCGplayer's cheapest copy at/above recent sales, or hardly any for sale in
 *   Australia at/above its AU price), price already starting to move (a steady rise that hasn't
 *   blown out, or its group surging while it hasn't caught up), a card people chase (top rarity
 *   or vintage holo of a popular Pokémon), a market that trades (AU sales or a reliable price),
 *   not a new set, not a thin market, and at least 5 of the checks below. Few, on purpose. */
async function bestIdeas({ cardsMeta, prices, history, lst, hot, au, date, research }) {
  const sets = cardsMeta.sets;
  const n = history.dates.length;
  const out = [];
  const pending = [];
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f || row[f] < 10) continue;
    const usd = row[f];
    const set = sets[setId] ?? [];
    const age = monthsSince(set[3], date);
    if (age != null && age < 4) continue; // still being printed
    const vintage = (set[3] || '9') < '2004';
    const chase = CHASE.slice(0, 2).find(([re]) => re.test(rarity || '')) || (vintage && /holo/i.test(rarity || ''));
    const top = TOP_MONS.test(name), fan = FAN_MONS.test(name);
    // Research: a card reported climbing (counts as a card people chase, and as movement).
    const r = research.match(name, number, set[0], set[3]);
    if (!r.card && (!chase || !(top || fan))) continue; // a card people chase
    const checks = [];
    // Demand (TCGplayer).
    const sup = supply(lst.get(row.p)?.[SUBTYPE[f]]);
    if (sup != null && sup > 1.5) continue; // thin market
    const demandUs = sup != null && sup >= 1.0;
    if (demandUs) checks.push(`cheapest copy for sale on TCGplayer is ${sup >= 1.02 ? `${Math.round((sup - 1) * 100)}% above` : 'at'} recent sales — demand is ahead of supply`);
    // Movement.
    const series = (history.items[`${id}:${f}`] ?? []).filter((v) => v != null);
    const t = trend(history.items[`${id}:${f}`]);
    const g = hot.get(`r:${rarity}`) ?? hot.get(`s:${setId}`);
    let moving = false;
    if (r.card) { moving = true; checks.push(`${srcName(r.card)} (${dayName(r.card.date)}): ${r.card.note.replace(/^TCGplayer:\s*/, '')}`); }
    if (t && t.days >= 3 && t.chg >= 5 && t.chg <= 60 && t.up >= 2 && t.up > t.down) { moving = true; checks.push(`price rising steadily: ${pct(t.chg)} since ${dayName(history.dates[0])}, up ${t.up} of ${t.days - 1} days — not blown out yet`); }
    if (t && Math.abs(t.chg) > 60 && !g) continue; // sudden jump on its own: unreliable
    if (g && series.length >= 3) {
      const from = series[Math.max(0, series.length - 1 - RECENT)];
      const recent = ((series.at(-1) - from) / from) * 100;
      if (recent < 10) { moving = true; checks.push(`${g.label} are surging (median ${pct(g.median)}) and this one hasn't caught up yet`); }
    }
    if (chase) checks.push(chase === true ? 'vintage holo' : `${chase[2]}`);
    if (top || fan) checks.push(`${name.match(top ? TOP_MONS : FAN_MONS)[1].replace(/^./, (c) => c.toUpperCase())} — ${top ? 'one of the most collected Pokémon' : 'a fan favourite'}`);
    if (r.set && !r.card) checks.push(`${srcName(r.set)}: ${r.set.note.replace(/^TCGplayer:\s*/, '')}`);
    if (r.mon) checks.push(`${srcName(r.mon)}: ${r.mon.note.replace(/^TCGplayer:\s*/, '')}`);
    if (r.era && (top || fan) && !vintage) checks.push(`${r.era.from}–${r.era.to} card of a popular Pokémon — ${srcName(r.era)} says that's the kind of card rising most this year`);
    if (age != null && age >= 9 && !vintage) checks.push(age > 48 ? 'long out of print — no new supply coming' : 'out of (or near the end of) its print run — no new supply coming');
    if (vintage) checks.push('vintage — no new supply, ever');
    const a = au.byId.get(id);
    pending.push({ id, name, number, set: set[0] || setId, rarity, finish: FINISH_LABEL[f], usd, checks, demandUs, moving, a, sup, chg: t?.chg ?? 0 });
  }
  // Australia: sales, and what's for sale now (checked for those without it yet).
  const need = pending.filter((p) => (p.demandUs || p.moving) && p.a && !p.a.forSale).slice(0, 80);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (need.length) {
      const p = need.shift();
      const u = new URL('listings', WORKER);
      u.search = new URLSearchParams({ q: p.a.q, n: p.a.n2, ...(p.a.t && { t: p.a.t }), ...(p.a.s && { s: p.a.s }), e: p.set.replace(/^Scarlet & Violet[—–-]?\s*(?=\S)/, '').replace(/^Base$/, 'Base Set') });
      try { const r = await (await fetch(u, { headers: HEADERS })).json(); if (r.ok) p.a.forSale = { count: r.count, ...(r.cheapest?.[0] && { aud: Math.round(r.cheapest[0].aud), url: r.cheapest[0].url }) }; } catch { /* skip */ }
    }
  }));
  for (const p of pending) {
    const { a } = p;
    let demandAu = false, trades = false;
    if (a) {
      if (a.n >= 5) { trades = true; p.checks.push(`sells regularly in Australia (${a.n} sales in 90 days, about A$${Math.round(a.aud)})`); }
      if (a.forSale) {
        if (a.forSale.count === 0 && a.n >= 3) { demandAu = true; p.checks.push('none for sale in Australia right now'); }
        else if (a.forSale.count <= 3 && a.forSale.aud >= a.aud) { demandAu = true; p.checks.push(`only ${a.forSale.count} for sale in Australia, cheapest A$${a.forSale.aud} — above what it sells for`); }
      }
      if (a.aud < a.usAud * 0.9) p.checks.push(`Australia hasn't caught up: sells for A$${Math.round(a.aud)} here vs A$${Math.round(a.usAud)} in the US`);
    }
    if (!trades && p.sup != null && p.sup >= 0.9 && p.usd >= 20) trades = true;
    if (!(p.demandUs || demandAu) || !p.moving || !trades) continue;
    if (p.checks.length < 5) continue;
    out.push({ ...p, aud: a?.aud ? Math.round(a.aud) : null, forSale: a?.forSale ?? null, conviction: p.checks.length, a: undefined, sup: undefined, demandUs: undefined, moving: undefined });
  }
  out.sort((x, y) => y.conviction - x.conviction || y.chg - x.chg);
  return out.slice(0, 15);
}

/* Catch-up plays: a group is surging (e.g. Prism Stars) — the same cards in Japanese, and any
 * English members, that haven't moved yet. Riskier than the strict list (the market may not
 * follow), so they're their own section. */
async function catchUps({ hot, cardsMeta, prices, history }) {
  const out = [];
  if (!hot.size) return out;
  const [ja, jaPrices, jaHist] = await Promise.all([readJson('cards-ja.json'), readJson('prices-ja.json'), readJson('history-ja.json', { dates: [], items: {} })]);
  // English movers per group: Pokémon names and their move.
  for (const g of hot.values()) {
    const [kind, val] = [g.key.slice(0, 1), g.key.slice(2)];
    const members = cardsMeta.cards.filter((r) => (kind === 'r' ? r[4] === val : r[3] === val));
    const moved = new Map();
    for (const [id, name] of members) {
      const row = prices.cards[id];
      const f = row && MAIN_FINISH.find((k) => row[k] != null);
      const t = f && trend(history.items[`${id}:${f}`]);
      if (t && t.chg >= 25) moved.set(name.replace(/\s*◇.*$|\s*★.*$/, '').trim().toLowerCase(), Math.round(t.chg));
      else if (t && t.chg < 10 && row[f] >= 3) out.push({ lang: 'en', id, name, set: cardsMeta.sets[members.find((r) => r[0] === id)[3]]?.[0], usd: row[f], chg: Math.round(t.chg),
        why: `${g.label} are surging (median ${pct(g.median)}); this English one hasn't moved (${pct(t.chg)})` });
    }
    // Japanese printings of the movers (same Pokémon, same special rarity).
    if (kind === 'r' && ja?.cards) {
      const word = /prism/i.test(val) ? /prism star|◇/i : /gold star|★/i.test(val) ? /★|star/i : null;
      for (const [id, name, , setId] of ja.cards) {
        if (!word || !word.test(name)) continue;
        const mon = name.replace(/\s*(prism star|◇|★|gold star).*$/i, '').trim().toLowerCase();
        if (!moved.has(mon)) continue;
        const row = jaPrices?.cards?.[id];
        const f = row && MAIN_FINISH.find((k) => row[k] != null);
        if (!f) continue;
        const t = trend(jaHist.items[`${id}:${f}`]);
        if (t && t.chg >= 25) continue; // already moved
        out.push({ lang: 'ja', id, name, set: ja.sets[setId]?.[0] ?? setId, usd: row[f], chg: t ? Math.round(t.chg) : 0,
          why: `English ${name.replace(/\s*prism star/i, ' ◇')} is up ${pct(moved.get(mon))}; this Japanese printing hasn't moved yet — Japanese prices often follow (thinner market, riskier)` });
      }
    }
  }
  out.sort((a, b) => b.usd - a.usd);
  return out.slice(0, 30);
}

/* Catalyst watch: dated events from data/catalysts.json — chased cards of that Pokémon that
 * haven't moved yet. Supply news → a warning on that set's picks. */
async function catalystWatch({ cardsMeta, prices, history, lst, date, research }) {
  const out = [];
  for (const c of research.items) {
    if (c.kind !== 'event' || c.effect !== 'up' || !c.pokemon) continue;
    const re = new RegExp(`\\b${c.pokemon}\\b`, 'i');
    for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
      if (!re.test(name)) continue;
      const row = prices.cards[id];
      const f = row && MAIN_FINISH.find((k) => row[k] != null);
      if (!f || row[f] < 10) continue;
      const set = cardsMeta.sets[setId] ?? [];
      const chase = CHASE.slice(0, 2).find(([rx]) => rx.test(rarity || '')) || ((set[3] || '9') < '2004' && /holo/i.test(rarity || ''));
      if (!chase) continue;
      const t = trend(history.items[`${id}:${f}`]);
      if (t && t.chg >= 25) continue;
      const sup = supply(lst.get(row.p)?.[SUBTYPE[f]]);
      if (sup != null && sup > 1.5) continue;
      out.push({ id, name, number, set: set[0] ?? setId, rarity, usd: row[f], chg: t ? Math.round(t.chg) : 0, sup: sup && Math.round(sup * 100) / 100,
        why: `${c.event} (${c.date}) — older ${c.pokemon} chase cards often get pulled up by a new one; this one hasn't moved yet${sup != null && sup >= 1 ? '; cheapest copy already at/above recent sales' : ''}`, source: c.source });
    }
  }
  out.sort((a, b) => (b.sup ?? 0) - (a.sup ?? 0) || b.usd - a.usd);
  return { picks: out.slice(0, 20), supply: research.items.filter((c) => c.effect === 'supply').map((c) => ({ ...c, event: c.event ?? c.note })) };
}

/* In the news: cards that price-tracking articles report climbing (data/catalysts.json, kind
 * 'card'), then the top cards of sets / Pokémon they say are rising that haven't moved yet. */
function newsPicks({ cardsMeta, prices, history, lst, research }) {
  const rows = [];
  const priced = (id) => {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    return f ? { usd: row[f], f, row } : null;
  };
  // Named cards: the printing(s) the article means — the priciest, and any within half of it.
  for (const c of research.up.filter((x) => x.kind === 'card')) {
    const hits = cardsMeta.cards.filter(([, name, number, setId]) => research.cardOf(c, name, number, cardsMeta.sets[setId]?.[0])).map((r) => ({ r, p: priced(r[0]) })).filter((x) => x.p && x.p.usd >= 10);
    const max = Math.max(0, ...hits.map((x) => x.p.usd));
    for (const { r: [id, name, number, setId, rarity], p } of hits) {
      if (p.usd < max * 0.5) continue;
      const t = trend(history.items[`${id}:${p.f}`]);
      rows.push({ id, name, number, set: cardsMeta.sets[setId]?.[0] ?? setId, rarity, usd: p.usd, chg: t ? Math.round(t.chg) : 0, kind: 'card',
        why: `${srcName(c)} (${dayName(c.date)}): ${c.note.replace(/^TCGplayer:\s*/, '')}`, source: c.source });
    }
  }
  // Sets / Pokémon on the rise: their chase cards that haven't moved in our data yet.
  for (const c of research.up.filter((x) => x.kind === 'set' || x.kind === 'pokemon')) {
    const re = c.kind === 'pokemon' && new RegExp(`\\b${c.pokemon}\\b`, 'i');
    const cand = [];
    for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
      const set = cardsMeta.sets[setId] ?? [];
      if (c.kind === 'set' ? set[0] !== c.set : !re.test(name.replace(/-(EX|GX|V|VMAX|VSTAR)\b/g, ''))) continue;
      if (rows.some((x) => x.id === id)) continue;
      const chase = CHASE.slice(0, 2).find(([rx]) => rx.test(rarity || '')) || ((set[3] || '9') < '2004' && /holo/i.test(rarity || ''));
      if (!chase) continue;
      const p = priced(id);
      if (!p || p.usd < 20) continue;
      const t = trend(history.items[`${id}:${p.f}`]);
      if (t && t.chg >= 25) continue; // already moved
      const sup = supply(lst.get(p.row.p)?.[SUBTYPE[p.f]]);
      if (sup != null && (sup > 1.5 || sup < 0.8)) continue; // thin, or plenty of cheap copies
      cand.push({ id, name, number, set: set[0] ?? setId, rarity, usd: p.usd, chg: t ? Math.round(t.chg) : 0, kind: c.kind, sup,
        why: `${srcName(c)} (${dayName(c.date)}): ${c.note.replace(/^TCGplayer:\s*/, '')} — this one hasn't moved in our data yet${sup != null && sup >= 1 ? '; cheapest copy at/above recent sales' : ''}`, source: c.source });
    }
    cand.sort((a, b) => (b.sup ?? 0) - (a.sup ?? 0) || b.usd - a.usd);
    rows.push(...cand.slice(0, 6).map(({ sup, ...x }) => x));
  }
  return rows.slice(0, 40);
}

/* ---------- Early signals (developer panel → ⭐ Best → 🚀 Early signals) ---------- */

/* Sell-out watch: TCGplayer's cheapest copy for each card (A$10+ chase cards), kept 45 days in
 * data/lows.json. When the cheap copies sell out the cheapest listing jumps first and the
 * market (sold) price follows a few days later — catch it in between. */
async function sellOuts({ cardsMeta, prices, history, lst, date }) {
  const lows = await readJson('lows.json', { dates: [], items: {} });
  if (lows.dates.at(-1) !== date) lows.dates.push(date);
  const di = lows.dates.length - 1;
  const out = [];
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f || row[f] < 10) continue;
    const set = cardsMeta.sets[setId] ?? [];
    const chase = CHASE.find(([rx]) => rx.test(rarity || '')) || ((set[3] || '9') < '2004' && /holo/i.test(rarity || ''));
    if (!chase) continue;
    const l = lst.get(row.p)?.[SUBTYPE[f]];
    if (!l?.low) continue;
    const k = `${id}:${f}`;
    const ser = lows.items[k] ?? (lows.items[k] = []);
    ser[di] = Math.round(l.low * 100);
    // Cheapest copy now vs its median over the previous days; market price over the same days.
    const past = ser.slice(0, di).filter((v) => v != null).slice(-7);
    if (past.length < 3) continue;
    const before = [...past].sort((a, b) => a - b)[Math.floor(past.length / 2)];
    const lowChg = ((ser[di] - before) / before) * 100;
    const t = trend((history.items[k] ?? []).slice(-8));
    const mktChg = t?.chg ?? 0;
    if (lowChg >= 25 && mktChg < 10 && l.low <= row[f] * 2.5) {
      out.push({ id, name, number, set: set[0] ?? setId, rarity, usd: row[f], chg: Math.round(mktChg), kind: 'sellout',
        why: `cheapest copy on TCGplayer jumped ${pct(lowChg)} (US$${(before / 100).toFixed(0)} → US$${l.low.toFixed(0)}) while the sold price has only moved ${pct(mktChg)} — the cheap copies are selling out; the sold price usually follows` });
    }
  }
  // Keep 45 days.
  const drop = Math.max(0, lows.dates.length - 45);
  if (drop) { lows.dates = lows.dates.slice(drop); for (const k of Object.keys(lows.items)) lows.items[k] = lows.items[k].slice(drop); }
  for (const k of Object.keys(lows.items)) if (!lows.items[k].some((v) => v != null)) delete lows.items[k];
  await writeFile(dataFile('lows.json'), JSON.stringify(lows));
  out.sort((a, b) => b.usd - a.usd);
  return out.slice(0, 25);
}

/* Contagion: when several cards of one Pokémon are rising (e.g. Rayquaza before a Rayquaza set),
 * or a set's chase card jumps (Jirachi ◇ → the rest of Celestial Storm), the others tend to
 * follow. The chase cards of that Pokémon / set that haven't moved yet. */
function contagion({ cardsMeta, prices, history, lst }) {
  const mon = (name) => name.replace(/^(M|Mega|Dark|Light|Shining|Radiant|Team \w+'s|\w+'s)\s+/i, '').split(/[\s-]/)[0].replace(/[◇★δ]/g, '').toLowerCase();
  const info = [];
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f || row[f] < 15) continue;
    const set = cardsMeta.sets[setId] ?? [];
    const chase = CHASE.slice(0, 2).find(([rx]) => rx.test(rarity || '')) || ((set[3] || '9') < '2004' && /holo/i.test(rarity || ''));
    if (!chase) continue;
    const t = trend(history.items[`${id}:${f}`]);
    if (!t || t.days < 3) continue;
    const sup = supply(lst.get(row.p)?.[SUBTYPE[f]]);
    info.push({ id, name, number, setId, set: set[0] ?? setId, rarity, usd: row[f], chg: t.chg, mon: mon(name), sup });
  }
  const by = (key) => { const m = new Map(); for (const c of info) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return m; };
  const out = [];
  const seen = new Set();
  // Pokémon: at least 4 chase cards up 15%+ and they're at least a quarter of its chase cards.
  for (const [m, cards] of by((c) => c.mon)) {
    const up = cards.filter((c) => c.chg >= 15 && (c.sup == null || c.sup <= 1.5));
    if (cards.length < 6 || up.length < 4 || up.length < cards.length * 0.25) continue;
    for (const c of cards.filter((x) => x.chg < 5 && x.chg > -10 && (x.sup == null || (x.sup >= 0.85 && x.sup <= 1.5))).sort((a, b) => b.usd - a.usd).slice(0, 5)) {
      seen.add(c.id);
      out.push({ ...c, chg: Math.round(c.chg), kind: 'pokemon', why: `${up.length} of ${cards.length} ${c.name.split(' ')[0]} chase cards are up 15%+ (e.g. ${up.sort((a, b) => b.chg - a.chg).slice(0, 2).map((u) => `${u.set} ${pct(u.chg)}`).join(', ')}) — this one hasn't moved yet` });
    }
  }
  // Set: its priciest chase card (or one of its top 3) up 40%+ and steady (not a thin market).
  for (const [, cards] of by((c) => c.setId)) {
    const top = [...cards].sort((a, b) => b.usd - a.usd).slice(0, 3);
    const leader = top.find((c) => c.chg >= 40 && c.chg <= 200 && c.sup != null && c.sup >= 0.85 && c.sup <= 1.5); // a real move, not one odd sale
    if (!leader) continue;
    for (const c of cards.filter((x) => x !== leader && x.chg < 5 && x.chg > -10 && x.usd >= 20 && !seen.has(x.id) && (x.sup == null || (x.sup >= 0.85 && x.sup <= 1.5))).sort((a, b) => b.usd - a.usd).slice(0, 4)) {
      out.push({ ...c, chg: Math.round(c.chg), kind: 'set', why: `${leader.name} from ${leader.set} is up ${pct(leader.chg)} — the set's other chase cards often follow; this one hasn't moved yet` });
    }
  }
  return out.map(({ setId, mon, sup, ...c }) => c).slice(0, 30);
}

/* Niche movers: thin cards (no Australian sales needed) where the supply has dried up — the
 * cheapest copy for sale is above what it last sold for — and the price is already climbing
 * steadily. How niche cards explode: a few buyers clear the cheap copies, the next sale is at
 * the new low, repeat (TCGplayer's Garchomp / Tyranitar / Zoroark spikes, Oct 2026). */
function nicheMovers({ cardsMeta, prices, history, lst, date, research }) {
  const NICHE = /promo|lv\.x|prime|legend|star|shining|holo ex|secret|rainbow|ultra|illustration|trainer gallery|amazing|radiant|shiny|break/i;
  const out = [];
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    const f = row && MAIN_FINISH.find((k) => row[k] != null);
    if (!f || row[f] < 15) continue;
    const set = cardsMeta.sets[setId] ?? [];
    const age = monthsSince(set[3], date);
    if (age != null && age < 6) continue;
    const vintage = (set[3] || '9') < '2004';
    if (!NICHE.test(rarity || '') && !(vintage && /holo/i.test(rarity || ''))) continue;
    const sup = supply(lst.get(row.p)?.[SUBTYPE[f]]);
    if (sup == null || sup < 1.15 || sup > 3) continue; // supply gone (but not a lone silly listing)
    const t = trend(history.items[`${id}:${f}`]);
    if (!t || t.days < 3 || t.chg < 8 || t.chg > 80 || t.up < 2 || t.up <= t.down) continue;
    const top = TOP_MONS.test(name), fan = FAN_MONS.test(name);
    const r = research.match(name, number, set[0], set[3]);
    const year = (set[3] || '').slice(0, 4);
    let score = Math.min(30, t.chg) + Math.min(30, (sup - 1) * 40) + (top ? 15 : fan ? 8 : 0) + (r.card || r.set || r.mon ? 10 : 0)
      + (year >= '2007' && year <= '2016' ? 6 : 0) + (/lv\.x|prime|legend|gold star|star|shining/i.test(rarity || '') ? 5 : 0);
    const why = [`price up ${pct(t.chg)} since ${dayName(history.dates[0])} (rising ${t.up} of ${t.days - 1} days)`,
      `cheapest copy for sale is ${Math.round((sup - 1) * 100)}% above its last sales — the cheap copies are gone`,
      top ? 'one of the most collected Pokémon' : fan ? 'fan-favourite Pokémon' : '',
      r.card ? `${srcName(r.card)}: reported climbing` : r.set ? `${srcName(r.set)}: its set is rising` : r.mon ? `${srcName(r.mon)}: ${r.mon.pokemon} is rising` : '',
      'thin market — few sales, so it can jump fast (and drop fast)'].filter(Boolean).join('; ');
    out.push({ id, name, number, set: set[0] ?? setId, rarity, usd: row[f], chg: Math.round(t.chg), score: Math.round(score), kind: 'niche', why });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 25);
}

/* Track record: every list's picks are logged with their price on the day (data/pick-log.json).
 * Later runs check how each list did after 7 and 30 days, so we learn which signals work. */
async function trackRecord(out, prices, date) {
  const log = await readJson('pick-log.json', { picks: [] });
  const now = (id) => { const row = prices.cards[id]; const f = row && MAIN_FINISH.find((k) => row[k] != null); return f ? row[f] : null; };
  const lists = { best: out.best, news: out.news, catchUp: out.catchUp.filter((c) => c.lang !== 'ja'), catalyst: out.catalysts.picks, sellout: out.sellouts, contagion: out.contagion, niche: out.niche,
    cardsSafer: out.cards.filter((c) => c.risk === 'safer').slice(0, 30) };
  const have = new Set(log.picks.map((p) => `${p.list}|${p.id}`));
  for (const [list, rows] of Object.entries(lists)) for (const r of rows ?? []) {
    if (!r.id || have.has(`${list}|${r.id}`) || r.usd == null) continue;
    log.picks.push({ list, id: r.id, name: r.name, date, usd: r.usd });
  }
  const days = (d) => (Date.parse(date) - Date.parse(d)) / 86400000;
  const summary = {};
  for (const p of log.picks) {
    const n = now(p.id);
    if (n == null) continue;
    for (const [w, min] of [['d7', 7], ['d30', 30]]) {
      if (days(p.date) < min) continue;
      if (p[w] == null && days(p.date) <= min + 3) p[w] = n; // the price at about that age
      if (p[w] == null) continue;
      const s = (summary[p.list] ??= {})[w] ??= { n: 0, up: 0, sum: 0 };
      const chg = ((p[w] - p.usd) / p.usd) * 100;
      s.n++; s.sum += chg; if (chg > 0) s.up++;
    }
  }
  for (const l of Object.values(summary)) for (const s of Object.values(l)) { s.avg = Math.round(s.sum / s.n); s.hit = Math.round((s.up / s.n) * 100); delete s.sum; }
  log.picks = log.picks.filter((p) => days(p.date) <= 120);
  await writeFile(dataFile('pick-log.json'), JSON.stringify(log));
  return { since: log.picks.reduce((m, p) => (p.date < m ? p.date : m), date), logged: log.picks.length, lists: summary };
}

/* Supply: cheapest listing / recent sales. */
function supply(l) {
  if (!l?.low || !l?.market) return null;
  return l.low / l.market;
}

export async function buildPicks({ date = new Date().toISOString().slice(0, 10), listingMap = null } = {}) {
  const [prices, cardsMeta, sealedData, history, extremes] = await Promise.all([
    readJson('prices.json'), readJson('cards.json'), readJson('sealed.json'), readJson('history.json', { dates: [], items: {} }), readJson('extremes.json', { items: {} }),
  ]);
  if (!prices?.cards || !cardsMeta?.cards) throw new Error('prices.json / cards.json missing');
  const lst = listingMap ?? await listings();
  const research = await loadResearch(date);
  const sets = cardsMeta.sets; // id → [name, series, total, releaseDate]
  const days = history.dates.length;

  /* ---------- Cards ---------- */
  const cardPicks = [];
  const hot = groupSurges(cardsMeta, prices, history);
  const since = dayName(history.dates[Math.max(0, history.dates.length - 1 - RECENT)] ?? date);
  for (const [id, name, number, setId, rarity] of cardsMeta.cards) {
    const row = prices.cards[id];
    if (!row) continue;
    const f = MAIN_FINISH.find((k) => row[k] != null);
    if (!f) continue;
    const usd = row[f];
    if (usd < 2) continue;
    const set = sets[setId] ?? [];
    const age = monthsSince(set[3], date);
    const reasons = [];
    let score = 0, risky = 0;
    // Rarity.
    const chase = CHASE.find(([re]) => re.test(rarity || ''));
    const vintage = (set[3] || '9') < '2004';
    if (chase) { score += chase[1]; reasons.push(chase[2]); }
    else if (vintage && /holo/i.test(rarity || '')) { score += 14; reasons.push('vintage holo'); }
    else if (/^(common|uncommon)$/i.test(rarity || '') && !vintage) continue;
    else if (/^promo$/i.test(rarity || '')) score -= 2;
    // Popularity.
    if (TOP_MONS.test(name)) { score += 15; reasons.push(`${name.match(TOP_MONS)[1].replace(/^./, (c) => c.toUpperCase())} — among the most collected Pokémon`); }
    else if (FAN_MONS.test(name)) { score += 7; reasons.push('fan-favourite Pokémon'); }
    if (HOT_SETS.test(set[0] || '')) { score += 5; reasons.push(`${set[0]} is a set collectors chase`); }
    // Set age.
    if (age != null && age < 4) { risky += 2; reasons.push('new set — still being printed, prices often dip before settling'); }
    else if (age != null && age >= 9 && age <= 48) { score += 6; reasons.push('set is out of (or near the end of) its print run'); }
    else if (vintage) score += 4;
    // Supply.
    const l = lst.get(row.p)?.[SUBTYPE[f]];
    const sup = supply(l);
    let thin = false;
    if (sup != null) {
      if (sup > 1.5) { thin = true; risky++; reasons.push('few recent sales — its price is unreliable (listings far above the last sales)'); }
      else if (sup >= 1.05) { score += 16; reasons.push(`cheapest copy listed is ${pct((sup - 1) * 100)} above recent sales — demand is ahead of supply`); }
      else if (sup >= 0.93) { score += 9; reasons.push('little cheap supply: the cheapest copy is about what it last sold for'); }
      else if (sup < 0.65) { score -= 8; reasons.push('plenty listed below recent sales'); }
    }
    // Trend.
    const key = `${id}:${f}`;
    const t = trend(history.items[key]);
    // Part of a group surge (its rarity or set)?
    const g = hot.get(`r:${rarity}`) ?? hot.get(`s:${setId}`);
    if (g && t) {
      const pts = history.items[key].filter((v) => v != null);
      const recent = ((pts.at(-1) - pts[Math.max(0, pts.length - 1 - RECENT)]) / pts[Math.max(0, pts.length - 1 - RECENT)]) * 100;
      if (recent >= 25) {
        score += 12; risky++;
        reasons.push(`part of a surge: ${g.up} ${g.label} up a median ${pct(g.median)} since ${since} (this one ${pct(recent)}) — real demand, but it may cool off`);
      } else if (recent < 10 && usd >= 3) {
        score += 14;
        reasons.push(`${g.label} are surging (${g.up} up a median ${pct(g.median)} since ${since}) — this one hasn't moved yet`);
      }
    }
    if (g && t && t.days >= 3) { /* the group surge explains the jump — not a thin market */ }
    else if (t && t.days >= 3 && Math.abs(t.chg) > 60) { thin = true; risky++; reasons.push(`price jumped ${pct(t.chg)} in days — few sales, unreliable`); }
    else if (t && t.days >= 3) {
      if (t.chg > 0 && t.up >= t.down + 1) { score += Math.min(16, 3 + t.chg * 0.7); reasons.push(`up ${pct(t.chg)} since ${dayName(history.dates[0])} (rising ${t.up} of ${t.days - 1} days)`); }
      else if (t.chg < -8) { score -= 8; reasons.push(`down ${pct(t.chg)} since ${dayName(history.dates[0])}`); }
      if (t.chg > 25) { risky++; reasons.push('rising fast — could cool off'); }
    }
    if (thin) score -= 10;
    // Near its low since tracking began (a dip in a strong card).
    const e = extremes.items?.[key];
    if (e && e[0] > e[2] * 1.12 && usd * 100 <= e[2] * 1.02 && score >= 20) { score += 4; reasons.push('at its lowest since tracking began — a dip'); risky++; }
    if (usd < 5) risky++;
    if (score < 22) continue;
    const safer = !risky && (chase || vintage) && (age == null || age >= 6);
    cardPicks.push({ key, id, name, number, set: set[0] || setId, finish: FINISH_LABEL[f], rarity, usd, score: Math.round(score), risk: safer ? 'safer' : 'riskier', reasons });
  }
  // Best first, at most 3 per set (a broad list).
  cardPicks.sort((a, b) => b.score - a.score || b.usd - a.usd);
  const perSet = new Map();
  const cards = [];
  for (const p of cardPicks) {
    const n = perSet.get(p.set) ?? 0;
    if (n >= 3) continue;
    perSet.set(p.set, n + 1);
    cards.push(p);
    if (cards.length >= 250) break;
  }

  /* ---------- Sealed ---------- */
  const sealedPicks = [];
  const RATE = 1.52; // AUD per USD, roughly — only to compare with Australian RRPs
  for (const s of sealedData?.items ?? []) {
    if (!SEALED_TYPES.has(s.type) || s.usd == null || s.usd < 5) continue;
    if (/code card|case|display/i.test(s.name)) continue;
    const set = sets[s.set] ?? [];
    const age = monthsSince(set[3], date);
    const reasons = [];
    let score = 0, risky = 0;
    if (/booster pack|blister|tin/i.test(s.type) && age != null && age >= 9) { score += 6; reasons.push('cheap way into an out-of-print set — packs only get scarcer'); }
    if (/booster box|elite trainer|booster bundle|ultra-premium/i.test(s.type)) { score += 10; reasons.push(`${/box$/i.test(s.type) ? `${s.type}es` : `${s.type}s`} are what collectors keep sealed`); }
    if (HOT_SETS.test(set[0] || '')) { score += 12; reasons.push(`${set[0]} is a set collectors chase`); }
    if (age != null) {
      if (age < 5) { risky += 2; reasons.push('still being printed — wait for the print run to end, or buy at RRP'); }
      else if (age < 12) { score += 8; reasons.push('print run ending soon — supply will start shrinking'); }
      else if (age <= 48) { score += 16; reasons.push('likely out of print — supply only goes down from here'); }
      else { score += 6; reasons.push('long out of print'); }
    }
    const rrp = RRP_AUD[s.type];
    if (rrp) {
      const x = (s.usd * RATE) / rrp;
      if (x <= 1.3 && age != null && age >= 9) { score += 12; reasons.push(`still near shop price (≈${Math.round(x * 100)}% of RRP) for a set this old — room to grow`); }
      else if (x > 6) { risky++; reasons.push(`already ${x.toFixed(0)}× its shop price`); }
    }
    const sup = supply(lst.get(s.id)?.Normal ?? Object.values(lst.get(s.id) ?? {})[0]);
    if (sup != null) {
      if (sup > 1.5) { risky++; score -= 6; reasons.push('few recent sales — its price is unreliable'); }
      else if (sup >= 1.05) { score += 14; reasons.push(`cheapest listed is ${pct((sup - 1) * 100)} above recent sales — demand is ahead of supply`); }
      else if (sup >= 0.93) { score += 7; reasons.push('little cheap supply: the cheapest is about what it last sold for'); }
      else if (sup < 0.7) { score -= 8; reasons.push('plenty listed below recent sales'); }
    }
    const key = `s${s.id}`;
    const t = trend(history.items[key]);
    if (t && t.days >= 3) {
      if (t.chg > 0 && t.up >= t.down + 1) { score += Math.min(14, 3 + t.chg * 0.8); reasons.push(`up ${pct(t.chg)} since ${dayName(history.dates[0])}`); }
      else if (t.chg < -6) { score -= 8; reasons.push(`down ${pct(t.chg)} since ${dayName(history.dates[0])}`); }
      if (t.chg > 20) { risky++; reasons.push('rising fast — could cool off'); }
    }
    if (score < (s.usd < 40 ? 18 : 24)) continue;
    const safer = !risky && age != null && age >= 9;
    sealedPicks.push({ key, id: s.id, name: s.name, set: set[0] || s.set, type: s.type, usd: s.usd, score: Math.round(score), risk: safer ? 'safer' : 'riskier', reasons });
  }
  sealedPicks.sort((a, b) => b.score - a.score || b.usd - a.usd);
  const perSetS = new Map();
  const sealed = [];
  for (const p of sealedPicks) {
    const n = perSetS.get(p.set) ?? 0;
    if (n >= 2) continue;
    perSetS.set(p.set, n + 1);
    sealed.push(p);
    if (sealed.length >= 150) break;
  }

  const au = await auPicks({ prices, cardsMeta, date, lst });

  const out = { built: new Date().toISOString(), since: history.dates[0] ?? date, days, currency: 'USD', cards, sealed, au: au.picks, auInfo: au.info,
    hot: [...hot.values()].sort((a, b) => b.median - a.median).slice(0, 8).map((h) => ({ ...h, since })),
    anomalies: anomalies({ cardsMeta, prices, sealedData, history, lst }),
    best: await bestIdeas({ cardsMeta, prices, history, lst, hot, au, date, research }),
    catchUp: await catchUps({ hot, cardsMeta, prices, history }),
    catalysts: await catalystWatch({ cardsMeta, prices, history, lst, date, research }),
    news: newsPicks({ cardsMeta, prices, history, lst, research }),
    sellouts: await sellOuts({ cardsMeta, prices, history, lst, date }),
    contagion: contagion({ cardsMeta, prices, history, lst }),
    niche: nicheMovers({ cardsMeta, prices, history, lst, date, research }) };
  out.record = await trackRecord(out, prices, date);
  // More supply coming for a set: a warning on its picks.
  for (const c of out.catalysts.supply) {
    for (const list of [out.cards, out.best, out.au]) for (const p of list ?? []) {
      if (c.set && p.set && p.set.startsWith(c.set)) (p.reasons ?? p.checks)?.push?.(`⚠ ${c.event}`);
    }
  }
  await writeFile(dataFile('picks.json'), JSON.stringify(out));
  console.log(`AU picks: ${au.picks.length} (${au.info.priced} cards with an AU sold price, ${au.info.withSales} with recent sale dates, ${au.info.listed} checked on eBay AU)`);
  console.log(`Catch-up: ${out.catchUp.length}; catalyst watch: ${out.catalysts.picks.length}; in the news: ${out.news.length}; sell-outs: ${out.sellouts.length}; contagion: ${out.contagion.length}; niche movers: ${out.niche.length}; track record: ${out.record.logged} logged`);
  console.log(`Best ideas: ${out.best.length} (${out.best.map((b) => b.name).join(', ')})`);
  console.log(`Anomalies: ${out.anomalies.groups.length} groups, ${out.anomalies.moves.length} single moves`);
  console.log(`Hot groups: ${out.hot.map((h) => `${h.label} (${h.up}/${h.members}, median ${pct(h.median)})`).join(', ') || 'none'}`);
  console.log(`Picks: ${cards.length} cards (${cards.filter((c) => c.risk === 'safer').length} safer), ${sealed.length} sealed (${sealed.filter((c) => c.risk === 'safer').length} safer); ${lst.size} listings`);
  return out;
}

/* ---------- From Australian sold prices ---------- */

/* Cards ranked on what they actually sell for in Australia (eBay.com.au, last 90 days): the
 * nightly-checked file (data/au-sold.json) plus every price looked up since in the app (the
 * worker's /au-export — no SoldComps searches). Signals: cheaper here than the US market (room
 * to catch up), how often it sells here (easy to resell), how steady the price is, recent
 * Australian sales trending up, and the same rarity / popularity / set-age signals. */
const LISTING_CHECKS = 220; // eBay AU searches a night (the worker allows 3,000 a day)
async function auPicks({ prices, cardsMeta, date, lst }) {
  const byId = new Map(); // card id → its AU sold answer (plain finish), for best ideas
  const [pre, rate] = await Promise.all([readJson('au-sold.json', { items: {} }), audRate()]);
  let exported = {};
  try {
    const r = await fetch(AU_EXPORT, { headers: HEADERS });
    if (r.ok) exported = (await r.json()).items ?? {};
  } catch { /* offline: the file alone */ }
  const sets = cardsMeta.sets;
  const meta = new Map(cardsMeta.cards.map(([id, name, number, setId, rarity]) => [id, { name, number, setId, rarity }]));
  const picks = [];
  let priced = 0, withSales = 0;
  for (const t of targets(cardsMeta, prices.cards, rate, 20)) {
    const p = pre.items?.[t.key];
    const x = exported[t.key];
    // Newest answer wins.
    const fromPre = p && p[0] != null ? { aud: p[0], n: p[1], low: p[2], high: p[3], date: p[4], recent: [] } : null;
    const fromEx = x ? { aud: x.a, n: x.n, low: x.l, high: x.h, date: x.d, recent: x.r ?? [], wide: !!x.w } : null;
    const a = !fromPre ? fromEx : !fromEx ? fromPre : fromEx.date >= fromPre.date ? fromEx : fromPre;
    if (!a || !(a.aud > 0)) continue;
    if (!/(reverse holo|1st edition)$/i.test(t.q) && !byId.has(t.id)) byId.set(t.id, { aud: a.aud, n: a.n, usAud: t.aud, q: t.q, n2: t.n, t: t.t, s: t.set });
    priced++;
    const m = meta.get(t.id);
    if (!m) continue;
    const set = sets[m.setId] ?? [];
    const age = monthsSince(set[3], date);
    const reasons = [];
    let score = 0, risky = 0;
    // Australia vs the US market.
    const vsUs = a.aud / t.aud;
    if (vsUs < 0.8) { score += 18; reasons.push(`sells for ${Math.round((1 - vsUs) * 100)}% less in Australia than the US market (A$${Math.round(a.aud)} vs A$${Math.round(t.aud)}) — room to catch up`); }
    else if (vsUs < 0.92) { score += 9; reasons.push(`a little cheaper in Australia than the US market (A$${Math.round(a.aud)} vs A$${Math.round(t.aud)})`); }
    else if (vsUs > 1.3) { score += 5; risky++; reasons.push(`Australians pay ${Math.round((vsUs - 1) * 100)}% more than the US market — strong local demand, but you'd pay a premium`); }
    // How often it sells here.
    if (a.n >= 10) { score += 12; reasons.push(`sells often in Australia (${a.n} sales in 90 days) — easy to resell`); }
    else if (a.n >= 5) { score += 6; reasons.push(`${a.n} Australian sales in 90 days`); }
    else if (a.n <= 2) { risky++; reasons.push(`only ${a.n} Australian sale${a.n === 1 ? '' : 's'} in 90 days — hard to price`); }
    if (a.wide) { risky++; reasons.push('few Australian sellers — price includes overseas sellers'); }
    // Steadiness.
    const spread = a.high && a.low ? (a.high - a.low) / a.aud : null;
    if (spread != null && a.n >= 4) {
      if (spread < 0.45) { score += 6; reasons.push(`steady price (A$${Math.round(a.low)}–${Math.round(a.high)})`); }
      else if (spread > 1.5) { risky++; reasons.push(`price swings a lot (A$${Math.round(a.low)}–${Math.round(a.high)})`); }
    }
    if (a.low && a.low < a.aud * 0.72 && a.n >= 4) reasons.push(`copies have sold for as little as A$${Math.round(a.low)} — worth waiting for one`);
    // Recent Australian sales trend (newest first in the list).
    if (a.recent.length >= 4) {
      withSales++;
      const half = Math.floor(a.recent.length / 2);
      const med = (arr) => { const v = arr.map((r) => r[0]).sort((p1, p2) => p1 - p2); return v[Math.floor(v.length / 2)]; };
      const newer = med(a.recent.slice(0, half)), older = med(a.recent.slice(half));
      const chg = (newer - older) / older * 100;
      if (chg > 8) { score += Math.min(14, 4 + chg * 0.4); reasons.push(`recent Australian sales up ${pct(chg)} on the ones before`); }
      else if (chg < -10) { score -= 6; reasons.push(`recent Australian sales down ${pct(chg)}`); }
    }
    // Card fundamentals (lighter weight).
    const chase = CHASE.find(([re]) => re.test(m.rarity || ''));
    const vintage = (set[3] || '9') < '2004';
    if (chase) { score += chase[1] * 0.6; reasons.push(chase[2]); } else if (vintage) { score += 7; reasons.push('vintage'); }
    if (TOP_MONS.test(m.name)) { score += 9; reasons.push(`${m.name.match(TOP_MONS)[1].replace(/^./, (c) => c.toUpperCase())} — among the most collected Pokémon`); }
    else if (FAN_MONS.test(m.name)) score += 4;
    if (age != null && age < 4) { risky++; reasons.push('new set — still being printed'); }
    const ageDays = (Date.parse(date) - Date.parse(a.date)) / 86400000;
    if (score < 14) continue; // the rest can't make the list even with good supply news
    picks.push({ key: t.key, q: t.q, n: t.n, t: t.t, s: t.set, e: (set[0] || '').replace(/^Scarlet & Violet[—–-]?\s*(?=\S)/, '').replace(/^Base$/, 'Base Set').replace(/ Black Star Promos$/, ''), id: t.id, name: m.name, number: m.number, set: set[0] || m.setId, rarity: m.rarity, finish: t.q.match(/(reverse holo|1st edition)$/i)?.[1] ?? null,
      aud: Math.round(a.aud), usAud: Math.round(t.aud), sales: a.n, auDate: a.date, stale: ageDays > 30,
      score, risky, reasons });
  }
  // Supply in Australia right now (eBay AU Buy It Now, via the worker's /listings — eBay's free
  // Browse API, no SoldComps credits): for the best candidates.
  picks.sort((p1, p2) => p2.score - p1.score);
  const check = picks.slice(0, LISTING_CHECKS);
  let listed = 0;
  const queue = [...check];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const p = queue.shift();
      const u = new URL('listings', WORKER);
      u.search = new URLSearchParams({ q: p.q, n: p.n, ...(p.t && { t: p.t }), ...(p.s && { s: p.s }), ...(p.e && { e: p.e }) });
      let r = null;
      try { r = await (await fetch(u, { headers: HEADERS })).json(); } catch { /* skip */ }
      if (!r?.ok) continue;
      listed++;
      const c = r.cheapest?.[0];
      p.forSale = { count: r.count, ...(c && { aud: Math.round(c.aud), url: c.url }) };
      if (!r.count) { p.score += 8; p.reasons.push('none for sale in Australia right now — scarce'); }
      else {
        if (r.count <= 2) { p.score += 5; p.reasons.push(`only ${r.count} for sale in Australia right now`); }
        else if (r.count >= 15) { p.score -= 5; p.reasons.push(`plenty for sale in Australia (${r.count})`); }
        if (c.aud >= p.aud * 1.02) { p.score += 8; p.reasons.push(`cheapest Australian listing (A$${Math.round(c.aud)}) is above what it sells for — demand ahead of supply`); }
        else if (c.aud < p.aud * 0.5) p.reasons.push(`one listed at only A$${Math.round(c.aud)} — suspiciously cheap, check it's real and the right card`);
        else if (c.aud <= p.aud * 0.85) { p.score += 6; p.deal = true; p.reasons.push(`a copy is listed for A$${Math.round(c.aud)} — ${Math.round((1 - c.aud / p.aud) * 100)}% below what it usually sells for`); }
      }
    }
  }));
  for (const p of picks) {
    p.risk = !p.risky && p.sales >= 5 ? 'safer' : 'riskier';
    p.score = Math.round(p.score);
    delete p.risky; delete p.q; delete p.n; delete p.t; delete p.s; delete p.e;
  }
  picks.splice(0, picks.length, ...picks.filter((p) => p.score >= 24));
  picks.sort((p1, p2) => p2.score - p1.score || p2.aud - p1.aud);
  const perSet = new Map();
  const out = [];
  for (const p of picks) {
    const n = perSet.get(p.set) ?? 0;
    if (n >= 3) continue;
    perSet.set(p.set, n + 1);
    out.push(p);
    if (out.length >= 200) break;
  }
  for (const p of picks) if (p.forSale && byId.has(p.id)) byId.get(p.id).forSale = p.forSale;
  return { picks: out, byId, rate, info: { priced, withSales, rate, exported: Object.keys(exported).length, asOf: pre.asOf ?? null, listed } };
}

if (import.meta.url === `file://${process.argv[1]}`) await buildPicks();
