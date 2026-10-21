# Financial Planner — technical state
*Updated 2026-10-17. Personal/household data is kept outside this public repo.*


| Item | Value |
|---|---|
| Repo | `marvyeo/FinancialPlanner` (**public**), branch `main` — never commit personal data |
| Live URL | https://marvyeo.github.io/FinancialPlanner/ |
| Stack | Static `index.html` (vanilla JS + Tailwind CDN) + `engine.js` (pure, Node-testable) + `rules.json` + `merchants-sg.json` |
| Tests | `node tests/engine.test.js` → 58 passing |
| Data | Google Drive `financialplanner-data.json` (+ `merchants.json`), scope `drive.file` |
| OAuth client | `669494100250-gvromuq72r7j0djmkd4vdbdq5damncj7.apps.googleusercontent.com` (GCP project number 669494100250) |
| Rules refresh | `RULES_REFRESH.md` weekly → `rules.json` (version 2026-10-14) → in-app banner |
| Commit trailer | `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` + `Claude-Session: <session url>` |

### Pages
Dashboard (phone quick buttons; month-end reminder) · Spending · Investments · Month-end check · Advice · Owed to me · Profiles · Which card? · Strategy · Cards · Merchants · Settings (Household, accounts, policy, rules, valuations).

### Key engine functions (engine.js)
recommend / analyseLedger / ledgerEarnings (card engine, caps, conditions, miles-first policy with cashback gap 2.5¢) · categorise (merchant DB + learned mappings + keywords) · parseStatementText / csvToRows / classifyFlow / pairTransfers · owedSummary / migrateContra (splits) · parseDigiPortfolio / mergeInvestmentData / investmentSummary (Modified Dietz, XIRR, paid-out coupons count in gain, fee rate annualised) / investmentInsights · **reconcileStatement** (matched / split / grouped / amount-differs / not-logged / logged-but-missing) · **mergeData** (3-way merge for two phones) · **ghostResult / adviceSummary** (ghost tracking: `rate`, `position`, `switch`).

### File formats the app imports
- `fp-investments` (Investments → Import): accounts/snapshots/activity; matched by `provider:key`; activity `paidOut:true` for coupons paid to bank.
- `fp-statements` (Month-end check → Prepare with Claude): `{format:'fp-statements',statements:[{source,owner,institution,product,last4,statementDate,periodFrom,periodTo,openingBalance,closingBalance,lines:[{date,postDate,description,amount,credit,fcy}]}],checks:[{source,ok,note}]}`. The app copies the exact prompt (lists card/account names).
- `fp-advice` (Advice → Import check-in file): `{format:'fp-advice',recommendations:[{id,date,area:'cash|invest|cards|other',title,detail,steps[],amountSgd,expectedPerYear,priority,ghost}],prices:{TICKER:[{date,price}],USDSGD:[…]}}`. Ghost kinds: `{kind:'rate',amountSgd,fromRate,toRate,date}` · `{kind:'position',ticker,ccy,amountSgd,date,price?,fx?}` · `{kind:'switch',from:{ticker,ccy},to:{ticker,ccy},amountSgd,date}`. Re-importing keeps the user's decisions; prices merge by date.
- `fp-merchant` (Claude MCC lookup reply, pasted into the add-expense form).

### Household sign-in (built 2026-10-17, setup pending)
- Each person signs in with own Google account; token kept in localStorage (~1 h, one-tap renew; 401 → re-auth overlay, no data lost).
- File found via remembered id → shared-with-me → own. No file → "Join household" screen (Google Picker, needs `PICKER_API_KEY` in index.html; currently EMPTY).
- `settings.household.members [{email, profile}]`; `ME.profile` drives default "for whom" and recon list. Share button: Settings → Household (writer permission on data + merchants files).
- Save = check Drive `version`; if changed, `mergeData(base, local, remote)` then upload. Refresh on returning to the tab.
- **TODO (user):** GCP → OAuth consent screen test user (partner's Gmail); enable Picker API; create API key restricted to Picker API + `https://marvyeo.github.io/*`; put key in `PICKER_API_KEY`; Settings → Household → Share.

### Open app items
- [ ] Picker API key (`PICKER_API_KEY`) — needed before the second person can open the shared file.
- [ ] Single corrected statement-based household import (asked earlier; household or per person — undecided).
- [ ] Joint 50/50 settle-up page (offered twice, no answer).
- [ ] Add Caroline's cards to the app: DBS Altitude (stmt ~12th), DBS Woman's World (12th), Citi Rewards (15th), HSBC Revolution (1st/2nd), OCBC Rewards (19th). Add bank accounts for both (for transfers + recon checklist).
- [ ] Import investment files: `endowus-2026-10-17.json` (Amundi relabelled cash), `sgx-shares-2026-10-16.json`, `cpf-2026-10-16.json`, `caroline-investments-2026-10-16.json`; `advice-2026-10-17.json` on Advice page.

- 2026-10-21 (conductor): new app icon from the ecosystem icon set; app is now installable (manifest.json, network-first sw.js, icons). iPhone redirect sign-in fallback not added yet.
