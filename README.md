# PokeScan

Point your phone at a Pokémon card and it identifies it **by its artwork** and shows its
market price in AUD. One codebase: works in any browser and installs to your phone's home
screen like an app (PWA).

Live: https://roboy2911.github.io/pokescan/

## How it identifies a card

1. **Card index (built once):** `tools/build-index.html` downloads every card image from
   [pokemontcg.io](https://pokemontcg.io) (~20k cards) and turns each into a tiny colour
   fingerprint: the card averaged over an 8×11 grid, normalised for brightness and colour
   cast. The result is saved to `data/cards.json` (names, sets, numbers) and
   `data/index.bin` (fingerprints, 264 bytes per card).
2. **Auto-scan:** while the camera is on, frames are scanned continuously in a background
   thread (`worker.js` → `matcher.js`):
   - **Find the card:** edge detection (`detect.js`) looks for card outlines across the
     whole camera view at several sizes, so the card doesn't have to fill the frame. Each
     outline is un-tilted (perspective correction). Blank areas are ignored.
   - **Quick pass:** a coarse fingerprint of each candidate is compared with all ~20k
     cards to make a shortlist of 300.
   - **Detailed pass:** many slightly shifted/zoomed crops of the best candidates are
     compared with the shortlist, ignoring the worst-matching grid cells (glare,
     reflections on sleeves). Off-centre cards and plain boxes without a detected outline
     count for a bit less, so in a binder the card you're pointing at wins.
   - **Lock in:** when the same card wins on consecutive frames, the result is shown.

No text reading and no network calls while scanning. In tests on simulated photos
(`tools/sim.js`) against the full index: card filling the frame ~97%, binder pages ~87%,
far away (40–75% of the frame) ~85%. The app only says "Found it" when the match is
clear; otherwise it shows the closest matches to pick from.

**Variants:** every card with its own number (alt arts, full arts, secret rares, reprints in
other sets) is in the index. Finishes of the *same* number (holo, reverse holo, 1st Edition)
share one image, so you pick the finish on the result card (it changes the price).

## Prices

TCGplayer (US) market prices converted to AUD at the day's exchange rate
([Frankfurter](https://frankfurter.dev), fallback [open.er-api.com](https://open.er-api.com)).

- `data/prices.json` is a daily snapshot of every card's TCGplayer prices, built by
  `tools/update-prices.mjs` and committed by the **Update prices** GitHub Action
  (`.github/workflows/prices.yml`, daily at 04:30 AEST; can also be run by hand from the
  repo's Actions tab).
- Cards missing from the snapshot are looked up live on pokemontcg.io and cached on the device.
- The Collection tab shows each card's price and the collection's total value.

These are US market prices, not Australian sold prices. See the research notes in the
project history for eBay AU options.

## Run it on your computer

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080. The app is plain HTML/JS, with no build step.

## Updating the card index (new sets)

1. Run `serve.ps1` (it accepts saves into `data/`).
2. Open http://localhost:8080/tools/build-index.html and click **Build index**.
   It downloads ~3.5 GB of images and takes roughly 15–30 minutes.
3. Commit and push `data/cards.json` and `data/index.bin`.

If you change anything in `fingerprint.js`, you must rebuild the index. The app and
the index must fingerprint cards the same way.

## Get it on your phone

Open https://roboy2911.github.io/pokescan/ on your phone, allow the camera, then
*Share → Add to Home Screen* (iPhone) or *⋮ → Install app* (Android).
(The live camera needs HTTPS, which GitHub Pages provides.)

## Tips for good scans

- Point at one card; it doesn't need to fill the frame. Hold steady for a moment.
- In a binder, aim at the card you want. Tilt slightly to move reflections off it.
- If it isn't sure, it shows the closest matches. Tap the right one.
- The **Search** tab finds cards by name and/or number (`199` or `199/165`), offline.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | Page layout and styling (Scan / Search / Collection) |
| `app.js` | Camera, auto-scan, results, search, collection |
| `worker.js`, `matcher.js` | Background matching: finding the card and identifying it |
| `detect.js` | Card outline detection and perspective correction |
| `fingerprint.js` | Fingerprint maths, shared by the app and the index builder |
| `prices.js` | TCGplayer prices → AUD |
| `data/` | Card index and price snapshot |
| `tools/build-index.html` | Builds the card index |
| `tools/update-prices.mjs` | Builds the price snapshot (run by GitHub Actions) |
| `tools/sim.js` | Accuracy tests on simulated photos and binder pages |
| `manifest.json`, `sw.js`, `icon.svg` | Makes it installable as a phone app |
| `serve.ps1` | Tiny local web server for testing on Windows |
