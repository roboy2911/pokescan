/* Background thread for scanning, so the camera preview stays smooth while matching. */
importScripts('cardprint.js', 'detect.js', 'matcher.js');

let matcherPromise = null;
let englishIndex = null;

/* Downloads with a few retries (the network is often still waking up when the app opens). */
async function fetchBuffer(url) {
  let last;
  for (const wait of [0, 500, 1200, 2500, 4000, 6000]) {
    if (wait > 500 && navigator.onLine === false) break; // offline: the saved copy (if any) was already tried
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(url);
      if (r.status === 404) throw Object.assign(new Error(`${url}: not found`), { final: true });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.arrayBuffer();
    } catch (err) {
      last = err;
      if (err.final) break;
    }
  }
  throw last;
}

function getEnglish() {
  matcherPromise ??= fetchBuffer('data/index.bin')
    .then((buf) => { englishIndex = buf; return createMatcher(buf); })
    .catch((err) => { matcherPromise = null; throw err; }); // try again on the next scan
  return matcherPromise;
}

/* "Scan Japanese cards" on: data/index-ja.bin is loaded (once) and searched together with the
 * English index — its rows come after the English ones. Off: English only, as before. */
let japanesePromise = null;
let useJapanese = false;
function getJapanese() {
  japanesePromise ??= Promise.all([getEnglish(), fetchBuffer('data/index-ja.bin')]).then(([, ja]) => {
    const both = new Uint8Array(englishIndex.byteLength + ja.byteLength);
    both.set(new Uint8Array(englishIndex), 0);
    both.set(new Uint8Array(ja), englishIndex.byteLength);
    return createMatcher(both.buffer);
  });
  japanesePromise.catch(() => { japanesePromise = null; });
  return japanesePromise;
}
const getMatcher = () => (useJapanese ? getJapanese() : getEnglish());

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'japanese') {
      useJapanese = !!msg.on;
      const m = await getMatcher().catch((err) => { useJapanese = false; throw err; });
      self.postMessage({ id: msg.id, count: m.count, jaStart: englishIndex.byteLength / FP.DIM });
      return;
    }
    const matcher = await getMatcher();
    if (msg.type === 'warmup') {
      self.postMessage({ id: msg.id, count: matcher.count });
      return;
    }
    const t0 = performance.now();
    const regions = msg.regions.map((r) => ({ ...r, data: new Uint8ClampedArray(r.data) }));
    const { matches, where, glare, combined } = matcher.match(regions, 12, { live: !!msg.live });
    self.postMessage({ id: msg.id, matches, where, glare, combined, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id: msg.id, error: err.message });
  }
};
