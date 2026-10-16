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

test('OCBC 6 mpd promo: Shopee 6 mpd, promo cap S$1,000 then 4 mpd to S$1,110, ends 31 Mar 2027', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, 'OCBC Rewards Mastercard');
  const t = (o) => txn({ mcc: '5399', merchant: 'Shopee', channel: 'online', ...o });
  close(earn(cards, c.name, t({ amount: 100 })).mpd, 6);
  const ledger = [t({ id: 'p', cardId: c.id, amount: 950, date: '2026-10-02' })];
  close(earn(cards, c.name, t({ amount: 100 }), ledger).miles, 50 * 6 + 50 * 4, 'crosses promo cap');
  const ledger2 = [t({ id: 'q', cardId: c.id, amount: 1100, date: '2026-10-02' })];
  close(earn(cards, c.name, t({ amount: 100 }), ledger2).miles, 10 * 4 + 90 * 0.4, 'crosses regular cap');
  close(earn(cards, c.name, t({ amount: 100, date: '2027-04-02' })).mpd, 4, 'after promo ends');
  close(earn(cards, c.name, t({ amount: 100, merchant: 'Uniqlo', mcc: '5651', channel: 'chip' })).mpd, 4, 'regular category');
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

test('curated merchant list: statement aliases resolve to the right merchant and MCC', () => {
  const db = require(path.join(__dirname, '..', 'merchants-sg.json')).merchants;
  const cases = [
    ['NTUC FP-XTRA JURONG', '5411'], ['GRAB*A-8KX2 SINGAPORE SG', '4121'], ['GRABFOOD SINGAPORE', '5812'],
    ['BUS/MRT 123456', '4111'], ['SHOPEE SINGAPORE MP', '5399'], ['7-ELEVEN #1234', '5499'],
    ['RYDE TECHNOLOGIES', '5734'], ['KOPITIAM INVESTMENT PTE', '5812'], ['UNIQLO ION', '5651'],
    ['SP DIGITAL PTE LTD', '4900'], ['COMMUNITY CLUB FEES', null],
  ];
  cases.forEach(([desc, mcc]) => {
    const r = E.categorise(desc, db, []);
    if (mcc) assert.strictEqual(r.mcc, mcc, desc + ' → ' + r.merchant);
    else assert.notStrictEqual(r.confidence, 'db', desc + ' should not match ' + r.merchant);
  });
  const ids = new Set(); db.forEach((m) => { assert.ok(m.mcc && /^\d{4}$/.test(m.mcc), m.id); assert.ok(!ids.has(m.id), 'dup ' + m.id); ids.add(m.id); });
});

