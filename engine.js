/* =====================================================================
 * FPEngine — rule-based card optimisation engine for Financial Planner
 * Pure functions, no DOM. Loaded by index.html and testable in Node.
 *
 * Concepts
 *  - rules      : rules.json (card definitions, refreshed weekly)
 *  - card       : a card the household holds (data.cards[i]); links to a
 *                 definition via card.ruleId, and carries card.options
 *  - ledger     : data.transactions[] — every logged / imported expense
 *  - cycle      : calendar month or statement period a cap/condition uses
 *  - capGroup   : a cap shared by one or more bonuses (spend or cashback)
 *  - policy     : miles first; cashback only if it beats miles by N ¢/$
 * ===================================================================== */
(function (root) {
  'use strict';

  const ENGINE_VERSION = '2.0.0';

  /* ---------------- small utils ---------------- */
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const pad = (n) => String(n).padStart(2, '0');
  const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function textHas(hay, needles) {
    if (!needles || !needles.length) return false;
    const h = ' ' + norm(hay) + ' ';
    const squashed = norm(hay).replace(/ /g, '');
    return needles.some((n) => {
      const k = norm(n);
      if (!k) return false;
      if (k.length <= 3) return h.includes(' ' + k + ' ');          // short names: whole word only
      if (h.includes(' ' + k)) return true;                          // word-start prefix ("grab" ⊂ "grabfood")
      return k.includes(' ') && squashed.includes(k.replace(/ /g, '')); // "cold storage" vs "COLDSTORAGE"
    });
  }

  /* ---------------- MCC lists ---------------- */
  function expandList(list, def, rules) {
    const out = [];
    (list || []).forEach((item) => {
      const s = String(item).trim();
      if (s.startsWith('@')) {
        const key = s.slice(1);
        const src = (def && def.lists && def.lists[key]) || (rules && rules.sharedLists && rules.sharedLists[key]) || [];
        out.push(...expandList(src, def, rules));
      } else out.push(s);
    });
    return out;
  }
  const _rangeCache = new Map();
  function mccIn(mcc, list) {
    if (mcc == null || mcc === '' || !list || !list.length) return false;
    const key = list.join(',');
    let ranges = _rangeCache.get(key);
    if (!ranges) {
      ranges = list.map((s) => {
        const m = String(s).match(/^(\d{1,4})\s*-\s*(\d{1,4})$/);
        return m ? [+m[1], +m[2]] : [+s, +s];
      });
      _rangeCache.set(key, ranges);
    }
    const n = +mcc;
    return ranges.some(([a, b]) => n >= a && n <= b);
  }

  /* ---------------- dates & cycles ---------------- */
  const parseYmd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  /** Window of the calendar month or statement period that contains dateStr. */
  function cycleFor(cycleType, statementDay, dateStr) {
    const d = parseYmd(dateStr);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const sd = parseInt(statementDay, 10);
    if (cycleType !== 'statement' || !sd) {
      return { type: 'calendar', start: ymd(new Date(Date.UTC(y, m, 1))), end: ymd(new Date(Date.UTC(y, m, daysIn(y, m)))), key: `${y}-${pad(m + 1)}` };
    }
    let ey = y, em = m;
    if (day > Math.min(sd, daysIn(y, m))) { em += 1; if (em > 11) { em = 0; ey += 1; } }
    const end = new Date(Date.UTC(ey, em, Math.min(sd, daysIn(ey, em))));
    let sy = ey, sm = em - 1; if (sm < 0) { sm = 11; sy -= 1; }
    const start = new Date(Date.UTC(sy, sm, Math.min(sd, daysIn(sy, sm)) + 1));
    return { type: 'statement', start: ymd(start), end: ymd(end), key: 'S' + ymd(end) };
  }
  const inWindow = (dateStr, w) => dateStr >= w.start && dateStr <= w.end;
  function daysUntil(dateStr, fromStr) { return Math.round((parseYmd(dateStr) - parseYmd(fromStr)) / 86400000); }

  /* ---------------- rules resolution ---------------- */
  function findDef(rules, id) { return (rules && rules.cards || []).find((c) => c.id === id) || null; }

  /** Best rules definition for a held card: explicit ruleId, else longest alias match. */
  function matchDefByName(rules, name) {
    const n = ' ' + norm(name) + ' ';
    let best = null, bestLen = 0;
    (rules && rules.cards || []).forEach((def) => {
      (def.names || []).forEach((alias) => {
        const a = norm(alias);
        if (a && n.includes(' ' + a + ' ') || (a && n.includes(' ' + a))) {
          if (a.length > bestLen) { best = def; bestLen = a.length; }
        }
      });
    });
    return best;
  }

  /** Convert the app's old bonusRules format into a definition so unlinked cards still work. */
  function legacyToDef(card) {
    const tp = (card.transferPartners || [])[0];
    const ratio = tp ? (num(tp.ratio) || 1) : 1;
    const toMpd = (rate) => r2(num(rate) / ratio);
    const bonuses = [];
    const capGroups = {};
    (card.bonusRules || []).forEach((r, i) => {
      const id = 'legacy-' + i;
      const b = { id, label: r.category || ('Bonus ' + (i + 1)), mpd: toMpd(r.rate), when: {} };
      if (r.mcc) b.when.mcc = String(r.mcc).split(/[,\s]+/).filter(Boolean);
      else b.when.categoryText = [r.category];
      if (r.monthlyCap) { capGroups[id] = { spend: num(r.monthlyCap) }; b.cap = [id]; }
      if (r.threshold) {
        b.requires = [];
        if (r.threshold.minMonthlySpend) b.requires.push({ type: 'minSpend', amount: num(r.threshold.minMonthlySpend), basis: 'card', label: 'S$' + r.threshold.minMonthlySpend + ' spend' });
      }
      bonuses.push(b);
    });
    const isCash = /cash/i.test(card.pointsCurrency || '') || /cimb/i.test(card.name || '');
    return {
      id: 'legacy:' + card.name, legacy: true, names: [card.name], issuer: card.issuer,
      reward: isCash ? { type: 'cashback', pct: num(card.baseRate), fcyPct: num(card.baseRate) } : { type: 'miles', mpd: toMpd(card.baseRate || 1), fcyMpd: toMpd(card.baseRate || 1), rounding: { mode: 'exact' } },
      programs: tp ? { [tp.partner]: 1 } : { KrisFlyer: 1 },
      cycle: card.cycleType === 'statement' ? 'statement' : 'calendar',
      exclusions: { mcc: [] }, bonuses, capGroups,
    };
  }

  function resolveDef(card, rules) {
    if (card.ruleId === 'legacy') return legacyToDef(card);
    if (card.ruleId) { const d = findDef(rules, card.ruleId); if (d) return d; }
    return matchDefByName(rules, card.name) || legacyToDef(card);
  }

  /** Set ruleId on cards that match a definition by name. Returns number linked. */
  function autoLink(cards, rules) {
    let n = 0;
    (cards || []).forEach((c) => {
      if (c.ruleId === 'legacy' || (c.ruleId && findDef(rules, c.ruleId))) return;
      const d = matchDefByName(rules, c.name);
      if (d) { c.ruleId = d.id; n++; }
    });
    return n;
  }

  function optionValue(card, def, key) {
    const o = card.options || {};
    if (o[key] !== undefined && o[key] !== '') return o[key];
    const spec = def.options && def.options[key];
    return spec ? spec.default : undefined;
  }

  /* ---------------- matching ---------------- */
  function matchWhen(when, txn, card, def, rules) {
    if (!when) return true;
    if (when.channels && !when.channels.includes(txn.channel)) return false;
    if (when.fcy === true && !txn.fcy) return false;
    if (when.fcy === false && txn.fcy) return false;
    if (when.noWallet && txn.wallet) return false;
    if (when.mccExclude && mccIn(txn.mcc, expandList(when.mccExclude, def, rules))) return false;
    if (when.merchantsExclude && textHas(txn.merchant, when.merchantsExclude)) return false;
    if (when.anyOf) return when.anyOf.some((w) => matchWhen(w, txn, card, def, rules));

    const tests = [];
    if (when.mcc) tests.push(() => mccIn(txn.mcc, expandList(when.mcc, def, rules)));
    if (when.merchants) tests.push(() => textHas(txn.merchant, when.merchants));
    if (when.merchantGroup) tests.push(() => !!merchantGroupKey(def, when.merchantGroup, txn.merchant));
    if (when.merchantsOption) tests.push(() => textHas(txn.merchant, String(optionValue(card, def, when.merchantsOption) || '').split(',')));
    if (when.categoryText) tests.push(() => textHas((txn.category || '') + ' ' + (txn.merchant || ''), when.categoryText));
    if (when.optionCategory) {
      tests.push(() => {
        const spec = def.options && def.options[when.optionCategory];
        const choice = spec && spec.choices[optionValue(card, def, when.optionCategory)];
        return !!choice && mccIn(txn.mcc, expandList(choice.mcc, def, rules));
      });
    }
    return tests.length === 0 || tests.some((t) => t());
  }

  function merchantGroupKey(def, group, merchant) {
    const groups = (def.merchantGroups && def.merchantGroups[group]) || [];
    for (let i = 0; i < groups.length; i++) if (textHas(merchant, groups[i])) return group + ':' + i;
    return null;
  }

  function isExcluded(txn, def, rules) {
    const ex = def.exclusions || {};
    return mccIn(txn.mcc, expandList(ex.mcc, def, rules)) || textHas(txn.merchant, ex.merchants);
  }

  function bonusActive(b, dateStr) {
    if (b.validFrom && dateStr < b.validFrom) return false;
    if (b.validTo && dateStr > b.validTo) return false;
    return true;
  }

  /* ---------------- rounding & rates ---------------- */
  function roundedAmount(amount, rounding) {
    const a = num(amount);
    if (!rounding || rounding.mode === 'exact') return a;
    const block = num(rounding.block) || 1;
    return Math.floor(a / block + 1e-9) * block;
  }
  function bonusRate(b, card, def) {
    let rate = def.reward.type === 'cashback' ? num(b.pct) : num(b.mpd);
    if (b.rateAdd) {
      const spec = def.options && def.options[b.rateAdd];
      const choice = spec && spec.choices[optionValue(card, def, b.rateAdd)];
      if (choice) rate += num(choice.add);
    }
    return rate;
  }
  function baseRate(def, txn) {
    const r = def.reward;
    if (r.type === 'cashback') return num(txn.fcy ? (r.fcyPct ?? r.pct) : r.pct);
    return num(txn.fcy ? (r.fcyMpd ?? r.mpd) : r.mpd);
  }
  /** Value in SGD cents per mile for the card's best programme. */
  function bestProgramme(def, settings) {
    const vals = (settings && settings.mile_valuations) || {};
    const fallback = num(settings && settings.defaultMileValue) || 1.5;
    let best = { name: 'KrisFlyer', mult: 1, cents: num(vals.KrisFlyer) || fallback, value: 0 };
    let bestVal = -1;
    Object.entries(def.programs || { KrisFlyer: 1 }).forEach(([name, mult]) => {
      const cents = num(vals[name]) || fallback;
      const v = num(mult) * cents;
      if (v > bestVal) { bestVal = v; best = { name, mult: num(mult), cents, value: v }; }
    });
    return best;
  }

  /* ---------------- conditions ---------------- */
  /**
   * Evaluate a bonus's requirements against the cycle's transactions on this card.
   * Returns { status: 'met'|'committed'|'unmet', items: [{label, progress, target, met}] }
   */
  function evalRequires(b, card, def, cycleTxns, rules, extraTxn) {
    const reqs = b.requires || [];
    if (!reqs.length) return { status: 'met', items: [] };
    const txns = extraTxn ? cycleTxns.concat([extraTxn]) : cycleTxns;
    const items = reqs.map((r) => {
      if (r.type === 'option') {
        const v = optionValue(card, def, r.key);
        const met = (r.equals === undefined) ? !!v : (!!v === !!r.equals);
        return { label: r.label || r.key, met, option: true };
      }
      if (r.type === 'minSpend') {
        const pool = txns.filter((t) => !isExcluded(t, def, rules) && (r.basis !== 'bonus' || matchWhen(b.when, t, card, def, rules)));
        const progress = r2(pool.reduce((s, t) => s + num(t.amount), 0));
        return { label: r.label || 'Minimum spend', progress, target: num(r.amount), met: progress >= num(r.amount), money: true };
      }
      if (r.type === 'distinctMerchants') {
        const seen = new Set();
        txns.forEach((t) => { const k = merchantGroupKey(def, r.group, t.merchant); if (k) seen.add(k); });
        return { label: r.label || 'Distinct merchants', progress: seen.size, target: num(r.count), met: seen.size >= num(r.count) };
      }
      return { label: r.label || r.type, met: true };
    });
    const allMet = items.every((i) => i.met);
    if (allMet) return { status: 'met', items };
    // An option condition that fails is a hard "no"; spend conditions can be committed to.
    if (items.some((i) => i.option && !i.met)) return { status: 'unmet', items, hard: true };
    const commits = (card.options && card.options.commit) || {};
    if (commits[b.id]) return { status: 'committed', items };
    return { status: 'unmet', items };
  }

  /* ---------------- cap accounting ---------------- */
  function emptyUsage() { return { spend: 0, cashback: 0 }; }

  /** Spend that can still go to bonus b given the cap groups it draws from. */
  function capRoom(b, rate, def, usage) {
    let room = Infinity;
    (b.cap || []).forEach((g) => {
      const spec = (def.capGroups || {})[g];
      if (!spec) return;
      const u = usage[g] || emptyUsage();
      if (spec.spend != null) room = Math.min(room, Math.max(0, num(spec.spend) - u.spend));
      if (spec.cashback != null) room = Math.min(room, rate > 0 ? Math.max(0, num(spec.cashback) - u.cashback) / (rate / 100) : 0);
    });
    return room;
  }
  function consume(b, spend, rate, usage) {
    (b.cap || []).forEach((g) => {
      const u = usage[g] || (usage[g] = emptyUsage());
      u.spend += spend;
      u.cashback += spend * rate / 100;
    });
  }

  /**
   * Core earning calculation for one transaction on one card.
   * usage is mutated (caps consumed). condFn(b) returns a requires result.
   */
  function allocate(txn, card, def, rules, usage, condFn) {
    const amount = num(txn.amount);
    const isCash = def.reward.type === 'cashback';
    const result = { cardId: card.id, cardName: card.name, ruleId: def.id, type: isCash ? 'cashback' : 'miles', amount, excluded: false, pieces: [], conditions: [], notes: [], miles: 0, cashback: 0 };
    if (amount <= 0) return result;
    if (isExcluded(txn, def, rules)) { result.excluded = true; result.notes.push('Excluded from rewards on this card'); return result; }

    const date = txn.date || ymd(new Date());
    const candidates = [];
    (def.bonuses || []).forEach((b) => {
      if (!bonusActive(b, date) || !matchWhen(b.when, txn, card, def, rules)) return;
      const cond = condFn(b);
      if (cond.status === 'unmet') { result.conditions.push({ bonus: b, cond, applied: false }); return; }
      result.conditions.push({ bonus: b, cond, applied: true });
      candidates.push({ b, rate: bonusRate(b, card, def), cond });
    });
    candidates.sort((x, y) => y.rate - x.rate);

    let remaining = amount;
    const base = baseRate(def, txn);
    for (const c of candidates) {
      if (remaining <= 0) break;
      if (c.rate <= base) continue;
      const room = capRoom(c.b, c.rate, def, usage);
      const take = Math.min(remaining, room);
      if (take <= 0) { result.notes.push(`${c.b.label}: cap reached`); continue; }
      consume(c.b, take, c.rate, usage);
      result.pieces.push({ bonusId: c.b.id, label: c.b.label, spend: r2(take), rate: c.rate, committed: c.cond.status === 'committed', capRoomBefore: room === Infinity ? null : r2(room) });
      if (take < remaining && room !== Infinity) result.notes.push(`Only S$${r2(take)} fits under the ${c.b.label} cap`);
      remaining -= take;
    }
    if (remaining > 0) result.pieces.push({ bonusId: null, label: 'Base rate', spend: r2(remaining), rate: base });

    // Rounding: scale pieces by the rounded/actual ratio (block rounding per transaction).
    const factor = amount > 0 ? roundedAmount(amount, def.reward.rounding) / amount : 0;
    result.pieces.forEach((p) => {
      const earned = p.spend * factor * p.rate;
      if (isCash) result.cashback += earned / 100; else result.miles += earned;
    });
    result.miles = r2(result.miles);
    result.cashback = r2(result.cashback);
    if (factor < 1 && factor >= 0 && def.reward.rounding && def.reward.rounding.block > 1) {
      const lost = amount - roundedAmount(amount, def.reward.rounding);
      if (lost > 0.009) result.notes.push(`S$${r2(lost)} lost to S$${def.reward.rounding.block} earning blocks`);
    }
    return result;
  }

  /* ---------------- card state from the ledger ---------------- */
  /**
   * Transaction kinds:
   *   expense          — household spending (default)
   *   paid_for_others  — you paid, someone pays you back; earns on the card but isn't your spending
   *   transfer         — money moving between your own accounts (card bill payments, top-ups, savings)
   *   income           — salary, interest, repayments, reimbursements
   *   refund           — merchant refund / reversal
   */
  const KINDS = ['expense', 'paid_for_others', 'transfer', 'income', 'refund', 'repayment'];
  const kindOf = (t) => (t && KINDS.includes(t.kind) ? t.kind : 'expense');
  /** Does this txn count toward card caps, minimum spend and rewards? */
  const earnsOnCard = (t) => { const k = kindOf(t); return k === 'expense' || k === 'paid_for_others'; };
  /** Does this txn count as household spending? */
  const isSpending = (t) => kindOf(t) === 'expense';

  /* ---------------- splits: you paid the bill, others owe you their share ---------------- */
  // t.splits = [{ id, person, amount, status: 'owed'|'collected'|'forgiven', collectedOn, repaymentId }]
  const splitsOf = (t) => (t && Array.isArray(t.splits) ? t.splits : []);
  /** Your own share of a transaction (what counts as your spending). */
  function yourShare(t) {
    const k = kindOf(t);
    if (k === 'paid_for_others') return 0;
    if (k !== 'expense') return 0;
    return r2(Math.max(0, num(t.amount) - splitsOf(t).reduce((s, x) => s + num(x.amount), 0)));
  }
  /** Amounts others owe you on this transaction that haven't come back yet. */
  function openSplits(t) { return splitsOf(t).filter((x) => (x.status || 'owed') === 'owed'); }
  function normPerson(s) { return norm(s).replace(/\b(mr|ms|mrs|dr)\b/g, '').trim(); }
  /** Does a statement description / name refer to this person? (first name or full name, either order) */
  function personMatches(text, person) {
    const t = ' ' + norm(text) + ' ', p = normPerson(person);
    if (!p) return false;
    if (t.includes(' ' + p + ' ')) return true;                 // full name as written
    const parts = p.split(' ').filter((w) => w.length >= 3);
    if (!parts.length) return false;
    if (parts.length === 1) return t.includes(' ' + parts[0] + ' '); // "Vanessa" in "PAYNOW FROM VANESSA LIM"
    return parts.every((w) => t.includes(' ' + w + ' '));        // all name parts, any order
  }
  /**
   * Suggest links between incoming money (income/repayment not yet linked) and open splits.
   * Match on person name in the description and amount = one split or the sum of that person's open splits,
   * within `days` after the bill. Returns [{ incomingId, person, amount, items:[{txnId, splitId, amount}] }].
   */
  function matchRepayments(ledger, opts) {
    opts = opts || {};
    const days = opts.days || 90;
    const open = [];
    (ledger || []).forEach((t) => openSplits(t).forEach((sp) => open.push({ t, sp })));
    const incoming = (ledger || []).filter((t) => t.direction === 'in' && !t.repays && (kindOf(t) === 'income' || kindOf(t) === 'repayment' || kindOf(t) === 'transfer' && (t.review || []).length));
    const used = new Set(), out = [];
    incoming.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((inc) => {
      const desc = (inc.rawDescription || '') + ' ' + (inc.merchant || '') + ' ' + (inc.note || '');
      const cands = open.filter((o) => !used.has(o.sp.id) && personMatches(desc, o.sp.person) &&
        o.t.date <= inc.date && daysUntil(inc.date, o.t.date) <= days);
      if (!cands.length) return;
      const amt = num(inc.amount);
      // single split with the same amount (closest bill first)
      let pick = cands.filter((o) => Math.abs(num(o.sp.amount) - amt) < 0.005).sort((a, b) => (a.t.date > b.t.date ? -1 : 1)).slice(0, 1);
      // or all of that person's open splits together
      if (!pick.length) {
        const byPerson = {};
        cands.forEach((o) => (byPerson[normPerson(o.sp.person)] = byPerson[normPerson(o.sp.person)] || []).push(o));
        for (const list of Object.values(byPerson)) if (Math.abs(list.reduce((s, o) => s + num(o.sp.amount), 0) - amt) < 0.005) { pick = list; break; }
      }
      if (!pick.length) return;
      pick.forEach((o) => used.add(o.sp.id));
      out.push({ incomingId: inc.id, person: pick[0].sp.person, amount: amt, items: pick.map((o) => ({ txnId: o.t.id, splitId: o.sp.id, amount: num(o.sp.amount) })) });
    });
    return out;
  }
  /**
   * One-time conversion of spreadsheet "Contra" history into splits + linked repayments.
   * Mutates and returns { ledger, stats }. Only touches rows with source === 'spreadsheet'.
   */
  function migrateContra(ledger, asOf, opts) {
    opts = opts || {};
    const settleAfterDays = opts.settleAfterDays == null ? 60 : opts.settleAfterDays;
    let L = ledger.slice();
    const stats = { merged: 0, standalone: 0, linked: 0, linkedGroups: 0, assumed: 0, stillOwed: 0, repaymentsUnlinked: 0 };
    const isSheet = (t) => t.source === 'spreadsheet';
    const src = (t) => t.cardId || t.accountId || t.cardName || '';
    let n = 0; const sid = () => 'sp_mig' + (++n);
    // 1. merge "your share + friend's share" rows into one bill
    const groups = new Map();
    L.forEach((t) => { if (!isSheet(t)) return; const k = src(t) + '|' + t.date + '|' + norm(t.merchant); (groups.get(k) || groups.set(k, []).get(k)).push(t); });
    const drop = new Set();
    groups.forEach((g) => {
      const own = g.filter((t) => kindOf(t) === 'expense');
      const others = g.filter((t) => kindOf(t) === 'paid_for_others');
      if (!own.length || !others.length) return;
      const base = own[0];
      base.splits = splitsOf(base).concat(others.map((o) => ({ id: sid(), person: '', amount: num(o.amount), status: 'owed', fromRow: o.importKey })));
      base.amount = r2(num(base.amount) + others.reduce((s, o) => s + num(o.amount), 0));
      base.importKeys = [base.importKey].concat(others.map((o) => o.importKey)).filter(Boolean);
      others.forEach((o) => drop.add(o.id));
      stats.merged += others.length;
    });
    L = L.filter((t) => !drop.has(t.id));
    // 2. standalone "paid for others" → bill with the whole amount owed
    L.forEach((t) => {
      if (!isSheet(t) || kindOf(t) !== 'paid_for_others') return;
      t.kind = 'expense';
      t.splits = [{ id: sid(), person: '', amount: num(t.amount), status: 'owed' }];
      stats.standalone++;
    });
    // 3. link "Collect from X" (and work reimbursements of an exact bill) to splits
    const nameOf = (t) => { const m = String(t.rawDescription || '').match(/collect(?:ed)?\s+from\s+([^(]+)/i); return m ? m[1].trim() : (/reimburse/i.test(t.rawDescription || '') ? 'Work (reimbursement)' : ''); };
    const cols = L.filter((t) => isSheet(t) && t.direction === 'in' && (kindOf(t) === 'income' || kindOf(t) === 'refund') && nameOf(t))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const open = () => { const o = []; L.forEach((t) => splitsOf(t).forEach((sp) => { if (sp.status === 'owed') o.push({ t, sp }); })); return o; };
    const settle = (c, picks, person) => {
      picks.forEach(({ sp }) => { sp.person = sp.person || person; sp.status = 'collected'; sp.collectedOn = c.date; sp.repaymentId = c.id; });
      c.kind = 'repayment'; c.repays = picks.map(({ t, sp }) => ({ txnId: t.id, splitId: sp.id, amount: num(sp.amount) }));
    };
    cols.forEach((c) => {
      const person = nameOf(c), amt = num(c.amount);
      const cand = open().filter(({ t, sp }) => t.date <= c.date && daysUntil(c.date, t.date) <= 90 && (!sp.person || personMatches(person, sp.person)))
        .sort((a, b) => (a.t.date > b.t.date ? -1 : 1));
      const one = cand.find(({ sp }) => Math.abs(num(sp.amount) - amt) < 0.005);
      if (one) { settle(c, [one], person); stats.linked++; return; }
      const near = cand.filter(({ t }) => daysUntil(c.date, t.date) <= 31).slice(0, 10);
      for (let k = 2; k <= 4; k++) {
        for (const combo of combos(near, k)) {
          if (Math.abs(combo.reduce((s, x) => s + num(x.sp.amount), 0) - amt) < 0.005) { settle(c, combo, person); stats.linkedGroups++; return; }
        }
      }
      if (/collect/i.test(c.rawDescription || '')) { c.kind = 'repayment'; stats.repaymentsUnlinked++; }
    });
    // 4. older unmatched splits: assume settled outside the records
    L.forEach((t) => splitsOf(t).forEach((sp) => {
      if (sp.status !== 'owed') return;
      if (!sp.person) sp.person = 'Unassigned';
      if (daysUntil(asOf, t.date) > settleAfterDays) { sp.status = 'assumed'; stats.assumed++; } else stats.stillOwed++;
    }));
    return { ledger: L, stats };
  }
  function* combos(arr, k, start) {
    start = start || 0;
    if (k === 0) { yield []; return; }
    for (let i = start; i <= arr.length - k; i++) for (const rest of combos(arr, k - 1, i + 1)) yield [arr[i]].concat(rest);
  }

  /** Outstanding by person: { person: { owed, items:[{txn, split, ageDays}] } } */
  function owedSummary(ledger, asOf) {
    const out = {};
    (ledger || []).forEach((t) => openSplits(t).forEach((sp) => {
      const k = sp.person || 'Unnamed';
      const o = out[k] || (out[k] = { person: k, owed: 0, items: [] });
      o.owed = r2(o.owed + num(sp.amount));
      o.items.push({ txn: t, split: sp, ageDays: asOf ? daysUntil(asOf, t.date) : null });
    }));
    return out;
  }

  function cardTxns(ledger, card) {
    return (ledger || []).filter((t) => (t.cardId === card.id || (!t.cardId && t.cardName === card.name)) && earnsOnCard(t));
  }

  /**
   * Replays the cycle containing dateStr for one card. Returns cap usage,
   * cycle transactions and condition progress. Optionally stops before a txn id.
   */
  function cycleState(card, def, rules, ledger, dateStr, opts) {
    opts = opts || {};
    const cycle = cycleFor(def.cycle || card.cycleType, card.cycleDate, dateStr);
    let txns = cardTxns(ledger, card).filter((t) => t.date && inWindow(t.date, cycle))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))));
    if (opts.beforeId) { const i = txns.findIndex((t) => t.id === opts.beforeId); if (i >= 0) txns = txns.slice(0, i); }
    if (opts.excludeId) txns = txns.filter((t) => t.id !== opts.excludeId);

    const usage = {};
    // Manual adjustments for spend not in the ledger (e.g. before tracking started)
    const adj = (card.capAdjustments || {})[cycle.key] || {};
    Object.entries(adj).forEach(([g, v]) => { const u = usage[g] || (usage[g] = emptyUsage()); u.spend += num(v); });
    const adjSpend = num(adj._total);

    const condFn = (b) => evalRequires(b, card, def, txns.concat(adjSpend ? [{ amount: adjSpend, merchant: '', mcc: '' }] : []), rules);
    let earned = { miles: 0, cashback: 0 };
    txns.forEach((t) => {
      const r = allocate(t, card, def, rules, usage, condFn);
      earned.miles += r.miles; earned.cashback += r.cashback;
      if (opts.onTxn) opts.onTxn(t, r);
    });
    const spend = r2(txns.reduce((s, t) => s + num(t.amount), 0) + adjSpend);
    return { cycle, txns, usage, spend, earned: { miles: r2(earned.miles), cashback: r2(earned.cashback) }, adjSpend };
  }

  /** Cap and condition status for display on card tiles. */
  function cardStatus(card, rules, ledger, asOf) {
    const def = resolveDef(card, rules);
    const st = cycleState(card, def, rules, ledger, asOf);
    const caps = Object.entries(def.capGroups || {}).map(([g, spec]) => {
      const u = st.usage[g] || emptyUsage();
      const usedBy = (def.bonuses || []).filter((b) => (b.cap || []).includes(g));
      const isCash = spec.cashback != null;
      const limit = isCash ? num(spec.cashback) : num(spec.spend);
      const used = isCash ? r2(u.cashback) : r2(u.spend);
      return { group: g, label: usedBy.map((b) => b.label).join(' / ') || g, unit: isCash ? 'cashback' : 'spend', limit, used, remaining: r2(Math.max(0, limit - used)), pct: limit ? Math.min(1, used / limit) : 0 };
    });
    const extra = st.adjSpend ? [{ amount: st.adjSpend, merchant: '', mcc: '' }] : [];
    const conditions = (def.bonuses || []).filter((b) => (b.requires || []).some((r) => r.type !== 'option'))
      .map((b) => ({ bonus: b, result: evalRequires(b, card, def, st.txns.concat(extra), rules) }));
    return { def, cycle: st.cycle, daysLeft: daysUntil(st.cycle.end, asOf) + 1, spend: st.spend, earned: st.earned, caps, conditions, txnCount: st.txns.length };
  }

  /* ---------------- recommendation ---------------- */
  const PROFILE_KEYS = ['marvin', 'wife', 'cobae', 'joint'];
  function candidateCards(forProfile, cards, settings) {
    const s = (settings && settings.household) || {};
    const parents = s.parents || ['marvin', 'wife'];
    let owners;
    if (forProfile === 'cobae' || forProfile === 'joint' || !forProfile) owners = parents.concat(['joint']);
    else if (s.crossUse) owners = parents.concat(['joint']);
    else owners = [forProfile, 'joint'];
    return (cards || []).filter((c) => owners.includes(c.profile || 'marvin') && !c.archived);
  }

  /**
   * Rank cards for a prospective transaction and apply the miles-first policy.
   * ctx = { cards, rules, ledger, settings }
   */
  function recommend(txn, ctx, opts) {
    opts = opts || {};
    const settings = ctx.settings || {};
    const policy = Object.assign({ mode: 'miles_first', cashbackGapCents: 2.5 }, settings.policy || {});
    const t = Object.assign({ date: ymd(new Date()), channel: 'chip', fcy: false }, txn);
    const amount = num(t.amount) || 1;
    t.amount = amount;
    const pool = opts.cards || candidateCards(t.forProfile, ctx.cards, settings);

    const options = pool.map((card) => {
      const def = resolveDef(card, ctx.rules);
      const st = cycleState(card, def, ctx.rules, ctx.ledger, t.date, { beforeId: opts.beforeId, excludeId: opts.excludeId });
      const condFn = (b) => evalRequires(b, card, def, st.txns, ctx.rules, t);
      const res = allocate(t, card, def, ctx.rules, clone(st.usage), condFn);
      let cents, unitLine, programme = null;
      if (res.type === 'cashback') {
        cents = res.cashback * 100;
        unitLine = `${r2(res.cashback / amount * 100)}% cashback`;
      } else {
        programme = bestProgramme(def, settings);
        cents = res.miles * programme.mult * programme.cents;
        unitLine = `${r2(res.miles / amount)} mpd`;
      }
      const centsPerDollar = r2(cents / amount);
      const bonusPiece = res.pieces.find((p) => p.bonusId);
      const unlock = res.conditions.filter((c) => !c.applied && !c.cond.hard).map((c) => ({ bonus: c.bonus.label, items: c.cond.items.filter((i) => !i.met) }));
      const committed = res.pieces.some((p) => p.committed);
      return {
        card, def, result: res, type: res.type, miles: res.miles, cashback: res.cashback,
        mpd: res.type === 'miles' ? r2(res.miles / amount) : 0,
        pct: res.type === 'cashback' ? r2(res.cashback / amount * 100) : 0,
        centsPerDollar, valueCents: r2(cents), unitLine, programme,
        bonusLabel: bonusPiece ? bonusPiece.label : null,
        capRoom: bonusPiece ? bonusPiece.capRoomBefore : null,
        cycle: st.cycle, unlock, committed, excluded: res.excluded, notes: res.notes,
      };
    });

    // Rank within type: value first, then more cap headroom, then bonus-earning
    const rank = (a, b) => b.centsPerDollar - a.centsPerDollar
      || ((b.capRoom == null ? 1e9 : b.capRoom) - (a.capRoom == null ? 1e9 : a.capRoom))
      || (a.committed - b.committed);
    const miles = options.filter((o) => o.type === 'miles' && !o.excluded).sort(rank);
    const cash = options.filter((o) => o.type === 'cashback' && !o.excluded).sort(rank);
    const bestMiles = miles[0] || null, bestCash = cash[0] || null;

    let pick = bestMiles || bestCash || null;
    let reason = '';
    if (policy.mode === 'max_value') {
      pick = [bestMiles, bestCash].filter(Boolean).sort(rank)[0] || null;
      reason = 'Highest value in SGD.';
    } else if (bestMiles && bestCash) {
      const gap = r2(bestCash.centsPerDollar - bestMiles.centsPerDollar);
      if (gap >= num(policy.cashbackGapCents)) {
        pick = bestCash;
        reason = `Cashback beats the best miles option by ${gap}¢/$ (your threshold is ${policy.cashbackGapCents}¢/$).`;
      } else {
        pick = bestMiles;
        reason = gap > 0 ? `Miles first: cashback is only ${gap}¢/$ better, under your ${policy.cashbackGapCents}¢/$ threshold.` : 'Miles first: best miles earn.';
      }
    } else if (bestMiles) reason = 'Best miles earn.';
    else if (bestCash) reason = 'No miles card earns here; best cashback.';
    else reason = 'No card earns rewards on this (excluded category). Pay the cheapest way, e.g. GIRO or bank transfer.';

    const ranked = [pick].concat(options.filter((o) => o !== pick).sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      if (policy.mode !== 'max_value' && a.type !== b.type) return a.type === 'miles' ? -1 : 1;
      return rank(a, b);
    })).filter(Boolean);
    return { txn: t, pick, reason, ranked, bestMiles, bestCash, policy };
  }

  /* ---------------- ledger analytics ---------------- */
  /**
   * Earnings per logged txn, replaying each card's full cycle so retroactive
   * bonuses (e.g. yuu 10 mpd once S$800 is reached) are credited to every txn.
   * Returns Map(txnId → { card, def, result, valueCents }).
   */
  function ledgerEarnings(ctx, filterFn) {
    const out = new Map();
    const done = new Set();
    const settings = ctx.settings || {};
    (ctx.cards || []).forEach((card) => {
      const def = resolveDef(card, ctx.rules);
      const prog = def.reward.type === 'miles' ? bestProgramme(def, settings) : null;
      cardTxns(ctx.ledger, card).forEach((t) => {
        if (!t.date || (filterFn && !filterFn(t))) return;
        const cyc = cycleFor(def.cycle || card.cycleType, card.cycleDate, t.date);
        if (done.has(card.id + cyc.key)) return;
        done.add(card.id + cyc.key);
        cycleState(card, def, ctx.rules, ctx.ledger, t.date, {
          onTxn: (tx, r) => out.set(tx.id, { card, def, result: r, valueCents: r2(prog ? r.miles * prog.mult * prog.cents : r.cashback * 100) }),
        });
      });
    });
    return out;
  }

  /** Actual earnings per logged txn and what the best card would have given at the time. */
  function analyseLedger(ctx, filterFn) {
    const rows = (ctx.ledger || []).filter(filterFn || (() => true));
    const earned = ledgerEarnings(ctx, filterFn);
    return rows.map((t) => {
      const actual = earned.get(t.id) || null;
      if (!actual) return { txn: t, actual: null, best: null, missedCents: 0 };
      const rec = recommend(t, ctx, { beforeId: t.id, excludeId: t.id });
      const best = rec.pick;
      const missed = best && best.card.id !== actual.card.id ? Math.max(0, best.valueCents - actual.valueCents) : 0;
      return { txn: t, actual, best, missedCents: r2(missed) };
    });
  }

  /* ---------------- strategy scenarios ---------------- */
  const SCENARIOS = [
    { id: 'dining', label: 'Restaurant (tap phone)', mcc: '5812', channel: 'mobile_contactless', merchant: 'Restaurant' },
    { id: 'cafe', label: 'Café / fast food (tap phone)', mcc: '5814', channel: 'mobile_contactless', merchant: 'Cafe' },
    { id: 'delivery', label: 'Food delivery app', mcc: '5812', channel: 'online', merchant: 'GrabFood' },
    { id: 'groceries', label: 'Supermarket (tap phone)', mcc: '5411', channel: 'mobile_contactless', merchant: 'NTUC FairPrice' },
    { id: 'groceries-online', label: 'Online groceries', mcc: '5411', channel: 'online', merchant: 'FairPrice Online' },
    { id: 'yuu', label: 'Cold Storage / Giant / 7-Eleven', mcc: '5411', channel: 'mobile_contactless', merchant: 'Cold Storage' },
    { id: 'shopee', label: 'Shopee / Lazada', mcc: '5999', channel: 'online', merchant: 'Shopee' },
    { id: 'online', label: 'Other online shopping', mcc: '5999', channel: 'online', merchant: 'Online store' },
    { id: 'fashion', label: 'Clothes / shoes in store (tap)', mcc: '5651', channel: 'mobile_contactless', merchant: 'Uniqlo' },
    { id: 'pharmacy', label: 'Watsons / Guardian (tap)', mcc: '5912', channel: 'mobile_contactless', merchant: 'Watsons' },
    { id: 'kids', label: 'Kids & baby store (tap)', mcc: '5641', channel: 'mobile_contactless', merchant: 'Kids store' },
    { id: 'ride', label: 'Grab / Gojek ride', mcc: '4121', channel: 'online', merchant: 'Grab' },
    { id: 'transit', label: 'Bus / MRT (SimplyGo)', mcc: '4111', channel: 'card_contactless', merchant: 'SimplyGo' },
    { id: 'petrol', label: 'Petrol (Esso / Caltex)', mcc: '5541', channel: 'card_contactless', merchant: 'Esso' },
    { id: 'sia', label: 'SIA / Scoot flights (SGD)', mcc: '3005', channel: 'online', merchant: 'Singapore Airlines' },
    { id: 'flights', label: 'Other airline website', mcc: '4511', channel: 'online', merchant: 'Airline' },
    { id: 'hotel', label: 'Hotel booked direct', mcc: '7011', channel: 'online', merchant: 'Hotel' },
    { id: 'ota', label: 'Agoda / Booking.com', mcc: '4722', channel: 'online', merchant: 'Agoda' },
    { id: 'fcy-store', label: 'Overseas, in person', mcc: '5812', channel: 'mobile_contactless', merchant: 'Overseas shop', fcy: true },
    { id: 'fcy-online', label: 'Foreign-currency online', mcc: '5999', channel: 'online', merchant: 'Overseas website', fcy: true },
    { id: 'telco', label: 'Singtel bill', mcc: '4814', channel: 'online', merchant: 'Singtel' },
    { id: 'utilities', label: 'Utilities (SP)', mcc: '4900', channel: 'online', merchant: 'SP Services' },
    { id: 'insurance', label: 'Insurance premium', mcc: '6300', channel: 'online', merchant: 'Insurance' },
  ];

  function strategy(ctx, forProfile, asOf, amount) {
    return SCENARIOS.map((s) => {
      const rec = recommend(Object.assign({}, s, { amount: amount || 50, date: asOf, forProfile }), ctx);
      return { scenario: s, rec };
    });
  }

  /* ---------------- rules diff ---------------- */
  function diffRules(oldR, newR) {
    const out = [];
    const oldCards = new Map(((oldR && oldR.cards) || []).map((c) => [c.id, c]));
    const newCards = new Map(((newR && newR.cards) || []).map((c) => [c.id, c]));
    const label = (c) => (c.names && c.names[0]) || c.id;
    newCards.forEach((nc, id) => {
      const oc = oldCards.get(id);
      if (!oc) { out.push({ type: 'added', cardId: id, name: label(nc), details: ['New card definition'] }); return; }
      const details = [];
      const rateOf = (b) => (b.mpd != null ? b.mpd + ' mpd' : b.pct + '%');
      if (JSON.stringify(oc.reward) !== JSON.stringify(nc.reward)) details.push(`Base earn ${fmtReward(oc.reward)} → ${fmtReward(nc.reward)}`);
      if ((oc.cycle || 'calendar') !== (nc.cycle || 'calendar')) details.push(`Cycle ${oc.cycle} → ${nc.cycle}`);
      const ob = new Map((oc.bonuses || []).map((b) => [b.id, b]));
      const nb = new Map((nc.bonuses || []).map((b) => [b.id, b]));
      nb.forEach((b, bid) => {
        const o = ob.get(bid);
        if (!o) { details.push(`New bonus: ${b.label} at ${rateOf(b)}`); return; }
        if (rateOf(o) !== rateOf(b)) details.push(`${b.label}: ${rateOf(o)} → ${rateOf(b)}`);
        if (JSON.stringify(o.when) !== JSON.stringify(b.when)) details.push(`${b.label}: eligibility changed`);
        if (JSON.stringify(o.requires || []) !== JSON.stringify(b.requires || [])) details.push(`${b.label}: conditions changed`);
        if ((o.validTo || '') !== (b.validTo || '')) details.push(`${b.label}: valid until ${b.validTo || 'ongoing'}`);
      });
      ob.forEach((b, bid) => { if (!nb.has(bid)) details.push(`Removed bonus: ${b.label}`); });
      const ocg = oc.capGroups || {}, ncg = nc.capGroups || {};
      new Set(Object.keys(ocg).concat(Object.keys(ncg))).forEach((g) => {
        if (JSON.stringify(ocg[g]) !== JSON.stringify(ncg[g])) details.push(`Cap ${g}: ${fmtCap(ocg[g])} → ${fmtCap(ncg[g])}`);
      });
      if (JSON.stringify(oc.exclusions) !== JSON.stringify(nc.exclusions)) details.push('Exclusion list changed');
      if (details.length) out.push({ type: 'changed', cardId: id, name: label(nc), details });
    });
    oldCards.forEach((oc, id) => { if (!newCards.has(id)) out.push({ type: 'removed', cardId: id, name: label(oc), details: ['Card definition removed'] }); });
    return out;
  }
  function fmtReward(r) { if (!r) return '—'; return r.type === 'cashback' ? `${r.pct}%` : `${r.mpd} mpd (FCY ${r.fcyMpd ?? r.mpd})`; }
  function fmtCap(c) { if (!c) return 'none'; return c.cashback != null ? `S$${c.cashback} cashback` : `S$${c.spend} spend`; }

  /* ---------------- categorisation ---------------- */
  // Built-in descriptor keywords for SG statements. Checked after learned mappings and the merchant DB.
  const KEYWORDS = [
    ['grabfood', 'GrabFood', '5812', 'Food delivery', 'online'], ['grab food', 'GrabFood', '5812', 'Food delivery', 'online'],
    ['grabmart', 'GrabMart', '5411', 'Groceries', 'online'], ['grabpay', 'GrabPay top-up', '6540', 'Wallet top-up', 'online'],
    ['grab', 'Grab', '4121', 'Transport', 'online'], ['gojek', 'Gojek', '4121', 'Transport', 'online'], ['tada', 'TADA', '4121', 'Transport', 'online'],
    ['comfortdelgro', 'ComfortDelGro', '4121', 'Transport', 'card_contactless'], ['cdg taxi', 'ComfortDelGro', '4121', 'Transport', 'card_contactless'],
    ['bus mrt', 'SimplyGo', '4111', 'Public transport', 'card_contactless'], ['simplygo', 'SimplyGo', '4111', 'Public transport', 'card_contactless'], ['transitlink', 'TransitLink', '4111', 'Public transport', 'card_contactless'],
    ['foodpanda', 'foodpanda', '5812', 'Food delivery', 'online'], ['pandamart', 'pandamart', '5411', 'Groceries', 'online'], ['deliveroo', 'Deliveroo', '5812', 'Food delivery', 'online'],
    ['shopeepay', 'ShopeePay top-up', '6540', 'Wallet top-up', 'online'], ['shopee', 'Shopee', '5999', 'Online shopping', 'online'], ['lazada', 'Lazada', '5999', 'Online shopping', 'online'],
    ['taobao', 'Taobao', '5999', 'Online shopping', 'online'], ['tiktok', 'TikTok Shop', '5999', 'Online shopping', 'online'], ['amazon', 'Amazon', '5999', 'Online shopping', 'online'],
    ['aliexpress', 'AliExpress', '5999', 'Online shopping', 'online'], ['qoo10', 'Qoo10', '5999', 'Online shopping', 'online'], ['heymax', 'HeyMax', '5311', 'Vouchers', 'online'],
    ['fairprice', 'NTUC FairPrice', '5411', 'Groceries', 'mobile_contactless'], ['ntuc', 'NTUC FairPrice', '5411', 'Groceries', 'mobile_contactless'], ['cold storage', 'Cold Storage', '5411', 'Groceries', 'mobile_contactless'],
    ['giant', 'Giant', '5411', 'Groceries', 'mobile_contactless'], ['sheng siong', 'Sheng Siong', '5411', 'Groceries', 'mobile_contactless'], ['don don donki', 'Don Don Donki', '5411', 'Groceries', 'mobile_contactless'],
    ['redmart', 'RedMart', '5411', 'Groceries', 'online'], ['7 eleven', '7-Eleven', '5499', 'Convenience', 'mobile_contactless'], ['7eleven', '7-Eleven', '5499', 'Convenience', 'mobile_contactless'], ['cheers', 'Cheers', '5499', 'Convenience', 'mobile_contactless'],
    ['watsons', 'Watsons', '5912', 'Pharmacy & beauty', 'mobile_contactless'], ['guardian', 'Guardian', '5912', 'Pharmacy & beauty', 'mobile_contactless'], ['unity', 'Unity', '5912', 'Pharmacy & beauty', 'mobile_contactless'],
    ['sephora', 'Sephora', '5977', 'Pharmacy & beauty', 'mobile_contactless'],
    ['starbucks', 'Starbucks', '5814', 'Dining', 'mobile_contactless'], ['mcdonald', "McDonald's", '5814', 'Dining', 'mobile_contactless'], ['kfc', 'KFC', '5814', 'Dining', 'mobile_contactless'],
    ['toast box', 'Toast Box', '5814', 'Dining', 'mobile_contactless'], ['ya kun', 'Ya Kun', '5814', 'Dining', 'mobile_contactless'], ['koufu', 'Koufu', '5812', 'Dining', 'mobile_contactless'],
    ['kopitiam', 'Kopitiam', '5812', 'Dining', 'mobile_contactless'], ['food republic', 'Food Republic', '5812', 'Dining', 'mobile_contactless'], ['chagee', 'CHAGEE', '5814', 'Dining', 'online'],
    ['restaurant', 'Restaurant', '5812', 'Dining', 'mobile_contactless'], ['cafe', 'Café', '5814', 'Dining', 'mobile_contactless'],
    ['shell', 'Shell', '5541', 'Petrol', 'card_contactless'], ['esso', 'Esso', '5541', 'Petrol', 'card_contactless'], ['caltex', 'Caltex', '5541', 'Petrol', 'card_contactless'], ['spc', 'SPC', '5541', 'Petrol', 'card_contactless'], ['sinopec', 'Sinopec', '5541', 'Petrol', 'card_contactless'],
    ['singapore airlines', 'Singapore Airlines', '3005', 'Flights', 'online'], ['singaporeair', 'Singapore Airlines', '3005', 'Flights', 'online'], ['scoot', 'Scoot', '3000', 'Flights', 'online'],
    ['krisshop', 'KrisShop', '5999', 'Online shopping', 'online'], ['pelago', 'Pelago', '4722', 'Travel', 'online'],
    ['agoda', 'Agoda', '4722', 'Travel', 'online'], ['booking com', 'Booking.com', '4722', 'Travel', 'online'], ['expedia', 'Expedia', '4722', 'Travel', 'online'], ['klook', 'Klook', '4722', 'Travel', 'online'], ['trip com', 'Trip.com', '4722', 'Travel', 'online'],
    ['airbnb', 'Airbnb', '7011', 'Travel', 'online'], ['hotel', 'Hotel', '7011', 'Travel', 'online'],
    ['singtel', 'Singtel', '4814', 'Telco', 'online'], ['starhub', 'StarHub', '4814', 'Telco', 'online'], ['m1 ', 'M1', '4814', 'Telco', 'online'], ['circles', 'Circles.Life', '4814', 'Telco', 'online'],
    ['sp digital', 'SP Services', '4900', 'Utilities', 'online'], ['sp services', 'SP Services', '4900', 'Utilities', 'online'], ['sp group', 'SP Services', '4900', 'Utilities', 'online'],
    ['netflix', 'Netflix', '4899', 'Subscriptions', 'online'], ['spotify', 'Spotify', '5815', 'Subscriptions', 'online'], ['disney', 'Disney+', '4899', 'Subscriptions', 'online'],
    ['apple com', 'Apple', '5818', 'Subscriptions', 'online'], ['google', 'Google', '5818', 'Subscriptions', 'online'], ['youtube', 'YouTube', '5815', 'Subscriptions', 'online'],
    ['ikea', 'IKEA', '5712', 'Home', 'mobile_contactless'], ['courts', 'Courts', '5732', 'Electronics', 'mobile_contactless'], ['harvey norman', 'Harvey Norman', '5732', 'Electronics', 'mobile_contactless'], ['challenger', 'Challenger', '5732', 'Electronics', 'mobile_contactless'],
    ['uniqlo', 'Uniqlo', '5651', 'Fashion', 'mobile_contactless'], ['zara', 'Zara', '5621', 'Fashion', 'mobile_contactless'], ['h m', 'H&M', '5651', 'Fashion', 'mobile_contactless'], ['cotton on', 'Cotton On', '5651', 'Fashion', 'mobile_contactless'],
    ['takashimaya', 'Takashimaya', '5311', 'Department store', 'mobile_contactless'], ['isetan', 'Isetan', '5311', 'Department store', 'mobile_contactless'], ['robinsons', 'Robinsons', '5311', 'Department store', 'mobile_contactless'], ['tangs', 'TANGS', '5311', 'Department store', 'mobile_contactless'],
    ['daiso', 'Daiso', '5331', 'Retail', 'mobile_contactless'], ['popular', 'Popular', '5942', 'Books & stationery', 'mobile_contactless'], ['kinokuniya', 'Kinokuniya', '5942', 'Books & stationery', 'mobile_contactless'],
    ['toys r us', 'Toys"R"Us', '5945', 'Kids', 'mobile_contactless'], ['mothercare', 'Mothercare', '5641', 'Kids', 'mobile_contactless'], ['kiddy palace', 'Kiddy Palace', '5641', 'Kids', 'mobile_contactless'],
    ['childcare', 'Childcare', '8351', 'Education', 'online'], ['kindergarten', 'Kindergarten', '8351', 'Education', 'online'], ['preschool', 'Preschool', '8351', 'Education', 'online'],
    ['pet', 'Pet store', '5995', 'Pets', 'mobile_contactless'], ['vet', 'Vet', '0742', 'Pets', 'mobile_contactless'],
    ['clinic', 'Clinic', '8011', 'Healthcare', 'mobile_contactless'], ['hospital', 'Hospital', '8062', 'Healthcare', 'chip'], ['polyclinic', 'Polyclinic', '8062', 'Healthcare', 'chip'], ['dental', 'Dental', '8021', 'Healthcare', 'mobile_contactless'],
    ['prudential', 'Prudential', '6300', 'Insurance', 'online'], ['aia', 'AIA', '6300', 'Insurance', 'online'], ['great eastern', 'Great Eastern', '6300', 'Insurance', 'online'], ['income', 'Income Insurance', '6300', 'Insurance', 'online'], ['insurance', 'Insurance', '6300', 'Insurance', 'online'],
    ['iras', 'IRAS', '9311', 'Government', 'online'], ['axs', 'AXS', '9399', 'Government', 'online'], ['hdb', 'HDB', '9399', 'Government', 'online'], ['lta', 'LTA', '9399', 'Government', 'online'], ['ica', 'ICA', '9399', 'Government', 'online'],
    ['golden village', 'Golden Village', '7832', 'Entertainment', 'online'], ['shaw', 'Shaw Theatres', '7832', 'Entertainment', 'online'], ['sistic', 'SISTIC', '7922', 'Entertainment', 'online'], ['ticketmaster', 'Ticketmaster', '7922', 'Entertainment', 'online'],
    ['fitness', 'Gym', '7997', 'Fitness', 'online'], ['gym', 'Gym', '7997', 'Fitness', 'online'], ['activesg', 'ActiveSG', '7997', 'Fitness', 'online'],
  ];
  const FCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'MYR', 'THB', 'HKD', 'IDR', 'KRW', 'TWD', 'CNY', 'RMB', 'NZD', 'CHF', 'CAD', 'VND', 'PHP', 'INR'];

  const MCC_CATEGORY = [
    [['5812', '5811', '5813', '5814'], 'Dining'], [['5411', '5422', '5441', '5451', '5462'], 'Groceries'], [['5499'], 'Convenience'],
    [['4121'], 'Transport'], [['4111', '4112', '4131'], 'Public transport'], [['5541', '5542'], 'Petrol'],
    [['3000-3350', '4511'], 'Flights'], [['3501-3999', '7011', '4722', '4411'], 'Travel'], [['5311', '5331', '5399'], 'Department store'],
    [['5611-5699', '5948'], 'Fashion'], [['5912', '5977', '7230', '7297', '7298'], 'Pharmacy & beauty'], [['5732-5735', '5722'], 'Electronics'],
    [['4814', '4816'], 'Telco'], [['4900'], 'Utilities'], [['4899', '5815-5818'], 'Subscriptions'], [['6300', '6381', '6399'], 'Insurance'],
    [['8211-8299', '8351'], 'Education'], [['8011-8099'], 'Healthcare'], [['9211-9402'], 'Government'], [['6540', '6051'], 'Wallet top-up'],
    [['5995', '0742'], 'Pets'], [['5641', '5945'], 'Kids'], [['7832', '7922', '7929', '7996'], 'Entertainment'], [['7997'], 'Fitness'], [['5999', '5964-5969'], 'Online shopping'],
  ];
  function categoryForMcc(mcc) {
    for (const [list, cat] of MCC_CATEGORY) if (mccIn(mcc, list)) return cat;
    return 'Other';
  }

  /**
   * Guess merchant / MCC / category / channel from a statement description.
   * Order: learned mappings → merchant DB → keyword table.
   */
  function categorise(desc, merchantsDb, mappings) {
    const d = norm(desc);
    const fcyMatch = String(desc || '').toUpperCase().match(new RegExp('\\b(' + FCY_CODES.join('|') + ')\\s*[\\d,]+\\.\\d{2}'));
    const fcy = !!fcyMatch;
    for (const m of (mappings || [])) {
      if (m.pattern && d.includes(norm(m.pattern))) return { merchant: m.merchant, mcc: m.mcc, category: m.category || categoryForMcc(m.mcc), channel: m.channel || 'chip', confidence: 'learned', fcy };
    }
    let best = null, bestLen = 0, bestOnBrand = false;
    const servicesPerBrand = {};
    (merchantsDb || []).forEach((m) => { const b = norm(m.name); servicesPerBrand[b] = (servicesPerBrand[b] || 0) + 1; });
    (merchantsDb || []).forEach((m) => {
      // statement aliases (e.g. "NTUC FP", "GRAB*A-") are as specific as a service name
      const names = [m.service, m.name].concat(m.aliases || []);
      names.forEach((nm, idx) => {
        if (!nm) return;
        const k = norm(nm);
        if (k.length >= 2 && k.length > bestLen && textHas(desc, [nm])) {
          best = m; bestLen = k.length;
          // matched only on the brand of a multi-service merchant (e.g. "Grab") → service is ambiguous
          bestOnBrand = (idx === 1 || (idx === 0 && !m.service)) && servicesPerBrand[norm(m.name)] > 1;
        }
      });
    });
    let kw = null, kwLen = 0;
    const padded = ' ' + d + ' ';
    KEYWORDS.forEach((row) => {
      const k = norm(row[0]);
      const hit = k && (k.length <= 3 ? padded.includes(' ' + k + ' ') : padded.includes(' ' + k));
      if (hit && k.length > kwLen) { kw = row; kwLen = k.length; }
    });
    if (best && bestOnBrand && kw) best = null; // let the keyword table pick the service (GRAB*A-… = ride)
    if (best && bestLen >= kwLen) {
      const svc = best.service && best.service !== best.name ? best.service : '';
      const display = !svc ? best.name : (norm(svc).includes(norm(best.name)) ? svc : best.name + ' · ' + svc);
      return { merchant: display, mcc: best.mcc, category: best.category || categoryForMcc(best.mcc), channel: best.channel || (kw && kw[4]) || guessChannel(best), confidence: 'db', fcy,
        mccAlt: best.mccAlt || [], mccConfidence: best.confidence || null, note: best.notes || '' };
    }
    if (kw) return { merchant: kw[1], mcc: kw[2], category: kw[3], channel: kw[4], confidence: 'keyword', fcy };
    const cleaned = String(desc || '').replace(/\s{2,}.*/, '')
      .replace(/^(paynow|pay now|fast|ibg|giro|nets|funds?)\s*(transfer|payment|trf)?\s*(to|from)?\s*[:\-]?\s*/i, '').replace(/\b(pte|ltd|sg|singapore)\b\.?/gi, '').trim();
    return { merchant: titleCase((cleaned || String(desc || '')).slice(0, 40)), mcc: '', category: 'Other', channel: 'chip', confidence: 'none', fcy };
  }
  function guessChannel(m) { return /online|delivery|app|subscription|e-?commerce|ride|hail|stream|telco|utilit|insurance/i.test((m.category || '') + ' ' + (m.service || '')) ? 'online' : 'mobile_contactless'; }
  function titleCase(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim(); }

  /* ---------------- statement parsing ---------------- */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function inferYear(month, day, refDate) {
    const ref = parseYmd(refDate);
    let y = ref.getUTCFullYear();
    const cand = Date.UTC(y, month - 1, day);
    if (cand > ref.getTime() + 31 * 86400000) y -= 1; // statement dates never sit far in the future
    return y;
  }
  function toDate(dd, mm, yy, refDate) {
    let m = /^\d+$/.test(mm) ? +mm : MONTHS[String(mm).slice(0, 3).toLowerCase()];
    let d = +dd;
    if (!m || !d || d > 31 || m > 12) return null;
    let y = yy ? +yy : inferYear(m, d, refDate);
    if (y < 100) y += 2000;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  /**
   * Parse text copied or extracted from a statement. One transaction per line:
   *   "12 OCT  GRAB*FOOD SINGAPORE   23.40"  /  "12/10/2026 SHOPEE 45.00 CR"
   * Credits (CR, payments, refunds) are flagged and skipped by default.
   */
  function parseStatementText(text, opts) {
    opts = opts || {};
    const refDate = opts.refDate || ymd(new Date());
    const rows = [];
    // day, month (name or number), optional year: "/26", "-2026" or " 2026" (never a bare " 14", which is a posting day)
    const dateRe = /^\s*(\d{1,2})[\s\/\-.]+([A-Za-z]{3,9}|\d{1,2})(?:[\/\-.](\d{2,4})|\s+(\d{4}))?\b/;
    // amount at end of line; optional "S$"/"$" prefix must be separated from the description by whitespace
    const amtRe = /(?:^|\s)(-?\(?(?:S\$|\$)?\s*[\d,]+\.\d{2}\)?)\s*(CR|DR)?\s*$/i;
    String(text || '').split(/\r?\n/).forEach((raw) => {
      const line = raw.replace(/\t/g, '  ').trim();
      if (!line) return;
      const dm = line.match(dateRe);
      const am = line.match(amtRe);
      if (!dm || !am) return;
      let rest = line.slice(dm[0].length);
      // Some statements show a second (posting) date right after the first
      const dm2 = rest.match(dateRe);
      let postDate = null;
      if (dm2) {
        const pd = toDate(dm2[1], dm2[2], dm2[3] || dm2[4], refDate);
        if (pd) { postDate = pd; rest = rest.slice(dm2[0].length); }
      }
      const date = toDate(dm[1], dm[2], dm[3] || dm[4], refDate);
      if (!date) return;
      const desc = rest.slice(0, rest.length - am[0].length).replace(/\s{2,}/g, '  ').trim();
      if (!desc) return;
      const rawAmt = am[1];
      let amount = num(rawAmt.replace(/[^\d.]/g, ''));
      // On card statements, payments/refunds are credits even without a CR marker. On bank statements "payment" usually means money out.
      const credit = /CR/i.test(am[2] || '') || /^-|\(/.test(rawAmt.trim()) ||
        (opts.isCard !== false && /\b(payment thank you|payment - thank you|payment received|refund|reversal|rebate|cash ?back|thank you)\b/i.test(desc)) ||
        (opts.isCard !== false && /^payment\b/i.test(desc));
      rows.push({ date, postDate, description: desc, amount, credit });
    });
    return rows;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  /** Guess which CSV columns hold date / description / amount / debit / credit. */
  function guessCsvMapping(header) {
    const h = header.map((x) => norm(x));
    const find = (...keys) => h.findIndex((c) => keys.some((k) => c.includes(k)));
    return {
      date: find('transaction date', 'trans date', 'date'),
      description: find('description', 'details', 'merchant', 'particulars', 'narrative'),
      amount: find('amount', 'sgd'),
      debit: find('debit', 'withdrawal'),
      credit: find('credit', 'deposit'),
    };
  }
  function csvToRows(table, map, opts) {
    opts = opts || {};
    const refDate = opts.refDate || ymd(new Date());
    const out = [];
    table.slice(opts.hasHeader === false ? 0 : 1).forEach((r) => {
      const ds = String(r[map.date] || '').trim();
      let date = null;
      let m = ds.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      else { m = ds.match(/^(\d{1,2})[\s\/\-.]+([A-Za-z]{3,9}|\d{1,2})(?:[\s\/\-.]+(\d{2,4}))?/); if (m) date = toDate(m[1], m[2], m[3], refDate); }
      if (!date) return;
      const desc = String(r[map.description] || '').trim();
      let amount = 0, credit = false;
      const parseAmt = (v) => num(String(v || '').replace(/[^\d.\-]/g, ''));
      if (map.debit >= 0 && String(r[map.debit] || '').trim()) amount = Math.abs(parseAmt(r[map.debit]));
      else if (map.credit >= 0 && String(r[map.credit] || '').trim()) { amount = Math.abs(parseAmt(r[map.credit])); credit = true; }
      else if (map.amount >= 0) {
        const raw = String(r[map.amount] || '');
        const v = parseAmt(raw);
        credit = v < 0 || /CR/i.test(raw);
        amount = Math.abs(v);
      }
      if (!amount) return;
      if (opts.isCard !== false && map.credit < 0 && /\b(payment thank you|refund|reversal|thank you)\b/i.test(desc)) credit = true;
      out.push({ date, description: desc, amount, credit });
    });
    return out;
  }

  /* ---------------- money flow classification (transfers, income, review) ---------------- */
  const FLOW_PATTERNS = [
    // [regex on normalised description, kind, reason, direction: 'out'|'in'|'any']
    [/\b(bill payment|bill pymt|payment thank you|payment received|card payment|cc payment|credit card payment|autopay|giro payment card)\b/, 'transfer', 'Card bill payment', 'any'],
    [/\b(endowus|moomoo|futu|saxo|tiger brokers|tiger trade|poems|phillip securities|cdp|syfe|stashaway|ibkr|interactive brokers|crypto com|coinhako|gemini|srs contribution|cpf|medisave|ma top ?up)\b/, 'transfer', 'Investment / CPF / SRS', 'any'],
    [/\b(grabpay top ?up|youtrip|shopback pay|revolut|wise|trust bank|instarem|amaze|top ?up)\b/, 'transfer', 'Wallet top-up', 'out'],
    [/\b(atm|cash withdrawal|cash wdl|nets cash ?out)\b/, 'transfer', 'Cash withdrawal', 'out'],
    [/\b(salary|payroll|sal cr|giro salary)\b/, 'income', 'Salary', 'in'],
    [/\b(interest|bonus interest|int credit|interest earned|dividend|cash ?back|rebate)\b/, 'income', 'Interest / dividend / cashback', 'in'],
    [/\b(refund|reversal|reversed|chargeback)\b/, 'refund', 'Refund', 'in'],
    [/\b(reimburse|claim)\b/, 'income', 'Reimbursement', 'in'],
  ];
  const TRANSFERISH = /\b(fast|funds? transfer|fund trf|trf|transfer|paynow|pay now|ibg|giro|inter ?bank|own account|i bank|ib transfer)\b/;

  /**
   * Classify one statement row. ctx: { accounts:[{id,name,patterns:[],owner}], ownerNames:[], transferRules:[{pattern,kind,accountId}] , isCard }
   * Returns { kind, reason, counterpartyId, review: [] }.
   */
  function classifyFlow(row, ctx) {
    ctx = ctx || {};
    const d = norm(row.description || row.rawDescription || '');
    const dir = row.credit || num(row.amount) < 0 ? 'in' : 'out';
    const review = [];
    // 1. learned / user rules win
    for (const r of ctx.transferRules || []) {
      if (r.pattern && d.includes(norm(r.pattern))) return { kind: r.kind || 'transfer', reason: 'Your rule: "' + r.pattern + '"', counterpartyId: r.accountId || null, review };
    }
    // 2. own accounts named in the description (account names, last-4 digits, your own names)
    const acct = (ctx.accounts || []).find((a) => a.id !== ctx.accountId && [a.name].concat(a.patterns || []).some((p) => p && norm(p).length >= 3 && d.includes(norm(p))));
    const ownName = (ctx.ownerNames || []).some((n) => n && norm(n).length >= 3 && d.includes(norm(n)));
    if (acct || (ownName && TRANSFERISH.test(d))) {
      return { kind: 'transfer', reason: acct ? 'To/from your ' + acct.name : 'Transfer to your own name', counterpartyId: acct ? acct.id : null, review };
    }
    // 3. built-in patterns
    for (const [re, kind, reason, pdir] of FLOW_PATTERNS) {
      if ((pdir === 'any' || pdir === dir) && re.test(d)) {
        // on a card statement, a credit "payment" is the bill being paid; elsewhere it's a transfer out to the card
        return { kind, reason, counterpartyId: null, review };
      }
    }
    // 4. defaults by direction
    if (dir === 'in') {
      if (ctx.isCard) return { kind: 'refund', reason: 'Card credit', counterpartyId: null, review: ['check'] };
      review.push('incoming');
      return { kind: 'income', reason: 'Money in', counterpartyId: null, review };
    }
    if (!ctx.isCard && TRANSFERISH.test(d)) {
      review.push('paynow'); // PayNow/FAST to someone: spending, paying for others, or your own account?
      return { kind: 'expense', reason: 'PayNow / transfer out', counterpartyId: null, review };
    }
    return { kind: 'expense', reason: '', counterpartyId: null, review };
  }

  /**
   * Pair an outflow on one of your accounts with an inflow of the same amount on another within `days`.
   * Mutates matching txns: kind='transfer', transferPair=<other id>. Returns number of pairs made.
   */
  function pairTransfers(ledger, opts) {
    opts = opts || {};
    const days = opts.days == null ? 4 : opts.days;
    const fresh = opts.onlyIds ? new Set(opts.onlyIds) : null;          // at least one side must be newly imported
    const acctOf = (t) => t.cardId || t.accountId || t.cardName || '';
    // a side is "open" if it's new, or not yet confirmed by you (unreviewed / flagged), and isn't already linked
    const pairable = (t) => !t.transferPair && !t.repays && t.date && num(t.amount) > 0 && kindOf(t) !== 'refund' && kindOf(t) !== 'repayment' &&
      (fresh ? (fresh.has(t.id) || (t.source === 'import' && !t.reviewed) || (t.review || []).length) : true);
    const open = (ledger || []).filter(pairable);
    const outs = open.filter((t) => t.direction !== 'in' && (kindOf(t) === 'transfer' || (t.review || []).includes('paynow')));
    const ins = open.filter((t) => t.direction === 'in');
    let n = 0;
    outs.forEach((o) => {
      const m = ins.find((i) => !i.transferPair && acctOf(i) !== acctOf(o) && Math.abs(num(i.amount) - num(o.amount)) < 0.005 &&
        Math.abs(daysUntil(i.date, o.date)) <= days && (!fresh || fresh.has(i.id) || fresh.has(o.id)));
      if (!m) return;
      o.kind = 'transfer'; m.kind = 'transfer';
      o.transferPair = m.id; m.transferPair = o.id;
      o.review = (o.review || []).filter((r) => r !== 'paynow' && r !== 'incoming');
      m.review = (m.review || []).filter((r) => r !== 'paynow' && r !== 'incoming');
      n++;
    });
    return n;
  }

  function txnFingerprint(t) {
    return [t.cardId || t.cardName || '', t.date, r2(num(t.amount)).toFixed(2), norm(t.rawDescription || t.merchant).slice(0, 24)].join('|');
  }

  /* ---------------- rules sanity check ---------------- */
  function validateRules(rules) {
    const errors = [];
    if (!rules || !Array.isArray(rules.cards)) return ['rules.cards must be an array'];
    if (!rules.rulesVersion) errors.push('rulesVersion missing');
    const ids = new Set();
    rules.cards.forEach((c) => {
      if (!c.id) errors.push('card without id');
      if (ids.has(c.id)) errors.push('duplicate id ' + c.id);
      ids.add(c.id);
      if (!c.reward || !['miles', 'cashback'].includes(c.reward.type)) errors.push(c.id + ': reward.type must be miles or cashback');
      (c.bonuses || []).forEach((b) => {
        if (!b.id) errors.push(c.id + ': bonus without id');
        if (c.reward && c.reward.type === 'miles' && !(b.mpd > 0)) errors.push(c.id + '/' + b.id + ': mpd missing');
        if (c.reward && c.reward.type === 'cashback' && !(b.pct > 0)) errors.push(c.id + '/' + b.id + ': pct missing');
        (b.cap || []).forEach((g) => { if (!(c.capGroups || {})[g]) errors.push(c.id + '/' + b.id + ': unknown cap group ' + g); });
      });
    });
    return errors;
  }

  const api = {
    ENGINE_VERSION, SCENARIOS, PROFILE_KEYS,
    cycleFor, resolveDef, autoLink, matchDefByName, legacyToDef, optionValue,
    matchWhen, isExcluded, allocate, cycleState, cardStatus, candidateCards,
    recommend, analyseLedger, ledgerEarnings, strategy, bestProgramme, diffRules, validateRules,
    KINDS, kindOf, earnsOnCard, isSpending, classifyFlow, pairTransfers,
    splitsOf, yourShare, openSplits, personMatches, matchRepayments, owedSummary, migrateContra,
    categorise, categoryForMcc, parseStatementText, parseCSV, guessCsvMapping, csvToRows, txnFingerprint,
    util: { norm, mccIn, expandList, r2, ymd, parseYmd, daysUntil },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
