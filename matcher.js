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
      let top = -Infinity;
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
        if (score > top) top = score;
      }
      out.push({ i: c, score: top });
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
    { fineTop = 8, shortlistSize = 800, perCandidate = 300, preTop = 40, centreWeight = 0.06, windowPenalty = 0.03, keep = MATCH_ROBUST_KEEP, maskPenalty = MASK_PENALTY, drop = 0, debugIdx = null, step = SEARCH_STEP, maxOutlines = 16, tl = TOPLOADER, plain = PLAIN } = {}) {
    const t0 = performance.now();
    const cands = regions.flatMap((r) => candidates(r, { step, maxOutlines, tl, plain }).map((c) => ({ ...c, region: r })));
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
    const chosen = [...new Set([...order.slice(0, fineTop), ...(centre >= 0 ? [centre] : [])])];

    // Testing aid (tools/sim.js): how the correct card fares at each candidate position.
    const debug = debugIdx === null ? null : {
      inShortlist: shortlist.includes(debugIdx),
      coarseRank: Array.from(cardBest.keys()).filter((c) => cardBest[c] > cardBest[debugIdx]).length,
      cands: [],
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
      const score = ranked[0].score - c.penalty;
      if (!best || score > best.score) best = { score, ranked, c };
      debug?.cands.push({
        kind: c.kind === 'outline' ? 'outline' : `win${c.rect.s}`,
        dist: +c.dist.toFixed(2),
        top: +ranked[0].score.toFixed(3),
        target: +robustScores(fine, [debugIdx], 1, keep, maskPenalty)[0].score.toFixed(3),
      });
    }
    if (!best) return { matches: [], where: null };
    return {
      matches: best.ranked,
      where: best.c.kind === 'outline' ? best.c.q : best.c.rect,
      debug,
      timing: { candidates: Math.round(t1 - t0), quick: Math.round(t2 - t1), fine: Math.round(performance.now() - t2) },
    };
  }

  return { count, match };
}
