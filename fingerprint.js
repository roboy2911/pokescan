/* Card image fingerprints — shared by the app (scanning) and tools/build-index.html (indexing).
 * Both sides MUST compute fingerprints identically, so keep all of it in this file.
 *
 * A fingerprint is the card's colours averaged over an 8x11 grid (inside a small margin,
 * so the frame edge / background doesn't matter), each colour channel standardised
 * (removes brightness and white-balance differences), then scaled to unit length.
 * Two cards are compared with a dot product: 1 = identical, ~0 = unrelated.
 *
 * Photos can have glare: blown-out white reflections that hide the card. Photo fingerprints
 * (fpQuery) mark grid cells that are mostly glare; those cells are left out of the colour
 * standardisation and set to 0, and the vector gets a `w` array (1 = usable cell, 0 =
 * glare) so the matcher can compare only the usable cells. Index fingerprints never have
 * glare, so building the index is unaffected.
 */
const FP = {
  GW: 8,
  GH: 11,
  // Region of the card used (fractions): skips the outer edge of the card.
  X0: 0.05, X1: 0.95, Y0: 0.04, Y1: 0.96,
  get DIM() { return this.GW * this.GH * 3; },
};

/* Glare: a pixel this bright in every channel, and nearly colourless, is a reflection. */
const FP_GLARE_MIN = 225;
const FP_GLARE_SPREAD = 50;
// A cell this much glare is left out — or this much (FP_GLARE_HALO) if it's next to one:
// reflections fade out, and the faint edge still washes the colours out.
const FP_GLARE_CELL = 0.2;
const FP_GLARE_HALO = 0.02;
// Washed out: a pale, faded pixel — the edge of a reflection, or haze on a sleeve. Natural
// pale areas of a card look the same, so this is only tried as an extra variant.
const FP_WASH_MIN = 170;
const FP_WASH_SPREAD = 70;
const FP_WASH_CELL = 0.5;
// In dim light a reflection isn't bright in absolute terms, so also: a pale cell whose
// darkest channel is this far above the card's typical cell.
const FP_WASH_RELATIVE = 60;

/* Exact box average of RGBA pixel data `d` (W x H) over a gw x gh grid covering the
 * fractional rectangle x0..x1, y0..y1. Returns [r,g,b, r,g,b, ...] per cell.
 * With `glare` (length gw*gh), also stores the fraction of glare pixels in each cell. */
function fpBoxGrid(d, W, H, gw, gh, x0, y0, x1, y1, glare = null, wash = null) {
  const I = fpIntegrals.get(d);
  if (I) return fpBoxGridFast(I, gw, gh, x0, y0, x1, y1, glare, wash);
  const sum = new Float64Array(gw * gh * 3);
  const cnt = new Float64Array(gw * gh);
  const px0 = Math.floor(x0 * W), px1 = Math.floor(x1 * W);
  const py0 = Math.floor(y0 * H), py1 = Math.floor(y1 * H);
  const cw = px1 - px0, ch = py1 - py0;
  for (let y = py0; y < py1; y++) {
    const gy = Math.floor((y - py0) * gh / ch);
    for (let x = px0; x < px1; x++) {
      const gx = Math.floor((x - px0) * gw / cw);
      const c = gy * gw + gx;
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      sum[c * 3] += r;
      sum[c * 3 + 1] += g;
      sum[c * 3 + 2] += b;
      cnt[c]++;
      if (glare) {
        const lo = Math.min(r, g, b);
        const spread = Math.max(r, g, b) - lo;
        if (lo >= FP_GLARE_MIN && spread <= FP_GLARE_SPREAD) glare[c]++;
        if (wash && lo >= FP_WASH_MIN && spread <= FP_WASH_SPREAD) wash[c]++;
      }
    }
  }
  for (let c = 0; c < gw * gh; c++) {
    const n = cnt[c] || 1;
    sum[c * 3] /= n;
    sum[c * 3 + 1] /= n;
    sum[c * 3 + 2] /= n;
    if (glare) glare[c] /= n;
    if (wash) wash[c] /= n;
  }
  return sum;
}

/* Summed-area tables of an image, so any box can be averaged with 4 lookups. The scanner
 * takes dozens of slightly different crops of each candidate; call fpPrepare(d, W, H) once
 * and every fpBoxGrid on `d` gets fast (same results). */
const fpIntegrals = new WeakMap();

