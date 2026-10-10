/* Developer mode — hidden. Tap the "PokeScan" title 7 times quickly, then enter the PIN.
 * Settings are kept on this device only (localStorage) and change nothing for anyone else.
 * The PIN is stored as a SHA-256 hash; it keeps casual users out, nothing more (the app is
 * public code). Loaded before app.js; app.js reads `devCfg` through devVal() and calls
 * devFrame() after each scanned frame, and works the same without this file.
 *
 *   Scan tuning: confidence (best score, gap to runner-up), frames to lock in, bulk-add
 *                timing, an on-screen overlay with the top matches and time per frame.
 *   Data tools:  clear saved AU sold answers / the offline cache, reload data, storage used,
 *                export debug info (no collection contents).
 *   Status:      app version, price data date, AU sold data, card index, storage, device. */

const DEV_KEY = 'pokescan.dev.v1';
const DEV_PIN_HASH = '87d657b0335fa42f30da02abe25ed7cd6a6b95125fab738ac41d69d40843e7a5'; // sha256('pokescan-dev:' + PIN)
const DEV_UNLOCKED = 'pokescan.dev.unlocked'; // sessionStorage: no PIN again until the app is closed
const DEV_DEFAULTS = { minScore: 0.88, minGap: 0.015, lockFrames: 2, bulkAbsentMs: 1000, bulkRepeatMs: 2000, overlay: false };
const DEV_LIMITS = {
  minScore: [0.7, 0.98, 0.005, 'Best match score needed', 'Higher = fewer wrong answers, more "pick the card"'],
  minGap: [0, 0.1, 0.005, 'Lead over the runner-up', 'How far ahead of the 2nd match the best must be'],
  lockFrames: [1, 6, 1, 'Frames in a row to lock in', 'Confident frames needed before showing the card'],
  bulkAbsentMs: [200, 5000, 100, 'Bulk: card out of view (ms)', 'Before the same card can be added again'],
  bulkRepeatMs: [500, 10000, 100, 'Bulk: repeat gap (ms)', 'Minimum time between adding the same card twice'],
};

const devCfg = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(DEV_KEY)) || {};
    const cfg = { ...DEV_DEFAULTS };
    for (const [k, [lo, hi]] of Object.entries(DEV_LIMITS)) {
      if (typeof saved[k] === 'number' && saved[k] >= lo && saved[k] <= hi) cfg[k] = saved[k];
    }
    cfg.overlay = saved.overlay === true;
    return cfg;
  } catch {
    return { ...DEV_DEFAULTS };
  }
})();
function devSave() {
  try { localStorage.setItem(DEV_KEY, JSON.stringify(devCfg)); } catch { /* storage blocked */ }
}
const devChanged = () => Object.keys(DEV_DEFAULTS).some((k) => devCfg[k] !== DEV_DEFAULTS[k]);

/* ---------- Unlock: 7 quick taps on the title, then the PIN ---------- */

(() => {
  const title = document.querySelector('.topbar h1');
  if (!title) return;
  let taps = [];
  title.addEventListener('click', () => {
    const now = Date.now();
    taps = [...taps.filter((t) => now - t < 3000), now];
    if (taps.length < 7) return;
    taps = [];
    let unlocked = false;
    try { unlocked = sessionStorage.getItem(DEV_UNLOCKED) === '1'; } catch { /* storage blocked */ }
    if (unlocked) devOpen(); else devAskPin();
  });
})();

