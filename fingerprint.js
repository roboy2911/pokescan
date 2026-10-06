/* Card image fingerprints — shared by the app (scanning) and tools/build-index.html (indexing).
 * Both sides MUST compute fingerprints identically, so keep all of it in this file.
 *
 * A fingerprint is the card's colours averaged over an 8x11 grid (inside a small margin,
 * so the frame edge / background doesn't matter), each colour channel standardised
 * (removes brightness and white-balance differences), then scaled to unit length.
 * Two cards are compared with a dot product: 1 = identical, ~0 = unrelated.
 */
const FP = {
  GW: 8,
  GH: 11,
  // Region of the card used (fractions): skips the outer edge of the card.
  X0: 0.05, X1: 0.95, Y0: 0.04, Y1: 0.96,
  get DIM() { return this.GW * this.GH * 3; },
};

/* Exact box average of RGBA pixel data `d` (W x H) over a gw x gh grid covering the
 * fractional rectangle x0..x1, y0..y1. Returns [r,g,b, r,g,b, ...] per cell. */
function fpBoxGrid(d, W, H, gw, gh, x0, y0, x1, y1) {
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
      sum[c * 3] += d[i];
      sum[c * 3 + 1] += d[i + 1];
      sum[c * 3 + 2] += d[i + 2];
      cnt[c]++;
    }
  }
  for (let c = 0; c < gw * gh; c++) {
    const n = cnt[c] || 1;
    sum[c * 3] /= n;
    sum[c * 3 + 1] /= n;
    sum[c * 3 + 2] /= n;
  }
  return sum;
}

/* Standardise each colour channel, then scale the whole vector to length 1. */
function fpNormalise(g) {
  const n = g.length / 3;
  const out = new Float32Array(g.length);
  for (let k = 0; k < 3; k++) {
    let mean = 0;
    for (let c = 0; c < n; c++) mean += g[c * 3 + k];
    mean /= n;
    let v = 0;
    for (let c = 0; c < n; c++) v += (g[c * 3 + k] - mean) ** 2;
    const sd = Math.sqrt(v / n) || 1;
    for (let c = 0; c < n; c++) out[c * 3 + k] = (g[c * 3 + k] - mean) / sd;
  }
  let len = 0;
  for (const x of out) len += x * x;
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= len;
  return out;
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
        out.push(fpNormalise(fpBoxGrid(d, W, H, FP.GW, FP.GH, x0, y0, x1, y1)));
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
  let o = 0;
  for (const rows of FP_POOL_ROWS) {
    for (const cols of FP_POOL_COLS) {
      for (let ch = 0; ch < 3; ch++) {
        let s = 0;
        for (const r of rows) for (const c of cols) s += v[(r * FP.GW + c) * 3 + ch];
        out[o++] = s / (rows.length * cols.length);
      }
    }
  }
  return fpNormalise(out);
}

/* Index storage: one signed byte per value (vectors are re-normalised on load). */
function fpQuantise(v) {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / (max || 1)) * 127);
  return q;
}
