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
    let n = 0; const sid = () => 'sp_mig' + Date.now().toString(36) + (++n);
    L.forEach((t) => {
      if (isSheet(t) && /^collect(ed)?\s+from\b/i.test(t.rawDescription || '') && t.direction !== 'in') { t.direction = 'in'; t.kind = 'income'; delete t.splits; stats.fixedCollectRows = (stats.fixedCollectRows || 0) + 1; }
      splitsOf(t).forEach((sp) => { if (sp.status === 'assumed') { sp.status = 'owed'; if (sp.person === 'Unassigned') sp.person = ''; } });
    });
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
    const cols = L.filter((t) => isSheet(t) && t.direction === 'in' && !t.repays && (kindOf(t) === 'income' || kindOf(t) === 'refund' || kindOf(t) === 'repayment') && nameOf(t))
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
    // 3b. one share paid back by several people (each sends their part): split the share per person
    const freeCols = () => cols.filter((c) => !c.repays && /collect/i.test(c.rawDescription || ''));
    L.forEach((t) => {
      const owedUnnamed = splitsOf(t).filter((sp) => sp.status === 'owed' && !sp.person);
      owedUnnamed.forEach((sp) => {
        const near = freeCols().filter((c) => c.date >= t.date && daysUntil(c.date, t.date) <= 14).slice(0, 12);
        for (let k = 2; k <= 5; k++) {
          for (const combo of combos(near, k)) {
            if (Math.abs(combo.reduce((s2, c) => s2 + num(c.amount), 0) - num(sp.amount)) >= 0.005) continue;
            const parts = combo.map((c) => ({ id: sid(), person: nameOf(c), amount: num(c.amount), status: 'collected', collectedOn: c.date, repaymentId: c.id }));
            t.splits = splitsOf(t).filter((x) => x !== sp).concat(parts);
            combo.forEach((c, i) => { c.kind = 'repayment'; c.repays = [{ txnId: t.id, splitId: parts[i].id, amount: parts[i].amount }]; });
            stats.multiPayer = (stats.multiPayer || 0) + 1;
            return;
          }
        }
      });
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
    [/\b(endowus|moomoo|futu|saxo|tiger brokers|tiger trade|poems|phillip securities|cdp|syfe|stashaway|ibkr|interactive brokers|crypto com|coinhako|gemini|srs contribution|cpf|medisave|ma top ?up|investment securities|digiportfolio|chocfin|chocolate finance)\b/, 'transfer', 'Investment / CPF / SRS', 'any'],
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

  /* ---------------- investments ---------------- */
  const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const toNum = (s) => Number(String(s).replace(/[,\s]/g, ''));
  const isNumTok = (s) => /^-?[\d,]*\d(\.\d+)?$/.test(String(s).trim());
  const DATE_TOK = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/;
  function dmyText(s) {
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(String(s));
    return m && MON3[m[2].toLowerCase()] ? `${m[3]}-${pad(MON3[m[2].toLowerCase()])}-${pad(+m[1])}` : null;
  }
  const CCY_NAMES = { 'united states dollar': 'USD', 'singapore dollar': 'SGD', 'euro': 'EUR', 'hong kong dollar': 'HKD', 'australian dollar': 'AUD', 'pound sterling': 'GBP', 'japanese yen': 'JPY' };

  /**
   * Parse a DBS digiPortfolio monthly statement from its text (pdftotext -layout, or the app's pdf.js line rebuild).
   * Returns { provider, date, totalSgd, portfolios:[{ portfolioNo, name, currency, fx, holdings[], cash, cashSgd, totalCcy, totalSgd, activity[], txTotals }] } or null.
   */
  function parseDigiPortfolio(text) {
    text = String(text || '');
    if (!/digiPortfolio/i.test(text)) return null;
    const asAt = /Account Summary as (?:at|of)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/.exec(text);
    const out = { provider: 'DBS digiPortfolio', date: asAt ? dmyText(asAt[1]) : null, totalSgd: null, portfolios: [] };
    const tot = /Total:\s*SGD Equivalent\s+([\d,]+\.\d+)/.exec(text); if (tot) out.totalSgd = toNum(tot[1]);
    if (!out.date) return null;
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\f/g, '').trim()).filter(Boolean);
    const tok = (l) => l.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
    const byNo = {};
    const getPf = (no) => {
      if (!byNo[no]) { byNo[no] = { portfolioNo: no, name: '', currency: 'SGD', fx: 1, holdings: [], cash: 0, cashSgd: 0, totalCcy: null, totalSgd: null, activity: [], txTotals: null }; out.portfolios.push(byNo[no]); }
      return byNo[no];
    };
    let pf = null, section = 'hold', h = null, a = null;
    for (const l of lines) {
      let m;
      if (/^Transaction Details as at/i.test(l)) { section = 'tx'; h = a = null; continue; }
      if (/^GENERAL INFORMATION|^Special Notes/i.test(l)) { section = null; h = a = null; continue; }
      if ((m = /^Portfolio(?: No\.)?\s*:?\s*(D-[\d-]+)/i.exec(l))) { pf = getPf(m[1]); h = a = null; continue; }
      if (!pf) continue;
      if (/^[^,]+ Portfolio, [^,]+ risk$/i.test(l)) { pf.name = l; continue; }
      if ((m = /^Currency\s*:\s*(.+)$/i.exec(l))) { const c = m[1].trim(); pf.currency = CCY_NAMES[c.toLowerCase()] || c.slice(0, 3).toUpperCase(); continue; }
      if ((m = /^Total Investment Value:\s*([\d,.-]+)\s+([\d,.-]+)/i.exec(l))) { pf.totalCcy = toNum(m[1]); pf.totalSgd = toNum(m[2]); h = null; continue; }
      if ((m = /^Total Balance:\s*([\d,.-]+)\s+([\d,.-]+)/i.exec(l))) { pf.txTotals = { debit: toNum(m[1]), credit: toNum(m[2]) }; a = null; continue; }
      const t = tok(l);
      if (section === 'hold') {
        if (t[0] === 'Cash' && t.length === 3 && isNumTok(t[1]) && isNumTok(t[2])) { pf.cash = toNum(t[1]); pf.cashSgd = toNum(t[2]); h = null; continue; }
        if (t.length >= 7 && /^[A-Z0-9]{2,8}$/.test(t[0]) && !isNumTok(t[1]) && t.slice(-5).every(isNumTok)) {
          const n = t.slice(-5).map(toNum);
          h = { code: t[0], name: t.slice(1, -5).join(' '), units: n[0], cost: n[1], price: n[2], value: n[3], valueSgd: n[4], costPrice: null, priceDate: null, pnl: null };
          pf.holdings.push(h); continue;
        }
        if (h) {
          if (/^(ISIN|Security|Code|Account Summary|PDS_|Page )/i.test(l)) { h = null; continue; }
          const dm = /(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/.exec(l);
          const parts = t;
          let seenDate = false; const words = [];
          parts.forEach((x) => {
            if (DATE_TOK.test(x)) { seenDate = true; h.priceDate = dmyText(x); }
            else if (isNumTok(x)) { if (seenDate) h.pnl = toNum(x); else h.costPrice = toNum(x); }
            else words.push(x);
          });
          if (dm && !h.priceDate) h.priceDate = dmyText(dm[1]);
          if (words.length) h.name = (h.name + ' ' + words.join(' ')).trim();
        }
        continue;
      }
      if (section === 'tx') {
        if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t[0] || ''))) {
          const nums = t.filter(isNumTok);
          const ccyIdx = t.findIndex((x) => /^[A-Z]{3}$/.test(x));
          const type = t[1] || '';
          const amount = toNum(t[t.length - 1]);
          const price = ccyIdx > 2 && isNumTok(t[ccyIdx - 1]) ? toNum(t[ccyIdx - 1]) : null;
          const k = /buy|purchase|subscri/i.test(type) ? 'buy' : /sell|redeem|redemption/i.test(type) ? 'sell' : /dividend|distribution/i.test(type) ? 'dividend'
            : /fee|charge/i.test(type) ? 'fee' : /withdraw|transfer out|fund out/i.test(type) ? 'withdrawal' : /deposit|top ?up|transfer in|fund in|contribut/i.test(type) ? 'deposit' : /interest/i.test(type) ? 'interest' : 'other';
          a = { date: `${m[3]}-${m[2]}-${m[1]}`, type: k, label: type, price, units: null, amount: nums.length ? amount : 0, ccy: ccyIdx >= 0 ? t[ccyIdx] : pf.currency, name: '', ref: '' };
          a.debit = ['buy', 'fee', 'withdrawal'].includes(k);
          pf.activity.push(a); continue;
        }
        if (a && !a.ref) {
          const nums = []; while (t.length && isNumTok(t[t.length - 1])) nums.unshift(toNum(t.pop()));
          const words = t.join(' ').split(/\s+/);
          a.ref = words[0] || '';
          a.name = words.slice(1).join(' ');
          if (nums.length >= 2) a.units = nums[nums.length - 2];
          continue;
        }
      }
    }
    out.portfolios.forEach((p) => {
      if (p.totalCcy && p.totalSgd) p.fx = p.totalSgd / p.totalCcy;
      // name the instrument each trade belongs to
      p.activity.forEach((x) => {
        if (!x.name || x.type === 'dividend' || x.type === 'fee') return;
        const n = norm(x.name);
        const hit = p.holdings.find((hh) => { const hn = norm(hh.name); return hn && (n === hn || n.startsWith(hn) || hn.startsWith(n)); });
        if (hit) x.code = hit.code;
      });
      p.holdings.forEach((hh) => { const c = classifyHolding(hh.name, hh.code); hh.assetClass = c.assetClass; hh.region = c.region; });
    });
    return out.portfolios.length ? out : null;
  }

  function classifyHolding(name, code) {
    const n = ' ' + norm(name + ' ' + (code || '')) + ' ';
    let assetClass = 'Equity';
    if (/ cash | money market /.test(n)) assetClass = 'Cash';
    else if (/ gold | silver | commodit/.test(n) && !/ producers /.test(n)) assetClass = 'Commodities';
    else if (/ bond | bnd | treasury | corp | aggregate | govt | fixed income | t ?bill | sgs | ssb /.test(n)) assetClass = 'Bonds';
    else if (/ reit | trust | ascott | capitaland integrated | mapletree /.test(n)) assetClass = 'REITs';
    let region = 'Global';
    if (/ s p 500 | usa | u s | nasdaq | russell | treasury | us | united states /.test(n)) region = 'US';
    else if (/ eur | europe | stoxx /.test(n)) region = 'Europe';
    else if (/ jap | japan | nikkei | jpx /.test(n)) region = 'Japan';
    else if (/ em | emerging | india | china | fe x jp | asia ex /.test(n)) region = 'Emerging markets';
    else if (/ singapore | sti | sgx | sgd /.test(n)) region = 'Singapore';
    if (/ gold /.test(n)) region = 'Global';
    return { assetClass, region };
  }

  /** Add one parsed statement to the investments store. Idempotent: re-importing the same month replaces it. */
  function mergeInvestmentStatement(inv, parsed, opts) {
    opts = opts || {};
    const newId = opts.newId || (() => 'inv_' + Math.random().toString(36).slice(2, 10));
    inv.accounts = inv.accounts || []; inv.snapshots = inv.snapshots || []; inv.activity = inv.activity || [];
    const res = { accounts: [], snapshots: 0, activity: 0, created: [] };
    parsed.portfolios.forEach((p) => {
      let acct = inv.accounts.find((x) => (x.statementIds || []).includes(p.portfolioNo));
      if (!acct) {
        acct = { id: newId(), name: parsed.portfolios.length > 1 ? `digiPortfolio ${p.portfolioNo.slice(-4)}` : 'digiPortfolio', provider: parsed.provider, type: 'robo',
          owner: opts.owner || 'marvin', currency: p.currency, statementIds: [p.portfolioNo], patterns: ['DIGIPORTFOLIO'], strategy: p.name };
        inv.accounts.push(acct); res.created.push(acct.name);
      }
      res.accounts.push(acct.id);
      const snap = { id: newId(), accountId: acct.id, date: parsed.date, source: 'statement', ccy: p.currency, fx: r2(p.fx * 1e6) / 1e6,
        valueCcy: p.totalCcy, valueSgd: p.totalSgd, cashCcy: p.cash, cashSgd: p.cashSgd,
        holdings: p.holdings.filter((x) => x.units > 0 || x.value > 0).map((x) => ({ code: x.code, name: x.name, units: x.units, cost: x.cost, price: x.price, value: x.value, valueSgd: x.valueSgd, pnl: x.pnl, assetClass: x.assetClass, region: x.region })) };
      inv.snapshots = inv.snapshots.filter((s) => !(s.accountId === acct.id && s.date === snap.date));
      inv.snapshots.push(snap); res.snapshots++;
      const key = (x) => [x.accountId, x.date, x.type, r2(num(x.amount)), x.units || '', norm(x.name).slice(0, 20)].join('|');
      const have = new Set(inv.activity.map(key));
      p.activity.forEach((x) => {
        const rec = { id: newId(), accountId: acct.id, date: x.date, type: x.type, label: x.label, name: x.name, code: x.code || '', units: x.units, price: x.price, amount: x.amount, ccy: x.ccy, ref: x.ref };
        if (have.has(key(rec))) return;
        have.add(key(rec)); inv.activity.push(rec); res.activity++;
      });
    });
    inv.snapshots.sort((x, y) => (x.date < y.date ? -1 : 1));
    inv.activity.sort((x, y) => (x.date < y.date ? -1 : 1));
    return res;
  }

  /**
   * Merge a prepared investments file: { format:'fp-investments', accounts:[{key, name, provider, type, owner, fundedBy, patterns, replaces}],
   *   snapshots:[{account, date, valueSgd, opening?, holdings[]}], activity:[{account, date, type, amount, ccy, name, units, price, label}] }.
   * Accounts are matched by provider+key, then by an existing empty account named in `replaces`. Idempotent.
   */
  function mergeInvestmentData(inv, payload, opts) {
    opts = opts || {};
    const newId = opts.newId || (() => 'inv_' + Math.random().toString(36).slice(2, 10));
    inv.accounts = inv.accounts || []; inv.snapshots = inv.snapshots || []; inv.activity = inv.activity || [];
    const res = { created: [], updated: [], snapshots: 0, activity: 0 };
    const idFor = {};
    (payload.accounts || []).forEach((p) => {
      const ext = (p.provider || '') + ':' + p.key;
      let a = inv.accounts.find((x) => x.extId === ext);
      if (!a && p.replaces) a = inv.accounts.find((x) => !x.extId && p.replaces.some((n) => norm(n) === norm(x.name)) && !inv.snapshots.some((s) => s.accountId === x.id) && !inv.activity.some((s) => s.accountId === x.id));
      const fields = { name: p.name, provider: p.provider, type: p.type || 'robo', owner: p.owner || 'marvin', fundedBy: p.fundedBy || '', strategy: p.strategy || '', extId: ext };
      if (a) { Object.assign(a, fields); a.patterns = [...new Set((a.patterns || []).concat(p.patterns || []))]; res.updated.push(a.name); }
      else { a = { id: newId(), ...fields, patterns: p.patterns || [], dividendPatterns: [] }; inv.accounts.push(a); res.created.push(a.name); }
      idFor[p.key] = a.id;
    });
    (payload.snapshots || []).forEach((s) => {
      const accountId = idFor[s.account]; if (!accountId) return;
      const snap = { id: newId(), accountId, date: s.date, source: s.source || 'import', opening: !!s.opening, valueSgd: num(s.valueSgd), ccy: 'SGD', fx: 1,
        holdings: (s.holdings || []).map((h) => { const c = classifyHolding(h.name, h.code); return { ...h, assetClass: h.assetClass || c.assetClass, region: h.region || c.region }; }) };
      inv.snapshots = inv.snapshots.filter((x) => !(x.accountId === accountId && x.date === s.date));
      inv.snapshots.push(snap); res.snapshots++;
    });
    const key = (x) => [x.accountId, x.date, x.type, r2(num(x.amount)), x.units || '', norm(x.name).slice(0, 20)].join('|');
    const have = new Set(inv.activity.map(key));
    (payload.activity || []).forEach((x) => {
      const accountId = idFor[x.account]; if (!accountId) return;
      const rec = { id: newId(), accountId, date: x.date, type: x.type, label: x.label || x.type, name: x.name || '', code: x.code || '', units: x.units || null, price: x.price || null, amount: num(x.amount), ccy: x.ccy || 'SGD', ref: x.ref || '', via: x.via || '' };
      if (x.paidOut) rec.paidOut = true;
      if (have.has(key(rec))) return;
      have.add(key(rec)); inv.activity.push(rec); res.activity++;
    });
    inv.snapshots.sort((x, y) => (x.date < y.date ? -1 : 1));
    inv.activity.sort((x, y) => (x.date < y.date ? -1 : 1));
    return res;
  }

  /* bank / spreadsheet lines that move money into or out of investments */
  const INVEST_RE = /\b(endowus|moomoo|futu|saxo|tiger brokers|tiger trade|poems|phillip securities|syfe|stashaway|ibkr|interactive brokers|digiportfolio|investment securities|chocfin|chocolate finance|cpf|medisave|ma top ?up|srs contribution|srs)\b/;
  const txnText = (t) => norm([t.rawDescription, t.merchant, t.note].filter(Boolean).join(' '));
  function acctMatches(acct, text) { return [acct.name].concat(acct.patterns || []).some((p) => p && norm(p).length >= 3 && text.includes(norm(p))); }

  /**
   * Find contributions, withdrawals and dividends in the ledger and tie them to investment accounts.
   * t.investAccountId = '<id>' forces an account, '-' excludes a line. Returns [{ txn, accountId, flow }] (flow: contribution|withdrawal|dividend).
   */
  function investFlows(ledger, inv) {
    const accts = (inv && inv.accounts) || [];
    const out = [];
    (ledger || []).forEach((t) => {
      if (t.investAccountId === '-') return;
      const text = txnText(t);
      const dir = t.direction === 'in' ? 'in' : 'out';
      const isDiv = dir === 'in' && /\b(dividend|dividends|distribution)\b/.test(text);
      const forced = t.investAccountId && accts.find((a) => a.id === t.investAccountId);
      const matched = forced || accts.find((a) => acctMatches(a, text) || (isDiv && (a.dividendPatterns || []).some((p) => p && text.includes(norm(p)))));
      if (!forced && !matched && !isDiv && !INVEST_RE.test(text)) return;
      if (!forced && kindOf(t) === 'expense' && !INVEST_RE.test(text) && !matched) return;
      let accountId = matched ? matched.id : null;
      if (isDiv && !accountId) { const sh = accts.find((a) => a.type === 'shares'); accountId = sh ? sh.id : null; }
      out.push({ txn: t, accountId, flow: isDiv ? 'dividend' : dir === 'out' ? 'contribution' : 'withdrawal', amount: r2(num(t.amount)) });
    });
    // the same transfer logged twice (spreadsheet row + bank line): keep one
    const kept = [];
    out.sort((x, y) => (x.txn.date < y.txn.date ? -1 : 1)).forEach((f) => {
      const dup = kept.find((k) => k.flow === f.flow && k.amount === f.amount && (k.accountId || '') === (f.accountId || '') && k.txn.id !== f.txn.id &&
        (k.txn.source || '') !== (f.txn.source || '') && Math.abs(daysUntil(k.txn.date, f.txn.date)) <= 3);
      if (dup) dup.dupIds = (dup.dupIds || []).concat(f.txn.id); else kept.push(f);
    });
    return kept;
  }

  /** Annualised money-weighted return. flows: [{date, amount}] (money you put in negative, value/withdrawals positive). */
  function xirr(flows) {
    const f = (flows || []).filter((x) => x && num(x.amount) !== 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (f.length < 2 || !f.some((x) => x.amount > 0) || !f.some((x) => x.amount < 0)) return null;
    const t0 = parseYmd(f[0].date);
    const yrs = f.map((x) => (parseYmd(x.date) - t0) / (365 * 86400000));
    const npv = (r) => f.reduce((s, x, i) => s + x.amount / Math.pow(1 + r, yrs[i]), 0);
    let lo = -0.99, hi = 10, flo = npv(lo), fhi = npv(hi);
    if (flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2, fm = npv(mid); if (Math.abs(fm) < 1e-9) return mid; if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; } }
    return (lo + hi) / 2;
  }

  /**
   * Everything the Investments page shows. asOf: YYYY-MM-DD.
   * Values are SGD. Foreign-currency activity is converted at the nearest statement's rate.
   */
  function investmentSummary(inv, ledger, asOf) {
    inv = inv || {}; asOf = asOf || ymd(new Date());
    const yStart = asOf.slice(0, 4) + '-01-01';
    const yearAgo = ymd(new Date(parseYmd(asOf).getTime() - 365 * 86400000));
    const flowsAll = investFlows(ledger, inv);
    const accounts = (inv.accounts || []).map((acct) => {
      const snaps = (inv.snapshots || []).filter((s) => s.accountId === acct.id && s.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
      const fxAt = (d) => { if (!snaps.length) return 1; let best = snaps[0]; snaps.forEach((s) => { if (Math.abs(daysUntil(s.date, d)) < Math.abs(daysUntil(best.date, d))) best = s; }); return num(best.fx) || 1; };
      const act = (inv.activity || []).filter((x) => x.accountId === acct.id && x.date <= asOf).map((x) => ({ ...x, sgd: r2(num(x.amount) * (x.ccy && x.ccy !== 'SGD' ? fxAt(x.date) : 1)) }));
      const bank = flowsAll.filter((f) => f.accountId === acct.id && f.txn.date <= asOf);
      // external money in/out: statement deposits/withdrawals, plus bank lines (bank wins if a statement doesn't list them)
      const ext = [];
      act.filter((x) => x.type === 'deposit' || x.type === 'withdrawal').forEach((x) => ext.push({ date: x.date, amount: x.type === 'deposit' ? x.sgd : -x.sgd, via: 'statement' }));
      bank.filter((f) => f.flow !== 'dividend').forEach((f) => {
        const amt = f.flow === 'contribution' ? f.amount : -f.amount;
        if (!ext.some((e) => e.via === 'statement' && Math.abs(Math.abs(e.amount) - f.amount) < 1 && Math.abs(daysUntil(e.date, f.txn.date)) <= 7)) ext.push({ date: f.txn.date, amount: amt, via: 'bank', txnId: f.txn.id });
      });
      // paidOut: the payout left the account (bond coupons, SGX dividends to the bank), so it isn't in the value and counts toward the gain
      const divs = act.filter((x) => x.type === 'dividend').map((x) => ({ date: x.date, amount: x.sgd, paidOut: !!x.paidOut })).concat(bank.filter((f) => f.flow === 'dividend').map((f) => ({ date: f.txn.date, amount: f.amount, txnId: f.txn.id, paidOut: true })));
      const fees = act.filter((x) => x.type === 'fee').map((x) => ({ date: x.date, amount: x.sgd }));
      const rebates = act.filter((x) => x.type === 'cashback').map((x) => ({ date: x.date, amount: x.sgd }));
      const sum = (arr, from, to) => r2(arr.filter((x) => x.date >= from && x.date <= (to || asOf)).reduce((s, x) => s + num(x.amount), 0));
      const latest = snaps[snaps.length - 1] || null, first = snaps[0] || null;
      // an "opening" snapshot (value 0 the day before the first deposit) anchors since-start returns, but isn't a year-end value
      let startYtd = snaps.filter((s) => s.date < yStart).pop() || snaps.find((s) => s.date >= yStart) || null;
      if (startYtd && startYtd.opening && startYtd.date < yStart) startYtd = null;
      const windowStats = (start, end) => {
        if (!start || !end || start === end || start.date >= end.date) return null;
        const inWin = ext.filter((e) => e.date > start.date && e.date <= end.date);
        const net = inWin.reduce((s, e) => s + e.amount, 0);
        const paid = divs.filter((d) => d.paidOut && d.date > start.date && d.date <= end.date);
        const paidOut = paid.reduce((s, d) => s + num(d.amount), 0);
        const gain = num(end.valueSgd) - num(start.valueSgd) - net + paidOut;
        const T = daysUntil(end.date, start.date);
        const base = num(start.valueSgd) + inWin.reduce((s, e) => s + e.amount * (daysUntil(end.date, e.date) / T), 0);
        const ret = base > 0 ? gain / base : null;
        const ccyEnd = num(end.valueCcy), fxMove = end.ccy && end.ccy !== 'SGD' && ccyEnd ? r2(ccyEnd * (num(end.fx) - num(start.fx))) : 0;
        return { from: start.date, to: end.date, net: r2(net), gain: r2(gain), ret, days: T, fxEffect: fxMove, paidOut: r2(paidOut),
          annualised: T >= 300 ? xirr([{ date: start.date, amount: -num(start.valueSgd) }].concat(inWin.map((e) => ({ date: e.date, amount: -e.amount })), paid.map((d) => ({ date: d.date, amount: num(d.amount) })), [{ date: end.date, amount: num(end.valueSgd) }])) : null };
      };
      const avgVal = (from) => { const w = snaps.filter((s) => s.date >= from); return w.length ? w.reduce((s, x) => s + num(x.valueSgd), 0) / w.length : null; };
      const av12 = avgVal(yearAgo);
      // fee rate is annualised over the part of the last year we have data for
      const feeFrom = first && first.date > yearAgo ? first.date : yearAgo;
      const feeDays = daysUntil(asOf, feeFrom);
      const alloc = { assetClass: {}, region: {}, holdings: [] };
      if (latest && latest.holdings && latest.holdings.length) {
        const fx = num(latest.fx) || 1;
        latest.holdings.forEach((h) => {
          const v = num(h.valueSgd) || num(h.value) * fx; if (!v) return;
          const c = h.assetClass ? h : { ...h, ...classifyHolding(h.name, h.code) };
          alloc.assetClass[c.assetClass] = r2((alloc.assetClass[c.assetClass] || 0) + v);
          alloc.region[c.assetClass === 'Equity' || c.assetClass === 'REITs' ? c.region : c.assetClass] = r2((alloc.region[c.assetClass === 'Equity' || c.assetClass === 'REITs' ? c.region : c.assetClass] || 0) + v);
          alloc.holdings.push({ code: h.code, name: h.name, valueSgd: r2(v), pnl: h.pnl, cost: h.cost, value: h.value, units: h.units, price: h.price, assetClass: c.assetClass, region: c.region, expenseRatio: h.expenseRatio, isin: h.isin });
        });
        const cash = num(latest.cashSgd) || num(latest.cashCcy) * fx;
        if (cash) { alloc.assetClass.Cash = r2((alloc.assetClass.Cash || 0) + cash); alloc.region.Cash = r2((alloc.region.Cash || 0) + cash); }
        alloc.holdings.sort((a, b) => b.valueSgd - a.valueSgd);
      }
      const trades = act.filter((x) => (x.type === 'buy' || x.type === 'sell') && x.date >= yearAgo);
      return {
        account: acct, snapshots: snaps, latest, first,
        value: latest ? r2(num(latest.valueSgd)) : null, valueDate: latest ? latest.date : null,
        contributions: ext.sort((a, b) => (a.date < b.date ? -1 : 1)),
        contributedYtd: r2(ext.filter((e) => e.date >= yStart).reduce((s, e) => s + e.amount, 0)),
        contributedAll: r2(ext.reduce((s, e) => s + e.amount, 0)),
        dividends: divs, dividendsYtd: sum(divs, yStart), dividends12m: sum(divs, yearAgo),
        fees, feesYtd: sum(fees, yStart), fees12m: sum(fees, yearAgo),
        cashback: rebates, cashbackYtd: sum(rebates, yStart), cashback12m: sum(rebates, yearAgo), feesAll: sum(fees, '0000'), cashbackAll: sum(rebates, '0000'),
        feeRate: av12 && fees.length && feeDays >= 60 ? (sum(fees, yearAgo) / av12) * (365 / Math.min(365, feeDays)) : null, feeFrom: feeFrom > yearAgo ? feeFrom : null,   // platform fees; fund costs (net of any cashback) sit on each holding's expenseRatio
        yield12m: av12 && divs.length ? sum(divs, yearAgo) / av12 : null,
        ytd: windowStats(startYtd, latest), sinceStart: windowStats(first, latest),
        allocation: alloc, cashShare: latest && latest.valueSgd ? (alloc.assetClass.Cash || 0) / num(latest.valueSgd) : null,
        trades: trades.length, turnover: r2(trades.filter((x) => x.type === 'sell').reduce((s, x) => s + x.sgd, 0)),
        activity: act,
      };
    });
    const valued = accounts.filter((a) => a.value != null);
    const total = r2(valued.reduce((s, a) => s + a.value, 0));
    const agg = (k) => { const o = {}; valued.forEach((a) => { const src = a.allocation[k]; const sumA = Object.values(src).reduce((s, v) => s + v, 0); if (sumA) Object.entries(src).forEach(([n, v]) => { o[n] = r2((o[n] || 0) + v); }); else if (a.value) { const key = a.account.type === 'cpf' ? 'CPF' : 'Unclassified'; o[key] = r2((o[key] || 0) + a.value); } }); return o; };
    // month-end value series for the chart (carry the last known value forward per account)
    // only accounts with a value history are drawn; opening zeros are anchors, not readings
    const real = (a) => a.snapshots.filter((x) => !x.opening);
    const charted = valued.filter((a) => real(a).length >= 2);
    const months = [...new Set(charted.flatMap((a) => real(a).map((s) => s.date.slice(0, 7))))].sort();
    const series = charted.map((a) => ({ accountId: a.account.id, name: a.account.name, points: months.map((m) => { const s = real(a).filter((x) => x.date.slice(0, 7) <= m).pop(); return s ? { month: m, value: r2(num(s.valueSgd)) } : { month: m, value: null }; }) }));
    return {
      asOf, accounts, total, months, series, notCharted: valued.filter((a) => real(a).length < 2 && a.value).map((a) => a.account.name),
      contributedYtd: r2(accounts.reduce((s, a) => s + a.contributedYtd, 0)),
      dividendsYtd: r2(accounts.reduce((s, a) => s + a.dividendsYtd, 0)),
      feesYtd: r2(accounts.reduce((s, a) => s + a.feesYtd, 0)),
      gainYtd: valued.some((a) => a.ytd) ? r2(valued.reduce((s, a) => s + (a.ytd ? a.ytd.gain : 0), 0)) : null,
      gainAll: valued.some((a) => a.sinceStart) ? r2(valued.reduce((s, a) => s + (a.sinceStart ? a.sinceStart.gain : 0), 0)) : null,
      cashbackYtd: r2(accounts.reduce((s, a) => s + a.cashbackYtd, 0)),
      allocation: { assetClass: agg('assetClass'), region: agg('region') },
      unassigned: flowsAll.filter((f) => !f.accountId),
    };
  }

  /** Plain-English observations for the Investments page. Each: { level: 'info'|'watch', text }. */
  function investmentInsights(summary) {
    const out = [];
    const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
    const money = (x) => '$' + Math.abs(x).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    summary.accounts.forEach((a) => {
      const n = a.account.name;
      if (a.account.type === 'cpf' && a.ytd) {
        const inY = a.contributions.filter((c) => c.date >= a.ytd.from && c.amount > 0).reduce((x, c) => x + c.amount, 0);
        const outY = -a.contributions.filter((c) => c.date >= a.ytd.from && c.amount < 0).reduce((x, c) => x + c.amount, 0);
        out.push({ level: 'info', text: `${n}: ${money(a.value)} on ${a.valueDate}. Since ${a.ytd.from}, ${money(inY)} went in and ${money(outY)} was paid out of it (housing, insurance). CPF interest is credited at the end of December, so this year's growth shows up then.` });
      } else if (a.ytd) {
        const w = a.ytd;
        out.push({ level: 'info', text: `${n}: ${w.gain >= 0 ? 'up' : 'down'} ${money(w.gain)} (${w.ret != null ? (w.ret >= 0 ? '+' : '') + pct(w.ret) : '—'}) from ${w.from} to ${w.to}` +
          (w.net ? `, after ${w.net > 0 ? 'adding' : 'taking out'} ${money(w.net)}` : ', with no new money added') + (w.paidOut ? `. That includes ${money(w.paidOut)} paid out as interest or dividends` : '') + '.' });
        if (Math.abs(w.fxEffect) >= 5) out.push({ level: 'info', text: `${n} is held in ${a.latest.ccy}. Exchange-rate moves ${w.fxEffect < 0 ? 'cut' : 'added'} about ${money(w.fxEffect)} in SGD terms over the same period; the rest is market movement.` });
      }
      if (!a.ytd && a.sinceStart && a.sinceStart.from) {
        const w = a.sinceStart;
        const since = a.first && a.first.opening && a.contributions.length ? a.contributions[0].date : w.from;
        if (!a.value && w.net <= 0) out.push({ level: 'info', text: `${n}: closed. It made ${money(w.gain)} overall before the money was taken out.` });
        else out.push({ level: 'info', text: `${n}: ${w.gain >= 0 ? 'up' : 'down'} ${money(w.gain)} on ${money(w.net)} put in since ${since}` + (w.annualised != null ? `, about ${pct(w.annualised)} a year (money-weighted)` : '') + '.' });
      }
      if (a.feeRate != null && a.feeRate >= 0.004) out.push({ level: 'watch', text: `${n}: fees were ${money(a.fees12m)} ${a.feeFrom ? 'since ' + a.feeFrom : 'over the last 12 months'}${a.cashback12m ? ` (cashback paid back ${money(a.cashback12m)})` : ''}, about ${pct(a.feeRate, 2)} a year of the average balance. Dividends over the same period: ${money(a.dividends12m)}.` });
      if (a.yield12m != null && a.yield12m >= 0.02 && a.value) out.push({ level: 'info', text: `${n}: ${money(a.dividends12m)} in ${a.allocation.holdings.length && a.allocation.holdings.every((h) => h.assetClass === 'Bonds') ? 'interest' : 'dividends'} over the last 12 months, about ${pct(a.yield12m)} of its value${a.ytd && a.ytd.paidOut ? ' (counted in the gain above)' : ''}.` });
      if (a.cashShare != null && a.cashShare >= 0.05 && !['srs', 'cash'].includes(a.account.type) && a.cashShare * a.value >= 500) out.push({ level: 'watch', text: `${n}: ${pct(a.cashShare)} is sitting in cash inside the portfolio.` });
      const top = a.allocation.holdings[0];
      if (top && a.value && a.account.type !== 'cpf' && a.allocation.holdings.length > 1 && top.valueSgd / a.value >= 0.3) out.push({ level: 'info', text: `${n}: the largest holding is ${top.name} at ${pct(top.valueSgd / a.value, 0)} of the portfolio.` });
      if (a.trades >= 6) out.push({ level: 'info', text: `${n}: ${a.trades} buy/sell trades in the last 12 months (rebalancing), selling ${money(a.turnover)} worth.` });
      if (a.value == null && (a.contributions.length || a.dividends.length)) out.push({ level: 'watch', text: `${n}: ${a.contributions.length ? money(a.contributedAll) + ' put in' : ''}${a.contributions.length && a.dividends.length ? ' and ' : ''}${a.dividends.length ? money(a.dividends.reduce((s, x) => s + x.amount, 0)) + ' in dividends' : ''} on record, but no current value. Add one to see its return.` });
      if (a.latest && a.latest.source === 'statement' && daysUntil(summary.asOf, a.latest.date) > 45) out.push({ level: 'watch', text: `${n}: the latest statement is from ${a.latest.date}. Import the newer ones to keep values current.` });
    });
    const ua = summary.unassigned.filter((f) => f.flow !== 'dividend');
    if (ua.length) out.push({ level: 'watch', text: `${ua.length} transfer${ua.length > 1 ? 's' : ''} (${money(ua.reduce((s, f) => s + (f.flow === 'contribution' ? f.amount : -f.amount), 0))}) look like investment money but aren't tied to an account yet.` });
    // the same kind of fund held at very different cost
    const funds = summary.accounts.flatMap((a) => a.allocation.holdings.filter((h) => h.expenseRatio != null).map((h) => ({ ...h, acct: a.account.name })));
    const byKind = {};
    funds.forEach((h) => { (byKind[h.assetClass + '|' + h.region] = byKind[h.assetClass + '|' + h.region] || []).push(h); });
    Object.values(byKind).forEach((g) => {
      if (g.length < 2) return;
      const lo = g.reduce((m, h) => (h.expenseRatio < m.expenseRatio ? h : m)), hi = g.reduce((m, h) => (h.expenseRatio > m.expenseRatio ? h : m));
      if (hi.expenseRatio - lo.expenseRatio >= 0.0015) out.push({ level: 'watch', text: `${hi.name} (${hi.acct}, ${pct(hi.expenseRatio, 2)} a year) and ${lo.name} (${lo.acct}, ${pct(lo.expenseRatio, 2)}) are both ${hi.region} ${hi.assetClass.toLowerCase()} funds. On ${money(hi.valueSgd)} the cost gap is about ${money(hi.valueSgd * (hi.expenseRatio - lo.expenseRatio))} a year.` });
    });
    const eqTot = summary.accounts.reduce((s, a) => s + a.allocation.holdings.filter((h) => h.assetClass === 'Equity').reduce((x, h) => x + h.valueSgd, 0), 0);
    const eqUS = summary.accounts.reduce((s, a) => s + a.allocation.holdings.filter((h) => h.assetClass === 'Equity' && h.region === 'US').reduce((x, h) => x + h.valueSgd, 0), 0);
    if (eqTot > 0 && eqUS / eqTot >= 0.6) out.push({ level: 'info', text: `${pct(eqUS / eqTot, 0)} of the shares you hold across accounts are US companies (${money(eqUS)} of ${money(eqTot)}).` });
    const tot = Object.values(summary.allocation.assetClass).reduce((s, v) => s + v, 0);
    if (tot) {
      const parts = Object.entries(summary.allocation.assetClass).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${v / tot < 0.005 ? 'under 1%' : pct(v / tot, 0)} ${k === 'Equity' ? 'shares' : ['CPF', 'REITs'].includes(k) ? k : k.toLowerCase()}`);
      out.push({ level: 'info', text: `Across valued accounts: ${parts.join(', ')}.` });
    }
    return out;
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
    parseDigiPortfolio, classifyHolding, mergeInvestmentStatement, mergeInvestmentData, investFlows, investmentSummary, investmentInsights, xirr,
    categorise, categoryForMcc, parseStatementText, parseCSV, guessCsvMapping, csvToRows, txnFingerprint,
    util: { norm, mccIn, expandList, r2, ymd, parseYmd, daysUntil },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
