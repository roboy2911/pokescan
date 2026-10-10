/* Card grader — the measuring part (no UI; grade.js runs it). Free, on the phone.
 *
 * Photos: front, back (straight on), and up to two front shots tilted so a lamp reflects off
 * the surface (scratches show in reflected light). Each photo is:
 *   1. outlined: the card found roughly (detect.js, small copy), then each edge refined at
 *      full resolution (strongest colour edge across many points, straight-line fit, so the
 *      corners are where the edges meet — rounded corners don't throw it);
 *   2. flattened to GR.W × GR.H (15 px per mm of a 63 × 88 mm card).
 * Then:
 *   - centering: on each side, the border width from the cut edge to where the print's frame
 *     starts (the depth most scan lines agree on — text on a border is ignored) → "55/45";
 *   - edges: whitening = border pixels within 0.8 mm of the edge that are much paler / greyer
 *     than that border's own colour (reflections that also cover the inner border are skipped);
 *   - corners: the same in a band along each 3 mm rounded corner, plus missing card (the
 *     background showing where the corner should be — a soft or chipped corner);
 *   - surface: the straight front compared with the card's official image (lined up, colours
 *     matched): compact spots that differ (dents, ink, stains, print marks); the tilted shots:
 *     thin straight lines in the reflection that the official image doesn't have (scratches);
 *   - an estimated PSA grade from PSA's published centering limits and wear caps, and a
 *     raw-card condition (NM / LP / MP / HP / DMG).
 * Everything is an estimate: a phone photo can't see what a grader's lamp and loupe can. */

