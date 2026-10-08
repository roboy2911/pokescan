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
  altStrip: $('altStrip'),
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
  searchStatus: $('searchStatus'),
  searchResults: $('searchResults'),
  historyList: $('historyList'),
  clearHistory: $('clearHistory'),
  collectionTools: $('collectionTools'),
  collectionSearch: $('collectionSearch'),
  collectionSort: $('collectionSort'),
  collectionSet: $('collectionSet'),
  detail: $('detail'),
  detailBody: $('detailBody'),
};

let stream = null;

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function showView(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'collection') refreshCollection();
  if (name === 'sets') showSets();
  if (name === 'market') renderMarket();
  if (name === 'search' && !els.qName.value) els.qName.focus();
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

/* The finish last picked for each card (so a reverse holo you scan often stays picked). */
const FINISH_KEY = 'pokescan.lastFinish';
function lastFinish(id) {
  try { return JSON.parse(localStorage.getItem(FINISH_KEY))?.[id] ?? null; } catch { return null; }
}
function rememberFinish(id, key) {
  try {
    const all = JSON.parse(localStorage.getItem(FINISH_KEY)) || {};
    all[id] = key;
    localStorage.setItem(FINISH_KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}

/* Optional beep when a card is found (toggle on the camera; off by default). */
const SOUND_KEY = 'pokescan.sound';
let audioCtx = null;
let soundOn = false;
try { soundOn = localStorage.getItem(SOUND_KEY) === '1'; } catch { /* no storage */ }
function showSound() {
  const btn = $('soundBtn');
  btn.setAttribute('aria-pressed', String(soundOn));
  btn.classList.toggle('on', soundOn);
}
function beep() {
  if (!soundOn) return;
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1200;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.12);
  } catch { /* no audio */ }
}
$('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0'); } catch { /* no storage */ }
  showSound();
  if (soundOn) { audioCtx ??= new AudioContext(); audioCtx.resume?.(); beep(); } // unlock audio on this tap
  toast(soundOn ? 'Beep on when a card is found' : 'Beep off');
});
showSound();

const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const scrollBehavior = reduceMotion ? 'auto' : 'smooth';

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
    db.sets = meta.sets; // id → [name, series, total, releaseDate]
    db.byId = new Map(db.cards.map((c) => [c.id, c]));
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
  recent: [],        // last few frames' matches (fuseFrames)
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
  auto.recent = [];
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

/* Evidence over the last few frames. Glare and reflections move as the phone moves, so a
 * card can be unsure on every single frame yet win most of them. `frames` = recent match
 * lists (newest last). Returns the card that wins clearly across them, or null.
 * Tuned on simulated photos (tools/sim.js testFusion) to add no wrong answers. */
const FUSE_FRAMES = 5;
function fuseFrames(frames) {
  if (frames.length < 4) return null;
  const stats = new Map();
  frames.forEach((ms, f) => {
    ms.slice(0, 8).forEach(({ card, score }, rank) => {
      if (!stats.has(card.id)) stats.set(card.id, { card, scores: Array(frames.length).fill(null), wins: 0 });
      const st = stats.get(card.id);
      st.scores[f] = score;
      if (rank === 0) st.wins++;
    });
  });
  // A card missing from a frame's top 8 gets a bit less than that frame's 8th score.
  const floor = frames.map((ms) => (ms[Math.min(7, ms.length - 1)]?.score ?? 0) - 0.02);
  const fused = [...stats.values()].map((st) => ({
    ...st, mean: st.scores.reduce((sum, v, f) => sum + (v ?? floor[f]), 0) / frames.length,
  })).sort((a, b) => b.mean - a.mean);
  const [a, b] = fused;
  if (!a || a.wins < Math.ceil(frames.length * 0.6) || a.mean < 0.86 || a.mean - (b?.mean ?? 0) < 0.02) return null;
  return a.card;
}

/* Decide, frame by frame, when a result is solid enough to show. */
function onFrame(matches, where, region) {
  auto.recent.push(matches);
  if (auto.recent.length > FUSE_FRAMES) auto.recent.shift();
  const fusedCard = !isConfident(matches) ? fuseFrames(auto.recent) : null;
  if (fusedCard) {
    // Put the card that won across frames first, and treat it as found.
    matches = [matches.find((m) => m.card.id === fusedCard.id) ?? { card: fusedCard, score: matches[0].score },
      ...matches.filter((m) => m.card.id !== fusedCard.id)];
  }
  const [best] = matches;
  const confident = isConfident(matches) || !!fusedCard;
  bulkTrack(best);
  // Bulk add: the card just added stays "done" while it's in view, even on unsure frames.
  if (bulk.on && bulk.last && best && best.score >= 0.75 && best.card.name === bulk.last.name
    && !(confident && bulkCanReadd(best.card))) {
    showOutline(null, region);
    setStatus(els.status, 'Added — point at the next card', 'busy');
    auto.lastKey = null;
    auto.streak = 0;
    return;
  }
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
  const needed = fusedCard ? 1 : confident ? 2 : 4;
  if (auto.streak < needed) {
    setStatus(els.status, 'Hold still…', 'busy');
    return;
  }

  // Bulk add: add it and keep scanning instead of stopping on the result.
  if (bulk.on && confident) {
    bulkAdd(best.card);
    return;
  }

  // Locked in.
  auto.state = 'locked';
  auto.lockedKey = key;
  els.wrap.classList.add('locked');
  navigator.vibrate?.(60);
  beep();
  auto.recent = [];
  renderScanResults(matches, { found: confident });
}

/* ------------------------------------------------------------------ */
/* Bulk add: scan a stack or binder without tapping for every card     */
/* ------------------------------------------------------------------ */

/* While on, each card found with confidence is added straight to the collection (with the
 * finish last picked for it) and scanning carries on. The same card isn't added twice while
 * it's held in view: it only re-arms after it has been out of view for several frames in a
 * row and at least BULK_ABSENT_MS, and at least BULK_REPEAT_MS after it was added — so a
 * second copy swapped in is added again, but one held still (or a glitchy frame) isn't. */
const BULK_KEY = 'pokescan.bulk';
const BULK_ABSENT_FRAMES = 3;
const BULK_ABSENT_MS = 1000;
const BULK_REPEAT_MS = 2000;
const bulk = {
  on: false,
  last: null,     // { id, name, at, absentFrames, absentSince, rearmed }
  session: { count: 0, usd: 0, byId: new Map(), log: [] },
};
try { bulk.on = localStorage.getItem(BULK_KEY) === '1'; } catch { /* no storage */ }

/* Keep track of whether the last-added card is still in view. */
function bulkTrack(best) {
  const last = bulk.last;
  if (!last) return;
  const present = best && best.score >= 0.75 && best.card.name === last.name;
  if (present) {
    last.absentFrames = 0;
    last.absentSince = null;
    return;
  }
  last.absentFrames++;
  last.absentSince ??= performance.now();
  if (last.absentFrames >= BULK_ABSENT_FRAMES && performance.now() - last.absentSince >= BULK_ABSENT_MS) last.rearmed = true;
}

/* May this card be added (again)? A different card always may. */
function bulkCanReadd(card) {
  const last = bulk.last;
  return !last || card.id !== last.id || (last.rearmed && performance.now() - last.at >= BULK_REPEAT_MS);
}

function bulkAdd(card) {
  auto.lastKey = null;
  auto.streak = 0;
  auto.recent = [];
  if (!bulkCanReadd(card)) {
    setStatus(els.status, 'Added — point at the next card', 'busy');
    return;
  }
  const variant = lastFinish(card.id);
  addToCollection(card, variant);
  const s = bulk.session;
  const n = (s.byId.get(card.id) || 0) + 1;
  s.byId.set(card.id, n);
  s.count++;
  const item = { card, variant, usd: 0 };
  s.log.push(item);
  bulk.last = { id: card.id, name: card.name, at: performance.now(), absentFrames: 0, absentSince: null, rearmed: false };
  navigator.vibrate?.(40);
  beep();
  const label = `${card.name}${n > 1 ? ` ×${n}` : ''}`;
  toast(`Added ${label}`);
  setStatus(els.status, `Added ${esc(label)} — next card`, 'ok');
  renderBulkBar(label);
  // Add its price to the session total once known.
  getTcgPrices([card.id]).then((prices) => {
    item.usd = cardUsd({ variant }, prices[card.id]) ?? 0;
    s.usd += item.usd;
    renderBulkBar();
  });
}

function bulkUndo() {
  const s = bulk.session;
  const item = s.log.pop();
  if (!item) return;
  const key = entryKeyOf(item.card.id, item.variant);
  const list = loadCollection();
  const entry = list.find((e) => e.key === key);
  if (entry) {
    if (entry.qty > 1) entry.qty--;
    else list.splice(list.indexOf(entry), 1);
    saveCollection(list);
  }
  s.count--;
  s.usd -= item.usd;
  s.byId.set(item.card.id, (s.byId.get(item.card.id) || 1) - 1);
  if (bulk.last?.id === item.card.id) bulk.last = null; // it can be scanned again straight away
  toast(`Removed ${item.card.name}`);
  renderBulkBar(s.log.length ? undefined : '');
}

let bulkLastLabel = '';
async function renderBulkBar(label) {
  if (label !== undefined) bulkLastLabel = label;
  const bar = $('bulkBar');
  bar.hidden = !bulk.on;
  if (!bulk.on) return;
  const s = bulk.session;
  const rate = await getAudRate();
  $('bulkCount').textContent = `${s.count} card${s.count === 1 ? '' : 's'} · ${formatAud(Math.max(0, s.usd), rate.rate)} added`;
  $('bulkLast').textContent = bulkLastLabel ? `Last: ${bulkLastLabel}` : 'Bulk add on — point at a card';
  $('bulkUndo').disabled = !s.log.length;
}

function showBulk() {
  const btn = $('bulkBtn');
  btn.classList.toggle('on', bulk.on);
  btn.setAttribute('aria-pressed', String(bulk.on));
  renderBulkBar();
}