console.log('transfers & kinds');
test('transfers, income and refunds do not count toward caps; paid-for-others does', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, "UOB Lady's Mastercard (Marvin)");
  const base = { cardId: c.id, mcc: '5812', merchant: 'Restaurant', date: '2026-10-02' };
  const ledger = [
    txn({ ...base, id: 'a', amount: 500, kind: 'paid_for_others' }),
    txn({ ...base, id: 'b', amount: 400, kind: 'refund' }),
    txn({ ...base, id: 'c', amount: 900, kind: 'transfer' }),
  ];
  const st = E.cardStatus(c, rules, ledger, '2026-10-13');
  close(st.caps[0].used, 500);
});
test('classifyFlow: bill payments, investments, own accounts, salary, PayNow', () => {
  const ctx = { accounts: [{ id: 'joint', name: 'Joint Account', patterns: ['0123-4567'] }, { id: 'uob1', name: 'UOB One' }], ownerNames: ['Marvin Yeo'], accountId: 'uob1' };
  const k = (desc, extra) => E.classifyFlow({ description: desc, amount: 100, ...extra }, ctx);
  assert.strictEqual(k('BILL PAYMENT MBK-UOB CARDS 1234').kind, 'transfer');
  assert.strictEqual(k('FAST PAYMENT TO ENDOWUS').reason, 'Investment / CPF / SRS');
  assert.strictEqual(k('FUNDS TRANSFER 0123-4567').counterpartyId, 'joint');
  assert.strictEqual(k('PAYNOW TRANSFER MARVIN YEO').kind, 'transfer');
  assert.strictEqual(k('GIRO SALARY AMAZON', { credit: true }).kind, 'income');
  const p = k('PAYNOW TO AH LIANG HOR FUN');
  assert.strictEqual(p.kind, 'expense'); assert.ok(p.review.includes('paynow'));
  assert.strictEqual(E.classifyFlow({ description: 'PAYMENT - THANK YOU', credit: true, amount: 500 }, { isCard: true }).kind, 'transfer');
  assert.strictEqual(E.classifyFlow({ description: 'ODD THING', credit: true, amount: 5 }, { isCard: true }).kind, 'refund');
  const ruled = E.classifyFlow({ description: 'PAYNOW TO CAROLINE TAN', amount: 50 }, { transferRules: [{ pattern: 'caroline tan', kind: 'transfer' }] });
  assert.strictEqual(ruled.kind, 'transfer');
});
test('pairTransfers matches an outflow to an equal inflow on another account within 4 days', () => {
  const L = [
    { id: 'o', accountId: 'uob1', date: '2026-10-01', amount: 2000, kind: 'expense', review: ['paynow'], direction: 'out' },
    { id: 'i', accountId: 'joint', date: '2026-10-02', amount: 2000, kind: 'income', review: ['incoming'], direction: 'in' },
    { id: 'x', accountId: 'joint', date: '2026-10-20', amount: 2000, kind: 'income', direction: 'in' },
  ];
  assert.strictEqual(E.pairTransfers(L), 1);
  assert.strictEqual(L[0].kind, 'transfer'); assert.strictEqual(L[1].transferPair, 'o');
  assert.deepStrictEqual(L[0].review, []); assert.strictEqual(L[2].kind, 'income');
});

test('bank statements: "BILL PAYMENT" / "FAST PAYMENT" are money out; card "PAYMENT - THANK YOU" is a credit', () => {
  const bank = E.parseStatementText('02 OCT  BILL PAYMENT MBK-UOB CARDS 4321   826.84\n06 OCT  FAST PAYMENT ENDOWUS   400.00\n07 OCT  PAYNOW FROM VANESSA   7.30 CR', { refDate: '2026-10-13', isCard: false });
  assert.deepStrictEqual(bank.map((r) => r.credit), [false, false, true]);
  const card = E.parseStatementText('03 OCT  PAYMENT - THANK YOU   500.00', { refDate: '2026-10-13' });
  assert.strictEqual(card[0].credit, true);
  assert.strictEqual(E.categorise('PAYNOW TO AH LIANG HOR FUN', [], []).merchant, 'Ah Liang Hor Fun');
});

