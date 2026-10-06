/* PokeScan — identify Pokémon cards by their artwork.
 *
 *   - data/cards.json (names, sets, numbers) is loaded here for results and search.
 *   - Matching runs in a background worker (worker.js → matcher.js) against
 *     data/index.bin: a colour fingerprint of every card, built by tools/build-index.html.
 *   - While the camera is on, frames are scanned continuously. The whole camera view is
 *     searched, so the card doesn't have to fill the frame. When the same card wins on
 *     consecutive frames the result locks in until "Scan next card".
 *
 * Everything runs on the device — no network calls while scanning.
 */

const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'),
  still: $('stillPreview'),
  wrap: $('cameraWrap'),
  guide: $('guide'),
  overlay: $('overlay'),
  outline: $('outline'),
  camMsg: $('cameraMsg'),
  startCam: $('startCamBtn'),
  stopCam: $('stopCamBtn'),
  scan: $('scanBtn'),
  file: $('fileInput'),
  status: $('status'),
  dbNote: $('dbNote'),
  resultPanel: $('resultPanel'),
  resultTitle: $('resultTitle'),
  hero: $('hero'),
  heroImg: $('heroImg'),
  heroName: $('heroName'),
  heroSub: $('heroSub'),
  heroTags: $('heroTags'),
  addBtn: $('addBtn'),
  altWrap: $('altWrap'),
  altSummary: $('altSummary'),
  scanResults: $('scanResults'),
  collectionCount: $('collectionCount'),
  priceValue: $('priceValue'),
  variantChips: $('variantChips'),
  priceNote: $('priceNote'),
  valueCard: $('valueCard'),
  valueTotal: $('valueTotal'),
  valueNote: $('valueNote'),
  toast: $('toast'),
  searchForm: $('searchForm'),
  qName: $('qName'),
  qNumber: $('qNumber'),
  searchStatus: $('searchStatus'),
  searchResults: $('searchResults'),
  historyList: $('historyList'),
  clearHistory: $('clearHistory'),
  detail: $('detail'),
  detailBody: $('detailBody'),
};

let stream = null;

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function showView(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'collection') renderHistory();
  // Don't keep the camera busy while looking at other screens.
  if (name !== 'scan' && stream) stopCamera();
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

function setStatus(el, msg, kind = '') {
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.remove('ok', 'err', 'busy');
  if (kind) el.classList.add(kind);
  el.innerHTML = kind === 'busy' ? `<span class="spinner"></span>${msg}` : msg;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Card list (for results + search)                                    */
/* ------------------------------------------------------------------ */

const IMG = 'https://images.pokemontcg.io/';
const db = { cards: [] };

function cardFromRow(row, sets) {
  const [id, name, number, setId, rarity, image] = row;
  const [setName, setSeries, setTotal, releaseDate] = sets[setId] ?? [];
  const small = image || `${IMG}${setId}/${number}.png`;
  return {
    id, name, number, rarity, setId, setName, setSeries, setTotal, releaseDate,
    image: small,
    imageLarge: small.replace(/\.png$/, '_hires.png'),
  };
}

const dbReady = fetch('data/cards.json')
  .then((r) => {
    if (!r.ok) throw new Error(`cards.json: HTTP ${r.status}`);
    return r.json();
  })
  .then((meta) => {
    if (meta.dim !== FP.DIM) throw new Error('Card index was built with different settings — rebuild it.');
    db.cards = meta.cards.map((row) => cardFromRow(row, meta.sets));
    return db;
  });

/* ------------------------------------------------------------------ */
/* Matching worker                                                     */
/* ------------------------------------------------------------------ */

const worker = new Worker('worker.js');
const pending = new Map();
let msgId = 0;

worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) p?.reject(new Error(data.error));
  else p?.resolve(data);
};

