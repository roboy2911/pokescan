/* Background thread for scanning, so the camera preview stays smooth while matching. */
importScripts('fingerprint.js', 'detect.js', 'matcher.js');

let matcherPromise = null;

function getMatcher() {
  matcherPromise ??= fetch('data/index.bin')
    .then((r) => {
      if (!r.ok) throw new Error(`index.bin: HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then(createMatcher);
  return matcherPromise;
}

self.onmessage = async ({ data: msg }) => {
  try {
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
