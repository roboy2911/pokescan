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
  qNumber: $('qNumber'),
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
  const pick = (v, remember = false) => {
    shownVariant = v.key;
    if (remember) rememberFinish(card.id, v.key);
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
      chip.addEventListener('click', () => pick(v, true));
      els.variantChips.appendChild(chip);
    }
  }
  pick(variants.find((v) => v.key === lastFinish(card.id)) ?? variants[0]);
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

  const sealed = name && !number ? await searchSealed(els.qName.value.trim()) : [];
  const parts = [
    found.length ? `${found.length} card${found.length === 1 ? '' : 's'}${found.length > 100 ? ' (showing 100)' : ''}` : '',
    sealed.length ? `${sealed.length} sealed product${sealed.length === 1 ? '' : 's'}${sealed.length > 40 ? ' (showing 40)' : ''}` : '',
  ].filter(Boolean);
  setStatus(els.searchStatus, parts.length ? parts.join(' · ') : 'Nothing found.', parts.length ? 'ok' : 'err');
  // Sealed product goes first when the search is clearly for it (or no card matched).
  const sealedFirst = !found.length || /\b(box|tin|pack|bundle|collection|blister|etb|deck|display|case|premium)\b/i.test(els.qName.value);
  const showCards = () => found.slice(0, 100).forEach((c) => els.searchResults.appendChild(cardRow(c)));
  if (!sealedFirst) showCards();
  if (sealed.length) {
    const h = document.createElement('h3');
    h.className = 'sub-title';
    h.textContent = 'Sealed product';
    els.searchResults.appendChild(h);
    const rate = await getAudRate();
    for (const sp of sealed.slice(0, 40)) {
      const e = sealedEntry(sp);
      els.searchResults.appendChild(cardRow({ ...e, number: '', setTotal: '', rarity: sp.type, releaseDate: '' }, {
        onClick: () => openSealedDetail(e),
        extra: sp.usd != null ? formatAud(sp.usd, rate.rate) : '',
      }));
    }
    if (found.length && sealedFirst) {
      const h2 = document.createElement('h3');
      h2.className = 'sub-title';
      h2.textContent = 'Cards';
      els.searchResults.appendChild(h2);
    }
  }
  if (sealedFirst) showCards();
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
function openDetail(card, { entryKey = null } = {}) {
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
    </div>
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
           <button class="btn ghost" id="detailRemove">Remove from collection</button>`
        : '<button class="btn primary" id="detailAdd">＋ Add to collection</button>'}
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

  els.detail.showModal();

  // Price, with a chip per finish (picking one changes the saved card's finish).
  Promise.all([getTcgPrices([card.id]), getAudRate()]).then(([prices, rate]) => {
    const priceEl = $('detailPrice');
    if (!priceEl) return;
    const info = prices[card.id];
    const variants = priceVariants(info?.prices);
    if (!variants.length) {
      priceEl.textContent = info ? 'No price available' : "Couldn't load price";
      return;
    }
    const pick = (v, save) => {
      variant = v.key;
      priceEl.textContent = formatAud(v.usd, rate.rate);
      priceEl.className = 'price-value';
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
    $('detailNote').innerHTML = `TCGplayer (US) market price in AUD`
      + `${info.url ? ` · <a href="${esc(info.url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}`;
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

const entryKeyOf = (id, variant) => `${id}|${variant || ''}`;

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
  const newKey = entryKeyOf(entry.id, variant);
  if (newKey === key) return key;
  const other = list.find((e) => e.key === newKey);
  if (other) {
    other.qty += entry.qty;
    list.splice(list.indexOf(entry), 1);
  } else {
    Object.assign(entry, { key: newKey, variant });
  }
  saveCollection(list);
  return newKey;
}

/* USD market price of one copy, using the entry's finish. */
function cardUsd(entry, info) {
  const variants = priceVariants(info?.prices);
  return (variants.find((v) => v.key === entry.variant) ?? variants[0])?.usd ?? null;
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
  for (const e of list) {
    const usd = !prices ? null
      : e.kind === 'sealed' ? sealed?.byKey.get(e.id)?.usd ?? null
        : cardUsd(e, prices[e.id]);
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
      + `${pricedCards} priced · TCGplayer market prices in AUD${rate.approx ? ' (approx. exchange rate)' : ''}`
      + (collectionPrices.age ? ` · ${collectionPrices.age}` : '');
  } else {
    els.valueTotal.textContent = 'Loading…';
    els.valueNote.textContent = '';
  }

  renderSetFilter(list);
  renderValueBySet(list, rate);
  const q = normName(els.collectionSearch.value.trim());
  const onlySet = els.collectionSet.value;
  const shown = list
    .filter((e) => !onlySet || e.setId === onlySet)
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
    const finish = e.variant ? variantLabel(e.variant) : '';
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
  const key = want.map((e) => e.setId).join(',');
  if (els.collectionSet.dataset.key === key) return;
  const current = els.collectionSet.value;
  els.collectionSet.innerHTML = '<option value="">All sets</option>'
    + want.map((e) => `<option value="${esc(e.setId)}">${esc(e.setName)}</option>`).join('');
  els.collectionSet.value = sets.has(current) ? current : '';
  els.collectionSet.dataset.key = key;
  els.collectionSet.hidden = want.length < 2;
}
els.collectionSet.addEventListener('change', renderCollection);

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
    const entry = { ...pickCard(e), key: entryKeyOf(e.id, e.variant), variant: e.variant ?? null,
      qty: Math.max(1, Math.floor(Number(e.qty) || 1)), addedAt: e.addedAt || e.scannedAt || '' };
    const have = list.find((x) => x.key === entry.key);
    if (have) have.qty = Math.max(have.qty, entry.qty);
    else { list.push(entry); added++; }
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
           <button class="btn ghost" id="detailRemove">Remove from collection</button>`
        : '<button class="btn primary" id="detailAdd">＋ Add to collection</button>'}
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
  els.detail.showModal();

  const [sealed, rate] = await Promise.all([getSealed(), getAudRate()]);
  const s = sealed.byKey.get(`s${productId}`);
  const priceEl = $('detailPrice');
  if (!priceEl) return;
  if (s?.usd == null) {
    priceEl.textContent = 'No price available';
    return;
  }
  priceEl.textContent = formatAud(s.usd, rate.rate);
  priceEl.className = 'price-value';
  const cmp = rrpCompare(s.type, s.usd, rate.rate);
  $('sealedPrice').addEventListener('click', () => {
    const rrpEl = $('sealedRrp');
    const open = rrpEl.hidden;
    rrpEl.hidden = !open;
    $('sealedPrice').setAttribute('aria-expanded', String(open));
    $('sealedHint').textContent = open ? 'TCGplayer (US) market price in AUD' : 'Tap to compare with Australian RRP';
    rrpEl.innerHTML = cmp
      ? `RRP ${formatAudPlain(cmp.rrp)}${cmp.estimate ? ' <small>(estimate)</small>' : ''} · <b class="${cmp.up ? 'up' : 'down'}">${esc(cmp.text)}</b>`
      : 'No Australian RRP for this kind of product';
  });
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
  if (openSetId) {
    renderSetPage(); // owned marks may have changed
    return;
  }
  if (!setsRendered) await renderSetsList();
  else updateSetCounts();
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
    <p class="muted center" id="setSummary">You have ${ownedCount} of ${cards.length} cards</p>`;

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
    if (key[0] === 's') {
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
