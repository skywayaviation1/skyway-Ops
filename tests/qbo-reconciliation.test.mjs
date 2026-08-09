import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchQboPurchases,
  normalizeQboPurchase,
  qboLinkPatch,
} from '../src/qbo-reconciliation.js';

function expense(overrides = {}) {
  return {
    id: 'exp-1',
    vendor: 'Signature Flight Support',
    totalAmount: 421.5,
    transactionDate: '2026-08-04',
    status: 'approved',
    paidWith: 'amex',
    ...overrides,
  };
}

function purchase(overrides = {}) {
  return {
    Id: '100',
    TxnDate: '2026-08-05',
    TotalAmt: 421.5,
    AccountRef: { value: '20', name: 'Amex' },
    EntityRef: { value: '30', name: 'Signature Flight' },
    PaymentType: 'CreditCard',
    ...overrides,
  };
}

test('normalizes a QBO Purchase without leaking raw structure', () => {
  assert.deepEqual(normalizeQboPurchase(purchase()), {
    id: '100',
    date: new Date('2026-08-05T00:00:00'),
    txnDate: '2026-08-05',
    amount: 421.5,
    accountId: '20',
    accountName: 'Amex',
    vendorName: 'Signature Flight',
    vendorId: '30',
    docNumber: '',
    privateNote: '',
    paymentType: 'CreditCard',
  });
});

test('matches exact amount/date/vendor on the mapped card account', () => {
  const result = matchQboPurchases(
    [expense()],
    [purchase()],
    { amex: { id: '20', name: 'Amex' } },
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].expense.id, 'exp-1');
  assert.equal(result.matched[0].purchase.id, '100');
  assert.ok(result.matched[0].score > 100);
  assert.equal(result.stats.matchedTotal, 421.5);
});

test('will not match the same amount from the wrong linked card', () => {
  const result = matchQboPurchases(
    [expense()],
    [purchase({ AccountRef: { value: '99', name: 'Capital One' } })],
    { amex: { id: '20', name: 'Amex' } },
  );
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatchedExpenses.length, 1);
});

test('unmapped cards are reported instead of loosely matched', () => {
  const result = matchQboPurchases([expense()], [purchase()], {});
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmapped.length, 1);
  assert.match(result.unmapped[0].reason, /Map amex/);
});

test('already-linked, personal and draft expenses are excluded', () => {
  const result = matchQboPurchases([
    expense({ id: 'linked', qbTransactionId: '1' }),
    expense({ id: 'personal', paidWith: 'personal' }),
    expense({ id: 'draft', status: 'draft' }),
  ], [purchase()], { amex: { id: '20', name: 'Amex' } });
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatchedExpenses.length, 0);
});

test('link patch records QBO identity and reconciliation audit', () => {
  const [match] = matchQboPurchases(
    [expense()],
    [purchase()],
    { amex: { id: '20', name: 'Amex' } },
  ).matched;
  const patch = qboLinkPatch(match, { uid: 'acct-1', name: 'Accounting' }, 'realm');
  assert.equal(patch.status, 'synced');
  assert.equal(patch.qbTransactionId, '100');
  assert.equal(patch.qbEntityType, 'Purchase');
  assert.equal(patch.qbLinkMode, 'linked');
  assert.equal(patch.qbCompanyId, 'realm');
  assert.equal(patch.qboAccountRef.id, '20');
  assert.equal(patch.qboMatchedBy, 'acct-1');
});