function ask(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

const ready = Promise.all([dbReady, ask({ type: 'warmup' })]);

ready
  .then(() => {
    els.dbNote.textContent = `${db.cards.length.toLocaleString()} cards`;
    if (!window.isSecureContext) {
      setStatus(els.status, 'Live camera needs HTTPS — uploading a photo still works.', 'err');
    }
  })
  .catch((err) => setStatus(els.status, `Couldn't load the card database: ${esc(err.message)}`, 'err'));

/* Ask the worker to identify the card in a captured region. */
async function identify(region) {
  const res = await ask({ type: 'scan', regions: [region] }, [region.data]);
  return {
    matches: res.matches.map(({ i, score }) => ({ card: db.cards[i], score })),
    where: res.where,
    ms: res.ms,
  };
}

/* ------------------------------------------------------------------ */
/* Capturing frames                                                    */
/* ------------------------------------------------------------------ */

const REGION_WIDTH = 480;

/* Copy `rect` (source pixels) of an image/video into a REGION_WIDTH-wide RGBA buffer, and
 * express `guide` (source pixels: where a card filling the frame would be) in it. */
function captureRegion(source, rect, guide) {
  const scale = REGION_WIDTH / rect.w;
  const canvas = document.createElement('canvas');
  canvas.width = REGION_WIDTH;
  canvas.height = Math.round(rect.h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer,
    w: canvas.width,
    h: canvas.height,
    guide: {
      x0: (guide.x - rect.x) * scale, y0: (guide.y - rect.y) * scale,
      x1: (guide.x + guide.w - rect.x) * scale, y1: (guide.y + guide.h - rect.y) * scale,
    },
  };
}

/* Video is shown with object-fit: cover — map on-screen boxes to video pixels. */
function videoMapping() {
  const v = els.video;
  const box = els.wrap.getBoundingClientRect();
  const scale = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
  const offX = (box.width - v.videoWidth * scale) / 2;
  const offY = (box.height - v.videoHeight * scale) / 2;
  const toSource = (r) => ({
    x: (r.left - box.left - offX) / scale, y: (r.top - box.top - offY) / scale,
    w: r.width / scale, h: r.height / scale,
  });
  return { box, toSource };
}

/* The whole visible camera view, with the guide inside it. */
function captureVideo() {
  const { box, toSource } = videoMapping();
  return captureRegion(els.video, toSource(box), toSource(els.guide.getBoundingClientRect()));
}

/* Uploaded photos: search the whole photo, guessing the card fills most of the middle. */
function capturePhoto(img, w, h) {
  const ratio = 63 / 88;
  let gw = w, gh = h;
  if (w / h > ratio) gw = h * ratio; else gh = w / ratio;
  gw *= 0.85;
  gh *= 0.85;
  return captureRegion(img, { x: 0, y: 0, w, h }, { x: (w - gw) / 2, y: (h - gh) / 2, w: gw, h: gh });
}

/* Draw where the card was found (region pixels → screen). */
function showOutline(where, region) {
  if (!where || !stream) {
    els.outline.setAttribute('points', '');
    return;
  }
  const box = els.wrap.getBoundingClientRect();
  const k = box.width / region.w;
  const pts = Array.isArray(where)
    ? where
    : [{ x: where.x0, y: where.y0 }, { x: where.x1, y: where.y0 }, { x: where.x1, y: where.y1 }, { x: where.x0, y: where.y1 }];
  els.overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  els.outline.setAttribute('points', pts.map((p) => `${(p.x * k).toFixed(1)},${(p.y * k).toFixed(1)}`).join(' '));
}

/* ------------------------------------------------------------------ */
/* Camera + auto-scan                                                  */
/* ------------------------------------------------------------------ */

const auto = {
  state: 'off',      // off | scanning | locked
  lastKey: null,     // what the previous frame saw
  streak: 0,         // how many frames in a row
  ignoreKey: null,   // card just confirmed — don't lock on it again straight away
  lockedKey: null,
};

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(els.status,
      'Live camera needs HTTPS (or localhost). Use “Take / upload photo” instead — it works everywhere.',
      'err');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.still.hidden = true;
    els.video.hidden = false;
    els.wrap.classList.remove('photo');
    els.wrap.classList.add('live');
    resumeScanning();
  } catch (err) {
    setStatus(els.status, `Couldn't open the camera: ${esc(err.message)}`, 'err');
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  auto.state = 'off';
  els.video.srcObject = null;
  els.wrap.classList.remove('live', 'locked');
  els.outline.setAttribute('points', '');
  setStatus(els.status, '');
}

