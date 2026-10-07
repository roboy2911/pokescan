# PokeScan

Point your phone at a Pokémon card and it identifies it **by its artwork** and shows its
market price in AUD. Track your collection (cards and sealed product), browse every set,
and see what's moving in the market. One codebase: works in any browser and installs to
your phone's home screen like an app (PWA), and works offline after the first visit.

## What's in the app

- **Scan** — auto-scans while the camera is on; shows the card, its price per finish
  (holo, reverse holo, Poké Ball / Master Ball pattern, 1st Edition…) and lets you add it.
  The finish you pick is remembered per card. "Not it?" thumbnails swap in one tap.
  Optional beep when a card is found.
- **Search** — cards by name and/or number, and sealed product by name (ETB, UPC and PC
  shorthands work), all offline.
- **Sets** — every English set by series; open one to see all its cards in number order
  with prices, which you own (All / Owned / Missing), your progress and its sealed product.
- **Collection** — cards and sealed product with quantities and finishes; search, sort,
  filter by set, value by set, and back up / restore as a file (••• menu). It's stored on
  the phone only, so back it up now and then.
- **Market** — biggest risers and fallers over 1, 7 and 30 days, and items at their
  highest / lowest since tracking began (6 Oct 2026), for cards and sealed product.
- **Sealed product** — tap the market price to compare it with the Australian RRP
  (table in `prices.js`: pack $8.50, booster bundle $50, ETB $100, booster box $300;
  other types are marked estimates — edit them there).

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
     cards to make a shortlist of 800; each candidate position also keeps its own 300
     best matches (so junk outlines along a reflection's edges can't crowd the real card
     out).
   - **Detailed pass:** many slightly shifted/zoomed crops of the best candidates are
     compared with the shortlist, ignoring the worst-matching grid cells (glare,
     reflections on sleeves). Off-centre cards and plain boxes without a detected outline
     count for a bit less, so in a binder the card you're pointing at wins.
   - **Glare and sleeves:** blown-out reflections (and the faint halo around them) are
     found pixel by pixel and left out; the rest of the card is compared on its own, so a
     reflection can't skew the colours of the whole card. Pale, washed-out patches
     (reflection streaks, sleeve haze) are also tried with those patches left out. A
     match that relies on only part of the card counts for a bit less.
   - **Lock in:** when the same card wins clearly on two frames in a row — or wins most of
     the last 5 frames with a clear lead on average (glare moves as the phone moves) — the
     result is shown.

No text reading and no network calls while scanning. The app only says "Found it" when the
match is clear; otherwise it shows the closest matches to pick from.

Accuracy on simulated photos of **real card images** (`tools/sim.js`, 60 random cards each,
right card first; Oct 2026):

| Test | Before glare work → now |
|---|---|
| Card filling the frame (`testMatch`) | 58 |
| Far away, 40–75% of the frame | 44 → 47 |
| Binder page, middle card (`testBinder`) | 53 |
| Clean (`testHard`) | 57 → 57 |
| Bright glare spots | 56 |
| Reflection streak | 42 → 47 |
| Penny sleeve + streak | 40 → 43 |
| Toploader | 51 → 51 |
| Finger over an edge | 53 → 58 |
| Dim light + glare | 45 → 52 |
| Sleeve + glare + finger | 46 → 50 |

(The "before" column for hard conditions is after the first round of glare work; on
stand-in cards that round took glare from 21 to 55 of 60 and dim light + glare from 4
to 49.) Over 5 frames of a moving phone (`testFusion`), the app's lock-in rule gave no
wrong answers in any condition. A frame takes ≈ 0.5 s on a desktop on real cards (it was
≈ 0.64 s before), so expect 1–2 s on a phone.

**Variants:** every card with its own number (alt arts, full arts, secret rares, reprints in
other sets) is in the index — all English sets, including 30th Celebration and its Classic
Collection. Finishes of the *same* number (holo, reverse holo, 1st Edition, Poké Ball /
Master Ball pattern reverse holos) share one image, so you pick the finish on the result
card (it changes the price).

