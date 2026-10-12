# Review log — hourly improvement runs (8–9 Oct 2026)

Every change is its own commit, so anything can be taken out on its own. Tell Claude
"remove <name>" (it runs `git revert <commit>`), or do it yourself with that command.

## ☀️ Morning summary (7am Fri 9 Oct)

Everything is live on the site. The full test suite passed on every run, including the last one at 7am
(all tabs, sealed, search 11.5 ms, backup/restore, offline, AU sold, Japanese, full-screen scan at
390×844 / iPhone SE / desktop), with no page errors. To remove anything, run `git revert <hash>`, or tell
Claude "remove <name>".

**Features**
- Bulk add mode (scan stacks/binders, Undo last) — `7c30b9f` → `git revert 7c30b9f`
- "Check AU sold prices on eBay" button *(your request)* — `f54012a` → `git revert f54012a`
- Release calendar in Sets *(your request)* — `33a4e3e` → `git revert 33a4e3e`
- Shareable trade / sale list — `9139840` → `git revert 9139840`
- Card condition NM/LP/MP/HP/DMG — `d870859` → `git revert d870859`
- Cost to finish a set — `3a7943e` → `git revert 3a7943e`
- AU sold price as the main price (SoldComps via Cloudflare Worker) *(your request)* — `46bf34d` → `git revert 46bf34d`
- AU sold price on the scan result — `b4af18c` → `git revert b4af18c`
- Collection value over time + "Your movers" — `98324b7` → `git revert 98324b7`
- Nightly AU sold pre-check for A$50+ singles *(your request)* — `6fe981c` → `git revert 6fe981c`
- Japanese cards (scan + search + prices, 24,961 cards) *(your request)* — `7a76dec` `62854e2` `8dfe9d9` `a735cf7` → revert all four, newest first
- Full-screen scan view on phones *(your request)* — `65ac929` → `git revert 65ac929`

**Fixes**
- A card's price could land in the next sheet you opened — `301edfb` → `git revert 301edfb`
- AU sold for sealed skips multi-item/vague listings — `d87aff1` → `git revert d87aff1`
- AU sold lookups faster and never doubled — `f197913` → `git revert f197913`
- Market tab listed SM/SWSH/SV cards as sealed — `669d522` → `git revert 669d522`
- Gold Star cards searched as "Gold Star" — `162809f` → `git revert 162809f`
- Daily price job names the app (TCGCSV blocks Node's default user agent) — `f3f7f16` → `git revert f3f7f16` (not recommended)
- Classic Collection reprints vs originals in AU sold — `2d7823e` → `git revert 2d7823e`

**Tweaks**
- AU sold prices kept 14 days (was 3) — `598074d` → `git revert 598074d`
- AU pre-check can be paced and stops cleanly — `370161b` → `git revert 370161b`
- Full-screen panel fits short phones (iPhone SE) — `28eecc5` → `git revert 28eecc5`
- Header counts the Japanese cards — `cf78ac0` → `git revert cf78ac0`

**Still to check / your call**
- Tonight's scheduled "Update prices" and "AU sold prices" jobs hadn't started by 7am (GitHub runs
  them late; the last two days they started 22:45–23:15 UTC = 8:45–9:15am AEST). It will be the first
  run of the Japanese price step, so check it went green.
- AU sold: should sales far below the TCGplayer price (e.g. under 35%) be ignored? That would stop
  reprint sales dragging down vintage originals (e.g. A$412 from 3 sales).
- SoldComps: the 429 reply said `"plan": "free"` — check the 10,000 credits are on this key, and
  whether they're monthly or one-off.
- Not done: want list, Japanese sealed product, Japanese cards in Market movers.

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

## AU sold — full pre-check (owner request, Thu night)

- Full run (60/min): **3,228 checked → 1,611 priced, 1,617 too few Australian sales**, 23 failed
  (SoldComps "upstream blocked" / scrape errors). Stopped at 55 min on SoldComps' 60/min rate limit
  (its retries count too) — the rest is being finished at 50/min (656 cards). Credits used ≈ 3,900.
- Note: SoldComps' rate-limit reply says `"plan": "free"` — worth checking on the SoldComps
  dashboard that the 10,000-credit plan is attached to this key.
- **Fix: Classic Collection reprints vs originals** — `2d7823e`. Base Set Charizard 4/102 was priced from
  Celebrations / 30th Celebration reprint sales (A$285), and the reprints were searched as "4/25".
  Reprints now search the original's printed number and count only their own sales; the 53 reprinted
  originals ignore reprint sales. *Remove:* `git revert 2d7823e`.

## 10pm Thu — run 8 (Japanese 2/4)

- **Feature: Japanese cards (2/4): scanning index — built, not switched on** — `8dfe9d9`.
  `data/index-ja.bin` (6.6 MB; the English index is 5.4 MB): 24,961 rows, same format as index.bin,
  built by `tools/build-index-ja.mjs` with fingerprint.js exactly like the English one, from TCGplayer
  photos (200 px; 415 MB downloaded, ~8 min; fingerprinting 2 min). 995 cards have no photo (empty row).
- **Accuracy (testHard, n=60, seed 5, real images)** — English only / + Japanese in every scan /
  + Japanese only when English isn't sure ("two-step"):

  | | English | + Japanese | two-step |
  |---|---|---|---|
  | clean | 57 (0 wrong-conf.) | 58 (0) | 58 (0) |
  | glare | 56 (1) | 55 (2) | 55 (2) |
  | streak | 47 (3) | 44 (2) | 47 (3) |
  | sleeve+streak | 45 (1) | 43 (2) | 42 (3) |
  | toploader | 51 (2) | 49 (1) | 51 (2) |
  | finger | 58 (0) | 57 (0) | 57 (0) |
  | dim+glare | 52 (2) | 46 (4) | 48 (5) |
  | sleeve+glare+finger | 51 (1) | 49 (3) | 51 (1) |

  Both ways make English scanning worse in hard light, so the app doesn't load it yet.
  Japanese-only (30 cards, Japanese preferred): clean 24/29, glare 28/29, sleeve+streak 17/28, no
  wrong-confident answers.
- **What's left:** switch it on behind a **"Scan Japanese cards"** toggle on the Scan screen (off by
  default → English scanning exactly as now; on → Japanese and English searched together, the
  preferred language first, the other print offered as its twin). Loader written and saved
  (`scratchpad/ja-scan-loader.patch`: worker loads index-ja.bin after start-up and swaps it in; app
  folds JA/EN twins of the same name within 0.03). To do in the 11pm / 12am runs with part 3.

