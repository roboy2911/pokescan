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
    if (seg) return seg.map((p) => ({ x: p.x * k, y: p.y * k }));
    return detectQuad(small, k, guide);
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
    if (spread > 45) return null; // not a plain background
    const thr = Math.max(30, spread * 2.2);
    const fg = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fg[y * w + x] = dist3(at(x, y), bg) > thr ? 1 : 0;
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
    if (area < 0.12 * w * h || x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2) return null;
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
    if (Math.abs((wTop / hL) / (63 / 88) - 1) > 0.15) return null; // not card-shaped (two cards, a hand…)
    return q;
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
  function refineQuad(img, q) {
    const sides = [[0, 1], [1, 2], [2, 3], [3, 0]]; // top, right, bottom, left
    const centre = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
    const cardW = (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2;
    const reach = Math.max(4, cardW * 0.012), step = 0.5;
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
        for (let j = 1; j < g.length - 1; j++) {
          const v = g[j - 1] * 0.25 + g[j] * 0.5 + g[j + 1] * 0.25;
          if (v > bestG) { bestG = v; bestI = j; }
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
      if (line && off(A) < cardW * 0.015 && off(B) < cardW * 0.015) { support += pts.length; lines.push(line); continue; }
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

  /* Flatten: the quad → a W × H card. */
  function flatten(img, q) {
    return { d: warpQuad(img.d, img.w, img.h, q, W, H), w: W, h: H };
  }

  /* The whole step for one photo. `guide`: where the on-screen box was (fractions). */
  function outline(img, guide = null) {
    const rough = roughQuad(img, guide);
    if (!rough) return null;
    const ref = refineQuad(img, rough);
    const cardPx = Math.hypot(ref.q[1].x - ref.q[0].x, ref.q[1].y - ref.q[0].y);
    return { quad: ref.q, refined: ref.refined, residual: ref.residual ?? null, cardPx, card: flatten(img, ref.q) };
  }

  /* ---------- Photo quality ---------- */

  function quality(o) {
    const notes = [];
    if (o.cardPx < 600) notes.push('The card is small in the photo — hold the phone closer (fill the box) for finer detail.');
    if (!o.refined) notes.push("The card's edges weren't crisp — measurements are less exact (use a plain, contrasting background).");
    if (o.residual != null && o.residual > 1.6) notes.push("The card's edges look curved — is it bent, or the photo blurry?");
    // Sharpness: average gradient on the border band.
    const c = o.card;
    let g = 0, n = 0;
    for (let y = 40; y < c.h - 40; y += 7) {
      for (let x = 8; x < 60; x++) { g += Math.abs(px(c, x + 1, y, 1) - px(c, x - 1, y, 1)); n++; }
    }
    const sharp = g / n;
    // Glare: share of the card that's blown out.
    let blown = 0, all = 0;
    for (let y = 0; y < c.h; y += 4) for (let x = 0; x < c.w; x += 4) {
      all++;
      if (px(c, x, y, 0) > 245 && px(c, x, y, 1) > 245 && px(c, x, y, 2) > 245) blown++;
    }
    const glare = blown / all;
    return { notes, sharp, glare };
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
        const refCols = [];
        for (let dpt = Math.round(0.3 * MM); dpt < start; dpt++) refCols.push(at(dpt));
        const ref = medianColour(refCols);
        thrs.push(median(refCols.map((c) => dist3(c, ref))));
        for (let dpt = start; dpt < maxDepth; dpt++) dist[dpt][i] = dist3(at(dpt), ref);
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

  function edges(card) {
    const out = {};
    const band0 = Math.round(0.15 * MM), band1 = Math.round(0.8 * MM);
    const refsAll = [];
    const lines = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const horiz = side === 'left' || side === 'right';
      const along = horiz ? card.h : card.w;
      const at = (a, dpt) => {
        const x = side === 'left' ? dpt : side === 'right' ? card.w - 1 - dpt : a;
        const y = side === 'top' ? dpt : side === 'bottom' ? card.h - 1 - dpt : a;
        return [px(card, x, y, 0), px(card, x, y, 1), px(card, x, y, 2)];
      };
      lines[side] = [];
      // Every 2 px along the side, away from the corners (they're checked on their own).
      for (let a = Math.round(RADIUS + 0.5 * MM); a < along - RADIUS - 0.5 * MM; a += 2) {
        const refCols = [];
        for (let dpt = Math.round(1.0 * MM); dpt <= Math.round(1.6 * MM); dpt++) refCols.push(at(a, dpt));
        const ref = medianColour(refCols);
        let white = 0;
        for (let dpt = band0; dpt <= band1; dpt++) if (isWhite(at(a, dpt), ref)) white++;
        lines[side].push({ a, ref, white: white / (band1 - band0 + 1) });
        refsAll.push(ref);
      }
    }
    const borderRef = medianColour(refsAll);
    const coloured = hsv(borderRef).s >= 0.3 || hsv(borderRef).v < 110;
    for (const side of Object.keys(lines)) {
      // Glare: the inner border itself is washed out → skip that line.
      const use = lines[side].filter((l) => dist3(l.ref, borderRef) < 60 && !isWhite(l.ref, borderRef));
      const whiteLines = use.filter((l) => l.white >= 0.34);
      // Longest stretch of whitened lines (mm), allowing 1-line gaps.
      let longest = 0, cur = 0, gap = 0;
      for (const l of use) {
        if (l.white >= 0.34) { cur += 2 + gap * 2; gap = 0; longest = Math.max(longest, cur); } else if (cur && gap < 1) gap++; else { cur = 0; gap = 0; }
      }
      out[side] = {
        share: use.length ? whiteLines.length / use.length : 0,
        longestMm: longest / MM,
        spots: whiteLines.map((l) => l.a),
        checked: use.length / Math.max(1, lines[side].length),
      };
    }
    return { sides: out, borderRef, coloured };
  }

  /* Corners: distance inside the rounded corner (px, negative = outside the card). */
  function corners(card, borderRef) {
    const out = {};
    const Z = Math.round(RADIUS + 2.6 * MM);
    const defs = { tl: [0, 0, 1, 1], tr: [card.w - 1, 0, -1, 1], br: [card.w - 1, card.h - 1, -1, -1], bl: [0, card.h - 1, 1, -1] };
    for (const [name, [x0, y0, sx, sy]] of Object.entries(defs)) {
      const inside = (u, v) => { // u, v: px from the corner along the edges
        if (u >= RADIUS || v >= RADIUS) return Math.min(u, v);
        return RADIUS - Math.hypot(RADIUS - u, RADIUS - v);
      };
      const refCols = [], bgCols = [], band = [], edge = [];
      for (let v = 0; v < Z; v++) for (let u = 0; u < Z; u++) {
        const x = x0 + sx * u, y = y0 + sy * v;
        const c = [px(card, x, y, 0), px(card, x, y, 1), px(card, x, y, 2)];
        const d = inside(u + 0.5, v + 0.5);
        if (d >= 1.2 * MM && d <= 2.0 * MM) refCols.push(c);
        else if (d <= -0.5 * MM) bgCols.push(c);
        if (d >= 0.15 * MM && d <= 0.8 * MM) band.push({ c, u, v });
        if (d >= 0 && d < 0.5 * MM && u < RADIUS && v < RADIUS) edge.push({ c, u, v });
      }
      const ref = refCols.length ? medianColour(refCols) : borderRef;
      const bg = bgCols.length > 20 ? medianColour(bgCols) : null;
      const glare = dist3(ref, borderRef) > 70;
      const white = band.filter((p) => isWhite(p.c, ref));
      // Missing card: on the arc, pixels that look like the background, not the border.
      const missing = bg && dist3(bg, ref) > 40 ? edge.filter((p) => dist3(p.c, bg) < dist3(p.c, ref) * 0.6) : [];
      // On a pale table, missing card and whitening look the same: call it all wear.
      const paleBg = !!bg && isWhite(bg, ref);
      out[name] = {
        whiteShare: band.length ? white.length / band.length : 0,
        missingShare: edge.length ? missing.length / edge.length : 0,
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

  /* Spots on the straight front that the official image doesn't have. Colours are matched per
   * channel (least squares), glare and the outer 1.4 mm are left out, then the difference is
   * thresholded against its own spread and grouped; compact groups (0.3–40 mm²) are spots,
   * anything bigger is a difference in lighting / holo foil, not damage. */
  function spots(front, refImg) {
    const photo = resize(front, SW, SH);
    const { img: ref, ncc } = alignRef(photo, refImg);
    const n = SW * SH;
    const fit = [0, 1, 2].map((k) => {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let p = 0; p < n; p += 3) {
        const a = ref.d[p * 4 + k], b = photo.d[p * 4 + k];
        if (b > 245) continue;
        sx += a; sy += b; sxx += a * a; sxy += a * b; m++;
      }
      const g = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1);
      return { g, o: (sy - g * sx) / m };
    });
    // Both softened alike (the photo is never as sharp as the scan), then for each pixel the
    // best match within ±1 px (a hair of misalignment isn't damage), and a higher bar along
    // the print's own sharp edges (text, outlines).
    const soft = (img, f) => [0, 1, 2].map((k) => {
      const C = new Float32Array(n);
      for (let p = 0; p < n; p++) C[p] = f ? f[k].g * img.d[p * 4 + k] + f[k].o : img.d[p * 4 + k];
      return blur(blur(C, SW, SH, 1), SW, SH, 1);
    });
    const P = soft(photo, null), Q = soft(ref, fit);
    const QL = new Float32Array(n);
    for (let p = 0; p < n; p++) QL[p] = 0.299 * Q[0][p] + 0.587 * Q[1][p] + 0.114 * Q[2][p];
    const D = new Float32Array(n);
    const margin = 7;
    for (let y = margin; y < SH - margin; y++) for (let x = margin; x < SW - margin; x++) {
      const p = y * SW + x;
      if (photo.d[p * 4] > 240 && photo.d[p * 4 + 1] > 240 && photo.d[p * 4 + 2] > 240) continue; // glare
      let best = Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = p + dy * SW + dx;
        const v = Math.hypot(P[0][p] - Q[0][q], P[1][p] - Q[1][q], P[2][p] - Q[2][q]);
        if (v < best) best = v;
      }
      const grad = Math.abs(QL[p + 1] - QL[p - 1]) + Math.abs(QL[p + SW] - QL[p - SW]);
      D[p] = Math.max(0, best - 0.6 * grad);
    }
    const Db = blur(D, SW, SH, 1);
    const vals = [];
    for (let p = 0; p < n; p += 5) if (Db[p] > 0) vals.push(Db[p]);
    const med = median(vals), mad = median(vals.map((v) => Math.abs(v - med)));
    const thr = Math.max(40, med + 7 * mad);
    const found = groups(Db, SW, SH, (v) => v > thr).filter((g) => g.area >= 8 && g.area <= 1000);
    return {
      ncc,
      aligned: ncc > 0.35,
      spots: found.map((g) => ({ x: g.cx / SW, y: g.cy / SH, r: Math.max(g.bw, g.bh) / SW, mm2: g.area / 25 })),
      wide: groups(Db, SW, SH, (v) => v > thr).filter((g) => g.area > 1000).length,
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
  const wearLevel = (share) => (share < 0.006 ? 0 : share < 0.03 ? 1 : share < 0.08 ? 2 : share < 0.2 ? 3 : 4);
  const WEAR_WORDS = ['none seen', 'tiny specks', 'light', 'noticeable', 'heavy'];
  /* A corner's wear level: whitening along its arc, or card missing from it (soft / chipped). */
  const cornerWear = (c) => {
    const w = c.paleBg ? Math.max(c.whiteShare, c.missingShare) : c.whiteShare;
    let lvl = w < 0.02 ? 0 : w < 0.06 ? 1 : w < 0.15 ? 2 : w < 0.3 ? 3 : 4;
    if (!c.paleBg && c.missingShare > 0.08) lvl = Math.max(lvl, c.missingShare > 0.3 ? 4 : 3);
    return lvl;
  };
  const WEAR_CAP = [10, 9, 8, 7, 5];

  function grade({ frontC, backC, frontE, backE, frontK, backK, surf, scr }) {
    const caps = [];
    const why = [];
    // Centering.
    const cc = centeringCap(frontC?.ok ? frontC.worse : null, backC?.ok ? backC.worse : null);
    caps.push(cc);
    if (cc < 10) why.push(`centering (${[frontC?.ok && `front ${frontC.lr.text} · ${frontC.tb.text}`, backC?.ok && `back ${backC.lr.text} · ${backC.tb.text}`].filter(Boolean).join('; ')})`);
    // Edges: worst side of front/back. The back's dark border shows whitening best.
    const edgeLevel = Math.max(0, ...[backE, frontE?.coloured ? frontE : null].filter(Boolean)
      .flatMap((e) => Object.values(e.sides).map((s) => wearLevel(s.share) + (s.longestMm > 6 ? 1 : 0))));
    caps.push(WEAR_CAP[Math.min(4, edgeLevel)]);
    if (edgeLevel) why.push(`edge whitening (${WEAR_WORDS[Math.min(4, edgeLevel)]})`);
    // Corners.
    let cornerLevel = 0, softCorners = 0;
    for (const k of [frontK, backK].filter(Boolean)) {
      for (const c of Object.values(k)) {
        if (c.glare) continue;
        cornerLevel = Math.max(cornerLevel, cornerWear(c));
        if (c.missingShare > 0.08 && !c.paleBg) softCorners++;
      }
    }
    caps.push(WEAR_CAP[Math.min(4, cornerLevel)]);
    if (cornerLevel) why.push(`corners (${WEAR_WORDS[Math.min(4, cornerLevel)]}${softCorners ? `, ${softCorners} look soft or chipped` : ''})`);
    // Surface.
    const nSpots = surf?.aligned ? surf.spots.length : 0;
    const nScr = (scr ?? []).reduce((n, s) => n + s.scratches.length, 0);
    const surfLevel = nSpots + nScr === 0 ? 0 : nSpots + nScr <= 1 ? 1 : nSpots + nScr <= 3 ? 2 : nSpots + nScr <= 6 ? 3 : 4;
    caps.push(WEAR_CAP[surfLevel]);
    if (surfLevel) why.push(`surface (${[nSpots && `${nSpots} spot${nSpots > 1 ? 's' : ''}`, nScr && `${nScr} possible scratch${nScr > 1 ? 'es' : ''}`].filter(Boolean).join(', ')})`);

    const best = Math.min(...caps);
    // How sure: centering measured cleanly, back photo there, surface checked.
    const unsure = [!frontC?.sure && 'front centering', backC && !backC.sure && 'back centering', !backE && 'no back photo',
      !(surf?.aligned) && 'surface not compared', !(scr?.length) && 'no tilted shots'].filter(Boolean);
    const low = Math.max(1, best - (unsure.length ? 1 : 0) - (surfLevel === 0 && !(scr?.length) ? 1 : 0));
    const condition = best >= 7 ? 'NM' : best >= 5 ? 'LP' : best >= 3 ? 'MP' : best >= 2 ? 'HP' : 'DMG';
    return { high: best, low: Math.min(low, best), condition, why, unsure, caps: { centering: cc, edges: WEAR_CAP[Math.min(4, edgeLevel)], corners: WEAR_CAP[Math.min(4, cornerLevel)], surface: WEAR_CAP[surfLevel] }, levels: { edgeLevel, cornerLevel, surfLevel } };
  }

  return { MM, W, H, RADIUS, cornerWear, outline, quality, centering, edges, corners, spots, scratches, grade, resize, WEAR_WORDS, wearLevel, PSA_CENTERING };
})();
