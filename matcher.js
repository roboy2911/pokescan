/* Card matching: find the card anywhere in a camera frame and identify it against the index.
 * Needs cardprint.js and detect.js. Runs inside worker.js; tools/sim.js also loads it
 * on a page for accuracy tests.
 *
 * 1. Candidate positions: search windows (card-shaped boxes) at several sizes — from
 *    filling the guide down to ~40% of it — and positions, so far-away / off-centre cards
 *    are covered. Edge detection runs in each window to find real card outlines.
 * 2. Quick pass: a coarse 60-value fingerprint of the best candidates against all ~20k
 *    cards → shortlist of 800 cards, and the few candidates that look most like *some* card
 *    (= where the card actually is).
 * 3. Fine pass: many slightly shifted crops of those few candidates, full fingerprints,
 *    glare-tolerant scoring, against the shortlist only.
 *
 * Fingerprints with glare cells (`q.w`, see cardprint.js) are compared on their usable
 * cells only: the index card is re-standardised over those same cells first, so the score
 * means the same as for a glare-free photo.
 */

/* Sizes (fraction of the guide) and position spacing (fraction of window size). */
const SEARCH_SCALES = [1, 0.8, 0.64, 0.51, 0.41];
const SEARCH_STEP = 0.3;
// Size cards are cut out at (plenty for an 8x11 fingerprint).
const WARP_W = 168, WARP_H = 235;
// Areas with less brightness variation than this (0–255) are blank, not cards.
const MIN_CONTRAST = 6;
// ...and areas with too little fine detail (fpDetail) are a plain mat / table, not a card: on
// a white playmat, uneven light or a reflection gave the mat enough contrast to be "matched"
// to a random card. Plain = edges < e1, or edges < e2 with almost no colour variation (< c).
// Tuned on tools/sim.js (testEmpty on a white mat, testHard incl. dim toploaders).
// sd: a position whose quick-pass fingerprints' usable (non-glare) cells vary less than this
// (0–255) is a plain surface once the reflection is left out, and isn't a candidate.
const PLAIN = { e1: 6, e2: 10, c: 3, sd: 4 };
const solid = (q, p) => !(q.sd < p.sd);
const isPlain = ({ edges, chroma }, p) => edges < p.e1 || (edges < p.e2 && chroma < p.c);
const MATCH_ROBUST_KEEP = 0.85;
// Cards in a toploader: the card is ~83% of the toploader's outline and usually sits low or
// off to one side, so outlines are also cropped there. `coarse`: [scale, dx, dy] crops for
// the quick pass; `fine`: scales × sideways × downward shifts. Tuned on tools/sim.js
// testHard (real images, 'toploader' / 'toploader2'). `penalty`: those crops score a little
// lower, so a zoomed-in part of a sleeved card can't beat the real match by chance.
const TOPLOADER = { penalty: 0.02, coarse: [[0.84, 0, 0.035]], fine: { s: [0.82, 0.86], dx: [-0.05, 0, 0.05], dy: [0, 0.035, 0.07] } };
// Score taken off per fraction of the card hidden by glare: a few visible cells can look
// like many cards, so a heavily masked match must not seem as sure as a clear one.
const MASK_PENALTY = 0.2;

// Glare memory (live scanning): glare on plastic moves with the slightest tilt, so the last
// few straightened views of the same card are combined, keeping each pixel's darkest value —
// glare only ever adds light, so any spot one frame saw without glare comes back. Views are
// lined up by the strongest card-sized outline (a toploader / sleeve / card edge), and the
// memory starts again when that outline jumps (another card, or the phone moved a lot).
const MEMORY_FRAMES = 8;
const MEMORY_MOVE = 0.35;  // outline centre may move this much (in guide heights) between frames
const MEMORY_SIZE = 0.35;  // ...and change size by this much
const ALIGN_MIN = 0.4;     // views whose edges line up worse than this aren't combined
// A block comes from an older view only when the newest is this much more glared there
// (min-channel level, 0-255).
const GLARE_MARGIN = 25;
const COMBINED_BONUS = 0.03; // preference for the combined view when choosing the card's position
// A cell counts as glare for the "tilt it" hint when blown out or under a veil this strong.
const GLARE_VEIL = 0.35;