## 11pm Thu — run 9 (Japanese 3/4)

- **Feature: Japanese cards (3/4): prices, search and sets** — `62854e2`.
  - **Prices:** `tools/prices-ja.mjs` → `data/prices-ja.json` (21,430 of 24,961 cards priced by
    TCGplayer Japan, 0.8 MB, **~5 s** — the daily job stays well under 25 min). Downloaded only when a
    Japanese card is priced. Not in market history yet (movers/highs stay English).
  - **Search:** "pikachu jp", "terastal jp", "ピカチュウ" find Japanese cards; plain English queries
    search the English cards only (same speed as before: 27 ms per filter, 11 ms in the search test).
  - **Sets:** "Japanese · Scarlet & Violet", "Japanese · Mega", … after the English series
    ("Japanese · Other / Promos" last — 130 vintage/promo groups without a set code).
  - **JP badge** (results, set pages, collection, card sheet + Japanese name); collection, backup,
    trade and condition keep the language. **AU sold** for Japanese cards searches "… Japanese" and
    only counts sales that say Japanese (worker mode `ja`).
  - Not done: scanning Japanese cards (switch planned for 12am), Japanese sealed product, Japanese
    cards in Market movers.
  - *Remove:* "remove Japanese cards" (revert the Japanese commits, newest first).

## 12am Fri — run 10 (Japanese 4/4)

- **Feature: "Scan Japanese cards" switch** — `7a76dec`. **JP** button with the camera controls, off by
  default and remembered. Off → English index only, results identical to before (checked on the
  upload path). On → loads `index-ja.bin` once (~1.3 s here) and searches both; a Japanese print and
  the English print of the same artwork fold into one match (Japanese first, English first in
  "Not it?"). Upload tests with it on: Japanese Leafeon ex and Charizard ex (151) found with their
  English prints offered; Budew (two Japanese prints, same art) → "same artwork in more than one
  set". JP badge on the scan result too.
- Checked: all tabs, search (12 ms per search, as before), Sets, card sheet prices, collection,
  backup, trade, condition, offline, AU sold, scan flow — no errors. English start-up unchanged:
  cards-ja.json (3.1 MB) loads 3 s after start; prices-ja.json and index-ja.bin only when needed.
  The daily price job runs the Japanese part in ~5 s, wrapped so it can't break English prices.
- **All Japanese commits** (remove with "remove Japanese cards" = `git revert` newest first):
  `7a76dec` (scan switch) · `62854e2` (prices, search, Sets, badges) · `8dfe9d9` (scanning index) ·
  `a735cf7` (card list). Separate fix kept either way: `f3f7f16` (price job user agent).
- Not done: Japanese sealed product; Japanese cards in Market movers / price history.

## 1am Fri — run 11

- Bug sweep: all regression scripts pass (smoke, ui, backup, trade, bulk, condition, offline, AU sold,
  pre-check, value trend, scan flow, search, Japanese search and scan switch).
- **Feature: full-screen scan view on phones** (owner request, moved from the cancelled 7pm run) —
  `65ac929`. Camera fills the screen behind a floating header and see-through tab bar; results in a
  see-through bottom panel (card, price, finishes, Add / Scan next) whose strips scroll sideways; the
  panel never scrolls up/down and the page doesn't scroll (checked: page height = screen height).
  Camera buttons move to the top right; card guide stays card-shaped above the panel. Desktop
  (≥ 700 px wide) and the other tabs unchanged. *Remove:* "remove full-screen scan" (`git revert 65ac929`).

## 2am Fri — run 12

- Bug sweep: regression passing; checked the new full-screen scan view at 390×844, 375×667 and
  1280×800 (desktop unchanged).
- **Tweak: full-screen scan panel fits short phones** — `28eecc5`. On an iPhone SE the "Not it?" strip was
  cut off and "Add to collection" wrapped; screens up to 740 px tall now get a tighter panel.
  *Remove:* `git revert 28eecc5`.

## 3am Fri — run 13

- Bug sweep: full regression passing (14 scripts), no bugs found.
- **Tweak: header counts the Japanese cards** — `cf78ac0`. "20,583 cards · 24,961 JP" once they've loaded.
  *Remove:* `git revert cf78ac0`.

## 4am Fri — run 14

- Bug sweep: full regression passing (15 scripts, search 12.6 ms), no bugs found, no changes.

## 5am Fri — run 15

