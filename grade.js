/* Card grader — the guided photos and the report (the measuring is in grade-core.js).
 * Opened from a card's sheet: "Grade this card". Four photos: front, back, and two tilted
 * front shots for the surface (the last two can be skipped). Nothing is saved. */

const SHINE_PICTURE = `<svg class="shine-pic" viewBox="0 0 240 112" role="img" aria-label="A lamp above, the card on the table, the phone tilted so the lamp's reflection shows on the card">
  <path d="M30 14h26l-6 14H36z" fill="#ffcb05"/><path d="M43 4v10" stroke="#ffcb05" stroke-width="2"/>
  <path d="M43 30 L118 84 L176 36" fill="none" stroke="#ffcb05" stroke-width="2" stroke-dasharray="4 4"/>
  <path d="M10 92h220" stroke="currentColor" stroke-width="2" opacity=".4"/>
  <rect x="96" y="83" width="44" height="6" rx="2" fill="#3b82f6"/>
  <ellipse cx="118" cy="85" rx="9" ry="3" fill="#fff"/>
  <rect x="168" y="14" width="18" height="32" rx="4" transform="rotate(35 177 30)" fill="currentColor" opacity=".85"/>
  <g font-size="10" fill="currentColor" opacity=".8" font-family="system-ui, sans-serif">
    <text x="62" y="20">lamp or window</text>
    <text x="194" y="64">phone</text>
    <text x="100" y="106">card</text>
    <text x="128" y="78" fill="#ffcb05" opacity="1">shine</text>
  </g>
</svg>`;

const GRADE_STEPS = [
  { key: 'front', kind: 'front', title: 'Front', tip: 'Card out of its sleeve, flat on a plain DARK surface (a dark table, mousepad or black cloth). Light from the side, not straight above. Phone straight above, card filling the box.' },
  { key: 'back', kind: 'back', title: 'Back', tip: 'Turn the card over — same spot, same light. The back\'s blue border shows edge and corner whitening best.' },
  { key: 'tilt1', kind: 'shine', title: 'Shine check 1 of 2', optional: true,
    tip: 'Scratches are invisible straight on — they only show as fine lines inside a reflection. Front up again: move the phone (or the card) until the light from a lamp or window shines off the card, like a mirror. Aim for a bright patch over the TOP half of the card.' },
  { key: 'tilt2', kind: 'shine', title: 'Shine check 2 of 2', optional: true,
    tip: 'Same again, with the bright patch over the BOTTOM half this time, so the whole card has been checked.' },
];

const grader = { card: null, step: 0, shots: {}, stream: null, el: null, ref: null, live: null };

function graderEl() {
  if (grader.el) return grader.el;
  const el = document.createElement('dialog');
  el.id = 'grader';
  el.className = 'grader';
  el.innerHTML = `
    <div class="grader-head">
      <button type="button" class="btn ghost small" id="gradeClose" aria-label="Close">✕</button>
      <div class="grader-title"><b id="gradeCardName"></b><span id="gradeStepName"></span></div>
      <span class="grader-dots" id="gradeDots"></span>
    </div>
    <div class="grader-body" id="gradeBody"></div>
    <input type="file" accept="image/*" id="gradeFile" hidden>`;
  document.body.appendChild(el);
  el.querySelector('#gradeClose').addEventListener('click', closeGrader);
  el.addEventListener('cancel', (e) => { e.preventDefault(); closeGrader(); });
  el.querySelector('#gradeFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) { toast("Couldn't open that picture"); return; }
    useShot(imageDataOf(bmp, bmp.width, bmp.height), null);
  });
  grader.el = el;
  return el;
}

function openGrader(card) {
  if (typeof stopCamera === 'function' && stream) stopCamera();
  els.detail.close();
  Object.assign(grader, { card, step: 0, shots: {}, ref: null });
  const el = graderEl();
  el.querySelector('#gradeCardName').textContent = card.name;
  el.showModal();
  // The official image, for comparing the surface (English cards; Japanese pictures can't be read).
  grader.refPromise = loadRefImage(card).then((r) => { grader.ref = r; return r; }).catch(() => null);
  showStep();
}

