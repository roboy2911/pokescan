# Review log — hourly improvement runs (8–9 Oct 2026)

Every change is its own commit, so anything can be taken out on its own. Tell Claude
"remove <name>" (it runs `git revert <commit>`), or do it yourself with that command.

## Candidate ideas

- **Want list** (owner-approved): star cards/sealed you're chasing, with optional target
  prices and a flag when they drop to it. ("Cost to finish" part done in the 6pm run.)
- Shareable trade / sell list — done in the 4pm run.
- Card condition — done in the 5pm run.
- Collection value over time + "Your movers" — done in the 8pm run.
- **Full-screen scan view** (owner request) — planned for the 7pm run: camera fills the screen,
  see-through tab bar, see-through bottom panel (card, price, finish, Add) with "Not it?"
  matches swiping sideways; panel doesn't scroll up/down; tap the card for the full sheet.
- **Japanese cards** (owner request: scan + search + prices, all sets) — planned over the 9pm
  (card list), 10pm (scanning index), 11pm (prices, search, Sets) and 12am (finish + test) runs.

## 3pm Thu — run 1

- Bug sweep: all tabs, sealed sheet, search, backup/restore, offline and the daily price job
  checked in headless Chromium — no bugs found.
- **Feature: Bulk add mode** — `7c30b9f`. Camera toggle (stack icon): every card found with
  confidence is added to the collection automatically (remembered finish), scanning carries on;
  a bar shows the session's count/value, the last card ("Pikachu ×2") and **Undo last**.
  Duplicate guard: the card just added is ignored while in view; it re-arms after ~1 s / 3+
  frames without it and ≥2 s after adding, so a second copy swapped in is still added.
  Tested: held 20 frames → 1; card, gap, card → 2; A then B → both; one glitchy frame → 1.
  *Remove:* "remove bulk add" (`git revert 7c30b9f`).

## Owner request (between runs)

- **Feature: "Check AU sold prices on eBay" button** — in the card sheet (follows the finish
  you pick: reverse holo, Master Ball pattern, 1st edition…), the sealed sheet, and as
  "AU sold ↗" on the scan result. Opens ebay.com.au sold + completed listings, located in
  Australia, newest first, searching the number as printed ("4/102", "025/165", "SWSH020").
  Works because you're signed in to eBay in your browser. *Remove:* "remove AU sold button" (`git revert f54012a`).
- **Feature: Release calendar** (owner request) — `33a4e3e`. Top of the Sets tab: upcoming sets
  (Delta Reign, 6 Nov) and ones out in the last 45 days, with each product's release date,
  market/presale price in AUD and "+x% over RRP". Built daily into `data/releases.json`.
  *Remove:* "remove release calendar" (`git revert 33a4e3e`).

## 4pm Thu — run 2

- Bug sweep: all tabs, search, sets, release calendar, backup/restore — passing.
- **Fix: a card's price could land in the next sheet opened** — `301edfb`. Opening a card
  sheet and quickly another sheet put the first card's price into the new one (and threw
  an error). Late prices for an older sheet are now ignored.
- **Feature: Shareable trade / sale list** — `9139840`. "For trade / sale" switch in any
  collection item's sheet; "⇄ Trade / sale list" in the Collection's set filter with total,
  "list at N% of market" and **Share list** (ready-to-paste text with A$ prices, ×2 … each,
  total). *Remove:* "remove trade list" (`git revert 9139840`).

## 5pm Thu — run 3

- Bug sweep: all tabs, search, bulk add (all five cases), scan flow, trade list,
  backup/restore — passing, no bugs found.
- **Feature: Card condition** — `d870859`. "Your copy's condition" chips (NM / LP / MP / HP /
  DMG) in a collection item's sheet. Non-NM copies are valued at a share of market (LP 85%,
  MP 70%, HP 50%, DMG 30%), with a note like "Lightly Played: valued at 85% = A$1,183.61
  each"; tiles show "Holo · LP" and the trade list adds the condition. Copies in different
  conditions are kept as separate entries (changing one to match another merges them).
  Existing collections are all NM, so they look and add up exactly as before; backups keep
  the condition. *Remove:* "remove condition" (`git revert d870859`).

## 6pm Thu — run 4

- Bug sweep: all tabs, sealed sheet, search, bulk add, condition, trade list, backup/restore,
  offline, scan flow; price Action last ran fine — passing, no bugs found.
- **Feature: Cost to finish a set** — `3a7943e`. Under the progress bar on a set page: "To finish:
  101 missing ≈ A$1,860 + 1 unpriced", using each missing card's cheapest finish; when the set
  has secret rares it also shows the main set alone ("main set (128): A$82").
  *Remove:* "remove cost to finish" (`git revert 3a7943e`).

## Owner request (Thu evening) — AU sold prices

