/* Card outline detection + perspective correction.
 *
 * Given a photo region that contains the card (roughly where the on-screen guide says),
 * find the card's four edges, then "un-tilt" it into a flat, tightly cropped card image.
 * This removes the framing / angle errors that hurt matching most.
 *
 * Method: blur → brightness gradients → for each side of the expected card, collect the
 * strongest edge points near where that side should be → fit straight lines to them
 * (RANSAC, preferring the outermost well-supported line so the art box border isn't
 * mistaken for the card edge) → intersect the lines for the corners → perspective warp.
 */

/* Greyscale + 3x3 blur of RGBA data. */
function detGray(d, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const b = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * w + x + dx];
      b[y * w + x] = s / 9;
    }
  }
  return b;
}

/* Edge points for one side. `horizontal` sides (top/bottom) scan columns for |d/dy|. */
function detSidePoints(g, w, h, horizontal, lo, hi, along0, along1) {
  const pts = [];
  const n = 60;
  for (let k = 0; k < n; k++) {
    const a = Math.round(along0 + (along1 - along0) * (k + 0.5) / n);
    const peaks = [];
    for (let t = Math.max(2, lo); t <= Math.min((horizontal ? h : w) - 3, hi); t++) {
      const v = horizontal
        ? Math.abs(g[(t + 1) * w + a] - g[(t - 1) * w + a])
        : Math.abs(g[a * w + t + 1] - g[a * w + t - 1]);
      peaks.push([t, v]);
    }
    // Local maxima, strongest 3.
    const maxima = peaks.filter((p, i) => p[1] > 6 && p[1] >= (peaks[i - 1]?.[1] ?? 0) && p[1] >= (peaks[i + 1]?.[1] ?? 0));
    maxima.sort((p, q) => q[1] - p[1]);
    for (const [t, v] of maxima.slice(0, 3)) pts.push({ a, t, v });
  }
  return pts;
}

/* Least-squares refit of t = m*a + c over the points within `tol` of a line. */
function detRefit(pts, m, c, tol) {
  const inl = pts.filter((r) => Math.abs(r.t - (m * r.a + c)) <= tol);
  const n = inl.length;
  let sa = 0, st = 0, saa = 0, sat = 0;
  for (const r of inl) { sa += r.a; st += r.t; saa += r.a * r.a; sat += r.a * r.t; }
  const den = n * saa - sa * sa;
  if (n < 5 || Math.abs(den) < 1e-6) return { m, c };
  const m2 = (n * sat - sa * st) / den;
  return { m: m2, c: (st - m2 * sa) / n };
}

/* Candidate straight lines t = m*a + c through the edge points (RANSAC), strongest first.
 * Several are kept because the card edge isn't always the strongest line (art-box borders,
 * other cards, table edges); the caller decides using the card's shape. */
function detCandidateLines(pts, span, maxLines = 4) {
  if (pts.length < 10) return [];
  const tol = 1.5;
  const lines = [];
  for (let it = 0; it < 400; it++) {
    const p = pts[Math.floor(Math.random() * pts.length)];
    const q = pts[Math.floor(Math.random() * pts.length)];
    if (p.a === q.a) continue;
    const m = (q.t - p.t) / (q.a - p.a);
    if (Math.abs(m) > 0.2) continue; // card sides are near-axis-aligned in the guide
    const c = p.t - m * p.a;
    const cols = new Set();
    for (const r of pts) if (Math.abs(r.t - (m * r.a + c)) <= tol) cols.add(r.a);
    if (cols.size >= 15) lines.push({ m, c, support: cols.size });
  }
  lines.sort((l1, l2) => l2.support - l1.support);
  const mid = span / 2;
  const out = [];
  for (const l of lines) {
    const at = l.m * mid + l.c;
    if (out.some((o) => Math.abs(o.m * mid + o.c - at) < 4)) continue; // same line
    out.push({ ...detRefit(pts, l.m, l.c, tol), support: l.support });
    if (out.length >= maxLines) break;
  }
  return out;
}

/* Find likely card outlines inside an RGBA image (w x h). `guide` = expected card rect
 * {x0,y0,x1,y1} in the same pixels. Returns up to `maxQuads` corner lists
 * [TL, TR, BR, BL], most plausible first (may be empty). Pass `gray` (from detGray) to
 * reuse it when searching many windows of the same image. */
function detectCardQuads(d, w, h, guide, maxQuads = 8, areaWeight = 0, gray = null) {
  return detectCardQuadsScored(d, w, h, guide, maxQuads, areaWeight, gray).map((x) => x.q);
}