## Prices

TCGplayer (US) market prices converted to AUD at the day's exchange rate
([Frankfurter](https://frankfurter.dev), fallback [open.er-api.com](https://open.er-api.com)).

- `data/prices.json` is a daily snapshot of every card's TCGplayer prices, built by
  `tools/update-prices.mjs` and committed by the **Update prices** GitHub Action
  (`.github/workflows/prices.yml`, daily at 04:30 AEST; can also be run by hand from the
  repo's Actions tab).
- The snapshot merges two sources: pokemontcg.io's API, and [TCGCSV](https://tcgcsv.com)
  (a daily dump of TCGplayer). TCGCSV prices the newest sets that pokemontcg.io doesn't
  (e.g. 30th Celebration) and adds printings TCGplayer sells as separate products, like
  pattern reverse holos. They're matched to our cards by set name and card number; the
  Action's log lists any sets it couldn't match (fix with `GROUP_ALIASES` in the script).
- Cards missing from the snapshot are looked up live on pokemontcg.io and cached on the device.
- **Sealed product** (`data/sealed.json`, ~1,600 items) comes from TCGCSV too: products
  in each set with no card number, typed by name (booster pack, ETB, tin…).
- **Market data:** `tools/market.mjs` (run by the same Action) keeps 31 days of daily
  prices (`data/history.json`), highs/lows since tracking began (`data/extremes.json`),
  and the small precomputed lists the Market tab shows (`data/market.json`). Prices are
  tracked per finish, so a source adding a holo price can't fake a mover.
- `data/sets.json` holds set logos and symbols.

These are US market prices, not Australian sold prices — see **Ideas** below.

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
- Glare or a shiny sleeve? Keep the phone moving a little — the scanner combines the
  last few frames, and the reflection moves while the card doesn't.
- If it isn't sure, it shows the closest matches. Tap the right one.
- The **Search** tab finds cards by name and/or number (`199` or `199/165`), offline.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | Page layout and styling (Scan / Search / Sets / Collection / Market) |
| `app.js` | Camera, auto-scan, results, search, sets, collection, market |
| `worker.js`, `matcher.js` | Background matching: finding the card and identifying it |
| `detect.js` | Card outline detection and perspective correction |
| `fingerprint.js` | Fingerprint maths, shared by the app and the index builder |
| `prices.js` | TCGplayer prices → AUD; sealed product and the Australian RRP table |
| `data/` | Card index, prices, sealed product, set logos, price history, market lists |
| `tools/build-index.html` | Builds the card index |
| `tools/update-prices.mjs` | Builds the price snapshot and sealed product (run by GitHub Actions) |
| `tools/market.mjs` | Price history and market movers (`--backfill` rebuilds from git history) |
| `tools/sim.js` | Accuracy tests on simulated photos: binder pages, glare/sleeves (`testHard`), multi-frame (`testFusion`) |
| `manifest.json`, `sw.js`, `icon.svg` | Makes it installable as a phone app |
| `serve.ps1` | Tiny local web server for testing on Windows |

## Ideas

**Australian sold prices.** TCGplayer is a US market, and Australian sold prices (mostly on
eBay.com.au) can differ a lot. Options, best first:

1. *eBay Marketplace Insights API* — official sold-item data (up to 90 days). It's a Limited
   Release API: apply through the eBay developer program and explain the app; many
   applications are declined or waitlisted. Check it covers the EBAY_AU marketplace.
   (eBay's normal Browse API only returns active listings.)
2. *Paid aggregators* — e.g. PokemonPriceTracker (TCGplayer + eBay sold + Cardmarket,
   graded prices, history) or tcgapi.net (PriceCharting + eBay comps). Check whether they
   can filter eBay sales to Australia before paying.
3. *Scraping eBay AU sold listings* — works technically but is against eBay's terms and
   gets blocked; not suitable for the public app.
4. *Stopgap* — hand-check eBay AU sold prices for a sample of cards in a few price bands
   and apply the typical AU ÷ TCGplayer ratio per band.