els.startCam.addEventListener('click', startCamera);
els.stopCam.addEventListener('click', stopCamera);

function resumeScanning() {
  hideResult();
  if (!stream) {
    startCamera();
    return;
  }
  auto.ignoreKey = auto.lockedKey;
  auto.lockedKey = null;
  auto.lastKey = null;
  auto.streak = 0;
  auto.state = 'scanning';
  els.wrap.classList.remove('locked');
  setStatus(els.status, 'Looking for a card…', 'busy');
  scanLoop();
}

els.scan.addEventListener('click', resumeScanning);

/* Start the camera straight away if permission was already given. */
navigator.permissions?.query({ name: 'camera' })
  .then((p) => { if (p.state === 'granted' && window.isSecureContext) startCamera(); })
  .catch(() => { /* not supported in this browser */ });

/* Confidence: a clear winner scores well and stands out from the runner-up.
 * Tuned on simulated photos and binder pages against the full index (tools/sim.js):
 * at these values no confident answer was wrong. */
function isConfident([best, second]) {
  return best && best.score >= 0.88 && best.score - (second?.score ?? 0) >= 0.015;
}

let loopRunning = false;

async function scanLoop() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    await ready;
    while (auto.state === 'scanning' && stream) {
      if (!els.video.videoWidth || document.hidden) {
        await sleep(300);
        continue;
      }
      const region = captureVideo();
      const { w, h } = region;
      const { matches, where } = await identify(region);
      if (auto.state !== 'scanning') break;
      onFrame(matches, where, { w, h });
      await sleep(80);
    }
  } catch (err) {
    console.error(err);
    setStatus(els.status, `Scanning stopped: ${esc(err.message)}`, 'err');
  } finally {
    loopRunning = false;
  }
}

/* Decide, frame by frame, when a result is solid enough to show. */
function onFrame(matches, where, region) {
  const [best] = matches;
  const confident = isConfident(matches);
  // Confident → that exact card. Close call with a good score → probably a reprint of the
  // same artwork, so track by name. Otherwise nothing.
  const key = confident ? `id:${best.card.id}`
    : best && best.score >= 0.75 ? `name:${best.card.name}` : null;

  if (key !== auto.ignoreKey) auto.ignoreKey = null; // moved on from the confirmed card
  if (key && key === auto.lastKey) auto.streak++;
  else auto.streak = key ? 1 : 0;
  auto.lastKey = key;

  const ignored = key && key === auto.ignoreKey;
  showOutline(key && !ignored ? where : null, region);

  if (!key || ignored) {
    setStatus(els.status, ignored ? 'Got it — point at the next card' : 'Looking for a card…', 'busy');
    return;
  }
  const needed = confident ? 2 : 4;
  if (auto.streak < needed) {
    setStatus(els.status, 'Hold still…', 'busy');
    return;
  }

  // Locked in.
  auto.state = 'locked';
  auto.lockedKey = key;
  els.wrap.classList.add('locked');
  navigator.vibrate?.(60);
  renderScanResults(matches);
}

/* ------------------------------------------------------------------ */
/* Photo upload                                                        */
/* ------------------------------------------------------------------ */

els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  els.file.value = '';
  if (!file) return;
  if (stream) stopCamera();
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    els.still.src = url;
    els.still.hidden = false;
    els.video.hidden = true;
    els.wrap.classList.add('photo');
    hideResult();
    setStatus(els.status, 'Matching artwork…', 'busy');
    try {
      await ready;
      const { matches } = await identify(capturePhoto(img, img.naturalWidth, img.naturalHeight));
      renderScanResults(matches);
    } catch (err) {
      setStatus(els.status, `Something went wrong: ${esc(err.message)}`, 'err');
    }
  };
  img.onerror = () => setStatus(els.status, 'Could not open that image.', 'err');
  img.src = url;
});

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

