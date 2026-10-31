import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qibAllotment, bidFromAmount, profitScenarios } from '../docs/allotment.js';

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
