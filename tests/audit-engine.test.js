// Checks the AIS Audit Sandbox engine across thousands of rounds.
// Run with: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../audit/engine.js');

const ROUNDS = 3000;
const rounds = [];
for (let s = 1; s <= ROUNDS; s++) rounds.push({ seed: s, round: E.generateRound(s) });

const people = (r) => Object.fromEntries(r.people.map((p) => [p.id, p]));
const registered = (r) => new Set(r.registry.map((v) => v.name));

test('rounds are reproducible from a seed', () => {
  assert.deepStrictEqual(JSON.stringify(E.generateRound(42)), JSON.stringify(E.generateRound(42)));
});

test('every round builds, usually on the first few tries', () => {
  const attempts = rounds.map((x) => x.round.attempts);
  assert.ok(Math.max(...attempts) <= 50, 'max attempts ' + Math.max(...attempts));
  const avg = attempts.reduce((a, b) => a + b, 0) / attempts.length;
  assert.ok(avg < 3, 'average attempts ' + avg.toFixed(2));
});

test('ledger shape: size, ids, dates inside the fiscal year and in order', () => {
  for (const { seed, round: r } of rounds) {
    assert.ok(r.txns.length >= 18 && r.txns.length <= 22, `seed ${seed}: ${r.txns.length} rows`);
    assert.strictEqual(new Set(r.txns.map((t) => t.id)).size, r.txns.length, `seed ${seed}: duplicate ids`);
    let prev = '';
    for (const t of r.txns) {
      for (const d of [t.date, t.po.date, t.inv.date].concat(t.rr ? [t.rr.date] : [])) assert.ok(d.startsWith(String(r.year)), `seed ${seed}: ${d} outside FY${r.year}`);
      assert.ok(t.date >= prev, `seed ${seed}: ledger out of date order`);
      prev = t.date;
      assert.ok(t.po.date <= t.date, `seed ${seed} ${t.id}: PO dated after payment`);
      if (t.rr) assert.ok(t.po.date <= t.rr.date && t.rr.date <= t.date, `seed ${seed} ${t.id}: receiving out of order`);
    }
  }
});

test('money is whole cents and every document foots', () => {
  for (const { seed, round: r } of rounds) {
    for (const t of r.txns) {
      for (const n of [t.po.unit, t.po.total, t.inv.unit, t.inv.total, t.amount]) assert.ok(Number.isInteger(n) && n > 0, `seed ${seed} ${t.id}: ${n}`);
      assert.strictEqual(t.po.total, t.po.qty * t.po.unit, `seed ${seed} ${t.id}: PO doesn't foot`);
      assert.strictEqual(t.inv.total, t.inv.qty * t.inv.unit, `seed ${seed} ${t.id}: invoice doesn't foot`);
      assert.strictEqual(t.amount, t.inv.total);
      assert.strictEqual(t.vendor, t.inv.vendor);
    }
  }
});

test('the answer key matches a fresh evaluation, one problem per row', () => {
  for (const { seed, round: r } of rounds) {
    const found = E.evaluate(r);
    for (const t of r.txns) {
      assert.ok(found[t.id].length <= 1, `seed ${seed} ${t.id}: ${found[t.id]}`);
      assert.strictEqual(found[t.id][0] || null, r.key[t.id], `seed ${seed} ${t.id}`);
    }
  }
});

// Each type checked directly against its definition, without using the engine's evaluate().
test('every keyed problem is supported by the evidence', () => {
  for (const { seed, round: r } of rounds) {
    const P = people(r), REG = registered(r);
    const byPo = {};
    r.txns.forEach((t) => (byPo[t.po.num] = byPo[t.po.num] || []).push(t));
    for (const t of r.txns) {
      const k = r.key[t.id], at = `seed ${seed} ${t.id} ${k}`;
      if (k === 'DUPLICATE_PAYMENT') {
        const first = byPo[t.po.num][0];
        assert.notStrictEqual(first, t, at);
        assert.ok(first.date < t.date && first.rr === t.rr && t.inv.num === first.inv.num + '-A', at);
        assert.strictEqual(r.key[first.id], null, at + ': original should be clean');
      }
      if (k === 'SPLIT_PURCHASE') {
        const g = r.txns.filter((x) => x.po.project === t.po.project && x.po.vendor === t.po.vendor);
        assert.ok(g.length >= 2, at);
        const combined = g.reduce((s, x) => s + x.po.total, 0);
        for (const x of g) {
          assert.ok(E.canApprove(P[x.po.approver], x.po.dept, x.po.total), at + ': piece should be within limit');
          assert.ok(P[x.po.approver].limit < combined, at + ': combined should be over the limit');
          assert.strictEqual(r.key[x.id], 'SPLIT_PURCHASE', at);
        }
      }
      if (k === 'UNREGISTERED_VENDOR') assert.ok(!REG.has(t.inv.vendor) && t.po.vendor === t.inv.vendor && t.rr.vendor === t.inv.vendor, at);
      if (k === 'VENDOR_MISMATCH') assert.ok(REG.has(t.inv.vendor) && REG.has(t.po.vendor) && t.inv.vendor !== t.po.vendor && t.rr.vendor === t.po.vendor, at);
      if (k === 'MISSING_RECEIPT') assert.strictEqual(t.rr, null, at);
      if (k === 'UNAUTHORIZED_APPROVAL') assert.ok(!E.canApprove(P[t.po.approver], t.po.dept, t.po.total), at);
      if (k === 'QTY_MISMATCH') assert.ok(t.inv.qty > t.po.qty && t.rr.qty === t.po.qty && t.inv.unit === t.po.unit, at);
      if (k === 'PRICE_MISMATCH') assert.ok(t.inv.unit > t.po.unit && t.inv.qty === t.po.qty && t.rr.qty === t.po.qty, at);
      if (!k) {
        assert.ok(t.rr && REG.has(t.inv.vendor) && t.inv.vendor === t.po.vendor && t.rr.vendor === t.po.vendor, at + ': clean row with a document problem');
        assert.ok(t.inv.qty === t.po.qty && t.rr.qty === t.po.qty && t.inv.unit === t.po.unit, at);
        assert.ok(E.canApprove(P[t.po.approver], t.po.dept, t.po.total), at + ': clean row approved without authority');
        assert.strictEqual(byPo[t.po.num][0], t, at + ': clean row paying a PO twice');
      }
    }
  }
});

