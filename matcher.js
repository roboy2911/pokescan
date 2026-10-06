/* Card matching: find the card anywhere in a camera frame and identify it against the index.
 * Needs fingerprint.js and detect.js. Runs inside worker.js; tools/sim.js also loads it
 * on a page for accuracy tests.
 *
 * 1. Candidate positions: search windows (card-shaped boxes) at several sizes — from
 *    filling the guide down to ~40% of it — and positions, so far-away / off-centre cards
 *    are covered. Edge detection runs in each window to find real card outlines.
 * 2. Quick pass: a coarse 60-value fingerprint of the best candidates against all ~20k
 *    cards → shortlist of 300 cards, and the few candidates that look most like *some* card
 *    (= where the card actually is).
 * 3. Fine pass: many slightly shifted crops of those few candidates, full fingerprints,
 *    glare-tolerant scoring, against the shortlist only.
 */

/* Sizes (fraction of the guide) and position spacing (fraction of window size). */
const SEARCH_SCALES = [1, 0.8, 0.64, 0.51, 0.41];
const SEARCH_STEP = 0.3;
// Size cards are cut out at (plenty for an 8x11 fingerprint).
const WARP_W = 168, WARP_H = 235;
// Areas with less brightness variation than this (0–255) are blank, not cards.
const MIN_CONTRAST = 6;
const MATCH_ROBUST_KEEP = 0.85;