- Bug sweep: full regression passing (15 scripts, search 12.1 ms), no bugs found, no changes.
- Price Action: today's scheduled "Update prices" (18:30 UTC) hasn't started yet. GitHub queues scheduled jobs late (yesterday's started 23:14 UTC), so it's the first run with the TCGCSV user-agent fix and Japanese prices — check its log in the morning.

## 6am Fri — run 16

- Bug sweep: full regression passing (15 scripts, search 10.7 ms), no bugs found, no changes.
- Price Action: still not started (both "Update prices" and "AU sold prices" are queued late by GitHub). Tried the Japanese price step locally; this sandbox blocks Node from reaching TCGCSV (its own network allowlist, not TCGCSV — curl gets 200), so the Action log is the real test.

## 7am Fri — run 17 (final)

- Bug sweep: full regression passing (15 scripts + full-screen layout at 390×844, 375×667, 1280×800), no bugs found, no changes. Morning summary written at the top.

## Owner report (Fri morning) — wrong AU prices

- **Fix: AU sold prices counted other cards' sales** — `b0921aa`. Charmander SVP 044 showed A$7.49, made of a Geodude 44/64, an Ivysaur 44/130 and a Graveler 44/110. The filter never checked the name, and a promo's bare number matched any "44". Now the title must contain the card's name and a bare number must stand alone ("SVP 044", "#44"). The 87 saved promo answers were removed (tonight's pre-check redoes them first); the worker and phone caches were reset. *Remove:* `git revert b0921aa`.

- **Fix: rare cards fell back to a bad TCGplayer price** — `74b441b`. Umbreon ★ (POP 5) showed ~A$75 (pokemontcg.io has a bad US$51.99; 1 Australian sale in 90 days). With fewer than 3 Australian sellers' sales the worker now also counts overseas sellers on eBay.com.au (still AUD); 1–2 sales show as "Last sold (eBay AU)". Searches leave out PSA/CGC/BGS slabs; reprinted originals leave out Celebrations/Classic Collection and must name their set; DIY/"inspired"/AGS/Italian listings are junk. Pre-check unchanged (Australian only, same credits). Real worldwide test: Umbreon ★ → A$300.16 (the one POP 5 copy). *Remove:* `git revert 74b441b`.

## Owner request (Fri morning) — pause SoldComps credits for 2 weeks

- **All SoldComps searches paused until 23 Oct 2026** — `66c4e92`. Nightly "AU sold prices" schedule removed (manual only); `tools/au-sold-precheck.mjs` exits before searching until then; the worker has `PAUSED_UNTIL` in `wrangler.jsonc` (saved answers still served, no new searches; app says "New Australian sold lookups are paused for now" and shows TCGplayer). Checked live: worker answers "paused". The 87 promo and 32 original answers removed earlier stay unpriced (TCGplayer) until the pause ends. *Undo:* put the cron back in `au-sold.yml`, remove `PAUSED_UNTIL` from `wrangler.jsonc` and the script.

## 10am Fri — price job check (no SoldComps)

- "Update prices" ran at 23:29 UTC (9:29am AEST) and passed: 20,554 cards, 1,633 sealed, market history 6–8 Oct, and the first daily **Japanese prices: 21,407 cards** (the user-agent fix works). Committed `e067103`.
- No "AU sold prices" run happened (schedule removed; SoldComps paused until 23 Oct). No credits used.

## Owner request (Fri) — fixes and developer mode

- **Fix: app wouldn't start with an ad blocker ("FP is not defined")** — `1c6e4e6`. `fingerprint.js` renamed to `cardprint.js` (blockers block that name). *Remove:* `git revert 1c6e4e6`.
- **AU sold worker accepts the Cloudflare Pages copy** (`pokescan*.pages.dev`) — `6f862b9`.
- **Feature: hidden developer mode** — `311bf61`. Tap the "PokeScan" title 7 times quickly, then the PIN. Scan tuning (match score, lead, lock-in frames, bulk timing, score overlay), data tools (clear AU answers / live prices / offline cache, reload data, export debug info), status panel. This device only; a small dot by the title while scan settings differ from normal. *Remove:* `git revert 311bf61`.
- **Tweak: no double-tap zoom or sideways scrolling on phones** — `9529319`. Double-tap zoom off (pinch still works), page can't slide sideways, phone text boxes 16px so iPhones don't zoom in on tap. *Remove:* `git revert 9529319`.
- **Feature: AU sold prices count near-mint copies only** — `c3a6753`. Sales whose title or eBay condition says LP/MP/HP/DMG, played, creased, bent, water damage etc. are left out ("never played", "no creases", "120 HP" still count). Saved answers update as they are re-checked (after the pause). *Remove:* `git revert c3a6753`.
- **Tweak: scan much better through toploaders** — `e6f7ccb`. Outlines are also cropped where a card sits in a toploader (~83% size, low / off to one side). testHard 60 real cards: realistic toploader 48→58 right (0 wrong-confident), toploader+glare 42→48, wrong-confident over the standard 8 sets 11→7; ~10% slower per frame. Marker writing on sleeves already barely affects scanning (57/60 vs 58 clean); an ink-masking idea was tried and dropped (+1–2 cards, 30% slower, more wrong answers in dim light). Simulator: `94529fc`. *Remove:* `git revert e6f7ccb`.
- **Live AU sold lookups back on** — `82449b1` (only the nightly re-check stays paused until 23 Oct).
- **Fix: white playmat recognised as random cards** — `6760e9b`. Plain areas (few edges / no colour variation / nothing left outside a reflection) are no longer matched. Empty white mat: 4–7 false finds per 40 frames → 0 in normal light. *Remove:* `git revert 6760e9b`.

