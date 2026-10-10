// Test images for the card grader (grade-core.js): a card with known flaws, "photographed".
// Used by the grader tests (load in a page with detect.js + grade-core.js).
// Grader test images: a card with known flaws, then "photographed" (perspective, background,
// light, blur, noise). Runs in the page (OffscreenCanvas).
export const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export async function loadImg(url) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
  return { bmp, d: x.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
}
const MM = 15, W = 945, H = 1320, R = 45;
function roundRect(x, w, h, r) { x.beginPath(); x.moveTo(r, 0); x.arcTo(w, 0, w, h, r); x.arcTo(w, h, 0, h, r); x.arcTo(0, h, 0, 0, r); x.arcTo(0, 0, w, 0, r); x.closePath(); }
/* opts: shift [mmX, mmY] (print moved right/down), whiten [{side, at (0..1), len mm}], chip corner name,
 * spots [{x,y,r mm}], scratches [{x0,y0,x1,y1}] (fractions) */
export function makeCard(ref, o = {}) {
  const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
  // Border colour: the ref's own outer band.
  const b = ref.d; let r = 0, g = 0, bl = 0, n = 0;
  for (let yy = Math.round(ref.h * 0.3); yy < ref.h * 0.7; yy += 3) { const i = (yy * ref.w + Math.round(ref.w * 0.012)) * 4; if (b[i + 3] > 200) { r += b[i]; g += b[i + 1]; bl += b[i + 2]; n++; } }
  x.fillStyle = `rgb(${r / n},${g / n},${bl / n})`; roundRect(x, W, H, R); x.fill();
  // Miscut: the whole print moved by `shift`; the strip it leaves is the print's own edge
  // stretched (so the border colour carries on, as on a real card).
  const [sx, sy] = o.shift || [0, 0];
  const dx = sx * MM, dy = sy * MM;
  x.save(); roundRect(x, W, H, R); x.clip();
  x.drawImage(ref.bmp, 0, 0, ref.w, ref.h, dx, dy, W, H);
  const e = 3; // px of the source edge to stretch
  if (dx > 0) x.drawImage(ref.bmp, 0, 0, e, ref.h, 0, dy, dx + 1, H);
  if (dx < 0) x.drawImage(ref.bmp, ref.w - e, 0, e, ref.h, W + dx - 1, dy, -dx + 1, H);
  if (dy > 0) x.drawImage(ref.bmp, 0, 0, ref.w, e, 0, 0, W, dy + 1);
  if (dy < 0) x.drawImage(ref.bmp, 0, ref.h - e, ref.w, e, 0, H + dy - 1, W, -dy + 1);
  x.restore();
  for (const s of o.spots || []) { x.fillStyle = s.c || 'rgba(60,40,30,0.85)'; x.beginPath(); x.ellipse(s.x * W, s.y * H, s.r * MM, s.r * MM * 0.8, 0.4, 0, 7); x.fill(); }
  // Whitening: little pale chips at the edge.
  const rnd = mulberry(o.seed || 1);
  for (const wv of o.whiten || []) {
    const along = (wv.side === 'top' || wv.side === 'bottom') ? W : H;
    const a0 = wv.at * along, a1 = a0 + wv.len * MM;
    x.fillStyle = 'rgb(236,236,232)';
    for (let a = a0; a < a1; a += 1.2) {
      const dpt = (0.25 + rnd() * 0.55) * MM;
      if (rnd() < 0.25) continue;
      if (wv.side === 'top') x.fillRect(a, 0, 1.4, dpt); if (wv.side === 'bottom') x.fillRect(a, H - dpt, 1.4, dpt);
      if (wv.side === 'left') x.fillRect(0, a, dpt, 1.4); if (wv.side === 'right') x.fillRect(W - dpt, a, dpt, 1.4);
    }
  }
  for (const cw of o.whitenCorners || []) { // white wear along a corner's arc
    const [cx, cy] = { tl: [R, R], tr: [W - R, R], br: [W - R, H - R], bl: [R, H - R] }[cw];
    const a0 = { tl: Math.PI, tr: 1.5 * Math.PI, br: 0, bl: 0.5 * Math.PI }[cw];
    x.strokeStyle = 'rgb(238,238,234)'; x.lineWidth = 0.6 * MM; x.beginPath(); x.arc(cx, cy, R - 0.3 * MM, a0, a0 + Math.PI / 2); x.stroke();
  }
  const img = x.getImageData(0, 0, W, H);
  // Chip: cut a bite out of a corner (made transparent → background in the photo).
  for (const ch of o.chip ? [o.chip] : []) {
    const [cx, cy] = { tl: [0, 0], tr: [W, 0], br: [W, H], bl: [0, H] }[ch];
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) if (Math.hypot(xx - cx, yy - cy) < R * 1.25) img.data[(yy * W + xx) * 4 + 3] = 0;
  }
  for (const s of o.scratches || []) { // stored for the photo step (they show in reflected light)
  }
  return { d: img.data, w: W, h: H, scratches: o.scratches || [] };
}
function sq2quad(q) { const [p0, p1, p2, p3] = q; const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y; if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1]; const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y; const den = dx1 * dy2 - dx2 * dy1; const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den; return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1]; }
function inv3(m) { const [a, b, c, d, e, f, g, h, i] = m; const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g; const det = a * A + b * B + c * C; return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]; }
/* Photo: PW × PH, card ~`fill` of the height, tilt/rotation, table colour, lamp reflection
 * (`sheen` 0..1 at a spot — scratches light up inside it), blur and noise. */
