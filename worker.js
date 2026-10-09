/* Background thread for scanning, so the camera preview stays smooth while matching. */
importScripts('cardprint.js', 'detect.js', 'matcher.js');

let matcherPromise = null;
let englishIndex = null;

function getEnglish() {
  matcherPromise ??= fetch('data/index.bin')
    .then((r) => {
      if (!r.ok) throw new Error(`index.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => { englishIndex = buf; return createMatcher(buf); });
  return matcherPromise;
}

/* "Scan Japanese cards" on: data/index-ja.bin is loaded (once) and searched together with the
 * English index — its rows come after the English ones. Off: English only, as before. */
let japanesePromise = null;
let useJapanese = false;
function getJapanese() {
  japanesePromise ??= Promise.all([getEnglish(), fetch('data/index-ja.bin').then((r) => {
    if (!r.ok) throw new Error(`index-ja.bin: HTTP ${r.status}`);
    return r.arrayBuffer();
  })]).then(([, ja]) => {
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
    const { matches, where } = matcher.match(regions);
    self.postMessage({ id: msg.id, matches, where, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id: msg.id, error: err.message });
  }
};
