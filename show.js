/* Card show mode: buying at a card show, market or shop.
 * On (the tag button by the camera): each scanned card shows big offer prices (70 / 80 / 90%
 * of its value), "Add to collection" becomes "Add to pile", and a bar keeps a running total of
 * the pile — what it's worth and what to offer. The pile sheet lists the cards, lets you remove
 * one or change the offer %, and "Bought" adds them all to the collection.
 * Prices come from what's saved on the phone (TCGplayer prices, and AU sold answers already
 * looked up), so it works without signal and costs no AU sold searches. Bulk add is turned off
 * while it's on (both would add cards). The pile is kept on this device until cleared. */

const SHOW_KEY = 'pokescan.show';
const SHOW_PILE_KEY = 'pokescan.showPile';
const SHOW_PCT_KEY = 'pokescan.showPct';
const SHOW_PCTS = [70, 80, 90];

const showMode = { on: false, pct: 80, pile: [], aud: null };
try {
  showMode.on = localStorage.getItem(SHOW_KEY) === '1';
  showMode.pct = Number(localStorage.getItem(SHOW_PCT_KEY)) || 80;
  showMode.pile = JSON.parse(localStorage.getItem(SHOW_PILE_KEY)) || [];
} catch { /* no storage */ }

const showSave = () => {
  try {
    localStorage.setItem(SHOW_KEY, showMode.on ? '1' : '0');
    localStorage.setItem(SHOW_PCT_KEY, String(showMode.pct));
    localStorage.setItem(SHOW_PILE_KEY, JSON.stringify(showMode.pile));
  } catch { /* no storage */ }
};
const showAud = (aud) => (aud == null ? '—' : formatAudPlain(aud));
const showRound = (aud) => Math.round(aud);
const showOfferAud = (aud) => `$${Math.round(aud).toLocaleString('en-AU')}`; // offers: whole dollars

function showModeOn() { return showMode.on; }

/* app.js showPrice: the value (AUD) of the card on screen, or null while unknown. */
function showModeOffers(aud) {
  showMode.aud = aud;
  const row = $('offerRow');
  row.hidden = !showMode.on;
  if (!showMode.on) return;
  row.innerHTML = aud == null ? '' : SHOW_PCTS.map((p) => `<button type="button" class="offer${p === showMode.pct ? ' active' : ''}" data-p="${p}">
      <small>${p}%</small><b>${showOfferAud(aud * p / 100)}</b></button>`).join('');
  row.querySelectorAll('.offer').forEach((b) => b.addEventListener('click', () => {
    showMode.pct = Number(b.dataset.p);
    showSave();
    showModeOffers(showMode.aud);
    showRenderBar();
  }));
}

/* app.js "Add" button while show mode is on. */
function showModeAdd(card, variant) {
  showMode.pile.push({
    id: card.id, variant, aud: showMode.aud, name: card.name,
    sub: `${card.setName} · ${numberText(card)}${variant ? ` · ${variantLabel(variant)}` : ''}`, image: card.image,
  });
  showSave();
  showRenderBar();
  toast(`${card.name} added to the pile`);
}

const showTotals = () => {
  const worth = showMode.pile.reduce((s, p) => s + (p.aud ?? 0), 0);
  return { n: showMode.pile.length, worth, offer: showRound(worth * showMode.pct / 100), unpriced: showMode.pile.filter((p) => p.aud == null).length };
};

function showRenderBar() {
  const bar = $('showBar');
  bar.hidden = !showMode.on;
  if (!showMode.on) return;
  const t = showTotals();
  $('showCount').textContent = t.n ? `Pile: ${t.n} card${t.n === 1 ? '' : 's'} · worth ${showAud(t.worth)}` : 'Show mode — scan a card to price it';
  $('showOffer').textContent = t.n ? `Offer ${showOfferAud(t.offer)} (${showMode.pct}%)${t.unpriced ? ` · ${t.unpriced} without a price` : ''}` : 'Add cards to build a pile and total';
  $('showPileBtn').disabled = !t.n;
}