console.log('splits & owed money');
test('your share excludes what others owe; the card still earns on the full bill', () => {
  const cards = household(); E.autoLink(cards, rules);
  const c = card(cards, "UOB Lady's Mastercard (Marvin)");
  const bill = txn({ id: 'bill', cardId: c.id, amount: 100, mcc: '5812', merchant: 'Restaurant', date: '2026-10-02',
    splits: [{ id: 's1', person: 'Vanessa Lim', amount: 30 }, { id: 's2', person: 'Aaron', amount: 30, status: 'collected' }] });
  close(E.yourShare(bill), 40);
  assert.strictEqual(E.openSplits(bill).length, 1);
  close(E.cardStatus(c, rules, [bill], '2026-10-13').caps[0].used, 100);
  const owed = E.owedSummary([bill], '2026-10-13');
  close(owed['Vanessa Lim'].owed, 30); assert.strictEqual(owed['Vanessa Lim'].items[0].ageDays, 11);
});
test('matchRepayments links PayNow-in by name and amount (single split or the person\'s total)', () => {
  const L = [
    { id: 'b1', date: '2026-09-01', amount: 60, kind: 'expense', splits: [{ id: 'x1', person: 'Vanessa', amount: 20 }] },
    { id: 'b2', date: '2026-09-05', amount: 45, kind: 'expense', splits: [{ id: 'x2', person: 'Vanessa', amount: 15 }, { id: 'x3', person: 'Sze Yin', amount: 15 }] },
    { id: 'i1', date: '2026-09-07', amount: 35, direction: 'in', kind: 'income', rawDescription: 'PAYNOW FROM VANESSA LIM' },
    { id: 'i2', date: '2026-09-08', amount: 15, direction: 'in', kind: 'income', rawDescription: 'PAYNOW FROM TAN SZE YIN' },
    { id: 'i3', date: '2026-09-08', amount: 15, direction: 'in', kind: 'income', rawDescription: 'PAYNOW FROM SOMEONE ELSE' },
  ];
  const m = E.matchRepayments(L);
  assert.strictEqual(m.length, 2);
  assert.deepStrictEqual(m[0].items.map((x) => x.splitId).sort(), ['x1', 'x2']);
  assert.strictEqual(m[1].items[0].splitId, 'x3');
  assert.ok(!E.personMatches('PAYNOW FROM VANESSALIM', 'Aaron'));
});

test('migrateContra merges share rows, names splits from "Collect from", assumes old unmatched settled', () => {
  const sh = (o) => ({ source: 'spreadsheet', direction: 'out', ...o });
  const L = [
    sh({ id: 'a', cardId: 'c1', date: '2026-03-01', merchant: 'Ramen', amount: 40, kind: 'expense', importKey: 'k1' }),
    sh({ id: 'b', cardId: 'c1', date: '2026-03-01', merchant: 'Ramen', amount: 40, kind: 'paid_for_others', importKey: 'k2' }),
    sh({ id: 'c', accountId: 'u1', date: '2026-03-03', merchant: 'Collect from Vanessa', rawDescription: 'Collect from Vanessa', amount: 40, kind: 'income', direction: 'in' }),
    sh({ id: 'd', cardId: 'c1', date: '2026-01-05', merchant: 'Pizza', amount: 30, kind: 'paid_for_others' }),
    sh({ id: 'e', cardId: 'c1', date: '2026-10-01', merchant: 'Dinner', amount: 25, kind: 'paid_for_others' }),
  ];
  const { ledger, stats } = E.migrateContra(L, '2026-10-15');
  assert.strictEqual(ledger.length, 4);
  const ramen = ledger.find((t) => t.id === 'a');
  close(ramen.amount, 80); close(E.yourShare(ramen), 40); assert.deepStrictEqual(ramen.importKeys, ['k1', 'k2']);
  assert.strictEqual(ramen.splits[0].person, 'Vanessa'); assert.strictEqual(ramen.splits[0].status, 'collected');
  assert.strictEqual(ledger.find((t) => t.id === 'c').kind, 'repayment');
  assert.strictEqual(ledger.find((t) => t.id === 'd').splits[0].status, 'assumed');
  assert.strictEqual(ledger.find((t) => t.id === 'e').splits[0].status, 'owed');
  assert.strictEqual(stats.stillOwed, 1);
});

test('pairTransfers with onlyIds never re-pairs confirmed history', () => {
  const L = [
    { id: 'h1', accountId: 'a', date: '2026-03-01', amount: 500, kind: 'transfer', direction: 'out', source: 'spreadsheet', reviewed: true },
    { id: 'h2', accountId: 'b', date: '2026-03-02', amount: 500, kind: 'income', direction: 'in', source: 'spreadsheet', reviewed: true },
    { id: 'n1', accountId: 'b', date: '2026-10-15', amount: 40, kind: 'income', direction: 'in', source: 'import', review: ['incoming'] },
  ];
  assert.strictEqual(E.pairTransfers(L, { onlyIds: ['n1'] }), 0);
  assert.strictEqual(L[1].kind, 'income');
});

