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