$('bulkBtn').addEventListener('click', () => {
  bulk.on = !bulk.on;
  try { localStorage.setItem(BULK_KEY, bulk.on ? '1' : '0'); } catch { /* no storage */ }
  if (bulk.on) {
    bulk.session = { count: 0, usd: 0, byId: new Map(), log: [] };
    bulk.last = null;
    bulkLastLabel = '';
  }
  showBulk();
  toast(bulk.on ? 'Bulk add on: cards are added as they’re found' : 'Bulk add off');
});
$('bulkUndo').addEventListener('click', bulkUndo);
showBulk();

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
  const label = els.priceValue.parentElement.querySelector('.price-label');
  const tcgNote = `TCGplayer (US) market price × ${rate.rate.toFixed(3)}${rate.approx ? ' (approx. rate)' : ''}`
    + `${info.updatedAt ? ` · ${esc(info.updatedAt)}` : ''}`
    + `${info.url ? ` · <a href="${esc(info.url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}`;
  const soldLink = () => ` · <a class="ebay-sold" href="${esc(ebaySoldUrl(card, shownVariant))}" target="_blank" rel="noopener">AU sold ↗</a>`;
  // AU sold price (median of Australian eBay sales) replaces the main price when known.
  // In bulk mode only saved answers are used, so a big scanning session costs no searches.
  const showAu = (v, au) => {
    const tcg = formatAud(v.usd, rate.rate);
    els.priceValue.textContent = au?.ok ? formatAudPlain(au.aud) : tcg;
    els.priceValue.className = 'price-value';
    label.textContent = au?.ok ? 'AU sold price' : 'Market price (AUD)';
    els.priceNote.innerHTML = (au === undefined ? 'Checking Australian eBay sales (can take ~20 s)… · ' : '')
      + (au?.ok ? `${esc(auSoldText(au, tcg))}` : tcgNote) + soldLink();
  };
  let auReq = 0;
  const pick = async (v, remember = false) => {
    shownVariant = v.key;
    if (remember) rememberFinish(card.id, v.key);
    els.variantChips.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.key === v.key));
    const { q, n, t } = ebaySoldQuery(card, v.key);
    const req = ++auReq;
    const cached = auSoldCached(q, n, t);
    if (cached || bulk.on) return showAu(v, cached);
    showAu(v, undefined);
    const au = await getAuSold(q, n, t);
    if (token === priceToken && req === auReq && shownVariant === v.key) showAu(v, au);
  };
  if (variants.length > 1) {
    for (const v of variants) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.key = v.key;
      chip.textContent = v.label;
      chip.addEventListener('click', () => pick(v, true));
      els.variantChips.appendChild(chip);
    }
  }
  pick(variants.find((v) => v.key === lastFinish(card.id)) ?? variants[0]);
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

function renderScanResults(matches, { found = null } = {}) {
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
  const confident = found ?? isConfident(matches);
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

  // Quick swap: the next few matches as thumbnails right under the result.
  els.altStrip.innerHTML = '';
  els.altStrip.hidden = !confident || matches.length < 2;
  if (confident) {
    const label = document.createElement('span');
    label.className = 'alt-strip-label';
    label.textContent = 'Not it? Tap the right one:';
    els.altStrip.appendChild(label);
    for (const { card, score } of matches.slice(1, 5)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'alt-thumb';
      b.setAttribute('aria-label', `${card.name}, ${card.setName} #${card.number}`);
      b.innerHTML = `<img src="${esc(card.image)}" alt="" loading="lazy"><span>${esc(card.setName)}</span>`;
      b.addEventListener('click', () => {
        showHero(card, score);
        els.resultTitle.className = 'result-title ok';
        els.resultTitle.textContent = '✓ Your pick';
        els.altStrip.hidden = true;
      });
      els.altStrip.appendChild(b);
    }
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
        els.resultPanel.scrollIntoView({ behavior: scrollBehavior, block: 'nearest' });
      },
    }));
  });
  els.resultPanel.scrollIntoView({ behavior: scrollBehavior, block: 'nearest' });
}

els.addBtn.addEventListener('click', () => {
  if (!shownCard) return;
  const qty = addToCollection(shownCard, shownVariant);
  toast(qty > 1 ? `Added ${shownCard.name} — you have ${qty}` : `Added ${shownCard.name} to your collection`);
  // Straight on to the next card when using the camera.
  if (stream) resumeScanning();
  else hideResult();
});

els.heroImg.addEventListener('click', () => shownCard && openDetail({ ...shownCard, variant: shownVariant }));

/* ------------------------------------------------------------------ */
/* Search (offline, over the downloaded card list)                     */
/* ------------------------------------------------------------------ */

const normName = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* One search box, results as you type. Every word must match: name or set words for text
 * ("char", "prismatic"), the card number for numbers ("4", "025", "TG05"), or number and
 * set size together ("199/165"). So "charizard 4", "pikachu 25/102", "umbreon prismatic"
 * and "151 etb" all work. Sealed product is searched by name / set / type. */

// "025" → "25", "TG05" → "TG5", "SWSH020" → "SWSH20": compare numbers without padding.
const normNumber = (s) => String(s).toUpperCase().replace(/(^|[A-Z])0+(?=\d)/g, '$1');

let searchIndex = null;
function getSearchIndex() {
  searchIndex ??= db.cards.map((c) => ({
    c,
    words: ` ${normName(`${c.name} ${c.setName}`)} `,
    name: normName(c.name),
    number: normNumber(c.number),
    total: String(c.setTotal ?? ''),
  }));
  return searchIndex;
}

function parseQuery(q) {
  return normName(q).split(/\s+/).filter(Boolean).map((t) => {
    const m = t.replace(/^#/, '').match(/^([a-z]*\d+[a-z]*)(?:\/0*(\d+))?$/i);
    return m ? { text: t, number: normNumber(m[1]), total: m[2] ?? '' } : { text: t };
  });
}

function cardMatches(e, tokens) {
  return tokens.every((t) => {
    if (t.number) {
      if (e.number === t.number && (!t.total || e.total === t.total)) return true;
      return !t.total && e.words.includes(` ${t.text} `); // a number that's part of a name, e.g. "151"
    }
    return e.words.includes(t.text);
  });
}

/* Best first: the exact name, then names containing the typed words as whole words ("mew"
 * finds Mew ex before Mewtwo), then names starting with them; newest set first within each. */
function rankCards(list, tokens) {
  const text = tokens.filter((t) => !t.number).map((t) => t.text);
  const phrase = text.join(' ');
  const tier = (e) => {
    if (!text.length) return 0;
    if (e.name === phrase) return 0;
    const n = ` ${e.name} `;
    if (text.every((t) => n.includes(` ${t} `))) return 1;
    if (e.name.startsWith(phrase)) return 2;
    if (text.every((t) => n.includes(` ${t}`))) return 3; // starts a word
    return 4;
  };
  for (const e of list) e.tier = tier(e);
  return list.sort((x, y) => x.tier - y.tier
    || (y.c.releaseDate || '').localeCompare(x.c.releaseDate || '') || byNumber(x.c, y.c));
}

const SEARCH_LIMIT = 60;
const SEALED_WORDS = /\b(box|tin|pack|bundle|collection|blister|etb|upc|deck|display|case|premium|booster)\b/i;
let searchToken = 0;
let searchTimer = null;

async function runSearch() {
  const token = ++searchToken;
  const query = els.qName.value;
  const tokens = parseQuery(query);
  if (!tokens.length) {
    els.searchResults.innerHTML = '';
    setStatus(els.searchStatus, '');
    return;
  }
  try {
    await dbReady;
  } catch (err) {
    setStatus(els.searchStatus, `Card database didn't load: ${esc(err.message)}`, 'err');
    return;
  }
  const found = rankCards(getSearchIndex().filter((e) => cardMatches(e, tokens)), tokens).map((e) => e.c);
  // Don't hold results up for the exchange rate (slow offline): sealed prices need it, so
  // use it if it's ready within a moment, otherwise show them without and fill in later.
  const ratePromise = getAudRate();
  const [sealed, rate] = await Promise.all([searchSealed(query),
    Promise.race([ratePromise, sleep(250).then(() => null)])]);
  if (token !== searchToken) return; // a newer search has started
  if (!rate && sealed.length) ratePromise.then(() => { if (token === searchToken) runSearch(); });

  const parts = [
    found.length ? `${found.length.toLocaleString()} card${found.length === 1 ? '' : 's'}` : '',
    sealed.length ? `${sealed.length} sealed` : '',
  ].filter(Boolean);
  setStatus(els.searchStatus,
    parts.length ? parts.join(' · ') + (found.length > SEARCH_LIMIT ? ` — showing the top ${SEARCH_LIMIT}, keep typing to narrow it down` : '')
      : 'Nothing found — try fewer words, or just the card number.',
    parts.length ? 'ok' : 'err');

  const frag = document.createDocumentFragment();
  const heading = (text) => {
    const h = document.createElement('h3');
    h.className = 'sub-title';
    h.textContent = text;
    frag.appendChild(h);
  };
  const showCards = () => {
    if (found.length && sealed.length) heading('Cards');
    for (const c of found.slice(0, SEARCH_LIMIT)) frag.appendChild(cardRow(c));
  };
  const showSealed = () => {
    if (!sealed.length) return;
    heading('Sealed product');
    for (const sp of sealed.slice(0, 20)) {
      const e = sealedEntry(sp);
      frag.appendChild(cardRow({ ...e, number: '', setTotal: '', rarity: sp.type, releaseDate: '' }, {
        onClick: () => openSealedDetail(e),
        extra: sp.usd != null && rate ? formatAud(sp.usd, rate.rate) : '',
      }));
    }
  };
  // Sealed product first when the search is clearly for it (or no card matched).
  if (!found.length || SEALED_WORDS.test(query)) { showSealed(); showCards(); } else { showCards(); showSealed(); }
  els.searchResults.replaceChildren(frag);
}

els.qName.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
els.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  runSearch();
  els.qName.blur(); // close the phone keyboard to see the results
});

/* ------------------------------------------------------------------ */
/* Card list + detail                                                  */
/* ------------------------------------------------------------------ */

