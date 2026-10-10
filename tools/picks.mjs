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
  const sets = cardsMeta.sets; // id → [name, series, total, releaseDate]
  const days = history.dates.length;

  /* ---------- Cards ---------- */
  const cardPicks = [];
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
    if (t && t.days >= 3 && Math.abs(t.chg) > 60) { thin = true; risky++; reasons.push(`price jumped ${pct(t.chg)} in days — few sales, unreliable`); }
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
    if (cards.length >= 60) break;
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
    if (score < 24) continue;
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
    if (sealed.length >= 40) break;
  }

  const out = { built: new Date().toISOString(), since: history.dates[0] ?? date, days, currency: 'USD', cards, sealed };
  await writeFile(dataFile('picks.json'), JSON.stringify(out));
  console.log(`Picks: ${cards.length} cards (${cards.filter((c) => c.risk === 'safer').length} safer), ${sealed.length} sealed (${sealed.filter((c) => c.risk === 'safer').length} safer); ${lst.size} listings`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildPicks();
