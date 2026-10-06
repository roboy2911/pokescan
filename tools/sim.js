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
  const card = await imgData(cardUrl, 315, 440);
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
