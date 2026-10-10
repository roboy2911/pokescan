/* Want list: cards and sealed product you're after, with an optional target price (AUD).
 * Each item shows its current price and is flagged when it's at or below your target, or at
 * its lowest in the last month (data/history.json). Saved on this device and, when logged
 * in, to your account (account.js syncs it with the collection).
 *
 * Uses app.js (loaded first): loadCollection-style helpers, entryUsd, getTcgPrices, … */

const WANT_KEY = 'pokescan.wants.v1';      // [{ key, ...card fields, variant, target, addedAt }]
const WANT_SEEN_KEY = 'pokescan.wantsSeen.v1'; // { key: price (AUD) when last told it hit }

function loadWants() {
  try {
    const list = JSON.parse(localStorage.getItem(WANT_KEY));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.key === 'string') : [];
  } catch { return []; }
}
function saveWants(list) {
  try { localStorage.setItem(WANT_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  if (typeof accountChanged === 'function') accountChanged();
  showWantCount();
}
const wantOf = (id) => loadWants().find((e) => e.key === id) ?? null;

function addWant(item, variant = null) {
  const list = loadWants();
  if (list.some((e) => e.key === item.id)) return;
  list.unshift({ ...pickCard(item), key: item.id, variant: item.kind === 'sealed' ? null : variant ?? null, target: null, addedAt: new Date().toISOString() });
  saveWants(list);
}
function updateWant(id, fn) {
  const list = loadWants();
  const e = list.find((x) => x.key === id);
  if (!e) return;
  fn(e);
  saveWants(list);
}
function removeWant(id) {
  saveWants(loadWants().filter((e) => e.key !== id));
}

/* Parse "A$ 45", "45.50", "$1,200" → 45 / 45.5 / 1200; blank → null; junk → NaN. */
function parseAud(text) {
  const t = String(text ?? '').replace(/[a$\s,]/gi, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : NaN;
}

/* ---------- In the card / sealed sheet ---------- */

const wantBoxHtml = () => '<div class="want-box" id="wantBox"></div>';

/* `getVariant`: the finish shown in the sheet right now (cards). */
function wireWant(item, getVariant = () => null) {
  const box = $('wantBox');
  if (!box) return;
  const draw = () => {
    const w = wantOf(item.id);
    if (!w) {
      box.innerHTML = '<button type="button" class="btn ghost" id="wantAdd">☆ Add to want list</button>';
      $('wantAdd').addEventListener('click', () => {
        addWant(item, getVariant());
        toast(`${item.name} is on your want list`);
        draw();
        box.querySelector('input')?.focus();
        if (wantMode) renderWants();
      });
      return;
    }
    box.innerHTML = `<div class="want-on">
        <span class="want-star">★ On your want list</span>
        <label class="want-target">Tell me at or below
          <span class="aud-input">A$<input id="wantTarget" inputmode="decimal" placeholder="any price" value="${w.target ?? ''}" aria-label="Target price in Australian dollars"></span></label>
        <button type="button" class="link-btn" id="wantRemove">Remove</button>
      </div>`;
    const input = $('wantTarget');
    const save = () => {
      const v = parseAud(input.value);
      if (Number.isNaN(v)) { input.value = w.target ?? ''; toast('Type a price, like 45 or 45.50'); return; }
      updateWant(item.id, (e) => { e.target = v; if (item.kind !== 'sealed') e.variant = getVariant() ?? e.variant; });
      if (wantMode) renderWants();
    };
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    $('wantRemove').addEventListener('click', () => {
      removeWant(item.id);
      toast(`Removed ${item.name} from your want list`);
      draw();
      if (wantMode) renderWants();
    });
  };
  draw();
}

/* ---------- Prices and alerts ---------- */

/* Current AUD price of each want, and whether it's a hit: { key: { aud, hit, low } }. */
async function wantPrices(list = loadWants()) {
  if (!list.length) return {};
  await dbReady.catch(() => {});
  const ids = [...new Set(list.filter((e) => e.kind !== 'sealed').map((e) => e.id))];
  const [prices, rate, sealed, history] = await Promise.all([
    getTcgPrices(ids), getAudRate(), list.some((e) => e.kind === 'sealed') ? getSealed() : null, getHistory()]);
  const out = {};
  for (const e of list) {
    const usd = entryUsd(e, prices, sealed, rate);
    if (usd == null) { out[e.key] = { aud: null }; continue; }
    const aud = usd * rate.rate;
    // At its lowest in the last month: today's TCGplayer price is the lowest in history (and
    // the price has moved, so a flat line isn't "lowest").
    let low = false;
    const hk = history?.items && historyKey(e, history.items);
    if (hk) {
      const series = history.items[hk].filter((v) => v != null);
      const now = series.at(-1);
      low = series.length >= 7 && now === Math.min(...series) && Math.max(...series) > now * 1.05;
    }
    out[e.key] = { aud, hit: e.target != null && aud <= e.target + 0.005, low };
  }
  // For sale now on eBay Australia: the cheapest near-mint copy, and whether it's at or under
  // the target (a copy you could buy today).
  await Promise.all(list.map(async (e) => {
    const { q, n, t, s } = ebaySoldQuery(e, e.variant);
    const r = await getListings(q, n, t, s).catch(() => null);
    if (!r?.ok || !r.count || !out[e.key]) return;
    const c = r.cheapest[0];
    out[e.key].listed = { aud: c.aud, url: c.url, count: r.count };
    if (e.target != null && c.aud <= e.target + 0.005) out[e.key].listedHit = true;
  }));
  return out;
}

/* On opening the app: tell once about items that have dropped to their target. */
async function checkWantAlerts() {
  const list = loadWants().filter((e) => e.target != null);
  if (!list.length) return;
  const got = await wantPrices(list);
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(WANT_SEEN_KEY)) || {}; } catch { /* none */ }
  const fresh = list.filter((e) => got[e.key]?.hit && !(seen[e.key] && got[e.key].aud >= seen[e.key] - 0.005));
  // A copy listed on eBay AU at or under the target (told once per price).
  const freshListed = list.filter((e) => got[e.key]?.listedHit && !(seen[`l:${e.key}`] && got[e.key].listed.aud >= seen[`l:${e.key}`] - 0.005));
  const next = {};
  for (const e of list) {
    if (got[e.key]?.hit) next[e.key] = Math.min(got[e.key].aud, seen[e.key] ?? Infinity);
    if (got[e.key]?.listedHit) next[`l:${e.key}`] = Math.min(got[e.key].listed.aud, seen[`l:${e.key}`] ?? Infinity);
  }
  try { localStorage.setItem(WANT_SEEN_KEY, JSON.stringify(next)); } catch { /* storage full */ }
  showWantCount(list.filter((e) => got[e.key]?.hit || got[e.key]?.listedHit).length);
  if (freshListed.length) {
    const e = freshListed[0];
    toast(freshListed.length === 1
      ? `🛒 ${e.name} is for sale on eBay Australia for ${formatAudPlain(got[e.key].listed.aud)} — at or under your ${formatAudPlain(e.target)} target. See Collection → Want list`
      : `🛒 ${freshListed.length} items on your want list are for sale on eBay Australia at or under your target — see Collection → Want list`, 8000);
    return;
  }
  if (!fresh.length) return;
  toast(fresh.length === 1
    ? `★ ${fresh[0].name} is at your target price (${formatAudPlain(got[fresh[0].key].aud)}) — see Collection → Want list`
    : `★ ${fresh.length} items on your want list are at your target price — see Collection → Want list`, 7000);
}

/* ---------- The Want list view (Collection → Want list) ---------- */

let wantMode = false;
let wantToken = 0;

function showWantCount(hits = null) {
  const n = loadWants().length;
  const el = $('wantCount');
  if (el) el.textContent = n ? `(${n})` : '';
  if (hits !== null) document.querySelector('.nav-btn[data-view=collection]')?.classList.toggle('has-alert', hits > 0);
}

function setCollectionMode(mode) {
  wantMode = mode === 'wants';
  document.querySelectorAll('#collectionMode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === mode);
    b.setAttribute('aria-pressed', String(b.dataset.v === mode));
  });
  $('view-collection').classList.toggle('wants', wantMode);
  if (wantMode) renderWants();
  else refreshCollection();
}

