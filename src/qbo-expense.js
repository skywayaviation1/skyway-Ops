// Pure QuickBooks entity payloads for approved Skyway expenses.

import { expenseDate, round2 } from './expense-export.js';

export function qboDate(expense) {
  const date = expenseDate(expense);
  if (!date) return new Date().toISOString().slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function qboDocNumber(expense) {
  // QBO DocNumber is capped; preserve the unique end of the expense id.
  const clean = String(expense?.id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return (`SW-${clean}`).slice(0, 21);
}

export function qboPrivateNote(expense) {
  const parts = [`skyway-ops:${expense.id}`];
  if (expense.authorName) parts.push(`submitted by ${expense.authorName}`);
  if (expense.tripUid) parts.push(`trip ${expense.tripUid}`);
  if (expense.notes) parts.push(String(expense.notes).replace(/[\r\n]+/g, ' ').slice(0, 1000));
  return parts.join(' · ');
}

function expenseLine(expense, expenseAccount) {
  return {
    Amount: round2(expense.totalAmount),
    DetailType: 'AccountBasedExpenseLineDetail',
    Description: expense.category || 'Expense',
    AccountBasedExpenseLineDetail: {
      AccountRef: {
        value: String(expenseAccount.Id),
        name: expenseAccount.Name,
      },
      BillableStatus: 'NotBillable',
    },
  };
}

export function buildBillPayload({ expense, expenseAccount, vendor }) {
  return {
    VendorRef: {
      value: String(vendor.Id),
      name: vendor.DisplayName,
    },
    TxnDate: qboDate(expense),
    DueDate: qboDate(expense),
    DocNumber: qboDocNumber(expense),
    PrivateNote: `${qboPrivateNote(expense)} · reimbursable`,
    TotalAmt: round2(expense.totalAmount),
    Line: [expenseLine(expense, expenseAccount)],
  };
}

export function qboSyncEligibility(expense) {
  if (!expense) return { eligible: false, reason: 'Expense missing' };
  if (expense.qbTransactionId) return { eligible: false, reason: 'Already synced' };
  if (expense.status !== 'approved') return { eligible: false, reason: 'Expense must be approved' };
  if (!Number.isFinite(Number(expense.totalAmount)) || Number(expense.totalAmount) <= 0) {
    return { eligible: false, reason: 'Expense amount must be greater than zero' };
  }
  if (!expense.paidWith) return { eligible: false, reason: 'Payment account is not tagged' };
  if (expense.paidWith !== 'personal') {
    return {
      eligible: false,
      reason: 'Match this receipt to its posted QuickBooks credit-card charge',
    };
  }
  return { eligible: true, entityType: 'Bill' };
}