function cardRow(card, { score = null, onClick = () => openDetail(card), extra = '' } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card-row';
  btn.innerHTML = `
    <img src="${esc(card.image)}" alt="" loading="lazy">
    <div class="meta">
      <div class="name">${esc(card.name)}</div>
      <div class="sub">${esc(card.setName)}${card.number ? ` · #${esc(card.number)}${card.setTotal ? '/' + esc(card.setTotal) : ''}` : ''}</div>
      <div class="sub">${esc([card.rarity, card.releaseDate?.slice(0, 4),
        score !== null ? `${Math.round(Math.max(0, score) * 100)}% match` : ''].filter(Boolean).join(' · '))}</div>
    </div>${extra ? `<span class="row-price">${esc(extra)}</span>` : ''}`;
  btn.addEventListener('click', onClick);
  return btn;
}

/* Card details. `entryKey` = the collection entry being shown (to edit or remove it). */
/* eBay Australia sold listings for a card (or sealed product): sold + completed, located in
 * Australia, most recently ended first. Opens in the browser, where you're signed in to eBay
 * (it needs that to show sold results). Finishes that change the price narrow the search. */
const EBAY_FINISH_WORDS = {
  reverseHolofoil: 'reverse holo',
  '1stEditionHolofoil': '1st edition',
  '1stEditionNormal': '1st edition',
};
/* Classic Collection reprints carry the original card's name and printed number (Charizard
 * "4/102"), so they're searched as the original and told apart by the words in sale titles
 * (tools/au-sold-filter.mjs). Built once from the card list: reprint id → original card, and the
 * originals that were reprinted. */
const REPRINT_SETS = { cel25c: 'r25', me55c: 'r30' };
let reprintIndex = null;
function reprintInfo(item) {
  if (!db.cards) return {};
  if (!reprintIndex) {
    const earliest = new Map();
    for (const c of db.cards) {
      if (REPRINT_SETS[c.setId]) continue;
      const k = `${c.name}|${c.number}`;
      if (!earliest.has(k) || (c.releaseDate || '') < (earliest.get(k).releaseDate || '')) earliest.set(k, c);
    }
    reprintIndex = { of: new Map(), originals: new Set() };
    for (const c of db.cards) {
      const o = REPRINT_SETS[c.setId] && earliest.get(`${c.name}|${c.number}`);
      if (o && (o.releaseDate || '') < (c.releaseDate || '')) { reprintIndex.of.set(c.id, o); reprintIndex.originals.add(o.id); }
    }
  }
  const original = reprintIndex.of.get(item.id);
  if (original) return { original, t: REPRINT_SETS[item.setId] };
  return reprintIndex.originals.has(item.id) ? { t: 'o' } : {};
}

/* What to search eBay for: { q: words, n: the number as printed ('' for sealed), t: reprint mode }. */
function ebaySoldQuery(item, variant = null) {
  let q;
  let n = '';
  let t = '';
  if (item.kind === 'sealed') {
    q = item.name.replace(/\bPokemon\b/gi, '').replace(/[[\]()]/g, ' ');
  } else {
    // Search the number as it's printed (and so how sellers list it): "4/102" on older
    // cards, "025/165" from Sword & Shield (2020) on; promos and gallery cards ("SWSH020",
    // "TG05") have no set size.
    const rp = reprintInfo(item);
    t = rp.t || '';
    const printed = rp.original ?? item; // a reprint is printed with the original's number
    const raw = String(printed.number);
    const coded = /^[A-Z]/i.test(raw) || /promo/i.test(printed.setName || '');
    const digits = raw.replace(/^0+(?=\d)/, '');
    const num = !coded && (printed.releaseDate || '') >= '2020' && /^\d+$/.test(digits) ? digits.padStart(3, '0') : digits;
    const total = num !== digits ? String(printed.setTotal).padStart(3, '0') : printed.setTotal;
    n = coded || !printed.setTotal ? raw : `${num}/${total}`;
    // Sellers write "Gold Star", not ★ (and often leave out δ).
    q = `${item.name.replace(/★/g, ' Gold Star').replace(/δ/g, '')} ${n}`;
    const finish = variant?.startsWith('x:') ? variant.slice(2).replace(/\bPattern\b/i, '').trim() : EBAY_FINISH_WORDS[variant];
    if (finish) q += ` ${finish}`;
  }
  return { q: q.replace(/\s+/g, ' ').trim(), n, t };
}
function ebaySoldUrl(item, variant = null) {
  const q = `pokemon ${ebaySoldQuery(item, variant).q}`;
  return `https://www.ebay.com.au/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_PrefLoc=1&_sop=13`;
}

/* AU sold price box under the main price. `show(au)` gets the answer (or null). */
function auSoldText(au, tcgText) {
  const tcg = tcgText ? ` · TCGplayer ${tcgText}` : '';
  if (au?.ok) {
    return `Median of ${au.n} Australian eBay sales, last 90 days (${formatAudPlain(au.low)}–${formatAudPlain(au.high)})${tcg}`;
  }
  const why = !au ? "Couldn't check Australian sales"
    : au.reason === 'few-sales' ? 'Not enough Australian sales to price it'
      : au.reason === 'daily-limit' ? 'Australian sold lookups are paused until tomorrow'
        : "Couldn't check Australian sales";
  return `${why} — showing TCGplayer (US) market price`;
}
function auSoldRecent(au) {
  if (!au?.ok || !au.recent?.length) return '';
  return `<details class="au-recent"><summary>Recent Australian sales</summary><ul>${au.recent.map((r) =>
    `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(formatAudPlain(r.aud))} · ${esc(r.date)}</a> <span>${esc(r.title)}</span></li>`).join('')}</ul></details>`;
}

// The nightly AU sold list loads in the background; re-total the collection once it's in.
auPreReady.then(() => { if (collectionPrices) renderCollection(); });

/* Value of one collection entry in USD: the AU sold price when one has been looked up,
 * otherwise TCGplayer. */
function entryUsd(e, prices, sealed, rate) {
  const au = rate && auSoldCached(...Object.values(ebaySoldQuery(e, e.variant)), { anyAge: true });
  if (au?.ok) return (au.aud / rate.rate) * (e.kind === 'sealed' ? 1 : conditionFactor(e.condition));
  return e.kind === 'sealed' ? sealed?.byKey.get(e.id)?.usd ?? null : cardUsd(e, prices[e.id]);
}
const ebayButton = (url) => `<a class="btn ghost ebay-sold" href="${esc(url)}" target="_blank" rel="noopener">Check AU sold prices on eBay ↗</a>`;

/* Each opened sheet gets a number; a price that arrives after another sheet has opened
 * (they load asynchronously) is dropped instead of landing in the wrong sheet. */
let sheetToken = 0;

function openDetail(card, { entryKey = null } = {}) {
  const token = ++sheetToken;
  const inCollection = entryKey !== null;
  let variant = card.variant ?? null; // finish picked in this sheet
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
    <div class="detail-price">
      <span class="price-label">Market price (AUD)</span>
      <span class="price-value none" id="detailPrice">Loading…</span>
      <div class="variant-chips" id="detailChips"></div>
      <span class="price-note" id="detailNote"></span>
      <div id="auRecent"></div>
    </div>
    ${inCollection ? `<div class="detail-price cond-box">
      <span class="price-label">Your copy's condition</span>
      <div class="variant-chips" id="condChips">${CONDITIONS.map(([k, label]) =>
        `<button type="button" class="chip" data-cond="${k}" title="${esc(label)}">${k}</button>`).join('')}</div>
      <span class="price-note" id="condNote"></span>
    </div>` : ''}
    <table class="detail-table">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <div class="detail-actions">
      ${inCollection
        ? `<div class="qty-row">
             <span>Quantity</span>
             <div class="stepper">
               <button type="button" class="step" id="qtyDown" aria-label="One less">−</button>
               <span id="qtyValue"></span>
               <button type="button" class="step" id="qtyUp" aria-label="One more">＋</button>
             </div>
           </div>
           <label class="toggle-row"><span>For trade / sale</span><input type="checkbox" id="tradeToggle"></label>
           <button class="btn ghost" id="detailRemove">Remove from collection</button>`
        : '<button class="btn primary" id="detailAdd">＋ Add to collection</button>'}
      ${ebayButton(ebaySoldUrl(card, variant))}
    </div>`;

  const showQty = () => {
    const entry = loadCollection().find((e) => e.key === entryKey);
    if (!entry) return;
    $('qtyValue').textContent = entry.qty;
    $('qtyDown').disabled = entry.qty <= 1;
  };
  const changeQty = (delta) => {
    updateEntry(entryKey, (e) => { e.qty = Math.max(1, e.qty + delta); });
    showQty();
    renderCollection();
  };

  $('detailAdd')?.addEventListener('click', () => {
    const qty = addToCollection(card, variant);
    els.detail.close();
    toast(qty > 1 ? `Added ${card.name} — you have ${qty}` : `Added ${card.name} to your collection`);
    if (shownCard?.id === card.id && stream) resumeScanning();
  });
  $('detailRemove')?.addEventListener('click', () => {
    saveCollection(loadCollection().filter((e) => e.key !== entryKey));
    els.detail.close();
    renderCollection();
    toast(`Removed ${card.name}`);
  });
  $('qtyDown')?.addEventListener('click', () => changeQty(-1));
  $('qtyUp')?.addEventListener('click', () => changeQty(1));
  if (inCollection) showQty();
  wireTradeToggle(() => entryKey);

  // Condition (collection cards): value = market price × the condition's factor.
  let unitUsd = null;
  let condRate = null;
  const showCondition = () => {
    const chips = $('condChips');
    if (!chips) return;
    const cond = loadCollection().find((e) => e.key === entryKey)?.condition ?? 'NM';
    chips.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.cond === cond));
    const [, label, factor] = CONDITIONS.find(([k]) => k === cond);
    $('condNote').textContent = unitUsd == null || !condRate ? label
      : `${label}: valued at ${Math.round(factor * 100)}% = ${formatAud(unitUsd * factor, condRate.rate)} each`;
  };
  $('condChips')?.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    entryKey = setEntryCondition(entryKey, b.dataset.cond);
    showQty();
    showCondition();
    renderCollection();
  }));
  getAudRate().then((r) => { condRate = r; showCondition(); });
  showCondition();

  els.detail.showModal();

  // Price, with a chip per finish (picking one changes the saved card's finish).
  Promise.all([getTcgPrices([card.id]), getAudRate()]).then(([prices, rate]) => {
    if (token !== sheetToken) return;
    const priceEl = $('detailPrice');
    if (!priceEl) return;
    const info = prices[card.id];
    const variants = priceVariants(info?.prices);
    if (!variants.length) {
      priceEl.textContent = info ? 'No price available' : "Couldn't load price";
      return;
    }
    const label = els.detailBody.querySelector('.detail-price .price-label');
    let auReq = 0;
    // AU sold price for the picked finish replaces the main price (TCGplayer in the note).
    const showAu = (v, au) => {
      const tcg = formatAud(v.usd, rate.rate);
      if (au?.ok) {
        unitUsd = au.aud / rate.rate;
        priceEl.textContent = formatAudPlain(au.aud);
        label.textContent = 'AU sold price';
      } else {
        unitUsd = v.usd;
        priceEl.textContent = tcg;
        label.textContent = 'Market price (AUD)';
      }
      priceEl.className = 'price-value';
      $('detailNote').innerHTML = au === undefined ? 'Checking Australian eBay sales (can take ~20 s)…'
        : esc(auSoldText(au, au?.ok ? tcg : '')) + (info.url ? ` · <a href="${esc(info.url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : '');
      $('auRecent').innerHTML = auSoldRecent(au);
      showCondition();
      if (inCollection && au?.ok) renderCollection();
    };
    const lookupAu = async (v) => {
      const { q, n, t } = ebaySoldQuery(card, v.key);
      const req = ++auReq;
      const cached = auSoldCached(q, n, t);
      showAu(v, cached ?? undefined);
      if (cached) return;
      const au = await getAuSold(q, n, t);
      if (token === sheetToken && req === auReq && $('detailNote')) showAu(v, au);
    };
    const pick = (v, save) => {
      variant = v.key;
      els.detailBody.querySelector('.ebay-sold')?.setAttribute('href', ebaySoldUrl(card, variant));
      lookupAu(v);
      $('detailChips').querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.key === v.key));
      if (save) rememberFinish(card.id, v.key);
      if (save && inCollection) {
        entryKey = setEntryVariant(entryKey, v.key);
        showQty();
        renderCollection();
      }
    };
    if (variants.length > 1) {
      for (const v of variants) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.key = v.key;
        chip.textContent = `${v.label} · ${formatAud(v.usd, rate.rate)}`;
        chip.addEventListener('click', () => pick(v, true));
        $('detailChips').appendChild(chip);
      }
    }
    pick(variants.find((v) => v.key === variant) ?? variants.find((v) => v.key === lastFinish(card.id)) ?? variants[0], false);
  });
}