function createMatcher(indexBuffer) {
  const dim = FP.DIM;
  const vectors = new Int8Array(indexBuffer);
  const count = vectors.length / dim;
  const norms = new Float32Array(count);
  const pooled = new Float32Array(count * FP_POOL_DIM);
  for (let c = 0; c < count; c++) {
    const v = vectors.subarray(c * dim, (c + 1) * dim);
    let s = 0;
    for (let k = 0; k < dim; k++) s += v[k] * v[k];
    norms[c] = Math.sqrt(s) || 1;
    pooled.set(fpPool(v), c * FP_POOL_DIM);
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
  function candidates(region, { step = SEARCH_STEP, maxOutlines = 16 } = {}) {
    const { data, w, h } = region;
    const gray = detGray(data, w, h);
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
      if (fpContrast(warped, WARP_W, WARP_H) < MIN_CONTRAST) continue; // blank area, not a card
      // As found, and zoomed in a little in case the outline is a sleeve / binder pocket.
      cands.push({
        kind: 'outline', q, warped,
        coarse: [fpFromPixels(warped, WARP_W, WARP_H), fpCrops(warped, WARP_W, WARP_H, [0.91], [0])[0]],
      });
    }
    // Plain windows too (centred, every size), in case no outline is found.
    for (const win of searchWindows(region).filter((v) => Math.abs((v.x0 + v.x1) / 2 - (region.guide.x0 + region.guide.x1) / 2) < 1
      && Math.abs((v.y0 + v.y1) / 2 - (region.guide.y0 + region.guide.y1) / 2) < 1)) {
      const rw = win.x1 - win.x0, rh = win.y1 - win.y0;
      const contrast = fpContrast(data, w, h,
        (win.x0 + FP.X0 * rw) / w, (win.y0 + FP.Y0 * rh) / h, (win.x0 + FP.X1 * rw) / w, (win.y0 + FP.Y1 * rh) / h);
      if (win.s < 1 && contrast < MIN_CONTRAST) continue; // the full-size box is always kept
      cands.push({ kind: 'window', rect: win, coarse: fpCropsRect(data, w, h, win, [0.95], [0]) });
    }
    return cands;
  }

  /* Score pooled index vectors against pooled queries. Returns per-card best score and,
   * per query, its best score (how much that position looks like some card).
   * Glare-tolerant like the fine pass: the `drop` worst-matching of the 20 cells are
   * ignored, so a reflection streak can't knock the right card out of the shortlist. */
  function quickPass(queries, drop = 0) {
    const pq = queries.map((q) => fpPool(q));
    const cardBest = new Float32Array(count).fill(-Infinity);
    const queryBest = new Float32Array(pq.length).fill(-Infinity);
    if (!drop) {
      // Plain dot product — fastest.
      for (let c = 0; c < count; c++) {
        const base = c * FP_POOL_DIM;
        for (let qi = 0; qi < pq.length; qi++) {
          const q = pq[qi];
          let s = 0;
          for (let k = 0; k < FP_POOL_DIM; k++) s += q[k] * pooled[base + k];
          if (s > cardBest[c]) cardBest[c] = s;
          if (s > queryBest[qi]) queryBest[qi] = s;
        }
      }
      return { cardBest, queryBest };
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
      }
    }
    return { cardBest, queryBest };
  }

  /* Glare-tolerant score: ignores the grid cells that disagree most. 1 = identical. */
  function robustScores(queries, indices, topN, keepFrac = MATCH_ROBUST_KEEP) {
    const cells = dim / 3;
    const keep = Math.round(cells * keepFrac);
    const drop = cells - keep;
    const worst = new Float64Array(drop); // largest errors so far, descending
    const out = [];
    for (const c of indices) {
      const base = c * dim;
      const inv = 1 / norms[c];
      let top = -Infinity;
      for (const q of queries) {
        let sum = 0;
        worst.fill(0);
        for (let cell = 0, k = 0; cell < cells; cell++, k += 3) {
          const d0 = q[k] - vectors[base + k] * inv;
          const d1 = q[k + 1] - vectors[base + k + 1] * inv;
          const d2 = q[k + 2] - vectors[base + k + 2] * inv;
          const e = d0 * d0 + d1 * d1 + d2 * d2;
          sum += e;
          if (drop && e > worst[drop - 1]) {
            let j = drop - 1;
            while (j > 0 && worst[j - 1] < e) { worst[j] = worst[j - 1]; j--; }
            worst[j] = e;
          }
        }
        for (let j = 0; j < drop; j++) sum -= worst[j];
        const score = 1 - (sum * cells / keep) / 2;
        if (score > top) top = score;
      }
      out.push({ i: c, score: top });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
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
    { fineTop = 8, shortlistSize = 300, centreWeight = 0.06, windowPenalty = 0.03, keep = MATCH_ROBUST_KEEP, drop = 0, debugIdx = null, step = SEARCH_STEP, maxOutlines = 16 } = {}) {
    const t0 = performance.now();
    const cands = regions.flatMap((r) => candidates(r, { step, maxOutlines }).map((c) => ({ ...c, region: r })));
    if (!cands.length) return { matches: [], where: null };
    const t1 = performance.now();
    // Each candidate has one or more quick-pass fingerprints.
    const queries = [];
    const owner = [];
    cands.forEach((c, ci) => c.coarse.forEach((q) => { queries.push(q); owner.push(ci); }));
    const { cardBest, queryBest } = quickPass(queries, drop);
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
      // zooming in a little.
      const fine = c.kind === 'outline'
        ? fpCrops(c.warped, WARP_W, WARP_H, [0.91, 0.96, 1], [-0.015, 0, 0.015])
        : fpCropsRect(c.region.data, c.region.w, c.region.h, c.rect);
      const ranked = robustScores(fine, shortlist, topN, keep);
      const score = ranked[0].score - c.penalty;
      if (!best || score > best.score) best = { score, ranked, c };
      debug?.cands.push({
        kind: c.kind === 'outline' ? 'outline' : `win${c.rect.s}`,
        dist: +c.dist.toFixed(2),
        top: +ranked[0].score.toFixed(3),
        target: +robustScores(fine, [debugIdx], 1, keep)[0].score.toFixed(3),
      });
    }
    return {
      matches: best.ranked,
      where: best.c.kind === 'outline' ? best.c.q : best.c.rect,
      debug,
      timing: { candidates: Math.round(t1 - t0), quick: Math.round(t2 - t1), fine: Math.round(performance.now() - t2) },
    };
  }

  return { count, match };
}
