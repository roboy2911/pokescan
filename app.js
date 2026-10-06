/* PokeScan — identify Pokémon cards from a photo.
 *
 * Pipeline:
 *   1. Grab a frame from the camera (or an uploaded photo).
 *   2. Crop the card using the on-screen guide.
 *   3. OCR the name strip and the number corners on-device with Tesseract.js.
 *   4. Look up candidates in pokemontcg.io by collector number ("025/198"), falling back
 *      to a misread-tolerant name search (and TCGdex if pokemontcg.io is down).
 *   5. Rank candidates by how closely their artwork matches the photo, with the
 *      name match as a tie-breaker.
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
  debug: $('ocrDebug'),
  dbgTop: $('dbgTop'),
  dbgTopText: $('dbgTopText'),
  dbgBottom: $('dbgBottom'),
  dbgBottomText: $('dbgBottomText'),
  scanResults: $('scanResults'),
  searchForm: $('searchForm'),
  qName: $('qName'),
  qNumber: $('qNumber'),
  qTotal: $('qTotal'),
  searchStatus: $('searchStatus'),
  searchResults: $('searchResults'),
  historyList: $('historyList'),
  clearHistory: $('clearHistory'),
  detail: $('detail'),
  detailBody: $('detailBody'),
  work: $('work'),
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
    setStatus(els.status, 'Line the card up inside the yellow frame, then tap Scan.');
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

/* Draw the guide area of a source (video or image) into a new canvas = the card. */
function cropCard(source, srcW, srcH) {
  const r = guideRectInSource(srcW, srcH);
  const c = document.createElement('canvas');
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  c.getContext('2d').drawImage(source, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}

/* ------------------------------------------------------------------ */
/* Image preprocessing                                                 */
/* ------------------------------------------------------------------ */

/* Cut out a region (fractions of the card), upscale it and boost contrast for OCR. */
function region(card, x0, y0, x1, y1, targetWidth) {
  const sx = card.width * x0;
  const sy = card.height * y0;
  const sw = card.width * (x1 - x0);
  const sh = card.height * (y1 - y0);
  const scale = Math.max(1, targetWidth / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, sx, sy, sw, sh, 0, 0, c.width, c.height);
  enhance(ctx, c.width, c.height);
  return c;
}

/* White-on-dark text (full-art cards) reads better as dark-on-white. Returns a copy. */
function invert(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  ctx.putImageData(img, 0, 0);
  return c;
}

/* Grayscale + contrast stretch. Leaves thresholding to Tesseract (Otsu). */
function enhance(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng').catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function ocr(canvas, psm = '6', extra = {}) {
  const worker = await getWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    tessedit_char_whitelist: '',
    ...extra,
  });
  const { data } = await worker.recognize(canvas);
  return data.text || '';
}

/* ------------------------------------------------------------------ */
/* Text parsing                                                        */
/* ------------------------------------------------------------------ */

/* Fix common OCR confusions in a part that should be numeric. */
function fixDigits(s) {
  return s.replace(/[Oo]/g, '0').replace(/[Il|!]/g, '1').replace(/[S$]/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
}

/* Split "TG05" -> {prefix: "TG", digits: "05"}; single stray letters are treated as misread digits. */
function splitPart(raw) {
  const m = raw.match(/^([A-Z]{2,3})(.+)$/);
  if (m && /\d/.test(m[2])) return { prefix: m[1], digits: fixDigits(m[2]) };
  return { prefix: '', digits: fixDigits(raw) };
}

/* Find collector numbers like "025/198", "TG05/TG30", "199/165", "GG12/GG70". */
function parseNumbers(text) {
  const out = [];
  const seen = new Set();
  const re = /([A-Z]{0,3}[0-9OoIlS|]{1,3})\s*[\/\\|]\s*([A-Z]{0,3}[0-9OoIlS]{2,3})/g;
  const cleaned = text.replace(/[‘’`'"]/g, '');
  let m;
  while ((m = re.exec(cleaned))) {
    const a = splitPart(m[1]);
    const b = splitPart(m[2]);
    if (!/^\d+$/.test(a.digits) || !/^\d+$/.test(b.digits)) continue;
    const num = a.prefix + (a.prefix ? a.digits : String(parseInt(a.digits, 10)));
    const total = b.prefix ? '' : String(parseInt(b.digits, 10));
    const key = `${num}/${total}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ number: num, total, raw: m[0].trim() });
  }
  // Promo style numbers without a slash, e.g. "SWSH050", "SM210", "XY124".
  const promo = /\b(SWSH|SM|XY|BW|HGSS|DP)\s?-?\s?(\d{2,3})\b/g;
  while ((m = promo.exec(cleaned))) {
    const num = m[1] + m[2];
    if (!seen.has(num)) {
      seen.add(num);
      out.push({ number: num, total: '', raw: m[0] });
    }
  }
  return out;
}