function createMatcher(indexBuffer) {
  const dim = FP.DIM;
  const vectors = new Int8Array(indexBuffer);
  const count = vectors.length / dim;
  const norms = new Float32Array(count);
  const pooled = new Float32Array(count * FP_POOL_DIM);
  // Per card and colour channel: sum and sum of squares of its pooled values (for glare-
  // masked comparisons, which then only need to subtract the few masked blocks).
  const pooledSums = new Float64Array(count * 6);
  for (let c = 0; c < count; c++) {
    const v = vectors.subarray(c * dim, (c + 1) * dim);
    let s = 0;
    for (let k = 0; k < dim; k++) s += v[k] * v[k];
    norms[c] = Math.sqrt(s) || 1;
    pooled.set(fpPool(v), c * FP_POOL_DIM);
    for (let k = 0; k < FP_POOL_DIM; k++) {
      const x = pooled[c * FP_POOL_DIM + k];
      pooledSums[c * 6 + (k % 3)] += x;
      pooledSums[c * 6 + 3 + (k % 3)] += x * x;
    }
  }

  /* Card-shaped search windows over the region, all inside the image. */
  function searchWindows(region, step = SEARCH_STEP) {
    const { w, h, guide } = region;
    const gw = guide.x1 - guide.x0, gh = guide.y1 - guide.y0;
    const cx = (guide.x0 + guide.x1) / 2, cy = (guide.y0 + guide.y1) / 2;
    const wins = [];
    for (const s of SEARCH_SCALES) {
      const ww = gw * s, hh = gh * s;
      // How far the window centre can move and stay inside the image.
      const maxX = Math.max(0, Math.min(cx - ww / 2, w - cx - ww / 2));
      const maxY = Math.max(0, Math.min(cy - hh / 2, h - cy - hh / 2));
      const stepX = ww * step, stepY = hh * step;
      const nx = Math.floor(maxX / stepX), ny = Math.floor(maxY / stepY);
      for (let iy = -ny; iy <= ny; iy++) {
        for (let ix = -nx; ix <= nx; ix++) {
          const x = cx + ix * stepX, y = cy + iy * stepY;
          wins.push({ x0: x - ww / 2, y0: y - hh / 2, x1: x + ww / 2, y1: y + hh / 2, s });
        }
      }
    }
    return wins;
  }

  /* All candidate card positions in one frame: detected outlines + plain windows. */
  function candidates(region, { step = SEARCH_STEP, maxOutlines = 16, tl = TOPLOADER, plain = PLAIN } = {}) {
    const { data, w, h } = region;
    const gray = detGray(data, w, h);
    fpPrepare(data, w, h); // many crops of this frame get fingerprinted
    const outlines = [];
    for (const win of searchWindows(region, step)) {
      for (const { q, score } of detectCardQuadsScored(data, w, h, win, 2, 0, gray)) {
        // Skip outlines we already found from a neighbouring window.
        const dup = outlines.some((o) => o.q.every((p, k) => Math.hypot(p.x - q[k].x, p.y - q[k].y) < 0.03 * (win.x1 - win.x0)));
        if (!dup) outlines.push({ q, score });
      }
    }
    outlines.sort((a, b) => b.score - a.score);
    const cands = [];
    for (const { q } of outlines) {
      if (cands.length >= maxOutlines) break;
      const warped = warpQuad(data, w, h, q, WARP_W, WARP_H);
      fpPrepare(warped, WARP_W, WARP_H);
      if (fpContrast(warped, WARP_W, WARP_H) < MIN_CONTRAST) continue; // blank area, not a card
      if (isPlain(fpDetail(warped, WARP_W, WARP_H), plain)) continue; // plain mat / table
      // As found, and zoomed in a little in case the outline is a sleeve / binder pocket.
      const coarse = [...fpQueries(warped, WARP_W, WARP_H, FP.X0, FP.Y0, FP.X1, FP.Y1), fpCrops(warped, WARP_W, WARP_H, [0.91], [0])[0],
        ...(tl?.coarse ? tl.coarse.map(([s, dx, dy]) => fpCropsXY(warped, WARP_W, WARP_H, [s], [dx], [dy])[0]) : [])]
        .filter((f) => f && solid(f, plain));
      if (coarse.length) cands.push({ kind: 'outline', q, warped, coarse });
    }
    // Plain windows too (centred, every size), in case no outline is found.
    for (const win of searchWindows(region).filter((v) => Math.abs((v.x0 + v.x1) / 2 - (region.guide.x0 + region.guide.x1) / 2) < 1
      && Math.abs((v.y0 + v.y1) / 2 - (region.guide.y0 + region.guide.y1) / 2) < 1)) {
      const rw = win.x1 - win.x0, rh = win.y1 - win.y0;
      const contrast = fpContrast(data, w, h,
        (win.x0 + FP.X0 * rw) / w, (win.y0 + FP.Y0 * rh) / h, (win.x0 + FP.X1 * rw) / w, (win.y0 + FP.Y1 * rh) / h);
      if (win.s < 1 && contrast < MIN_CONTRAST) continue; // the full-size box is kept unless it's plain:
      if (isPlain(fpDetail(data, w, h, (win.x0 + FP.X0 * rw) / w, (win.y0 + FP.Y0 * rh) / h, (win.x0 + FP.X1 * rw) / w, (win.y0 + FP.Y1 * rh) / h), plain)) continue;
      const coarse = fpCropsRect(data, w, h, win, [0.95], [0]).filter((f) => solid(f, plain));
      if (coarse.length) cands.push({ kind: 'window', rect: win, coarse });
    }
    return cands;
  }

  /* Score pooled index vectors against pooled queries. Returns per-card best score and,
   * per query, its best score (how much that position looks like some card).
   * Glare-tolerant like the fine pass: the `drop` worst-matching of the 20 cells are
   * ignored, so a reflection streak can't knock the right card out of the shortlist. */
  function quickPass(queries, drop = 0, owner = null, ncand = 0) {
    const pq = queries.map((q) => fpPool(q));
    const cardBest = new Float32Array(count).fill(-Infinity);
    // Per candidate position too: each gets its own shortlist (see match()).
    const candBest = Array.from({ length: ncand }, () => new Float32Array(count).fill(-Infinity));
    const qOwner = owner ?? new Int32Array(pq.length);
    const queryBest = new Float32Array(pq.length).fill(-Infinity);
    const masked = pq.map((q) => !!q.w);
    // For masked queries: which blocks are masked, how many are used, and Σq² per channel.
    const minfo = pq.map((q) => {
      if (!q.w) return null;
      const off = [];
      q.w.forEach((u, cell) => { if (!u) off.push(cell * 3); });
      const qq = [0, 0, 0];
      for (let k = 0; k < FP_POOL_DIM; k++) qq[k % 3] += q[k] * q[k];
      return { off, used: q.w.length - off.length, qq };
    });
    if (!drop) {
      // Plain dot product — fastest. With glare: correlation over the usable blocks.
      for (let c = 0; c < count; c++) {
        const base = c * FP_POOL_DIM;
        for (let qi = 0; qi < pq.length; qi++) {
          const q = pq[qi];
          const s = masked[qi] ? maskedPooledDot(q, minfo[qi], c) : plainDot(q, pooled, base);
          if (s > cardBest[c]) cardBest[c] = s;
          if (s > queryBest[qi]) queryBest[qi] = s;
          if (ncand && s > candBest[qOwner[qi]][c]) candBest[qOwner[qi]][c] = s;
        }
      }
      return { cardBest, queryBest, candBest };
    }
    const cells = FP_POOL_DIM / 3;
    const scale = cells / (cells - drop) / 2;
    const worst = new Float64Array(drop);
    for (let c = 0; c < count; c++) {
      const base = c * FP_POOL_DIM;
      for (let qi = 0; qi < pq.length; qi++) {
        const q = pq[qi];
        let sum = 0;
        worst.fill(0);
        for (let cell = 0, k = 0; cell < cells; cell++, k += 3) {
          const d0 = q[k] - pooled[base + k];
          const d1 = q[k + 1] - pooled[base + k + 1];
          const d2 = q[k + 2] - pooled[base + k + 2];
          const e = d0 * d0 + d1 * d1 + d2 * d2;
          sum += e;
          // Keep the `drop` largest errors (tiny insertion sort).
          if (drop && e > worst[drop - 1]) {
            let j = drop - 1;
            while (j > 0 && worst[j - 1] < e) { worst[j] = worst[j - 1]; j--; }
            worst[j] = e;
          }
        }
        for (let j = 0; j < drop; j++) sum -= worst[j];
        const s = 1 - sum * scale;
        if (s > cardBest[c]) cardBest[c] = s;
        if (s > queryBest[qi]) queryBest[qi] = s;
        if (ncand && s > candBest[qOwner[qi]][c]) candBest[qOwner[qi]][c] = s;
      }
    }
    return { cardBest, queryBest, candBest };
  }

  function plainDot(q, arr, base) {
    let s = 0;
    for (let k = 0; k < FP_POOL_DIM; k++) s += q[k] * arr[base + k];
    return s;
  }

  /* Correlation of a glare-masked pooled query `q` (standardised over its usable blocks, 0
   * elsewhere) with pooled index card c, each colour channel standardised over the usable
   * blocks only — same scale as a plain dot product. Uses the card's precomputed sums:
   * per channel, Σq·x over all blocks (q is 0 on masked ones), and Σx, Σx² minus the
   * masked blocks. */
  function maskedPooledDot(q, { off, used, qq }, c) {
    const base = c * FP_POOL_DIM;
    let s = 0;
    for (let ch = 0; ch < 3; ch++) {
      let sx = pooledSums[c * 6 + ch], sxx = pooledSums[c * 6 + 3 + ch], sqx = 0;
      for (let k = ch; k < FP_POOL_DIM; k += 3) sqx += q[k] * pooled[base + k];
      for (const o of off) {
        const x = pooled[base + o + ch];
        sx -= x;
        sxx -= x * x;
      }
      const vx = sxx - sx * sx / (used || 1);
      if (vx > 1e-12 && qq[ch] > 0) s += sqx / Math.sqrt(vx * qq[ch]);
    }
    return s / 3;
  }

  /* Index card c, re-standardised over the usable cells `w` and scaled to unit length
   * there (0 elsewhere) — directly comparable with a glare-masked query. */
  function maskedCard(c, w, out) {
    const cells = dim / 3;
    const base = c * dim;
    let used = 0;
    for (let cell = 0; cell < cells; cell++) used += w[cell];
    for (let ch = 0; ch < 3; ch++) {
      let sx = 0, sxx = 0;
      for (let cell = 0, k = ch; cell < cells; cell++, k += 3) {
        if (!w[cell]) continue;
        const x = vectors[base + k];
        sx += x; sxx += x * x;
      }
      const mean = sx / used;
      const sd = Math.sqrt(Math.max(1e-12, sxx / used - mean * mean));
      const scale = 1 / (sd * Math.sqrt(3 * used));
      for (let cell = 0, k = ch; cell < cells; cell++, k += 3) {
        out[k] = w[cell] ? (vectors[base + k] - mean) * scale : 0;
      }
    }
    return out;
  }

  /* Glare-tolerant score: ignores the grid cells that disagree most. 1 = identical. */
  function robustScores(queries, indices, topN, keepFrac = MATCH_ROBUST_KEEP, maskPenalty = MASK_PENALTY) {
    const cells = dim / 3;
    const keep = Math.round(cells * keepFrac);
    const drop = cells - keep;
    const worst = new Float64Array(drop); // largest errors so far, descending
    const out = [];
    // Crops often share a glare mask: re-standardise each card once per distinct mask.
    const maskIds = new Map();
    const qInfo = queries.map((q) => {
      if (!q.w) return { m: -1, used: cells, qDrop: drop };
      const key = q.w.join('');
      if (!maskIds.has(key)) maskIds.set(key, maskIds.size);
      const used = q.w.reduce((a, b) => a + b, 0);
      return { m: maskIds.get(key), used, qDrop: Math.round(used * (1 - keepFrac)) };
    });
    const maskBufs = Array.from(maskIds, () => new Float32Array(dim));
    const maskDone = new Int32Array(maskBufs.length).fill(-1);
    for (const c of indices) {
      const base = c * dim;
      const inv = 1 / norms[c];
      let top = -Infinity, topQ = -1;
      for (let qi = 0; qi < queries.length; qi++) {
        const q = queries[qi];
        // Glare-masked query: compare its usable cells with the card re-standardised there.
        const w = q.w;
        const { m, used, qDrop } = qInfo[qi];
        let x = null;
        if (w) {
          x = maskBufs[m];
          if (maskDone[m] !== c) {
            maskedCard(c, w, x);
            maskDone[m] = c;
          }
        }
        let sum = 0;
        worst.fill(0);
        for (let cell = 0, k = 0; cell < cells; cell++, k += 3) {
          if (w && !w[cell]) continue;
          const d0 = q[k] - (x ? x[k] : vectors[base + k] * inv);
          const d1 = q[k + 1] - (x ? x[k + 1] : vectors[base + k + 1] * inv);
          const d2 = q[k + 2] - (x ? x[k + 2] : vectors[base + k + 2] * inv);
          const e = d0 * d0 + d1 * d1 + d2 * d2;
          sum += e;
          if (qDrop && e > worst[qDrop - 1]) {
            let j = qDrop - 1;
            while (j > 0 && worst[j - 1] < e) { worst[j] = worst[j - 1]; j--; }
            worst[j] = e;
          }
        }
        for (let j = 0; j < qDrop; j++) sum -= worst[j];
        const score = 1 - (sum * used / (used - qDrop)) / 2 - maskPenalty * (1 - used / cells);
        if (score > top) { top = score; topQ = qi; }
      }
      out.push({ i: c, score: top, q: topQ });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
  }

  /* Indices of the k largest values (order not needed). */
  function topIndices(arr, k) {
    if (k >= arr.length) return Array.from(arr.keys());
    const cut = Float32Array.from(arr).sort()[arr.length - k];
    const out = [];
    for (let i = 0; i < arr.length && out.length < k; i++) if (arr[i] >= cut) out.push(i);
    return out;
  }

  /* Glare memory (see MEMORY_FRAMES). */
  let memory = [];
  const quadInfo = (q) => {
    const x = q.reduce((s, p) => s + p.x, 0) / 4, y = q.reduce((s, p) => s + p.y, 0) / 4;
    const h = (Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)) / 2;
    return { x, y, h };
  };
  /* The outline to line frames up by: about card / toploader size and in the guide — the one
   * most like the previous frame's, else the strongest (outlines come strongest first). */
  function anchorOf(cands, prev = null) {
    let best = null, bestD = Infinity;
    for (const c of cands) {
      if (c.kind !== 'outline' || c.combined) continue;
      const { guide } = c.region;
      const gh = guide.y1 - guide.y0;
      const info = quadInfo(c.q);
      if (!(info.h >= 0.55 * gh && info.x > guide.x0 && info.x < guide.x1 && info.y > guide.y0 && info.y < guide.y1)) continue;
      if (!prev) return c;
      const d = Math.hypot(info.x - prev.x, info.y - prev.y) / gh + Math.abs(info.h / prev.h - 1);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }
  /* Add this frame's anchor view; returns a combined (darkest-pixel) candidate, or null. */
  /* Line views up: each view's edges (gradient of a small grey copy), and the zoom + shift that
   * best maps view `v` onto the reference (normalised correlation of edges; glare is smooth,
   * so its edges barely count). The outline used can be the toploader one frame and the card
   * the next, so zooms from 0.8 to 1.25 are tried. */
  const AL_W = 42, AL_H = 59;
  function edgesOf(d) {
    const g = fpBoxGrid(d, WARP_W, WARP_H, AL_W, AL_H, 0, 0, 1, 1);
    const L = new Float32Array(AL_W * AL_H);
    for (let c = 0; c < L.length; c++) L[c] = 0.299 * g[c * 3] + 0.587 * g[c * 3 + 1] + 0.114 * g[c * 3 + 2];
    const E = new Float32Array(AL_W * AL_H);
    for (let y = 1; y < AL_H - 1; y++) {
      for (let x = 1; x < AL_W - 1; x++) {
        const c = y * AL_W + x;
        E[c] = Math.hypot(L[c + 1] - L[c - 1], L[c + AL_W] - L[c - AL_W]);
      }
    }
    return E;
  }
  function align(refE, E) {
    let best = { ncc: -1, s: 1, sy: 1, dx: 0, dy: 0 };
    const tryAt = (s, dx, dy, sy = s) => {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
      for (let y = 2; y < AL_H - 2; y += 1) {
        const v = 0.5 + ((y + 0.5) / AL_H - 0.5) * sy + dy;
        const yy = Math.floor(v * AL_H);
        if (yy < 1 || yy >= AL_H - 1) continue;
        for (let x = 2; x < AL_W - 2; x += 1) {
          const u = 0.5 + ((x + 0.5) / AL_W - 0.5) * s + dx;
          const xx = Math.floor(u * AL_W);
          if (xx < 1 || xx >= AL_W - 1) continue;
          const a = refE[y * AL_W + x], b = E[yy * AL_W + xx];
          sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
        }
      }
      if (n < AL_W * AL_H * 0.5) return;
      const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
      const ncc = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
      if (ncc > best.ncc) best = { ncc, s, sy, dx, dy };
    };
    for (let s = 0.8; s <= 1.25; s += 0.025) {
      for (let dx = -0.12; dx <= 0.12001; dx += 0.03) for (let dy = -0.12; dy <= 0.12001; dy += 0.03) tryAt(s, dx, dy);
    }
    // Refine around the best: zoom across and down separately (a toploader isn't card-shaped).
    for (const step of [0.01, 0.005]) {
      const b0 = { ...best };
      for (let s = b0.s - 2 * step; s <= b0.s + 2.001 * step; s += step) {
        for (let sy = b0.sy - 2 * step; sy <= b0.sy + 2.001 * step; sy += step) {
          for (let dx = b0.dx - 2 * step; dx <= b0.dx + 2.001 * step; dx += step) {
            for (let dy = b0.dy - 2 * step; dy <= b0.dy + 2.001 * step; dy += step) tryAt(s, dx, dy, sy);
          }
        }
      }
    }
    return best;
  }
  /* View `d` resampled into the reference's frame (zoom s, shift dx/dy as found by align). */
  function resample(d, { s, sy = s, dx, dy }) {
    const out = new Uint8ClampedArray(d.length); // alpha 0 = outside the view
    for (let y = 0; y < WARP_H; y++) {
      const yy = Math.floor((0.5 + ((y + 0.5) / WARP_H - 0.5) * sy + dy) * WARP_H);
      if (yy < 0 || yy >= WARP_H) continue;
      for (let x = 0; x < WARP_W; x++) {
        const xx = Math.floor((0.5 + ((x + 0.5) / WARP_W - 0.5) * s + dx) * WARP_W);
        if (xx < 0 || xx >= WARP_W) continue;
        const o = (y * WARP_W + x) * 4, i = (yy * WARP_W + xx) * 4;
        out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = 255;
      }
    }
    return out;
  }

  /* Per colour channel: the 30th-percentile value of a view (glare covers the bright end). */
  function levels(d) {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let p = 0; p < d.length; p += 16) { hist[0][d[p]]++; hist[1][d[p + 1]]++; hist[2][d[p + 2]]++; }
    const n = Math.floor(d.length / 16) * 0.3;
    return hist.map((h) => { let s = 0; for (let v = 0; v < 256; v++) { s += h[v]; if (s >= n) return v; } return 255; });
  }
  let lastAnchor = null, lastComp = null, lastViews = [], lastNcc = [];
  let memoryFrames = MEMORY_FRAMES, blockSize = 8;
  function remember(cands) {
    const last = memory.info ?? null;
    const a = anchorOf(cands, last);
    lastAnchor = null;
    if (!a) return null;
    const gh = a.region.guide.y1 - a.region.guide.y0;
    const now = quadInfo(a.q);
    lastAnchor = { x: +(now.x / gh).toFixed(3), y: +(now.y / gh).toFixed(3), h: +(now.h / gh).toFixed(3) };
    // A big jump (another card, or the phone moved a lot): start again.
    if (last && (Math.hypot(now.x - last.x, now.y - last.y) > MEMORY_MOVE * gh || Math.abs(now.h / last.h - 1) > MEMORY_SIZE)) memory = [];
    memory.info = now;
    if (!memory.length) {
      // The first view is the reference frame every later view is lined up with.
      memory.push(a.warped);
      memory.target = edgesOf(a.warped);
      memory.misses = 0;
      return null;
    }
    // Line this view up with the combined view so far (least glare, so the best edges).
    const t = align(memory.target, edgesOf(a.warped));
    lastNcc = [+t.ncc.toFixed(2)];
    if (t.ncc < ALIGN_MIN) {
      // Doesn't fit: a bad frame, or another card — twice in a row starts again from this one.
      // (The old combined view isn't offered: right after a swap it would be the last card.)
      if (++memory.misses >= 2) { memory = [a.warped]; memory.info = now; memory.target = edgesOf(a.warped); memory.misses = 0; }
      return null;
    }
    memory.misses = 0;
    memory.push(resample(a.warped, t));
    while (memory.length > memoryFrames) memory.shift();
    const views = [...memory];
    // Frames differ in exposure / white balance: bring each to the newest one's levels first
    // (per channel, by a darkish percentile that glare doesn't reach), then take the darkest.
    const ref = levels(views[views.length - 1]);
    const scaled = views.map((w) => {
      const lv = levels(w);
      const gain = lv.map((v, ch) => (v > 4 ? ref[ch] / v : 1));
      const o = new Uint8ClampedArray(w.length);
      for (let p = 0; p < w.length; p += 4) {
        o[p] = w[p] * gain[0]; o[p + 1] = w[p + 1] * gain[1]; o[p + 2] = w[p + 2] * gain[2]; o[p + 3] = w[p + 3];
      }
      return o;
    });
    // Block by block: the newest view, unless it's clearly glared there — then the view with
    // the least glare (glare lifts the darkest colours and blows pixels out). Each block keeps
    // one view's own colours, and without glare the combined view is just the newest frame
    // (so a card swapped in can't be mixed with the last one).
    const comp = new Uint8ClampedArray(views[0].length);
    const B = blockSize;
    for (let by = 0; by < WARP_H; by += B) {
      for (let bx = 0; bx < WARP_W; bx += B) {
        let pick = 0, pickV = Infinity, newestV = Infinity;
        scaled.forEach((w, k) => {
          let sum = 0, n = 0, blown = 0, missing = 0;
          for (let y = by; y < Math.min(WARP_H, by + B); y++) {
            for (let x = bx; x < Math.min(WARP_W, bx + B); x++) {
              const p = (y * WARP_W + x) * 4;
              if (!w[p + 3]) { missing++; continue; }
              const lo = Math.min(w[p], w[p + 1], w[p + 2]);
              sum += lo; n++;
              if (lo >= FP_GLARE_MIN) blown++;
            }
          }
          const v = !n || missing > n ? Infinity : sum / n + 120 * (blown / n);
          if (k === scaled.length - 1) newestV = v;
          if (v < pickV) { pickV = v; pick = k; }
        });
        if (newestV - pickV < GLARE_MARGIN) pick = scaled.length - 1;
        const w = scaled[pick];
        for (let y = by; y < Math.min(WARP_H, by + B); y++) {
          for (let x = bx; x < Math.min(WARP_W, bx + B); x++) {
            const p = (y * WARP_W + x) * 4;
            comp[p] = w[p]; comp[p + 1] = w[p + 1]; comp[p + 2] = w[p + 2]; comp[p + 3] = 255;
          }
        }
      }
    }
    lastComp = comp;
    lastViews = views;
    memory.target = edgesOf(comp);
    fpPrepare(comp, WARP_W, WARP_H);
    const coarse = [...fpQueries(comp, WARP_W, WARP_H, FP.X0, FP.Y0, FP.X1, FP.Y1), fpCrops(comp, WARP_W, WARP_H, [0.91], [0])[0],
      ...TOPLOADER.coarse.map(([s, dx, dy]) => fpCropsXY(comp, WARP_W, WARP_H, [s], [dx], [dy])[0])].filter(Boolean);
    memory.comp = { kind: 'outline', warped: comp, coarse, combined: views.length };
    return { ...memory.comp, q: a.q, region: a.region };
  }

  /* How far a candidate is from the middle of the view, in guide heights (0 = centred). */
  function centreDistance(c) {
    const { guide } = c.region;
    const gx = (guide.x0 + guide.x1) / 2, gy = (guide.y0 + guide.y1) / 2;
    let x, y;
    if (c.kind === 'outline') {
      x = c.q.reduce((s, p) => s + p.x, 0) / 4;
      y = c.q.reduce((s, p) => s + p.y, 0) / 4;
    } else {
      x = (c.rect.x0 + c.rect.x1) / 2;
      y = (c.rect.y0 + c.rect.y1) / 2;
    }
    return Math.hypot(x - gx, y - gy) / (guide.y1 - guide.y0);
  }

  /* Identify the card in one or more frames. Each region: { data, w, h, guide }.
   * With several cards in view (a binder page), the one nearest the middle wins unless it
   * can't be recognised: each candidate position is scored on its own, minus a penalty
   * for being off-centre. */
  function match(regions, topN = 12,
    { fineTop = 8, shortlistSize = 800, perCandidate = 300, preTop = 40, centreWeight = 0.06, windowPenalty = 0.03, keep = MATCH_ROBUST_KEEP, maskPenalty = MASK_PENALTY, drop = 0, debugIdx = null, step = SEARCH_STEP, maxOutlines = 16, tl = TOPLOADER, plain = PLAIN, live = false, combinedBonus = COMBINED_BONUS, memFrames = 0, block = 0 } = {}) {
    const t0 = performance.now();
    const cands = regions.flatMap((r) => candidates(r, { step, maxOutlines, tl, plain }).map((c) => ({ ...c, region: r })));
    // Live scanning: also the combined view of the last few frames (glare memory).
    if (!live) memory = [];
    if (memFrames) memoryFrames = memFrames;
    if (block) blockSize = block;
    const combined = live ? remember(cands) : null;
    if (combined) cands.push(combined);
    if (!cands.length) return { matches: [], where: null };
    const t1 = performance.now();
    // Each candidate has one or more quick-pass fingerprints.
    const queries = [];
    const owner = [];
    cands.forEach((c, ci) => c.coarse.forEach((q) => { queries.push(q); owner.push(ci); }));
    const { cardBest, queryBest, candBest } = quickPass(queries, drop, owner, cands.length);
    const t2 = performance.now();
    cands.forEach((c) => { c.quick = -Infinity; });
    queryBest.forEach((s, qi) => { cands[owner[qi]].quick = Math.max(cands[owner[qi]].quick, s); });
    cands.forEach((c) => {
      c.dist = centreDistance(c);
      // A detected outline is real evidence of a card; a smaller plain box is just a guess
      // (the full-size box is where the guide says the card is, so it isn't penalised).
      c.penalty = centreWeight * c.dist + (c.kind === 'window' && c.rect.s < 1 ? windowPenalty : 0);
      c.prio = c.quick - c.penalty;
    });

    const shortlist = Array.from(cardBest.keys()).sort((a, b) => cardBest[b] - cardBest[a]).slice(0, shortlistSize);
    const order = Array.from(cands.keys()).sort((a, b) => cands[b].prio - cands[a].prio);
    // The centred full-size window (a card filling the guide) is always checked closely too.
    const centre = cands.findIndex((c) => c.kind === 'window' && c.rect.s === 1);
    const comb = combined ? cands.length - 1 : -1;
    const chosen = [...new Set([...order.slice(0, fineTop), ...(centre >= 0 ? [centre] : []), ...(comb >= 0 ? [comb] : [])])];

    // Testing aid (tools/sim.js): how the correct card fares at each candidate position.
    const debug = debugIdx === null ? null : {
      inShortlist: shortlist.includes(debugIdx),
      coarseRank: Array.from(cardBest.keys()).filter((c) => cardBest[c] > cardBest[debugIdx]).length,
      cands: [],
      lists: [],
    };

    let best = null;
    for (const qi of chosen) {
      const c = cands[qi];
      // Outlines can be a sleeve/binder pocket slightly bigger than the card, so also try
      // zooming in a little — or a lot, for a toploader (fineTl).
      const fine = (c.kind === 'outline'
        ? fpCrops(c.warped, WARP_W, WARP_H, [0.91, 0.96, 1], [-0.015, 0, 0.015])
        : fpCropsRect(c.region.data, c.region.w, c.region.h, c.rect));
      const fineTl = c.kind === 'outline' && tl?.fine ? fpCropsXY(c.warped, WARP_W, WARP_H, tl.fine.s, tl.fine.dx, tl.fine.dy) : null;
      if (!fine.length) continue;
      // Narrow the shortlist with this position's few quick fingerprints first, then
      // compare all the crops against the best of it only.
      // Its own best coarse matches join the shared shortlist: a position that really is the
      // card can rank it well even when junk positions (outlines along a reflection's edges)
      // crowd it out of the shared list.
      const own = perCandidate ? topIndices(candBest[qi], perCandidate) : [];
      const list = own.length ? [...new Set([...shortlist, ...own])] : shortlist;
      const pre = preTop ? robustScores(c.coarse, list, preTop, keep, maskPenalty).map((r) => r.i) : list;
      let ranked = robustScores(fine, pre, topN, keep, maskPenalty);
      if (fineTl?.length) {
        // Toploader crops: a small handicap, so a zoomed-in part of a sleeved card can't
        // beat the real match just by resembling another card.
        const byCard = new Map(ranked.map((r) => [r.i, r]));
        for (const r of robustScores(fineTl, pre, topN, keep, maskPenalty)) {
          const sc = r.score - (tl.penalty ?? 0);
          if (!byCard.has(r.i) || byCard.get(r.i).score < sc) byCard.set(r.i, { i: r.i, score: sc });
        }
        ranked = [...byCard.values()].sort((a, b) => b.score - a.score).slice(0, topN);
      }
      // The combined view (glare memory) rests on several frames, so it's preferred a little
      // when choosing where the card is — its scores themselves aren't changed.
      const score = ranked[0].score - c.penalty + (c.combined ? combinedBonus : 0);
      if (!best || score > best.score) best = { score, ranked, c };
      const tq = fine[ranked[0].q] ?? fineTl?.[ranked[0].q];
      debug?.lists?.push({ penalty: c.penalty, ranked: ranked.map((r) => [r.i, +r.score.toFixed(4)]) });
      debug?.cands.push({
        used: tq?.w ? tq.w.reduce((a, b) => a + b, 0) : 88,
        detail: (() => { const dd = c.kind === 'outline' ? fpDetail(c.warped, WARP_W, WARP_H) : null; return dd ? `${dd.edges.toFixed(0)}/${dd.chroma.toFixed(0)}` : ''; })(),
        kind: c.kind === 'outline' ? 'outline' : `win${c.rect.s}`,
        dist: +c.dist.toFixed(2),
        top: +ranked[0].score.toFixed(3),
        target: +robustScores(fine, [debugIdx], 1, keep, maskPenalty)[0].score.toFixed(3),
      });
    }
    if (!best) return { matches: [], where: null };
    // How much of the card is glare (blown out, or a heavy veil): the app asks for a tilt.
    const gc = best.c.kind === 'outline' ? best.c : anchorOf(cands);
    let glare = 0;
    if (gc) {
      const a = fpVeil(gc.warped, WARP_W, WARP_H, FP.X0, FP.Y0, FP.X1, FP.Y1);
      const q = fpQueries(gc.warped, WARP_W, WARP_H, FP.X0, FP.Y0, FP.X1, FP.Y1)[0];
      let n = 0;
      for (let cell = 0; cell < a.length; cell++) if ((q.w && !q.w[cell]) || a[cell] > GLARE_VEIL) n++;
      glare = n / a.length;
    }
    return {
      matches: best.ranked,
      glare,
      combined: best.c.combined || 0,
      memory: { frames: memory.length, anchor: lastAnchor, ncc: lastNcc, ...(debugIdx !== null && { comp: lastComp, views: lastViews }) },
      where: best.c.kind === 'outline' ? best.c.q : best.c.rect,
      debug,
      timing: { candidates: Math.round(t1 - t0), quick: Math.round(t2 - t1), fine: Math.round(performance.now() - t2) },
    };
  }

  // Testing aid (tools/sim.js): robust scores of `queries` against index cards `indices`.
  const score = (queries, indices, topN = 12, keep = MATCH_ROBUST_KEEP) => robustScores(queries, indices, topN, keep, MASK_PENALTY);
  return { count, match, score, forget: () => { memory = []; } };
}