function fpPrepare(d, W, H) {
  if (fpIntegrals.has(d)) return;
  const S = W + 1;
  const n = S * (H + 1);
  const t = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const [tr, tg, tb, tgl, twa] = t;
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0, gl = 0, wa = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const lo = Math.min(R, G, B), spread = Math.max(R, G, B) - lo;
      r += R; g += G; b += B;
      if (lo >= FP_GLARE_MIN && spread <= FP_GLARE_SPREAD) gl++;
      if (lo >= FP_WASH_MIN && spread <= FP_WASH_SPREAD) wa++;
      const o = (y + 1) * S + x + 1, up = o - S;
      tr[o] = tr[up] + r; tg[o] = tg[up] + g; tb[o] = tb[up] + b;
      tgl[o] = tgl[up] + gl; twa[o] = twa[up] + wa;
    }
  }
  fpIntegrals.set(d, { W, H, S, t });
}

/* fpBoxGrid using fpPrepare's tables: the same pixel-exact cells, without the pixel loop. */
function fpBoxGridFast(I, gw, gh, x0, y0, x1, y1, glare, wash) {
  const { W, H, S, t: [tr, tg, tb, tgl, twa] } = I;
  const sum = new Float64Array(gw * gh * 3);
  const px0 = Math.floor(x0 * W), px1 = Math.floor(x1 * W);
  const py0 = Math.floor(y0 * H), py1 = Math.floor(y1 * H);
  const cw = px1 - px0, ch = py1 - py0;
  // Cell k spans pixels [start(k), start(k+1)) — matches floor((p - p0) * g / span) above.
  const xs = Array.from({ length: gw + 1 }, (_, k) => px0 + Math.ceil(k * cw / gw));
  const ys = Array.from({ length: gh + 1 }, (_, k) => py0 + Math.ceil(k * ch / gh));
  const box = (a, xa, ya, xb, yb) => a[yb * S + xb] - a[ya * S + xb] - a[yb * S + xa] + a[ya * S + xa];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const xa = xs[gx], xb = xs[gx + 1], ya = ys[gy], yb = ys[gy + 1];
      const n = (xb - xa) * (yb - ya) || 1;
      const c = gy * gw + gx;
      sum[c * 3] = box(tr, xa, ya, xb, yb) / n;
      sum[c * 3 + 1] = box(tg, xa, ya, xb, yb) / n;
      sum[c * 3 + 2] = box(tb, xa, ya, xb, yb) / n;
      if (glare) glare[c] = box(tgl, xa, ya, xb, yb) / n;
      if (wash) wash[c] = box(twa, xa, ya, xb, yb) / n;
    }
  }
  return sum;
}

/* Standardise each colour channel, then scale the whole vector to length 1.
 * With `w` (per cell, 1 = use, 0 = skip), only the used cells count and skipped cells
 * become 0; the result then carries `w`. */
function fpNormalise(g, w = null) {
  const n = g.length / 3;
  const used = w ? w.reduce((a, b) => a + b, 0) : n;
  const out = new Float32Array(g.length);
  for (let k = 0; k < 3; k++) {
    let mean = 0;
    for (let c = 0; c < n; c++) if (!w || w[c]) mean += g[c * 3 + k];
    mean /= used || 1;
    let v = 0;
    for (let c = 0; c < n; c++) if (!w || w[c]) v += (g[c * 3 + k] - mean) ** 2;
    const sd = Math.sqrt(v / (used || 1)) || 1;
    for (let c = 0; c < n; c++) out[c * 3 + k] = !w || w[c] ? (g[c * 3 + k] - mean) / sd : 0;
  }
  let len = 0;
  for (const x of out) len += x * x;
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= len;
  if (w) out.w = w;
  return out;
}

/* Photo fingerprints of the fractional rectangle x0..x1, y0..y1: one with glare cells
 * left out (see the top of this file) and, when part of the card looks washed out, a
 * second one leaving that out too. Too little left to go on → all cells are used. */
function fpQueries(d, W, H, x0, y0, x1, y1) {
  const cells = FP.GW * FP.GH;
  const glare = new Float64Array(cells);
  const wash = new Float64Array(cells);
  const g = fpBoxGrid(d, W, H, FP.GW, FP.GH, x0, y0, x1, y1, glare, wash);
  const w = new Uint8Array(cells).fill(1);
  for (let c = 0; c < cells; c++) {
    if (glare[c] <= FP_GLARE_CELL) continue;
    const cx = c % FP.GW, cy = (c - cx) / FP.GW;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= FP.GW || y >= FP.GH) continue;
        const n = y * FP.GW + x;
        if (n === c || glare[n] > FP_GLARE_HALO) w[n] = 0;
      }
    }
  }
  const usedOf = (m) => m.reduce((a, b) => a + b, 0);
  const enough = (m) => usedOf(m) >= cells * 0.4;
  const used = usedOf(w);
  const out = [used === cells || !enough(w) ? fpNormalise(g) : fpNormalise(g, w)];
  const floor = (c) => Math.min(g[c * 3], g[c * 3 + 1], g[c * 3 + 2]);
  const floors = Array.from({ length: cells }, (_, c) => floor(c)).sort((a, b) => a - b);
  const typical = floors[cells >> 1];
  const washed = (c) => wash[c] > FP_WASH_CELL
    || (floor(c) - typical > FP_WASH_RELATIVE && Math.max(g[c * 3], g[c * 3 + 1], g[c * 3 + 2]) - floor(c) <= FP_WASH_SPREAD);
  const w2 = w.map((v, c) => (v && !washed(c) ? 1 : 0));
  if (usedOf(w2) < used && enough(w2)) out.push(fpNormalise(g, w2));
  return out;
}

