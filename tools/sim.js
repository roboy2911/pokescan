/* Test helpers: simulated phone photos of cards, for measuring detection / matching accuracy.
 * Load in the browser console on the app page:  await import('./tools/sim.js')
 */
export const mulberry = (a) => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

function sq2quad(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const bmpCache = new Map();
export async function imgData(url, W, H) {
  if (url === 'plain') {
    // A plain, slightly noisy "table".
    const d = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < d.length; i += 4) {
      const n = 90 + Math.random() * 25;
      d[i] = n * 1.1; d[i + 1] = n; d[i + 2] = n * 0.85; d[i + 3] = 255;
    }
    return { d, W, H };
  }
  if (!bmpCache.has(url)) bmpCache.set(url, fetch(url).then((r) => r.blob()).then(createImageBitmap));
  const b = await bmpCache.get(url);
  const c = new OffscreenCanvas(W || b.width, H || b.height);
  const x = c.getContext('2d');
  x.drawImage(b, 0, 0, c.width, c.height);
  return { d: x.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
}

/* A 480x640 "camera view" shaped like the app's (guide = 86% of the height, centred), with
 * the card drawn as a tilted/perspective quad, `bgUrl` image behind, then blur / exposure /
 * glare. `size` = card size range relative to the guide; `anywhere` = card can be anywhere
 * in view (for far-away cards) instead of roughly centred. */
export async function simPhoto(cardUrl, bgUrl, rnd,
  { jitter = 0.05, shift = 0.05, rot = 0.06, size = [0.9, 1.04], anywhere = false } = {}) {
  const W = 480, H = 640;
  const ghei = H * 0.86, gwid = ghei * 63 / 88;
  const guide = { x0: (W - gwid) / 2, y0: (H - ghei) / 2, x1: (W + gwid) / 2, y1: (H + ghei) / 2 };
  const r = (a, b) => a + rnd() * (b - a);
  const s = r(size[0], size[1]), ang = r(-rot, rot);
  let cx = W / 2 + r(-shift, shift) * gwid, cy = H / 2 + r(-shift, shift) * ghei;
  if (anywhere) {
    const mx = (gwid * s) / 2 + 12, my = (ghei * s) / 2 + 12;
    cx = r(mx, Math.max(mx, W - mx));
    cy = r(my, Math.max(my, H - my));
  }
  const quad = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const x = u * gwid / 2 * s, y = v * ghei / 2 * s;
    return {
      x: cx + x * Math.cos(ang) - y * Math.sin(ang) + r(-jitter, jitter) * gwid,
      y: cy + x * Math.sin(ang) + y * Math.cos(ang) + r(-jitter, jitter) * gwid,
    };
  });
  const card = typeof cardUrl === 'string' ? await imgData(cardUrl, 315, 440) : cardUrl;
  const bg = await imgData(bgUrl, W, H);
  const Hm = inv3(sq2quad(quad));
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  const out = x.createImageData(W, H);
  const o = out.data;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const z = Hm[6] * px + Hm[7] * py + Hm[8];
      const u = (Hm[0] * px + Hm[1] * py + Hm[2]) / z, v = (Hm[3] * px + Hm[4] * py + Hm[5]) / z;
      const k = (py * W + px) * 4;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const si = (Math.floor(v * card.H) * card.W + Math.floor(u * card.W)) * 4;
        o[k] = card.d[si]; o[k + 1] = card.d[si + 1]; o[k + 2] = card.d[si + 2];
      } else {
        o[k] = bg.d[k] * 0.6; o[k + 1] = bg.d[k + 1] * 0.6; o[k + 2] = bg.d[k + 2] * 0.6;
      }
      o[k + 3] = 255;
    }
  }
  x.putImageData(out, 0, 0);
  const c2 = new OffscreenCanvas(W, H);
  const y = c2.getContext('2d');
  y.filter = `brightness(${r(0.7, 1.1)}) contrast(${r(0.85, 1.15)}) saturate(${r(0.8, 1.2)}) blur(${r(0.4, 1.4)}px)`;
  y.drawImage(c, 0, 0);
  y.filter = 'none';
  y.globalCompositeOperation = 'multiply';
  y.fillStyle = `rgb(${r(215, 255)},${r(215, 255)},${r(195, 255)})`;
  y.fillRect(0, 0, W, H);
  y.globalCompositeOperation = 'screen';
  const gx = r(0, W), gy = r(0, H);
  const gr = y.createRadialGradient(gx, gy, 0, gx, gy, r(50, 160));
  gr.addColorStop(0, `rgba(255,255,255,${r(0.2, 0.55)})`);
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  y.fillStyle = gr;
  y.fillRect(0, 0, W, H);
  return { d: y.getImageData(0, 0, W, H).data, W, H, guide, quad };
}

