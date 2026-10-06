# PokeScan

Scan a Pokémon card with your phone or computer camera and identify it **by its artwork**.
One codebase: works in any browser and installs to your phone's home screen like an app (PWA).

Live: https://roboy2911.github.io/pokescan/

## How it identifies a card

1. **Card index (built once):** `tools/build-index.html` downloads every card image from
   [pokemontcg.io](https://pokemontcg.io) (~20k cards) and turns each into a tiny colour
   fingerprint: the card averaged over an 8×11 grid, normalised for brightness and colour
   cast. The result is saved to `data/cards.json` (names, sets, numbers) and
   `data/index.bin` (fingerprints, 264 bytes per card).
2. **Scanning:** the app crops the card using the yellow frame, fingerprints 27 slightly
   shifted/zoomed crops (so imperfect framing doesn't matter), and compares them against
   every card in the index. The closest artwork wins.

No text reading and no network calls while scanning: it all runs on the device, so it also
works offline once the app has loaded. In testing against simulated phone photos (blur,
glare, tilt, colour casts, sloppy framing), the exact card came first about 90% of the time
and in the top 5 about 95% of the time.

**Variants:** every card with its own number (alt arts, full arts, secret rares, reprints in
other sets) is in the index. Finish/stamp variants of the *same* number (reverse holo,
1st Edition, Shadowless, stamped promos) share one image, so they can't be told apart yet.

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

- Fill the yellow frame with the card, held flat, in even light (avoid glare on holos).
- If it isn't sure, it shows the closest matches. Tap the right one.
- The **Search** tab finds cards by name and/or number (`199` or `199/165`), offline.

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout (Scan / Search / History tabs) |
| `app.js` | Camera, matching against the index, search, history |
| `fingerprint.js` | The fingerprint maths, shared by the app and the index builder |
| `data/` | The card index (built by `tools/build-index.html`) |
| `style.css` | Styling (mobile-first, dark) |
| `manifest.json`, `sw.js`, `icon.svg` | Makes it installable as a phone app |
| `serve.ps1` | Tiny local web server for testing on Windows |

## Next up: prices

Confirmed scans are saved in **History** (on the device) with the card's set, number and ID,
ready for a pricing step (eBay AU sold listings) later.
