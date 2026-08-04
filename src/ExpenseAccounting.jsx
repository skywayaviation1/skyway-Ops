import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Check,
  CreditCard,
  Download,
  FileSpreadsheet,
  Link2,
  Loader2,
  Upload,
  User,
} from 'lucide-react';
import { Button, Card, CardHeader, StatusChip, cx } from './ui.jsx';
import {
  availableMonths,
  buildQuickBooksRows,
  exportFilename,
  exportTotal,
  filterForMonth,
  monthLabel,
  rowsToCsv,
  summarizeByCategory,
  summarizeByUser,
} from './expense-export.js';
import {
  parseCardStatement,
  reconcile,
  reconciliationPatch,
} from './card-reconciliation.js';

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function download(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExpenseAccounting({ expenses = [], users = [], currentUser }) {
  const months = useMemo(() => availableMonths(expenses), [expenses]);
  const [monthKey, setMonthKey] = useState(() => months[0] || '');
  const [scopeUid, setScopeUid] = useState('company');
  const actor = currentUser?.name || currentUser?.email || 'accounting';

  const monthExpenses = useMemo(() => filterForMonth(expenses, monthKey || null), [expenses, monthKey]);
  const scopedExpenses = useMemo(() => (
    scopeUid === 'company' ? monthExpenses : monthExpenses.filter((e) => e.uid === scopeUid)
  ), [monthExpenses, scopeUid]);

  const byUser = useMemo(() => summarizeByUser(monthExpenses, users), [monthExpenses, users]);
  const byCategory = useMemo(() => summarizeByCategory(scopedExpenses), [scopedExpenses]);
  const scopeLabel = scopeUid === 'company'
    ? 'Company'
    : (byUser.find((u) => u.uid === scopeUid)?.name || 'Crew member');

  const exportScope = () => {
    const rows = buildQuickBooksRows(scopedExpenses, { users });
    if (rows.length === 0) return;
    download(rowsToCsv(rows), exportFilename({ scopeLabel, monthKey: monthKey || null }));
  };

  const exportUserPack = () => {
    // One combined company CSV; the Employee column lets QuickBooks split by
    // crew member (class/location) on import, so accounting gets both views
    // from a single file.
    const rows = buildQuickBooksRows(monthExpenses, { users });
    if (rows.length === 0) return;
    download(rowsToCsv(rows), exportFilename({ scopeLabel: 'company-itemized', monthKey: monthKey || null }));
  };

  /* ── Card reconciliation ── */
  const fileRef = useRef(null);
  const [statementError, setStatementError] = useState('');
  const [result, setResult] = useState(null);
  const [savingRecon, setSavingRecon] = useState(false);
  const [reconMessage, setReconMessage] = useState(null);

  const onStatementSelected = async (event) => {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    setStatementError('');
    setResult(null);
    setReconMessage(null);
    try {
      const text = await file.text();
      const { charges, error } = parseCardStatement(text);
      if (error) { setStatementError(error); return; }
      // Reconcile against the whole approved population, not just the selected
      // month — a statement can span a month boundary.
      const reconciliation = reconcile(charges, expenses.filter((e) => e.status === 'approved' || e.status === 'synced'));
      setResult(reconciliation);
    } catch (err) {
      setStatementError(err.message || 'Could not read that statement file.');
    }
  };

  const confirmMatches = async () => {
    if (!result?.matched?.length) return;
    setSavingRecon(true);
    setReconMessage(null);
    try {
      const { saveExpense } = await import('./firebase-expenses.js');
      let saved = 0;
      for (const match of result.matched) {
        // eslint-disable-next-line no-await-in-loop
        await saveExpense({ ...match.expense, ...reconciliationPatch(match, actor) });
        saved += 1;
      }
      setReconMessage({ tone: 'success', text: `Reconciled ${saved} charge${saved === 1 ? '' : 's'} to the statement.` });
      setResult(null);
    } catch (err) {
      setReconMessage({ tone: 'danger', text: err.message || 'Could not save reconciliation.' });
    } finally {
      setSavingRecon(false);
    }
  };

  return (
    <div className="space-y-4 p-3 md:p-4">
      {/* Period + scope controls */}
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Month</span>
            <select
              value={monthKey}
              onChange={(e) => setMonthKey(e.target.value)}
              className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
            >
              <option value="">All time</option>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Scope</span>
            <select
              value={scopeUid}
              onChange={(e) => setScopeUid(e.target.value)}
              className="min-w-[12rem] rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
            >
              <option value="company">Whole company</option>
              {byUser.map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
            </select>
          </label>
          <div className="ml-auto flex flex-col items-end">
            <span className="font-mono text-xl font-semibold tabular-nums text-content">{money(exportTotal(scopedExpenses))}</span>
            <span className="text-2xs text-content-muted">{scopedExpenses.length} itemized charge{scopedExpenses.length === 1 ? '' : 's'} · {monthLabel(monthKey)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-edge p-4">
          <Button variant="primary" icon={Download} onClick={exportScope} disabled={scopedExpenses.length === 0}>
            Export {scopeUid === 'company' ? 'company' : 'this crew member'} · QuickBooks CSV
          </Button>
          <Button variant="secondary" icon={FileSpreadsheet} onClick={exportUserPack} disabled={monthExpenses.length === 0}>
            Company itemized (all crew)
          </Button>
        </div>
        <p className="border-t border-edge px-4 py-2 text-2xs leading-relaxed text-content-subtle">
          Rows include Date, Vendor, Account, Amount, Employee, Payment Account and Reference No. In QuickBooks choose
          Import → Bills/Expenses and map each column once; the account names come from the fleet chart of accounts.
        </p>
      </Card>

      {/* Per-crew and per-category breakdown */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card padded={false}>
          <CardHeader title="By crew member" subtitle={monthLabel(monthKey)} icon={User} className="p-4 pb-2" />
          <div className="border-t border-edge">
            {byUser.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-content-muted">No approved charges this period.</p>
            ) : byUser.map((u) => (
              <button
                key={u.uid}
                type="button"
                onClick={() => setScopeUid(u.uid)}
                className={cx(
                  'flex w-full items-center justify-between gap-3 border-b border-edge px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-raised',
                  scopeUid === u.uid && 'bg-accent-soft',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-content">{u.name}</span>
                  <span className="block text-2xs text-content-muted">{u.count} charge{u.count === 1 ? '' : 's'} · {u.reconciled} reconciled</span>
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums text-content">{money(u.total)}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title="By QuickBooks account" subtitle={scopeLabel} icon={Building2} className="p-4 pb-2" />
          <div className="border-t border-edge">
            {byCategory.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-content-muted">Nothing to summarize.</p>
            ) : byCategory.map((c) => (
              <div key={`${c.category}-${c.account}`} className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5 last:border-b-0">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-content">{c.account}</span>
                  <span className="block text-2xs text-content-muted">{c.category} · {c.count} charge{c.count === 1 ? '' : 's'}</span>
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums text-content">{money(c.total)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Credit-card reconciliation */}
      <Card padded={false}>
        <CardHeader
          title="Reconcile with credit-card report"
          subtitle="Upload the card statement CSV to match each charge to an expense."
          icon={CreditCard}
          className="p-4 pb-2"
        />
        <div className="border-t border-edge p-4">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onStatementSelected}
            className="hidden"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={Upload} onClick={() => fileRef.current?.click()}>
              Upload statement CSV
            </Button>
            <span className="text-2xs text-content-subtle">
              Exported from Capital One, Amex or any card portal. Payments and credits are ignored automatically.
            </span>
          </div>
          {statementError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-2.5 text-2xs text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{statementError}
            </div>
          )}
          {reconMessage && (
            <div className={cx(
              'mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-2xs',
              reconMessage.tone === 'success' ? 'border-success-border bg-success-soft text-success' : 'border-danger-border bg-danger-soft text-danger',
            )}>
              {reconMessage.tone === 'success' ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {reconMessage.text}
            </div>
          )}

          {result && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Statement charges', result.stats.chargeCount],
                  ['Matched', result.stats.matchedCount],
                  ['Unmatched charges', result.stats.unmatchedChargeCount],
                  ['Unmatched expenses', result.stats.unmatchedExpenseCount],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-edge bg-surface p-3">
                    <p className="font-mono text-lg font-semibold tabular-nums text-content">{value}</p>
                    <p className="text-2xs text-content-muted">{label}</p>
                  </div>
                ))}
              </div>

              {result.matched.length > 0 && (
                <div className="rounded-lg border border-edge">
                  <div className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Proposed matches</span>
                    <Button size="sm" variant="primary" icon={savingRecon ? Loader2 : Link2} onClick={confirmMatches} loading={savingRecon}>
                      Confirm {result.matched.length} match{result.matched.length === 1 ? '' : 'es'}
                    </Button>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    {result.matched.map((m) => (
                      <div key={m.charge.id} className="flex items-center gap-3 border-b border-edge px-3 py-2 last:border-b-0">
                        <StatusChip tone={m.score >= 115 ? 'success' : 'info'} size="sm">
                          {m.charge.last4 ? `••${m.charge.last4}` : 'match'}
                        </StatusChip>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-content">
                            {m.expense.vendor || 'Expense'} → {m.charge.description || 'statement charge'}
                          </p>
                          <p className="text-2xs text-content-muted">
                            {m.expense.authorName || 'Crew'} · {m.charge.date ? m.charge.date.toISOString().slice(0, 10) : 'no date'}
                          </p>
                        </div>
                        <span className="font-mono text-xs font-semibold tabular-nums text-content">{money(m.charge.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.unmatchedCharges.length > 0 && (
                <div className="rounded-lg border border-warning-border">
                  <div className="border-b border-warning-border bg-warning-soft px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-warning">
                    Charges with no matching expense
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {result.unmatchedCharges.map((c) => (
                      <div key={c.id} className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2 last:border-b-0">
                        <div className="min-w-0">
                          <p className="truncate text-xs text-content">{c.description || 'Charge'}</p>
                          <p className="text-2xs text-content-muted">{c.date ? c.date.toISOString().slice(0, 10) : 'no date'}{c.last4 ? ` · ••${c.last4}` : ''}</p>
                        </div>
                        <span className="font-mono text-xs font-semibold tabular-nums text-warning">{money(c.amount)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="px-3 py-2 text-2xs text-content-subtle">
                    These likely need a receipt from crew, or the charge is not a reimbursable expense.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
