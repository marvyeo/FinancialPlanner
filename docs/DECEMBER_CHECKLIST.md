# December parallel run and 2027-01-01 cutover

Goal: run the app and `2026Planning.xlsx` side by side for December, prove they agree, then stop using the xlsx on 2027-01-01. No personal data in this file (public repo).

## Before 1 Dec
- [ ] Clear the November backlog first: Month-end check coverage grid shows no "outstanding" for Oct/Nov (cards and bank accounts, both people). Mark never-statement cards "no statements expected".
- [ ] Caroline sheet leftovers resolved (unpaired transfers, duplicate account removed).
- [ ] Settings → Export JSON, keep as the pre-December backup.
- [ ] Each person's capture Project has current "Chat capture instructions" (Settings → Chat capture instructions; re-copy if cards, accounts or merchants changed).
- [ ] Decide the comparison method (below) and the tolerance.

## Daily (both people, about 1 minute)
- [ ] Capture in the chat Project as you spend: what, how much, where, which card, joint/personal.
- [ ] Still enter in the xlsx as usual (this is the parallel run).
- [ ] "Close day" → paste the `fp-entries` JSON into Settings → Import chat entries → check the preview → Apply. Skipped lines (unknown card or account) get fixed, not ignored.

## Weekly (Sunday, 5 minutes)
- [ ] App vs xlsx: compare the week's total and the count of entries per person. Note every difference with its cause (missed capture, wrong card, split, timing).
- [ ] Merchants page: clear new merchants lacking a category.
- [ ] Rules banner: refresh `rules.json` if the weekly check has run.

## Statement days (as each lands; 25–28 Dec is the cluster)
- [ ] Month-end check → Prepare with Claude → import each statement; chat entries should flip pending → verified.
- [ ] Review queue: unmatched statement lines and chat entries with no line. Fix as a ledger patch, not by hand-editing in two places.
- [ ] Bank accounts: confirm opening/closing balances reconcile on the Balances page ("Balanced ✓").
- [ ] Card bill payments logged; own-account transfers paired.

## Early January (parallel-run close)
- [ ] Wait for the last December statements, import and reconcile all of them.
- [ ] Compare December totals app vs xlsx: per person, per category, per card, joint vs personal. Within tolerance, or every gap explained.
- [ ] Spot-check card cap usage (`engine.cardStatus`) against the issuer's own figures.
- [ ] Owed-to-me balances (collections and repayments) match the xlsx.

## Cutover go / no-go (2027-01-01)
Go only if all of these hold:
- [ ] December totals agree within tolerance and every difference has a recorded cause.
- [ ] No "outstanding" squares for Oct–Dec in the coverage grid.
- [ ] Both people captured on at least 80% of days in December.
- [ ] Backup exported; xlsx archived read-only outside the repo.
If no-go, extend the parallel run by one month and list what blocked it here.

## After cutover
- [ ] Stop entering in the xlsx. Archive it outside the repo.
- [ ] Update `docs/PROJECT_STATE.md`: parallel run done, xlsx retired.
- [ ] Add the monthly routine: capture daily, close day, statements at month-end, exceptions as patches.
