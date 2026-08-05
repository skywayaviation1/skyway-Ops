import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Check,
  CreditCard,
  Download,
  FileSpreadsheet,
  Loader2,
  PlugZap,
  RefreshCw,
  Send,
  Unplug,
  User,
} from 'lucide-react';
import { Button, Card, CardHeader, StatusChip, cx } from './ui.jsx';
import {
  availableMonths,
  buildQuickBooksRows,
  DEFAULT_QBO_ACCOUNTS,
  exportFilename,
  exportTotal,
  filterForMonth,
  monthLabel,
  rowsToCsv,
  summarizeByCategory,
  summarizeByUser,
} from './expense-export.js';
import { qboSyncEligibility } from './qbo-expense.js';

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

async function qboApi(path, body = {}) {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Your accounting session expired');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export default function ExpenseAccounting({ expenses = [], users = [], currentUser }) {
  const months = useMemo(() => availableMonths(expenses), [expenses]);
  const [monthKey, setMonthKey] = useState(() => months[0] || '');
  const [scopeUid, setScopeUid] = useState('company');
  const canManageQbo = ['accounting', 'admin'].includes(currentUser?.role);

  useEffect(() => {
    if (!monthKey && months.length) setMonthKey(months[0]);
  }, [monthKey, months]);

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

  /* ── Direct QuickBooks connection + sync ── */
  const [qbo, setQbo] = useState({ loading: true, connected: false });
  const [qboBusy, setQboBusy] = useState(false);
  const [qboMessage, setQboMessage] = useState(null);
  const [accounts, setAccounts] = useState({ expenseAccounts: [], paymentAccounts: [] });
  const [accountMaps, setAccountMaps] = useState({
    expenseAccountMap: {},
    paymentAccountMap: {},
  });

  const loadQboStatus = async () => {
    setQbo((current) => ({ ...current, loading: true }));
    try {
      const status = await qboApi('/api/quickbooks-status');
      setQbo({ ...status, loading: false });
      setAccountMaps({
        expenseAccountMap: status.expenseAccountMap || {},
        paymentAccountMap: status.paymentAccountMap || {},
      });
      if (status.connected && canManageQbo) {
        try {
          const chart = await qboApi('/api/quickbooks-accounts', { action: 'list' });
          setAccounts({
            expenseAccounts: chart.expenseAccounts || [],
            paymentAccounts: chart.paymentAccounts || [],
          });
        } catch (error) {
          setQboMessage({ tone: 'danger', text: error.message });
        }
      }
    } catch (error) {
      setQbo({ loading: false, connected: false, error: error.message });
    }
  };

  useEffect(() => { loadQboStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connectQbo = async () => {
    setQboBusy(true);
    setQboMessage(null);
    try {
      const { buildOAuthStartUrl } = await import('./firebase-quickbooks.js');
      window.location.href = await buildOAuthStartUrl();
    } catch (error) {
      setQboMessage({ tone: 'danger', text: error.message || 'Could not start QuickBooks connection' });
      setQboBusy(false);
    }
  };

  const disconnectQbo = async () => {
    if (!window.confirm('Disconnect QuickBooks Online? Direct sync will stop until it is connected again.')) return;
    setQboBusy(true);
    setQboMessage(null);
    try {
      const { disconnectQuickBooks } = await import('./firebase-quickbooks.js');
      await disconnectQuickBooks();
      setQbo({ loading: false, connected: false });
      setAccounts({ expenseAccounts: [], paymentAccounts: [] });
      setQboMessage({ tone: 'success', text: 'QuickBooks disconnected.' });
    } catch (error) {
      setQboMessage({ tone: 'danger', text: error.message || 'Could not disconnect QuickBooks' });
    } finally {
      setQboBusy(false);
    }
  };

  const mappedRef = (list, id) => {
    const account = list.find((item) => item.id === id);
    return account ? { id: account.id, name: account.name } : null;
  };

  const saveAccountMappings = async () => {
    setQboBusy(true);
    setQboMessage(null);
    try {
      const result = await qboApi('/api/quickbooks-accounts', {
        action: 'save',
        ...accountMaps,
      });
      setAccountMaps({
        expenseAccountMap: result.expenseAccountMap || {},
        paymentAccountMap: result.paymentAccountMap || {},
      });
      setQboMessage({ tone: 'success', text: 'QuickBooks account mappings saved.' });
    } catch (error) {
      setQboMessage({ tone: 'danger', text: error.message || 'Could not save account mappings' });
    } finally {
      setQboBusy(false);
    }
  };

  const syncCandidates = useMemo(
    () => scopedExpenses.filter((expense) => qboSyncEligibility(expense).eligible),
    [scopedExpenses],
  );
  const blockedSync = useMemo(
    () => scopedExpenses.filter((expense) => (
      expense.status === 'approved' && !expense.qbTransactionId && !qboSyncEligibility(expense).eligible
    )),
    [scopedExpenses],
  );

  const syncToQbo = async () => {
    if (!syncCandidates.length) return;
    if (!window.confirm(`Sync ${syncCandidates.length} charge${syncCandidates.length === 1 ? '' : 's'} directly to ${qbo.companyName || 'QuickBooks'}?`)) return;
    setQboBusy(true);
    setQboMessage(null);
    try {
      const result = await qboApi('/api/quickbooks-sync-expenses', {
        expenseIds: syncCandidates.map((expense) => expense.id),
      });
      const failures = result.results?.filter((item) => !item.ok) || [];
      setQboMessage({
        tone: failures.length ? 'danger' : 'success',
        text: failures.length
          ? `${result.succeeded} synced; ${failures.length} failed. ${failures[0]?.error || ''}`
          : `${result.succeeded} charge${result.succeeded === 1 ? '' : 's'} synced directly to QuickBooks.`,
      });
      await loadQboStatus();
    } catch (error) {
      setQboMessage({ tone: 'danger', text: error.message || 'QuickBooks sync failed' });
    } finally {
      setQboBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-3 md:p-4">
      {/* Direct QuickBooks connection — visible where accounting actually works,
          rather than hidden in the general app settings modal. */}
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <span className={cx(
            'flex h-10 w-10 items-center justify-center rounded-lg',
            qbo.connected ? 'bg-success-soft text-success' : 'bg-surface-raised text-content-muted',
          )}>
            {qbo.loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <PlugZap className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-content">QuickBooks Online</h2>
              <StatusChip tone={qbo.connected ? 'success' : 'neutral'} size="sm">
                {qbo.loading ? 'Checking' : qbo.connected ? 'Connected' : 'Not connected'}
              </StatusChip>
              {qbo.connected && qbo.environment === 'sandbox' && (
                <StatusChip tone="warning" size="sm">Sandbox</StatusChip>
              )}
            </div>
            <p className="mt-1 text-2xs text-content-muted">
              {qbo.connected
                ? `${qbo.companyName || 'QuickBooks company'} · connected by ${qbo.connectedByName || 'accounting'}`
                : 'Connect the company once, then accounting can sync approved charges directly.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={loadQboStatus} disabled={qboBusy}>
              Refresh
            </Button>
            {canManageQbo && !qbo.connected && !qbo.loading && (
              <Button size="sm" variant="primary" icon={PlugZap} onClick={connectQbo} loading={qboBusy}>
                Connect QuickBooks
              </Button>
            )}
            {canManageQbo && qbo.connected && (
              <Button size="sm" variant="outline" icon={Unplug} onClick={disconnectQbo} disabled={qboBusy}>
                Disconnect
              </Button>
            )}
          </div>
        </div>

        {qboMessage && (
          <div className={cx(
            'mx-4 mb-4 flex items-start gap-2 rounded-lg border p-2.5 text-2xs',
            qboMessage.tone === 'success'
              ? 'border-success-border bg-success-soft text-success'
              : 'border-danger-border bg-danger-soft text-danger',
          )}>
            {qboMessage.tone === 'success'
              ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {qboMessage.text}
          </div>
        )}

        {qbo.connected && canManageQbo && (
          <div className="border-t border-edge p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-content">Direct sync for this view</p>
                <p className="mt-0.5 text-2xs text-content-muted">
                  {syncCandidates.length} ready to sync · {blockedSync.length} blocked
                  {blockedSync.length ? ' (company cards link from Accounting → Receipt matching; every charge needs a payment tag)' : ''}
                </p>
              </div>
              <Button
                variant="primary"
                icon={Send}
                loading={qboBusy}
                disabled={!syncCandidates.length}
                onClick={syncToQbo}
              >
                Create {syncCandidates.length || ''} reimbursement Bills
              </Button>
            </div>

            <details className="mt-4 rounded-lg border border-edge">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content">
                Account mappings
              </summary>
              <div className="grid gap-4 border-t border-edge p-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Expense categories</p>
                  {Object.keys(DEFAULT_QBO_ACCOUNTS).map((category) => (
                    <label key={category} className="grid grid-cols-[8rem_1fr] items-center gap-2">
                      <span className="truncate text-2xs text-content-muted">{category}</span>
                      <select
                        value={accountMaps.expenseAccountMap?.[category]?.id || ''}
                        onChange={(event) => setAccountMaps((current) => ({
                          ...current,
                          expenseAccountMap: {
                            ...current.expenseAccountMap,
                            [category]: mappedRef(accounts.expenseAccounts, event.target.value),
                          },
                        }))}
                        className="min-w-0 rounded border border-edge bg-surface px-2 py-1.5 text-xs text-content"
                      >
                        <option value="">Auto: {DEFAULT_QBO_ACCOUNTS[category]}</option>
                        {accounts.expenseAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Company payment accounts</p>
                  {[
                    ['capital_one', 'Capital One'],
                    ['amex', 'Amex'],
                  ].map(([key, label]) => (
                    <label key={key} className="grid grid-cols-[8rem_1fr] items-center gap-2">
                      <span className="text-2xs text-content-muted">{label}</span>
                      <select
                        value={accountMaps.paymentAccountMap?.[key]?.id || ''}
                        onChange={(event) => setAccountMaps((current) => ({
                          ...current,
                          paymentAccountMap: {
                            ...current.paymentAccountMap,
                            [key]: mappedRef(accounts.paymentAccounts, event.target.value),
                          },
                        }))}
                        className="min-w-0 rounded border border-edge bg-surface px-2 py-1.5 text-xs text-content"
                      >
                        <option value="">Auto: {label}</option>
                        {accounts.paymentAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.name}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <Button block size="sm" variant="secondary" onClick={saveAccountMappings} loading={qboBusy}>
                    Save account mappings
                  </Button>
                  <p className="text-2xs leading-relaxed text-content-subtle">
                    Company-card receipts link to Purchases already posted on these QBO card accounts. Personal charges create Bills payable to the crew member.
                  </p>
                </div>
              </div>
            </details>
          </div>
        )}
      </Card>

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

    </div>
  );
}
