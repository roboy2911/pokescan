/* Card grader — the guided photos and the report (the measuring is in grade-core.js).
 * Opened from a card's sheet: "Grade this card". Four photos: front, back, and two tilted
 * front shots for the surface (the last two can be skipped). Nothing is saved. */

const GRADE_STEPS = [
  { key: 'front', title: 'Front', tip: 'Card flat on a plain table that isn\'t white (dark is best), even light, no sleeve. Hold the phone straight above it so the card fills the box.' },
  { key: 'back', title: 'Back', tip: 'Turn the card over — same spot, same light. The back\'s blue border shows edge and corner whitening best.' },
  { key: 'tilt1', title: 'Surface 1', tip: 'Front again, but tilt the phone (or the card) until a lamp or window reflects off the card. Scratches show up in that bright patch — keep it bright, not pure white.', optional: true },
  { key: 'tilt2', title: 'Surface 2', tip: 'Once more, with the reflection on the other half of the card.', optional: true },
];

const grader = { card: null, step: 0, shots: {}, stream: null, el: null, ref: null };

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

/* Pixels of an image / video frame (longest side at most 2400 px — plenty, and phones'
 * memory is limited). */
function imageDataOf(src, w, h) {
  const k = Math.min(1, 2400 / Math.max(w, h));
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
  const s = GRADE_STEPS[grader.step];
  stepDots();
  grader.el.querySelector('#gradeStepName').textContent = `${grader.step + 1} of ${GRADE_STEPS.length} · ${s.title}`;
  const body = grader.el.querySelector('#gradeBody');
  body.innerHTML = `
    <div class="grade-cam">
      <video id="gradeVideo" playsinline muted autoplay></video>
      <div class="grade-guide" id="gradeGuide"></div>
    </div>
    <p class="grade-tip">${esc(s.tip)}</p>
    <div class="grade-actions">
      <button type="button" class="btn primary" id="gradeShoot">Take photo</button>
      <button type="button" class="btn ghost" id="gradeUpload">Use a photo…</button>
      ${s.optional ? '<button type="button" class="btn ghost" id="gradeSkip">Skip</button>' : ''}
    </div>`;
  body.querySelector('#gradeUpload').addEventListener('click', () => grader.el.querySelector('#gradeFile').click());
  body.querySelector('#gradeSkip')?.addEventListener('click', () => nextStep());
  body.querySelector('#gradeShoot').addEventListener('click', () => {
    const v = body.querySelector('#gradeVideo');
    if (!v.videoWidth) { toast('The camera isn\'t ready — or use "Use a photo…"'); return; }
    const shot = imageDataOf(v, v.videoWidth, v.videoHeight);
    useShot(shot, guideFraction(v));
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
  } catch {
    body.querySelector('.grade-cam').innerHTML = '<p class="muted grade-nocam">No camera here — use "Use a photo…" (a photo taken with your camera app works well, and is often sharper).</p>';
    body.querySelector('#gradeShoot').hidden = true;
  }
}

/* Where the on-screen box is in the video (fractions), for the outline finder. */
function guideFraction(v) {
  const box = v.getBoundingClientRect(), g = grader.el.querySelector('#gradeGuide').getBoundingClientRect();
  const scale = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
  const offX = (box.width - v.videoWidth * scale) / 2, offY = (box.height - v.videoHeight * scale) / 2;
  const fx = (px) => (px - box.left - offX) / scale / v.videoWidth, fy = (py) => (py - box.top - offY) / scale / v.videoHeight;
  return { x0: fx(g.left), y0: fy(g.top), x1: fx(g.right), y1: fy(g.bottom) };
}

/* A photo was taken: find the card, show it, and ask to keep it or try again. */
async function useShot(img, guide) {
  const body = grader.el.querySelector('#gradeBody');
  body.innerHTML = '<p class="empty"><span class="spinner"></span>Finding the card…</p>';
  await new Promise((r) => setTimeout(r, 30));
  let o = null;
  try { o = GR.outline(img, guide); } catch (err) { console.error(err); }
  if (!o) {
    body.innerHTML = `<p class="empty">Couldn't find the card's edges. Use a plain table that's a different colour from the card's border, and get the whole card in the box.</p>
      <div class="grade-actions"><button type="button" class="btn primary" id="gradeRetry">Try again</button></div>`;
    body.querySelector('#gradeRetry').addEventListener('click', showStep);
    return;
  }
  const q = GR.quality(o);
  const s = GRADE_STEPS[grader.step];
  if (s.key.startsWith('tilt') && q.glare > 0.25) q.notes.push('Most of the card is washed out by the reflection — scratches hide in pure white. Tilt a little less.');
  if (!s.key.startsWith('tilt') && q.glare > 0.03) q.notes.push('There\'s a reflection on the card — it can hide or fake wear. Move the light or tilt slightly.');
  body.innerHTML = `
    <div class="grade-still"><canvas id="gradeStill"></canvas></div>
    ${q.notes.length ? `<ul class="grade-notes">${q.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="grade-tip ok">✓ Card found — edges are sharp.</p>'}
    <div class="grade-actions">
      <button type="button" class="btn primary" id="gradeKeep">${grader.step === GRADE_STEPS.length - 1 ? 'Use it — see the grade' : 'Use it — next'}</button>
      <button type="button" class="btn ghost" id="gradeAgain">Retake</button>
    </div>`;
  drawCard(body.querySelector('#gradeStill'), o.card, 1 / 3);
  body.querySelector('#gradeKeep').addEventListener('click', () => { grader.shots[s.key] = { ...o, quality: q }; nextStep(); });
  body.querySelector('#gradeAgain').addEventListener('click', showStep);
}

function nextStep() {
  grader.step++;
  // The back is needed for a full grade, but can be skipped from the photo step's file picker.
  if (grader.step >= GRADE_STEPS.length) { stopGraderCamera(); runGrade(); return; }
  showStep();
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
    const lv = GR.wearLevel(s.share) + (s.longestMm > 6 ? 1 : 0);
    return lv ? `${level(lv)}${s.longestMm >= 1 ? ` · ${s.longestMm.toFixed(1)} mm stretch` : ''}` : 'clean';
  };
  const edgeRows = (e, label) => !e ? '' : `<tr><td>${label}</td><td colspan="2">${['top', 'right', 'bottom', 'left'].map((k) =>
    `${k}: <b>${edgeText(e, k)}</b>`).join(' · ')}</td></tr>`;
  const cornerText = (c) => c.glare ? 'reflection — not judged' : (() => {
    const lv = GR.cornerWear(c);
    if (!lv) return 'sharp, clean';
    const soft = !c.paleBg && c.missingShare > 0.08;
    return `${level(lv)}${soft ? ' · looks soft / chipped' : ' whitening'}`;
  })();
  const nSpots = r.surf?.aligned ? r.surf.spots.length : 0;
  const nScr = r.scr.reduce((n, s) => n + s.scratches.length, 0);
  body.innerHTML = `
    <div class="grade-result">
      <span class="price-label">Estimated grade</span>
      <span class="grade-big">PSA ${range}</span>
      <span class="grade-cond">${CONDITION_NAMES[g.condition]} (${g.condition})</span>
      <p class="price-note">${g.why.length ? `Held back by: ${esc(g.why.join('; '))}.` : 'Nothing found that would hold it back.'}
        ${g.unsure.length ? `<br>Less sure because: ${esc(g.unsure.join(', '))}.` : ''}</p>
    </div>

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
        : nSpots ? `${nSpots} spot${nSpots > 1 ? 's' : ''} that the official image doesn't have (circled) — a mark, dent, ink or print flaw. Check them in person.`
          : 'No marks or dents found against the official image.'}
      ${r.scr.length ? (r.scr.some((s) => s.textured) ? ' Holo foil texture on a tilted shot — scratches on foil can\'t be judged reliably.'
        : nScr ? ` ${nScr} possible scratch${nScr > 1 ? 'es' : ''} in the reflection (boxed).` : ' No scratches seen in the reflection.') : ' No tilted shots, so scratches weren\'t checked.'}</p>

    ${(() => {
      const notes = [r.front, r.back, ...r.tilts].filter(Boolean).flatMap((s) => s.quality.notes);
      return notes.length ? `<h3 class="sub-title">Photo notes</h3><ul class="grade-notes">${[...new Set(notes)].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    })()}
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
      const Z = Math.round(GR.RADIUS + 2.6 * GR.MM);
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

  body.querySelector('#gradeDone').addEventListener('click', closeGrader);
  body.querySelector('#gradeRedo').addEventListener('click', () => { grader.step = 0; grader.shots = {}; showStep(); });
  body.scrollTop = 0;
}