test('migrateContra: one share repaid by several people; mislabelled "Collect from" rows; re-runnable', () => {
  const sh = (o) => ({ source: 'spreadsheet', direction: 'out', ...o });
  const L = [
    sh({ id: 'b', cardId: 'c1', date: '2026-07-22', merchant: 'Mama Diam', amount: 66.91, kind: 'expense' }),
    sh({ id: 'p', cardId: 'c1', date: '2026-07-22', merchant: 'Mama Diam', amount: 133.8, kind: 'paid_for_others' }),
    sh({ id: 'v', accountId: 'u', date: '2026-07-22', rawDescription: 'Collect from Vivian', merchant: 'Collect from Vivian', amount: 66.9, kind: 'income', direction: 'in' }),
    sh({ id: 'n', accountId: 'u', date: '2026-07-23', rawDescription: 'Collect from Naomi', merchant: 'Collect from Naomi', amount: 66.9, kind: 'income', direction: 'in' }),
    sh({ id: 'r', cardId: 'c1', date: '2026-02-09', merchant: 'Ramen', amount: 39, kind: 'paid_for_others' }),
    sh({ id: 'a', cardId: 'c1', date: '2026-02-24', rawDescription: 'Collect from Aaron', merchant: 'Collect from Aaron', amount: 39, kind: 'paid_for_others' }),
  ];
  const { ledger } = E.migrateContra(L, '2026-10-15');
  const md = ledger.find((t) => t.id === 'b');
  assert.deepStrictEqual(md.splits.map((x) => x.person + ':' + x.status).sort(), ['Naomi:collected', 'Vivian:collected']);
  const ramen = ledger.find((t) => t.id === 'r');
  assert.strictEqual(ramen.splits[0].person, 'Aaron'); assert.strictEqual(ramen.splits[0].status, 'collected');
  const again = E.migrateContra(ledger, '2026-10-15');   // second run changes nothing material
  assert.deepStrictEqual(E.owedSummary(again.ledger, '2026-10-15'), {});
});

