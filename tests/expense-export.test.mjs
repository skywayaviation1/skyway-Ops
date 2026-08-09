import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountForCategory,
  availableMonths,
  buildQuickBooksRows,
  exportFilename,
  exportTotal,
  filterForMonth,
  monthKeyOf,
  rowsToCsv,
  summarizeByCategory,
  summarizeByUser,
} from '../src/expense-export.js';

function expense(overrides = {}) {
  return {
    id: 'exp-1',
    uid: 'u1',
    authorName: 'Jake Pilot',
    vendor: 'Signature Flight Support',
    category: 'FBO Fees',
    totalAmount: 421.5,
    currency: 'USD',
    transactionDate: '2026-01-15',
    status: 'approved',
    paidWith: 'amex',
    ...overrides,
  };
}

test('category maps to a QuickBooks account, unknown falls back', () => {
  assert.equal(accountForCategory('Fuel'), 'Fuel');
  assert.equal(accountForCategory('FBO Fees'), 'FBO & Handling');
  assert.equal(accountForCategory('Nonsense'), 'Ask My Accountant');
  assert.equal(accountForCategory('Fuel', { Fuel: 'Jet-A' }), 'Jet-A');
});

test('month key derives from transaction date and available months are sorted', () => {
  assert.equal(monthKeyOf(expense()), '2026-01');
  assert.equal(monthKeyOf(expense({ transactionDate: '02/03/2026' })), '2026-02');
  assert.equal(monthKeyOf(expense({ transactionDate: null, createdAt: Date.UTC(2025, 11, 2) })), '2025-12');
  const months = availableMonths([
    expense({ transactionDate: '2026-01-15' }),
    expense({ transactionDate: '2026-03-01' }),
    expense({ transactionDate: '2026-01-20' }),
  ]);
  assert.deepEqual(months, ['2026-03', '2026-01']);
});

test('only approved or synced expenses in the month are exportable', () => {
  const list = [
    expense({ id: 'a', status: 'approved', transactionDate: '2026-01-10' }),
    expense({ id: 'b', status: 'draft', transactionDate: '2026-01-11' }),
    expense({ id: 'c', status: 'pending', transactionDate: '2026-01-12' }),
    expense({ id: 'd', status: 'synced', transactionDate: '2026-02-01' }),
  ];
  assert.deepEqual(filterForMonth(list, '2026-01').map((e) => e.id), ['a']);
  assert.deepEqual(filterForMonth(list, null).map((e) => e.id).sort(), ['a', 'd']);
});

test('QuickBooks rows carry the fields an importer maps', () => {
  const [row] = buildQuickBooksRows([expense({ notes: 'Overnight fees', tripUid: 'TRIP9' })]);
  assert.equal(row.Date, '01/15/2026');
  assert.equal(row.Vendor, 'Signature Flight Support');
  assert.equal(row.Account, 'FBO & Handling');
  assert.equal(row.Amount, '421.50');
  assert.equal(row.Employee, 'Jake Pilot');
  assert.equal(row['Payment Account'], 'Amex');
  assert.equal(row.Billable, 'Company paid');
  assert.match(row.Memo, /FBO Fees/);
  assert.match(row.Memo, /Trip TRIP9/);
  assert.match(row.Memo, /Overnight fees/);
  assert.equal(row['Reference No'], 'exp-1');
});

test('personal cards are flagged reimbursable', () => {
  const [row] = buildQuickBooksRows([expense({ paidWith: 'personal' })]);
  assert.equal(row.Billable, 'Reimbursable');
  assert.equal(row['Payment Account'], 'Personal (reimbursable)');
});

test('summaries total by category and user with money rounding', () => {
  const list = [
    expense({ id: 'a', uid: 'u1', authorName: 'Jake', category: 'Fuel', totalAmount: 100.1 }),
    expense({ id: 'b', uid: 'u1', authorName: 'Jake', category: 'Fuel', totalAmount: 50.2 }),
    expense({ id: 'c', uid: 'u2', authorName: 'Zack', category: 'Catering', totalAmount: 33.33 }),
  ];
  const byCategory = summarizeByCategory(list);
  assert.equal(byCategory[0].category, 'Fuel');
  assert.equal(byCategory[0].total, 150.3);
  assert.equal(byCategory[0].count, 2);
  const byUser = summarizeByUser(list);
  assert.equal(byUser[0].name, 'Jake');
  assert.equal(byUser[0].total, 150.3);
  assert.equal(exportTotal(list), 183.63);
});

test('CSV output is BOM-prefixed, quoted and filename is period scoped', () => {
  const csv = rowsToCsv(buildQuickBooksRows([expense({ vendor: 'Jet, Fuel Co' })]));
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"Jet, Fuel Co"/);
  assert.ok(csv.includes('\r\n'));
  assert.equal(exportFilename({ scopeLabel: 'Jake Pilot', monthKey: '2026-01' }), 'quickbooks-jake-pilot-2026-01.csv');
  assert.equal(exportFilename({ scopeLabel: 'Company', monthKey: null }), 'quickbooks-company-all-time.csv');
});