export const SAMPLE = ['sv3pt5/199', 'swsh7/215', 'base1/4', 'sv1/25', 'xy12/12', 'dp1/1', 'sm115/7',
  'me1/50', 'neo1/9', 'swsh4/44', 'sv2/254', 'sv6/130', 'sv8/238', 'swsh12pt5/160'];
export const BACKGROUNDS = ['plain', 'https://images.pokemontcg.io/sv3pt5/199_hires.png',
  'https://images.pokemontcg.io/base1/4_hires.png', 'https://images.pokemontcg.io/swsh7/215_hires.png'];

/* Corner accuracy of detectCardQuads (best of its candidates), as a fraction of card width. */
export async function testDetect(n = 40, seed = 7) {
  const rnd = mulberry(seed);
  let found = 0;
  const errs = [];
  for (let i = 0; i < n; i++) {
    const id = SAMPLE[i % SAMPLE.length];
    const P = await simPhoto(`https://images.pokemontcg.io/${id}_hires.png`, BACKGROUNDS[i % BACKGROUNDS.length], rnd);
    const quads = detectCardQuads(P.d, P.W, P.H, P.guide, ...(globalThis.DET_ARGS || []));
    if (!quads.length) continue;
    found++;
    const gw = P.guide.x1 - P.guide.x0;
    errs.push(Math.min(...quads.map((q) =>
      Math.max(...q.map((p, k) => Math.hypot(p.x - P.quad[k].x, p.y - P.quad[k].y))) / gw)));
  }
  errs.sort((a, b) => a - b);
  return {
    n, found,
    goodWithin3pct: errs.filter((e) => e <= 0.03).length,
    median: errs[Math.floor(errs.length / 2)]?.toFixed(3),
  };
}

/* End-to-end accuracy with the real matcher (matcher.js), on a page where `db` (card list)
 * is loaded and fingerprint.js / detect.js / matcher.js are available. Collects scores of
 * right/wrong top answers for tuning the "confident" threshold. */
let matcher = null;
export async function testMatch(n = 60, seed = 11, opts = {}) {
  matcher ??= createMatcher(await (await fetch('data/index.bin')).arrayBuffer());
  const rnd = mulberry(seed);
  const res = { n, top1: 0, top5: 0, right: [], wrong: [], ms: 0, misses: [] };
  for (let i = 0; i < n; i++) {
    const card = db.cards[Math.floor(rnd() * db.cards.length)];
    let P;
    try {
      P = await simPhoto(card.imageLarge, opts.bg || BACKGROUNDS[i % BACKGROUNDS.length], rnd, opts);
    } catch {
      continue; // image missing
    }
    const t0 = performance.now();
    const { matches } = matcher.match([{ data: P.d, w: P.W, h: P.H, guide: P.guide }], 12, opts.match || {});
    res.ms += performance.now() - t0;
    const rank = matches.findIndex((m) => db.cards[m.i].id === card.id);
    if (rank === 0) res.top1++;
    if (rank >= 0 && rank < 5) res.top5++;
    if (rank !== 0) res.misses.push(`${card.id}→${db.cards[matches[0].i].id}`);
    const gap = matches[0].score - (matches[1]?.score ?? 0);
    (rank === 0 ? res.right : res.wrong).push([+matches[0].score.toFixed(3), +gap.toFixed(3)]);
  }
  res.ms = Math.round(res.ms / n);
  return res;
}

/* A binder page in view: 3x3 cards in plastic pockets, the target is the middle card.
 * `size` = middle card height relative to the guide. Adds pocket seams, sleeve haze and a
 * long reflection streak across the plastic, then the usual blur / exposure. */