function showUpdateButtons() {
  const btn = $('showBtn');
  btn.classList.toggle('on', showMode.on);
  btn.setAttribute('aria-pressed', String(showMode.on));
  els.addBtn.textContent = showMode.on ? '＋ Add to pile' : '＋ Add to collection';
  showRenderBar();
  showModeOffers(showMode.on ? showMode.aud : null);
}

$('showBtn').addEventListener('click', () => {
  showMode.on = !showMode.on;
  if (showMode.on && bulk.on) { // both would add cards
    bulk.on = false;
    try { localStorage.setItem(BULK_KEY, '0'); } catch { /* no storage */ }
    showBulk();
  }
  showSave();
  showUpdateButtons();
  toast(showMode.on ? 'Show mode on: scan a card for offer prices' : 'Show mode off');
});
// Turning bulk add on turns show mode off.
$('bulkBtn').addEventListener('click', () => {
  if (bulk.on && showMode.on) {
    showMode.on = false;
    showSave();
    showUpdateButtons();
  }
});

/* The pile: each card with its value, remove, offer %, Bought / Clear. */
function showOpenPile() {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet show-sheet';
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const draw = () => {
    const t = showTotals();
    dlg.innerHTML = `<form method="dialog"><button class="close" aria-label="Close">✕</button></form>
      <h2>Show pile</h2>
      <div class="show-total"><div><small>Worth</small><b>${showAud(t.worth)}</b></div>
        <div><small>Offer at
          <select class="show-pct" aria-label="Offer percentage">${[50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map((p) => `<option value="${p}"${p === showMode.pct ? ' selected' : ''}>${p}%</option>`).join('')}</select></small>
          <b class="offer-total">${showOfferAud(t.offer)}</b></div></div>
      ${t.unpriced ? `<p class="muted">${t.unpriced} card${t.unpriced === 1 ? ' has' : 's have'} no price and ${t.unpriced === 1 ? 'isn’t' : 'aren’t'} counted.</p>` : ''}
      <div class="results">${showMode.pile.map((p, i) => `<div class="card-row show-item">
        <img src="${esc(p.image)}" alt="" loading="lazy">
        <div class="meta"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.sub)}</div></div>
        <div class="mv"><b>${showAud(p.aud)}</b><span class="muted">${p.aud == null ? '' : `offer ${showOfferAud(p.aud * showMode.pct / 100)}`}</span></div>
        <button type="button" class="icon-btn small" data-rm="${i}" aria-label="Remove ${esc(p.name)}">✕</button></div>`).join('')}</div>
      <div class="result-actions">
        <button type="button" class="btn primary" data-act="bought">Bought — add all to collection</button>
        <button type="button" class="btn secondary" data-act="clear">Clear pile</button>
      </div>`;
    dlg.querySelector('.show-pct').addEventListener('change', (e) => {
      showMode.pct = Number(e.target.value);
      showSave();
      showRenderBar();
      showModeOffers(showMode.aud);
      draw();
    });
    dlg.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      showMode.pile.splice(Number(b.dataset.rm), 1);
      showSave();
      showRenderBar();
      if (!showMode.pile.length) dlg.close(); else draw();
    }));
    dlg.querySelector('[data-act=clear]').addEventListener('click', () => {
      if (!confirm('Clear the pile?')) return;
      showMode.pile = [];
      showSave();
      showRenderBar();
      dlg.close();
    });
    dlg.querySelector('[data-act=bought]').addEventListener('click', async () => {
      if (showMode.pile.some((p) => p.id.startsWith('ja:'))) await loadJapanese();
      let added = 0;
      for (const p of showMode.pile) {
        const card = db.byId.get(p.id);
        if (card) { addToCollection(card, p.variant); added++; }
      }
      showMode.pile = [];
      showSave();
      showRenderBar();
      dlg.close();
      toast(`Added ${added} card${added === 1 ? '' : 's'} to your collection`);
    });
  };
  draw();
  dlg.showModal();
}
$('showPileBtn').addEventListener('click', showOpenPile);

showUpdateButtons();
