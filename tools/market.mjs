// Price history and the Market tab's data, updated by tools/update-prices.mjs each day.
//
//   data/history.json   last HISTORY_DAYS daily prices (USD cents) of everything worth ≥ MIN_USD:
//                       { dates: ['2026-10-06', …], items: { key: [cents|null, …] } }
//   data/extremes.json  highest / lowest price ever seen per item, since tracking began:
//                       { since, items: { key: [hiCents, hiDate, loCents, loDate] } }
//   data/market.json    small, precomputed lists for the app: biggest risers / fallers over
//                       1, 7 and 30 days, and items at their highest / lowest right now.
//
// Keys: card id + ":" + finish ("sv8pt5-161:h", the same finish codes as prices.json), or
// "s" + a sealed product's TCGplayer id ("s593355"). Keying by finish means a card whose
// "main" finish changes (a source adds a holo price) can't show up as a fake mover.
// Backfill from git history of data/prices.json: node tools/market.mjs --backfill
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const HISTORY_DAYS = 31;
const MIN_USD = 1; // cheaper items aren't tracked (noisy, and would bloat the history)
const MOVER_MIN = { cards: 2, sealed: 5 }; // USD, now and then, to count as a mover
const LIST_SIZE = 25;
const WINDOWS = [1, 7, 30];

const dataFile = (name) => new URL(`../data/${name}`, import.meta.url);
const readJson = async (name, fallback) => {
  try { return JSON.parse(await readFile(dataFile(name), 'utf8')); } catch { return fallback; }
};

// A card's main finish: the same order as the app's prices.js.
const MAIN_FINISH = ['h', 'n', '1h', 'uh', '1n', 'u', 'r'];
const mainFinish = (row) => MAIN_FINISH.find((k) => row?.[k] != null) ?? null;

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/* Record today's prices and rebuild market.json. `cards` = prices.json's cards; `sealed` =
 * sealed.json's items, or null when today's sealed prices aren't known. */
export async function updateMarket(cards, sealed, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const now = new Map();
  for (const [id, row] of Object.entries(cards)) {
    const f = mainFinish(row);
    if (f && row[f] >= MIN_USD) now.set(`${id}:${f}`, Math.round(row[f] * 100));
  }
  for (const s of sealed ?? []) if (s.usd >= MIN_USD) now.set(`s${s.id}`, Math.round(s.usd * 100));

  // History: one column per day (a re-run on the same day replaces that day's column).
  const history = await readJson('history.json', { dates: [], items: {} });
  let col = history.dates.indexOf(date);
  if (col < 0) {
    if (history.dates.length && date < history.dates.at(-1)) return; // older than what we have
    history.dates.push(date);
    col = history.dates.length - 1;
    for (const series of Object.values(history.items)) series.push(null);
  }
  for (const [key, cents] of now) {
    history.items[key] ??= Array(history.dates.length).fill(null);
    history.items[key][col] = cents;
  }
  // Sealed prices unknown today: carry yesterday's forward rather than dropping them.
  if (!sealed && col > 0) {
    for (const [key, series] of Object.entries(history.items)) {
      if (key[0] === 's' && series[col] == null) series[col] = series[col - 1];
    }
  }
  const drop = Math.max(0, history.dates.length - HISTORY_DAYS);
  if (drop) {
    history.dates.splice(0, drop);
    for (const series of Object.values(history.items)) series.splice(0, drop);
  }
  for (const [key, series] of Object.entries(history.items)) {
    if (series.every((v) => v == null)) delete history.items[key];
  }

  // All-time extremes.
  const extremes = await readJson('extremes.json', { since: date, items: {} });
  for (const [key, cents] of now) {
    const e = extremes.items[key];
    if (!e) {
      extremes.items[key] = [cents, date, cents, date];
      continue;
    }
    if (cents >= e[0]) { e[0] = cents; e[1] = date; }
    if (cents <= e[2]) { e[2] = cents; e[3] = date; }
  }

  // Movers: compare today with the latest day at least N days ago (or the oldest day there
  // is, while history is still short — the app shows which date it's comparing with).
  const kind = (key) => (key[0] === 's' ? 'sealed' : 'cards');
  const movers = {};
  for (const days of WINDOWS) {
    let from = -1;
    for (let i = col - 1; i >= 0; i--) {
      if (daysBetween(history.dates[i], date) >= days) { from = i; break; }
    }
    if (from < 0 && col > 0) from = 0;
    if (from < 0) { movers[days] = null; continue; }
    const lists = { cards: [], sealed: [] };
    for (const [key, series] of Object.entries(history.items)) {
      const a = series[from], b = series[col];
      const min = MOVER_MIN[kind(key)] * 100;
      if (a == null || b == null || a < min || b < min || a === b) continue;
      lists[kind(key)].push([key, b, a, Math.round(((b - a) / a) * 1000) / 10]);
    }
    const pick = (list, dir) => list.filter((m) => dir * m[3] > 0)
      .sort((x, y) => dir * (y[3] - x[3])).slice(0, LIST_SIZE);
    movers[days] = {
      from: history.dates[from],
      cards: { up: pick(lists.cards, 1), down: pick(lists.cards, -1) },
      sealed: { up: pick(lists.sealed, 1), down: pick(lists.sealed, -1) },
    };
  }

  // At their highest / lowest since tracking began (only items whose price has moved).
  const extremesNow = (side) => {
    const out = { cards: [], sealed: [] };
    for (const [key, cents] of now) {
      const [hi, hiDate, lo, loDate] = extremes.items[key];
      if (hi === lo) continue;
      if (side === 'high' ? cents === hi && hiDate === date : cents === lo && loDate === date) {
        out[kind(key)].push([key, cents, side === 'high' ? lo : hi]);
      }
    }
    for (const k of Object.keys(out)) {
      out[k] = out[k].sort((a, b) => b[1] - a[1]).slice(0, LIST_SIZE);
    }
    return out;
  };

  await writeFile(dataFile('history.json'), JSON.stringify(history));
  await writeFile(dataFile('extremes.json'), JSON.stringify(extremes));
  await writeFile(dataFile('market.json'), JSON.stringify({
    asOf: date,
    since: extremes.since,
    currency: 'USD cents',
    movers,
    highs: extremesNow('high'),
    lows: extremesNow('low'),
  }));
  console.log(`Market: ${now.size} items tracked, history ${history.dates[0]} → ${date}`);
}

/* One-off: build history from every past daily snapshot in git (latest commit per day). */
async function backfill() {
  const log = execFileSync('git', ['log', '--reverse', '--format=%H %cI', '--', 'data/prices.json'], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.split(' '));
  const byDay = new Map();
  for (const [sha, iso] of log) byDay.set(new Date(iso).toISOString().slice(0, 10), sha);
  for (const [date, sha] of byDay) {
    const snap = JSON.parse(execFileSync('git', ['show', `${sha}:data/prices.json`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
    let sealed = null;
    try {
      sealed = JSON.parse(execFileSync('git', ['show', `${sha}:data/sealed.json`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })).items;
    } catch { /* no sealed data that day */ }
    await updateMarket(snap.cards, sealed, { date });
  }
}

if (process.argv.includes('--backfill')) await backfill();
