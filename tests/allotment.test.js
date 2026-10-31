import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qibAllotment, bidFromAmount, profitScenarios, backSolveDemand } from '../docs/allotment.js';

const cases = JSON.parse(readFileSync(new URL('./allotment_cases.json', import.meta.url)));
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());

for (const c of cases) {
  test(c.name, () => {
    const p = Object.fromEntries(Object.entries(c.in).map(([k, v]) => [camel(k), v]));
    assert.equal(qibAllotment(p).allottedShares, c.out.allotted_shares);
  });
}

test('amount to lots', () => {
  assert.deepEqual(bidFromAmount({ amount: 5000000, price: 105, lotSize: 142 }),
    { lots: 335, shares: 47570, amountUsed: 4994850, leftover: 5150 });
});

test('profit table', () => {
  const rows = profitScenarios({ allottedShares: 100, issuePrice: 100, rupeeSteps: [-2, 5], pctSteps: [], gmp: 10 });
  assert.deepEqual(rows.map((r) => r.net), [1000, -200, 500]);
});

test('back-solve BLS Polymers: actual 11,934 implies final valid demand ~0.48% below live', () => {
  const r = backSolveDemand({ bidShares: 2503100, actualShares: 11934, netQibShares: 3400000, liveTimes: 200.25 });
  assert.ok(r.demandLow < 677620000 && 677620000 <= r.demandHigh);
  assert.ok(r.gapPct < -0.47 && r.gapPct > -0.49, String(r.gapPct));
  // round trip: the implied demand reproduces the actual allotment exactly
  const back = qibAllotment({ bidShares: 2503100, netQibShares: 3400000, subscriptionTimes: 200.25, validDemandShares: r.demand });
  assert.equal(back.allottedShares, 11934);
});