function closeGrader() {
  stopLive();
  stopGraderCamera();
  grader.el?.close();
}

function stopGraderCamera() {
  grader.stream?.getTracks().forEach((t) => t.stop());
  grader.stream = null;
}

async function loadRefImage(card) {
  if (card.lang === 'ja' || !card.imageLarge) return null;
  const res = await fetch(card.imageLarge, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob());
  return imageDataOf(bmp, bmp.width, bmp.height);
}

/* Pixels of an image / video frame (longest side at most `max` px — plenty, and phones'
 * memory is limited). */
function imageDataOf(src, w, h, max = 2400) {
  const k = Math.min(1, max / Math.max(w, h));
  const W = Math.round(w * k), H = Math.round(h * k);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, W, H);
  return { d: x.getImageData(0, 0, W, H).data, w: W, h: H };
}

function stepDots() {
  grader.el.querySelector('#gradeDots').innerHTML = GRADE_STEPS.map((s, i) =>
    `<i class="${i < grader.step ? 'done' : i === grader.step ? 'now' : ''}"></i>`).join('');
}

async function showStep() {
  stopLive();
  const s = GRADE_STEPS[grader.step];
  stepDots();
  grader.el.querySelector('#gradeStepName').textContent = `Photo ${grader.step + 1} of ${GRADE_STEPS.length} · ${s.title}`;
  const body = grader.el.querySelector('#gradeBody');
  body.innerHTML = `
    ${s.kind === 'shine' ? `<div class="shine-explain">${SHINE_PICTURE}</div>` : ''}
    <div class="grade-cam">
      <video id="gradeVideo" playsinline muted autoplay></video>
      <div class="grade-guide" id="gradeGuide"></div>
      <div class="grade-live" id="gradeLive">Starting the camera…</div>
    </div>
    <p class="grade-tip">${esc(s.tip)}</p>
    <div class="grade-actions">
      <button type="button" class="btn primary" id="gradeShoot">Take photo</button>
      <button type="button" class="btn ghost" id="gradeUpload">Use a photo…</button>
      ${s.optional ? '<button type="button" class="btn ghost" id="gradeSkip">Skip</button>' : ''}
    </div>
    ${s.optional ? '<p class="price-note">Skipping these means scratches aren\'t checked (the grade is less sure).</p>' : ''}`;
  body.querySelector('#gradeUpload').addEventListener('click', () => grader.el.querySelector('#gradeFile').click());
  body.querySelector('#gradeSkip')?.addEventListener('click', () => nextStep());
  body.querySelector('#gradeShoot').addEventListener('click', () => {
    const v = body.querySelector('#gradeVideo');
    if (!v.videoWidth) { toast('The camera isn\'t ready — or use "Use a photo…"'); return; }
    stopLive();
    useShot(imageDataOf(v, v.videoWidth, v.videoHeight), guideFraction(v));
  });
  try {
    if (!grader.stream) {
      grader.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
      });
    }
    const v = body.querySelector('#gradeVideo');
    v.srcObject = grader.stream;
    await v.play().catch(() => {});
    startLive(v, s.kind);
  } catch {
    body.querySelector('.grade-cam').innerHTML = '<p class="muted grade-nocam">No camera here — use "Use a photo…" (a photo taken with your camera app works well, and is often sharper).</p>';
    body.querySelector('#gradeShoot').hidden = true;
  }
}

/* Live guidance over the camera, ~3 times a second. */
function startLive(v, kind) {
  const el = grader.el.querySelector('#gradeLive');
  const tick = () => {
    if (!grader.live || !v.videoWidth) return;
    const img = imageDataOf(v, v.videoWidth, v.videoHeight, 360);
    let f = null;
    try { f = GR.quickFind(img); } catch { /* keep going */ }
    let msg, good = false;
    if (!f) msg = 'Looking for the card… (plain, dark surface; whole card in view)';
    else if (!f.inFrame) msg = 'Get the whole card in view';
    else if (f.dark) msg = 'Too dark — add light';
    else if (f.fill < 0.45) msg = 'Move closer — fill the box';
    else if (kind === 'shine') {
      if (f.glare > 0.35) msg = 'Too bright — tilt a little less';
      else if (f.lit < 0.08) msg = 'No reflection yet — tilt until the light shines off the card';
      else { msg = '✓ Good reflection — take the photo'; good = true; }
    } else if (f.glare > 0.02) msg = 'Reflection on the card — move the light or tilt slightly';
    else { msg = '✓ Looks good — hold still and take the photo'; good = true; }
    el.textContent = msg;
    el.classList.toggle('good', good);
    grader.live = setTimeout(tick, 330);
  };
  grader.live = setTimeout(tick, 400);
}
function stopLive() {
  if (grader.live) clearTimeout(grader.live);
  grader.live = null;
}

