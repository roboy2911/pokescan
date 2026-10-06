/* PokeScan — identify Pokémon cards by their artwork.
 *
 * Pipeline:
 *   1. On start-up, load the card index (data/cards.json + data/index.bin): a colour
 *      fingerprint of every card, built once by tools/build-index.html.
 *   2. Grab a frame from the camera (or an uploaded photo) and crop the card using the
 *      on-screen guide.
 *   3. Fingerprint several slightly shifted / zoomed crops of it (see fingerprint.js).
 *   4. Compare against every card in the index; the closest artwork wins.
 *
 * Everything runs on the device — no text reading, no network calls while scanning.
 */

const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'),
  still: $('stillPreview'),
  wrap: $('cameraWrap'),
  guide: $('guide'),
  camMsg: $('cameraMsg'),
  startCam: $('startCamBtn'),
  scan: $('scanBtn'),
  file: $('fileInput'),
  status: $('status'),
  scanResults: $('scanResults'),
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
let busy = false;

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.id === `view-${tab.dataset.view}`));
    if (tab.dataset.view === 'history') renderHistory();
  });
});

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

function setStatus(el, msg, kind = '') {
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = kind === 'busy' ? `<span class="spinner"></span>${msg}` : msg;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ */
/* Card index                                                          */
/* ------------------------------------------------------------------ */

const IMG = 'https://images.pokemontcg.io/';

const db = {
  cards: [],        // card objects, same order as the vectors
  vectors: null,    // Int8Array, count * dim
  norms: null,      // Float32Array, length of each stored vector
  dim: 0,
};

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

const dbReady = (async () => {
  const [meta, bin] = await Promise.all([
    fetch('data/cards.json').then((r) => {
      if (!r.ok) throw new Error(`cards.json: HTTP ${r.status}`);
      return r.json();
    }),
    fetch('data/index.bin').then((r) => {
      if (!r.ok) throw new Error(`index.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  if (meta.dim !== FP.DIM) throw new Error('Card index was built with different settings — rebuild it.');
  db.dim = meta.dim;
  db.cards = meta.cards.map((row) => cardFromRow(row, meta.sets));
  db.vectors = new Int8Array(bin);
  db.norms = new Float32Array(db.cards.length);
  for (let c = 0; c < db.cards.length; c++) {
    let s = 0;
    for (let i = c * db.dim, end = i + db.dim; i < end; i++) s += db.vectors[i] * db.vectors[i];
    db.norms[c] = Math.sqrt(s) || 1;
  }
  return db;
})();

dbReady
  .then(() => {
    if (!busy) setStatus(els.status, window.isSecureContext
      ? `${db.cards.length.toLocaleString()} cards loaded. Start the camera or take a photo.`
      : `${db.cards.length.toLocaleString()} cards loaded. Not on HTTPS, so the live camera is off — “Take / upload photo” still works.`);
  })
  .catch((err) => setStatus(els.status, `Couldn't load the card database: ${esc(err.message)}`, 'err'));

/* Score the given cards (indices into the index) against query fingerprints; each card
 * keeps its best-matching query. Returns the topN as { i, score }, best first. */
function scoreCards(queries, indices, topN) {
  const { vectors, norms, dim } = db;
  const best = [];
  let floor = -Infinity;
  for (const c of indices) {
    const base = c * dim;
    let top = -Infinity;
    for (const q of queries) {
      let s = 0;
      for (let k = 0; k < dim; k++) s += q[k] * vectors[base + k];
      if (s > top) top = s;
    }
    const score = top / norms[c];
    if (score > floor) {
      best.push({ i: c, score });
      // Trim occasionally; `floor` = the worst score that can still make the top N.
      if (best.length >= topN * 2) {
        best.sort((a, b) => b.score - a.score);
        best.length = topN;
        floor = best[topN - 1].score;
      }
    }
  }
  best.sort((a, b) => b.score - a.score);
  return best.slice(0, topN);
}

/* Glare-tolerant score: like the dot product, but ignores the grid cells that disagree
 * most (a glare spot or a finger only spoils a few cells). 1 = identical. */
const ROBUST_KEEP = 0.85;

function robustScores(queries, indices, topN) {
  const { vectors, norms, dim } = db;
  const cells = dim / 3;
  const keep = Math.round(cells * ROBUST_KEEP);
  const err = new Float32Array(cells);
  const out = [];
  for (const c of indices) {
    const base = c * dim;
    const inv = 1 / norms[c];
    let top = -Infinity;
    for (const q of queries) {
      for (let cell = 0, k = 0; cell < cells; cell++, k += 3) {
        const d0 = q[k] - vectors[base + k] * inv;
        const d1 = q[k + 1] - vectors[base + k + 1] * inv;
        const d2 = q[k + 2] - vectors[base + k + 2] * inv;
        err[cell] = d0 * d0 + d1 * d1 + d2 * d2;
      }
      const sorted = err.slice().sort();
      let sum = 0;
      for (let k = 0; k < keep; k++) sum += sorted[k];
      // Scale to the full vector so it reads like a cosine similarity.
      const score = 1 - (sum * cells / keep) / 2;
      if (score > top) top = score;
    }
    out.push({ i: c, score: top });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}

/* Two stages so lots of crops stay fast on a phone: a few "coarse" fingerprints against
 * every card to shortlist, then all the "fine" crops against just the shortlist. */
function matchQueries({ coarse, fine }, topN = 12, { robust = true } = {}) {
  const all = Array.from(db.cards.keys());
  const shortlist = scoreCards(coarse, all, 300).map((r) => r.i);
  const ranked = robust ? robustScores(fine, shortlist, topN) : scoreCards(fine, shortlist, topN);
  return ranked.map(({ i, score }) => ({ card: db.cards[i], score }));
}

/* Copy a rectangle of the source (the guide area plus a margin around it) into a
 * ~480px-wide canvas. `rect` is the expected card position in source pixels. */
function captureRegion(source, srcW, srcH, rect) {
  const mx = rect.w * 0.16, my = rect.h * 0.16;
  const x0 = Math.max(0, rect.x - mx), y0 = Math.max(0, rect.y - my);
  const x1 = Math.min(srcW, rect.x + rect.w + mx), y1 = Math.min(srcH, rect.y + rect.h + my);
  const scale = 480 / (x1 - x0);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = Math.round((y1 - y0) * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
  return {
    canvas,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    w: canvas.width,
    h: canvas.height,
    guide: {
      x0: (rect.x - x0) * scale, y0: (rect.y - y0) * scale,
      x1: (rect.x + rect.w - x0) * scale, y1: (rect.y + rect.h - y0) * scale,
    },
  };
}

/* All the fingerprints to try for one photo: crops around where the guide says the card
 * is, plus the card cut out along any outlines edge-detection found (un-tilted). */
function buildQueries(region) {
  const { guide } = region;
  const gc = document.createElement('canvas');
  gc.width = 300;
  gc.height = Math.round(300 * 88 / 63);
  const gctx = gc.getContext('2d', { willReadFrequently: true });
  gctx.drawImage(region.canvas, guide.x0, guide.y0, guide.x1 - guide.x0, guide.y1 - guide.y0, 0, 0, gc.width, gc.height);
  const gd = gctx.getImageData(0, 0, gc.width, gc.height).data;

  const coarse = [fpCrops(gd, gc.width, gc.height, [0.95], [0])[0]];
  const fine = fpCrops(gd, gc.width, gc.height);

  const quads = detectCardQuads(region.data, region.w, region.h, guide);
  for (const q of quads) {
    const warped = warpQuad(region.data, region.w, region.h, q, 252, 352);
    coarse.push(fpFromPixels(warped, 252, 352));
    fine.push(...fpCrops(warped, 252, 352, [0.97, 1, 1.03], [0]));
  }
  return { coarse, fine, outlines: quads.length };
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

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
    els.camMsg.hidden = true;
    els.scan.disabled = false;
    els.startCam.textContent = 'Stop camera';
    setStatus(els.status, 'Fill the yellow frame with the card, then tap Scan.');
  } catch (err) {
    setStatus(els.status, `Couldn't open camera: ${esc(err.message)}. Try “Take / upload photo”.`, 'err');
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.scan.disabled = true;
  els.startCam.textContent = 'Start camera';
  els.camMsg.hidden = false;
}

els.startCam.addEventListener('click', () => (stream ? stopCamera() : startCamera()));

/* Map the on-screen guide rectangle onto source pixels of a video/img drawn with object-fit: cover. */
function guideRectInSource(srcW, srcH) {
  const box = els.wrap.getBoundingClientRect();
  const g = els.guide.getBoundingClientRect();
  const scale = Math.max(box.width / srcW, box.height / srcH);
  const offX = (box.width - srcW * scale) / 2;
  const offY = (box.height - srcH * scale) / 2;
  const x = (g.left - box.left - offX) / scale;
  const y = (g.top - box.top - offY) / scale;
  const w = g.width / scale;
  const h = g.height / scale;
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.min(srcW - Math.max(0, x), w),
    h: Math.min(srcH - Math.max(0, y), h),
  };
}

/* Uploaded photos aren't lined up with the guide: assume the card is a card-shaped area
 * filling most of the middle (edge detection then finds where it really is). */
function regionFromPhoto(img, w, h) {
  const ratio = 63 / 88;
  let cw = w, ch = h;
  if (w / h > ratio) cw = h * ratio; else ch = w / ratio;
  cw *= 0.85;
  ch *= 0.85;
  return captureRegion(img, w, h, { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch });
}

/* ------------------------------------------------------------------ */
/* Scan flow                                                           */
/* ------------------------------------------------------------------ */

async function runScan(region) {
  if (busy) return;
  busy = true;
  els.scan.disabled = true;
  els.scanResults.innerHTML = '';

  try {
    setStatus(els.status, 'Loading card database…', 'busy');
    await dbReady;
    setStatus(els.status, 'Matching artwork…', 'busy');
    await new Promise((r) => setTimeout(r, 0)); // let the spinner paint

    // One or several frames: pool all their fingerprints, best crop wins.
    const queries = { coarse: [], fine: [] };
    for (const r of Array.isArray(region) ? region : [region]) {
      const q = buildQueries(r);
      queries.coarse.push(...q.coarse);
      queries.fine.push(...q.fine);
    }
    renderScanResults(matchQueries(queries));
  } catch (err) {
    console.error(err);
    setStatus(els.status, `Something went wrong: ${esc(err.message)}`, 'err');
  } finally {
    busy = false;
    els.scan.disabled = !stream;
  }
}

/* Grab a few frames a moment apart, so one blurry or glary frame doesn't spoil the scan. */
els.scan.addEventListener('click', async () => {
  const v = els.video;
  if (!v.videoWidth || busy) return;
  const regions = [];
  for (let k = 0; k < 3; k++) {
    if (k) await new Promise((r) => setTimeout(r, 150));
    regions.push(captureRegion(v, v.videoWidth, v.videoHeight, guideRectInSource(v.videoWidth, v.videoHeight)));
  }
  runScan(regions);
});

els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  els.file.value = '';
  if (!file) return;
  if (stream) stopCamera();
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    els.still.src = url;
    els.still.hidden = false;
    els.video.hidden = true;
    els.camMsg.hidden = true;
    runScan(regionFromPhoto(img, img.naturalWidth, img.naturalHeight));
  };
  img.onerror = () => setStatus(els.status, 'Could not open that image.', 'err');
  img.src = url;
});

/* Confidence: a clear winner scores well and stands out from the runner-up.
 * Tuned on simulated photos against the full index (tools/sim.js testMatch): at these
 * values ~90% of scans were "confident" and no confident answer was wrong. */
function isConfident([best, second]) {
  return best && best.score >= 0.75 && best.score - (second?.score ?? 0) >= 0.015;
}

function renderScanResults(matches) {
  if (!matches.length) {
    setStatus(els.status, 'No match found. Try again with the card filling the frame.', 'err');
    return;
  }
  const confident = isConfident(matches);
  // Near-tie between cards with the same name = the same artwork reprinted in several sets.
  const [best, second] = matches;
  const reprint = !confident && second && best.score >= 0.75
    && best.score - second.score < 0.015 && best.card.name === second.card.name;
  setStatus(els.status,
    confident
      ? 'Found it! Tap the card to confirm.'
      : reprint
        ? `This artwork was printed in more than one set. Check the set symbol and number on your card and tap the right one.`
        : 'Not sure — here are the closest matches. Tap the right one, or rescan with the card filling the frame and less glare.',
    confident ? 'ok' : '');

  els.scanResults.innerHTML = '';
  matches.slice(0, confident ? 5 : 12).forEach(({ card, score }, i) => {
    els.scanResults.appendChild(cardRow(card, { best: i === 0 && confident, score }));
  });
}

/* ------------------------------------------------------------------ */
/* Search (offline, over the downloaded index)                         */
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

function cardRow(card, { best = false, score = null, onClick = () => openDetail(card) } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `card-row${best ? ' best' : ''}`;
  btn.innerHTML = `
    <img src="${esc(card.image)}" alt="" loading="lazy">
    <div class="meta">
      <div class="name">${esc(card.name)}${best ? '<span class="badge">Best match</span>' : ''}</div>
      <div class="sub">${esc(card.setName)} · #${esc(card.number)}${card.setTotal ? '/' + esc(card.setTotal) : ''}</div>
      <div class="sub">${esc([card.rarity, card.releaseDate?.slice(0, 4),
        score !== null ? `${Math.round(Math.max(0, score) * 100)}% match` : ''].filter(Boolean).join(' · '))}</div>
    </div>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function openDetail(card, { fromHistory = false } = {}) {
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
    <table class="detail-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="detail-actions">
      ${fromHistory ? '' : '<button class="btn primary" id="confirmBtn">✓ This is my card</button>'}
    </div>`;

  $('confirmBtn')?.addEventListener('click', () => {
    addHistory(card);
    els.detail.close();
    setStatus(els.status, `Saved ${esc(card.name)} to History.`, 'ok');
  });

  els.detail.showModal();
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

function renderHistory() {
  const list = loadHistory();
  els.historyList.innerHTML = list.length ? '' : '<p class="muted">Nothing yet — scan a card and tap “This is my card”.</p>';
  list.forEach((card) => {
    els.historyList.appendChild(cardRow(card, { onClick: () => openDetail(card, { fromHistory: true }) }));
  });
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
