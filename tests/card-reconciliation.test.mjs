import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractLast4,
  parseCardStatement,
  parseCsv,
  parseStatementAmount,
  reconcile,
  reconciliationPatch,
} from '../src/card-reconciliation.js';

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x,y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x,y', 'he said "hi"']]);
});

test('statement amounts normalize currency, parentheses and CR credits', () => {
  assert.equal(parseStatementAmount('$1,234.50'), 1234.5);
  assert.equal(parseStatementAmount('(45.00)'), -45);
  assert.equal(parseStatementAmount('12.34 CR'), -12.34);
  assert.equal(parseStatementAmount(''), null);
  assert.equal(extractLast4('************4421'), '4421');
});

test('parsing a card statement keeps charges and drops payments', () => {
  const csv = [
    'Transaction Date,Description,Amount,Card No.',
    '01/15/2026,SIGNATURE FLIGHT,421.50,************4421',
    '01/16/2026,PAYMENT THANK YOU,-1000.00,************4421',
    '01/17/2026,ATLANTIC AVIATION,88.00,************0002',
  ].join('\n');
  const { charges, error } = parseCardStatement(csv);
  assert.equal(error, null);
  assert.equal(charges.length, 2);
  assert.equal(charges[0].amount, 421.5);
  assert.equal(charges[0].last4, '4421');
  assert.equal(charges[1].last4, '0002');
});

test('missing required columns reports a clear error', () => {
  const { charges, error } = parseCardStatement('foo,bar\n1,2');
  assert.equal(charges.length, 0);
  assert.match(error, /date and amount/);
});

function expense(overrides = {}) {
  return {
    id: 'exp-1',
    vendor: 'Signature Flight',
    totalAmount: 421.5,
    transactionDate: '2026-01-15',
    status: 'approved',
    ...overrides,
  };
}

test('reconcile matches on amount and date window, one-to-one', () => {
  const { charges } = parseCardStatement([
    'Date,Description,Amount,Card',
    '01/15/2026,SIGNATURE FLIGHT,421.50,4421',
    '01/17/2026,ATLANTIC,88.00,0002',
  ].join('\n'));
  const expenses = [
    expense({ id: 'exp-1', totalAmount: 421.5, transactionDate: '2026-01-15' }),
    expense({ id: 'exp-2', vendor: 'Atlantic', totalAmount: 88, transactionDate: '2026-01-18' }),
    expense({ id: 'exp-3', vendor: 'Hangar', totalAmount: 999, transactionDate: '2026-01-15' }),
  ];
  const result = reconcile(charges, expenses);
  assert.equal(result.matched.length, 2);
  assert.equal(result.stats.matchedTotal, 509.5);
  assert.equal(result.unmatchedExpenses.length, 1);
  assert.equal(result.unmatchedExpenses[0].id, 'exp-3');
  assert.equal(result.unmatchedCharges.length, 0);
});

test('a charge outside the date window is not matched', () => {
  const { charges } = parseCardStatement([
    'Date,Description,Amount',
    '01/01/2026,SIGNATURE,421.50',
  ].join('\n'));
  const result = reconcile(charges, [expense({ transactionDate: '2026-01-20' })], { windowDays: 5 });
  assert.equal(result.matched.length, 0);
  assert.equal(result.unmatchedCharges.length, 1);
});

test('already reconciled expenses are excluded from matching', () => {
  const { charges } = parseCardStatement([
    'Date,Description,Amount',
    '01/15/2026,SIGNATURE,421.50',
  ].join('\n'));
  const result = reconcile(charges, [expense({ reconciledAt: Date.now() })]);
  assert.equal(result.matched.length, 0);
  assert.equal(result.stats.alreadyReconciled, 1);
});

test('matching last four boosts score so the right expense wins', () => {
  const { charges } = parseCardStatement([
    'Date,Description,Amount,Card',
    '01/15/2026,FUEL,200.00,0002',
  ].join('\n'));
  const expenses = [
    expense({ id: 'wrong', vendor: 'Fuel', totalAmount: 200, transactionDate: '2026-01-15', reconciledCardLast4: '4421' }),
    expense({ id: 'right', vendor: 'Fuel', totalAmount: 200, transactionDate: '2026-01-15', reconciledCardLast4: '0002' }),
  ];
  const result = reconcile(charges, expenses);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].expense.id, 'right');
  const patch = reconciliationPatch(result.matched[0], 'Zack');
  assert.equal(patch.reconciledBy, 'Zack');
  assert.equal(patch.reconciledCardLast4, '0002');
  assert.equal(patch.statementAmount, 200);
  assert.equal(patch.statementDate, '2026-01-15');
});