/* Tap the dark backdrop to close the sheet. */
els.detail.addEventListener('click', (e) => { if (e.target === els.detail) els.detail.close(); });

/* ------------------------------------------------------------------ */
/* Collection (per-device)                                             */
/* ------------------------------------------------------------------ */

/* One entry per card + finish: { key, ...card, variant, qty, addedAt }. */
const COLLECTION_KEY = 'pokescan.collection.v2';
const OLD_HISTORY_KEY = 'pokescan.history.v1'; // one row per scan, no quantities
const SORT_KEY = 'pokescan.collectionSort';
const CARD_FIELDS = ['id', 'name', 'number', 'rarity', 'setId', 'setName', 'setSeries', 'setTotal',
  'releaseDate', 'image', 'imageLarge', 'kind', 'type'];

// Near Mint keeps the plain key, so collections from before conditions existed are unchanged.
const entryKeyOf = (id, variant, condition = null) =>
  `${id}|${variant || ''}${condition && condition !== 'NM' ? `|${condition}` : ''}`;

/* Card condition and how much of the (Near Mint) market price each is valued at.
 * Edit freely. Entries without a condition are Near Mint. */
const CONDITIONS = [
  ['NM', 'Near Mint', 1],
  ['LP', 'Lightly Played', 0.85],
  ['MP', 'Moderately Played', 0.7],
  ['HP', 'Heavily Played', 0.5],
  ['DMG', 'Damaged', 0.3],
];
const conditionFactor = (c) => CONDITIONS.find(([k]) => k === c)?.[2] ?? 1;

/* Change an entry's condition, merging into an existing entry of that condition. Returns the new key. */
function setEntryCondition(key, condition) {
  const list = loadCollection();
  const entry = list.find((e) => e.key === key);
  if (!entry) return key;
  const newKey = entryKeyOf(entry.id, entry.variant, condition);
  if (newKey === key) return key;
  const other = list.find((e) => e.key === newKey);
  if (other) {
    other.qty += entry.qty;
    other.trade ||= entry.trade;
    list.splice(list.indexOf(entry), 1);
  } else {
    entry.key = newKey;
    if (condition && condition !== 'NM') entry.condition = condition;
    else delete entry.condition;
  }
  saveCollection(list);
  return newKey;
}

function loadCollection() {
  try {
    const saved = localStorage.getItem(COLLECTION_KEY);
    if (saved) return JSON.parse(saved) || [];
    // First run after the update: turn the old scan list into entries with quantities.
    const old = JSON.parse(localStorage.getItem(OLD_HISTORY_KEY)) || [];
    const list = [];
    for (const card of old) {
      const key = entryKeyOf(card.id, card.variant);
      const entry = list.find((e) => e.key === key);
      if (entry) {
        entry.qty++;
      } else {
        list.push({ ...pickCard(card), key, variant: card.variant ?? null, qty: 1, addedAt: card.scannedAt || '' });
      }
    }
    saveCollection(list);
    return list;
  } catch {
    return [];
  }
}

