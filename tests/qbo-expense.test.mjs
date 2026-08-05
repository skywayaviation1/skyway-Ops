import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBillPayload,
  qboDate,
  qboDocNumber,
  qboSyncEligibility,
} from '../src/qbo-expense.js';

function expense(overrides = {}) {
  return {
    id: 'exp-1700000-abcdef',
    authorName: 'Jake Pilot',
    authorEmail: 'jake@flyskyway.com',
    vendor: 'Signature Flight',
    transactionDate: '2026-08-04',
    totalAmount: 421.5,
    category: 'FBO Fees',
    paidWith: 'amex',
    status: 'approved',
    reconciledAt: 1,
    ...overrides,
  };
}

const expenseAccount = { Id: '10', Name: 'FBO & Handling' };
const vendor = { Id: '30', DisplayName: 'Signature Flight' };

test('company-card expenses must match a posted QBO charge', () => {
  assert.deepEqual(
    qboSyncEligibility(expense({ reconciledAt: null })),
    { eligible: false, reason: 'Match this receipt to its posted QuickBooks credit-card charge' },
  );
});

test('personal expenses become reimbursable bills without reconciliation', () => {
  assert.deepEqual(
    qboSyncEligibility(expense({ paidWith: 'personal', reconciledAt: null })),
    { eligible: true, entityType: 'Bill' },
  );
});

test('draft, zero and already-synced expenses are not eligible', () => {
  assert.equal(qboSyncEligibility(expense({ status: 'draft' })).eligible, false);
  assert.equal(qboSyncEligibility(expense({ totalAmount: 0 })).eligible, false);
  assert.equal(qboSyncEligibility(expense({ qbTransactionId: '123' })).reason, 'Already synced');
});

test('bill payload is payable to the crew vendor', () => {
  const payload = buildBillPayload({
    expense: expense({ paidWith: 'personal', reconciledAt: null }),
    expenseAccount,
    vendor: { Id: '40', DisplayName: 'Jake Pilot' },
  });
  assert.deepEqual(payload.VendorRef, { value: '40', name: 'Jake Pilot' });
  assert.equal(payload.Line[0].Amount, 421.5);
  assert.match(payload.PrivateNote, /reimbursable/);
});

test('QBO date and document number are stable', () => {
  assert.equal(qboDate(expense()), '2026-08-04');
  assert.equal(qboDocNumber(expense()), 'SW-exp-1700000-abcdef');
  assert.ok(qboDocNumber(expense({ id: 'this-is-a-very-long-expense-id-that-overflows' })).length <= 21);
});
