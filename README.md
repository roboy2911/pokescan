# PokeScan

Scan a Pokémon card with your phone or computer camera and identify it.
One codebase: works in any browser and installs to your phone's home screen like an app (PWA).

## How it identifies a card

1. **Crop** the card using the yellow on-screen frame.
2. **Read text** on-device with [Tesseract.js](https://tesseract.projectnaptha.com/):
   the name (top) and the collector number (bottom corners, e.g. `025/198`).
3. **Find candidates** in [pokemontcg.io](https://pokemontcg.io) by number + set size,
   or by name. OCR misreads are corrected against the list of every Pokémon name
   (from PokéAPI), e.g. "Chavizarvd" → Charizard. If pokemontcg.io is slow or down,
   [TCGdex](https://tcgdex.dev) is used instead.
4. **Compare artwork**: every candidate's image is shrunk to a tiny colour fingerprint
   and compared to the photo. Best visual match wins. This is how commercial scanners
   work too, and it's what makes full-art cards (unreadable text) work.

Nothing is uploaded anywhere: OCR and image matching run on the device.

## Run it on your computer

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080. (Any static file server works. The app is plain HTML/JS, with no build step.)

## Get it on your phone

The live camera only works over **HTTPS**, so host the folder somewhere free:

- **Netlify Drop** (easiest): go to https://app.netlify.com/drop and drag this folder in.
  You get an `https://…netlify.app` link. Open it on your phone, then
  *Share → Add to Home Screen* (iPhone) or *⋮ → Install app* (Android).
- Or GitHub Pages / Cloudflare Pages.

## Tips for good scans

- Fill the yellow frame with the card, held flat, in even light (avoid glare on holos).
- If it isn't sure, it shows a list of best guesses. Tap the right one.
- "What the scanner read" (under the buttons) shows the crops and raw text, which is handy for debugging.
- The **Search** tab lets you look a card up by name/number manually.

## Optional: pokemontcg.io API key

Without a key, pokemontcg.io is rate-limited and sometimes slow. Get a free key at
https://dev.pokemontcg.io and paste it into `PTCG_API_KEY` in `app.js`.

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout (Scan / Search / History tabs) |
| `app.js` | Camera, OCR, card lookup, artwork matching, history |
| `style.css` | Styling (mobile-first, dark) |
| `manifest.json`, `sw.js`, `icon.svg` | Makes it installable as a phone app |
| `serve.ps1` | Tiny local web server for testing on Windows |

## Next up: prices

Confirmed scans are saved in **History** (on the device) with the card's set, number and ID,
ready for a pricing step (eBay AU sold listings) later.