const NAME_NOISE = new Set([
  'basic', 'stage', 'stagel', 'stage1', 'stage2', 'hp', 'evolves', 'from', 'put', 'on', 'the',
  'pokemon', 'pokémon', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'energy', 'ability',
  'tera', 'rule', 'weakness', 'resistance', 'retreat', 'illus', 'and', 'of', 'this', 'card',
]);

/* Best guess at the card's name from the top strip: the longest run of real-looking words. */
function guessName(text) {
  let best = '';
  for (const line of text.split('\n')) {
    const words = line
      .replace(/[^A-Za-zéÉ'’.\-\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !NAME_NOISE.has(w.toLowerCase().replace(/[^a-zé0-9]/g, '')));
    // Keep short suffixes that are part of names (ex, V, GX, VMAX, VSTAR).
    const phrase = words.filter((w, i) => w.length >= 3 || (i > 0 && /^(ex|EX|GX|V|VMAX|VSTAR)$/.test(w))).join(' ');
    if (phrase.replace(/\s/g, '').length > best.replace(/\s/g, '').length) best = phrase;
  }
  return best.trim();
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/* How strongly does the OCR text look like it contains this card name? */
function nameScore(cardName, ocrText) {
  const words = norm(ocrText).split(/\s+/).filter((w) => w.length >= 3);
  const tokens = norm(cardName).split(/\s+/).filter((t) => t.length >= 3);
  if (!tokens.length || !words.length) return 0;
  let score = 0;
  for (const t of tokens) {
    if (words.includes(t)) score += 3;
    else if (t.length >= 5 && words.some((w) => levenshtein(w, t) <= 2)) score += 2;
  }
  return score / tokens.length;
}

/* ------------------------------------------------------------------ */
/* Card database APIs                                                  */
/* ------------------------------------------------------------------ */

const PTCG = 'https://api.pokemontcg.io/v2/cards';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
// Optional free key from https://dev.pokemontcg.io — raises the rate limit a lot.
const PTCG_API_KEY = '';

async function fetchJson(url, timeoutMs = 15000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function fromPtcg(c) {
  return {
    id: c.id,
    name: c.name,
    number: c.number,
    setName: c.set?.name ?? '',
    setSeries: c.set?.series ?? '',
    setTotal: c.set?.printedTotal ?? '',
    setCode: c.set?.ptcgoCode ?? '',
    releaseDate: c.set?.releaseDate ?? '',
    rarity: c.rarity ?? '',
    artist: c.artist ?? '',
    image: c.images?.small ?? '',
    imageLarge: c.images?.large ?? c.images?.small ?? '',
    source: 'pokemontcg.io',
  };
}

/* TCGdex's image server sends a broken CORS header, so its pixels can't be read for the
 * artwork match. The same scans live on images.pokemontcg.io under slightly different
 * set ids ("sv03.5" -> "sv3pt5", "sv08" -> "sv8", "lc" -> "base6"). */
const TCGDEX_TO_PTCG_SET = { lc: 'base6' };

function ptcgImageFor(tcgdexId) {
  const i = tcgdexId.lastIndexOf('-');
  let set = tcgdexId.slice(0, i);
  let num = tcgdexId.slice(i + 1);
  set = TCGDEX_TO_PTCG_SET[set] ?? set.replace(/\.5$/, 'pt5').replace(/^([a-z]+)0+(\d)/, '$1$2');
  if (/^\d+$/.test(num)) num = String(parseInt(num, 10));
  return `https://images.pokemontcg.io/${set}/${num}.png`;
}

function fromTcgdex(c) {
  const img = c.image ? `${c.image}/low.webp` : '';
  return {
    fpImage: ptcgImageFor(c.id),
    id: c.id,
    name: c.name,
    number: c.localId,
    setName: c.set?.name ?? '',
    setSeries: c.set?.serie?.name ?? '',
    setTotal: c.set?.cardCount?.official ?? '',
    setCode: '',
    releaseDate: c.set?.releaseDate ?? '',
    rarity: c.rarity ?? '',
    artist: c.illustrator ?? '',
    image: img,
    imageLarge: c.image ? `${c.image}/high.webp` : img,
    source: 'TCGdex',
  };
}

const quote = (s) => `"${String(s).replace(/"/g, '')}"`;

/* Search by any combination of name / number / printed set total.
 * A name starting with "*" means "contains" (e.g. "*charizard" also finds "Mega Charizard X ex"). */
async function searchCards({ name = '', number = '', total = '', pageSize = 60 }) {
  const q = [];
  if (name) {
    const contains = name.startsWith('*');
    const n = name.replace(/["*]/g, '').trim();
    if (n.includes(' ')) q.push(`name:${quote(n)}`);
    else q.push(`name:${contains ? '*' : ''}${n}*`);
  }
  if (number) q.push(`number:${quote(number)}`);
  if (total) q.push(`set.printedTotal:${total}`);
  const url = `${PTCG}?q=${encodeURIComponent(q.join(' '))}&orderBy=-set.releaseDate&pageSize=${pageSize}`;

  // pokemontcg.io is the better source but is sometimes very slow. If it hasn't answered
  // within 5s (or fails), ask TCGdex too and take whichever answers first.
  const primary = fetchJson(url, 20000, PTCG_API_KEY ? { 'X-Api-Key': PTCG_API_KEY } : {})
    .then((json) => (json.data || []).map(fromPtcg));
  let startBackup;
  const backupGate = new Promise((resolve) => { startBackup = resolve; });
  const timer = setTimeout(startBackup, 5000);
  primary.catch((err) => { console.warn('pokemontcg.io failed', err); startBackup(); });
  const backup = backupGate.then(() => searchTcgdex({ name, number, total }));
  try {
    return await Promise.any([primary, backup]);
  } catch (err) {
    throw new Error('Card databases are not responding — check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

/* Printed set sizes for TCGdex sets ("sv03.5" -> 165), so number searches can be filtered. */
let tcgdexTotals = null;

function getTcgdexTotals() {
  if (!tcgdexTotals) {
    tcgdexTotals = fetchJson(`${TCGDEX}/sets`)
      .then((sets) => new Map(sets.map((s) => [s.id, s.cardCount?.official])))
      .catch(() => { tcgdexTotals = null; return new Map(); });
  }
  return tcgdexTotals;
}

/* Backup source, used when pokemontcg.io is down or rate-limiting. */
async function searchTcgdex({ name, number, total }) {
  const params = new URLSearchParams();
  if (name) params.set('name', name.replace(/\*/g, ''));
  if (number) params.set('localId', /^\d+$/.test(number) ? `eq:${number}` : number);
  params.set('pagination:itemsPerPage', '150');
  let items = await fetchJson(`${TCGDEX}/cards?${params}`);
  // TCGdex sometimes stores zero-padded localIds ("025"), so a second try helps.
  if (!items.length && /^\d+$/.test(number)) {
    params.set('localId', number.padStart(3, '0'));
    items = await fetchJson(`${TCGDEX}/cards?${params}`);
  }
  // Card ids are "<setId>-<number>", so the set size can be checked without fetching each card.
  if (total) {
    const totals = await getTcgdexTotals();
    items = items.filter((c) => {
      const setTotal = totals.get(c.id.slice(0, c.id.lastIndexOf('-')));
      return setTotal === undefined || String(setTotal) === String(total);
    });
  }
  // Small result sets: fetch full details now.
  if (items.length <= 15) {
    const details = await Promise.all(
      items.map((c) => fetchJson(`${TCGDEX}/cards/${c.id}`).catch(() => null)));
    return details
      .filter(Boolean)
      .map(fromTcgdex)
      .filter((c) => !total || String(c.setTotal) === String(total));
  }
  // Big ones (name searches): the brief records have images, which is all the artwork
  // match needs. enrichCards() fills in set details for the few we end up showing.
  return items.map((c) => ({ ...fromTcgdex(c), partial: true }));
}

/* Fill in set details for TCGdex brief records before showing them. */
async function enrichCards(cards) {
  return Promise.all(cards.map(async (c) => {
    if (!c.partial) return c;
    try {
      return fromTcgdex(await fetchJson(`${TCGDEX}/cards/${c.id}`));
    } catch {
      return c;
    }
  }));
}

/* ------------------------------------------------------------------ */
/* Visual matching                                                     */
/* ------------------------------------------------------------------ */

/* A tiny colour "fingerprint" of a card image: a 16x22 thumbnail, mean-centred and
 * normalised so two cards can be compared with a dot product (1 = identical). This is
 * the same idea commercial scanners use (at much larger scale) — it works even when
 * the text on a full-art card is unreadable. */
function fingerprint(src) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 22;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, 16, 22);
  const d = ctx.getImageData(0, 0, 16, 22).data;
  const v = new Float32Array(16 * 22 * 3);
  for (let i = 0, j = 0; i < d.length; i += 4) {
    v[j++] = d[i]; v[j++] = d[i + 1]; v[j++] = d[i + 2];
  }
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let len = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= mean; len += v[i] * v[i]; }
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= len;
  return v;
}

function similarity(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const fpCache = new Map();

function cardFingerprint(card) {
  const url = card.fpImage || card.image;
  if (!url) return Promise.resolve(null);
  if (!fpCache.has(url)) {
    fpCache.set(url, fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b))
      .then(fingerprint)
      .catch(() => {
        fpCache.delete(url); // don't remember failures — retry next scan
        return null;
      }));
  }
  return fpCache.get(url);
}

/* Fingerprint every candidate (8 downloads at a time) and attach a visual score. */
async function visualRank(photoFp, candidates, onProgress) {
  const out = [];
  const queue = [...candidates];
  const next = async () => {
    while (queue.length) {
      const card = queue.shift();
      const fp = await cardFingerprint(card);
      out.push({ card, visual: fp ? similarity(photoFp, fp) : -1 });
      if (out.length % 10 === 0) onProgress(`Comparing artwork… ${out.length}/${candidates.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, next));
  return out;
}

/* ------------------------------------------------------------------ */
/* Scan flow                                                           */
/* ------------------------------------------------------------------ */

const NUMBER_OCR = { tessedit_char_whitelist: '0123456789/TGRCSWHVMXYB ' };

/* All Pokémon species names (from PokéAPI), cached on the device, used to fix OCR misreads. */
const SPECIES_KEY = 'pokescan.species.v1';
let speciesPromise = null;

function loadSpecies() {
  if (!speciesPromise) {
    speciesPromise = (async () => {
      try {
        const cached = JSON.parse(localStorage.getItem(SPECIES_KEY));
        if (cached?.length) return cached;
      } catch { /* storage unavailable */ }
      const json = await fetchJson('https://pokeapi.co/api/v2/pokemon-species?limit=2000');
      const names = json.results.map((s) => s.name.replace(/-/g, ''));
      try { localStorage.setItem(SPECIES_KEY, JSON.stringify(names)); } catch { /* ignore */ }
      return names;
    })().catch(() => []);
  }
  return speciesPromise;
}

/* Closest species to an OCR'd word: "Chavizarvd" -> charizard, "ARikach" -> pikachu,
 * "MegalManectric" -> manectric. Returns { name, dist } or null if nothing is close. */
function correctSpecies(word, species) {
  const w = word.toLowerCase();
  // Run-together words ("MegalManectric", "Dialgaus") contain the real name.
  let contained = null;
  for (const name of species) {
    if (name.length >= 5 && w.includes(name) && (!contained || name.length > contained.length)) contained = name;
  }
  if (contained) return { name: contained, dist: 0.5 };

  const variants = [w, w.slice(1), w.slice(0, -1)].filter((v) => v.length >= 4);
  let best = null;
  let bestDist = Infinity;
  for (const name of species) {
    for (const v of variants) {
      // Compare whole names, and also the start of the name when the OCR text was cut short.
      const d = Math.min(
        levenshtein(v, name) + (v === w ? 0 : 1),
        levenshtein(v, name.slice(0, v.length)) + (v === w ? 1 : 2));
      if (d < bestDist) { bestDist = d; best = name; }
    }
  }
  const allowed = w.length >= 6 ? 2 : 1;
  return bestDist <= allowed ? { name: best, dist: bestDist } : null;
}

/* Name search that tolerates OCR junk: match words against the species list first,
 * then fall back to shorter and shorter prefixes ("Pikachule" -> "Pikac*"). */
async function searchByName(nameText, onProgress) {
  // "Evolves from Electrike" names the *previous* Pokémon — ignore that line.
  const text = nameText.split('\n').filter((l) => !/evolves|from/i.test(l)).join(' ');
  const words = [...new Set(text.split(/[^A-Za-zé]+/)
    .filter((w) => w.length >= 4 && !NAME_NOISE.has(w.toLowerCase())))]
    .sort((a, b) => b.length - a.length);

  // Search the two most likely species together; the artwork comparison picks between them.
  const species = await loadSpecies();
  const names = [...new Set(words
    .map((w) => correctSpecies(w, species))
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist || b.name.length - a.name.length)
    .map((f) => f.name))]
    .slice(0, 2);
  const found = new Map();
  for (const name of names) {
    onProgress(`Looking up “${esc(name)}”…`);
    for (const c of await searchCards({ name: `*${name}`, pageSize: 150 })) found.set(c.id, c);
  }
  if (found.size) return { cards: [...found.values()], how: `name “${names.join('” / “')}”` };

  const tried = new Set();

  // Trainers / items aren't in the species list — try the raw words as prefixes.
  for (const word of words.slice(0, 2)) {
    for (const len of [word.length, 6, 5, 4]) {
      const prefix = word.slice(0, len);
      if (prefix.length < 4 || tried.has(prefix.toLowerCase())) continue;
      tried.add(prefix.toLowerCase());
      onProgress(`Looking up “${esc(prefix)}…”`);
      const cards = await searchCards({ name: prefix, pageSize: 150 });
      if (cards.length) return { cards, how: `name “${prefix}…”` };
    }
  }
  return { cards: [], how: '' };
}

/* Read a cropped card image and return ranked candidates. */
async function identifyCard(card, onProgress) {
  // 1. Read the name (top strip) and collector number (bottom corners).
  // No single crop/setting reads every card era, so read the name a few ways and pool the text.
  onProgress('Reading card name…');
  const nameImg = region(card, 0.05, 0.02, 0.7, 0.11, 1200);
  const nameText = [
    await ocr(nameImg, '6'),
    await ocr(nameImg, '11'),
    await ocr(region(card, 0.03, 0.025, 0.6, 0.085, 1200), '6'),
  ].join('\n');

  onProgress('Reading card number…');
  const corners = [region(card, 0, 0.9, 0.42, 0.985, 900), region(card, 0.58, 0.9, 1, 0.985, 900)];
  let numberText = '';
  for (const c of corners) numberText += (await ocr(c, '6', NUMBER_OCR)) + '\n';
  // Light text on full-art cards reads better inverted.
  if (!parseNumbers(numberText).length) {
    for (const c of corners) numberText += (await ocr(invert(c), '6', NUMBER_OCR)) + '\n';
  }
  showDebug(nameImg, corners[0], nameText, numberText);

  const numbers = parseNumbers(numberText);
  const nameGuess = guessName(nameText);
  const photoFp = fingerprint(card);

  // 2. Gather candidates: by number first (precise), then by name (broad).
  let candidates = [];
  let how = '';
  for (const n of numbers) {
    onProgress(`Looking up #${esc(n.number)}${n.total ? '/' + esc(n.total) : ''}…`);
    candidates = await searchCards({ number: n.number, total: n.total });
    if (candidates.length) { how = `number ${n.raw}`; break; }
  }

  let ranked = candidates.length ? await visualRank(photoFp, candidates, onProgress) : [];

  // A misread number can find the wrong card; if nothing looks alike, try the name too.
  const bestVisual = Math.max(-1, ...ranked.map((r) => r.visual));
  if (bestVisual < 0.45) {
    const byName = await searchByName(nameText, onProgress);
    const seen = new Set(candidates.map((c) => c.id));
    const extra = byName.cards.filter((c) => !seen.has(c.id));
    if (extra.length) {
      ranked = ranked.concat(await visualRank(photoFp, extra, onProgress));
      how = how ? `${how} + ${byName.how}` : byName.how;
    }
  }

  // 3. Rank: artwork similarity first, name match as a tie-breaker.
  const allText = `${nameText}\n${numberText}`;
  ranked.forEach((r) => { r.score = r.visual + 0.05 * nameScore(r.card.name, allText); });
  ranked.sort((a, b) => b.score - a.score);
  ranked = ranked.slice(0, 12);
  (await enrichCards(ranked.map((r) => r.card))).forEach((c, i) => { ranked[i].card = c; });

  return { ranked, numbers, nameGuess, how };
}

/* Uploaded photos aren't lined up with the guide: take the biggest card-shaped area in the middle. */
function cardFromPhoto(img, w, h) {
  const ratio = 63 / 88;
  let cw = w, ch = h;
  if (w / h > ratio) cw = h * ratio; else ch = w / ratio;
  const c = document.createElement('canvas');
  c.width = Math.round(cw);
  c.height = Math.round(ch);
  c.getContext('2d').drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, c.width, c.height);
  return c;
}

async function runScan(card) {
  if (busy) return;
  busy = true;
  els.scan.disabled = true;
  els.scanResults.innerHTML = '';
  els.debug.hidden = true;
  const progress = (m) => setStatus(els.status, m, 'busy');

  try {
    progress('Loading text reader (first time takes a few seconds)…');
    await getWorker();
    renderScanResults(await identifyCard(card, progress));
  } catch (err) {
    console.error(err);
    setStatus(els.status, `Something went wrong: ${esc(err.message)}`, 'err');
  } finally {
    busy = false;
    els.scan.disabled = !stream;
  }
}

els.scan.addEventListener('click', () => {
  const v = els.video;
  if (!v.videoWidth) return;
  runScan(cropCard(v, v.videoWidth, v.videoHeight));
});

els.file.addEventListener('change', async () => {
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
    runScan(cardFromPhoto(img, img.naturalWidth, img.naturalHeight));
  };
  img.onerror = () => setStatus(els.status, 'Could not open that image.', 'err');
  img.src = url;
});

function showDebug(nameImg, numberImg, nameText, numberText) {
  els.debug.hidden = false;
  els.dbgTop.src = nameImg.toDataURL('image/jpeg', 0.7);
  els.dbgBottom.src = numberImg.toDataURL('image/jpeg', 0.7);
  els.dbgTopText.textContent = nameText.trim() || '(nothing)';
  els.dbgBottomText.textContent = numberText.trim() || '(nothing)';
}

function renderScanResults({ ranked, numbers, nameGuess, how }) {
  if (!ranked.length) {
    const read = [
      numbers.length ? `number ${numbers.map((n) => esc(n.raw)).join(', ')}` : '',
      nameGuess ? `name “${esc(nameGuess)}”` : '',
    ].filter(Boolean).join(' and ');
    setStatus(els.status,
      `No match found${read ? ` (read ${read})` : ' — couldn’t read the card'}. ` +
      'Try better light, hold the card flat and fill the frame, or use the Search tab.', 'err');
    return;
  }
  const [best, second] = ranked;
  const confident = best.visual >= 0.45 && best.visual - (second?.visual ?? 0) >= 0.08;
  setStatus(els.status,
    confident
      ? `Found it via ${esc(how)}. Tap the card to confirm.`
      : `Not sure — best guesses via ${esc(how)}. Tap the right one.`,
    confident ? 'ok' : '');

  els.scanResults.innerHTML = '';
  ranked.slice(0, confident ? 6 : 12).forEach(({ card }, i) => {
    els.scanResults.appendChild(cardRow(card, i === 0 && confident));
  });
}

/* ------------------------------------------------------------------ */
/* Manual search                                                       */
/* ------------------------------------------------------------------ */

els.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.qName.value.trim();
  const rawNum = els.qNumber.value.trim().toUpperCase();
  const total = els.qTotal.value.trim().replace(/\D/g, '');
  // Accept "025/198" typed straight into the number box.
  let number = rawNum;
  let tot = total;
  const parsed = parseNumbers(rawNum)[0];
  if (parsed) { number = parsed.number; tot = tot || parsed.total; }
  else if (/^\d+$/.test(rawNum)) number = String(parseInt(rawNum, 10));

  if (!name && !number) {
    setStatus(els.searchStatus, 'Enter a name and/or number.', 'err');
    return;
  }
  setStatus(els.searchStatus, 'Searching…', 'busy');
  els.searchResults.innerHTML = '';
  try {
    const cards = await searchCards({ name, number, total: tot });
    setStatus(els.searchStatus, cards.length ? `${cards.length} result${cards.length === 1 ? '' : 's'}` : 'No cards found.', cards.length ? 'ok' : 'err');
    cards.forEach((c) => els.searchResults.appendChild(cardRow(c)));
  } catch (err) {
    setStatus(els.searchStatus, `Search failed: ${esc(err.message)}`, 'err');
  }
});

/* ------------------------------------------------------------------ */
/* Card list + detail                                                  */
/* ------------------------------------------------------------------ */

function cardRow(card, best = false, onClick = () => openDetail(card)) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `card-row${best ? ' best' : ''}`;
  btn.innerHTML = `
    <img src="${esc(card.image)}" alt="" loading="lazy">
    <div class="meta">
      <div class="name">${esc(card.name)}${best ? '<span class="badge">Best match</span>' : ''}</div>
      <div class="sub">${esc(card.setName)} · #${esc(card.number)}${card.setTotal ? '/' + esc(card.setTotal) : ''}</div>
      <div class="sub">${esc([card.rarity, card.releaseDate?.slice(0, 4)].filter(Boolean).join(' · '))}</div>
    </div>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function openDetail(card, { fromHistory = false } = {}) {
  const rows = [
    ['Set', card.setName],
    ['Series', card.setSeries],
    ['Number', `${card.number}${card.setTotal ? ' / ' + card.setTotal : ''}`],
    ['Set code', card.setCode],
    ['Rarity', card.rarity],
    ['Released', card.releaseDate],
    ['Artist', card.artist],
    ['Card ID', card.id],
  ].filter(([, v]) => v);

  els.detailBody.innerHTML = `
    <img class="detail-img" src="${esc(card.imageLarge || card.image)}" alt="${esc(card.name)}">
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
    els.historyList.appendChild(cardRow(card, false, () => openDetail(card, { fromHistory: true })));
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

if (!window.isSecureContext) {
  setStatus(els.status,
    'Not on HTTPS, so the live camera is off. “Take / upload photo” still works.');
}

// Warm up the name list in the background so the first scan is quicker.
loadSpecies();