## Owner request (Fri) — heavy toploader glare (a few hours)

- **Tools:** `09bde20` — realistic heavy toploader glare (`tlglare`: see-through sheen, light bands, hot spot) and live multi-frame scans with card swaps in `tools/sim.js`.
- **Tweak: see past heavy toploader glare** — `d736abb`. Glare memory (live camera combines the last 8 lined-up views, block by block, newest unless glared), veil removal ("dark channel"), combined-view lock rule (0.86 / 0.03, two frames), and a "Glare on the card — tilt it slightly" hint. Simulated live scans, 40 cards × 8 frames with swaps, right lock-ins old → new (all 0 wrong): toploader + heavy glare 2 → 17, sleeve + heavy glare 2 → 10, card + heavy glare 5 → 22, toploader + glare + writing 0 → 12; normal conditions unchanged. Real app with a fake camera: old locked a wrong card (Lugia); new asks for a tilt and offers the right card (Luxio) first. ~18% slower per frame. *Remove:* `git revert d736abb`.
- Follow-up idea: a card held much bigger than the yellow box (~1.75×) with heavy glare can still lock a wrong card (old version too) — a "move back a little" hint / bigger search sizes.

## Owner request (Sat) — login and account sync

- **Feature: log in to use the app; collection saved to your account** — `df94bae`. Login / sign-up screen (anyone can sign up, username + password), stays logged in per device, collection synced via the Cloudflare worker (merge across devices), Log out in Collection → •••. Password never sent (PBKDF2 on the phone); only hashes stored. Verified live: the worker answers the new account endpoints. *Remove:* `git revert df94bae` (accounts stay in KV, harmless).

## Owner request (Sat) — "Couldn't load the card database: Load failed"

- **Fix: app sometimes failed to load on open** — `009c2d3`. Cause: the app downloads its card data the instant it opens, often before the phone's connection has woken up, and gave up on the first failure. Now each data file is retried (0.5 → 6 s, ~14 s total, waits for the connection to come back), the service worker keeps a copy of the data files that app updates don't wipe (and uses it if the network is slow/failing), and if it still can't load there's a **Try again** button instead of reopening the app. Offline, retries stop quickly so search doesn't hang. Tested: 1, 2 and 4 failed downloads in a row → loads with prices; offline reload → loads and searches. Regression (smoke, e2e, UI, account tests) unchanged. *Remove:* `git revert 009c2d3`.

## Owner request (Sat) — the to-do list, price-check rules

- **AU sold: 500 searches a day; never checked on a schedule** — `db075b4`. Owner: "DO NOT CHECK PRICES NIGHTLY"; one-off SoldComps credits (18,000 left). The pre-check workflow is manual-only and searches nothing without a budget; the 23 Oct reminder was deleted. Worst case 500/day uses the credits in ~36 days (in practice far less — only cards someone opens, each answer kept 14 days). *Undo the limit:* `DAILY_LIMIT` in `wrangler.jsonc`.
- **Feature: search promos by printed code** — `9fefc07`. "charmander svp 044", "svp044", "swsh020", "sm 60" find the promo (promo set first); promos show "SVP 044" instead of "#44/102". *Remove:* `git revert 9fefc07`.
- **Feature: want list, automatic backups, "move back" hint** — `ffb86c8`.
  - Want list: ☆ in any card / sealed sheet, optional AUD target; Collection → Want list with today's price, ✓ at target, "lowest this month"; a one-time message (and a dot on Collection) when one hits its target. Synced with the account.
  - Automatic backups: daily copy on the phone (7 kept) + before "Remove everything"/restore; the account keeps each day's starting point 30 days (worker `/backups`). Collection → ••• → Automatic backups → tap to restore. Tested: worker (backup made before the day's first change, old app without wants keeps them), two-device want sync incl. delete, restore after "Remove everything".
  - "Too close — move back so the whole card fits in the box": when the biggest outline in the guide is under 0.8 of the box for two frames. Simulated: never in normal scans (0 of 320 frames); shows on ~45% of frames of a card held 1.45–1.8× the box. Matching itself unchanged.
  - *Remove:* `git revert ffb86c8` (account backups expire on their own).
- **Feature: Japanese sealed product + Japanese Market tab** — `0b8401a`. ~280 Japanese sealed products (all TCGplayer lists), searchable ("jp booster box"), on set pages, in collection/want list; Market tab English/Japanese switch (history from 8 Oct; Japanese sealed movers appear after a few days). *Remove:* `git revert 0b8401a`.

## Owner request (Sat) — AI card grader

- **Feature: card grader** — `d6094aa`. Owner chose: free on-phone checks first, both an estimated PSA grade and NM/LP/MP, 4 guided photos, report only (not saved). Card sheet → 🔍 Grade this card.
  - Tested on simulated photos (official images with known flaws, photographed at an angle): outline within ~0.5 px; centering within ~0.05 mm of the truth on 5 cards × 4 miscuts (ratio error < 1 point, borders down to 0.7 mm); edge whitening 1 mm specks and 6–8 mm stretches found, clean edges 0%; whitened and chipped corners found, clean corners clear; a 1 mm mark found on 3/3 cards with 0 false spots; scratches found on 3/3, 0 false on clean cards. Whole report ~4 s.
  - Limits (said in the app): silver-bordered fronts can't show edge whitening (judged on the back); a pale table makes chips and whitening look alike; holo foil hides scratches; Japanese cards have no official image to compare (marks unchecked, scratches against the front photo). Not yet tried on real photos of damaged cards — worth a few test grades of cards with known PSA grades to tune.
  - *Remove:* `git revert d6094aa`.