function saveCollection(list) {
  try { localStorage.setItem(COLLECTION_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

const pickCard = (card) => Object.fromEntries(CARD_FIELDS.map((f) => [f, card[f]]));

/* Add one copy of a card in a finish. Returns how many of it you now have. */
function addToCollection(card, variant) {
  const list = loadCollection();
  const key = entryKeyOf(card.id, variant);
  let entry = list.find((e) => e.key === key);
  if (entry) {
    entry.qty++;
    entry.addedAt = new Date().toISOString();
  } else {
    entry = { ...pickCard(card), key, variant: variant ?? null, qty: 1, addedAt: new Date().toISOString() };
    list.push(entry);
  }
  saveCollection(list);
  return entry.qty;
}

function updateEntry(key, fn) {
  const list = loadCollection();
  const entry = list.find((e) => e.key === key);
  if (entry) fn(entry);
  saveCollection(list);
}

/* Change an entry's finish, merging it into an existing entry of that finish. Returns the new key. */
function setEntryVariant(key, variant) {
  const list = loadCollection();
  const entry = list.find((e) => e.key === key);
  if (!entry) return key;
  const newKey = entryKeyOf(entry.id, variant, entry.condition);
  if (newKey === key) return key;
  const other = list.find((e) => e.key === newKey);
  if (other) {
    other.qty += entry.qty;
    other.trade ||= entry.trade;
    list.splice(list.indexOf(entry), 1);
  } else {
    Object.assign(entry, { key: newKey, variant });
  }
  saveCollection(list);
  return newKey;
}

/* USD value of one copy, using the entry's finish and condition. */
function cardUsd(entry, info) {
  const variants = priceVariants(info?.prices);
  const usd = (variants.find((v) => v.key === entry.variant) ?? variants[0])?.usd ?? null;
  return usd == null ? null : usd * conditionFactor(entry.condition);
}

/* "12", "TG05", "SV001" → sortable by number, then text. */
const numberKey = (n) => {
  const m = String(n).match(/(\d+)/);
  return [m ? Number(m[1]) : Infinity, String(n)];
};
const byNumber = (a, b) => {
  const [na, sa] = numberKey(a.number);
  const [nb, sb] = numberKey(b.number);
  return na - nb || sa.localeCompare(sb);
};

const SORTS = {
  recent: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
  value: (a, b) => (b.total ?? -1) - (a.total ?? -1),
  valueAsc: (a, b) => (a.total ?? Infinity) - (b.total ?? Infinity),
  name: (a, b) => a.name.localeCompare(b.name) || (b.releaseDate || '').localeCompare(a.releaseDate || ''),
  set: (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')
    || (a.setName || '').localeCompare(b.setName || '') || byNumber(a, b),
  qty: (a, b) => b.qty - a.qty || a.name.localeCompare(b.name),
};

try { els.collectionSort.value = localStorage.getItem(SORT_KEY) || 'recent'; } catch { /* no storage */ }
if (!SORTS[els.collectionSort.value]) els.collectionSort.value = 'recent';

/* Latest prices for the collection: { prices, rate } once loaded. */
let collectionPrices = null;
let collectionToken = 0;

/* Draw the collection from storage + the last loaded prices (no network). */
function renderCollection() {
  const list = loadCollection();
  const count = list.reduce((n, e) => n + e.qty, 0);
  els.collectionCount.textContent = count ? `(${count})` : '';
  els.valueCard.hidden = !list.length;
  els.collectionTools.hidden = !list.length;
  els.clearHistory.hidden = !list.length;

  const { prices, rate, sealed } = collectionPrices ?? {};
  let total = 0;
  let pricedCards = 0;
  renderValueTrend(list);
  for (const e of list) {
    const usd = !prices ? null : entryUsd(e, prices, sealed, rate);
    e.unit = usd;
    e.total = usd == null ? null : usd * e.qty;
    if (usd != null) {
      total += e.total;
      pricedCards += e.qty;
    }
  }
  if (!list.length) {
    els.valueTotal.textContent = '—';
  } else if (prices) {
    els.valueTotal.textContent = formatAud(total, rate.rate);
    const sealedCount = list.filter((e) => e.kind === 'sealed').reduce((n, e) => n + e.qty, 0);
    const what = sealedCount ? `${count} item${count === 1 ? '' : 's'}` : `${count} card${count === 1 ? '' : 's'}`;
    els.valueNote.textContent = `${what} (${list.length} different) · `
      + `${pricedCards} priced · AU sold prices for items you've opened, otherwise TCGplayer market prices in AUD${rate.approx ? ' (approx. exchange rate)' : ''}`
      + (collectionPrices.age ? ` · ${collectionPrices.age}` : '');
  } else {
    els.valueTotal.textContent = 'Loading…';
    els.valueNote.textContent = '';
  }

  renderSetFilter(list);
  renderValueBySet(list, rate);
  renderTradeBar(list, rate);
  const q = normName(els.collectionSearch.value.trim());
  const onlySet = els.collectionSet.value;
  const shown = list
    .filter((e) => (onlySet === TRADE_FILTER ? e.trade : !onlySet || e.setId === onlySet))
    .filter((e) => !q || normName(`${e.name} ${e.setName} ${e.number} ${variantLabel(e.variant)}`).includes(q))
    .sort(SORTS[els.collectionSort.value] ?? SORTS.recent);

  els.historyList.innerHTML = '';
  if (!list.length) {
    els.historyList.innerHTML = '<p class="empty">No cards yet — scan one and tap “Add to collection”.</p>';
    return;
  }
  if (!shown.length) {
    els.historyList.innerHTML = '<p class="empty">No cards match your search.</p>';
    return;
  }
  for (const e of shown) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'grid-item';
    const finish = [e.variant ? variantLabel(e.variant) : '', e.condition && e.condition !== 'NM' ? e.condition : '']
      .filter(Boolean).join(' · ');
    const price = e.unit == null ? ''
      : e.qty > 1 ? `${formatAud(e.total, rate.rate)} <small>(${e.qty} × ${formatAud(e.unit, rate.rate)})</small>`
        : formatAud(e.unit, rate.rate);
    item.innerHTML = `
      <div class="thumb"><img src="${esc(e.image)}" alt="" loading="lazy">${e.qty > 1 ? `<span class="qty">×${e.qty}</span>` : ''}</div>
      <span class="name">${esc(e.name)}</span>
      <span class="sub">${esc(e.setName)}${e.kind === 'sealed' ? '' : ` · #${esc(e.number)}`}</span>
      ${e.kind === 'sealed' ? `<span class="sub finish">${esc(e.type)}</span>` : ''}
      ${finish ? `<span class="sub finish">${esc(finish)}</span>` : ''}
      <span class="price">${price}</span>`;
    item.addEventListener('click', () => (e.kind === 'sealed'
      ? openSealedDetail(e, { entryKey: e.key }) : openDetail(e, { entryKey: e.key })));
    els.historyList.appendChild(item);
  }
}

/* Load prices for everything in the collection, then redraw. */
async function refreshCollection() {
  const token = ++collectionToken;
  renderCollection();
  const list = loadCollection();
  if (!list.length) return;
  getHistory().then((h) => { valueHistory = h; renderValueTrend(); });
  const ids = [...new Set(list.filter((e) => e.kind !== 'sealed').map((e) => e.id))];
  const [prices, rate, sealed] = await Promise.all([getTcgPrices(ids), getAudRate(),
    list.some((e) => e.kind === 'sealed') ? getSealed() : null]);
  if (token !== collectionToken) return;
  collectionPrices = { prices, rate, sealed, age: await priceAgeNote() };
  renderCollection();
}

els.collectionSearch.addEventListener('input', renderCollection);
els.collectionSort.addEventListener('change', () => {
  try { localStorage.setItem(SORT_KEY, els.collectionSort.value); } catch { /* no storage */ }
  renderCollection();
});

els.clearHistory.addEventListener('click', () => {
  $('collectionMenu').open = false;
  if (confirm('Remove everything from your collection on this device? (Back it up first if you might want it again.)')) {
    saveCollection([]);
    renderCollection();
  }
});

/* Set filter: the sets that are in the collection, newest first. */
function renderSetFilter(list) {
  const sets = new Map();
  for (const e of list) if (e.setId && !sets.has(e.setId)) sets.set(e.setId, e);
  const want = [...sets.values()].sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  const trading = list.filter((e) => e.trade).length;
  const key = want.map((e) => e.setId).join(',') + `|${trading}`;
  if (els.collectionSet.dataset.key === key) return;
  const current = els.collectionSet.value;
  els.collectionSet.innerHTML = '<option value="">All sets</option>'
    + (trading ? `<option value="${TRADE_FILTER}">⇄ Trade / sale list (${trading})</option>` : '')
    + want.map((e) => `<option value="${esc(e.setId)}">${esc(e.setName)}</option>`).join('');
  els.collectionSet.value = sets.has(current) || (current === TRADE_FILTER && trading) ? current : '';
  els.collectionSet.dataset.key = key;
  els.collectionSet.hidden = want.length < 2 && !trading;
}
els.collectionSet.addEventListener('change', renderCollection);

/* ------------------------------------------------------------------ */
/* Trade / sale list: flag items in their sheet, share them as text    */
/* ------------------------------------------------------------------ */

const TRADE_FILTER = '__trade';
const TRADE_PCT_KEY = 'pokescan.tradePct';

/* The "For trade / sale" switch in a collection item's sheet. */
function wireTradeToggle(getKey) {
  const box = $('tradeToggle');
  if (!box) return;
  box.checked = !!loadCollection().find((e) => e.key === getKey())?.trade;
  box.addEventListener('change', () => {
    updateEntry(getKey(), (e) => {
      if (box.checked) e.trade = true;
      else delete e.trade;
    });
    renderCollection();
    toast(box.checked ? 'Added to your trade / sale list' : 'Removed from your trade / sale list');
  });
}

function tradePct() {
  try { return Number(localStorage.getItem(TRADE_PCT_KEY)) || 100; } catch { return 100; }
}

/* Bar above the trade list: total, "list at N%" and Share. */
function renderTradeBar(list, rate) {
  const bar = $('tradeBar');
  const on = els.collectionSet.value === TRADE_FILTER;
  bar.hidden = !on;
  if (!on) return;
  const items = list.filter((e) => e.trade);
  const usd = items.reduce((sum, e) => sum + (e.total ?? 0), 0);
  const pct = tradePct();
  $('tradePct').value = String(pct);
  const n = `${items.length} item${items.length === 1 ? '' : 's'}`;
  $('tradeTotal').textContent = rate
    ? `${n} · ${formatAud(usd * pct / 100, rate.rate)}${pct !== 100 ? ` (${pct}% of ${formatAud(usd, rate.rate)})` : ''}`
    : n;
}

/* ------------------------------------------------------------------ */
/* Collection value over time + "Your movers"                          */
/* ------------------------------------------------------------------ */

/* From data/history.json (TCGplayer prices per day, USD cents, keyed "cardId:finish" or
 * "s" + product id) × each entry's quantity and condition. Entries with no history for
 * their finish count at today's price on every day, so they don't show as a move. */
let valueHistory = null;
let valueWindow = 7;

$('valueWindow').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  valueWindow = +b.dataset.v;
  $('valueWindow').querySelectorAll('button').forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-pressed', String(x === b));
  });
  renderValueTrend();
}));

const HISTORY_FINISHES = ['h', 'n', '1h', 'uh', '1n', 'u', 'r'];
function historyKey(e, items) {
  if (e.kind === 'sealed') return items[e.id] ? e.id : null;
  const short = VARIANTS.find(([k]) => k === e.variant)?.[1];
  if (short) return items[`${e.id}:${short}`] ? `${e.id}:${short}` : null;
  if (e.variant) return null; // pattern / special finishes aren't tracked
  const f = HISTORY_FINISHES.find((x) => items[`${e.id}:${x}`]);
  return f ? `${e.id}:${f}` : null;
}

function renderValueTrend(list = loadCollection()) {
  const box = $('valueTrend');
  const h = valueHistory;
  const { prices, rate, sealed } = collectionPrices ?? {};
  if (!h || !prices || !list.length || h.dates.length < 2) { box.hidden = true; return; }
  const days = h.dates.length;
  const last = days - 1;
  let from = 0;
  for (let i = last - 1; i >= 0; i--) {
    if ((Date.parse(h.dates[last]) - Date.parse(h.dates[i])) / 86400000 >= valueWindow) { from = i; break; }
  }
  // Daily totals (USD) and per-item moves.
  const totals = Array(days).fill(0);
  const moves = [];
  for (const e of list) {
    const factor = e.kind === 'sealed' ? 1 : conditionFactor(e.condition);
    const key = historyKey(e, h.items);
    const series = key && h.items[key];
    const today = e.kind === 'sealed' ? sealed?.byKey.get(e.id)?.usd ?? null : cardUsd({ variant: e.variant }, prices[e.id]);
    let prev = today != null ? today * 100 : null;
    for (let d = 0; d < days; d++) {
      const cents = series?.[d] ?? null;
      const v = cents ?? prev; // carry the last known price through gaps
      if (v != null) totals[d] += (v / 100) * factor * e.qty;
      if (cents != null) prev = cents;
    }
    const a = series?.[from], b = series?.[last];
    if (a && b && a !== b) moves.push({ e, now: b / 100, pct: ((b - a) / a) * 100, gain: ((b - a) / 100) * factor * e.qty });
  }
  box.hidden = false;
  const change = totals[last] - totals[from];
  const pct = totals[from] ? (change / totals[from]) * 100 : 0;
  const since = from === 0 && (Date.parse(h.dates[last]) - Date.parse(h.dates[0])) / 86400000 < valueWindow
    ? `since ${shortDate(h.dates[0])}` : valueWindow === 1 ? 'since yesterday' : valueWindow === 7 ? 'this week' : 'this month';
  const cents = Math.round(change * rate.rate * 100);
  $('valueChange').innerHTML = !cents ? `<span class="muted">No change ${esc(since)}</span>`
    : `<b class="${cents > 0 ? 'up' : 'down'}">${cents > 0 ? '+' : '−'}${esc(formatAud(Math.abs(change), rate.rate))}</b> ${esc(since)}`
      + ` <span class="${cents > 0 ? 'up' : 'down'}">${cents > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
  $('valueTrendNote').textContent = `TCGplayer price history, ${shortDate(h.dates[0])} – ${shortDate(h.dates[last])}`;

  // Inline SVG line of the daily totals (whole history; the window's start is marked).
  const W = 300, H = 64, pad = 4;
  const min = Math.min(...totals), max = Math.max(...totals), span = max - min || 1;
  const x = (d) => pad + (d / last) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = totals.map((v, d) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  $('valueChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Collection value per day, ${esc(formatAud(min, rate.rate))} to ${esc(formatAud(max, rate.rate))}">
    <line x1="${x(from).toFixed(1)}" x2="${x(from).toFixed(1)}" y1="0" y2="${H}" class="mark"/>
    <polyline points="${pts}" fill="none" class="${change >= 0 ? 'up' : 'down'}"/>
    <circle cx="${x(last).toFixed(1)}" cy="${y(totals[last]).toFixed(1)}" r="3" class="${change >= 0 ? 'up' : 'down'}"/>
  </svg>`;

  // Your movers: up to 5 risers and 5 fallers by percentage.
  const row = (m, i, dir) => `<button type="button" class="card-row mover" data-dir="${dir}" data-i="${i}">
      <img src="${esc(m.e.image || '')}" alt="" loading="lazy">
      <div class="meta"><div class="name">${esc(m.e.name)}</div><div class="sub">${esc(m.e.kind === 'sealed' ? m.e.type || '' : `${m.e.setName} · #${m.e.number}`)}${m.e.qty > 1 ? ` · ×${m.e.qty}` : ''}</div></div>
      <div class="mv"><b>${esc(formatAud(m.now, rate.rate))}</b>
        <span class="${m.pct >= 0 ? 'up' : 'down'}">${m.pct >= 0 ? '▲' : '▼'} ${Math.abs(m.pct).toFixed(Math.abs(m.pct) >= 10 ? 0 : 1)}%</span></div>
    </button>`;
  const up = moves.filter((m) => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 5);
  const down = moves.filter((m) => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 5);
  const groups = { up, down };
  $('yourMovers').innerHTML = !moves.length ? '<p class="muted small-note">None of your items has moved yet.</p>'
    : (up.length ? `<h4 class="sub-title">Your risers</h4><div class="results">${up.map((m, i) => row(m, i, 'up')).join('')}</div>` : '')
      + (down.length ? `<h4 class="sub-title">Your fallers</h4><div class="results">${down.map((m, i) => row(m, i, 'down')).join('')}</div>` : '');
  $('yourMovers').querySelectorAll('.mover').forEach((b) => b.addEventListener('click', () => {
    const { e } = groups[b.dataset.dir][+b.dataset.i];
    if (e.kind === 'sealed') openSealedDetail(e, { entryKey: e.key });
    else openDetail(e, { entryKey: e.key });
  }));
}

/* The list as plain text, ready to paste into Facebook / Discord / Messenger. */
function tradeListText() {
  const { rate, prices, sealed } = collectionPrices ?? {};
  const pct = tradePct();
  // "A$" so it's clear to people outside Australia too.
  const price = (usd) => (usd == null || !rate ? 'offers' : formatAud(usd * pct / 100, rate.rate).replace(/^\$/, 'A$'));
  let total = 0;
  const lines = loadCollection().filter((e) => e.trade).sort(SORTS.set).map((e) => {
    const unit = !prices ? null : entryUsd(e, prices, sealed, rate);
    if (unit != null) total += unit * e.qty;
    const qty = e.qty > 1 ? ` ×${e.qty}` : '';
    const each = e.qty > 1 && unit != null ? ' each' : '';
    if (e.kind === 'sealed') return `${e.name} · ${e.type}${qty} · ${price(unit)}${each}`;
    const num = `#${e.number}${e.setTotal ? '/' + e.setTotal : ''}`;
    const finish = (e.variant ? ` · ${variantLabel(e.variant)}` : '') + (e.condition && e.condition !== 'NM' ? ` · ${e.condition}` : '');
    return `${e.name} · ${e.setName} ${num}${finish}${qty} · ${price(unit)}${each}`;
  });
  const note = pct !== 100 ? ` (${pct}% of market value)` : ' (market value)';
  return ['Pokémon for trade / sale:', ...lines, '', `Total: ${price(total)}${note}`].join('\n');
}

async function shareTradeList() {
  if (!collectionPrices) await refreshCollection();
  const text = tradeListText();
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Trade list copied — paste it anywhere');
  } catch {
    toast('Couldn’t copy the list on this device');
  }
}

$('tradePct').addEventListener('change', () => {
  try { localStorage.setItem(TRADE_PCT_KEY, $('tradePct').value); } catch { /* no storage */ }
  renderCollection();
});
$('tradeShare').addEventListener('click', shareTradeList);

/* Value per set (biggest first), under the total. */
function renderValueBySet(list, rate) {
  const box = $('valueBySet');
  const bySet = new Map();
  for (const e of list) {
    const s = bySet.get(e.setId) ?? { name: e.setName, count: 0, usd: 0 };
    s.count += e.qty;
    s.usd += e.total ?? 0;
    bySet.set(e.setId, s);
  }
  box.hidden = !rate || bySet.size < 2;
  if (box.hidden) return;
  $('valueBySetList').innerHTML = [...bySet.values()].sort((a, b) => b.usd - a.usd).map((s) => `
    <div class="by-set-row"><span>${esc(s.name)} <small>×${s.count}</small></span><b>${formatAud(s.usd, rate.rate)}</b></div>`).join('');
}

/* Backup: the collection as a JSON file, and restoring one. */
$('exportBtn').addEventListener('click', () => {
  $('collectionMenu').open = false;
  const list = loadCollection();
  const blob = new Blob([JSON.stringify({ app: 'PokeScan', version: 2, saved: new Date().toISOString(), collection: list }, null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pokescan-collection-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved a backup of ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
});

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files?.[0];
  $('importFile').value = '';
  $('collectionMenu').open = false;
  if (!file) return;
  let incoming;
  try {
    const j = JSON.parse(await file.text());
    incoming = Array.isArray(j) ? j : j.collection;
    if (!Array.isArray(incoming)) throw new Error('not a PokeScan backup');
    incoming = incoming.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string');
  } catch (err) {
    toast(`Couldn’t read that file: ${err.message}`);
    return;
  }
  // Merge: the same card + finish keeps the larger quantity (restoring a backup twice, or
  // onto the phone it came from, doesn't double anything).
  const list = loadCollection();
  let added = 0;
  for (const e of incoming) {
    const cond = CONDITIONS.some(([k]) => k === e.condition) && e.condition !== 'NM' ? e.condition : null;
    const entry = { ...pickCard(e), key: entryKeyOf(e.id, e.variant, cond), variant: e.variant ?? null, ...(cond && { condition: cond }),
      qty: Math.max(1, Math.floor(Number(e.qty) || 1)), addedAt: e.addedAt || e.scannedAt || '' };
    const have = list.find((x) => x.key === entry.key);
    if (e.trade) entry.trade = true;
    if (have) {
      have.qty = Math.max(have.qty, entry.qty);
      have.trade ||= entry.trade;
    } else {
      list.push(entry);
      added++;
    }
  }
  saveCollection(list);
  refreshCollection();
  toast(`Restored ${incoming.length} entr${incoming.length === 1 ? 'y' : 'ies'} (${added} new)`);
});

/* ------------------------------------------------------------------ */
/* Sealed product                                                      */
/* ------------------------------------------------------------------ */

/* A sealed product (from getSealed) in the shape collection entries use. */
function sealedEntry(s) {
  const set = db.sets?.[s.set] ?? [];
  return {
    id: s.key, name: s.name, number: '', kind: 'sealed', type: s.type,
    setId: s.set, setName: set[0] ?? '', releaseDate: set[3] ?? '', image: s.image,
  };
}

/* Detail sheet for sealed product. Tapping the market price shows the Australian RRP. */
async function openSealedDetail(item, { entryKey = null } = {}) {
  const token = ++sheetToken;
  const inCollection = entryKey !== null;
  const productId = String(item.id).replace(/^s/, '');
  els.detailBody.innerHTML = `
    <img class="detail-img sealed" src="${esc(sealedImage(productId, 400))}" alt="${esc(item.name)}"
         onerror="this.onerror=null;this.src='${esc(item.image)}'">
    <p class="detail-title">${esc(item.name)}</p>
    <p class="detail-sub">${esc(item.setName)} · ${esc(item.type)}</p>
    <button type="button" class="detail-price tap" id="sealedPrice" aria-expanded="false">
      <span class="price-label">Market price (AUD)</span>
      <span class="price-value none" id="detailPrice">Loading…</span>
      <span class="rrp" id="sealedRrp" hidden></span>
      <span class="price-note" id="sealedHint">Tap to compare with Australian RRP</span>
    </button>
    <div id="sealedAuRecent"></div>
    <div class="detail-actions">
      ${inCollection
        ? `<div class="qty-row">
             <span>Quantity</span>
             <div class="stepper">
               <button type="button" class="step" id="qtyDown" aria-label="One less">−</button>
               <span id="qtyValue"></span>
               <button type="button" class="step" id="qtyUp" aria-label="One more">＋</button>
             </div>
           </div>
           <label class="toggle-row"><span>For trade / sale</span><input type="checkbox" id="tradeToggle"></label>
           <button class="btn ghost" id="detailRemove">Remove from collection</button>`
        : '<button class="btn primary" id="detailAdd">＋ Add to collection</button>'}
      ${ebayButton(ebaySoldUrl(item))}
      <a class="btn ghost" href="https://www.tcgplayer.com/product/${esc(productId)}" target="_blank" rel="noopener">View on TCGplayer ↗</a>
    </div>`;
  const showQty = () => {
    const entry = loadCollection().find((e) => e.key === entryKey);
    if (!entry) return;
    $('qtyValue').textContent = entry.qty;
    $('qtyDown').disabled = entry.qty <= 1;
  };
  $('detailAdd')?.addEventListener('click', () => {
    const qty = addToCollection(item, null);
    els.detail.close();
    toast(qty > 1 ? `Added ${item.name} — you have ${qty}` : `Added ${item.name} to your collection`);
  });
  $('detailRemove')?.addEventListener('click', () => {
    saveCollection(loadCollection().filter((e) => e.key !== entryKey));
    els.detail.close();
    renderCollection();
    toast(`Removed ${item.name}`);
  });
  const changeQty = (d) => {
    updateEntry(entryKey, (e) => { e.qty = Math.max(1, e.qty + d); });
    showQty();
    renderCollection();
  };
  $('qtyDown')?.addEventListener('click', () => changeQty(-1));
  $('qtyUp')?.addEventListener('click', () => changeQty(1));
  if (inCollection) showQty();
  wireTradeToggle(() => entryKey);
  els.detail.showModal();

  const [sealed, rate] = await Promise.all([getSealed(), getAudRate()]);
  if (token !== sheetToken) return;
  const s = sealed.byKey.get(`s${productId}`) ?? (item.usd !== undefined ? item : null);
  const priceEl = $('detailPrice');
  if (!priceEl) return;
  if (s?.usd == null) {
    priceEl.textContent = 'No price available';
    return;
  }
  let usd = s.usd;
  let source = 'TCGplayer (US) market price in AUD';
  const showAu = (au) => {
    const tcg = formatAud(s.usd, rate.rate);
    usd = au?.ok ? au.aud / rate.rate : s.usd;
    priceEl.textContent = au?.ok ? formatAudPlain(au.aud) : tcg;
    priceEl.className = 'price-value';
    $('sealedPrice').querySelector('.price-label').textContent = au?.ok ? 'AU sold price' : 'Market price (AUD)';
    source = au === undefined ? 'Checking Australian eBay sales (can take ~20 s)…' : auSoldText(au, au?.ok ? tcg : '');
    $('sealedHint').textContent = $('sealedRrp').hidden ? `${source} · Tap to compare with Australian RRP` : source;
    $('sealedAuRecent').innerHTML = auSoldRecent(au);
    if (!$('sealedRrp').hidden) showRrp();
    if (inCollection && au?.ok) renderCollection();
  };
  const showRrp = () => {
    const rrpEl = $('sealedRrp');
    const cmp = rrpCompare(s.type, usd, rate.rate);
    rrpEl.innerHTML = cmp
      ? `RRP ${formatAudPlain(cmp.rrp)}${cmp.estimate ? ' <small>(estimate)</small>' : ''} · <b class="${cmp.up ? 'up' : 'down'}">${esc(cmp.text)}</b>`
      : 'No Australian RRP for this kind of product';
  };
  $('sealedPrice').addEventListener('click', () => {
    const rrpEl = $('sealedRrp');
    const open = rrpEl.hidden;
    rrpEl.hidden = !open;
    $('sealedPrice').setAttribute('aria-expanded', String(open));
    $('sealedHint').textContent = open ? source : `${source} · Tap to compare with Australian RRP`;
    if (open) showRrp();
  });
  const { q, n, t } = ebaySoldQuery(item);
  const cached = auSoldCached(q, n, t);
  showAu(cached ?? undefined);
  if (!cached) {
    const au = await getAuSold(q, n, t);
    if (token === sheetToken && $('sealedHint')) showAu(au);
  }
}

const formatAudPlain = (aud) => audFormat.format(aud);

/* ------------------------------------------------------------------ */
/* Sets: browse every card in a set                                    */
/* ------------------------------------------------------------------ */

const setsEls = {
  list: $('setsList'), filter: $('setsFilter'), groups: $('setsGroups'),
  page: $('setPage'), back: $('setBack'), head: $('setHead'), show: $('setShow'),
  sealedTitle: $('setSealedTitle'), sealed: $('setSealed'), cards: $('setCards'),
};
let setsRendered = false;
let openSetId = null;
let setShowMode = 'all';

/* How many different cards of each set are in the collection. */
function ownedBySet() {
  const owned = new Map();
  const seen = new Set();
  for (const e of loadCollection()) {
    if (e.kind === 'sealed' || seen.has(e.id)) continue;
    seen.add(e.id);
    owned.set(e.setId, (owned.get(e.setId) || 0) + 1);
  }
  return owned;
}

async function showSets() {
  await dbReady;
  renderReleases();
  if (openSetId) {
    renderSetPage(); // owned marks may have changed
    return;
  }
  if (!setsRendered) await renderSetsList();
  else updateSetCounts();
}

/* Release calendar: upcoming sets (and ones out in the last few weeks) with their key
 * products, release dates, market price and how it compares with Australian RRP. */
const RELEASE_ORDER = ['Booster Box', 'Elite Trainer Box', 'Pokémon Center Elite Trainer Box', 'Booster Bundle',
  'Booster Pack', 'Sleeved Booster Pack', 'Build & Battle Box', '3-Pack Blister', 'Premium Collection',
  'Super-Premium Collection', 'Ultra-Premium Collection', 'Mini Tin', 'Tin', 'Collection Box', 'Blister'];
let releasesRendered = false;

async function renderReleases() {
  if (releasesRendered) return;
  const [data, rate] = await Promise.all([getReleases(), getAudRate()]);
  const box = $('releases');
  if (!data?.releases?.length) return;
  releasesRendered = true;
  const today = new Date(new Date().toDateString());
  const day = (iso) => new Date(`${iso}T00:00:00`);
  const fmt = (iso) => day(iso).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const when = (iso) => {
    const d = Math.round((day(iso) - today) / 86400000);
    return d > 1 ? `in ${d} days` : d === 1 ? 'tomorrow' : d === 0 ? 'out today' : `out ${-d} days ago`;
  };
  const rank = (t) => (RELEASE_ORDER.indexOf(t) + 1 || 99);
  const releases = [...data.releases].sort((a, b) => (day(b.date) >= today) - (day(a.date) >= today) || a.date.localeCompare(b.date));
  box.innerHTML = `<h3 class="sub-title">Release calendar</h3>` + releases.map((r, ri) => {
    const items = r.products.filter((p) => p.usd != null || p.presale).sort((a, b) => rank(a.type) - rank(b.type) || (b.usd ?? 0) - (a.usd ?? 0));
    const row = (p, i) => {
      const cmp = rrpCompare(p.type, p.usd, rate.rate);
      // "Delta Reign Elite Trainer Box" → "Elite Trainer Box" under the Delta Reign heading.
      const short = p.name.toLowerCase().startsWith(r.name.toLowerCase()) ? p.name.slice(r.name.length).trim() || p.name : p.name;
      return `<button type="button" class="rel-row" data-r="${ri}" data-i="${i}">
        <span class="rel-name">${esc(short)}${p.date !== r.date ? ` <small>· ${esc(fmt(p.date))}</small>` : ''}</span>
        <span class="rel-price">${p.usd != null ? formatAud(p.usd, rate.rate) : '—'}${cmp ? `<small class="${cmp.up ? 'up' : 'down'}">${esc(cmp.text)}</small>` : ''}</span>
      </button>`;
    };
    const upcoming = day(r.date) >= today;
    return `<div class="release${upcoming ? ' upcoming' : ''}">
      <div class="rel-head"${r.set ? ` data-set="${esc(r.set)}" role="button" tabindex="0"` : ''}>
        <b>${esc(r.name)}</b><span>${esc(fmt(r.date))} · <span class="${upcoming ? 'up' : ''}">${esc(when(r.date))}</span></span>
      </div>
      ${items.slice(0, 5).map(row).join('')}
      ${items.length > 5 ? `<details><summary>${items.length - 5} more products</summary>${items.slice(5).map((p, i) => row(p, i + 5)).join('')}</details>` : ''}
    </div>`;
  }).join('') + '<p class="muted small-note">Market prices from TCGplayer (presale prices before release) in AUD. RRP comparison uses the table in prices.js.</p>';
  box.hidden = false;
  const sortedItems = releases.map((r) => r.products.filter((p) => p.usd != null || p.presale)
    .sort((a, b) => rank(a.type) - rank(b.type) || (b.usd ?? 0) - (a.usd ?? 0)));
  box.querySelectorAll('.rel-row').forEach((b) => b.addEventListener('click', () => {
    const r = releases[+b.dataset.r];
    const p = sortedItems[+b.dataset.r][+b.dataset.i];
    openSealedDetail({ id: `s${p.id}`, name: p.name, number: '', kind: 'sealed', type: p.type, setId: r.set,
      setName: r.set ? db.sets[r.set]?.[0] ?? r.name : r.name, releaseDate: r.date, image: sealedImage(p.id), usd: p.usd });
  }));
  box.querySelectorAll('.rel-head[data-set]').forEach((h) => h.addEventListener('click', () => openSet(h.dataset.set)));
}

async function renderSetsList() {
  const info = await getSetsInfo();
  const counts = new Map();
  for (const c of db.cards) counts.set(c.setId, (counts.get(c.setId) || 0) + 1);
  // Series, newest first; sets in each newest first.
  const bySeries = new Map();
  for (const [id, [name, series, , date]] of Object.entries(db.sets)) {
    if (!counts.get(id)) continue;
    if (!bySeries.has(series)) bySeries.set(series, []);
    bySeries.get(series).push({ id, name, date: date || '' });
  }
  const groups = [...bySeries].map(([series, sets]) => ({
    series, sets: sets.sort((a, b) => b.date.localeCompare(a.date)),
  })).sort((a, b) => b.sets[0].date.localeCompare(a.sets[0].date));
  setsEls.groups.innerHTML = groups.map((g) => `
    <section class="set-group" data-series="${esc(g.series)}">
      <h3 class="sub-title">${esc(g.series)}</h3>
      ${g.sets.map((st) => `
        <button type="button" class="set-row" data-id="${esc(st.id)}" data-name="${esc(normName(st.name))}">
          <span class="set-icon">${info[st.id]?.symbol ? `<img src="${esc(info[st.id].symbol)}" alt="" loading="lazy">` : ''}</span>
          <span class="set-meta"><span class="name">${esc(st.name)}</span>
            <span class="sub">${esc(st.date.slice(0, 4))} · ${counts.get(st.id)} cards</span></span>
          <span class="set-owned" data-owned="${esc(st.id)}"></span>
        </button>`).join('')}
    </section>`).join('');
  setsEls.groups.querySelectorAll('.set-row').forEach((b) => b.addEventListener('click', () => openSet(b.dataset.id)));
  setsRendered = true;
  updateSetCounts();
}

function updateSetCounts() {
  const owned = ownedBySet();
  setsEls.groups.querySelectorAll('[data-owned]').forEach((el) => {
    const n = owned.get(el.dataset.owned) || 0;
    el.textContent = n ? `${n} owned` : '';
  });
}

setsEls.filter.addEventListener('input', () => {
  const q = normName(setsEls.filter.value.trim());
  setsEls.groups.querySelectorAll('.set-group').forEach((g) => {
    let any = false;
    g.querySelectorAll('.set-row').forEach((r) => {
      const hit = !q || r.dataset.name.includes(q) || normName(g.dataset.series).includes(q);
      r.hidden = !hit;
      any ||= hit;
    });
    g.hidden = !any;
  });
});

function openSet(id) {
  openSetId = id;
  setsEls.list.hidden = true;
  setsEls.page.hidden = false;
  window.scrollTo(0, 0);
  renderSetPage();
}

setsEls.back.addEventListener('click', () => {
  openSetId = null;
  setsEls.page.hidden = true;
  setsEls.list.hidden = false;
  updateSetCounts();
});

setsEls.show.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  setShowMode = b.dataset.v;
  setsEls.show.querySelectorAll('button').forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-pressed', String(x === b));
  });
  renderSetPage();
}));

