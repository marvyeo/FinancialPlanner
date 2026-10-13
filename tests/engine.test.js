/* Run: node tests/engine.test.js   (exits non-zero on failure) */
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));
const rules = require(path.join(__dirname, '..', 'rules.json'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg || ''} expected ${b}, got ${a}`);

const CARD_NAMES = [
  ['AMEX Platinum Credit Card', 'marvin', 'amex-plat-credit'],
  ['AMEX KrisFlyer Credit Card', 'marvin', 'amex-krisflyer'],
  ['DBS Altitude VISA', 'marvin', 'dbs-altitude'],
  ["DBS Woman's World Mastercard", 'marvin', 'dbs-wwmc'],
  ['UOB Preferred VISA', 'marvin', 'uob-preferred-visa'],
  ['DBS Yuu VISA', 'marvin', 'dbs-yuu'],
  ['UOB Visa Signature', 'marvin', 'uob-visa-signature'],
  ["UOB Lady's Mastercard (Marvin)", 'marvin', 'uob-ladys'],
  ['OCBC Rewards Mastercard', 'marvin', 'ocbc-rewards'],
  ['Citi Rewards Mastercard', 'marvin', 'citi-rewards'],
  ['CIMB Visa Signature', 'marvin', 'cimb-visa-signature'],
  ['CIMB Visa Infinite', 'marvin', 'cimb-visa-infinite'],
  ['HSBC Revolution VISA', 'marvin', 'hsbc-revolution'],
  ["UOB Lady's Mastercard (Caroline)", 'wife', 'uob-ladys'],
  ['UOB Preferred VISA (Caroline)', 'wife', 'uob-preferred-visa'],
  ['UOB Visa Signature (Caroline)', 'wife', 'uob-visa-signature'],
];
function household() {
  return CARD_NAMES.map(([name, profile], i) => ({ id: 'c' + i, name, profile, cycleDate: '12', options: {} }));
}
const settings = { mile_valuations: { KrisFlyer: 1.5, 'Asia Miles': 1.4 }, policy: { mode: 'miles_first', cashbackGapCents: 2.5 } };
const card = (cards, name) => cards.find((c) => c.name === name);
const txn = (o) => Object.assign({ id: 't' + Math.random(), date: '2026-10-13', channel: 'mobile_contactless', fcy: false, forProfile: 'marvin' }, o);

console.log('rules.json');
test('validates cleanly', () => assert.deepStrictEqual(E.validateRules(rules), []));
test('every held card links to the right definition', () => {
  const cards = household();
  assert.strictEqual(E.autoLink(cards, rules), 16);
  cards.forEach((c, i) => assert.strictEqual(c.ruleId, CARD_NAMES[i][2], c.name));
});

console.log('cycles');
test('calendar month', () => assert.deepStrictEqual(E.cycleFor('calendar', 12, '2026-10-13'), { type: 'calendar', start: '2026-10-01', end: '2026-10-31', key: '2026-10' }));
test('statement period after statement day', () => { const c = E.cycleFor('statement', 12, '2026-10-13'); assert.strictEqual(c.start, '2026-10-13'); assert.strictEqual(c.end, '2026-11-12'); });
test('statement period on statement day', () => { const c = E.cycleFor('statement', 12, '2026-10-12'); assert.strictEqual(c.start, '2026-09-13'); assert.strictEqual(c.end, '2026-10-12'); });
test('statement day 31 in a short month', () => { const c = E.cycleFor('statement', 31, '2026-02-15'); assert.strictEqual(c.start, '2026-02-01'); assert.strictEqual(c.end, '2026-02-28'); });

console.log('earning');
const ctxFor = (cards, ledger) => ({ cards, rules, ledger: ledger || [], settings });
function earn(cards, name, t, ledger) {
  return E.recommend(t, ctxFor(cards, ledger), { cards: [card(cards, name)] }).ranked[0];
}
test('UOB S$5 blocks: S$9.99 earns like S$5', () => {
  const cards = household(); E.autoLink(cards, rules);
  const r = earn(cards, "UOB Lady's Mastercard (Marvin)", txn({ amount: 9.99, mcc: '5812', merchant: 'Restaurant' }));
  close(r.miles, 20, 'miles');
});
test("Lady's cap overflow: S$990 used, S$50 more → S$10 at 4 mpd + S$40 at 0.4", () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, "UOB Lady's Mastercard (Marvin)");
  const ledger = [txn({ id: 'x', cardId: c.id, amount: 990, mcc: '5812', merchant: 'Restaurant', date: '2026-10-02' })];
  const r = earn(cards, c.name, txn({ amount: 50, mcc: '5812', merchant: 'Restaurant' }), ledger);
  close(r.miles, 56, 'miles');
});
test("Lady's category only applies to the chosen category", () => {
  const cards = household(); E.autoLink(cards, rules);
  card(cards, "UOB Lady's Mastercard (Marvin)").options.ladysCategory = 'family';
  close(earn(cards, "UOB Lady's Mastercard (Marvin)", txn({ amount: 50, mcc: '5812', merchant: 'Restaurant' })).mpd, 0.4);
  close(earn(cards, "UOB Lady's Mastercard (Marvin)", txn({ amount: 50, mcc: '5411', merchant: 'FairPrice' })).mpd, 4);
});
test("Lady's savings tier adds to the bonus rate", () => {
  const cards = household(); E.autoLink(cards, rules);
  card(cards, "UOB Lady's Mastercard (Marvin)").options.ladysSavingsTier = '2';
  close(earn(cards, "UOB Lady's Mastercard (Marvin)", txn({ amount: 50, mcc: '5812', merchant: 'Restaurant' })).mpd, 8);
});
test('HSBC Revolution: contactless dining 4 mpd, chip 0.4, 8 mpd tier with option', () => {
  const cards = household(); E.autoLink(cards, rules);
  close(earn(cards, 'HSBC Revolution VISA', txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' })).mpd, 4);
  close(earn(cards, 'HSBC Revolution VISA', txn({ amount: 100, mcc: '5812', merchant: 'Restaurant', channel: 'chip' })).mpd, 0.4);
  card(cards, 'HSBC Revolution VISA').options.hsbcEnhanced = true;
  close(earn(cards, 'HSBC Revolution VISA', txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' })).mpd, 8);
});
test('HSBC Revolution excludes fast food (5814)', () => {
  const cards = household(); E.autoLink(cards, rules);
  close(earn(cards, 'HSBC Revolution VISA', txn({ amount: 100, mcc: '5814', merchant: 'Cafe' })).mpd, 0.4);
});
test('UOB Visa Signature: base until S$1,000 contactless minimum, then 4 mpd', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'UOB Visa Signature');
  close(earn(cards, c.name, txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' })).mpd, 0.4, 'before');
  const ledger = [txn({ id: 'a', cardId: c.id, amount: 950, mcc: '5812', merchant: 'Restaurant', date: '2026-10-13' })];
  close(earn(cards, c.name, txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' }), ledger).mpd, 4, 'after');
});
test('UOB Visa Signature: FCY spend does not count toward the local minimum', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'UOB Visa Signature');
  const ledger = [txn({ id: 'a', cardId: c.id, amount: 1000, mcc: '5812', merchant: 'Overseas', fcy: true, date: '2026-10-13' })];
  close(earn(cards, c.name, txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' }), ledger).mpd, 0.4, 'local');
  close(earn(cards, c.name, txn({ amount: 100, mcc: '5812', merchant: 'Overseas', fcy: true }), ledger).mpd, 4, 'fcy');
});
test('Committing to a minimum spend applies the bonus with a warning flag', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'UOB Visa Signature');
  c.options.commit = { 'uobvs-local': true };
  const r = earn(cards, c.name, txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' }));
  close(r.mpd, 4); assert.ok(r.committed);
});
test('DBS yuu: 2.78 mpd before threshold, 10 mpd after S$800 + 4 merchants', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'DBS Yuu VISA');
  close(earn(cards, c.name, txn({ amount: 50, mcc: '5411', merchant: 'Cold Storage' })).mpd, 2.78, 'before');
  // 4 small yuu merchants + non-yuu spend to reach S$800 (non-yuu spend counts toward the minimum)
  const ledger = ['Giant', '7-Eleven', 'foodpanda', 'Guardian'].map((m, i) => txn({ id: 'y' + i, cardId: c.id, amount: 20, mcc: '5411', merchant: m, date: '2026-10-0' + (i + 1) }))
    .concat([txn({ id: 'n', cardId: c.id, amount: 720, mcc: '5651', merchant: 'Uniqlo', date: '2026-10-06' })]);
  close(earn(cards, c.name, txn({ amount: 50, mcc: '5411', merchant: 'Cold Storage' }), ledger).mpd, 10, 'after');
});
test('DBS yuu: same brand twice counts as one merchant', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'DBS Yuu VISA');
  const ledger = ['Giant', 'Giant Hypermarket', 'Cold Storage', 'CS Fresh'].map((m, i) => txn({ id: 'y' + i, cardId: c.id, amount: 250, mcc: '5411', merchant: m, date: '2026-10-0' + (i + 1) }));
  const st = E.cardStatus(c, rules, ledger, '2026-10-13');
  const yuu = st.conditions.find((x) => x.bonus.id === 'yuu-10');
  assert.strictEqual(yuu.result.items.find((i) => i.label.includes('merchant')).progress, 2);
});
test('DBS WWMC: online 4 mpd uncapped by category, in-store 0.4', () => {
  const cards = household(); E.autoLink(cards, rules);
  close(earn(cards, "DBS Woman's World Mastercard", txn({ amount: 123.45, mcc: '4722', merchant: 'Agoda', channel: 'online' })).mpd, 4);
  close(earn(cards, "DBS Woman's World Mastercard", txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' })).mpd, 0.4);
});
test('Citi Rewards: online travel excluded from 4 mpd, fashion in-store earns 4 mpd', () => {
  const cards = household(); E.autoLink(cards, rules);
  close(earn(cards, 'Citi Rewards Mastercard', txn({ amount: 100, mcc: '4722', merchant: 'Agoda', channel: 'online' })).mpd, 0.4);
  close(earn(cards, 'Citi Rewards Mastercard', txn({ amount: 100, mcc: '5651', merchant: 'Uniqlo', channel: 'chip' })).mpd, 4);
});
test('AMEX KrisFlyer: Grab capped at S$200/month', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'AMEX KrisFlyer Credit Card');
  const ledger = [txn({ id: 'g', cardId: c.id, amount: 180, mcc: '4121', merchant: 'Grab', channel: 'online', date: '2026-10-05' })];
  close(earn(cards, c.name, txn({ amount: 50, mcc: '4121', merchant: 'Grab', channel: 'online' }), ledger).miles, 20 * 2 + 30 * 1.1);
});
test('Insurance (6300) is excluded on every card', () => {
  const cards = household(); E.autoLink(cards, rules);
  const rec = E.recommend(txn({ amount: 500, mcc: '6300', merchant: 'Insurance', channel: 'online' }), ctxFor(cards));
  assert.ok(rec.ranked.every((o) => o.excluded), rec.ranked.filter((o) => !o.excluded).map((o) => o.card.name).join(','));
});

console.log('recommendation policy');
test('Dining tap: picks a 4 mpd card worth 6¢/$ (UOB) over HSBC 5.6¢/$', () => {
  const cards = household(); E.autoLink(cards, rules);
  const rec = E.recommend(txn({ amount: 50, mcc: '5812', merchant: 'Restaurant' }), ctxFor(cards));
  assert.strictEqual(rec.pick.card.ruleId, 'uob-ladys');
  close(rec.pick.centsPerDollar, 6);
});
test('Cap headroom breaks ties between equal-value cards', () => {
  const cards = household(); E.autoLink(cards, rules);
  const lady = card(cards, "UOB Lady's Mastercard (Marvin)");
  const ledger = [txn({ id: 'l', cardId: lady.id, amount: 900, mcc: '5812', merchant: 'Restaurant', date: '2026-10-02' })];
  const rec = E.recommend(txn({ amount: 50, mcc: '5812', merchant: 'Restaurant' }), ctxFor(cards, ledger));
  assert.strictEqual(rec.pick.card.ruleId, 'uob-preferred-visa');
});
test('Cashback wins only when it beats miles by the threshold', () => {
  const cards = household(); E.autoLink(cards, rules);
  card(cards, 'CIMB Visa Signature').options.commit = { 'cimbvs-grocery': true };
  const t = txn({ amount: 100, mcc: '5411', merchant: 'Sheng Siong', channel: 'chip' });
  let rec = E.recommend(t, ctxFor(cards));
  assert.strictEqual(rec.pick.card.ruleId, 'cimb-visa-signature', 'gap large → cashback');
  rec = E.recommend(t, { ...ctxFor(cards), settings: { ...settings, policy: { mode: 'miles_first', cashbackGapCents: 20 } } });
  assert.strictEqual(rec.pick.type, 'miles', 'gap below threshold → miles');
});
test('Without the S$800 commitment CIMB earns 0.2% and miles win', () => {
  const cards = household(); E.autoLink(cards, rules);
  const rec = E.recommend(txn({ amount: 100, mcc: '5411', merchant: 'Sheng Siong', channel: 'online' }), ctxFor(cards));
  assert.strictEqual(rec.pick.type, 'miles');
});
test("Cobae's spend can use either parent's cards", () => {
  const cards = household(); E.autoLink(cards, rules);
  card(cards, "UOB Lady's Mastercard (Marvin)").options.ladysCategory = 'dining';
  card(cards, "UOB Lady's Mastercard (Caroline)").options.ladysCategory = 'family';
  // Supermarket via physical chip: only Caroline's Lady's (Family) earns 4 mpd
  const t = { amount: 80, mcc: '5411', merchant: 'Sheng Siong', channel: 'chip' };
  const rec = E.recommend(txn({ ...t, forProfile: 'cobae' }), ctxFor(cards));
  assert.strictEqual(rec.pick.card.name, "UOB Lady's Mastercard (Caroline)");
  const own = E.recommend(txn({ ...t, forProfile: 'marvin' }), ctxFor(cards));
  assert.ok(own.ranked.every((o) => o.card.profile !== 'wife'));
});
test('Strategy matrix produces a pick for every scenario', () => {
  const cards = household(); E.autoLink(cards, rules);
  const rows = E.strategy(ctxFor(cards), 'cobae', '2026-10-13', 50);
  assert.strictEqual(rows.length, E.SCENARIOS.length);
  rows.forEach((r) => assert.ok(r.rec.pick || r.rec.reason.startsWith('No card earns'), r.scenario.id));
  assert.strictEqual(rows.find((r) => r.scenario.id === 'insurance').rec.pick, null);
});
test('Missed value is computed against the best card at the time', () => {
  const cards = household(); E.autoLink(cards, rules);
  const alt = card(cards, 'DBS Altitude VISA');
  const ledger = [txn({ id: 'm1', cardId: alt.id, amount: 100, mcc: '5812', merchant: 'Restaurant' })];
  const [row] = E.analyseLedger(ctxFor(cards, ledger));
  close(row.actual.result.miles, 130); close(row.missedCents, 600 - 195);
});
test('Ledger earnings credit retroactive bonuses to earlier txns in the cycle', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'DBS Yuu VISA');
  const ledger = ['Cold Storage', 'Giant', '7-Eleven', 'foodpanda'].map((m, i) => txn({ id: 'r' + i, cardId: c.id, amount: 30, mcc: '5411', merchant: m, date: '2026-10-0' + (i + 1) }))
    .concat([txn({ id: 'big', cardId: c.id, amount: 700, mcc: '5651', merchant: 'Uniqlo', date: '2026-10-20' })]);
  const earned = E.ledgerEarnings(ctxFor(cards, ledger));
  close(earned.get('r0').result.miles, 300, 'first yuu txn earns 10 mpd once the month qualifies');
});

console.log('statements');
test('parses common SG statement lines and flags credits', () => {
  const rows = E.parseStatementText([
    '12 OCT  GRAB*A-8KX2 SINGAPORE SG        23.40',
    '13 OCT 14 OCT SHOPEE SINGAPORE MP   1,045.90',
    '15/10/2026 PAYMENT - THANK YOU   500.00 CR',
    '02 SEP  AMAZON MKTPL USD 32.10     44.12',
    'Statement date 15 Oct 2026',
  ].join('\n'), { refDate: '2026-10-20' });
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], { date: '2026-10-12', postDate: null, description: 'GRAB*A-8KX2 SINGAPORE SG', amount: 23.4, credit: false });
  assert.strictEqual(rows[1].postDate, '2026-10-14'); assert.strictEqual(rows[1].amount, 1045.9);
  assert.strictEqual(rows[2].credit, true);
  assert.strictEqual(rows[3].date, '2026-09-02');
});
test('a description ending in S is not mistaken for an S$ prefix', () => {
  const [r] = E.parseStatementText('08 OCT  ABC BAKERY TAMPINES   12.80\n09 OCT  KOPI S$4.50', { refDate: '2026-10-13' });
  assert.strictEqual(r.description, 'ABC BAKERY TAMPINES');
  assert.strictEqual(E.parseStatementText('09 OCT  KOPI SHOP S$4.50', { refDate: '2026-10-13' })[0].amount, 4.5);
});
test('January lines on a December reference date fall in the previous year correctly', () => {
  const rows = E.parseStatementText('28 DEC STARBUCKS 7.50\n03 JAN NETFLIX 19.98', { refDate: '2027-01-10' });
  assert.strictEqual(rows[0].date, '2026-12-28'); assert.strictEqual(rows[1].date, '2027-01-03');
});
test('CSV with debit/credit columns', () => {
  const table = E.parseCSV('Transaction Date,Description,Debit,Credit\n2026-10-01,"COLD STORAGE, BUKIT TIMAH",45.20,\n2026-10-02,REFUND,,10.00\n');
  const map = E.guessCsvMapping(table[0]);
  const rows = E.csvToRows(table, map, { refDate: '2026-10-13' });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].description, 'COLD STORAGE, BUKIT TIMAH'); assert.strictEqual(rows[1].credit, true);
});
test('categorise: keywords, boundaries and FCY detection', () => {
  const g = E.categorise('GRAB*A-8KX2 SINGAPORE SG', [], []);
  assert.strictEqual(g.mcc, '4121');
  assert.strictEqual(E.categorise('GRABFOOD SINGAPORE', [], []).mcc, '5812');
  assert.notStrictEqual(E.categorise('PETROL STATION 123', [], []).category, 'Pets');
  assert.notStrictEqual(E.categorise('COMMUNITY CLUB FEES', [], []).merchant, 'Unity');
  assert.strictEqual(E.categorise('AMAZON MKTPL USD 32.10', [], []).fcy, true);
  assert.strictEqual(E.categorise('ABC BAKERY', [], [{ pattern: 'abc bakery', merchant: 'ABC Bakery', mcc: '5462', channel: 'mobile_contactless' }]).confidence, 'learned');
});
test('categorise prefers the merchant DB when it is the longer match', () => {
  const db = [{ name: 'Cold Storage', service: '', mcc: '5411', category: 'Groceries' }];
  const r = E.categorise('COLD STORAGE JELITA', db, []);
  assert.strictEqual(r.confidence, 'db'); assert.strictEqual(r.mcc, '5411');
});
test('a brand-only match on a multi-service merchant defers to the keyword table', () => {
  const db = [{ name: 'Grab', service: 'GrabFood', mcc: '5812' }, { name: 'Grab', service: 'GrabCar', mcc: '4121' }, { name: 'Shopee', service: 'Online Retail', mcc: '5999' }];
  assert.strictEqual(E.categorise('GRAB*A-8KX2 SINGAPORE SG', db, []).mcc, '4121');
  assert.strictEqual(E.categorise('GRABFOOD SG', db, []).mcc, '5812');
  assert.strictEqual(E.categorise('SHOPEE SINGAPORE MP', db, []).merchant, 'Shopee · Online Retail');
});

console.log('rules refresh');
test('diff reports cap and rate changes', () => {
  const next = JSON.parse(JSON.stringify(rules));
  next.rulesVersion = '2026-10-20';
  next.cards.find((c) => c.id === 'uob-ladys').capGroups.ladys.spend = 750;
  next.cards.find((c) => c.id === 'dbs-wwmc').bonuses[0].mpd = 3;
  const d = E.diffRules(rules, next);
  assert.strictEqual(d.length, 2);
  assert.ok(d.find((x) => x.cardId === 'uob-ladys').details[0].includes('750'));
});
test('legacy cards without a definition still earn from their old bonusRules', () => {
  const legacy = { id: 'L', name: 'Mystery Card', profile: 'marvin', baseRate: 1, transferPartners: [{ partner: 'KrisFlyer', ratio: 1 }], bonusRules: [{ category: 'Dining', mcc: '5812', rate: 3, monthlyCap: 500 }] };
  const r = E.recommend(txn({ amount: 100, mcc: '5812', merchant: 'Restaurant' }), { cards: [legacy], rules, ledger: [], settings }).pick;
  close(r.mpd, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