/* Where the on-screen box is in the video (fractions), for the outline finder. */
function guideFraction(v) {
  const box = v.getBoundingClientRect(), g = grader.el.querySelector('#gradeGuide').getBoundingClientRect();
  const scale = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
  const offX = (box.width - v.videoWidth * scale) / 2, offY = (box.height - v.videoHeight * scale) / 2;
  const fx = (px) => (px - box.left - offX) / scale / v.videoWidth, fy = (py) => (py - box.top - offY) / scale / v.videoHeight;
  return { x0: fx(g.left), y0: fy(g.top), x1: fx(g.right), y1: fy(g.bottom) };
}

/* A photo was taken: find the card, check the photo thoroughly, and ask to keep it or retake. */
async function useShot(img, guide) {
  const body = grader.el.querySelector('#gradeBody');
  const s = GRADE_STEPS[grader.step];
  body.innerHTML = '<p class="empty"><span class="spinner"></span>Checking the photo…</p>';
  await new Promise((r) => setTimeout(r, 30));
  let o = null;
  try { o = GR.outline(img, guide); } catch (err) { console.error(err); }
  if (!o) {
    body.innerHTML = `<p class="empty">Couldn't find the card. Put it on a plain surface that's darker than the card's border (a dark table, mousepad or cloth), with the whole card in view and nothing touching it.</p>
      <div class="grade-actions"><button type="button" class="btn primary" id="gradeRetry">Try again</button></div>`;
    body.querySelector('#gradeRetry').addEventListener('click', showStep);
    return;
  }
  // Which way up (fronts): compared with the official image; turned round if it was upside down.
  if (s.kind !== 'back') {
    const ref = await grader.refPromise;
    if (ref) {
      const r = GR.orient(o.card, ref);
      o.card = r.card;
      o.matchNcc = r.ncc;
    }
  }
  const q = GR.quality(o, s.kind, img);
  if (o.matchNcc != null && o.matchNcc < 0.3 && !GR.looksLikeBack(o.card)) q.checks.push({ level: 'warn', text: `This doesn't look much like ${grader.card.name} (${grader.card.setName}) — is it the right card? The surface comparison may be off.` });
  if (s.kind === 'shine') {
    const front = grader.shots.front?.card;
    const lit = front ? GR.shineShare(o.card, front).lit : GR.quickFind(GR.resize(img, 360, Math.round(360 * img.h / img.w)))?.lit ?? 0;
    if (lit < 0.06) q.checks.push({ level: 'bad', text: 'No reflection on the card — scratches only show where the light shines off it. Tilt more, towards a lamp or window.' });
    if (q.glare > 0.3) q.checks.push({ level: 'bad', text: 'The reflection washes out most of the card — scratches hide in pure white. Tilt a little less.' });
  }
  const badOnes = q.checks.filter((c) => c.level === 'bad'), warns = q.checks.filter((c) => c.level === 'warn');
  q.ok = !badOnes.length;
  body.innerHTML = `
    <div class="grade-still"><canvas id="gradeStill"></canvas></div>
    ${badOnes.length ? `<div class="grade-check bad"><b>Please retake:</b><ul>${badOnes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul></div>` : ''}
    ${warns.length ? `<div class="grade-check warn"><ul>${warns.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul></div>` : ''}
    ${!badOnes.length && !warns.length ? '<p class="grade-tip ok">✓ Good photo — sharp, well lit, edges found exactly.</p>' : ''}
    <div class="grade-actions">
      ${badOnes.length
        ? `<button type="button" class="btn primary" id="gradeAgain">Retake</button>
           <button type="button" class="btn ghost" id="gradeKeep">Use it anyway</button>`
        : `<button type="button" class="btn primary" id="gradeKeep">${grader.step === GRADE_STEPS.length - 1 ? 'Use it — see the grade' : 'Use it — next'}</button>
           <button type="button" class="btn ghost" id="gradeAgain">Retake</button>`}
    </div>`;
  drawCard(body.querySelector('#gradeStill'), o.card, 1 / 3);
  body.querySelector('#gradeKeep').addEventListener('click', () => {
    grader.shots[s.key] = { ...o, quality: q };
    // A small copy of the original photo, for "Help make it more accurate".
    jpegOf(img, 1600).then((b) => { if (grader.shots[s.key]) grader.shots[s.key].raw = b; });
    nextStep();
  });
  body.querySelector('#gradeAgain').addEventListener('click', showStep);
}

function nextStep() {
  grader.step++;
  if (grader.step >= GRADE_STEPS.length) { stopLive(); stopGraderCamera(); runGrade(); return; }
  showStep();
}

/* An image ({ d, w, h }) as a JPEG data URL, longest side at most `max`. */
function jpegOf(img, max = 1600, q = 0.85) {
  const k = Math.min(1, max / Math.max(img.w, img.h));
  const src = document.createElement('canvas');
  src.width = img.w; src.height = img.h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.d), img.w, img.h), 0, 0);
  const c = document.createElement('canvas');
  c.width = Math.round(img.w * k); c.height = Math.round(img.h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return Promise.resolve(c.toDataURL('image/jpeg', q));
}