## Owner feedback (Sat) — grader called a heavily damaged card LP and an NM card LP

- **Fix: grader accuracy, scale, photo checks, shine shots** — `37c53a0`.
  - Cause 1: wear could only cap the grade at PSA 5 (= LP), so heavy damage could never be HP. Now each area (centering, corners, edges, surface) is scored 1–10 and flaws add up → PSA 1–10, NM / LP / MP / HP (DMG only for structural damage).
  - Cause 2: real-photo effects read as wear (edge blur on light tables, glossy reflections, corner shape, uneven light, shadows). Reproduced with realistic simulated photos (wood / light / dark tables, blur, JPEG, vignette, colour cast, shadow, glossy streak, low-res): before, NM → LP and HP → LP; now NM → NM (PSA 8–9), LP → LP (5–6), HP → HP — 38/39 photos the app accepts; light-table photos it can't measure exactly now ask for a retake.
  - Photo checks before using any photo (retake with the reason): outline self-check, whole card in view, size, focus, light, glare, phone angle, right side, right card; upside-down / sideways cards are turned round automatically. Live guidance on the camera.
  - Shine shots: explained with a picture ("scratches only show inside a reflection"), live reflection meter, and a check that the photo actually has a reflection.
  - "Help make it more accurate" on the report: sends the photos + the owner's verdict to the worker (`/grade-sample`, 60 days, code to pass on) so the grader can be tuned on real cards.
  - *Remove:* `git revert 37c53a0`.

## Owner request (Sat) — buy recommendations in developer mode

- **Feature: Developer mode → Buy ideas** — `27412ba`. Owner chose: cards and sealed, any price, English only, safer and riskier picks labelled. Built daily by `tools/picks.mjs` (in the price job) into `data/picks.json`: 60 cards (max 3 per set) and 40 sealed (max 2 per set), each with reasons. Signals: cheapest TCGplayer listing vs recent sales (supply), trend since 6 Oct, rarity, popular Pokémon, collector-favourite sets, set age / print run, sealed vs AU RRP; thin markets flagged unreliable. Price history is only days old, so trends count little until it builds up. Not financial advice. *Remove:* `git revert 27412ba`.
- **Buy ideas: AU sold tab** — `323eb6f`. A third tab ranking 50 cards on Australian sold prices: the saved `data/au-sold.json` (~1,800 cards, checked to 8 Oct) plus every card looked up in the app from now on (the worker keeps a compact copy with recent sale dates → `/au-export`; read by the daily job, no SoldComps credits). Signals: cheaper here than the US market, sales per 90 days, price steadiness, recent AU sales trend, rarity / popularity / set age. *Remove:* `git revert 323eb6f`.
- **Buy ideas: max price filter** — `51211c2`. Budget box + chips, remembered; bigger daily lists so a low budget still finds picks (under A$50: 40 cards, 21 AU-sold cards, 3 sealed). *Remove:* `git revert 51211c2`.

## Owner (Sat) — eBay API key