let shownCard = null;
let shownVariant = null; // finish picked for the shown card (holofoil, reverseHolofoil, ...)
let priceToken = 0;

/* Load and show the AUD price of the result card, with a chip per finish. */
async function showPrice(card) {
  const token = ++priceToken;
  shownVariant = null;
  els.priceValue.textContent = 'Loading…';
  els.priceValue.className = 'price-value none';
  els.variantChips.innerHTML = '';
  els.priceNote.textContent = '';
  const [prices, rate] = await Promise.all([getTcgPrices([card.id]), getAudRate()]);
  if (token !== priceToken) return; // another card is showing now
  const info = prices[card.id];
  const variants = priceVariants(info?.prices);
  if (!variants.length) {
    els.priceValue.textContent = info ? 'No price available' : "Couldn't load price";
    return;
  }
  const pick = (v) => {
    shownVariant = v.key;
    els.priceValue.textContent = formatAud(v.usd, rate.rate);
    els.priceValue.className = 'price-value';
    els.variantChips.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.key === v.key));
  };
  if (variants.length > 1) {
    for (const v of variants) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.key = v.key;
      chip.textContent = v.label;
      chip.addEventListener('click', () => pick(v));
      els.variantChips.appendChild(chip);
    }
  }
  pick(variants[0]);
  els.priceNote.innerHTML = `TCGplayer (US) market price × ${rate.rate.toFixed(3)}${rate.approx ? ' (approx. rate)' : ''}`
    + `${info.updatedAt ? ` · ${esc(info.updatedAt)}` : ''}`
    + `${info.url ? ` · <a href="${esc(info.url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}`;
}

function hideResult() {
  els.resultPanel.hidden = true;
  $('view-scan').classList.remove('has-result');
  if (!stream) setStatus(els.status, '');
  shownCard = null;
}

/* Fill the big result card with one card. */
function showHero(card, score) {
  shownCard = card;
  els.hero.hidden = false;
  els.addBtn.hidden = false;
  els.heroImg.src = card.image;
  els.heroImg.alt = card.name;
  els.heroName.textContent = card.name;
  els.heroSub.textContent = `${card.setName} · #${card.number}${card.setTotal ? '/' + card.setTotal : ''}`;
  els.heroTags.innerHTML = [
    score != null ? `<span class="tag match">${Math.round(Math.max(0, score) * 100)}% match</span>` : '',
    card.rarity ? `<span class="tag">${esc(card.rarity)}</span>` : '',
    card.releaseDate ? `<span class="tag">${esc(card.releaseDate.slice(0, 4))}</span>` : '',
  ].join('');
  showPrice(card);
}