test('the three-way match is computed from the documents and agrees with the key', () => {
  const docTypes = new Set(['VENDOR_MISMATCH', 'MISSING_RECEIPT', 'QTY_MISMATCH', 'PRICE_MISMATCH']);
  for (const { seed, round: r } of rounds) {
    for (const t of r.txns) assert.strictEqual(E.threeWayMatch(t).ok, !docTypes.has(r.key[t.id]), `seed ${seed} ${t.id} ${r.key[t.id]}`);
  }
});

test('each round mixes three to five problem types, including one only the documents show', () => {
  for (const { seed, round: r } of rounds) {
    const types = new Set(Object.values(r.key).filter(Boolean));
    assert.ok(types.size >= 3 && types.size <= 5, `seed ${seed}: ${[...types]}`);
    assert.ok(types.has('QTY_MISMATCH') || types.has('PRICE_MISMATCH'), `seed ${seed}`);
    assert.ok(r.problemRows >= 4 && r.problemRows < r.txns.length / 2, `seed ${seed}: ${r.problemRows} problem rows`);
  }
});

test('every type and every trap shows up across rounds', () => {
  const seen = new Set();
  let nearLimit = 0, sameVendorTwoProjects = 0, vagueClean = 0, lookalikes = 0;
  for (const { round: r } of rounds) {
    const P = people(r), REG = [...registered(r)];
    Object.values(r.key).forEach((k) => k && seen.add(k));
    for (const t of r.txns) {
      const lim = P[t.po.approver].limit;
      if (!r.key[t.id] && lim < Infinity && t.po.total >= lim * 0.96) nearLimit++;
      if (!r.key[t.id] && ['Global Solutions LLC', 'Premier Advisory Group', 'Atlas Group Inc.'].includes(t.vendor)) vagueClean++;
      if (r.key[t.id] === 'UNREGISTERED_VENDOR' && REG.some((n) => E.lookalike(n) === t.vendor)) lookalikes++;
      if (!r.key[t.id] && r.txns.some((x) => x !== t && !r.key[x.id] && x.vendor === t.vendor && x.po.project !== t.po.project && Math.abs(x.po.day - t.po.day) <= 7 && x.po.approver === t.po.approver)) sameVendorTwoProjects++;
    }
  }
  assert.deepStrictEqual([...seen].sort(), [...E.TYPE_KEYS].sort());
  for (const [name, n] of Object.entries({ nearLimit, sameVendorTwoProjects, vagueClean, lookalikes })) assert.ok(n > ROUNDS / 10, `${name}: ${n}`);
});

test('scoring counts wrong flags against precision and missed problems against recall', () => {
  const key = { a: 'QTY_MISMATCH', b: 'SPLIT_PURCHASE', c: null, d: null };
  const perfect = E.score(key, { a: 'QTY_MISMATCH', b: 'SPLIT_PURCHASE' });
  assert.strictEqual(perfect.f1, 1);
  const everything = E.score(key, { a: 'QTY_MISMATCH', b: 'SPLIT_PURCHASE', c: 'QTY_MISMATCH', d: 'PRICE_MISMATCH' });
  assert.strictEqual(everything.recall, 1);
  assert.strictEqual(everything.precision, 0.5);
  assert.ok(everything.f1 < 0.7);
  const wrongType = E.score(key, { a: 'PRICE_MISMATCH' });
  assert.deepStrictEqual([wrongType.correct, wrongType.wrong, wrongType.missed], [0, 1, 2]);
  assert.strictEqual(E.score(key, {}).f1, 0);
});

test('page copy has no em dashes', () => {
  const text = JSON.stringify([E.TYPES, E.POLICY]);
  assert.ok(!text.includes('—'), 'em dash in engine copy');
});