- **eBay Australia listings** — worker `88c1745` (+ `ca25aef`, deletion endpoint), app `7fe59b8`. Owner added Production keys (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET) and the marketplace-account-deletion endpoint (`/ebay-deletion`, token in EBAY_VERIFY_TOKEN). eBay's free Browse API shows listings, not sales (sold data stays SoldComps). Used for: "For sale now in Australia" on card pages, want-list "Buy now" alerts at or under target, and AU supply / deals in Buy ideas (~220 searches a night; worker cap 3,000/day, answers kept 6 h). Same near-mint / right-card checks as AU sold (graded-slab filter widened: ARK, MNT, PCA, GMA, HGA, KSA).
- Note: one test request ran before the new worker was live and went to the old AU sold route — probably 1–2 SoldComps credits. Deploy checks now use a request that can't trigger a search.
- *Remove:* `git revert 7fe59b8` (app); the worker route is harmless unused.
- **Fix: Japanese copies in "For sale now"** — eBay's Language item detail + unmarked listings only if the title names the English set / says English and shows no Japanese signs (sv2a / s8b codes, SAR / CHR / CSR / AR, SV-P, Japanese writing). Live: Charizard ex 201/165 (the Japanese SAR number) 3 → 0; Umbreon VMAX 215/203 keeps all 7 English copies. Each lookup is now 2 eBay searches.
- **Fix: World Championship deck copies** (e.g. Jolteon Gold Star looked "stupidly cheap") — "World Championship", "Worlds 2006", "WCD", "championship deck", "not for tournament play", "gold border" are junk for AU sold and listings. Gold Star cards get fresh AU answers (worker key v6; ≤ 27 cards, a search each when next opened); the phone re-asks its saved AU answers (served from the worker's cache, no searches). Live: Jolteon ★ 101/108 now shows only the real copy (A$8,201).
- **Buy ideas: group surges + Anomalies tab** — `c3367f2`, `4551bdd`. Owner tip: Prism Stars ~7× in days (confirmed: 16 of 19 Pokémon Prism Stars up a median +116% since 6 Oct; Latios ×4.5). Picks now detect groups (rarity / set / one Pokémon) moving together: "Hot right now" banner, "part of a surge — may cool off", catch-up flags for members that haven't moved. New Anomalies tab: group moves and big single moves with a real-or-not note. *Remove:* `git revert 4551bdd c3367f2`.
- **Buy ideas: ⭐ Best tab** — `c302b7a`. Only cards passing every must-have (demand + movement + chased card + liquid market + not new / thin) and ≥ 5 checks, with the ✓ list. Deliberately few (2 today); grows as price history builds. *Remove:* `git revert c302b7a`.
- **Best ideas: catch-up plays + catalyst watch** — `a0f5bbe`. Research: market broadly flat in our data (every set / Pokémon median ≈ 0% since 6 Oct) except Prism Stars (+116% median, +67% on the last day). Japanese Prism Stars haven't moved → catch-up list. Delta Reign (6 Nov) chase = Mega Rayquaza → Rayquaza chase cards listed in `data/catalysts.json` (update by hand as news comes). *Remove:* `git revert a0f5bbe`.

## 2026-10-11 — Buy ideas: research from price-tracking articles
- `data/catalysts.json` now holds hand-checked research with sources (TCGplayer's weekly "Biggest Price Spikes" for 9 Sep, 2 Oct and 7 Oct, plus reprint news): named cards reported climbing, sets / Pokémon / an era on the rise, and sets getting more supply.
- `tools/picks.mjs`: research counts in ⭐ Best ideas (a named card counts as moving; set, Pokémon and 2007–2016 era add a ✓). The new "📰 In the news" list shows the named cards and the top cards of rising sets / Pokémon that haven't moved yet. Supply news adds ⚠ warnings. Research expires after 60 days (supply news after 90).
- Best ideas now has 4 (Charmander Stormfront, Slowking Prime, Gengar LV.X, Gyarados Base Set 2). In the news has 24.

## 2026-10-11 — Buy ideas: early signals and a track record
- **Sell-out watch** (`data/lows.json`): TCGplayer's cheapest copy of each A$10+ chase card is now saved daily (kept 45 days). The app flags cards where the cheapest copy jumped 25%+ but the sold price moved less than 10%, meaning cheap copies are selling out. This needs 3+ days of data, so it's empty until then.
- **Contagion:** when 4+ chase cards of one Pokémon (and a quarter of all of its chase cards) are up 15% or more, the ones that haven't moved are flagged. The same goes for a set whose top card made a real jump (+40–200%, with normal supply). The strict filters drop thin-market spikes such as Houndoom from Aquapolis (+293%).
- **Track record** (`data/pick-log.json`): every list's picks are logged with their price on the day. After 7 and 30 days the dev Best tab shows how many rose and the average change for each list, so we learn which signals actually work.

## 2026-10-11 — AU sold refresh (run 38103828651) and fixes
- The run checked 2,690 cards (997 priced, 1,693 with too few Australian-seller sales) and had 28 failures (SoldComps 503 "search blocked"). That used about 2,700 credits. It stopped after 100 minutes because the script's default time limit was never raised for the 330-minute job, leaving about 1,180 cards unchecked. The workflow now sets `TIME_LIMIT_MIN=320`.
- 314 cards that had a price lost it, because the pre-check only asks Australian sellers while the worker widens to every seller on eBay AU. The pre-check now keeps an earlier price (21 days or newer) instead of wiping it, and records the check date in field [5] so it isn't searched again straight away. The 314 prices were put back from the 8 Oct file.
- The 30th Celebration Mew R/G/B cards (a lone-letter number) searched just "mew g" and matched every Mew sale (A$5,510). They're now skipped.

## 2026-10-11 — AU sold: cracked ice copies excluded
- Theme-deck "cracked ice" versions (for example Espeon / Umbreon from HS Undaunted) are a different, cheaper card, but they were counted in the regular holo's AU price. Espeon 2/90 showed A$39 when only 1 of its 5 recent sales was the real holo (A$53.70). Titles with "cracked ice" now count as junk unless the search itself asks for cracked ice.

## 2026-10-11 — Want list: target = cheapest listing
- The want-list target is now compared only with the cheapest copy for sale on eBay Australia (price + postage), not the market price. Alerts, the ✓ mark and sorting all use it. The row shows the cheapest listing as its price, plus the market price and "none for sale" when there is none. Tested with a mocked listing: A$52.50 against a A$60 target alerts, and against a A$40 target it doesn't.

## 2026-10-11 — Want list: phone notifications (Web Push)
- Collection → Want list now has a "🔔 Turn on phone notifications" panel. On iPhone it needs iOS 16.4+ and the Home Screen app; the panel explains how to add it if needed. Notifications are sent when a want-list item is listed on eBay Australia at or under its target.
- Worker (`tools/push.mjs`):
  - Routes: `/push/key`, `/push/subscribe` (the subscription plus each want's eBay search and target), `/push/unsubscribe`, `/push/test`.
  - Hourly cron (`7 * * * *` in wrangler.jsonc) checks each item with a target via `findListings` (fresh within 54 minutes). It uses only the free eBay Browse API, never SoldComps. `EBAY_DAILY_LIMIT` is raised to 4500 (eBay allows 5,000).
  - Alerts once per price, and again only if a copy gets cheaper or after the price goes back above the target. Subscriptions that are gone (404/410) are removed.
  - The VAPID key pair is made by the worker itself and stored in KV, so there are no new secrets.
- Encryption is RFC 8291 aes128gcm with WebCrypto. It was checked by decrypting with the `http_ece` library, and the VAPID JWT signature was verified. The app flow (subscribe → test → re-sync when a target changes) was tested in the browser with a stubbed push manager.
- The service worker shows the notification. Tapping it opens the eBay listing, or the want list for a summary of several items.

## 2026-10-11 — AU sold refresh finished (run 38117825914)
- The remainder run checked 1,067 cards (418 priced, 649 too few sales) with 5 failures (SoldComps 503) in 35 minutes. The whole refresh (both runs) checked about 3,750 cards and used about 3,790 credits. au-sold.json now holds 3,809 cards, 1,903 of them with a price. ⭐ Best ideas: Charmander (Stormfront), Slowking Prime, Gengar LV.X (A$633 in AU, 12 sales via the wide search), Jirachi ◇.

## 2026-10-12 — AU sold / listings: lettered card numbers
- Lettered numbers (RC32, TG23, SV64, XY126) now have to stand on their own. "Sylveon EX RC21/RC32" no longer counts as RC32, because it's RC21 of 32.

## Prediction research (run 1, 09:05) — niche movers
- Angle: thin or niche cards, with no Australian sales required (the owner's ask). These cards spike when a few buyers clear the cheap copies: the cheapest listing goes above the last sale, and each new sale lands at the new low. That's TCGplayer's account of the Garchomp (Supreme Victors), Tyranitar (Mysterious Treasures) and Zoroark BW19 spikes ([seller blog 10/07](https://seller.tcgplayer.com/blog/price-trends-pok%C3%A9mon-cards-climbing-in-price-10-07-2026)).
- New `nicheMovers` list in `tools/picks.mjs`, shown as "🔎 Niche movers" in the dev Best tab:
  - Card: a niche rarity (promo, LV.X, Prime, LEGEND, Star, Shining, EX-era or secret rare, or a vintage holo), US$15+, set at least 6 months old.
  - Supply: cheapest copy 15–200% above recent sales.
  - Price: up 8–80% with 2+ rising days.
  - Scored on the move, the supply gap, popularity, research matches, the 2007–2016 era and LV.X/Prime/Star rarity.
  - It's tracked in the pick log.
- Today it finds 3: **Arceus LV.X 94/99** (Arceus, US$90, +26%, cheapest copy 27% above sales, none for sale in AU; the same set as Gengar LV.X), Golem 14 (Expedition, +20%) and Mr. Mime-GX 156 (Celestial Storm, +10%). Arceus LV.X also passes the ⭐ Best checks now.

## 2026-10-12 — Cloudflare free-plan storage writes (1,000 a day)
- The owner got Cloudflare limit warnings. The eBay `/listings` lookup made 2 KV writes per search (a daily counter plus the cached answer). The daily buy-ideas run (about 300 lookups), the hourly want-list check and this morning's deal scans (about 600 lookups) used up the 1,000 free writes a day.
- The eBay daily cap is now counted in memory, so there's no write (eBay's own 429 still stops it), and answers are kept in memory first. New `ns=1` ("don't store") is used by `tools/picks.mjs` (both lookups) and the hourly push check. App lookups still store: 1 write per new card a day.
- Remaining writes: app eBay lookups (1 per new card), AU sold searches (3 each, at most 500 a day, and rare), account sync and backups, and push "seen" updates.

## 2026-10-12 — Lugia hype (expected to cool)
- The owner noted Lugia rising on auction news. The sources found are record graded sales, not a $10M sale: 1st Edition Neo Genesis Lugia PSA 10 at $654k (24 Sep), Call of Legends Lugia PSA 10 at $367k (Goldin) and Crystal Lugia PSA 10 at about $360k (about 10 Oct).
- New `kind: 'hype'` in `data/catalysts.json`, used for 30 days. Hype cards are kept out of ⭐ Best and Niche movers, and get a ⚠ "likely to cool" warning (and a riskier label) in every other list. The new "⚠ Hype — likely to cool" section in the dev Best tab lists that Pokémon's cards up 10%+, framed as sell / don't chase. Today: Neo Genesis Lugia 9 (+606%, US$1,135), Lugia HGSS02 (+41%) and Lugia-EX 68 (+31%).

## Prediction research (run 2, 09:57) — Japanese lead
- Angle: do Japanese prices move before English? Over the 3 days of `history-ja.json`, 34 Japanese cards (US$8+) rose 20%+. Most are thin one-sale jumps: promos +300–900%, Oracle (Split Earth) +900%. Japanese TCGplayer prices are too thin to trust card by card.
- Clusters are the better signal: Latios (2 cards, both promos; no news found, English Latios flat) and Lucario (Lucario EX, The Best of XY, +149%; Lucario V starter deck +33%). Lucario fits the expected first English set of 2027, Japan's Aura Seeker, led by Mega Lucario (not officially confirmed).
- New `jpLeads` in `tools/picks.mjs`, shown under "🚀 Early signals":
  - Trigger: 2+ different Japanese cards of one Pokémon (US$10+) up 20–500%.
  - Shows: up to 3 English chase cards of that Pokémon that haven't moved (±10%) and have normal supply.
  - Hype Pokémon are skipped. Every pick is logged in the track record, which will show whether Japan really leads.
- Today: Lucario-GX SV64 (Hidden Fates Shiny Vault, US$86), Mega Lucario ex 188 / 179 (Mega Evolution, US$229 / US$170), Latios ★ 106 (Deoxys) and Latios 203 (Surging Sparks).

## Prediction research (run 3, 10:57) — upcoming reveals (mascot effect)
- Pattern (Kanto Post, Aug 2026): when a new set is revealed in English, older cards of its mascot jump (Rayquaza and Kyogre for Delta Reign, Darkrai before that). The next mascots, from the [Pokénnoisseur release calendar](https://pokennoisseur.ca/tools/release-calendar):
  - Aura Seeker (Mega Lucario Z ex): Japan reportedly 27 Nov 2026; English expected Jan 2027 and not announced yet, so the reveal is still ahead.
  - A speculative Q4 Special Deck Set with Mega Feraligatr, Dragonite and Gengar.
- Added 3 dated `event` items (Lucario, Feraligatr, Dragonite) to `data/catalysts.json`, so 📅 Catalyst watch now lists their chase cards that haven't moved (20 picks). Lucario now has two signals: the mascot event and the Japanese lead from run 2.
- Mega Feraligatr ex and Mega Dragonite ex already exist in Ascended Heroes, a set where TCGplayer reports supply returning. Older cards are the better play.
- Best lead: Neo Genesis Feraligatr 4/111 (unlimited holo). US$204 (≈A$292), flat, cheapest TCGplayer copy 27% above recent sales, AU sold about A$195 (3 sales). The only AU listing is a 1st Edition at A$370. Also Feraligatr 5/111 is listed at A$51.99 against A$195–239 for the other listings (check its condition).

## Prediction research (run 4, 11:57) — do risers keep rising?
- Angle: what happens after a card is reported climbing? I parsed TCGplayer's monthly "Pokémon Cards Climbing in Price" lists ([Jan–Sep 2026](https://seller.tcgplayer.com/blog/price-trends-pok%C3%A9mon-cards-climbing-in-price-01-06-2026), 77 cards) and matched 36 to today's prices (saved in `data/past-risers.json`).
  - **Pre-2020 cards:** 15 of 20 are still higher, median about +30%. Examples: Gengar & Mimikyu-GX alt art (+38% to +78% from each listing), Umbreon Prime (+63%), Garchomp POP 9 (+157%), Judge FA (+92%), Pikachu & Zekrom-GX (+77%).
  - **2021+ cards:** 8 of 16 higher, median about 0%. Crown Zenith, Paldean Fates and Prismatic Evolutions risers gave it back; Evolving Skies alt arts were the exception.
  - Overall 23 of 36 are higher (median +20%). Momentum is real for out-of-print cards.
- `tools/picks.mjs`:
  - Cards list: a pre-2020 riser gets +6 and a reason. A 2021+ riser that isn't a top chase card is marked riskier.
  - ⭐ Best: a pre-2020 card that's moving gets a ✓ check.
  - Niche movers: +6 for pre-2020, −8 for 2021+.
- ⭐ Best now has 5 ideas: Charmander, Slowking Prime, Gengar LV.X, Jirachi ◇ and **Rayquaza-GX 177 (Celestial Storm)**.

## Prediction research (run 5, 12:57) — lasting "theme" Pokémon
- Angle: which Pokémon keep coming back on TCGplayer's monthly risers lists (9 posts, Jan–Oct 2026, 87 entries)? Gengar was on the list in **7 of 9 months** (often Gengar & Mimikyu-GX), Pikachu in 6, Umbreon in 4, and Mew and Giratina in 3 each. That's lasting demand rather than one-off spikes, and it matches run 4 (Gengar Prime +54% and Gengar & Mimikyu +78% since January).
- Added `pokemon` research items for Gengar, Pikachu, Umbreon and Giratina (Mew was already there, now with the count) to `data/catalysts.json`. They give a ✓ in ⭐ Best and fill "📰 In the news" with each Pokémon's chase cards that haven't moved (40 entries now).
- `newsPicks` now lists pre-2020 cards first (run 4: their rises last) and skips Classic Collection reprints (cel25c, me55c), which aren't the original card.

## 2026-10-12 — Daily price update push race
- The 11 Oct 22:14 UTC run failed because its push was rejected: a research commit landed while it ran. The workflow now rebases onto newer commits (its own data wins any conflict in data/) and retries 3 times before giving up.

## Prediction research (run 6, 13:57) — sell-outs (and two pipeline fixes)
- Angle: sell-outs, where the cheapest listing jumps before the sold price follows. It couldn't be measured yet, and the reason was a bug: `lows.json` was keyed by the clock date. Two runs either side of midnight UTC both stamped the same TCGplayer snapshot as different days (11 and 12 Oct were identical for all 2,341 cards), so a "jump" could never show. It's now keyed by the price snapshot's date (`history.dates.at(-1)`), and the duplicate column was collapsed to 12 Oct. Sell-out signals can start once 3 more daily snapshots exist (about Thu 15 Oct).
- The daily price update had failed overnight (push rejected by a research commit). Fixed with a rebase-and-retry loop, re-run by hand at 13:00, and prices are now current to 12 Oct.
- With fresh prices, ⭐ Best has 6: Gengar LV.X, Charmander (Stormfront), Slowking Prime, Jirachi ◇, **Blastoise & Piplup-GX (Cosmic Eclipse, new)** and Rayquaza-GX.

## 2026-10-12 — Price updates are manual only
- The owner asked to stop the nightly price update. `prices.yml` no longer has a schedule; it runs only when started by hand (Actions → Update prices → Run workflow, or on request). The AU sold workflow was already manual. The hourly want-list eBay check (worker cron) is a separate thing and is unchanged.