/* Send this grading's photos with the owner's verdict, so the grader can be tuned on real
 * cards (tools/grade-samples.mjs). Returns the code to pass on. */
async function sendSample(r, verdict) {
  const imgs = {};
  for (const [k, shot] of Object.entries(grader.shots)) {
    imgs[k] = (await jpegOf(shot.card.wide ?? shot.card, 1400, 0.88)).split(',')[1];
    if (shot.raw) imgs[`${k}Raw`] = shot.raw.split(',')[1];
  }
  const g = r.g;
  const report = { score: g.score, high: g.high, low: g.low, condition: g.condition, subs: g.subs, why: g.why,
    centering: { front: r.frontC?.ok ? [r.frontC.lr.text, r.frontC.tb.text] : null, back: r.backC?.ok ? [r.backC.lr.text, r.backC.tb.text] : null },
    checks: Object.fromEntries(Object.entries(grader.shots).map(([k, v]) => [k, v.quality.checks])), version: 2 };
  const res = await fetch(new URL('grade-sample', AU_SOLD_URL), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card: { id: grader.card.id, name: grader.card.name, set: grader.card.setName }, verdict, report, images: imgs }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.reason || res.status);
  return j.code;
}

/* Draw a flattened card into a canvas at `k` scale; returns the 2D context. */
function drawCard(canvas, card, k) {
  canvas.width = Math.round(card.w * k);
  canvas.height = Math.round(card.h * k);
  const c = document.createElement('canvas');
  c.width = card.w; c.height = card.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(card.d), card.w, card.h), 0, 0);
  const x = canvas.getContext('2d');
  x.drawImage(c, 0, 0, canvas.width, canvas.height);
  return x;
}

/* ---------- The report ---------- */