async function devHash(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function devAskPin() {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet dev-pin';
  dlg.innerHTML = `<form method="dialog"><button class="close" aria-label="Close">✕</button></form>
    <form class="dev-pin-form"><label>PIN<input type="password" inputmode="numeric" autocomplete="off" maxlength="12" required></label>
    <button class="btn primary" type="submit">Open</button><p class="dev-msg" aria-live="polite"></p></form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const input = dlg.querySelector('input');
  dlg.querySelector('.dev-pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!crypto?.subtle) { dlg.querySelector('.dev-msg').textContent = 'Needs HTTPS (or localhost).'; return; }
    if (await devHash(`pokescan-dev:${input.value}`) === DEV_PIN_HASH) {
      try { sessionStorage.setItem(DEV_UNLOCKED, '1'); } catch { /* storage blocked */ }
      dlg.close();
      devOpen();
    } else {
      input.value = '';
      dlg.querySelector('.dev-msg').textContent = 'Wrong PIN';
    }
  });
  dlg.showModal();
  input.focus();
}

/* ---------- The panel ---------- */

const devEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const devBytes = (n) => (n == null ? '—' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

async function devStatus() {
  const s = {};
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };
  // The version is the offline cache name in sw.js ("pokescan-v39").
  s.version = (await safe(async () => (await (await fetch('sw.js', { cache: 'no-cache' })).text()).match(/CACHE = '([^']+)'/)?.[1])) || '?';
  s.serviceWorker = navigator.serviceWorker?.controller ? 'active' : 'not active';
  const snap = await safe(() => getSnapshot());
  s.prices = snap?.built ? new Date(snap.built).toLocaleString('en-AU') : 'not loaded';
  s.pricedCards = snap?.cards ? Object.keys(snap.cards).length : null;
  s.cards = db.enCount ?? db.cards.length;
  s.japanese = db.enCount != null ? db.cards.length - db.enCount : 'not loaded yet';
  s.jpScan = (() => { try { return localStorage.getItem('pokescan.scanJapanese') === '1' ? 'on' : 'off'; } catch { return '?'; } })();
  await safe(() => auPreReady);
  s.auNightly = auPre ? Object.keys(auPre).length : 0;
  s.auNightlyPriced = auPre ? Object.values(auPre).filter((r) => r[0] != null).length : 0;
  s.auDevice = Object.keys(auSoldStore()).length;
  s.collection = (() => {
    try {
      const c = JSON.parse(localStorage.getItem(COLLECTION_KEY));
      return Array.isArray(c) ? c.length : c ? Object.keys(c).length : 0;
    } catch { return '?'; }
  })();
  const est = await safe(() => navigator.storage.estimate());
  s.storageUsed = est?.usage ?? null;
  s.storageQuota = est?.quota ?? null;
  s.localStorage = (() => {
    try { let n = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) || '').length; } return n * 2; } catch { return null; }
  })();
  s.online = navigator.onLine;
  s.secure = window.isSecureContext;
  s.screen = `${innerWidth}×${innerHeight} @${devicePixelRatio}x`;
  s.userAgent = navigator.userAgent;
  return s;
}

function devRow(label, value) {
  return `<div class="dev-row"><span>${devEsc(label)}</span><b>${devEsc(value)}</b></div>`;
}

async function devRenderStatus(box) {
  box.innerHTML = '<p class="dev-msg">Loading…</p>';
  const s = await devStatus();
  box.innerHTML = [
    devRow('App version', s.version),
    devRow('Offline worker', s.serviceWorker),
    devRow('Price data built', s.prices),
    devRow('Cards with a price', s.pricedCards?.toLocaleString() ?? '—'),
    devRow('Card index', `${s.cards.toLocaleString()} English · ${typeof s.japanese === 'number' ? s.japanese.toLocaleString() : s.japanese} Japanese`),
    devRow('Scan Japanese', s.jpScan),
    devRow('AU sold — nightly file', `${s.auNightly.toLocaleString()} (${s.auNightlyPriced.toLocaleString()} priced)`),
    devRow('AU sold — saved on device', s.auDevice.toLocaleString()),
    devRow('Collection entries', s.collection),
    devRow('Storage used', `${devBytes(s.storageUsed)} of ${devBytes(s.storageQuota)} · settings ${devBytes(s.localStorage)}`),
    devRow('Online · HTTPS', `${s.online ? 'yes' : 'no'} · ${s.secure ? 'yes' : 'no'}`),
    devRow('Screen', s.screen),
  ].join('');
}

function devRenderTuning(box) {
  const field = (k) => {
    const [lo, hi, step, label, hint] = DEV_LIMITS[k];
    return `<label class="dev-field"><span>${label} <small>(default ${DEV_DEFAULTS[k]})</small></span>
      <input type="number" data-k="${k}" min="${lo}" max="${hi}" step="${step}" value="${devCfg[k]}">
      <small>${hint}</small></label>`;
  };
  box.innerHTML = Object.keys(DEV_LIMITS).map(field).join('')
    + `<label class="dev-check"><input type="checkbox" data-k="overlay" ${devCfg.overlay ? 'checked' : ''}> Show match scores and time per frame on the camera</label>
       <button type="button" class="btn ghost" data-act="reset">Reset scan settings</button>`;
  box.querySelectorAll('input[type=number]').forEach((inp) => inp.addEventListener('change', () => {
    const [lo, hi] = DEV_LIMITS[inp.dataset.k];
    const v = Number(inp.value);
    if (!Number.isFinite(v) || v < lo || v > hi) { inp.value = devCfg[inp.dataset.k]; toast(`Must be ${lo}–${hi}`); return; }
    devCfg[inp.dataset.k] = v;
    devSave();
    devBadge();
  }));
  box.querySelector('[data-k=overlay]').addEventListener('change', (e) => {
    devCfg.overlay = e.target.checked;
    devSave();
    if (!devCfg.overlay) devOverlay()?.remove();
    devBadge();
  });
  box.querySelector('[data-act=reset]').addEventListener('click', () => {
    Object.assign(devCfg, DEV_DEFAULTS);
    devSave();
    devOverlay()?.remove();
    devRenderTuning(box);
    devBadge();
    toast('Scan settings back to normal');
  });
}

async function devExport() {
  const info = { exported: new Date().toISOString(), settings: devCfg, status: await devStatus(), lastFrame: devLast };
  const blob = new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pokescan-debug-${Date.now()}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function devClearCaches() {
  try { await Promise.all((await caches.keys()).filter((k) => k.startsWith('pokescan-')).map((k) => caches.delete(k))); } catch { /* none */ }
  try { await Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => r.unregister())); } catch { /* none */ }
}

function devRenderTools(box) {
  box.innerHTML = `
    <button type="button" class="btn ghost" data-act="au">Clear saved AU sold answers (this device)</button>
    <button type="button" class="btn ghost" data-act="prices">Clear saved live prices &amp; exchange rate</button>
    <button type="button" class="btn ghost" data-act="reload">Reload card &amp; price data now</button>
    <button type="button" class="btn ghost" data-act="cache">Clear offline cache &amp; reload app</button>
    <button type="button" class="btn ghost" data-act="export">Export debug info (file)</button>
    <p class="dev-msg">Your collection is never touched by these.</p>`;
  box.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'au') {
      try { localStorage.removeItem(AU_SOLD_CACHE_KEY); } catch { /* storage blocked */ }
      auSoldMem = null;
      toast('Saved AU sold answers cleared');
    } else if (act === 'prices') {
      try { localStorage.removeItem(PRICE_CACHE_KEY); localStorage.removeItem(RATE_CACHE_KEY); } catch { /* storage blocked */ }
      toast('Live prices and rate will be fetched again');
    } else if (act === 'reload') {
      toast('Reloading data…');
      // The offline worker fetches network-first, so a reload gets the newest files.
      await Promise.all(['data/prices.json', 'data/cards.json', 'data/sealed.json', 'data/au-sold.json']
        .map((f) => fetch(f, { cache: 'reload' }).catch(() => null)));
      location.reload();
    } else if (act === 'cache') {
      if (!confirm('Clear the offline cache and reload? (Your collection stays.)')) return;
      await devClearCaches();
      location.reload();
    } else if (act === 'export') {
      devExport();
    }
  });
}

/* ---------- Buy ideas (data/picks.json, built daily by tools/picks.mjs) ---------- */

async function devRenderPicks(box) {
  box.innerHTML = '<p class="dev-msg"><span class="spinner"></span>Loading…</p>';
  const [picks, rate, sealed] = await Promise.all([fetchRetry('data/picks.json', { tries: 3 }).catch(() => null), getAudRate(), getSealed(), dbReady.catch(() => {})]);
  if (!picks) { box.innerHTML = '<p class="dev-msg">No buy ideas yet — they\'re built with the daily price update.</p>'; return; }
  const BUDGET_KEY = 'pokescan.dev.budget';
  let budget = null;
  try { budget = Number(localStorage.getItem(BUDGET_KEY)) || null; } catch { /* no storage */ }
  const view = { kind: 'cards', risk: 'all' };
  const audOf = (p) => (view.kind === 'au' ? p.aud : p.usd * rate.rate);
  const seg = (name, opts) => `<div class="seg dev-seg" data-seg="${name}">${opts.map(([v, l], i) => `<button type="button" data-v="${v}" class="${i ? '' : 'active'}">${l}</button>`).join('')}</div>`;
  box.innerHTML = `
    <p class="dev-msg">Cards and sealed product that look likely to rise, or are already rising, and why. Built ${devEsc(new Date(picks.built).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))} from TCGplayer prices and listings${picks.days < 14 ? ` — price history only goes back to ${devEsc(shortDate(picks.since))}, so trends count for little yet (better each week)` : ''}.</p>
    <div class="dev-picks-tools">${seg('kind', [['cards', 'Cards'], ['sealed', 'Sealed'], ...(picks.au ? [['au', 'AU sold']] : [])])}
      ${seg('risk', [['all', 'All'], ['safer', 'Safer'], ['riskier', 'Riskier']])}</div>
    <label class="dev-budget">Max price A$ <input type="number" inputmode="decimal" min="0" step="1" placeholder="any" value="${budget ?? ''}" data-budget>
      <span>${[20, 50, 100, 250].map((v) => `<button type="button" class="chip" data-b="${v}">${v}</button>`).join('')}<button type="button" class="chip" data-b="">any</button></span></label>
    <p class="dev-msg" data-au-note hidden>Ranked on what each card actually sells for on eBay Australia (near-mint sales, last 90 days)${picks.auInfo ? ` — ${picks.auInfo.priced.toLocaleString()} cards with an Australian price, checked up to ${devEsc(shortDate(picks.auInfo.asOf || picks.built.slice(0, 10)))}, plus every card looked up in the app since` : ''}. No new searches are made for this (no credits). "Cheaper in Australia" can also mean sellers here list worn copies as near mint — check the photos.</p>
    <div class="dev-picks" data-list></div>
    <p class="dev-msg">Not financial advice — reasons to look closer, not guarantees. Prices are TCGplayer (US) market prices in AUD; check Australian sold prices before buying.</p>`;
  const draw = () => {
    const list = box.querySelector('[data-list]');
    box.querySelector('[data-au-note]').hidden = view.kind !== 'au';
    const all = picks[view.kind].filter((p) => (view.risk === 'all' || p.risk === view.risk) && (!budget || audOf(p) <= budget));
    const items = all.slice(0, 40);
    list.innerHTML = items.length ? '' : `<p class="dev-msg">None in this list today${budget ? ` under A$${budget} — try a higher limit` : ''}.</p>`;
    box.querySelectorAll('[data-b]').forEach((b) => b.classList.toggle('active', String(budget ?? '') === b.dataset.b));
    for (const p of items) {
      const isCard = view.kind !== 'sealed';
      const item = isCard ? db.byId?.get(p.id) : sealed.byKey.get(p.key);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dev-pick';
      row.innerHTML = `
        <img src="${devEsc(item?.image ?? '')}" alt="" loading="lazy">
        <div class="meta">
          <div class="name">${devEsc(p.name)}</div>
          <div class="sub">${devEsc([p.set, p.number && `#${p.number}`, p.finish || p.type, p.rarity].filter(Boolean).join(' · '))}</div>
          <ul>${p.reasons.slice(0, 4).map((r) => `<li>${devEsc(r)}</li>`).join('')}</ul>
        </div>
        <div class="side">${view.kind === 'au'
          ? `<b>${formatAudPlain(p.aud)}</b><small>AU sold · ${p.sales} sales</small><small>US ${formatAudPlain(p.usAud)}</small>${p.forSale ? `<small>${p.forSale.count ? `${p.forSale.count} for sale from ${formatAudPlain(p.forSale.aud)}` : 'none for sale'}</small>` : ''}${p.deal ? '<small class="deal">🛒 deal listed</small>' : ''}${p.stale ? '<small>(old price)</small>' : ''}`
          : `<b>${formatAud(p.usd, rate.rate)}</b>`}<span class="risk ${p.risk}">${p.risk === 'safer' ? 'Safer' : 'Riskier'}</span><small>score ${p.score}</small></div>`;
      row.addEventListener('click', () => {
        if (isCard && item) openDetail(item);
        else if (item) openSealedDetail(sealedEntry(item));
      });
      list.appendChild(row);
    }
  };
  const setBudget = (v) => {
    budget = Number(v) > 0 ? Number(v) : null;
    try { if (budget) localStorage.setItem(BUDGET_KEY, String(budget)); else localStorage.removeItem(BUDGET_KEY); } catch { /* no storage */ }
    box.querySelector('[data-budget]').value = budget ?? '';
    draw();
  };
  box.querySelector('[data-budget]').addEventListener('change', (e) => setBudget(e.target.value));
  box.querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); setBudget(b.dataset.b); }));
  box.querySelectorAll('[data-seg]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    view[g.dataset.seg] = b.dataset.v;
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  }));
  draw();
}

function devOpen() {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet dev-sheet';
  dlg.innerHTML = `<form method="dialog"><button class="close" aria-label="Close">✕</button></form>
    <h2>Developer mode</h2>
    <p class="dev-msg">Only changes this device.</p>
    <details open><summary>Status</summary><div data-box="status"></div>
      <button type="button" class="btn ghost" data-act="refresh">Refresh</button></details>
    <details><summary>Scan tuning</summary><div data-box="tuning"></div></details>
    <details><summary>Buy ideas</summary><div data-box="picks"></div></details>
    <details><summary>Data tools</summary><div data-box="tools"></div></details>
    <button type="button" class="btn ghost" data-act="lock">Lock developer mode</button>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const box = (n) => dlg.querySelector(`[data-box=${n}]`);
  devRenderStatus(box('status'));
  devRenderTuning(box('tuning'));
  devRenderTools(box('tools'));
  // Buy ideas load when opened (a bigger file).
  dlg.querySelector('[data-box=picks]').closest('details').addEventListener('toggle', function once(e) {
    if (!e.target.open) return;
    e.target.removeEventListener('toggle', once);
    devRenderPicks(box('picks'));
  });
  dlg.querySelector('[data-act=refresh]').addEventListener('click', () => devRenderStatus(box('status')));
  dlg.querySelector('[data-act=lock]').addEventListener('click', () => {
    try { sessionStorage.removeItem(DEV_UNLOCKED); } catch { /* storage blocked */ }
    dlg.close();
    toast('Developer mode locked');
  });
  dlg.showModal();
}