/* Same, but returns { q, score } so outlines from different windows can be compared. */
function detectCardQuadsScored(d, w, h, guide, maxQuads = 8, areaWeight = 0, gray = null) {
  const g = gray || detGray(d, w, h);
  const gw = guide.x1 - guide.x0, gh = guide.y1 - guide.y0;
  const bandY = 0.16 * gh, bandX = 0.16 * gw;
  const ax0 = guide.x0 + 0.15 * gw, ax1 = guide.x1 - 0.15 * gw;
  const ay0 = guide.y0 + 0.15 * gh, ay1 = guide.y1 - 0.15 * gh;
  const R = Math.round;

  const tops = detCandidateLines(detSidePoints(g, w, h, true, R(guide.y0 - bandY), R(guide.y0 + bandY), ax0, ax1), w);
  const bottoms = detCandidateLines(detSidePoints(g, w, h, true, R(guide.y1 - bandY), R(guide.y1 + bandY), ax0, ax1), w);
  const lefts = detCandidateLines(detSidePoints(g, w, h, false, R(guide.x0 - bandX), R(guide.x0 + bandX), ay0, ay1), h);
  const rights = detCandidateLines(detSidePoints(g, w, h, false, R(guide.x1 - bandX), R(guide.x1 + bandX), ay0, ay1), h);

  // top/bottom: y = m*x + c; left/right: x = m*y + c.
  const cross = (hz, vt) => {
    const x = (vt.m * hz.c + vt.c) / (1 - vt.m * hz.m);
    return { x, y: hz.m * x + hz.c };
  };
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const quads = [];
  for (const t of tops) for (const b of bottoms) for (const l of lefts) for (const r of rights) {
    const q = [cross(t, l), cross(t, r), cross(b, r), cross(b, l)];
    const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]);
    const hL = dist(q[0], q[3]), hR = dist(q[1], q[2]);
    const aspect = ((wTop + wBot) / 2) / ((hL + hR) / 2);
    const aspectErr = Math.abs(aspect / (63 / 88) - 1);
    if (aspectErr > 0.1) continue;
    if (Math.min(wTop, wBot) / Math.max(wTop, wBot) < 0.85 || Math.min(hL, hR) / Math.max(hL, hR) < 0.85) continue;
    const area = ((wTop + wBot) / 2) * ((hL + hR) / 2);
    if (area < 0.55 * gw * gh || area > 1.5 * gw * gh) continue;
    // Strong, card-shaped, opposite sides roughly parallel — and bigger is better, because
    // the inner edge of the card's border also makes a perfect (slightly smaller) card shape.
    const skew = Math.abs(t.m - b.m) + Math.abs(l.m - r.m);
    const support = t.support + b.support + l.support + r.support;
    quads.push({ q, score: support / 240 - 4 * aspectErr - 2 * skew + areaWeight * area / (gw * gh) });
  }
  quads.sort((a, b) => b.score - a.score);
  return quads.slice(0, maxQuads);
}

/* Perspective-warp the quad [TL, TR, BR, BL] from RGBA data into an outW x outH card. */
function warpQuad(d, w, h, quad, outW, outH) {
  const [p0, p1, p2, p3] = quad; // TL, TR, BR, BL
  // Square -> quad homography (Heckbert).
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let a, b, c, dd, e, f, gg, hh;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x;
    dd = p1.y - p0.y; e = p3.y - p0.y; f = p0.y;
    gg = 0; hh = 0;
  } else {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    gg = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
    a = p1.x - p0.x + gg * p1.x; b = p3.x - p0.x + hh * p3.x; c = p0.x;
    dd = p1.y - p0.y + gg * p1.y; e = p3.y - p0.y + hh * p3.y; f = p0.y;
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let j = 0; j < outH; j++) {
    const v = (j + 0.5) / outH;
    for (let i = 0; i < outW; i++) {
      const u = (i + 0.5) / outW;
      const z = gg * u + hh * v + 1;
      const x = (a * u + b * v + c) / z - 0.5;
      const y = (dd * u + e * v + f) / z - 0.5;
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
      const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
      const o = (j * outW + i) * 4;
      for (let k = 0; k < 3; k++) {
        const i00 = (y0 * w + x0) * 4 + k;
        const top = d[i00] * (1 - fx) + d[i00 + 4] * fx;
        const bot = d[i00 + w * 4] * (1 - fx) + d[i00 + w * 4 + 4] * fx;
        out[o + k] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