function renderScanResults(matches) {
  els.resultPanel.hidden = false;
  $('view-scan').classList.add('has-result');
  els.scanResults.innerHTML = '';
  if (!matches.length) {
    els.hero.hidden = true;
    els.addBtn.hidden = true;
    els.resultTitle.className = 'result-title';
    els.resultTitle.textContent = 'No match found — try again closer, flat, and in good light.';
    els.altWrap.hidden = true;
    return;
  }
  const confident = isConfident(matches);
  // Near-tie between cards with the same name = the same artwork reprinted in several sets.
  const [best, second] = matches;
  const reprint = !confident && second && best.score >= 0.75
    && best.score - second.score < 0.015 && best.card.name === second.card.name;

  setStatus(els.status, confident ? 'Found it!' : 'Pick the right card below', confident ? 'ok' : '');
  els.resultTitle.className = `result-title${confident ? ' ok' : ''}`;
  els.resultTitle.textContent = confident ? '✓ Found it'
    : reprint ? 'Same artwork in more than one set — check the number on your card:'
      : 'Not sure — is it one of these?';

  if (confident) {
    showHero(best.card, best.score);
  } else {
    els.hero.hidden = true;
    els.addBtn.hidden = true;
  }

  // Alternatives: collapsed under "Not this card?" when confident, open otherwise.
  els.altWrap.hidden = false;
  els.altWrap.open = !confident;
  els.altSummary.textContent = confident ? 'Not this card?' : 'Closest matches';
  matches.slice(confident ? 1 : 0, 10).forEach(({ card, score }) => {
    els.scanResults.appendChild(cardRow(card, {
      score,
      onClick: () => {
        // Picking an alternative makes it the result.
        showHero(card, score);
        els.resultTitle.className = 'result-title ok';
        els.resultTitle.textContent = '✓ Your pick';
        els.altWrap.open = false;
        els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      },
    }));
  });
  els.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

els.addBtn.addEventListener('click', () => {
  if (!shownCard) return;
  addHistory({ ...shownCard, variant: shownVariant });
  toast(`Added ${shownCard.name} to your collection`);
  // Straight on to the next card when using the camera.
  if (stream) resumeScanning();
  else hideResult();
});

els.heroImg.addEventListener('click', () => shownCard && openDetail(shownCard));

/* ------------------------------------------------------------------ */
/* Search (offline, over the downloaded card list)                     */
/* ------------------------------------------------------------------ */

const normName = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = normName(els.qName.value.trim());
  // Accept "25", "025" or "025/198".
  const m = els.qNumber.value.trim().toUpperCase().match(/^([A-Z]*)0*(\d*[A-Z]*\d*)(?:\s*\/\s*0*(\d+))?$/);
  const number = m ? m[1] + m[2] : '';
  const total = m?.[3] ?? '';

  if (!name && !number) {
    setStatus(els.searchStatus, 'Enter a name and/or number.', 'err');
    return;
  }
  els.searchResults.innerHTML = '';
  try {
    await dbReady;
  } catch (err) {
    setStatus(els.searchStatus, `Card database didn't load: ${esc(err.message)}`, 'err');
    return;
  }
  const found = db.cards
    .filter((c) => (!name || normName(c.name).includes(name))
      && (!number || c.number.toUpperCase() === number)
      && (!total || String(c.setTotal) === total))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));

  setStatus(els.searchStatus,
    found.length ? `${found.length} result${found.length === 1 ? '' : 's'}${found.length > 100 ? ' (showing 100)' : ''}` : 'No cards found.',
    found.length ? 'ok' : 'err');
  found.slice(0, 100).forEach((c) => els.searchResults.appendChild(cardRow(c)));
});

/* ------------------------------------------------------------------ */
/* Card list + detail                                                  */
/* ------------------------------------------------------------------ */

function cardRow(card, { score = null, onClick = () => openDetail(card) } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-row';
  btn.innerHTML = `
    <img src="${esc(card.image)}" alt="" loading="lazy">
    <div class="meta">
      <div class="name">${esc(card.name)}</div>
      <div class="sub">${esc(card.setName)} · #${esc(card.number)}${card.setTotal ? '/' + esc(card.setTotal) : ''}</div>
      <div class="sub">${esc([card.rarity, card.releaseDate?.slice(0, 4),
        score !== null ? `${Math.round(Math.max(0, score) * 100)}% match` : ''].filter(Boolean).join(' · '))}</div>
    </div>`;
  btn.addEventListener('click', onClick);
  return btn;
}

