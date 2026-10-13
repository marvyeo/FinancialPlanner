# Weekly card-rules refresh

This is the playbook the weekly scheduled task follows. It replaces `financialplanner-sync.md`.
You can also run it by hand: paste this file into a Claude chat that has this repo attached.

## What the app expects

- `rules.json` at the repo root, served by GitHub Pages next to `index.html`.
- On sign-in the app fetches it. If `rulesVersion` is newer than the version the household
  approved, a banner appears ("Card rules update … Review changes"). Nothing changes until
  someone taps **Apply update**. The approved copy is stored in Drive (`rulesState.applied`).
- Schema is documented by example in `rules.json` and enforced by `FPEngine.validateRules`
  (see `engine.js`). Tests in `tests/engine.test.js` must keep passing.

## Steps

1. **Scope.** The household's cards are the definitions already in `rules.json`
   (AMEX Platinum Credit, AMEX KrisFlyer, DBS Altitude, DBS Woman's World, DBS yuu,
   UOB Preferred Visa, UOB Visa Signature, UOB Lady's, OCBC Rewards, Citi Rewards,
   HSBC Revolution, CIMB Visa Signature, CIMB Visa Infinite).
2. **Research each card** for changes since `rulesVersion`. Trusted sources, in order:
   official bank T&C PDF / product page → The MileLion → Mainly Miles → MoneySmart / SingSaver → HWZ.
   Look for: earn rates (local, FCY, bonus), bonus categories / MCC lists, caps and whether they
   are calendar or statement month, minimum-spend conditions, exclusions, transfer ratios and fees,
   new or ending promotions (with exact start/end dates), card discontinuations.
3. **Edit `rules.json`** only where a source confirms a change:
   - `mpd` is total miles per S$ for the best airline programme (includes the base rate);
     `pct` is total cashback %. Caps are S$ of spend (`spend`) or S$ of cashback (`cashback`).
   - Time-limited promos are separate bonuses with `validFrom` / `validTo` (YYYY-MM-DD).
     A promo stacking on a regular bonus lists both cap groups in `cap`.
   - Keep bonus `id`s stable so the app's diff and the household's "I'll hit the minimum"
     commitments carry over. New bonus → new id.
   - Mark anything inferred rather than stated with `"verify": true`; remove the flag once confirmed.
   - Add new source URLs to the card's `sources`.
   - Remove the OCBC note and add the quarterly promo once its current-quarter T&Cs are found;
     resolve the `verify` items (AMEX 10Xcelerator list, UOB Preferred SimplyGo cap, UOB Preferred online MCCs, CIMB Visa Infinite local rate).
4. **Version.** Set `rulesVersion` to today's date (YYYY-MM-DD, SGT), `generatedAt` to now,
   and replace `changeLog` with one plain-English line per change, e.g.
   `"UOB Lady's: monthly cap S$1,000 → S$750 from 1 Dec 2026 (UOB T&C, 12 Nov)"`.
4b. **Merchant list (`merchants-sg.json`).** Look for newly published MCCs for Singapore merchants
   (MileLion, MoneySmart, The Money Bees, HWZ threads with MCC screenshots). For each find:
   - update `mcc` / `mccAlt`, set `confidence: "reported"` and `source` to the URL;
   - upgrade `"unverified"` entries (food courts, Kopitiam via FairPrice app, enrichment classes) when evidence appears;
   - add common statement descriptors to `aliases` (upper case, the stable part only);
   - never remove an entry; bump `_meta.version` and `_meta.lastUpdated` if anything changed.
   The app merges this list under the household's own Drive list and flags disagreements on the Merchants page.
5. **Check.** Run `node tests/engine.test.js`. If a test fails because a rule genuinely changed,
   update the test's expectation in the same commit and say so in the changeLog.
6. **Publish.** If anything changed: commit `rules.json` / `merchants-sg.json` (and tests if touched) to `main` with message
   `rules: <rulesVersion> — <n> changes`, push. If nothing changed, don't commit.
7. **Report.** Reply with the changeLog lines (or "No changes this week") and anything that
   needs a human decision (e.g. a card being discontinued, or a better card for a category the
   household spends heavily on).