const GR = (() => {
  const MM = 15;                 // px per mm in the flattened card
  const W = 63 * MM, H = 88 * MM; // 945 × 1320
  const RADIUS = 3.0 * MM;       // corner radius (measured on official images: 2.8–3.1 mm)

  /* ---------- small image helpers ({ d: RGBA, w, h }) ---------- */

  const px = (img, x, y, k) => img.d[(y * img.w + x) * 4 + k];
  function sample(img, x, y) { // bilinear RGB
    const x0 = Math.max(0, Math.min(img.w - 2, Math.floor(x))), y0 = Math.max(0, Math.min(img.h - 2, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = (y0 * img.w + x0) * 4 + k;
      out[k] = (img.d[i] * (1 - fx) + img.d[i + 4] * fx) * (1 - fy) + (img.d[i + img.w * 4] * (1 - fx) + img.d[i + img.w * 4 + 4] * fx) * fy;
    }
    return out;
  }
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hsv = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return { v: mx, s: mx ? (mx - mn) / mx : 0 };
  };
  const median = (a) => {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const quantile = (a, q) => {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  };
  const medianColour = (cols) => [0, 1, 2].map((k) => median(cols.map((c) => c[k])));

  /* Downscaled copy (box filter) — for the rough outline and for surface work. */
  function resize(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    const sx = img.w / w, sy = img.h / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.w + xx) * 4;
          r += img.d[i]; g += img.d[i + 1]; b += img.d[i + 2]; n++;
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return { d: out, w, h };
  }

  /* ---------- 1. Outline ---------- */

  /* Rough outline on a ~480 px copy. Grading photos are taken on a plain background, so first
   * the card is told apart from the background by colour (the background's colour from the
   * photo's outer edge), and a straight line fitted to each side of that shape. On a busy
   * background, the scanner's outline finder (detect.js) instead. Returns full-res points. */
  function roughQuad(img, guide = null) {
    const small = resize(img, 480, Math.round(480 * img.h / img.w));
    const k = img.w / small.w;
    const seg = segmentQuad(small);
    if (seg) return { q: seg.q.map((p) => ({ x: p.x * k, y: p.y * k })), bg: seg.bg, spread: seg.spread, how: 'table' };
    const q = detectQuad(small, k, guide);
    return q && { q, bg: null, how: 'detect' };
  }

  function segmentQuad(img) {
    const { w, h } = img;
    const at = (x, y) => [px(img, x, y, 0), px(img, x, y, 1), px(img, x, y, 2)];
    const ring = [];
    const m = Math.max(3, Math.round(w * 0.025));
    for (let x = 0; x < w; x += 2) for (const y of [1, m, h - 2, h - 1 - m]) ring.push(at(x, y));
    for (let y = 0; y < h; y += 2) for (const x of [1, m, w - 2, w - 1 - m]) ring.push(at(x, y));
    const bg = medianColour(ring);
    const spread = quantile(ring.map((c) => dist3(c, bg)), 0.9);
    if (spread > 55) return null; // not a plain background
    // Threshold: Otsu's split of the colour distances from the background (card vs table),
    // never below the table's own variation — adapts to low-contrast tables.
    const D = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) D[y * w + x] = dist3(at(x, y), bg);
    const hist = new Float64Array(256);
    for (let i = 0; i < D.length; i++) hist[Math.min(255, D[i] | 0)]++;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let wB = 0, sB = 0, bestT = 30, bestV = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB || wB === D.length) continue;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / (D.length - wB);
      const v = wB * (D.length - wB) * (mB - mF) ** 2;
      if (v > bestV) { bestV = v; bestT = t; }
    }
    const thr = Math.max(spread * 1.6, 12, Math.min(bestT, 40));
    const fg = new Uint8Array(w * h);
    for (let i = 0; i < D.length; i++) fg[i] = D[i] > thr ? 1 : 0;
    // Clean-up: a pixel counts if most of its 3x3 does (specks / thin gaps).
    const clean = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += fg[(y + dy) * w + x + dx];
      clean[y * w + x] = n >= 5 ? 1 : 0;
    }
    // The card: the biggest blob, reached from the middle.
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    const seen = new Uint8Array(w * h);
    let start = -1;
    for (let r = 0; r < Math.min(w, h) / 3 && start < 0; r += 2) {
      for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const i = Math.round(h / 2 + dy) * w + Math.round(w / 2 + dx);
        if (clean[i]) { start = i; break; }
      }
    }
    if (start < 0) return null;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop();
      const x = q % w, y = (q / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const r of [q - 1, q + 1, q - w, q + w]) if (r >= 0 && r < w * h && !seen[r] && clean[r]) { seen[r] = 1; stack.push(r); }
    }
    // Fill holes: a card is solid, so use the blob's outer boundary only (first/last per row/col).
    if (area < 0.03 * w * h || x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2) return null;
    const pts = { top: [], bottom: [], left: [], right: [] };
    const bw = x1 - x0, bh = y1 - y0;
    for (let x = Math.round(x0 + bw * 0.12); x <= x1 - bw * 0.12; x++) {
      let a = -1, b = -1;
      for (let y = y0; y <= y1; y++) if (seen[y * w + x]) { a = y; break; }
      for (let y = y1; y >= y0; y--) if (seen[y * w + x]) { b = y; break; }
      if (a >= 0) { pts.top.push({ x, y: a }); pts.bottom.push({ x, y: b + 1 }); }
    }
    for (let y = Math.round(y0 + bh * 0.12); y <= y1 - bh * 0.12; y++) {
      let a = -1, b = -1;
      for (let x = x0; x <= x1; x++) if (seen[y * w + x]) { a = x; break; }
      for (let x = x1; x >= x0; x--) if (seen[y * w + x]) { b = x; break; }
      if (a >= 0) { pts.left.push({ x: a, y }); pts.right.push({ x: b + 1, y }); }
    }
    const L = {};
    for (const side of Object.keys(pts)) {
      if (pts[side].length < 20) return null;
      L[side] = fitLine(pts[side]);
    }
    const q = [crossLines(L.top, L.left), crossLines(L.top, L.right), crossLines(L.bottom, L.right), crossLines(L.bottom, L.left)];
    if (q.some((p) => !p)) return null;
    const wTop = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), hL = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
    // Lying sideways: start the corners one later so the card's top is its short side.
    if (Math.abs((hL / wTop) / (63 / 88) - 1) <= 0.15) return { q: [q[3], q[0], q[1], q[2]], bg, spread, sideways: true };
    if (Math.abs((wTop / hL) / (63 / 88) - 1) > 0.15) return null; // not card-shaped (two cards, a hand…)
    return { q, bg, spread };
  }

  /* How unlike the table a colour is, shadow-proof: a shadow is the table, darker, same
   * colour — so being darker counts for little; a different colour or brighter counts fully. */
  function tableDist(c, bg) {
    const sc = c[0] + c[1] + c[2] + 1, sb = bg[0] + bg[1] + bg[2] + 1;
    const chroma = Math.hypot(c[0] / sc - bg[0] / sb, c[1] / sc - bg[1] / sb, c[2] / sc - bg[2] / sb) * 255 * 3;
    const dv = (sc - sb) / 3;
    return Math.hypot(chroma, dv > 0 ? dv : dv * 0.3);
  }

  function crossLines(l1, l2) {
    const d = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(d) < 1e-9) return null;
    const t = ((l2.x - l1.x) * l2.dy - (l2.y - l1.y) * l2.dx) / d;
    return { x: l1.x + l1.dx * t, y: l1.y + l1.dy * t };
  }

  function detectQuad(small, k, guide) {
    const ratio = 63 / 88;
    let gw = small.w, gh = small.h;
    if (gw / gh > ratio) gw = gh * ratio; else gh = gw / ratio;
    const g0 = guide
      ? { x0: guide.x0 * small.w, y0: guide.y0 * small.h, x1: guide.x1 * small.w, y1: guide.y1 * small.h }
      : { x0: (small.w - gw * 0.85) / 2, y0: (small.h - gh * 0.85) / 2, x1: (small.w + gw * 0.85) / 2, y1: (small.h + gh * 0.85) / 2 };
    const cx = (g0.x0 + g0.x1) / 2, cy = (g0.y0 + g0.y1) / 2, bw = g0.x1 - g0.x0, bh = g0.y1 - g0.y0;
    const gray = detGray(small.d, small.w, small.h);
    let best = null;
    for (const s of [1, 0.88, 0.76, 0.64, 1.1]) {
      const win = { x0: cx - bw * s / 2, y0: cy - bh * s / 2, x1: cx + bw * s / 2, y1: cy + bh * s / 2 };
      // Bigger is better (areaWeight): a card's inner border is a smaller perfect card shape too.
      for (const { q, score } of detectCardQuadsScored(small.d, small.w, small.h, win, 3, 0.6, gray)) {
        if (!best || score > best.score) best = { q, score };
      }
    }
    return best ? best.q.map((p) => ({ x: p.x * k, y: p.y * k })) : null;
  }

  /* Refine each side at full resolution: the strongest colour edge across the side at 40
   * points (12–88% along it, away from the rounded corners), then a straight-line fit
   * (dropping the worst points twice). Returns the new corners, or the rough ones. */
  function refineQuad(img, q, bg = null) {
    const sides = [[0, 1], [1, 2], [2, 3], [3, 0]]; // top, right, bottom, left
    const centre = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
    const cardW = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
    const reach = Math.max(6, cardW * (bg ? 0.08 : 0.022)), step = 0.5;
    const lines = [];
    let support = 0;
    for (const [a, b] of sides) {
      const A = q[a], B = q[b];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
      let nx = -uy, ny = ux; // outward normal
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) { nx = -nx; ny = -ny; }
      const pts = [];
      for (let i = 0; i < 40; i++) {
        const t = 0.12 + 0.76 * (i + 0.5) / 40;
        const P = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
        const prof = [];
        for (let s = -reach; s <= reach; s += step) prof.push(sample(img, P.x + nx * s, P.y + ny * s));
        // Colour gradient over 2 px, smoothed.
        let bestI = -1, bestG = 0;
        const g = [];
        for (let j = 2; j < prof.length - 2; j++) g.push(dist3(prof[j - 2], prof[j + 2]));
        const sm = g.map((_, j) => (j < 1 || j >= g.length - 1 ? 0 : g[j - 1] * 0.25 + g[j] * 0.5 + g[j + 1] * 0.25));
        const top = Math.max(...sm);
        // The OUTERMOST clear edge with the table outside it and card inside: the cut edge — not
        // the border's inner frame line, and not the soft edge of the card's shadow.
        const tabThr = bg ? 18 : 0;
        for (let j = sm.length - 2; j >= 1; j--) {
          if (!(sm[j] >= top * 0.2 && sm[j] >= 12 && sm[j] >= sm[j - 1] && sm[j] >= sm[j + 1])) continue;
          if (bg) {
            const outC = prof[Math.min(prof.length - 1, j + 2 + 5)], inC = prof[Math.max(0, j + 2 - 5)];
            const tIn = tableDist(inC, bg), tOut = tableDist(outC, bg);
            // Card colour inside, table outside — or, for a border the table's colour (silver on
            // grey), a SHARP brightness step (a shadow fades over many pixels; a cut edge doesn't).
            const wide = dist3(prof[Math.max(0, j + 2 - 6)], prof[Math.min(prof.length - 1, j + 2 + 6)]);
            const sharp = sm[j] >= 0.6 * wide && wide > 25 && dist3(outC, bg) < dist3(inC, bg);
            if (!((tOut < tabThr + 0.5 * tIn && tIn > tabThr) || sharp)) continue;
          } else if (sm[j] < top * 0.45) continue;
          bestI = j; bestG = sm[j]; break;
        }
        if (bestG < 18 || bestI < 1 || bestI >= g.length - 1) continue;
        // Sub-pixel: parabola through the peak.
        const y0 = g[bestI - 1], y1 = g[bestI], y2 = g[bestI + 1];
        const den = y0 - 2 * y1 + y2;
        const off = den < -1e-6 ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den)) : 0;
        const s = -reach + (bestI + 2 + off) * step;
        pts.push({ x: P.x + nx * s, y: P.y + ny * s, g: bestG });
      }
      const line = pts.length >= 12 ? fitLine(pts) : null;
      // It must agree with the rough side (within 1.5% of the card's width at both ends).
      const off = (P) => line ? Math.abs((P.x - line.x) * line.dy - (P.y - line.y) * line.dx) : Infinity;
      if (line && off(A) < reach * 0.9 && off(B) < reach * 0.9) { support += pts.length; lines.push(line); continue; }
      // Not enough clear edge on this side: keep the rough line.
      lines.push({ x: A.x, y: A.y, dx: ux, dy: uy, rms: 0, rough: true });
    }
    const cross = crossLines;
    const [top, right, bottom, left] = lines;
    const nq = [cross(top, left), cross(top, right), cross(bottom, right), cross(bottom, left)];
    if (nq.some((p) => !p)) return { q, refined: false, support: 0 };
    // Sanity: the refined corners stay near the rough ones.
    if (nq.some((p, i) => Math.hypot(p.x - q[i].x, p.y - q[i].y) > cardW * 0.05)) return { q, refined: false, support: 0 };
    const rough = lines.filter((l) => l.rough).length;
    return { q: nq, refined: rough === 0, roughSides: rough, support: support / 160, residual: Math.max(...lines.map((l) => l.rms)) };
  }

  /* Total-least-squares line through points, dropping the worst 20% twice. */
  function fitLine(pts) {
    let use = pts;
    let line = null;
    for (let round = 0; round < 3 && use.length >= 6; round++) {
      const mx = use.reduce((s, p) => s + p.x, 0) / use.length, my = use.reduce((s, p) => s + p.y, 0) / use.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of use) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const res = use.map((p) => Math.abs((p.x - mx) * dy - (p.y - my) * dx));
      line = { x: mx, y: my, dx, dy, rms: Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) };
      if (round < 2) {
        const cut = quantile(res, 0.8);
        use = use.filter((p, i) => res[i] <= cut);
      }
    }
    return line;
  }

  /* Flatten: the quad → a W × H card, plus `wide`: the same with MARGIN of table around it
   * (for checking the outline, and telling wear from the table showing through blur). */
  const MARGIN = Math.round(1.5 * MM);
  function homography(q) { // unit square → quad (as warpQuad)
    const [p0, p1, p2, p3] = q;
    const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
      return (u, v) => ({ x: p0.x + (p1.x - p0.x) * u + (p3.x - p0.x) * v, y: p0.y + (p1.y - p0.y) * u + (p3.y - p0.y) * v });
    }
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
    const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
    return (u, v) => { const z = g * u + h * v + 1; return { x: (a * u + b * v + p0.x) / z, y: (d * u + e * v + p0.y) / z }; };
  }
  function flatten(img, q) {
    const H2 = homography(q);
    const mu = MARGIN / W, mv = MARGIN / H;
    const wq = [H2(-mu, -mv), H2(1 + mu, -mv), H2(1 + mu, 1 + mv), H2(-mu, 1 + mv)];
    const WW = W + 2 * MARGIN, HH = H + 2 * MARGIN;
    const wide = { d: warpQuad(img.d, img.w, img.h, wq, WW, HH), w: WW, h: HH };
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) d.set(wide.d.subarray(((y + MARGIN) * WW + MARGIN) * 4, ((y + MARGIN) * WW + MARGIN + W) * 4), y * W * 4);
    return { d, w: W, h: H, wide, margin: MARGIN };
  }

  /* Is the outline right? Just inside it, all four sides should be card border (one colour
   * family, unlike the table); just outside, table. Returns { ok, why }. */
  function outlineCheck(o) {
    const card = o.card;
    const { wide, margin: M } = card;
    const band = (side, d0, d1) => {
      const cols = [];
      const along = side === 'top' || side === 'bottom' ? W : H;
      for (let a = Math.round(along * 0.15); a < along * 0.85; a += 6) for (let dd = d0; dd <= d1; dd++) {
        const x = side === 'left' ? M + dd : side === 'right' ? M + W - 1 - dd : M + a;
        const y = side === 'top' ? M + dd : side === 'bottom' ? M + H - 1 - dd : M + a;
        cols.push([px(wide, x, y, 0), px(wide, x, y, 1), px(wide, x, y, 2)]);
      }
      return { c: medianColour(cols), spread: quantile(cols.map((c) => dist3(c, medianColour(cols))), 0.75) };
    };
    const sides = ['top', 'right', 'bottom', 'left'];
    const inside = sides.map((s) => band(s, Math.round(0.3 * MM), Math.round(0.6 * MM)));
    const outside = sides.map((s) => band(s, -Math.round(1.2 * MM), -Math.round(0.6 * MM)));
    const contrast = Math.min(...inside.map((b, i) => dist3(b.c, outside[i].c)));
    const borderMix = Math.max(...inside.map((b) => Math.max(...inside.map((o) => dist3(b.c, o.c)))));
    const why = [];
    // Just inside the outline looks like the table (or its shadow): the outline is off the card.
    const tableInside = o.bg ? Math.min(...inside.map((b) => tableDist(b.c, o.bg))) : 99;
    if (!o.refined || tableInside < 10) why.push("Couldn't find the card's edges exactly. Use a plain surface that's darker than the card's border (a dark table, a mousepad, a black cloth), with the light from above so there's little shadow.");
    else if (contrast < 22) why.push('The table is too close in colour to the card\'s border, so its edges can\'t be found exactly. Put the card on something darker (or a contrasting colour).');
    if (borderMix > 70) why.push('The outline doesn\'t look right (the border looks different on each side) — make sure the whole card is in view, on a plain surface, and nothing touches it.');
    return { ok: !why.length, why, contrast, borderMix, tableInside };
  }

  /* The whole step for one photo. `guide`: where the on-screen box was (fractions). */
  function outline(img, guide = null) {
    const r = roughQuad(img, guide);
    if (!r) return null;
    const rough = r.q;
    const ref = refineQuad(img, rough, r.bg);
    const cardPx = Math.hypot(ref.q[1].x - ref.q[0].x, ref.q[1].y - ref.q[0].y);
    return { quad: ref.q, refined: ref.refined, residual: ref.residual ?? null, cardPx, card: flatten(img, ref.q), bg: r.bg, how: r.how };
  }

  /* ---------- Photo quality ---------- */

  /* Live check on a small camera frame (~360 px): is there a card, how big, any glare, how
   * much reflection (for the shine shots). Cheap enough for a few times a second. */
  function quickFind(img) {
    const seg = segmentQuad(img);
    if (!seg) return null;
    const q = seg.q;
    const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const ix0 = Math.round(x0 + (x1 - x0) * 0.08), ix1 = Math.round(x1 - (x1 - x0) * 0.08);
    const iy0 = Math.round(y0 + (y1 - y0) * 0.06), iy1 = Math.round(y1 - (y1 - y0) * 0.06);
    const L = [];
    let blown = 0;
    for (let y = Math.max(0, iy0); y < Math.min(img.h, iy1); y += 2) for (let x = Math.max(0, ix0); x < Math.min(img.w, ix1); x += 2) {
      const r = px(img, x, y, 0), g = px(img, x, y, 1), b = px(img, x, y, 2);
      L.push(0.299 * r + 0.587 * g + 0.114 * b);
      if (r > 245 && g > 245 && b > 245) blown++;
    }
    const med = median(L);
    const lit = L.filter((v) => v > Math.min(250, med * 1.35 + 25)).length / Math.max(1, L.length);
    const inFrame = x0 > img.w * 0.01 && y0 > img.h * 0.01 && x1 < img.w * 0.99 && y1 < img.h * 0.99;
    return { q, fill: (y1 - y0) / img.h, inFrame, glare: blown / Math.max(1, L.length), lit, dark: med < 55 };
  }

  /* How much of a shine shot is lit by the reflection: brighter than the straight front photo
   * (same card, lined up by their outlines) by a clear margin. */
  function shineShare(shine, front) {
    const a = resize(shine, SW, SH), b = resize(front, SW, SH);
    const La = lum(a), Lb = lum(b);
    const ratios = [];
    for (let i = 0; i < La.length; i += 7) ratios.push(La[i] / Math.max(10, Lb[i]));
    const gain = quantile(ratios, 0.3);
    let lit = 0, blown = 0;
    for (let i = 0; i < La.length; i++) {
      if (La[i] > Lb[i] * gain + 35) lit++;
      if (La[i] > 247) blown++;
    }
    return { lit: lit / La.length, blown: blown / La.length };
  }

  /* Turn a flattened card upside down (the card was the wrong way round in the photo). */
  function rotate180(card) {
    const flip = (img) => {
      const d = new Uint8ClampedArray(img.d.length);
      for (let i = 0, j = img.d.length - 4; i < img.d.length; i += 4, j -= 4) { d[i] = img.d[j]; d[i + 1] = img.d[j + 1]; d[i + 2] = img.d[j + 2]; d[i + 3] = 255; }
      return { ...img, d };
    };
    return { ...flip(card), wide: card.wide && flip(card.wide), margin: card.margin };
  }

  /* Which way up: the official image matches better straight or turned round? Returns the
   * card the right way up, and how well it matches (0–1). */
  function orient(card, refImg) {
    const small = resize(card, SW, SH);
    const a = alignRef(small, refImg).ncc;
    const turned = rotate180(card);
    const b = alignRef(resize(turned, SW, SH), refImg).ncc;
    return b > a + 0.03 ? { card: turned, ncc: b, turned: true } : { card, ncc: a, turned: false };
  }

  /* Is this a card back (blue border, the Poké Ball back)? */
  function looksLikeBack(card) {
    const cols = [];
    for (let y = Math.round(H * 0.2); y < H * 0.8; y += 20) for (const x of [Math.round(1.2 * MM), W - 1 - Math.round(1.2 * MM)]) cols.push(at3(card, x, y));
    for (let x = Math.round(W * 0.2); x < W * 0.8; x += 20) for (const y of [Math.round(1.2 * MM), H - 1 - Math.round(1.2 * MM)]) cols.push(at3(card, x, y));
    const [r, g, b] = medianColour(cols);
    return b > r * 1.6 && b > g * 1.15 && b > 70;
  }

  /* Photo checks. Each: { level: 'bad' (retake) | 'warn', text }. `kind`: front / back / shine. */
  function quality(o, kind = 'front', photo = null) {
    const out = [];
    const bad = (text) => out.push({ level: 'bad', text });
    const warn = (text) => out.push({ level: 'warn', text });
    const c = o.card;
    // The outline itself.
    const oc = outlineCheck(o);
    for (const t of oc.why) bad(t);
    // Whole card in the photo.
    if (photo) {
      const m = Math.min(photo.w, photo.h) * 0.01;
      if (o.quad.some((p) => p.x < m || p.y < m || p.x > photo.w - m || p.y > photo.h - m)) bad('Part of the card is outside the photo — get the whole card in, with a little table around it.');
    }
    // Big enough for detail.
    if (o.cardPx < 480) bad('The card is too small in the photo — hold the phone closer so the card fills the box.');
    else if (o.cardPx < 750) warn('The card is a bit small in the photo — closer gives finer detail.');
    // Straight above (opposite sides about the same length).
    const L = (a, b) => Math.hypot(o.quad[b].x - o.quad[a].x, o.quad[b].y - o.quad[a].y);
    const skew = Math.max(L(0, 1) / L(3, 2), L(3, 2) / L(0, 1), L(0, 3) / L(1, 2), L(1, 2) / L(0, 3));
    if (skew > 1.15) bad('The phone is at an angle — hold it straight above the card (centering can\'t be measured at an angle).');
    else if (skew > 1.07) warn('The phone is slightly at an angle — straight above is best.');
    if (o.residual != null && o.residual > 2.2) warn("The card's edges look curved — is it bent or warped? (Or the photo is blurry.)");
    if (o.how === 'detect') warn('The background isn\'t plain, so the edges are found less exactly — a plain, dark surface is best.');
    // Focus: how many mm the cut edge takes to change from border to table (sharp ≈ 0.1 mm).
    const { wide, margin: M } = c;
    const widths = [];
    for (let i = 0; i < 24; i++) {
      const side = i % 4, t = 0.2 + 0.6 * (Math.floor(i / 4) + 0.5) / 6;
      const prof = [];
      for (let d = -Math.round(0.9 * MM); d <= Math.round(0.9 * MM); d++) {
        const x = side === 0 ? M + t * W : side === 1 ? M + W - 1 - d : side === 2 ? M + t * W : M + d;
        const y = side === 0 ? M + d : side === 1 ? M + t * H : side === 2 ? M + H - 1 - d : M + t * H;
        prof.push(at3(wide, Math.round(x), Math.round(y)));
      }
      const a = prof[0], b = prof[prof.length - 1];
      const total = dist3(a, b);
      if (total < 40) continue;
      const fr = prof.map((p) => dist3(p, a) / total);
      const i10 = fr.findIndex((f) => f > 0.15), i90 = fr.findIndex((f) => f > 0.85);
      if (i10 >= 0 && i90 > i10) widths.push((i90 - i10) / MM);
    }
    const blurMm = widths.length >= 6 ? median(widths) : null;
    if (blurMm != null && blurMm > 0.45) bad('The photo is blurry — hold still, tap the card on screen to focus, or add more light.');
    else if (blurMm != null && blurMm > 0.28) warn('The photo is a little soft — a sharper one finds smaller wear.');
    // Light.
    let lsum = 0, n = 0, blown = 0;
    for (let y = 0; y < c.h; y += 6) for (let x = 0; x < c.w; x += 6) {
      const r = px(c, x, y, 0), g = px(c, x, y, 1), b = px(c, x, y, 2);
      lsum += 0.299 * r + 0.587 * g + 0.114 * b; n++;
      if (r > 245 && g > 245 && b > 245) blown++;
    }
    const mean = lsum / n, glare = blown / n;
    if (mean < 55) bad('Too dark — add light (but not straight above the card, or it reflects).');
    else if (mean < 80) warn('A bit dark — more light shows wear better.');
    if (kind !== 'shine') {
      if (glare > 0.02) bad('There\'s a bright reflection on the card — it hides wear and can look like whitening. Move the light to the side, or tilt the card slightly.');
      else if (glare > 0.004) warn('A small reflection on the card — that area can\'t be checked.');
    }
    // Right side.
    const back = looksLikeBack(c);
    if (kind === 'back' && !back) bad("That doesn't look like the back of a Pokémon card — turn the card over.");
    if (kind !== 'back' && back) bad('That\'s the back of the card — this photo needs the front.');
    return { checks: out, ok: !out.some((x) => x.level === 'bad'), blurMm, glare, mean, skew, outline: oc,
      notes: out.map((x) => x.text) };
  }

  /* ---------- 2. Centering ---------- */

  /* Border width on each side, in mm, and the ratios. For each side, 120 scan lines from the
   * cut edge inward, each with its own border colour (0.3–0.6 mm in). The border ends at the
   * first depth where MOST lines (the median) have changed colour, for 3 px running — text or
   * a symbol printed on the border only changes some lines, so it doesn't count. */
  function centering(card) {
    const sides = {};
    const maxDepth = Math.round(12 * MM);
    const start = Math.round(0.6 * MM);
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const horiz = side === 'left' || side === 'right';
      const along = horiz ? card.h : card.w;
      const N = 120;
      const dist = Array.from({ length: maxDepth }, () => new Float32Array(N));
      const thrs = [];
      for (let i = 0; i < N; i++) {
        const a = Math.round(along * (0.12 + 0.76 * (i + 0.5) / N));
        const at = (dpt) => {
          const x = side === 'left' ? dpt : side === 'right' ? card.w - 1 - dpt : a;
          const y = side === 'top' ? dpt : side === 'bottom' ? card.h - 1 - dpt : a;
          return [px(card, x, y, 0), px(card, x, y, 1), px(card, x, y, 2)];
        };
        // Border colour on this line, leaving out whitened pixels (edge wear would otherwise
        // be taken for the border, and the real border for the print).
        const near = [];
        for (let dpt = Math.round(0.3 * MM); dpt < Math.round(1.0 * MM); dpt++) near.push(at(dpt));
        const rough = medianColour(near.slice(-5));
        const refCols = near.filter((c) => !isWhite(c, rough));
        const ref = medianColour(refCols.length >= 3 ? refCols : near);
        thrs.push(median((refCols.length >= 3 ? refCols : near).map((c) => dist3(c, ref))));
        for (let dpt = start; dpt < maxDepth; dpt++) {
          const c = at(dpt);
          // Whitening near the cut edge is still border.
          dist[dpt][i] = dpt < 1.0 * MM && isWhite(c, ref) ? 0 : dist3(c, ref);
        }
      }
      const thr = Math.max(24, 4 * median(thrs));
      let found = -1, run = 0;
      const prof = [];
      for (let dpt = start; dpt < maxDepth; dpt++) {
        const m = median(dist[dpt]);
        prof[dpt] = m;
        if (m > thr) { if (++run === 3) { found = dpt - 2; break; } } else run = 0;
      }
      if (found < 0) { sides[side] = { mm: NaN, agree: 0 }; continue; }
      // Sub-pixel: where the median profile crosses the threshold.
      const p0 = prof[found - 1] ?? 0, p1 = prof[found];
      const sub = p1 > p0 ? (thr - p0) / (p1 - p0) : 0;
      const depth = found - 1 + Math.min(1, Math.max(0, sub)) + 0.5;
      // Agreement: lines that change within ±0.3 mm of it.
      let agree = 0;
      for (let i = 0; i < N; i++) {
        let d = -1;
        for (let dpt = start; dpt < maxDepth; dpt++) if (dist[dpt][i] > thr) { d = dpt; break; }
        if (d >= 0 && Math.abs(d - depth) <= 0.3 * MM) agree++;
      }
      sides[side] = { mm: depth / MM, agree: agree / N };
    }
    const pair = (a, b) => {
      const A = sides[a].mm, B = sides[b].mm;
      if (!(A > 0 && B > 0)) return null;
      const big = Math.max(A, B) / (A + B) * 100;
      return { [a]: A, [b]: B, worse: Math.round(big), text: `${Math.round(A / (A + B) * 100)}/${Math.round(B / (A + B) * 100)}` };
    };
    const lr = pair('left', 'right'), tb = pair('top', 'bottom');
    const sure = Object.values(sides).every((s) => s.agree >= 0.5);
    return { sides, lr, tb, worse: Math.max(lr?.worse ?? 0, tb?.worse ?? 0) || null, sure, ok: !!(lr && tb) };
  }

  /* ---------- 3. Edges and corners ---------- */

  /* A pixel is "white" against its border colour `ref`: for a coloured border, much greyer and
   * not darker; for a dark border, also much brighter. */
  function isWhite(c, ref) {
    const a = hsv(c), r = hsv(ref);
    if (a.v < 120) return false;
    if (r.s >= 0.3) return a.s < r.s * 0.45 && a.v > r.v * 0.85;
    return a.v > r.v + 70 && a.s < 0.25;
  }
  /* Whitening, not blur: a pixel that's just the border and the table blended (the photo's
   * softness at the cut edge) doesn't count — real whitening is paler than both. */
  function isWear(c, ref, bg) {
    if (!isWhite(c, ref)) return false;
    if (!bg) return true;
    // Distance from the border→table colour line.
    const d = [bg[0] - ref[0], bg[1] - ref[1], bg[2] - ref[2]];
    const L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((c[0] - ref[0]) * d[0] + (c[1] - ref[1]) * d[1] + (c[2] - ref[2]) * d[2]) / L2));
    const off = Math.hypot(c[0] - ref[0] - t * d[0], c[1] - ref[1] - t * d[1], c[2] - ref[2] - t * d[2]);
    const v = hsv(c).v, vb = hsv(bg).v, vr = hsv(ref).v;
    return off > 30 && v > Math.max(vb, vr) - 10;
  }
  const at3 = (img, x, y) => [px(img, x, y, 0), px(img, x, y, 1), px(img, x, y, 2)];

  function edges(card) {
    const out = {};
    const { wide, margin: M } = card;
    const band0 = Math.round(0.2 * MM), band1 = Math.round(0.8 * MM);
    const refsAll = [];
    const lines = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const horiz = side === 'left' || side === 'right';
      const along = horiz ? card.h : card.w;
      // In wide-image coordinates; depth < 0 = outside the card.
      const at = (a, dpt) => {
        const x = side === 'left' ? M + dpt : side === 'right' ? M + card.w - 1 - dpt : M + a;
        const y = side === 'top' ? M + dpt : side === 'bottom' ? M + card.h - 1 - dpt : M + a;
        return at3(wide, x, y);
      };
      lines[side] = [];
      // Every 2 px along the side, away from the corners (they're checked on their own).
      for (let a = Math.round(RADIUS + 0.5 * MM); a < along - RADIUS - 0.5 * MM; a += 2) {
        const refCols = [], bgCols = [];
        for (let dpt = Math.round(0.9 * MM); dpt <= Math.round(1.3 * MM); dpt++) refCols.push(at(a, dpt));
        for (let dpt = -Math.round(1.2 * MM); dpt <= -Math.round(0.6 * MM); dpt++) bgCols.push(at(a, dpt));
        const ref = medianColour(refCols), bg = medianColour(bgCols);
        let white = 0;
        for (let dpt = band0; dpt <= band1; dpt++) if (isWear(at(a, dpt), ref, bg)) white++;
        lines[side].push({ a, ref, bg, white: white / (band1 - band0 + 1) });
        refsAll.push(ref);
      }
    }
    const borderRef = medianColour(refsAll);
    const coloured = hsv(borderRef).s >= 0.3 || hsv(borderRef).v < 110;
    for (const side of Object.keys(lines)) {
      // Glare: the inner border itself is washed out → skip that line. A pale table can't show
      // white wear against it → those lines can't be judged.
      const use = lines[side].filter((l) => dist3(l.ref, borderRef) < 60 && !isWhite(l.ref, borderRef));
      const paleTable = use.length && use.filter((l) => isWhite(l.bg, l.ref)).length > use.length / 2;
      const whiteLines = use.filter((l) => l.white >= 0.34);
      // Longest stretch of whitened lines (mm), allowing 2-line gaps.
      let longest = 0, cur = 0, gap = 0;
      for (const l of use) {
        if (l.white >= 0.34) { cur += 2 + gap * 2; gap = 0; longest = Math.max(longest, cur); } else if (cur && gap < 2) gap++; else { cur = 0; gap = 0; }
      }
      out[side] = {
        share: use.length ? whiteLines.length / use.length : 0,
        longestMm: longest / MM,
        spots: whiteLines.map((l) => l.a),
        checked: use.length / Math.max(1, lines[side].length),
        paleTable,
      };
    }
    return { sides: out, borderRef, coloured };
  }

  /* Corners. The card's own corner radius is measured (the four corners' median), then each
   * corner is judged against it: rounder than its siblings (worn soft), card missing (a chip
   * or bend), and whitening along the arc. */
  function corners(card, borderRef) {
    const out = {};
    const { wide, margin: M } = card;
    const Z = Math.round(4.6 * MM);
    const defs = { tl: [0, 0, 1, 1], tr: [card.w - 1, 0, -1, 1], br: [card.w - 1, card.h - 1, -1, -1], bl: [0, card.h - 1, 1, -1] };
    const inside = (u, v, R) => { // u, v: px from the corner along the edges; >0 inside
      if (u >= R || v >= R) return Math.min(u, v);
      return R - Math.hypot(R - u, R - v);
    };
    const info = {};
    for (const [name, [x0, y0, sx, sy]] of Object.entries(defs)) {
      const pix = [];
      for (let v = -Math.round(0.8 * MM); v < Z; v++) for (let u = -Math.round(0.8 * MM); u < Z; u++) {
        pix.push({ u, v, c: at3(wide, M + x0 + sx * u, M + y0 + sy * v) });
      }
      const refCols = pix.filter((p) => { const d = inside(p.u + 0.5, p.v + 0.5, RADIUS); return d >= 1.0 * MM && d <= 1.6 * MM; }).map((p) => p.c);
      const bgCols = pix.filter((p) => p.u < -0.3 * MM || p.v < -0.3 * MM).map((p) => p.c);
      const ref = refCols.length ? medianColour(refCols) : borderRef;
      const bg = bgCols.length > 20 ? medianColour(bgCols) : null;
      // Card or table, pixel by pixel (whichever colour it's nearer).
      // (Whitened card is still card — wear, not a chip.)
      const isCard = (c) => !bg || dist3(c, ref) < dist3(c, bg) || isWear(c, ref, bg);
      // The radius that fits this corner best.
      let bestR = RADIUS, bestS = -1;
      if (bg && dist3(bg, ref) > 35) {
        const arc = pix.filter((p) => p.u >= 0 && p.v >= 0 && p.u < 4.4 * MM && p.v < 4.4 * MM);
        for (let r = 1.8 * MM; r <= 5.0 * MM; r += 0.1 * MM) {
          let agree = 0;
          for (const p of arc) if ((inside(p.u + 0.5, p.v + 0.5, r) > 0) === isCard(p.c)) agree++;
          if (agree > bestS) { bestS = agree; bestR = r; }
        }
      }
      info[name] = { pix, ref, bg, isCard, r: bestR, glare: dist3(ref, borderRef) > 70, paleBg: !!bg && isWhite(bg, ref) };
    }
    const rs = Object.values(info).map((i) => i.r).sort((a, b) => a - b);
    const R0 = Math.max(2.2 * MM, Math.min(3.6 * MM, (rs[1] + rs[2]) / 2)); // the card's own radius
    for (const [name, [x0, y0, sx, sy]] of Object.entries(defs)) {
      const { pix, ref, bg, isCard, r, glare, paleBg } = info[name];
      const band = [], edge = [];
      for (const p of pix) {
        if (p.u < 0 || p.v < 0) continue;
        const d = inside(p.u + 0.5, p.v + 0.5, R0);
        if (d >= 0.2 * MM && d <= 0.8 * MM) band.push(p);
        if (d >= 0.25 * MM && d <= 1.0 * MM && p.u < R0 + 0.5 * MM && p.v < R0 + 0.5 * MM) edge.push(p);
      }
      const white = band.filter((p) => isWear(p.c, ref, bg));
      const missing = bg && dist3(bg, ref) > 35 && !paleBg ? edge.filter((p) => !isCard(p.c)) : [];
      out[name] = {
        whiteShare: band.length ? white.length / band.length : 0,
        missingShare: edge.length ? missing.length / edge.length : 0,
        roundMm: Math.max(0, (r - R0) / MM),
        radiusMm: r / MM,
        paleBg,
        glare,
        marks: [...white, ...missing].map((p) => ({ x: x0 + sx * p.u, y: y0 + sy * p.v })),
      };
    }
    return out;
  }

  /* ---------- 4. Surface ---------- */

  const SW = 315, SH = 440; // surface work size (5 px per mm)

  function lum(img) {
    const L = new Float32Array(img.w * img.h);
    for (let i = 0, p = 0; p < L.length; i += 4, p++) L[p] = 0.299 * img.d[i] + 0.587 * img.d[i + 1] + 0.114 * img.d[i + 2];
    return L;
  }
  function blur(L, w, h, r) {
    const tmp = new Float32Array(L.length), out = new Float32Array(L.length);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += L[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        s += L[y * w + Math.min(w - 1, x + r + 1)] - L[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / (2 * r + 1);
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /* Line up the official image with the photo: shift ±8 px and scale ±4% (x and y apart),
   * scored by the correlation of edge maps (lighting-proof). Returns the moved reference. */
  function alignRef(photo, ref, outW = SW, outH = SH) {
    const edgesOf = (img) => {
      const L = blur(lum(img), img.w, img.h, 1);
      const E = new Float32Array(L.length);
      for (let y = 1; y < img.h - 1; y++) for (let x = 1; x < img.w - 1; x++) {
        const i = y * img.w + x;
        E[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + img.w] - L[i - img.w]);
      }
      return E;
    };
    const Ep = edgesOf(photo);
    const small = (img, sx, sy, dx, dy) => { // ref resampled with scale + shift into SW × SH
      const out = new Uint8ClampedArray(SW * SH * 4);
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const rx = ((x - SW / 2) / sx + SW / 2 - dx) * img.w / SW, ry = ((y - SH / 2) / sy + SH / 2 - dy) * img.h / SH;
        const c = sample(img, rx, ry);
        const o = (y * SW + x) * 4;
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
      }
      return { d: out, w: SW, h: SH };
    };
    const score = (cand) => {
      const Er = edgesOf(cand);
      let sab = 0, saa = 0, sbb = 0;
      for (let y = 20; y < SH - 20; y += 2) for (let x = 20; x < SW - 20; x += 2) {
        const i = y * SW + x;
        sab += Ep[i] * Er[i]; saa += Ep[i] * Ep[i]; sbb += Er[i] * Er[i];
      }
      return sab / Math.sqrt(saa * sbb + 1e-9);
    };
    let best = { s: -1, p: [1, 1, 0, 0] };
    const tryP = (p) => { const s = score(small(ref, ...p)); if (s > best.s) best = { s, p }; };
    for (const sx of [0.96, 0.98, 1, 1.02, 1.04]) for (const sy of [0.96, 0.98, 1, 1.02, 1.04]) tryP([sx, sy, 0, 0]);
    for (let step = 4; step >= 1; step /= 2) {
      const [sx, sy, dx, dy] = best.p;
      for (const [ex, ey] of [[step, 0], [-step, 0], [0, step], [0, -step]]) tryP([sx, sy, dx + ex, dy + ey]);
      for (const [fx, fy] of [[0.005, 0], [-0.005, 0], [0, 0.005], [0, -0.005]]) tryP([sx + fx * step, sy + fy * step, best.p[2], best.p[3]]);
    }
    if (outW === SW) return { img: small(ref, ...best.p), ncc: best.s };
    // Same fit, drawn at the size asked for.
    const [sx, sy, dx, dy] = best.p, k = outW / SW;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const rx = ((x - outW / 2) / sx + outW / 2 - dx * k) * ref.w / outW, ry = ((y - outH / 2) / sy + outH / 2 - dy * k) * ref.h / outH;
      const c = sample(ref, rx, ry);
      const o = (y * outW + x) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
    return { img: { d: out, w: outW, h: outH }, ncc: best.s };
  }

  /* Spots on the straight front that the official image doesn't have: a dent, ink, a stain, a
   * print flaw. Uneven light, colour casts and soft reflections are taken out first: both
   * images are compared as fine detail (each minus its own ~2 mm blur), with the contrast
   * matched locally, plus a colour check for stains; each pixel takes the best match within
   * ±1 px. What's left that's compact (0.3–40 mm²) is a spot. Many spots all over means the
   * photo's light didn't allow a fair comparison → unreadable, not damage. */
  function spots(front, refImg) {
    const photo = resize(front, SW, SH);
    const { img: ref, ncc } = alignRef(photo, refImg);
    const n = SW * SH;
    const ch = (img, k) => { const C = new Float32Array(n); for (let p = 0; p < n; p++) C[p] = img.d[p * 4 + k]; return C; };
    const margin = 8;
    // Glare: much brighter and greyer than the official image there.
    const glare = new Uint8Array(n);
    const Lp = lum(photo), Lr = lum(ref);
    const Bp = blur(Lp, SW, SH, 10), Br = blur(Lr, SW, SH, 10);
    // Light level: the photo's brightness relative to the scan, smoothly over the card.
    const gainL = blur(Bp.map((v, i) => v / Math.max(8, Br[i])), SW, SH, 6);
    for (let p = 0; p < n; p++) {
      const sp = hsv([photo.d[p * 4], photo.d[p * 4 + 1], photo.d[p * 4 + 2]]).s, sr = hsv([ref.d[p * 4], ref.d[p * 4 + 1], ref.d[p * 4 + 2]]).s;
      if (Lp[p] > Lr[p] * gainL[p] + 45 && sp < sr * 0.7 + 0.05) glare[p] = 1;
    }
    const glareShare = glare.reduce((s, v) => s + v, 0) / n;
    // Fine detail, contrast matched locally (as for scratches), and a colour difference after
    // matching each channel's light level locally.
    const detail = (L) => { const B = blur(L, SW, SH, 5); return L.map((v, i) => v - B[i]); };
    const P = detail(blur(Lp, SW, SH, 1)), Q = detail(blur(Lr, SW, SH, 1));
    const PQ = blur(P.map((v, i) => v * Q[i]), SW, SH, 12), QQ = blur(Q.map((v) => v * v), SW, SH, 12);
    const G = PQ.map((v, i) => (QQ[i] > 1 ? Math.max(0.2, Math.min(3, v / QQ[i])) : 1));
    const chan = [0, 1, 2].map((k) => {
      const cp = blur(ch(photo, k), SW, SH, 1), cr = blur(ch(ref, k), SW, SH, 1);
      const gp = blur(cp, SW, SH, 10), gr = blur(cr, SW, SH, 10);
      return { cp, cr, g: gp.map((v, i) => v / Math.max(8, gr[i])) };
    });
    const D = new Float32Array(n);
    for (let y = margin; y < SH - margin; y++) for (let x = margin; x < SW - margin; x++) {
      const p = y * SW + x;
      if (glare[p]) continue;
      let bestD = Infinity, bestC = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = p + dy * SW + dx;
        bestD = Math.min(bestD, Math.abs(P[p] - G[p] * Q[q]));
        bestC = Math.min(bestC, Math.hypot(...chan.map((c) => c.cp[p] - c.g[p] * c.cr[q])));
      }
      const busy = Math.abs(Q[p]) + Math.abs(Q[p + 1] - Q[p - 1]) + Math.abs(Q[p + SW] - Q[p - SW]);
      D[p] = Math.max(0, Math.max(bestD * 1.3, bestC * 0.8) - 0.5 * busy);
    }
    const Db = blur(D, SW, SH, 1);
    const vals = [];
    for (let p = 0; p < n; p += 5) if (Db[p] > 0) vals.push(Db[p]);
    const med = median(vals), mad = median(vals.map((v) => Math.abs(v - med)));
    const thr = Math.max(28, med + 9 * mad);
    const all = groups(Db, SW, SH, (v) => v > thr);
    const found = all.filter((g) => g.area >= 8 && g.area <= 1000);
    const wide = all.filter((g) => g.area > 1000).length;
    const unreadable = found.length > 8 || wide > 0 || glareShare > 0.25;
    return {
      ncc,
      aligned: ncc > 0.35,
      unreadable,
      glareShare,
      spots: unreadable ? [] : found.map((g) => ({ x: g.cx / SW, y: g.cy / SH, r: Math.max(g.bw, g.bh) / SW, mm2: g.area / 25 })),
      wide,
      raw: found.length,
    };
  }

  /* Connected groups of pixels passing `test` (4-neighbour). */
  function groups(A, w, h, test) {
    const seen = new Uint8Array(w * h);
    const out = [];
    const stack = [];
    for (let p = 0; p < w * h; p++) {
      if (seen[p] || !test(A[p])) continue;
      let area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack.push(p); seen[p] = 1;
      while (stack.length) {
        const q = stack.pop();
        const x = q % w, y = (q / w) | 0;
        area++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const r of [q - 1, q + 1, q - w, q + w]) {
          if (r < 0 || r >= w * h || seen[r]) continue;
          if ((r === q - 1 && x === 0) || (r === q + 1 && x === w - 1)) continue;
          if (test(A[r])) { seen[r] = 1; stack.push(r); }
        }
      }
      out.push({ area, cx: sx / area, cy: sy / area, bw: x1 - x0 + 1, bh: y1 - y0 + 1 });
    }
    return out;
  }

  /* Scratches on a tilted shot (the lamp reflecting off the card): the card's own print is
   * taken away — the official image, lined up and matched in contrast (or, for cards without
   * one, the straight front photo) — and so is the reflection (it's smooth: only fine detail is
   * compared). What's left that forms thin straight lines (8 directions, 1.4 mm filter), longer
   * than 1.5 mm, is a possible scratch. Lines everywhere = holo foil texture → not judged.
   * At 10 px per mm. `against`: official image ({ d, w, h }) or a flattened front photo. */
  function scratches(tilted, against) {
    const S = 10, w = 63 * S, h = 88 * S;
    const photo = resize(tilted, w, h);
    const base = against.w === W && against.h === H ? resize(against, w, h) : alignRef(resize(photo, SW, SH), against, w, h).img;
    const detail = (img) => { const L = blur(lum(img), w, h, 1); const B = blur(L, w, h, 6); return L.map((v, i) => v - B[i]); };
    const P = detail(photo), Q = detail(base);
    // Contrast match, local (a reflection flattens the print's contrast where it falls):
    // least squares of the fine detail over ~5 mm around each point.
    const PQ = blur(P.map((v, i) => v * Q[i]), w, h, 25), QQ = blur(Q.map((v) => v * v), w, h, 25);
    const G = PQ.map((v, i) => (QQ[i] > 1 ? Math.max(0.1, Math.min(3, v / QQ[i])) : 1));
    const g = median(Array.from(G).filter((_, i) => i % 13 === 0));
    // How busy the print is around each point: lines are judged against that.
    const busy = blur(Q.map((v) => Math.abs(v)), w, h, 4);
    // Residual: the best match within ±1 px (misalignment), sign kept.
    const Rz = new Float32Array(w * h);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      let best = Infinity, val = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = P[i] - G[i] * Q[i + dy * w + dx];
        if (Math.abs(v) < best) { best = Math.abs(v); val = v; }
      }
      Rz[i] = val;
    }
    const R = new Float32Array(w * h);
    const len = 14, off = 3;
    const dirs = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);
    const margin = Math.round(1.6 * S);
    for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) {
      let best = 0;
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = dirs[k];
        let on = 0, s1 = 0, s2 = 0;
        for (let t = -len / 2; t <= len / 2; t += 2) {
          const xi = Math.round(x + dx * t), yi = Math.round(y + dy * t);
          on += Rz[yi * w + xi];
          s1 += Rz[Math.round(yi + dx * off) * w + Math.round(xi - dy * off)];
          s2 += Rz[Math.round(yi - dx * off) * w + Math.round(xi + dy * off)];
        }
        const n = len / 2 + 1;
        const v = Math.max(Math.min(on - s1, on - s2), Math.min(s1 - on, s2 - on)) / n;
        if (v > best) best = v;
      }
      R[y * w + x] = Math.max(0, best - 0.35 * G[y * w + x] * busy[y * w + x]);
    }
    const vals = [];
    for (let i = 0; i < R.length; i += 9) if (R[i] > 0) vals.push(R[i]);
    const med = median(vals), mad = median(vals.map((v) => Math.abs(v - med)));
    const thr = Math.max(7, med + 9 * mad);
    const keep = [];
    for (const gr of groups(R, w, h, (v) => v > thr)) {
      const long = Math.max(gr.bw, gr.bh);
      if (long < 1.5 * S) continue;
      const fill = gr.area / (gr.bw * gr.bh);
      const diag = Math.hypot(gr.bw, gr.bh);
      // A line: long and thin (a diagonal line fills little of its box; a straight one is narrow).
      if (Math.min(gr.bw, gr.bh) > 0.35 * long && fill > 0.3) continue;
      keep.push({ x: gr.cx / w, y: gr.cy / h, lenMm: diag / S, bw: gr.bw / w, bh: gr.bh / h });
    }
    // One scratch often shows as several pieces: join pieces whose boxes are within 2 mm.
    const box = (k) => ({ x0: k.x - k.bw / 2, x1: k.x + k.bw / 2, y0: k.y - k.bh / 2, y1: k.y + k.bh / 2 });
    const gapMm = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1) * 63, Math.max(0, a.y0 - b.y1, b.y0 - a.y1) * 88);
    const merged = [];
    for (const k of keep) {
      const b = box(k);
      const m = merged.find((g) => gapMm(g, b) < 2);
      if (m) { m.x0 = Math.min(m.x0, b.x0); m.x1 = Math.max(m.x1, b.x1); m.y0 = Math.min(m.y0, b.y0); m.y1 = Math.max(m.y1, b.y1); m.n++; } else merged.push({ ...b, n: 1 });
    }
    const out = merged.map((g) => ({ x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, bw: g.x1 - g.x0, bh: g.y1 - g.y0, lenMm: Math.hypot((g.x1 - g.x0) * 63, (g.y1 - g.y0) * 88) }));
    const textured = out.length > 12;
    return { scratches: textured ? [] : out.slice(0, 12), textured, against: against.w === W ? 'front photo' : 'official image' };
  }

  /* ---------- 5. Grade ---------- */

  // PSA's centering limits (front, back), worse side's share of the border.
  const PSA_CENTERING = [[10, 55, 75], [9, 60, 90], [8, 65, 90], [7, 70, 90], [6, 80, 90], [5, 85, 90], [4, 85, 90], [3, 90, 90], [2, 90, 90]];
  const centeringCap = (front, back) => {
    for (const [g, f, b] of PSA_CENTERING) if ((front == null || front <= f) && (back == null || back <= b)) return g;
    return 1;
  };
  const WEAR_WORDS = ['none seen', 'tiny specks', 'light', 'noticeable', 'heavy'];
  const levelOf = (pts) => (pts < 0.4 ? 0 : pts < 1.2 ? 1 : pts < 2.5 ? 2 : pts < 4.5 ? 3 : 4);
  const wearLevel = (share) => levelOf(edgePoints({ share, longestMm: 0 }));

  /* Wear points (0 = none … 9 = destroyed), with a dead zone so photo noise counts for nothing.
   * Tuned so: a 1 mm speck ≈ 0.5, a few mm of whitening along an edge ≈ 1.5–2, a fully
   * whitened corner ≈ 3, a chipped or bent corner ≈ 5–9. */
  const edgePoints = (s) => Math.min(9, 30 * Math.max(0, s.share - 0.004) + 0.2 * Math.max(0, s.longestMm - 3));
  const cornerPoints = (c) => {
    const w = c.paleBg ? Math.max(c.whiteShare, c.missingShare) : c.whiteShare;
    const m = c.paleBg ? 0 : c.missingShare;
    return Math.min(9, 8 * Math.max(0, w - 0.08) + 12 * Math.max(0, m - 0.05) + 3 * Math.max(0, c.roundMm - 0.5));
  };
  const cornerWear = (c) => levelOf(cornerPoints(c));
  /* A category's sub-grade: 10 minus the worst flaw and part of the rest (several flaws add up). */
  const subGrade = (pts) => {
    const sorted = [...pts].sort((a, b) => b - a);
    const worst = sorted[0] ?? 0, rest = sorted.slice(1).reduce((s, p) => s + p, 0);
    return Math.max(1, Math.min(10, 10 - worst - 0.35 * rest));
  };

  function grade({ frontC, backC, frontE, backE, frontK, backK, surf, scr, bend = 0 }) {
    const why = [];
    // Centering: PSA's own table.
    const cc = centeringCap(frontC?.ok ? frontC.worse : null, backC?.ok ? backC.worse : null);
    if (cc < 10) why.push(`centering (${[frontC?.ok && `front ${frontC.lr.text} · ${frontC.tb.text}`, backC?.ok && `back ${backC.lr.text} · ${backC.tb.text}`].filter(Boolean).join('; ')})`);
    // Edges: each side of the back (dark border shows whitening best), and of the front if
    // its border is coloured; a pale table can't show it.
    const edgeSides = [backE, frontE?.coloured ? frontE : null].filter(Boolean)
      .flatMap((e) => Object.values(e.sides).filter((s) => !s.paleTable));
    const edgePts = edgeSides.map(edgePoints);
    const eg = subGrade(edgePts);
    const edgeLevel = levelOf(Math.max(0, ...edgePts));
    if (eg < 9.5) why.push(`edge whitening (${WEAR_WORDS[edgeLevel]}${edgePts.filter((p) => p >= 1.2).length > 1 ? `, ${edgePts.filter((p) => p >= 1.2).length} edges` : ''})`);
    // Corners.
    const cs = [frontK, backK].filter(Boolean).flatMap((k) => Object.values(k)).filter((c) => !c.glare);
    const cornerPts = cs.map(cornerPoints);
    const kg = subGrade(cornerPts);
    const cornerLevel = levelOf(Math.max(0, ...cornerPts));
    const soft = cs.filter((c) => (!c.paleBg && c.missingShare > 0.12) || c.roundMm > 0.8).length;
    if (kg < 9.5) why.push(`corners (${WEAR_WORDS[cornerLevel]}${soft ? `, ${soft} soft / chipped` : ''})`);
    // Surface: marks and scratches; not judged when the photo's lighting made it unreadable.
    const spots = surf?.aligned && !surf.unreadable ? surf.spots : [];
    const scrs = (scr ?? []).filter((x) => !x.textured).flatMap((x) => x.scratches);
    const surfPts = [
      ...spots.map((p) => Math.min(6, 0.8 + p.mm2 / 4)),
      ...scrs.map((x) => Math.min(5, 0.5 + x.lenMm / 7)),
      ...(bend ? [bend] : []),
    ];
    const sg = subGrade(surfPts);
    const surfLevel = levelOf(Math.max(0, ...surfPts));
    if (sg < 9.5) why.push(`surface (${[spots.length && `${spots.length} mark${spots.length > 1 ? 's' : ''}`, scrs.length && `${scrs.length} possible scratch${scrs.length > 1 ? 'es' : ''}`, bend && 'looks bent or creased'].filter(Boolean).join(', ')})`);

    // Overall: the weakest area, a little lower when other areas are weak too.
    const subs = [cc, eg, kg, sg];
    const lowest = Math.min(...subs);
    const others = subs.filter((v) => v !== lowest || subs.indexOf(v) !== subs.indexOf(lowest)).filter((v) => v < lowest + 1.5).length;
    const score = Math.max(1, lowest - 0.4 * Math.max(0, others - 1));
    const high = Math.max(1, Math.min(10, Math.round(score)));
    const unsure = [!frontC?.sure && 'front centering', backC && !backC.sure && 'back centering', !backE && 'no back photo',
      !(surf?.aligned) && 'surface not compared', surf?.unreadable && 'surface lighting', !(scr?.length) && 'no shine shots'].filter(Boolean);
    const low = Math.max(1, high - (unsure.length ? 1 : 0));
    // Condition from the grade. Damaged needs structural damage (a bend / crease / tear).
    const condition = score >= 6.5 ? 'NM' : score >= 4.5 ? 'LP' : score >= 2.8 ? 'MP' : bend >= 6 ? 'DMG' : 'HP';
    return { score, high, low, condition, why, unsure,
      caps: { centering: cc, edges: Math.round(eg), corners: Math.round(kg), surface: Math.round(sg) },
      subs: { centering: cc, edges: eg, corners: kg, surface: sg },
      levels: { edgeLevel, cornerLevel, surfLevel } };
  }

  return { MM, W, H, RADIUS, quickFind, shineShare, rotate180, orient, looksLikeBack, cornerWear, edgePoints, cornerPoints, levelOf, outline, outlineCheck, quality, centering, edges, corners, spots, scratches, grade, resize, WEAR_WORDS, wearLevel, PSA_CENTERING };
})();
