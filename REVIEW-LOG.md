# Review log — hourly improvement runs (8–9 Oct 2026)

Every change is its own commit, so anything can be taken out on its own. Tell Claude
"remove <name>" (it runs `git revert <commit>`), or do it yourself with that command.

## Candidate ideas

- **Want list + "cost to finish"** (owner-approved): star cards/sealed you're chasing, with
  optional target prices and a flag when they drop to it; in Sets, "38 missing ≈ A$214" to
  complete a set (and the cheap ones only).
- Shareable trade / sell list — done in the 4pm run.
- Card condition — done in the 5pm run.
- Collection value over time + "Your movers" — planned for the 8pm run.

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