async function renderWants() {
  const token = ++wantToken;
  const box = $('wantList');
  const list = loadWants();
  showWantCount();
  if (!list.length) {
    box.innerHTML = '<p class="empty">Nothing on your want list yet — open any card or sealed product and tap “☆ Add to want list”. Add a target price and the app tells you when it drops to it.</p>';
    return;
  }
  const draw = (got) => {
    box.innerHTML = '';
    // Hits first, then the newest.
    const rank = (g) => (g?.listedHit ? 2 : g?.hit ? 1 : 0);
    const order = [...list].sort((a, b) => rank(got?.[b.key]) - rank(got?.[a.key]));
    for (const e of order) {
      const g = got?.[e.key];
      const price = !got ? '…' : g?.aud == null ? 'No price' : formatAudPlain(g.aud);
      const row = cardRow(e.kind === 'sealed' ? { ...e, number: '', rarity: e.type, releaseDate: '' } : e, {
        onClick: () => (e.kind === 'sealed' ? openSealedDetail(e) : openDetail({ ...e, variant: e.variant })),
        extra: price,
      });
      row.classList.add('want-row');
      if (g?.hit || g?.listedHit) row.classList.add('hit');
      const note = document.createElement('div');
      note.className = 'want-note';
      note.innerHTML = [
        g?.hit ? '<b class="ok">✓ At your target</b>' : '',
        e.target != null ? `Target ${esc(formatAudPlain(e.target))}` : 'No target price',
        g?.low ? '<b class="ok">▼ Lowest this month</b>' : '',
        e.variant ? esc(variantLabel(e.variant)) : '',
      ].filter(Boolean).join(' · ');
      row.querySelector('.meta').appendChild(note);
      if (g?.listed) {
        // (A link can't sit inside the row's button: tapping this line opens the listing.)
        const a = document.createElement('span');
        a.className = `want-listed${g.listedHit ? ' hit' : ''}`;
        a.setAttribute('role', 'link');
        a.textContent = `🛒 ${g.listedHit ? 'Buy now: ' : ''}from ${formatAudPlain(g.listed.aud)} on eBay AU (${g.listed.count} for sale) ↗`;
        a.addEventListener('click', (ev) => { ev.stopPropagation(); window.open(g.listed.url, '_blank', 'noopener'); });
        row.querySelector('.meta').appendChild(a);
      }
      box.appendChild(row);
    }
  };
  draw(null);
  const got = await wantPrices(list).catch(() => ({}));
  if (token === wantToken) {
    draw(got);
    showWantCount(list.filter((e) => got[e.key]?.hit || got[e.key]?.listedHit).length);
  }
}

document.querySelectorAll('#collectionMode button').forEach((b) => b.addEventListener('click', () => setCollectionMode(b.dataset.v)));
showWantCount();
// A little after opening (prices load in the background anyway).
setTimeout(() => checkWantAlerts().catch(() => {}), 2500);
