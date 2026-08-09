// Matches Skyway receipt expenses to posted QuickBooks credit-card Purchases.
// Raw, unreviewed Banking-feed rows are not exposed by QBO's public API; only
// transactions posted to a credit-card register can appear here.

import { expenseDate, money, round2 } from './expense-export.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeQboPurchase(purchase) {
  const date = purchase?.TxnDate ? new Date(`${purchase.TxnDate}T00:00:00`) : null;
  return {
    id: String(purchase?.Id || ''),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    txnDate: purchase?.TxnDate || '',
    amount: round2(purchase?.TotalAmt),
    accountId: String(purchase?.AccountRef?.value || ''),
    accountName: purchase?.AccountRef?.name || '',
    vendorName: purchase?.EntityRef?.name || '',
    vendorId: String(purchase?.EntityRef?.value || ''),
    docNumber: purchase?.DocNumber || '',
    privateNote: purchase?.PrivateNote || '',
    paymentType: purchase?.PaymentType || '',
  };
}

function vendorSimilarity(a, b) {
  const clean = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 2);
  const left = clean(a);
  const right = new Set(clean(b));
  if (!left.length || !right.size) return 0;
  const shared = left.filter((part) => right.has(part)).length;
  return shared / Math.max(left.length, right.size);
}

function score(expense, purchase, mappedAccountId, windowDays) {
  if (round2(expense.totalAmount) !== purchase.amount) return null;
  if (mappedAccountId && purchase.accountId !== String(mappedAccountId)) return null;
  const date = expenseDate(expense);
  let dayGap = 0;
  if (date && purchase.date) {
    dayGap = Math.abs(date.getTime() - purchase.date.getTime()) / DAY_MS;
    if (dayGap > windowDays) return null;
  }
  const similarity = vendorSimilarity(expense.vendor, purchase.vendorName);
  return {
    score: Math.round(100 - dayGap * 5 + similarity * 25),
    dayGap,
    vendorSimilarity: similarity,
  };
}

/**
 * Strongest one-to-one matches. A mapped QBO card account is mandatory for
 * each company-card expense, preventing an Amex receipt from matching a same-
 * amount Capital One charge.
 */
export function matchQboPurchases(expenses, purchases, paymentAccountMap, {
  windowDays = 5,
} = {}) {
  const normalized = (purchases || []).map((purchase) => (
    purchase?.amount != null ? purchase : normalizeQboPurchase(purchase)
  )).filter((purchase) => purchase.id && purchase.amount > 0);
  const eligible = (expenses || []).filter((expense) => (
    expense?.status === 'approved'
    && expense.paidWith
    && expense.paidWith !== 'personal'
    && !expense.qbTransactionId
  ));
  const candidates = [];
  const unmapped = [];

  for (const expense of eligible) {
    const account = paymentAccountMap?.[expense.paidWith];
    if (!account?.id) {
      unmapped.push({ expense, reason: `Map ${expense.paidWith} to a QuickBooks credit-card account` });
      continue;
    }
    for (const purchase of normalized) {
      const match = score(expense, purchase, account.id, windowDays);
      if (match) candidates.push({ expense, purchase, ...match });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const expenseIds = new Set();
  const purchaseIds = new Set();
  const matched = [];
  for (const candidate of candidates) {
    if (expenseIds.has(candidate.expense.id) || purchaseIds.has(candidate.purchase.id)) continue;
    expenseIds.add(candidate.expense.id);
    purchaseIds.add(candidate.purchase.id);
    matched.push(candidate);
  }

  return {
    matched,
    unmatchedExpenses: eligible.filter((expense) => !expenseIds.has(expense.id)),
    unmatchedPurchases: normalized.filter((purchase) => !purchaseIds.has(purchase.id)),
    unmapped,
    stats: {
      matched: matched.length,
      unmatchedExpenses: eligible.length - matched.length,
      unmatchedPurchases: normalized.length - matched.length,
      matchedTotal: round2(matched.reduce((sum, item) => sum + money(item.purchase.amount), 0)),
    },
  };
}

export function qboLinkPatch(match, caller, companyId) {
  const now = Date.now();
  return {
    status: 'synced',
    syncedAt: now,
    syncedBy: caller.uid,
    syncedByName: caller.name,
    qbTransactionId: match.purchase.id,
    qbEntityType: 'Purchase',
    qbCompanyId: companyId,
    qbLinkMode: 'linked',
    qboReconciledAt: now,
    qboAccountRef: {
      id: match.purchase.accountId,
      name: match.purchase.accountName,
    },
    qboTxnDate: match.purchase.txnDate,
    qboTotalAmt: match.purchase.amount,
    qboVendorName: match.purchase.vendorName,
    qboMatchScore: match.score,
    qboMatchedBy: caller.uid,
    qboMatchedByName: caller.name,
  };
}