export async function simBinder(cardUrls, rnd, { size = [0.45, 0.9], shift = 0.06, rot = 0.05 } = {}) {
  const W = 480, H = 640;
  const ghei = H * 0.86, gwid = ghei * 63 / 88;
  const guide = { x0: (W - gwid) / 2, y0: (H - ghei) / 2, x1: (W + gwid) / 2, y1: (H + ghei) / 2 };
  const r = (a, b) => a + rnd() * (b - a);
  const s = r(size[0], size[1]);
  const ch = ghei * s, cw = ch * 63 / 88, gap = cw * 0.07;
  const cards = await Promise.all(cardUrls.map((u) => fetch(u).then((x) => x.blob()).then(createImageBitmap)));

  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  const shade = r(18, 45);
  x.fillStyle = `rgb(${shade},${shade},${shade + 4})`;
  x.fillRect(0, 0, W, H);
  x.translate(W / 2 + r(-shift, shift) * W, H / 2 + r(-shift, shift) * H);
  x.rotate(r(-rot, rot));
  for (let i = 0; i < 9; i++) {
    const col = (i % 3) - 1, row = Math.floor(i / 3) - 1;
    const px = col * (cw + gap) - cw / 2, py = row * (ch + gap) - ch / 2;
    x.drawImage(cards[i], px, py, cw, ch);
    // Pocket: slightly hazy plastic with a lighter seam around it.
    x.fillStyle = `rgba(255,255,255,${r(0.03, 0.09)})`;
    x.fillRect(px - gap / 3, py - gap / 3, cw + gap * 2 / 3, ch + gap * 2 / 3);
    x.strokeStyle = `rgba(255,255,255,${r(0.12, 0.3)})`;
    x.lineWidth = 1.5;
    x.strokeRect(px - gap / 2.2, py - gap / 2.2, cw + gap / 1.1, ch + gap / 1.1);
  }
  x.setTransform(1, 0, 0, 1, 0, 0);

  const c2 = new OffscreenCanvas(W, H);
  const y = c2.getContext('2d');
  y.filter = `brightness(${r(0.7, 1.15)}) contrast(${r(0.85, 1.1)}) blur(${r(0.4, 1.4)}px)`;
  y.drawImage(c, 0, 0);
  y.filter = 'none';
  // Reflection streak across the sleeve plastic.
  y.globalCompositeOperation = 'screen';
  y.save();
  y.translate(r(0, W), r(0, H));
  y.rotate(r(-1.2, 1.2));
  const bw = r(30, 110);
  const g = y.createLinearGradient(0, -bw, 0, bw);
  const a = r(0.25, 0.65);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, `rgba(255,255,255,${a})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  y.fillStyle = g;
  y.fillRect(-2 * W, -bw, 4 * W, 2 * bw);
  y.restore();
  y.globalCompositeOperation = 'source-over';
  return { d: y.getImageData(0, 0, W, H).data, W, H, guide };
}

/* Binder accuracy: is the middle card identified? */
export async function testBinder(n = 40, seed = 61, opts = {}) {
  matcher ??= createMatcher(await (await fetch('data/index.bin')).arrayBuffer());
  const rnd = mulberry(seed);
  const res = { n, top1: 0, top5: 0, neighbour: 0, right: [], wrong: [], ms: 0 };
  for (let i = 0; i < n; i++) {
    const picks = Array.from({ length: 9 }, () => db.cards[Math.floor(rnd() * db.cards.length)]);
    let P;
    try {
      P = await simBinder(picks.map((p) => p.image), rnd, opts);
      globalThis.BINDER_DONE = i + 1;
    } catch {
      continue;
    }
    const t0 = performance.now();
    const { matches } = matcher.match([{ data: P.d, w: P.W, h: P.H, guide: P.guide }], 12, opts.match || {});
    res.ms += performance.now() - t0;
    const target = picks[4].id;
    const rank = matches.findIndex((m) => db.cards[m.i].id === target);
    if (rank === 0) res.top1++;
    if (rank >= 0 && rank < 5) res.top5++;
    if (rank !== 0 && picks.some((p, k) => k !== 4 && p.id === db.cards[matches[0].i].id)) res.neighbour++;
    const gap = matches[0].score - (matches[1]?.score ?? 0);
    (rank === 0 ? res.right : res.wrong).push([+matches[0].score.toFixed(3), +gap.toFixed(3)]);
  }
  res.ms = Math.round(res.ms / n);
  return res;
}

/* ------------------------------------------------------------------ */
/* Hard conditions: glare, sleeves, toploaders, fingers                */
/* ------------------------------------------------------------------ */

/* A stand-in card image (315x440) rebuilt from card `i`'s index fingerprint: its 8x11
 * colour grid, smoothly upscaled, with fine texture and a plain border. Lets the tests run
 * offline (no card image downloads); for final checks use real images. */
let indexVecs = null;
export async function synthCard(i, rnd = Math.random) {
  indexVecs ??= new Int8Array(await (await fetch('data/index.bin')).arrayBuffer());
  const v = indexVecs.subarray(i * FP.DIM, (i + 1) * FP.DIM);
  const W = 315, H = 440;
  // Each channel back to a 0–255 range (the fingerprint only keeps relative colour).
  const grid = new Float32Array(FP.DIM);
  for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let c = 0; c < FP.GW * FP.GH; c++) s += v[c * 3 + k] ** 2;
    const sd = Math.sqrt(s / (FP.GW * FP.GH)) || 1;
    for (let c = 0; c < FP.GW * FP.GH; c++) grid[c * 3 + k] = 128 + (v[c * 3 + k] / sd) * 42;
  }
  const border = [200 + rnd() * 40, 170 + rnd() * 40, 40 + rnd() * 60];
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W - FP.X0) / (FP.X1 - FP.X0), t = (y / H - FP.Y0) / (FP.Y1 - FP.Y0);
      const o = (y * W + x) * 4;
      d[o + 3] = 255;
      if (u < 0 || u >= 1 || t < 0 || t >= 1) {
        d[o] = border[0]; d[o + 1] = border[1]; d[o + 2] = border[2];
        continue;
      }
      // Bilinear between cell centres, plus texture.
      const gx = Math.min(FP.GW - 1, Math.max(0, u * FP.GW - 0.5)), gy = Math.min(FP.GH - 1, Math.max(0, t * FP.GH - 0.5));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(FP.GW - 1, x0 + 1), y1 = Math.min(FP.GH - 1, y0 + 1);
      const fx = gx - x0, fy = gy - y0;
      const tex = 14 * Math.sin(x * 0.37 + y * 0.11) * Math.cos(y * 0.29 - x * 0.07);
      for (let k = 0; k < 3; k++) {
        const g = (yy, xx) => grid[(yy * FP.GW + xx) * 3 + k];
        d[o + k] = (g(y0, x0) * (1 - fx) + g(y0, x1) * fx) * (1 - fy) + (g(y1, x0) * (1 - fx) + g(y1, x1) * fx) * fy + tex;
      }
    }
  }
  return { d, W, H };
}

/* Put a card image in a sleeve (slightly bigger, hazy plastic) or a toploader (much bigger,
 * card sitting low). Returns a new image whose outline is the sleeve/toploader's. */
function encase(card, kind, rnd) {
  const r = (a, b) => a + rnd() * (b - a);
  const W = card.W, H = card.H;
  const [sx, sy, oy] = kind === 'toploader' ? [r(0.8, 0.85), r(0.84, 0.88), r(0.3, 0.9)] : [r(0.93, 0.96), r(0.94, 0.97), r(0.3, 0.7)];
  const cw = W * sx, ch = H * sy;
  const ox = (W - cw) / 2, oyPx = (H - ch) * oy;
  const haze = r(0.04, 0.12), tint = [r(0.9, 1), r(0.92, 1), r(0.9, 1)];
  const plastic = r(150, 210);
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const u = (x - ox) / cw, v = (y - oyPx) / ch;
      let px;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const si = (Math.floor(v * H) * W + Math.floor(u * W)) * 4;
        px = [card.d[si], card.d[si + 1], card.d[si + 2]];
      } else {
        px = [plastic, plastic, plastic + 6];
      }
      for (let k = 0; k < 3; k++) d[o + k] = (px[k] * (1 - haze) + 255 * haze) * tint[k];
      d[o + 3] = 255;
    }
  }
  return { d, W, H };
}

/* Simulated photo with hard conditions. `conditions` (any mix):
 *   glare     — 1–3 bright, blown-out reflections on the card
 *   streak    — a long reflection band across the card
 *   sleeve    — card in a penny sleeve (outline slightly bigger, hazy, tinted)
 *   toploader — card in a toploader (outline much bigger, card sits low)
 *   finger    — a finger over one edge / corner
 *   dim       — dark, low-contrast lighting */
export async function simHard(card, bgUrl, rnd, conditions = [], opts = {}) {
  const r = (a, b) => a + rnd() * (b - a);
  let img = card;
  if (conditions.includes('sleeve')) img = encase(img, 'sleeve', rnd);
  if (conditions.includes('toploader')) img = encase(img, 'toploader', rnd);
  const P = await simPhoto(img, bgUrl, rnd, opts);
  const c = new OffscreenCanvas(P.W, P.H);
  const x = c.getContext('2d');
  x.putImageData(new ImageData(new Uint8ClampedArray(P.d), P.W, P.H), 0, 0);
  // Points inside the card (bilinear in the quad).
  const [p0, p1, p2, p3] = P.quad;
  const at = (u, v) => ({
    x: (p0.x * (1 - u) + p1.x * u) * (1 - v) + (p3.x * (1 - u) + p2.x * u) * v,
    y: (p0.y * (1 - u) + p1.y * u) * (1 - v) + (p3.y * (1 - u) + p2.y * u) * v,
  });
  const cardW = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (conditions.includes('dim')) {
    x.fillStyle = `rgba(0,0,0,${r(0.35, 0.55)})`;
    x.fillRect(0, 0, P.W, P.H);
  }
  if (conditions.includes('glare')) {
    x.globalCompositeOperation = 'screen';
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const p = at(r(0.15, 0.85), r(0.1, 0.9));
      const rad = cardW * r(0.12, 0.3);
      const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(r(0.3, 0.6), `rgba(255,255,255,${r(0.75, 0.95)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(p.x, p.y, rad, rad * r(0.5, 1), r(0, Math.PI), 0, 2 * Math.PI);
      x.fill();
    }
    x.globalCompositeOperation = 'source-over';
  }
  if (conditions.includes('streak')) {
    x.globalCompositeOperation = 'screen';
    const p = at(r(0.2, 0.8), r(0.2, 0.8));
    x.save();
    x.translate(p.x, p.y);
    x.rotate(r(-1.3, 1.3));
    const bw = cardW * r(0.08, 0.2);
    const g = x.createLinearGradient(0, -bw, 0, bw);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${r(0.6, 0.95)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(-2 * P.W, -bw, 4 * P.W, 2 * bw);
    x.restore();
    x.globalCompositeOperation = 'source-over';
  }
  if (conditions.includes('finger')) {
    // A finger reaching in from outside over one side.
    const side = Math.floor(rnd() * 4);
    const along = r(0.15, 0.85);
    const [u, v] = [[along, 0], [1, along], [along, 1], [0, along]][side];
    const tip = at(u + (side === 1 ? -1 : side === 3 ? 1 : 0) * r(0.1, 0.28), v + (side === 0 ? 1 : side === 2 ? -1 : 0) * r(0.08, 0.2));
    const base = at(u + (side === 1 ? 1 : side === 3 ? -1 : 0) * 0.6, v + (side === 0 ? -1 : side === 2 ? 1 : 0) * 0.6);
    const fw = cardW * r(0.16, 0.24);
    const skin = [r(190, 235), r(140, 180), r(110, 150)];
    x.save();
    x.lineCap = 'round';
    x.lineWidth = fw;
    const g = x.createLinearGradient(tip.x, tip.y, base.x, base.y);
    g.addColorStop(0, `rgb(${skin.map((s) => s * 1.05).join(',')})`);
    g.addColorStop(1, `rgb(${skin.map((s) => s * 0.75).join(',')})`);
    x.strokeStyle = g;
    x.beginPath();
    x.moveTo(base.x, base.y);
    x.lineTo(tip.x, tip.y);
    x.stroke();
    x.restore();
  }
  return { ...P, d: x.getImageData(0, 0, P.W, P.H).data };
}

/* Accuracy under hard conditions, with stand-in cards (see synthCard). Returns, per
 * condition set, how often the right card is first / in the top 5, and how often the app
 * would have said "Found it" for a wrong card (wrongConfident — should stay 0). */
export async function testHard(n = 40, seed = 5, sets = [[], ['glare'], ['streak'], ['sleeve', 'streak'],
  ['toploader'], ['finger'], ['dim', 'glare'], ['sleeve', 'glare', 'finger']], opts = {}) {
  matcher ??= createMatcher(await (await fetch('data/index.bin')).arrayBuffer());
  const confident = opts.confident ?? ((m) => m[0].score >= 0.88 && m[0].score - (m[1]?.score ?? 0) >= 0.015);
  const out = {};
  for (const conds of sets) {
    const rnd = mulberry(seed);
    const res = { top1: 0, top5: 0, confident: 0, wrongConfident: 0, ms: 0 };
    for (let k = 0; k < n; k++) {
      const i = Math.floor(rnd() * matcher.count);
      const card = await synthCard(i, rnd);
      const P = await simHard(card, BACKGROUNDS[k % 2 ? 0 : 0], rnd, conds, opts.photo || {});
      const t0 = performance.now();
      const { matches } = matcher.match([{ data: P.d, w: P.W, h: P.H, guide: P.guide }], 12, opts.match || {});
      res.ms += performance.now() - t0;
      const rank = matches.findIndex((m) => m.i === i);
      if (rank === 0) res.top1++;
      if (rank >= 0 && rank < 5) res.top5++;
      if (confident(matches)) {
        if (rank === 0) res.confident++;
        else res.wrongConfident++;
      }
    }
    res.ms = Math.round(res.ms / n);
    out[conds.join('+') || 'clean'] = res;
  }
  return out;
}