async function runGrade() {
  stepDots();
  grader.el.querySelector('#gradeStepName').textContent = 'Checking…';
  const body = grader.el.querySelector('#gradeBody');
  const say = async (t) => { body.innerHTML = `<p class="empty"><span class="spinner"></span>${esc(t)}</p>`; await new Promise((r) => setTimeout(r, 30)); };
  const { front, back, tilt1, tilt2 } = grader.shots;
  if (!front) { body.innerHTML = '<p class="empty">The front photo is needed. Close and start again.</p>'; return; }
  try {
    await say('Measuring centering…');
    const frontC = GR.centering(front.card);
    const backC = back ? GR.centering(back.card) : null;
    await say('Checking edges and corners…');
    const frontE = GR.edges(front.card), backE = back ? GR.edges(back.card) : null;
    const frontK = GR.corners(front.card, frontE.borderRef), backK = back ? GR.corners(back.card, backE.borderRef) : null;
    await say('Comparing the surface with the official image…');
    const ref = await grader.refPromise;
    const surf = ref ? GR.spots(front.card, ref) : null;
    await say('Looking for scratches…');
    const scr = [tilt1, tilt2].filter(Boolean).map((t) => GR.scratches(t.card, ref ?? front.card));
    const g = GR.grade({ frontC, backC, frontE, backE, frontK, backK, surf, scr });
    showReport({ front, back, tilts: [tilt1, tilt2].filter(Boolean), frontC, backC, frontE, backE, frontK, backK, surf, scr, g, ref });
  } catch (err) {
    console.error(err);
    body.innerHTML = `<p class="empty">Something went wrong checking the photos (${esc(err.message)}). Try again with clearer photos.</p>`;
  }
}

const CONDITION_NAMES = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' };
const CORNER_NAMES = { tl: 'top left', tr: 'top right', br: 'bottom right', bl: 'bottom left' };

