// Pure helpers for exporting expenses as QuickBooks-ready reports. Nothing here
// touches Firestore or the DOM, so the money math and CSV shape can be tested
// directly. The UI layer supplies already-fetched expense documents.

// Default chart-of-accounts mapping. QuickBooks matches imported rows to an
// expense account by name, so these must line up with the connected company's
// chart of accounts. Administrators can override any of these from settings;
// this map is only the starting point for a charter operation.
export const DEFAULT_QBO_ACCOUNTS = Object.freeze({
  Fuel: 'Fuel',
  Catering: 'Catering & Onboard',
  'FBO Fees': 'FBO & Handling',
  Hangar: 'Hangar & Ramp',
  'Ground Transport': 'Ground Transportation',
  'Crew Meals': 'Crew Meals & Per Diem',
  'Crew Lodging': 'Crew Lodging',
  Supplies: 'Supplies',
  Maintenance: 'Aircraft Maintenance',
  Office: 'Office & Administrative',
  Other: 'Ask My Accountant',
});

export function accountForCategory(category, accountMap = DEFAULT_QBO_ACCOUNTS) {
  const key = String(category || '').trim();
  return (accountMap && accountMap[key]) || DEFAULT_QBO_ACCOUNTS[key] || 'Ask My Accountant';
}

/** Parse whatever the receipt parser stored into a real Date, or null. */
export function expenseDate(expense) {
  const raw = expense?.transactionDate;
  if (raw) {
    // Accept ISO (2026-01-15), US (01/15/2026) and full timestamps.
    const iso = /^\d{4}-\d{2}-\d{2}/.test(String(raw));
    const us = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(raw));
    let parsed = null;
    if (iso) parsed = new Date(`${String(raw).slice(0, 10)}T00:00:00`);
    else if (us) {
      const [m, d, y] = String(raw).split('/').map(Number);
      parsed = new Date(y < 100 ? 2000 + y : y, m - 1, d);
    } else {
      const t = new Date(raw);
      if (!Number.isNaN(t.getTime())) parsed = t;
    }
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }
  if (Number.isFinite(expense?.createdAt)) return new Date(expense.createdAt);
  return null;
}

export function monthKeyOf(expense) {
  const date = expenseDate(expense);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(monthKey) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return 'All time';
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function availableMonths(expenses) {
  const keys = new Set();
  for (const expense of expenses || []) {
    const key = monthKeyOf(expense);
    if (key) keys.add(key);
  }
  return [...keys].sort().reverse();
}

function formatUsDate(date) {
  if (!date) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
}

export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function round2(value) {
  return Math.round((money(value) + Number.EPSILON) * 100) / 100;
}

/** The payer/card label as it should appear in QuickBooks. */
export function paymentAccountLabel(expense, cardLabels = {}) {
  const paidWith = String(expense?.paidWith || '').trim();
  if (!paidWith) return expense?.reconciledCardLast4 ? `Card ••${expense.reconciledCardLast4}` : '';
  return cardLabels[paidWith] || {
    capital_one: 'Capital One',
    amex: 'Amex',
    personal: 'Personal (reimbursable)',
  }[paidWith] || paidWith;
}

/**
 * Only approved/synced expenses are exportable — drafts and pending items are
 * not real charges yet. Reimbursable personal cards are still included; they
 * import to QuickBooks as a bill payable to the crew member.
 */
export function isExportable(expense) {
  return expense?.status === 'approved' || expense?.status === 'synced';
}

export function filterForMonth(expenses, monthKey) {
  const list = (expenses || []).filter(isExportable);
  if (!monthKey) return list;
  return list.filter((expense) => monthKeyOf(expense) === monthKey);
}

/**
 * One import row per expense. Columns are ordered for the QuickBooks Online
 * import mapping wizard (bills/expenses): a human maps each column to a QBO
 * field once, then future imports reuse the mapping.
 */
export function buildQuickBooksRows(expenses, {
  users = [],
  accountMap = DEFAULT_QBO_ACCOUNTS,
  cardLabels = {},
} = {}) {
  const nameByUid = new Map((users || []).map((u) => [u.uid || u.id, u.name || u.email || '']));
  return [...expenses]
    .sort((a, b) => (expenseDate(a)?.getTime() || 0) - (expenseDate(b)?.getTime() || 0))
    .map((expense) => {
      const submitter = expense.authorName || nameByUid.get(expense.uid) || expense.authorEmail || 'Unknown';
      const memoParts = [];
      if (expense.category) memoParts.push(expense.category);
      if (expense.tripUid) memoParts.push(`Trip ${expense.tripUid}`);
      if (expense.notes) memoParts.push(String(expense.notes).replace(/[\r\n]+/g, ' ').trim());
      return {
        Date: formatUsDate(expenseDate(expense)),
        Vendor: expense.vendor || 'Unknown vendor',
        Account: accountForCategory(expense.category, accountMap),
        Amount: round2(expense.totalAmount).toFixed(2),
        Currency: expense.currency || 'USD',
        Memo: memoParts.join(' · '),
        Employee: submitter,
        'Payment Account': paymentAccountLabel(expense, cardLabels),
        'Card Last4': expense.reconciledCardLast4 || '',
        Billable: expense.paidWith === 'personal' ? 'Reimbursable' : 'Company paid',
        Reconciled: expense.qboReconciledAt || expense.qbTransactionId || expense.reconciledAt ? 'Yes' : 'No',
        'Reference No': expense.id || '',
        'Receipt URL': expense.receiptUrl || '',
      };
    });
}

export function summarizeByCategory(expenses, accountMap = DEFAULT_QBO_ACCOUNTS) {
  const totals = new Map();
  for (const expense of expenses) {
    const account = accountForCategory(expense.category, accountMap);
    const key = `${expense.category || 'Other'}||${account}`;
    const entry = totals.get(key) || { category: expense.category || 'Other', account, count: 0, total: 0 };
    entry.count += 1;
    entry.total = round2(entry.total + money(expense.totalAmount));
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

export function summarizeByUser(expenses, users = []) {
  const nameByUid = new Map((users || []).map((u) => [u.uid || u.id, u.name || u.email || '']));
  const totals = new Map();
  for (const expense of expenses) {
    const uid = expense.uid || 'unknown';
    const entry = totals.get(uid) || {
      uid,
      name: expense.authorName || nameByUid.get(uid) || expense.authorEmail || 'Unknown',
      count: 0,
      total: 0,
      reconciled: 0,
    };
    entry.count += 1;
    entry.total = round2(entry.total + money(expense.totalAmount));
    if (expense.qboReconciledAt || expense.qbTransactionId || expense.reconciledAt) entry.reconciled += 1;
    totals.set(uid, entry);
  }
  return [...totals.values()].sort((a, b) => b.total - a.total);
}

export function exportTotal(expenses) {
  return round2((expenses || []).reduce((sum, e) => sum + money(e.totalAmount), 0));
}

/* ── CSV rendering (RFC 4180 + UTF-8 BOM so Excel/QuickBooks read it) ── */

export function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export function exportFilename({ scopeLabel, monthKey }) {
  const scope = String(scopeLabel || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const period = monthKey && /^\d{4}-\d{2}$/.test(monthKey) ? monthKey : 'all-time';
  return `quickbooks-${scope || 'company'}-${period}.csv`;
}