/* "Cost to finish": the missing cards at market price (cheapest finish), for the whole set
 * and for the main set (numbers up to the printed total, i.e. without secret rares). */
function finishCostText(cards, qtyById, prices, printed, rate) {
  const total = (list) => {
    let usd = 0, unpriced = 0;
    for (const c of list) {
      const finishes = priceVariants(prices[c.id]?.prices).map((v) => v.usd).filter((u) => u != null);
      if (finishes.length) usd += Math.min(...finishes);
      else unpriced++;
    }
    return `${formatAud(usd, rate)}${unpriced ? ` + ${unpriced} unpriced` : ''}`;
  };
  const missing = cards.filter((c) => !qtyById.has(c.id));
  if (!missing.length) return '';
  const main = printed ? missing.filter((c) => /^\d+$/.test(c.number) && +c.number <= printed) : [];
  const mainNote = main.length && main.length < missing.length ? ` · main set (${main.length}): ${total(main)}` : '';
  return `To finish: ${missing.length} missing ≈ ${total(missing)}${mainNote}`;
}

let setToken = 0;
async function renderSetPage() {
  const token = ++setToken;
  const id = openSetId;
  const [name, series, printed, date] = db.sets[id] ?? [];
  const cards = db.cards.filter((c) => c.setId === id).sort(byNumber);
  const qtyById = new Map();
  for (const e of loadCollection()) if (e.kind !== 'sealed') qtyById.set(e.id, (qtyById.get(e.id) || 0) + e.qty);
  const ownedCount = cards.filter((c) => qtyById.has(c.id)).length;
  const info = (await getSetsInfo())[id];
  setsEls.head.innerHTML = `
    ${info?.logo ? `<img class="set-logo" src="${esc(info.logo)}" alt="${esc(name)}">` : ''}
    <p class="detail-title">${esc(name)}</p>
    <p class="detail-sub">${esc(series)} · ${esc(date || '')}${printed ? ` · ${printed} in the main set` : ''}</p>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${cards.length}" aria-valuenow="${ownedCount}">
      <span style="width:${cards.length ? (100 * ownedCount / cards.length).toFixed(1) : 0}%"></span></div>
    <p class="muted center" id="setSummary">You have ${ownedCount} of ${cards.length} cards</p>
    <p class="muted center set-finish" id="setFinish"></p>`;

  const shown = cards.filter((c) => setShowMode === 'all'
    || (setShowMode === 'owned' ? qtyById.has(c.id) : !qtyById.has(c.id)));
  setsEls.cards.innerHTML = shown.length ? '' : `<p class="empty">${setShowMode === 'owned' ? 'None of this set yet.' : 'You have every card!'}</p>`;
  const priceEls = new Map();
  for (const c of shown) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `grid-item${qtyById.has(c.id) ? ' owned' : ''}`;
    const q = qtyById.get(c.id);
    item.innerHTML = `
      <div class="thumb"><img src="${esc(c.image)}" alt="" loading="lazy">${q ? `<span class="qty owned-mark" aria-label="Owned">${q > 1 ? '×' + q : '✓'}</span>` : ''}</div>
      <span class="name">${esc(c.name)}</span>
      <span class="sub">#${esc(c.number)}${c.rarity ? ` · ${esc(c.rarity)}` : ''}</span>
      <span class="price"></span>`;
    item.addEventListener('click', () => openDetail(c));
    setsEls.cards.appendChild(item);
    priceEls.set(c.id, item.querySelector('.price'));
  }

  const [prices, rate, sealed] = await Promise.all([getTcgPrices(cards.map((c) => c.id)), getAudRate(), getSealed()]);
  if (token !== setToken) return;
  let setValue = 0;
  for (const c of cards) {
    const usd = priceVariants(prices[c.id]?.prices)[0]?.usd;
    if (usd != null && qtyById.has(c.id)) setValue += usd * qtyById.get(c.id);
    const el = priceEls.get(c.id);
    if (el && usd != null) el.textContent = formatAud(usd, rate.rate);
  }
  if (ownedCount) $('setSummary').textContent += ` · worth about ${formatAud(setValue, rate.rate)}`;
  $('setFinish').textContent = finishCostText(cards, qtyById, prices, printed, rate.rate);

  const items = sealed.items.filter((s) => s.set === id && s.type !== 'Case')
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  setsEls.sealedTitle.hidden = !items.length;
  setsEls.sealed.innerHTML = '';
  for (const s of items) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sealed-tile';
    tile.innerHTML = `<img src="${esc(s.image)}" alt="" loading="lazy">
      <span class="name">${esc(s.type === 'Other' ? s.name : s.type)}</span>
      <span class="price">${s.usd != null ? formatAud(s.usd, rate.rate) : ''}</span>`;
    tile.title = s.name;
    tile.addEventListener('click', () => openSealedDetail(sealedEntry(s)));
    setsEls.sealed.appendChild(tile);
  }
}