console.log('investments');
const DIGI = [
  'Account Statement', 'TEST USER', 'Account Summary as at 31 Jul 2026', 'digiPortfolio',
  'digiPortfolio   Total: SGD Equivalent 1,290.00',
  'Portfolio: D-0000000001-1', 'Global Portfolio, High risk', 'Currency : United States Dollar', 'Fund source : CASH',
  'ISIN/   Description   Quantity Cost Value   Market Price   Market Value   Market',
  'SPYL   SPDR S&P 500 UCITS   36   492.62   18.3840   661.82   854.98',
  'ETF   13.6839   31 Jul 2026   169.20',
  'VDTY   VANGUARD USD   1   21.78   21.0190   21.02   27.15',
  'TREASURY BOND   21.7800   31 Jul 2026   -0.76',
  'UCITS ETF',
  'XMME   X MSCI EM 1C UCITS   4   300.00   80.0000   320.00   413.38',
  '(DR) ETF   75.0000   31 Jul 2026   20.00',
  'Cash   -4.33   -5.51',
  'Total Investment Value:   998.51   1,290.00',
  'Account Summary as of 31 Jul 2026   Page 1 of 3',
  'Transaction Details as at 31 Jul 2026', 'digiPortfolio', 'Portfolio No. D-0000000001-1', 'Global Portfolio, High risk', 'Currency : United States Dollar',
  'Transaction Date Transaction Type   Price   Currency   Debit   Credit',
  '08/07/2026   Management Fee (Inclusive of GST)   USD   12.60', 'AbC12 Annual Management Fee   12.60',
  '10/07/2026   Dividend   USD   0.07', 'EACPA260710A0 Cash Dividend   0.07',
  '14/07/2026   Sell   18.57   USD   37.14', '2026071400627 SPDR S&P 500 UCITS ETF   2   37.14', 'EltZ0.0',
  '16/07/2026   Buy   90.3563   USD   90.36', 'QAT3R4UTSQZR X MSCI EM 1C UCITS (DR) ETF   1   90.36',
  'Total Balance:   102.96   37.21',
].join('\n');
test('digiPortfolio statement parses and ties to its totals', () => {
  const p = E.parseDigiPortfolio(DIGI);
  assert.strictEqual(p.date, '2026-07-31');
  const pf = p.portfolios[0];
  assert.strictEqual(pf.currency, 'USD'); assert.strictEqual(pf.holdings.length, 3);
  const v = pf.holdings.find((h) => h.code === 'VDTY');
  assert.strictEqual(v.name, 'VANGUARD USD TREASURY BOND UCITS ETF'); assert.strictEqual(v.assetClass, 'Bonds'); close(v.pnl, -0.76);
  close(pf.holdings.reduce((s, h) => s + h.value, 0) + pf.cash, pf.totalCcy);
  const debit = pf.activity.filter((a) => a.debit).reduce((s, a) => s + a.amount, 0);
  close(debit, pf.txTotals.debit);
  assert.strictEqual(pf.activity.find((a) => a.type === 'buy').code, 'XMME');
  assert.strictEqual(pf.activity.find((a) => a.type === 'sell').units, 2);
  close(pf.fx, 1290 / 998.51);
});
test('importing the same statement twice changes nothing', () => {
  const inv = {}; let n = 0; const newId = () => 'x' + (++n);
  E.mergeInvestmentStatement(inv, E.parseDigiPortfolio(DIGI), { newId });
  const again = E.mergeInvestmentStatement(inv, E.parseDigiPortfolio(DIGI), { newId });
  assert.strictEqual(inv.accounts.length, 1); assert.strictEqual(inv.snapshots.length, 1);
  assert.strictEqual(inv.activity.length, 4); assert.strictEqual(again.activity, 0);
});
test('summary: gain excludes new money; contributions and dividends come from bank lines', () => {
  const inv = { accounts: [{ id: 'e', name: 'Endowus', type: 'robo', patterns: ['ENDOWUS', 'INVESTMENT SECURITIES'] }, { id: 's', name: 'SGX shares', type: 'shares', patterns: [] }],
    snapshots: [{ accountId: 'e', date: '2026-01-31', valueSgd: 1000, source: 'manual' }, { accountId: 'e', date: '2026-06-30', valueSgd: 1600, source: 'manual' }], activity: [] };
  const L = [
    { id: 'b1', date: '2026-03-11', amount: 500, direction: 'out', kind: 'transfer', rawDescription: 'Advice FAST Collection SGA11036 INVESTMENT & SECURITIES', source: 'import' },
    { id: 'b2', date: '2026-03-11', amount: 500, direction: 'out', kind: 'transfer', rawDescription: 'Money to Endowus', source: 'spreadsheet' },
    { id: 'd1', date: '2026-03-02', amount: 33.94, direction: 'in', kind: 'income', rawDescription: 'Dividends (OUE)' },
    { id: 'x', date: '2026-03-05', amount: 12, direction: 'out', kind: 'expense', rawDescription: 'Lunch' },
  ];
  const S = E.investmentSummary(inv, L, '2026-07-01');
  const e = S.accounts.find((a) => a.account.id === 'e');
  close(e.contributedAll, 500);          // the spreadsheet row and the bank line are one transfer
  close(e.ytd.gain, 100);                // 1600 - 1000 - 500
  assert.ok(e.ytd.ret > 0.07 && e.ytd.ret < 0.08);
  close(S.accounts.find((a) => a.account.id === 's').dividendsYtd, 33.94);
  assert.strictEqual(S.unassigned.length, 0);
});
test('prepared investments file: opening value anchors since-start return; bank debits matched to platform deposits', () => {
  const inv = { accounts: [{ id: 'old', name: 'Endowus', type: 'robo', patterns: ['ENDOWUS'] }], snapshots: [], activity: [] };
  const P = { format: 'fp-investments', accounts: [{ key: 'kid', name: 'Kid fund', provider: 'Robo', patterns: ['INVESTMENT & SECURITIES'], replaces: ['Endowus'] }],
    snapshots: [{ account: 'kid', date: '2025-01-09', valueSgd: 0, opening: true }, { account: 'kid', date: '2026-10-16', valueSgd: 1300, holdings: [{ name: 'Prime USA Fund', units: 5, price: 260, valueSgd: 1300, expenseRatio: 0.0005 }] }],
    activity: [{ account: 'kid', date: '2025-01-10', type: 'deposit', amount: 1000 }, { account: 'kid', date: '2026-03-12', type: 'deposit', amount: 200 }, { account: 'kid', date: '2026-04-16', type: 'fee', amount: 3 }, { account: 'kid', date: '2026-06-10', type: 'cashback', amount: 1 }] };
  const r = E.mergeInvestmentData(inv, P, { newId: (() => { let n = 0; return () => 'n' + (++n); })() });
  assert.deepStrictEqual(r.updated, ['Kid fund']); assert.strictEqual(inv.accounts.length, 1);   // took over the empty "Endowus" account
  assert.strictEqual(E.mergeInvestmentData(inv, P).activity, 0);
  const L = [{ id: 'b', date: '2026-03-11', amount: 200, direction: 'out', kind: 'transfer', rawDescription: 'FAST Collection INVESTMENT & SECURITIES', source: 'import' }];
  const a = E.investmentSummary(inv, L, '2026-10-16').accounts[0];
  close(a.contributedAll, 1200);             // the DBS debit is the platform's 12 Mar deposit, not extra money
  assert.strictEqual(a.ytd, null);            // no year-end value, so no "this year" figure
  close(a.sinceStart.gain, 100); close(a.cashbackYtd, 1);
  assert.strictEqual(a.allocation.holdings[0].region, 'US');
});
test('xirr: 10% over exactly one year', () => {
  close(E.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 0.1);
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

test('bond coupons paid out count toward the gain; partial-year fees are annualised', () => {
  const inv = { accounts: [], snapshots: [], activity: [] };
  E.mergeInvestmentData(inv, { format: 'fp-investments', accounts: [{ key: 'b', name: 'Bond', provider: 'X', type: 'other' }, { key: 'r', name: 'Robo', provider: 'X', type: 'robo' }],
    snapshots: [{ account: 'b', date: '2025-12-31', valueSgd: 10000, holdings: [{ name: 'Bond', value: 10000, valueSgd: 10000, assetClass: 'Bonds' }] }, { account: 'b', date: '2026-10-16', valueSgd: 10000, holdings: [{ name: 'Bond', value: 10000, valueSgd: 10000, assetClass: 'Bonds' }] },
      { account: 'r', date: '2026-03-31', valueSgd: 12000 }, { account: 'r', date: '2026-09-30', valueSgd: 12000 }],
    activity: [{ account: 'b', date: '2026-06-01', type: 'dividend', amount: 300, paidOut: true }, { account: 'r', date: '2026-06-30', type: 'fee', amount: 30 }, { account: 'r', date: '2026-09-30', type: 'fee', amount: 30 }] });
  const s = E.investmentSummary(inv, [], '2026-10-16');
  const b = s.accounts.find((a) => a.account.name === 'Bond'), r = s.accounts.find((a) => a.account.name === 'Robo');
  close(b.ytd.gain, 300); close(b.ytd.paidOut, 300);
  close(r.feeRate, (60 / 12000) * (365 / 199), 0.0005);
  assert(E.investmentInsights(s, inv).some((i) => /in interest over the last 12 months/.test(i.text)));
});

test('reconcileStatement: matches logged lines, splits, near-misses, not-logged and missing', () => {
  const ledger = [
    { id: 'a', date: '2026-10-02', amount: 12.5, cardId: 'C', kind: 'expense', source: 'manual' },
    { id: 'b', date: '2026-10-05', amount: 30, cardId: 'C', kind: 'expense' },
    { id: 'c', date: '2026-10-05', amount: 20, cardId: 'C', kind: 'expense' },
    { id: 'd', date: '2026-10-08', amount: 41, cardId: 'C', kind: 'expense' },
    { id: 'e', date: '2026-10-09', amount: 99, cardId: 'C', kind: 'expense' },
    { id: 'f', date: '2026-10-09', amount: 99, cardId: 'OTHER', kind: 'expense' },
  ];
  const lines = [
    { date: '2026-10-03', amount: 12.5, description: 'KOPI' },
    { date: '2026-10-05', amount: 50, description: 'DINNER' },
    { date: '2026-10-08', amount: 43.1, description: 'GRAB' },
    { date: '2026-10-07', amount: 7.7, description: 'NEW THING' },
  ];
  const r = E.reconcileStatement(lines, ledger, { cardId: 'C' });
  assert.deepStrictEqual(r.matched.map((m) => m.i).sort(), [0, 1]);
  assert.deepStrictEqual(r.matched.find((m) => m.i === 1).txnIds.sort(), ['b', 'c']);
  assert.strictEqual(r.differs[0].txnId, 'd'); close(r.differs[0].diff, 2.1);
  assert.deepStrictEqual(r.unmatched, [3]);
  assert.deepStrictEqual(r.missing, []);   // 'e' (10-09) is after the last statement line
  const r2 = E.reconcileStatement(lines, ledger, { cardId: 'C', to: '2026-10-10' });
  assert.deepStrictEqual(r2.missing, ['e']);
});
test('mergeData keeps both people\'s edits', () => {
  const base = { transactions: [{ id: '1', amount: 1 }, { id: '2', amount: 2 }], settings: { a: 1, b: 1 } };
  const local = { transactions: [{ id: '1', amount: 10 }, { id: '3', amount: 3 }], settings: { a: 2, b: 1 } };          // edit 1, delete 2, add 3, change a
  const remote = { transactions: [{ id: '1', amount: 1 }, { id: '2', amount: 2 }, { id: '4', amount: 4 }], settings: { a: 1, b: 5 } }; // add 4, change b
  const m = E.mergeData(base, local, remote);
  assert.deepStrictEqual(m.transactions.map((t) => t.id + ':' + t.amount).sort(), ['1:10', '3:3', '4:4']);
  assert.deepStrictEqual(m.settings, { a: 2, b: 5 });
});
test('ghost tracking: position, rate and switch', () => {
  const prices = { VWRA: [{ date: '2026-10-16', price: 100 }, { date: '2027-01-16', price: 110 }], USDSGD: [{ date: '2026-10-16', price: 1.3 }, { date: '2027-01-16', price: 1.3 }], ES3: [{ date: '2026-10-16', price: 4 }, { date: '2027-01-16', price: 4.2 }] };
  const pos = E.ghostResult({ ghost: { kind: 'position', ticker: 'VWRA', ccy: 'USD', amountSgd: 13000, date: '2026-10-16' } }, prices, '2027-01-16');
  close(pos.gain, 1300);
  const rate = E.ghostResult({ ghost: { kind: 'rate', amountSgd: 100000, fromRate: 0.01, toRate: 1.95, date: '2026-10-16' } }, prices, '2027-10-16');
  close(rate.gain, 1940);
  const sw = E.ghostResult({ ghost: { kind: 'switch', from: { ticker: 'ES3' }, to: { ticker: 'VWRA', ccy: 'USD' }, amountSgd: 10000, date: '2026-10-16' } }, prices, '2027-01-16');
  close(sw.gain, 500);
  const s = E.adviceSummary([{ status: 'rejected', ghost: { kind: 'rate', amountSgd: 100000, fromRate: 0, toRate: 2, date: '2026-01-01' } }], prices, '2026-12-31');
  assert.ok(s.notTaken > 1990 && s.notTaken < 2000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