function showReport(r) {
  grader.el.querySelector('#gradeStepName').textContent = 'Report';
  const { g } = r;
  const body = grader.el.querySelector('#gradeBody');
  const range = g.low === g.high ? `${g.high}` : `${g.low}–${g.high}`;
  const level = (lv) => GR.WEAR_WORDS[Math.min(4, lv)];
  const centerRow = (label, c) => !c ? '' : !c.ok ? `<tr><td>${label}</td><td colspan="2">Couldn't measure (borders unclear)</td></tr>`
    : `<tr><td>${label}</td><td><b>${c.lr.text}</b> <small>left/right</small></td><td><b>${c.tb.text}</b> <small>top/bottom</small>${c.sure ? '' : ' <small class="warn">(less sure)</small>'}</td></tr>`;
  const edgeText = (e, side) => {
    const s = e.sides[side];
    if (s.paleTable) return 'not judged (light table)';
    const lv = GR.levelOf(GR.edgePoints(s));
    return lv ? `${level(lv)}${s.longestMm >= 1 ? ` · ${s.longestMm.toFixed(1)} mm stretch` : ''}` : 'clean';
  };
  const edgeRows = (e, label) => !e ? '' : `<tr><td>${label}</td><td colspan="2">${['top', 'right', 'bottom', 'left'].map((k) =>
    `${k}: <b>${edgeText(e, k)}</b>`).join(' · ')}</td></tr>`;
  const cornerText = (c) => c.glare ? 'reflection — not judged' : (() => {
    const lv = GR.cornerWear(c);
    if (!lv) return 'sharp, clean';
    const soft = (!c.paleBg && c.missingShare > 0.12) || c.roundMm > 0.8;
    return `${level(lv)}${soft ? ' · looks soft / chipped' : ' whitening'}`;
  })();
  const nSpots = r.surf?.aligned && !r.surf.unreadable ? r.surf.spots.length : 0;
  const bar = (label, v, note = '') => `<div class="grade-bar"><span>${label}</span><div class="bar"><i style="width:${Math.max(4, v * 10)}%" class="${v >= 8.5 ? 'ok' : v >= 6.5 ? 'mid' : v >= 4.5 ? 'low' : 'bad'}"></i></div><b>${v >= 9.95 ? '10' : v.toFixed(1)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  const nScr = r.scr.reduce((n, s) => n + s.scratches.length, 0);
  body.innerHTML = `
    <div class="grade-result">
      <span class="price-label">Estimated grade</span>
      <span class="grade-big">PSA ${range}</span>
      <span class="grade-cond">${CONDITION_NAMES[g.condition]} (${g.condition})</span>
      <p class="price-note">${g.why.length ? `Held back by: ${esc(g.why.join('; '))}.` : 'Nothing found that would hold it back.'}
        ${g.unsure.length ? `<br>Less sure because: ${esc(g.unsure.join(', '))}.` : ''}</p>
    </div>
    <div class="grade-bars">
      ${bar('Centering', g.subs.centering)}
      ${bar('Corners', g.subs.corners)}
      ${bar('Edges', g.subs.edges)}
      ${bar('Surface', g.subs.surface, !r.surf?.aligned || r.surf?.unreadable ? 'not fully checked' : '')}
    </div>
    <p class="price-note">Each area scored out of 10 like a grader would; the grade follows the weakest, a little lower when several are weak.</p>

    <h3 class="sub-title">Centering</h3>
    <table class="detail-table grade-table">
      ${centerRow('Front', r.frontC)}${centerRow('Back', r.backC)}
    </table>
    <p class="price-note">PSA 10 allows 55/45 on the front and 75/25 on the back; PSA 9 60/40 and 90/10; PSA 8 65/35.</p>

    <h3 class="sub-title">Edges</h3>
    <table class="detail-table grade-table">
      ${edgeRows(r.backE, 'Back')}
      ${r.frontE.coloured ? edgeRows(r.frontE, 'Front') : '<tr><td>Front</td><td colspan="2">Silver / pale border — whitening is judged on the back</td></tr>'}
    </table>

    <h3 class="sub-title">Corners</h3>
    <div class="grade-corners" id="gradeCorners"></div>

    <h3 class="sub-title">Surface</h3>
    <div class="grade-surface" id="gradeSurface"></div>
    <p class="price-note">${!r.ref ? 'No official image to compare with for this card, so marks and dents weren\'t checked; scratches were judged against your front photo.'
      : !r.surf?.aligned ? 'Your front photo didn\'t line up with the official image well enough to compare (is it the right card?).'
        : r.surf.unreadable ? 'The light on your front photo (a reflection or uneven light) made a fair comparison with the official image impossible, so marks and dents weren\'t judged. Light from the side, no reflections, works best.'
        : nSpots ? `${nSpots} spot${nSpots > 1 ? 's' : ''} that the official image doesn't have (circled) — a mark, dent, ink or print flaw. Check them in person.`
          : 'No marks or dents found against the official image.'}
      ${r.scr.length ? (r.scr.some((s) => s.textured) ? ' Holo foil texture on a tilted shot — scratches on foil can\'t be judged reliably.'
        : nScr ? ` ${nScr} possible scratch${nScr > 1 ? 'es' : ''} in the reflection (boxed).` : ' No scratches seen in the reflection.') : ' No tilted shots, so scratches weren\'t checked.'}</p>

    ${(() => {
      const notes = [r.front, r.back, ...r.tilts].filter(Boolean).flatMap((s) => s.quality.checks.map((c) => c.text));
      return notes.length ? `<h3 class="sub-title">Photo notes</h3><ul class="grade-notes">${[...new Set(notes)].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    })()}
    <div class="grade-help" id="gradeHelp">
      <b>Help make it more accurate</b>
      <p class="price-note">Know this card's real condition? Send these photos with your verdict and the grader can be tuned on real cards. You'll get a short code to pass on. Only the card photos are sent.</p>
      <div class="variant-chips" id="gradeVerdict">${['NM', 'LP', 'MP', 'HP', 'DMG'].map((k) => `<button type="button" class="chip" data-v="${k}">${k}</button>`).join('')}</div>
      <label class="grade-psa">PSA grade, if it's been graded <input id="gradePsa" inputmode="decimal" placeholder="e.g. 9" maxlength="4"></label>
      <button type="button" class="btn ghost" id="gradeSend" disabled>Send photos</button>
      <p class="price-note" id="gradeSendMsg"></p>
    </div>
    <p class="price-note grade-disclaimer">An estimate from photos — not a grading company's grade. Graders use bright angled light and magnification, and see things a phone can't (fine scratches, tiny dents, print lines, re-cut edges).</p>
    <div class="grade-actions">
      <button type="button" class="btn primary" id="gradeDone">Done</button>
      <button type="button" class="btn ghost" id="gradeRedo">Grade again</button>
    </div>`;

  // Corners: zoomed crops with the wear marked.
  const cornersBox = body.querySelector('#gradeCorners');
  for (const [label, shot, k] of [['Front', r.front, r.frontK], ['Back', r.back, r.backK]]) {
    if (!shot || !k) continue;
    const row = document.createElement('div');
    row.className = 'grade-corner-row';
    row.innerHTML = `<span class="price-label">${label}</span>`;
    for (const name of ['tl', 'tr', 'bl', 'br']) {
      const c = k[name];
      const cell = document.createElement('figure');
      const cv = document.createElement('canvas');
      const Z = Math.round(4.6 * GR.MM);
      cv.width = Z * 2; cv.height = Z * 2;
      const x = cv.getContext('2d');
      const src = document.createElement('canvas');
      src.width = shot.card.w; src.height = shot.card.h;
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(shot.card.d), shot.card.w, shot.card.h), 0, 0);
      const ox = name.endsWith('r') ? shot.card.w - Z : 0, oy = name.startsWith('b') ? shot.card.h - Z : 0;
      x.imageSmoothingEnabled = false;
      x.drawImage(src, ox, oy, Z, Z, 0, 0, Z * 2, Z * 2);
      x.fillStyle = 'rgba(255, 60, 60, 0.75)';
      for (const m of c.marks.slice(0, 4000)) x.fillRect((m.x - ox) * 2, (m.y - oy) * 2, 2, 2);
      cell.appendChild(cv);
      const cap = document.createElement('figcaption');
      cap.textContent = `${CORNER_NAMES[name]}: ${cornerText(c)}`;
      cell.appendChild(cap);
      row.appendChild(cell);
    }
    cornersBox.appendChild(row);
  }

  // Surface: the front with spots circled, tilted shots with scratches boxed.
  const surfBox = body.querySelector('#gradeSurface');
  const fig = (shot, caption, mark) => {
    const f = document.createElement('figure');
    const cv = document.createElement('canvas');
    const x = drawCard(cv, shot.card, 1 / 3);
    x.lineWidth = 2;
    x.strokeStyle = '#ff3c3c';
    mark(x, cv.width, cv.height);
    f.appendChild(cv);
    const cap = document.createElement('figcaption');
    cap.textContent = caption;
    f.appendChild(cap);
    surfBox.appendChild(f);
  };
  fig(r.front, 'Front', (x, w, h) => {
    for (const s of r.surf?.aligned ? r.surf.spots : []) {
      x.beginPath();
      x.arc(s.x * w, s.y * h, Math.max(8, s.r * w * 1.5), 0, 7);
      x.stroke();
    }
  });
  r.tilts.forEach((t, i) => fig(t, `Reflection ${i + 1}`, (x, w, h) => {
    for (const s of r.scr[i]?.scratches ?? []) x.strokeRect((s.x - s.bw / 2) * w - 4, (s.y - s.bh / 2) * h - 4, s.bw * w + 8, s.bh * h + 8);
  }));
  if (r.back) fig(r.back, 'Back', () => {});

  let verdict = null;
  body.querySelectorAll('#gradeVerdict .chip').forEach((b) => b.addEventListener('click', () => {
    verdict = b.dataset.v;
    body.querySelectorAll('#gradeVerdict .chip').forEach((x) => x.classList.toggle('active', x === b));
    body.querySelector('#gradeSend').disabled = false;
  }));
  body.querySelector('#gradeSend').addEventListener('click', async () => {
    const btn = body.querySelector('#gradeSend'), msg = body.querySelector('#gradeSendMsg');
    btn.disabled = true;
    msg.textContent = 'Sending…';
    try {
      const code = await sendSample(r, { condition: verdict, psa: body.querySelector('#gradePsa').value.trim() || null });
      msg.innerHTML = `Sent ✓ — your code is <b class="grade-code">${esc(code)}</b>. Pass it on (e.g. "my NM card is ${esc(code)}") and these photos can be used to tune the grader.`;
    } catch (err) {
      msg.textContent = `Couldn't send (${err.message}) — check your connection and try again.`;
      btn.disabled = false;
    }
  });
  body.querySelector('#gradeDone').addEventListener('click', closeGrader);
  body.querySelector('#gradeRedo').addEventListener('click', () => { grader.step = 0; grader.shots = {}; showStep(); });
  body.scrollTop = 0;
}
