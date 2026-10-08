# Review log — hourly improvement runs (8–9 Oct 2026)

Every change is its own commit, so anything can be taken out on its own. Tell Claude
"remove <name>" (it runs `git revert <commit>`), or do it yourself with that command.

## Candidate ideas

- **Want list + "cost to finish"** (owner-approved): star cards/sealed you're chasing, with
  optional target prices and a flag when they drop to it; in Sets, "38 missing ≈ A$214" to
  complete a set (and the cheap ones only).
- Shareable trade / sell list — planned for the 4pm run.
- Card condition (NM/LP/MP/HP/DMG) with value multipliers — planned for the 5pm run.
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
  Works because you're signed in to eBay in your browser. *Remove:* "remove AU sold button".
