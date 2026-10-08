// Fingerprints the Japanese cards (data/cards-ja.json) into data/index-ja.bin, exactly as
// tools/build-index.html does for the English index (fingerprint.js: fpQuantise(fpFromPixels)),
// one 264-byte row per card in cards-ja.json order. Cards without a picture get an all-zero
// row (it never matches anything).
//
// Needs Playwright with Chromium (the same as the test tools) and a local web server:
//   python3 -m http.server 8765 &
//   IMG_DIR=/path/to/pictures node tools/build-index-ja.mjs
// IMG_DIR holds the pictures named by card id with ":" and "/" turned into "_" (e.g.
// "ja_SV8a-1.jpg"); download them from the URLs in cards-ja.json (200 px is plenty).
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const IMG_DIR = process.env.IMG_DIR;
const BATCH = 400;
if (!IMG_DIR) throw new Error('Set IMG_DIR');

const meta = JSON.parse(await readFile(new URL('../data/cards-ja.json', import.meta.url), 'utf8'));
const have = new Set(await readdir(IMG_DIR));
const file = (id) => `${id.replace(/[:/]/g, '_')}.jpg`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await page.route(/^https:\/\/ja\.local\//, async (r) => {
  const name = decodeURIComponent(new URL(r.request().url()).pathname.slice(1));
  try {
    r.fulfill({ status: 200, body: await readFile(`${IMG_DIR}/${name}`), contentType: 'image/jpeg',
      headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch { r.fulfill({ status: 404, body: '' }); }
});
await page.goto('http://localhost:8765/tools/build-index.html');
await page.waitForFunction(() => typeof fpFromPixels === 'function');

const dim = await page.evaluate(() => FP.DIM);
const out = new Int8Array(meta.cards.length * dim);
let done = 0, missing = 0;
const t0 = Date.now();
for (let start = 0; start < meta.cards.length; start += BATCH) {
  const batch = meta.cards.slice(start, start + BATCH).map(([id]) => (have.has(file(id)) ? file(id) : null));
  const rows = await page.evaluate(async (names) => Promise.all(names.map(async (name) => {
    if (!name) return null;
    try {
      const res = await fetch(`https://ja.local/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return Array.from(fpQuantise(fpFromPixels(data, bmp.width, bmp.height)));
    } catch { return null; }
  })), batch);
  rows.forEach((v, k) => {
    if (v) out.set(v, (start + k) * dim);
    else missing++;
  });
  done += rows.length;
  if (done % 4000 < BATCH) console.log(`  ${done}/${meta.cards.length}, ${Math.round((Date.now() - t0) / 1000)} s`);
}
await browser.close();
await writeFile(new URL('../data/index-ja.bin', import.meta.url), out);
console.log(`index-ja.bin: ${meta.cards.length} rows (${missing} without a picture), ${out.length} bytes, `
  + `${Math.round((Date.now() - t0) / 1000)} s`);