/* Card details. `historyIndex` = position in the collection (to offer removing it). */
function openDetail(card, { historyIndex = null } = {}) {
  const rows = [
    ['Set', card.setName],
    ['Series', card.setSeries],
    ['Number', `${card.number}${card.setTotal ? ' / ' + card.setTotal : ''}`],
    ['Rarity', card.rarity],
    ['Released', card.releaseDate],
    ['Card ID', card.id],
  ].filter(([, v]) => v);

  els.detailBody.innerHTML = `
    <img class="detail-img" src="${esc(card.imageLarge || card.image)}" alt="${esc(card.name)}"
         onerror="this.onerror=null;this.src='${esc(card.image)}'">
    <p class="detail-title">${esc(card.name)}</p>
    <p class="detail-sub">${esc(card.setName)} · #${esc(card.number)}</p>
    <table class="detail-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
      <tbody id="detailPrices"><tr><td>Price (AUD)</td><td>Loading…</td></tr></tbody></table>
    <div class="detail-actions">
      ${historyIndex === null
        ? '<button class="btn primary" id="detailAdd">＋ Add to collection</button>'
        : '<button class="btn ghost" id="detailRemove">Remove from collection</button>'}
    </div>`;

  $('detailAdd')?.addEventListener('click', () => {
    addHistory(card);
    els.detail.close();
    toast(`Added ${card.name} to your collection`);
    if (shownCard?.id === card.id && stream) resumeScanning();
  });
  $('detailRemove')?.addEventListener('click', () => {
    const list = loadHistory();
    list.splice(historyIndex, 1);
    saveHistory(list);
    els.detail.close();
    renderHistory();
    toast(`Removed ${card.name}`);
  });

  els.detail.showModal();

  // Prices for every finish of this card.
  Promise.all([getTcgPrices([card.id]), getAudRate()]).then(([prices, rate]) => {
    const body = $('detailPrices');
    if (!body) return;
    const variants = priceVariants(prices[card.id]?.prices);
    body.innerHTML = variants.length
      ? variants.map((v) => `<tr><td>${esc(v.label)}${v.key === card.variant ? ' ✓' : ''}</td><td>${formatAud(v.usd, rate.rate)}</td></tr>`).join('')
      : '<tr><td>Price (AUD)</td><td>No price available</td></tr>';
  });
}

/* Tap the dark backdrop to close the sheet. */
els.detail.addEventListener('click', (e) => { if (e.target === els.detail) els.detail.close(); });

/* ------------------------------------------------------------------ */
/* History (per-device)                                                */
/* ------------------------------------------------------------------ */

const HISTORY_KEY = 'pokescan.history.v1';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

function addHistory(card) {
  const list = loadHistory();
  list.unshift({ ...card, scannedAt: new Date().toISOString() });
  saveHistory(list.slice(0, 500));
}

/* USD market price of a saved card, using the finish chosen when it was added. */
function cardUsd(card, info) {
  const variants = priceVariants(info?.prices);
  return (variants.find((v) => v.key === card.variant) ?? variants[0])?.usd ?? null;
}

let historyToken = 0;

async function renderHistory() {
  const token = ++historyToken;
  const list = loadHistory();
  els.collectionCount.textContent = list.length ? `(${list.length})` : '';
  els.historyList.innerHTML = list.length ? '' : '<p class="empty">No cards yet — scan one and tap “Add to collection”.</p>';
  els.valueCard.hidden = !list.length;
  const priceEls = list.map((card, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'grid-item';
    item.innerHTML = `<img src="${esc(card.image)}" alt="" loading="lazy"><span>${esc(card.name)}</span><span class="price"></span>`;
    item.addEventListener('click', () => openDetail(card, { historyIndex: i }));
    els.historyList.appendChild(item);
    return item.querySelector('.price');
  });
  if (!list.length) return;

  els.valueTotal.textContent = 'Loading…';
  els.valueNote.textContent = '';
  const [prices, rate] = await Promise.all([getTcgPrices([...new Set(list.map((c) => c.id))]), getAudRate()]);
  if (token !== historyToken) return;
  let total = 0;
  let priced = 0;
  list.forEach((card, i) => {
    const usd = cardUsd(card, prices[card.id]);
    if (usd == null) return;
    total += usd;
    priced++;
    priceEls[i].textContent = formatAud(usd, rate.rate);
  });
  els.valueTotal.textContent = formatAud(total, rate.rate);
  els.valueNote.textContent = `${priced} of ${list.length} cards priced · TCGplayer market prices in AUD`
    + (rate.approx ? ' (approx. exchange rate)' : '');
}

els.clearHistory.addEventListener('click', () => {
  if (confirm('Clear all scanned cards from this device?')) {
    saveHistory([]);
    renderHistory();
  }
});

/* ------------------------------------------------------------------ */
/* PWA                                                                 */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW failed', err));
}
