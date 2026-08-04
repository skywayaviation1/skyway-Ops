// Pure logic for reconciling company credit-card statements against submitted
// expenses. Accounting uploads the card report (CSV); this module parses it and
// matches each statement charge to an expense by amount, date proximity and —
// when available — the card's last four digits. No Firestore or DOM here.

import { expenseDate, money, round2 } from './expense-export.js';

/* ── CSV parsing (handles quoted fields, commas, CRLF) ── */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((v) => v !== '')) rows.push(row);
  }
  return rows;
}

const DATE_HEADERS = ['transaction date', 'trans date', 'date', 'posted date', 'posting date'];
const DESC_HEADERS = ['description', 'merchant', 'payee', 'name', 'details', 'memo'];
const AMOUNT_HEADERS = ['amount', 'debit', 'charge', 'transaction amount'];
const CARD_HEADERS = ['card no.', 'card number', 'card', 'last 4', 'last four', 'account'];

function findHeader(headers, candidates) {
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  // Fall back to a contains match for banks that prefix column names.
  for (let i = 0; i < lower.length; i += 1) {
    if (candidates.some((candidate) => lower[i].includes(candidate))) return i;
  }
  return -1;
}

export function extractLast4(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

export function parseStatementAmount(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/CR$/i.test(s)) { negative = true; s = s.replace(/CR$/i, '').trim(); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Statements list charges as positive and payments/credits as negative. We
  // reconcile charges, so normalize to a positive magnitude and drop credits.
  return negative ? -round2(n) : round2(n);
}

function parseStatementDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [, mm, dd, yy] = m.map(Number);
    return new Date(yy < 100 ? 2000 + yy : yy, mm - 1, dd);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turn raw statement CSV text into normalized charge lines. Credits/payments
 * (negative amounts) are dropped — only real charges are reconciled.
 */
export function parseCardStatement(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { charges: [], error: 'The statement file has no data rows.' };
  const headers = rows[0];
  const dateIdx = findHeader(headers, DATE_HEADERS);
  const descIdx = findHeader(headers, DESC_HEADERS);
  const amountIdx = findHeader(headers, AMOUNT_HEADERS);
  const cardIdx = findHeader(headers, CARD_HEADERS);
  if (dateIdx === -1 || amountIdx === -1) {
    return { charges: [], error: 'Could not find date and amount columns in this statement.' };
  }

  const charges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cols = rows[i];
    const amount = parseStatementAmount(cols[amountIdx]);
    if (amount == null || amount <= 0) continue; // skip payments/credits
    const date = parseStatementDate(cols[dateIdx]);
    charges.push({
      id: `stmt-${i}`,
      date,
      dateMs: date ? date.getTime() : null,
      description: descIdx !== -1 ? String(cols[descIdx] || '').trim() : '',
      amount,
      last4: cardIdx !== -1 ? extractLast4(cols[cardIdx]) : '',
      raw: cols.join(' | '),
    });
  }
  return { charges, error: charges.length ? null : 'No charge rows were found in the statement.' };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function scoreMatch(charge, expense, windowDays) {
  if (round2(expense.totalAmount) !== charge.amount) return null;
  const eDate = expenseDate(expense);
  let dayGap = 0;
  if (charge.dateMs != null && eDate) {
    dayGap = Math.abs(charge.dateMs - eDate.getTime()) / DAY_MS;
    if (dayGap > windowDays) return null;
  }
  let score = 100 - dayGap * 4;
  // A matching card last-four is strong corroboration.
  const expenseLast4 = expense.reconciledCardLast4 || '';
  if (charge.last4 && expenseLast4 && charge.last4 === expenseLast4) score += 25;
  // Vendor/description overlap adds confidence when present.
  const vendor = String(expense.vendor || '').toLowerCase();
  const desc = String(charge.description || '').toLowerCase();
  if (vendor && desc && (desc.includes(vendor) || vendor.includes(desc.split(' ')[0]))) score += 15;
  return { score, dayGap };
}

/**
 * Greedy one-to-one reconciliation: strongest matches first, each expense and
 * each statement charge used at most once. Returns matched pairs plus the
 * leftovers a human still has to resolve.
 */
export function reconcile(charges, expenses, { windowDays = 5 } = {}) {
  const candidates = [];
  const eligible = (expenses || []).filter((e) => e && (e.status === 'approved' || e.status === 'synced') && !e.reconciledAt);
  for (const charge of charges || []) {
    for (const expense of eligible) {
      const result = scoreMatch(charge, expense, windowDays);
      if (result) candidates.push({ charge, expense, ...result });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedCharges = new Set();
  const usedExpenses = new Set();
  const matched = [];
  for (const candidate of candidates) {
    if (usedCharges.has(candidate.charge.id) || usedExpenses.has(candidate.expense.id)) continue;
    usedCharges.add(candidate.charge.id);
    usedExpenses.add(candidate.expense.id);
    matched.push(candidate);
  }

  const unmatchedCharges = (charges || []).filter((c) => !usedCharges.has(c.id));
  const unmatchedExpenses = eligible.filter((e) => !usedExpenses.has(e.id));
  const alreadyReconciled = (expenses || []).filter((e) => e && e.reconciledAt).length;
  return {
    matched,
    unmatchedCharges,
    unmatchedExpenses,
    stats: {
      chargeCount: (charges || []).length,
      matchedCount: matched.length,
      unmatchedChargeCount: unmatchedCharges.length,
      unmatchedExpenseCount: unmatchedExpenses.length,
      alreadyReconciled,
      matchedTotal: round2(matched.reduce((sum, m) => sum + money(m.charge.amount), 0)),
    },
  };
}

export function reconciliationPatch(match, actor) {
  return {
    reconciledAt: Date.now(),
    reconciledBy: actor || 'accounting',
    reconciledCardLast4: match.charge.last4 || match.expense.reconciledCardLast4 || '',
    statementDescription: match.charge.description || '',
    statementAmount: match.charge.amount,
    statementDate: match.charge.date ? match.charge.date.toISOString().slice(0, 10) : '',
  };
}