/* A small dot next to the title while scan settings differ from normal, so a tuned phone
 * isn't mistaken for a bug. Only you would know what it means. */
function devBadge() {
  const title = document.querySelector('.topbar h1');
  if (title) title.classList.toggle('dev-tuned', devChanged());
}
devBadge();

/* ---------- Scan overlay ---------- */

let devLast = null;
const devOverlay = () => document.getElementById('devOverlay');
function devFrame(matches, ms) {
  const [a, b] = matches || [];
  devLast = { ms: Math.round(ms), top: (matches || []).slice(0, 3).map((m) => ({ id: m.card.id, name: m.card.name, score: +m.score.toFixed(3) })) };
  if (!devCfg.overlay) return;
  let el = devOverlay();
  if (!el) {
    el = document.createElement('div');
    el.id = 'devOverlay';
    el.className = 'dev-overlay';
    (document.getElementById('cameraWrap') || document.body).appendChild(el);
  }
  const gap = a ? a.score - (b?.score ?? 0) : 0;
  const ok = a && a.score >= devCfg.minScore && gap >= devCfg.minGap;
  el.innerHTML = devLast.top.map((m, i) => `${i ? '' : ok ? '✓ ' : '· '}${m.score.toFixed(3)} ${devEsc(m.name)}`).join('<br>')
    + `<br>gap ${gap.toFixed(3)} · ${devLast.ms} ms/frame`;
}
