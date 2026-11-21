# Financial Planner — Project State

> **Next chat name: `Financial Planner ver 11`**
> Claude: your FIRST reply in a new chat must start with "Rename this chat to: **Financial Planner ver 11**" (you can't rename chats yourself). In your first commit this session, bump the number here by 1.

> ## ▶ RESUME HERE (ver 10, 2026-11-21, roadmap items 1–2 done)
> **Done in ver 10:** importer live-tested; item 2 finished: `reconcileStatement` already did card+amount+date±4, splits and grouped lines; added `groupTransitRows` (un-logged bus/MRT taps → one row per day), matched chat entries flip `pending` → `verified` on statement commit, unmatched chat entries are flagged "chat entry, no statement line yet" in Month-end check. 68 tests; `sw.js` v6. Not run against a real statement in-browser.
> **Decisions (Marvin):** only Marvin develops this app. Caroline's data is already in the app via Marvin's login, and she uses the same app/data via her own Gmail (PICKER_API_KEY is already set in index.html), so item 4 is mostly done: remaining is just verifying her cards have `profile:'wife'`. Don't make Marvin switch chats every prompt: keep working in one chat, checkpoint-commit, and only suggest a fresh chat when context is genuinely large.
> **Also done:** item 3: Settings → 📋 Chat capture instructions builds the Project instructions from live cards/accounts/merchants (nothing personal in the repo). `merchants.json` and `financialplanner-data.json` are readable via the Drive connector (read-only; data file is 2MB, don't read it). Merged to `main` with Marvin's OK; `.claude/skills/ship-app` added for sibling apps. `sw.js` v7.
> **Next:** Marvin tries capture chat for a few days; item 5 (history migration, separate chat). Never commit merchants.json (contains medical merchants). **First command:** `git pull && node tests/engine.test.js` (68 passing).

> ## (ver 8 block; item 1 below is now done)
> **Done in ver 8:** 122 xlsx rows (1–20 Nov) imported via a private `fp-ledger-patch` (dry-run 122 add / 0 skipped). 102 older xlsx rows left out on purpose (mostly Dining/Contra splits the statement-checked ledger holds as one line; 68 truly absent, to review only if wanted). Card usage read from `engine.cardStatus` after import. Private files (xlsx, exports, patches) live outside the repo.
> **Direction:** retire 2026Planning.xlsx by 2027-01-01. Capture in a Claude chat ("what, how much, where, which card, joint/personal"); "close day" outputs one `fp-entries` import; month-end statements verify them. Marvin and Caroline both capture; all dev goes through Marvin. Card bill payments ARE tracked; own-account transfers are not.
> **Roadmap (S/M/L):**
> 1. **M** `fp-entries` importer: stable-ID dedupe, `source:chat`, status `pending`, preview then Apply (reuse the ledger-patch preview pattern). Tests.
> 2. **M** Statement matching: card + amount + date ±3 days; matched = verified; unmatched statement lines (bus/MRT grouped per day) go to a review queue; chat entries with no line are flagged.
> 3. **S** Capture Project instructions for Marvin and Caroline + ~150-merchant alias table (from xlsx).
> 4. **M** Caroline onboarding: PICKER_API_KEY, her cards and accounts (see Open app items), balanceChecks merge fix.
> 5. **L (separate chat)** One-time 2026 xlsx history migration (1,611 rows; Contra to owed; scope prefix to scope + category); Dec parallel run; cut over 2027-01-01.
> **First command:** `git pull && node tests/engine.test.js` (66 passing).

> ## ▶ RESUME HERE (paused 2026-11-08, ver 6, patch importer built; waiting on the user)
> **Done:** `previewLedgerPatch` / `applyLedgerPatch` in engine.js (66 tests passing, incl. `mergeData` keeping deletions). Settings → Data management → **⇪ Import ledger patch** (dry-run modal → Apply → one save). `sw.js` cache v4. Checked in Node against the user's real 150-op patch + Drive ledger copy: 81 deleted, 68 updated, 1 added, 0 skipped, no dangling or one-sided transfer pairs (2292 → 2212 entries). Not tested live in a browser.
> **Next (user):** reload the app (new service-worker cache), Settings → Export JSON as backup, Import ledger patch with the private `fp-ledger-patch-2026-10.json`, check the preview shows 81 / 68 / 1 / 0 skipped, Apply. Then Balances page + Month-end check for Oct.
> **Held for the user's OK (not in the patch):** Kai Jia S$21.60 and Aaron S$10.90 repayments stay "Transfer"; the manual card-side S$285.16 "Bill Payment" leftover on HSBC Revolution.
> **Then:** items 5 and 6 below (bank-account mapping from 1 Nov, merchant-name alignment), and monthly maintenance (statements → `fp-statements` → exceptions as a patch). Naming: card payments `Card payment (<card>)`; transit `BUS/MRT`; own-account moves `Transfer to/from <account>`.
> **First command:** `git pull && node tests/engine.test.js` (66 passing).
> **Restart prompt:** "Continue Financial Planner ver 7 from RESUME HERE" (re-attach a fresh Drive ledger copy if more patches are needed).

> ## ▶ RESUME HERE (paused 2026-10-29, after checkpoint 2 of 4, `main` @ pushed)
> **Done:** items 1–4 (form layout, unticked rename boxes, owner-labelled pickers, Balances page + statement balance capture).
> **Next, in order:**
> 1. **Item 5 — map bank-account transactions in.** Needs Marvin's data: either the `fp-statements` JSON files for the bank/wallet accounts (both people), or a look at why existing imports left them unmapped (check `data.transactions` with `accountId` null/missing for bank statements; `guessSourceFor` matching; `data.accounts[].patterns`). Plan: confirm every bank/wallet account exists with owner + patterns → re-import statements via Month-end check (opening/closing balances now saved) → `pairTransfers` for A→B→C moves → Balances page should show "Balanced ✓" from 1 Nov 2026; earlier months best-effort (unidentified lines stay "Unknown merchant" in the review list).
> 2. **Item 6 — merchant-name alignment tool.** Cluster near-identical `merchant` strings (normalise case/punctuation/store numbers, token similarity), show clusters in Merchants page with counts + categories, one tap to pick the canonical name → rewrite `merchant` on all lines (opt-in, never automatic), optional `merchantMappings` entry (also opt-in).
> **First command:** `git pull && node tests/engine.test.js` (61 passing).
> **Restart prompt:** "Continue Financial Planner ver 4 from RESUME HERE".

**State version:** 2 (Session Rules added 2026-10-22 by the conductor chat "Life Plan Roadmap ver 3")
**Where this lives:** `PROJECT_STATE.md` in the repo. New chats `git pull` and read it; no uploads needed.
*Personal/household data is kept outside this public repo.*

## ⚙ Session Rules (every chat that works on this app follows these)

**1. Pick the cheapest model that can do the job.** At the start of every session Claude names the model it recommends and the estimated size (below). If the chat is on a pricier model than needed, Claude says so before starting.

| Model | Use for |
|---|---|
| **Haiku** | State-file edits, text or label changes, small data packs, lookups, "where is X" questions |
| **Sonnet** (default) | Features, bug fixes, refactors, data processing (e.g. novel volumes, PullList), most app work |
| **Opus** | Only for new-app builds, cross-app architecture, or a bug Sonnet has failed on twice. Claude says why before using it |

**2. Every push updates this file in the same commit.** No exceptions, including PR branches and one-line fixes.
- `git pull` before starting, so you build on the latest state.
- Add a dated line to the change log (what changed and why, in plain words) and update any section the change made wrong.
- If a session ends without a push, nothing changes here.

**3. Size the work first, and plan the pause points.**
- Before starting, Claude lists the steps and sizes the job: **S** (under ~20k tokens), **M** (~20–60k), **L** (over ~60k).
- **M and L jobs are split into checkpoints.** Each checkpoint ends with a commit and a state update, so a cut-off session loses nothing.
- **Pause** when usage is around half the window, when the chat has grown long (heavy file reads, ~30+ turns), or before a step that won't finish in what's left. Claude can't see the remaining credit directly, so on L jobs it asks Marvin to check usage at each checkpoint.
- **On pause,** Claude writes a `▶ RESUME HERE` block at the top of this file: what's done, the exact next step, branch and files, and the first command to run. It also gives Marvin a one-line restart prompt ("Continue <App> ver X from RESUME HERE"). The next session starts from that block and deletes it once the step is done.

**4. Chat naming.** Use the **Next chat name** line at the top of this file; tell Marvin in the first reply, then bump it.


| Item | Value |
|---|---|
| Repo | `marvyeo/FinancialPlanner` (**public**), branch `main` — never commit personal data |
| Live URL | https://marvyeo.github.io/FinancialPlanner/ |
| Stack | Static `index.html` (vanilla JS + Tailwind CDN) + `engine.js` (pure, Node-testable) + `rules.json` + `merchants-sg.json` |
| Tests | `node tests/engine.test.js` → 67 passing |
| Data | Google Drive `financialplanner-data.json` (+ `merchants.json`), scope `drive.file` |
| OAuth client | `669494100250-gvromuq72r7j0djmkd4vdbdq5damncj7.apps.googleusercontent.com` (GCP project number 669494100250) |
| Rules refresh | `RULES_REFRESH.md` weekly → `rules.json` (version 2026-11-16) → in-app banner |
| Commit trailer | `Co-Authored-By: <model> <noreply@anthropic.com>` (model named in the session's attribution reminder) + `Claude-Session: <session url>` |

### Pages
Dashboard (phone quick buttons; month-end reminder) · Spending · Investments · Month-end check · Advice · Owed to me · Profiles · Which card? · Strategy · Cards · Merchants · Settings (Household, accounts, policy, rules, valuations).

### Key engine functions (engine.js)
recommend / analyseLedger / ledgerEarnings (card engine, caps, conditions, miles-first policy with cashback gap 2.5¢) · categorise (merchant DB + learned mappings + keywords) · parseStatementText / csvToRows / classifyFlow / pairTransfers · owedSummary / migrateContra (splits) · parseDigiPortfolio / mergeInvestmentData / investmentSummary (Modified Dietz, XIRR, paid-out coupons count in gain, fee rate annualised) / investmentInsights · **accountBalance** (anchor + ledger movement, segment check between balances, running balance) · **reconcileStatement** (matched / split / grouped / amount-differs / not-logged / logged-but-missing) · **mergeData** (3-way merge for two phones) · **ghostResult / adviceSummary** (ghost tracking: `rate`, `position`, `switch`).

### File formats the app imports
- `fp-investments` (Investments → Import): accounts/snapshots/activity; matched by `provider:key`; activity `paidOut:true` for coupons paid to bank.
- `fp-statements` (Month-end check → Prepare with Claude): `{format:'fp-statements',statements:[{source,owner,institution,product,last4,statementDate,periodFrom,periodTo,openingBalance,closingBalance,lines:[{date,postDate,description,amount,credit,fcy}]}],checks:[{source,ok,note}]}`. The app copies the exact prompt (lists card/account names).
- `fp-advice` (Advice → Import check-in file): `{format:'fp-advice',recommendations:[{id,date,area:'cash|invest|cards|other',title,detail,steps[],amountSgd,expectedPerYear,priority,ghost}],prices:{TICKER:[{date,price}],USDSGD:[…]}}`. Ghost kinds: `{kind:'rate',amountSgd,fromRate,toRate,date}` · `{kind:'position',ticker,ccy,amountSgd,date,price?,fx?}` · `{kind:'switch',from:{ticker,ccy},to:{ticker,ccy},amountSgd,date}`. Re-importing keeps the user's decisions; prices merge by date.
- `fp-ledger-patch` (Settings → Import ledger patch): `{format,version:1,ops:[{op:'delete',id,expect}|{op:'update',id,expect,set}|{op:'add',tx}]}`. An op applies only if the entry exists and every `expect` field matches; `set` is whitelisted (merchant, category, forProfile, kind, note, transferPair, accountId, cardId, cardName, date, amount); dangling `transferPair`s are cleared; dry-run first. Personal patch files stay out of the repo.
- `fp-entries` (Settings → Import chat entries): `{format,version:1,entries:[{date,amount,merchant,card|account,forProfile,category,note,capturedBy}]}`. Preview then Apply; stable ids make re-import a no-op; saved pending until a statement verifies them. `card`/`account` match by name (exact, then contains); unknown names are skipped with a reason.
- `fp-merchant` (Claude MCC lookup reply, pasted into the add-expense form).

### Household sign-in (built 2026-10-17, setup pending)
- Each person signs in with own Google account; token kept in localStorage (~1 h, one-tap renew; 401 → re-auth overlay, no data lost).
- File found via remembered id → shared-with-me → own. No file → "Join household" screen (Google Picker, needs `PICKER_API_KEY` in index.html; currently EMPTY).
- `settings.household.members [{email, profile}]`; `ME.profile` drives default "for whom" and recon list. Share button: Settings → Household (writer permission on data + merchants files).
- Save = check Drive `version`; if changed, `mergeData(base, local, remote)` then upload. Refresh on returning to the tab.
- **Shared sign-in (2026-10-23, Sprint 13.4):** the app reads and publishes `lp-sso` in localStorage (a valid `drive.file` token from Life Plan or another app on the shared client means no second sign-in; a 401 or sign-out clears it). **Sign out no longer revokes the Google token**: revoking on the shared client would cancel the file grants of every app on that Google account.
- **iPhone (2026-10-23, Sprint 13.3):** "Sign-in window not opening? Try another way" (redirect sign-in, state `fp`) plus an iPhone "Share → Add to Home Screen" hint on the sign-in card (iOS can't install web apps from a prompt). Needs `https://marvyeo.github.io/FinancialPlanner/` under Authorized redirect URIs.
- **Sprint 13.2 (2026-10-23):** "← Life Plan" link (sidebar; "←" in the mobile top bar), `viewport-fit=cover`, safe-area padding, shared theme tokens `--lp-bg/--lp-surface/--lp-text/--lp-muted/--lp-accent`.
- **TODO (user):** GCP → OAuth consent screen test user (partner's Gmail); enable Picker API; create API key restricted to Picker API + `https://marvyeo.github.io/*`; put key in `PICKER_API_KEY`; Settings → Household → Share.

### Open app items
- [ ] Picker API key (`PICKER_API_KEY`) — needed before the second person can open the shared file.
- [ ] Single corrected statement-based household import (asked earlier; household or per person — undecided).
- [ ] Joint 50/50 settle-up page (offered twice, no answer).
- [ ] Add Caroline's cards to the app: DBS Altitude (stmt ~12th), DBS Woman's World (12th), Citi Rewards (15th), HSBC Revolution (1st/2nd), OCBC Rewards (19th). Add bank accounts for both (for transfers + recon checklist).
- [ ] Import investment files: `endowus-2026-10-17.json` (Amundi relabelled cash), `sgx-shares-2026-10-16.json`, `cpf-2026-10-16.json`, `caroline-investments-2026-10-16.json`; `advice-2026-10-17.json` on Advice page.

- 2026-10-21 (conductor): new app icon from the ecosystem icon set; app is now installable (manifest.json, network-first sw.js, icons). iPhone redirect sign-in fallback not added yet.
- 2026-10-22 (conductor): manifest id set to `/FinancialPlanner/` (the old `./` made Android treat all marvyeo.github.io apps as one).
- 2026-10-22 (conductor): added Session Rules and `CLAUDE.md`.
- 2026-10-23 (conductor, Sprints 13.4 + 13.3 + 13.2): shared `lp-sso` sign-in, no token revoke on sign out, iOS redirect fallback and hint, "← Life Plan" link, safe areas, theme tokens; `sw.js` cache `financialplanner-v3`. Not tested live.
- 2026-10-29 (ver 3, checkpoint 1 of 4): add-expense form: merchant on its own row, amount + date side by side (no scrolling), recent-merchant chips removed from all spend forms. Rename (pen) dialog: 'remember' and 'update previous' now start unticked. Card/account pickers (Spending filter, Import statement, quick-add) grouped by owner via `sourceGroupsHtml` + `cardLabel` ("Marvin — cards", "Caroline — accounts & wallets"…); Spending source column shows owner. Remaining this session: (2) balances views, (3) map bank-statement lines into ledger from Nov, (4) merchant-name alignment tool.
- 2026-10-29 (ver 3, checkpoint 2 of 4): **Balances page** (sidebar). Per account: latest known balance + logged lines since; per person and Family totals (chips). Tap an account → set a balance, see whether lines add up between two balances (red = unlogged money), balances on file, running balance per line. Data: `account.balanceChecks[{date,balance,source:'statement'|'manual'}]`. Statement imports (Month-end check → Prepare with Claude, accounts only) now save opening (day before periodFrom) and closing balances automatically. Not tested live; `mergeData` treats `balanceChecks` as part of the account object (last writer wins on a conflict).
- 2026-11-02 (weekly rules refresh, ver 4 bump): `rules.json` rulesVersion 2026-11-02. Citi Rewards note corrected: Visa is retired in batches (unnotified cards still earn 4 mpd, own S$1,000 cap, end date unconfirmed). No rate changes; other cards checked, nothing new confirmed. Next chat name bumped to ver 5.
- 2026-11-08 (ver 5, docs only): Oct 2026 statements checked against the Drive ledger (15 accounts/cards, 185 lines, all statement balances reconcile). Found ~81 duplicate entries from an in-app import and inconsistent names; prepared a private `fp-ledger-patch` (150 ops). Planned the importer in RESUME HERE; no app code changed. Next chat name bumped to ver 6.
- 2026-11-08 (ver 6, checkpoints 1+2): `fp-ledger-patch` importer. engine.js `previewLedgerPatch`/`applyLedgerPatch`; Settings → Import ledger patch (preview, then Apply, one save); +5 tests (66); `sw.js` cache v4. Verified in Node on the real patch (0 skipped). Not tested live. Next chat name bumped to ver 7.
- 2026-11-16 (weekly rules refresh, ver 7 bump): `rules.json` rulesVersion 2026-11-16. AMEX KrisFlyer Credit Card base earn 1.1 → 1.3 mpd (local + FCY) from 1 Nov 2026; test expectation updated. Other cards checked, nothing else confirmed. Next chat name bumped to ver 8.
- 2026-11-21 (ver 8, docs only): roadmap for retiring the xlsx agreed (RESUME HERE). Next chat name bumped to ver 9.
- 2026-11-21 (ver 8, no app change): Nov 1–20 xlsx rows imported as a ledger patch; card cap usage checked with cardStatus (UOB PPV contactless S$27 left, OCBC 6 mpd S$126 left). 48 new merchants lack MCC history; fix in Merchants.
- 2026-11-21 (ver 9): roadmap item 1 built: `fp-entries` importer (engine `previewEntries`/`applyEntries` reusing the ledger-patch add path; Settings → Import chat entries with preview). +1 test (67); `sw.js` cache v5. Not tested live. Next chat name bumped to ver 10.
- 2026-11-21 (ver 10, docs only): fp-entries importer live-tested in headless Chromium (Drive stubbed): preview 2 add / 1 skipped (unknown card), Apply saved 2 pending source:chat, no JS errors. Confirmed profile key `wife` = Caroline everywhere (label, alias caroline→wife). Next chat name bumped to ver 11.
- 2026-11-21 (ver 10): roadmap item 2: `groupTransitRows`, pending→verified on statement match, chat-entry flag in missing list; +1 test (68); `sw.js` v6. Recorded decisions: Marvin sole developer; Caroline already mapped and uses same app via her Gmail.
- 2026-11-21 (ver 10): roadmap item 3: Settings → Chat capture instructions (live cards/accounts/merchants); `ship-app` skill; merged to main on Marvin's instruction; `sw.js` v7.