/* ------------------------------------------------------------------ */
/* Market: movers and highs / lows                                     */
/* ------------------------------------------------------------------ */

const marketEls = { window: $('marketWindow'), kind: $('marketKind'), note: $('marketNote'), body: $('marketBody') };
const market = { window: '1', kind: 'cards' };

for (const [el, key] of [[marketEls.window, 'window'], [marketEls.kind, 'kind']]) {
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    market[key] = b.dataset.v;
    el.querySelectorAll('button').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderMarket();
  }));
}

const finishFromShort = (short) => VARIANTS.find(([, s]) => s === short)?.[0] ?? null;
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

let marketToken = 0;
async function renderMarket() {
  const token = ++marketToken;
  marketEls.body.innerHTML = '<p class="empty"><span class="spinner"></span>Loading market data…</p>';
  const [data, rate, sealed] = await Promise.all([getMarket(), getAudRate(), getSealed(), dbReady]);
  if (token !== marketToken) return;
  if (!data) {
    marketEls.body.innerHTML = '<p class="empty">Market data isn’t available right now. Try again later.</p>';
    return;
  }
  const w = data.movers[market.window];
  marketEls.note.textContent = (w ? `Comparing with ${shortDate(w.from)}. ` : '')
    + `“Highest” and “lowest” mean since tracking began on ${shortDate(data.since)}. TCGplayer market prices in AUD.`;

  // [key, nowCents, otherCents, pct?] → a row.
  const resolve = (key) => {
    if (/^s\d+$/.test(key)) { // card ids can start with "s" too (sv8pt5-161)
      const s = sealed.byKey.get(key);
      return s && { item: sealedEntry(s), sub: `${db.sets?.[s.set]?.[0] ?? ''} · ${s.type}`, open: () => openSealedDetail(sealedEntry(s)) };
    }
    const [id, short] = key.split(':');
    const c = db.byId.get(id);
    const variant = finishFromShort(short);
    return c && { item: c, sub: `${c.setName} · #${c.number} · ${variantLabel(variant)}`, open: () => openDetail({ ...c, variant }) };
  };
  const section = (title, rows, pctOf) => {
    const items = rows.map((r) => ({ r, x: resolve(r[0]) })).filter((x) => x.x);
    if (!items.length) return `<h3 class="sub-title">${esc(title)}</h3><p class="muted">Nothing yet — check back after a few days of prices.</p>`;
    return `<h3 class="sub-title">${esc(title)}</h3><div class="results">${items.map(({ r, x }, i) => {
      const pct = pctOf(r);
      return `<button type="button" class="card-row mover" data-i="${i}" data-sec="${esc(title)}">
        <img src="${esc(x.item.image)}" alt="" loading="lazy">
        <div class="meta"><div class="name">${esc(x.item.name)}</div><div class="sub">${esc(x.sub)}</div></div>
        <div class="mv"><b>${formatAud(r[1] / 100, rate.rate)}</b>
          <span class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}%</span></div>
      </button>`;
    }).join('')}</div>`;
  };
  const k = market.kind;
  const pctMove = (r) => r[3];
  const pctVs = (r) => ((r[1] - r[2]) / r[2]) * 100;
  const sections = [
    ['Biggest risers', w?.[k].up ?? [], pctMove],
    ['Biggest fallers', w?.[k].down ?? [], pctMove],
    ['At their highest', data.highs[k], pctVs],
    ['At their lowest', data.lows[k], pctVs],
  ];
  marketEls.body.innerHTML = sections.map(([t, rows, f]) => section(t, rows, f)).join('');
  marketEls.body.querySelectorAll('.mover').forEach((b) => {
    const rows = sections.find(([t]) => t === b.dataset.sec)[1].filter((r) => resolve(r[0]));
    b.addEventListener('click', () => resolve(rows[+b.dataset.i][0]).open());
  });
}

/* Search also finds sealed product (every word must appear in its name or set). */
async function searchSealed(query) {
  const words = normName(query)
    .replace(/\betb\b/g, 'elite trainer box').replace(/\bupc\b/g, 'ultra-premium collection')
    .replace(/\bpc\b/g, 'pokemon center').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const sealed = await getSealed();
  return sealed.items.filter((s) => {
    const hay = normName(`${s.name} ${db.sets?.[s.set]?.[0] ?? ''} ${s.type}`);
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => (a.type === 'Case') - (b.type === 'Case')
    || (db.sets?.[b.set]?.[3] ?? '').localeCompare(db.sets?.[a.set]?.[3] ?? '') || (b.usd ?? 0) - (a.usd ?? 0));
}

/* ------------------------------------------------------------------ */
/* PWA                                                                 */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW failed', err));
}