export function photo(card, o = {}) {
  const rnd = mulberry(o.seed || 7);
  const PW = o.w || 1500, PH = o.h || 2000;
  const ch = PH * (o.fill || 0.8), cw = ch * 63 / 88;
  const ang = (o.rot ?? 0.03), persp = o.persp ?? 0.03;
  const cx = PW / 2 + (o.dx || 0), cy = PH / 2 + (o.dy || 0);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v], i) => {
    const k = 1 + (v < 0 ? -persp : persp) * 0.5; // top narrower: phone tilted a little
    const X = u * cw / 2 * k, Y = v * ch / 2;
    return { x: cx + X * Math.cos(ang) - Y * Math.sin(ang), y: cy + X * Math.sin(ang) + Y * Math.cos(ang) };
  });
  const Hm = inv3(sq2quad(corners));
  const bg = o.bg || [62, 54, 46];
  const out = new Uint8ClampedArray(PW * PH * 4);
  const sheen = o.sheen ? { x: o.sheen.x, y: o.sheen.y, r: o.sheen.r, a: o.sheen.a } : null;
  const scr = card.scratches;
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const z = Hm[6] * x + Hm[7] * y + Hm[8];
    const u = (Hm[0] * x + Hm[1] * y + Hm[2]) / z, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / z;
    const k = (y * PW + x) * 4;
    let r = bg[0], g = bg[1], b = bg[2];
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      const sx = u * card.w, sy = v * card.h; const x0 = Math.min(card.w - 2, sx | 0), y0 = Math.min(card.h - 2, sy | 0), fx = sx - x0, fy = sy - y0;
      const i = (y0 * card.w + x0) * 4;
      const al = card.d[i + 3] / 255;
      const s = (c) => (card.d[i + c] * (1 - fx) + card.d[i + 4 + c] * fx) * (1 - fy) + (card.d[i + card.w * 4 + c] * (1 - fx) + card.d[i + card.w * 4 + 4 + c] * fx) * fy;
      r = s(0) * al + bg[0] * (1 - al); g = s(1) * al + bg[1] * (1 - al); b = s(2) * al + bg[2] * (1 - al);
      if (sheen && al > 0.5) {
        const dd = Math.hypot(u - sheen.x, (v - sheen.y) * 88 / 63) / sheen.r;
        const lit = Math.max(0, 1 - dd * dd) * sheen.a;
        // scratches: bright thin lines inside the reflection
        let sc = 0;
        for (const l of scr) { const ex = l.x1 - l.x0, ey = (l.y1 - l.y0) * 88 / 63; const L2 = ex * ex + ey * ey; let t = ((u - l.x0) * ex + (v - l.y0) * 88 / 63 * ey) / L2; t = Math.max(0, Math.min(1, t)); const dx = (u - l.x0 - t * ex) * 63, dy = ((v - l.y0) * 88 / 63 - t * ey) * 63; if (Math.hypot(dx, dy) < 0.09) sc = 1; }
        const m = lit * 0.55 + sc * lit * 0.9;
        r = r + (255 - r) * m; g = g + (255 - g) * m; b = b + (255 - b) * m;
      }
    }
    const light = (o.light ?? 1) * (1 - 0.12 * (y / PH));
    out[k] = r * light; out[k + 1] = g * light; out[k + 2] = b * light; out[k + 3] = 255;
  }
  const c = new OffscreenCanvas(PW, PH); const x = c.getContext('2d'); x.putImageData(new ImageData(out, PW, PH), 0, 0);
  const c2 = new OffscreenCanvas(PW, PH); const y2 = c2.getContext('2d');
  y2.filter = `blur(${o.blur ?? 0.8}px)`; y2.drawImage(c, 0, 0);
  const img = y2.getImageData(0, 0, PW, PH);
  const nz = o.noise ?? 4;
  for (let i = 0; i < img.data.length; i += 4) { const e = (rnd() - 0.5) * 2 * nz; img.data[i] += e; img.data[i + 1] += e; img.data[i + 2] += e; }
  return { d: img.data, w: PW, h: PH, corners };
}