- **Feature: AU sold prices as the main price** — `46bf34d`. Paid SoldComps key (owner's) behind a
  Cloudflare Worker (`tools/au-sold-worker.js`, deployed from `wrangler.jsonc`; key is a Cloudflare
  secret). Opening a card/sealed sheet looks up eBay.com.au sales **by Australian sellers**, last 90
  days, without graded/other-language/lot/custom listings and outliers; ≥3 sales → the median
  replaces the main price ("AU sold price", range, recent sales, TCGplayer in the note). Saved on the
  device 3 days (and in the worker's KV 3 days); collection value and trade list use it where known.
  Worker caps at 400 searches/day. *Remove:* "remove AU sold prices" (`git revert 46bf34d`; the worker can
  stay or be deleted in Cloudflare).
- **Feature: AU sold price on the scan result** — `b4af18c`. Same as the card sheet; bulk mode uses saved answers only (no searches). *Remove:* `git revert b4af18c`.
- **Tweak: AU sold prices kept 14 days** (was 3), on the phone and in the worker — `598074d`. *Remove:* `git revert 598074d`.

## 8pm Thu — run 6

- Bug sweep: all tabs, sealed sheet, search, bulk, condition, trade, backup/restore, offline,
  scan flow, AU sold — passing except the Market bug below.
- **Fix: Market tab put Sun & Moon / Sword & Shield / Scarlet & Violet cards under "Sealed"**
  — `669d522`. Sealed product keys are "s" + a number, but card ids like `sv8pt5-161` start with
  "s" too, so those cards were listed as sealed and missing from Cards. Fixed in
  `tools/market.mjs` and the app; market data rebuilt.
- **Feature: Collection value over time + "Your movers"** — `98324b7`. In the value card: 1 / 7 / 30
  day switch, "−A$3.84 since 6 Oct ▼ 0.1%" (honest "since 6 Oct" while history is short), a
  small line chart of the daily total, and "Your risers / fallers" (top 5 each, tap to open).
  From TCGplayer history × quantity × condition; hidden when the collection is empty.
  *Remove:* "remove value over time" (`git revert 98324b7`).

## Owner request (Thu evening) — AU sold pre-check (10,000 credits/month plan)

- **Feature: nightly AU sold pre-check for every single worth A$50+** — `6fe981c`. New GitHub job
  "AU sold prices" (05:15 AEST, `tools/au-sold-precheck.mjs`) checks ~275 of the ~3,850 singles
  worth A$50+ (each finish separately) each night, so each is re-checked about every 2 weeks, and
  writes `data/au-sold.json`. The app reads it: those cards open with their AU sold price
  instantly. Live lookups (cards not on the list) are capped at 50/day; total ≈ 9,750/month.
  Sales filter shared with the worker (`tools/au-sold-filter.mjs`). Test run: 10 cards OK.
  *Remove:* "remove AU pre-check" (`git revert 6fe981c`, and delete the workflow run history if wanted).
- **Fix: Gold Star cards searched as "Gold Star"** (not ★, δ dropped) — `162809f`.

## 9pm Thu — run 7 (Japanese 1/4)

- Bug sweep: regression scripts passing.
- **Fix: daily price job names the app in its requests** — `f3f7f16`. TCGCSV now blocks Node's default
  user agent (401 "Your User-Agent has been blocked"); yesterday's GitHub run still worked, but this
  keeps the TCGplayer, sealed and new-set prices from silently dropping out. *Remove:* `git revert f3f7f16`.
- **Feature: Japanese cards (1/4): card list** — `a735cf7`. `tools/build-ja.mjs` →
  `data/cards-ja.json` (**24,961 cards, 401 sets, all with a picture**; ids `ja:<set>-<number>`,
  same row shape as cards.json plus the Japanese name) and `data/ja-tcgmap.json` (TCGplayer product
  per card and finish, for prices). Not used by the app yet. Rebuild: `node tools/build-ja.mjs` (~6 s).
  - **Sources:** TCGdex's Japanese API is reachable but incomplete — 68 of its 184 sets have no card
    list (most of XY, Sun & Moon, early Sword & Shield) and only ~3,900 cards have images. So the main
    source is TCGplayer's Japanese catalogue (TCGCSV category 85, 460 groups: English names, numbers,
    rarities, photos, Mirror Foil / Master Ball printings); TCGdex adds Japanese names and real release
    dates where it covers the set (9,267 cards).
  - **Mapping:** by set code (TCGCSV abbreviation ↔ TCGdex id) and card number; 120 of TCGdex's 184
    sets match. Prices map 1:1 (the cards come from TCGplayer's own list).
  - **Blockers / to do:** 130 sets (mostly vintage/promo groups without a set code) are filed under
    "Other" — group them better in part 3. Pictures are TCGplayer photos (400 px), fine for the index.
  - **Next (10pm, part 2):** fingerprint the 24,961 pictures with fingerprint.js into a separate
    `data/index-ja.bin` the app loads after the English index; check English accuracy is no worse.
  - *Remove:* "remove Japanese cards" (revert the Japanese commits, newest first).
