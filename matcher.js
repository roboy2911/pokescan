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
  function searchWindows(region) {
    const { w, h, guide } = region;
    const gw = guide.x1 - guide.x0, gh = guide.y1 - guide.y0;
    const cx = (guide.x0 + guide.x1) / 2, cy = (guide.y0 + guide.y1) / 2;
    const wins = [];
    for (const s of SEARCH_SCALES) {
      const ww = gw * s, hh = gh * s;
      // How far the window centre can move and stay inside the image.
      const maxX = Math.max(0, Math.min(cx - ww / 2, w - cx - ww / 2));
      const maxY = Math.max(0, Math.min(cy - hh / 2, h - cy - hh / 2));
      const stepX = ww * SEARCH_STEP, stepY = hh * SEARCH_STEP;
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
  function candidates(region) {
    const { data, w, h } = region;
    const gray = detGray(data, w, h);
    const outlines = [];
    for (const win of searchWindows(region)) {
      for (const { q, score } of detectCardQuadsScored(data, w, h, win, 2, 0, gray)) {
        // Skip outlines we already found from a neighbouring window.
        const dup = outlines.some((o) => o.q.every((p, k) => Math.hypot(p.x - q[k].x, p.y - q[k].y) < 0.03 * (win.x1 - win.x0)));
        if (!dup) outlines.push({ q, score });
      }
    }
    outlines.sort((a, b) => b.score - a.score);
    const cands = outlines.slice(0, 16).map(({ q }) => {
      const warped = warpQuad(data, w, h, q, 252, 352);
      return { kind: 'outline', q, warped, coarse: fpFromPixels(warped, 252, 352) };
    });
    // Plain windows too (centred, every size), in case no outline is found.
    for (const win of searchWindows(region).filter((v) => Math.abs((v.x0 + v.x1) / 2 - (region.guide.x0 + region.guide.x1) / 2) < 1
      && Math.abs((v.y0 + v.y1) / 2 - (region.guide.y0 + region.guide.y1) / 2) < 1)) {
      cands.push({ kind: 'window', rect: win, coarse: fpCropsRect(data, w, h, win, [0.95], [0])[0] });
    }
    return cands;
  }

  /* Score pooled index vectors against pooled queries. Returns per-card best score and,
   * per query, its best score (how much that position looks like some card). */
  function quickPass(queries) {
    const pq = queries.map((q) => fpPool(q));
    const cardBest = new Float32Array(count).fill(-Infinity);
    const queryBest = new Float32Array(pq.length).fill(-Infinity);
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

  /* Glare-tolerant score: ignores the grid cells that disagree most. 1 = identical. */
  function robustScores(queries, indices, topN) {
    const cells = dim / 3;
    const keep = Math.round(cells * MATCH_ROBUST_KEEP);
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
        const score = 1 - (sum * cells / keep) / 2;
        if (score > top) top = score;
      }
      out.push({ i: c, score: top });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
  }

  /* Identify the card in one or more frames. Each region: { data, w, h, guide }. */
  function match(regions, topN = 12, { fineTop = 6, shortlistSize = 300 } = {}) {
    const cands = regions.flatMap((r) => candidates(r).map((c) => ({ ...c, region: r })));
    if (!cands.length) return { matches: [], where: null };
    const { cardBest, queryBest } = quickPass(cands.map((c) => c.coarse));

    const shortlist = Array.from(cardBest.keys()).sort((a, b) => cardBest[b] - cardBest[a]).slice(0, shortlistSize);
    const order = Array.from(queryBest.keys()).sort((a, b) => queryBest[b] - queryBest[a]);
    const fine = [];
    // The centred full-size window (a card filling the guide) is always checked closely too.
    const centre = cands.findIndex((c) => c.kind === 'window' && c.rect.s === 1);
    const chosen = [...new Set([...order.slice(0, fineTop), ...(centre >= 0 ? [centre] : [])])];
    for (const qi of chosen) {
      const c = cands[qi];
      if (c.kind === 'outline') fine.push(...fpCrops(c.warped, 252, 352, [0.97, 1, 1.03], [-0.015, 0, 0.015]));
      else fine.push(...fpCropsRect(c.region.data, c.region.w, c.region.h, c.rect));
    }
    const best = cands[order[0]];
    return {
      matches: robustScores(fine, shortlist, topN),
      where: best.kind === 'outline' ? best.q : best.rect,
    };
  }

  return { count, match };
}