/* The main photo fingerprint only (see fpQueries). */
function fpQuery(d, W, H, x0, y0, x1, y1) {
  return fpQueries(d, W, H, x0, y0, x1, y1)[0];
}

/* How much light/dark variation an area has (std. dev. of brightness over the grid, 0–255).
 * Cards have lots; a plain table or binder page has little — and the fingerprint's
 * normalisation would otherwise blow that faint texture up into a random "match". */
function fpContrast(d, W, H, x0 = FP.X0, y0 = FP.Y0, x1 = FP.X1, y1 = FP.Y1) {
  const g = fpBoxGrid(d, W, H, FP.GW, FP.GH, x0, y0, x1, y1);
  const n = g.length / 3;
  let mean = 0, sq = 0;
  for (let c = 0; c < n; c++) {
    const v = 0.299 * g[c * 3] + 0.587 * g[c * 3 + 1] + 0.114 * g[c * 3 + 2];
    mean += v;
    sq += v * v;
  }
  mean /= n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/* Fingerprint of a whole, tightly-cropped card image (used for the index). */
function fpFromPixels(d, W, H) {
  return fpNormalise(fpBoxGrid(d, W, H, FP.GW, FP.GH, FP.X0, FP.Y0, FP.X1, FP.Y1));
}

/* Fingerprints of several slightly zoomed / shifted crops of a photo. The card in a
 * photo is never perfectly lined up, so the scanner keeps whichever crop matches best. */
function fpCrops(d, W, H, scales = [0.88, 0.95, 1.02], shifts = [-0.035, 0, 0.035]) {
  return fpCropsRect(d, W, H, { x0: 0, y0: 0, x1: W, y1: H }, scales, shifts);
}

/* Same, for a card expected inside rectangle `r` (pixels) of a larger image. */
function fpCropsRect(d, W, H, r, scales = [0.88, 0.95, 1.02], shifts = [-0.035, 0, 0.035]) {
  const out = [];
  const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
  for (const s of scales) {
    for (const dx of shifts) {
      for (const dy of shifts) {
        const x0 = (r.x0 + (0.5 + dx + (FP.X0 - 0.5) * s) * rw) / W;
        const x1 = (r.x0 + (0.5 + dx + (FP.X1 - 0.5) * s) * rw) / W;
        const y0 = (r.y0 + (0.5 + dy + (FP.Y0 - 0.5) * s) * rh) / H;
        const y1 = (r.y0 + (0.5 + dy + (FP.Y1 - 0.5) * s) * rh) / H;
        if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) continue;
        out.push(...fpQueries(d, W, H, x0, y0, x1, y1));
      }
    }
  }
  return out;
}

/* A coarser 4x5 version of a fingerprint (60 values instead of 264), used for a fast first
 * pass over the whole index. Works on index vectors and photo fingerprints alike. */
const FP_POOL_COLS = [[0, 1], [2, 3], [4, 5], [6, 7]];
const FP_POOL_ROWS = [[0, 1], [2, 3], [4, 5, 6], [7, 8], [9, 10]];
const FP_POOL_DIM = FP_POOL_COLS.length * FP_POOL_ROWS.length * 3;

function fpPool(v) {
  const out = new Float64Array(FP_POOL_DIM);
  const w = v.w ? new Uint8Array(FP_POOL_DIM / 3) : null;
  let o = 0;
  for (const rows of FP_POOL_ROWS) {
    for (const cols of FP_POOL_COLS) {
      // With glare, average the usable cells only; a block that's mostly glare is skipped.
      let n = 0;
      for (const r of rows) for (const c of cols) n += v.w ? v.w[r * FP.GW + c] : 1;
      if (w) w[o / 3] = n * 2 >= rows.length * cols.length ? 1 : 0;
      for (let ch = 0; ch < 3; ch++) {
        let s = 0;
        for (const r of rows) for (const c of cols) s += v[(r * FP.GW + c) * 3 + ch];
        out[o++] = s / (n || 1);
      }
    }
  }
  return fpNormalise(out, w && w.every((x) => x) ? null : w);
}

/* Index storage: one signed byte per value (vectors are re-normalised on load). */
function fpQuantise(v) {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / (max || 1)) * 127);
  return q;
}
