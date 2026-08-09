import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CreditCard,
  DollarSign,
  FileText,
  Landmark,
  Loader2,
  PlugZap,
  RefreshCw,
  Receipt,
  Scale,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  StatusChip,
  cx,
} from './ui.jsx';
import { matchQboPurchases } from './qbo-reconciliation.js';
import { qboSyncEligibility } from './qbo-expense.js';
import { reportNumber, reportSections } from './qbo-report.js';

const ExpenseAccountingLazy = lazy(() => import('./ExpenseAccounting.jsx'));
const QuickBooksWorkspaceLazy = lazy(() => import('./QuickBooksWorkspace.jsx'));

function money(value) {
  return Number(value || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

function monthRange(key) {
  const [year, month] = key.split('-').map(Number);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0);
  const end = `${year}-${String(month).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
  return { start, end };
}

function Metric({ icon: Icon, label, value, detail, tone = 'neutral' }) {
  const color = {
    success: 'text-success',
    danger: 'text-danger',
    warning: 'text-warning',
    accent: 'text-accent',
    neutral: 'text-content',
  }[tone];
  return (
    <Card>
      <div className="flex items-center gap-2 text-2xs text-content-muted">
        <Icon className="h-4 w-4" /> {label}
      </div>
      <p className={cx('mt-2 font-mono text-2xl font-semibold tabular-nums', color)}>{value}</p>
      <p className="mt-1 text-2xs text-content-subtle">{detail}</p>
    </Card>
  );
}

function ReportTable({ title, report }) {
  const sections = reportSections(report);
  return (
    <Card padded={false}>
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-semibold text-content">{title}</h2>
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        {sections.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-content-muted">No report rows returned.</p>
        ) : sections.map((section) => (
          <div key={section.title}>
            <p className="border-b border-edge bg-surface-sunken px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-content-subtle">
              {section.title}
            </p>
            {section.rows.map((row, index) => (
              <div
                key={`${row.label}-${index}`}
                className={cx(
                  'flex items-center justify-between gap-3 border-b border-edge px-4 py-2 last:border-b-0',
                  row.summary && 'bg-surface-raised font-semibold',
                )}
              >
                <span className="truncate text-xs text-content-muted">{row.label}</span>
                <span className="font-mono text-xs tabular-nums text-content">
                  {row.value || '—'}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Accounting({ currentUser, users = [] }) {
  const [expenses, setExpenses] = useState([]);
  const [tab, setTab] = useState('overview');
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unsub = null;
    let cancelled = false;
    (async () => {
      const module = await import('./firebase-expenses.js');
      if (cancelled) return;
      unsub = module.subscribeToAllExpenses((list) => !cancelled && setExpenses(list || []));
    })().catch((err) => setError(err.message || 'Could not load expenses'));
    return () => { cancelled = true; if (unsub) unsub(); };
  }, []);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const range = monthRange(month);
      const result = await qboApi('/api/quickbooks-accounting-data', {
        startDate: range.start,
        endDate: range.end,
        accountingMethod: 'Accrual',
      });
      setData(result);
    } catch (err) {
      setError(err.message || 'Could not load QuickBooks accounting data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = data?.connected === true;
  const linkedTransactionIds = useMemo(
    () => new Set(expenses.map((expense) => String(expense.qbTransactionId || '')).filter(Boolean)),
    [expenses],
  );
  const availablePurchases = useMemo(
    () => (data?.purchases || []).filter((purchase) => !linkedTransactionIds.has(String(purchase.id))),
    [data?.purchases, linkedTransactionIds],
  );
  const effectivePaymentMap = useMemo(() => {
    const mapped = { ...(data?.paymentAccountMap || {}) };
    const cards = data?.cardAccounts || [];
    const infer = (key, terms) => {
      if (mapped[key]?.id) return;
      const account = cards.find((card) => terms.some((term) => card.name.toLowerCase().includes(term)));
      if (account) mapped[key] = { id: account.id, name: account.name };
    };
    infer('amex', ['amex', 'american express']);
    infer('capital_one', ['capital one', 'capitalone']);
    return mapped;
  }, [data?.paymentAccountMap, data?.cardAccounts]);
  const matching = useMemo(() => matchQboPurchases(
    expenses,
    availablePurchases,
    effectivePaymentMap,
  ), [expenses, availablePurchases, effectivePaymentMap]);
  const personalBills = useMemo(
    () => expenses.filter((expense) => qboSyncEligibility(expense).eligible),
    [expenses],
  );

  const pnl = data?.reports?.profitAndLoss;
  const balance = data?.reports?.balanceSheet;
  const income = reportNumber(pnl, ['Total Income', 'Income']);
  const totalExpenses = reportNumber(pnl, ['Total Expenses', 'Expenses']);
  const netIncome = reportNumber(pnl, ['Net Income', 'Net Operating Income']);
  const totalAssets = reportNumber(balance, ['Total Assets']);
  const totalLiabilities = reportNumber(balance, ['Total Liabilities']);
  const openBills = (data?.bills || []).filter((bill) => bill.balance > 0);

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { buildOAuthStartUrl } = await import('./firebase-quickbooks.js');
      window.location.href = await buildOAuthStartUrl();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not connect QuickBooks' });
      setBusy(false);
    }
  };

  const confirmLinks = async () => {
    if (!matching.matched.length) return;
    if (!window.confirm(`Link ${matching.matched.length} receipt${matching.matched.length === 1 ? '' : 's'} to the proposed QuickBooks card charges?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await qboApi('/api/quickbooks-link-expenses', {
        links: matching.matched.map((item) => ({
          expenseId: item.expense.id,
          purchaseId: item.purchase.id,
        })),
      });
      setMessage({
        tone: result.failed ? 'danger' : 'success',
        text: result.failed
          ? `${result.succeeded} linked; ${result.failed} failed. ${result.results?.find((item) => !item.ok)?.error || ''}`
          : `${result.succeeded} receipt${result.succeeded === 1 ? '' : 's'} linked to QuickBooks card charges.`,
      });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not link QuickBooks charges' });
    } finally {
      setBusy(false);
    }
  };

  const syncPersonal = async () => {
    if (!personalBills.length) return;
    if (!window.confirm(`Create ${personalBills.length} reimbursement Bill${personalBills.length === 1 ? '' : 's'} in QuickBooks?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await qboApi('/api/quickbooks-sync-expenses', {
        expenseIds: personalBills.map((expense) => expense.id),
      });
      setMessage({
        tone: result.failed ? 'danger' : 'success',
        text: `${result.succeeded} reimbursement Bill${result.succeeded === 1 ? '' : 's'} synced${result.failed ? `; ${result.failed} failed` : ''}.`,
      });
      await load();
    } catch (err) {
      setMessage({ tone: 'danger', text: err.message || 'Could not sync reimbursements' });
    } finally {
      setBusy(false);
    }
  };

  if (!['accounting', 'admin'].includes(currentUser?.role)) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken">
      <div className="shrink-0 border-b border-edge bg-surface px-4 py-4 md:px-6">
        <div className="mx-auto max-w-screen-2xl">
          <PageHeader
            title="Accounting"
            subtitle={connected
              ? `Live from ${data.companyName || 'QuickBooks Online'} · ${data.environment || 'sandbox'}`
              : 'QuickBooks Online financial reporting, card matching and expense exports'}
            actions={(
              <>
                <label className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2">
                  <span className="text-2xs text-content-muted">Period</span>
                  <input
                    type="month"
                    value={month}
                    onChange={(event) => setMonth(event.target.value)}
                    className="bg-transparent font-mono text-xs text-content outline-none"
                  />
                </label>
                <Button variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>Refresh QBO</Button>
              </>
            )}
          />
          <div className="flex gap-1 overflow-x-auto">
            {[
              ['overview', 'Overview', TrendingUp],
              ['invoices', 'Invoices & A/R', DollarSign],
              ['customers', 'Customers', Users],
              ['cards', 'Credit cards', CreditCard],
              ['expenses', 'Receipt matching', Receipt],
              ['reports', 'Reports', FileText],
              ['setup', 'Connection & export', PlugZap],
            ].map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cx(
                  'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold',
                  tab === id ? 'bg-accent-soft text-accent' : 'text-content-muted hover:bg-surface-raised hover:text-content',
                )}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-screen-2xl space-y-4">
          {message && (
            <div className={cx(
              'flex items-start gap-2 rounded-lg border p-3 text-sm',
              message.tone === 'success'
                ? 'border-success-border bg-success-soft text-success'
                : 'border-danger-border bg-danger-soft text-danger',
            )}>
              {message.tone === 'success'
                ? <Check className="mt-0.5 h-4 w-4 shrink-0" />
                : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
              {message.text}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-3 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {!loading && !connected ? (
            <Card className="mx-auto max-w-xl text-center">
              <Landmark className="mx-auto h-10 w-10 text-content-subtle" />
              <h2 className="mt-3 text-lg font-semibold text-content">Connect QuickBooks Online</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-content-muted">
                Connect the company to load financial reports, linked credit-card accounts, posted transactions and reimbursement Bills.
              </p>
              <Button className="mt-4" variant="primary" icon={PlugZap} onClick={connect} loading={busy}>
                Connect QuickBooks
              </Button>
            </Card>
          ) : loading && !data ? (
            <div className="flex items-center justify-center py-24 text-content-muted">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading QuickBooks…
            </div>
          ) : (
            <>
              {data?.bankingFeedLimitation && tab !== 'setup' && (
                <div className="flex items-start gap-2 rounded-lg border border-info-border bg-info-soft p-3 text-2xs text-info">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {data.bankingFeedLimitation}
                </div>
              )}

              {tab === 'overview' && (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <Metric icon={DollarSign} label="Income" value={money(income)} detail="P&L · period" tone="success" />
                    <Metric icon={Receipt} label="Expenses" value={money(totalExpenses)} detail="P&L · period" tone="warning" />
                    <Metric icon={TrendingUp} label="Net income" value={money(netIncome)} detail="Accrual basis" tone={netIncome >= 0 ? 'success' : 'danger'} />
                    <Metric icon={Landmark} label="Total assets" value={money(totalAssets)} detail="Balance sheet" tone="accent" />
                    <Metric icon={Scale} label="Liabilities" value={money(totalLiabilities)} detail="Balance sheet" />
                    <Metric icon={FileText} label="Open bills" value={money(openBills.reduce((sum, bill) => sum + bill.balance, 0))} detail={`${openBills.length} unpaid bill${openBills.length === 1 ? '' : 's'}`} tone={openBills.length ? 'warning' : 'success'} />
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    <ReportTable title="Profit & Loss" report={pnl} />
                    <ReportTable title="Balance Sheet" report={balance} />
                  </div>
                </>
              )}

              {(tab === 'invoices' || tab === 'customers') && (
                <Suspense fallback={(
                  <div className="flex items-center justify-center py-16 text-content-muted">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading QuickBooks…
                  </div>
                )}>
                  <QuickBooksWorkspaceLazy view={tab === 'customers' ? 'customers' : 'invoices'} />
                </Suspense>
              )}

              {tab === 'cards' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(18rem,0.7fr)_minmax(0,1.3fr)]">
                  <Card padded={false}>
                    <CardHeader title="Linked credit-card accounts" subtitle="From the QBO chart of accounts" icon={CreditCard} className="p-4 pb-2" />
                    <div className="border-t border-edge">
                      {(data?.cardAccounts || []).length === 0 ? (
                        <EmptyState icon={CreditCard} title="No QBO credit cards found" description="Add or connect a Credit Card account in QuickBooks first." />
                      ) : data.cardAccounts.map((account) => (
                        <div key={account.id} className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3 last:border-b-0">
                          <div>
                            <p className="text-sm font-semibold text-content">{account.name}</p>
                            <p className="text-2xs text-content-muted">{account.subtype || account.type}</p>
                          </div>
                          <span className="font-mono text-sm font-semibold tabular-nums text-content">{money(account.currentBalance)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                  <Card padded={false}>
                    <CardHeader title="Posted card purchases" subtitle={`${availablePurchases.length} unlinked this period`} icon={Receipt} className="p-4 pb-2" />
                    <div className="max-h-[36rem] overflow-y-auto border-t border-edge">
                      {availablePurchases.length === 0 ? (
                        <EmptyState icon={Check} title="No unlinked posted charges" />
                      ) : availablePurchases.map((purchase) => (
                        <div key={purchase.id} className="flex items-center gap-3 border-b border-edge px-4 py-3 last:border-b-0">
                          <StatusChip tone="neutral" size="sm">{purchase.accountName || 'Card'}</StatusChip>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-content">{purchase.vendorName || purchase.privateNote || 'Card purchase'}</p>
                            <p className="text-2xs text-content-muted">{purchase.txnDate} · QBO #{purchase.id}</p>
                          </div>
                          <span className="font-mono text-sm font-semibold tabular-nums text-content">{money(purchase.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              )}

              {tab === 'expenses' && (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.6fr)]">
                  <Card padded={false}>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-3">
                      <div>
                        <h2 className="text-sm font-semibold text-content">Proposed QBO card matches</h2>
                        <p className="mt-0.5 text-2xs text-content-muted">
                          Exact amount · ±5 days · mapped card account · vendor corroboration
                        </p>
                      </div>
                      <Button variant="primary" icon={ArrowRight} onClick={confirmLinks} loading={busy} disabled={!matching.matched.length}>
                        Link {matching.matched.length || ''} matches
                      </Button>
                    </div>
                    {matching.matched.length === 0 ? (
                      <EmptyState icon={Receipt} title="No proposed matches" description="Post card transactions in QBO and map each linked card under Connection & export." />
                    ) : (
                      <div className="max-h-[38rem] overflow-y-auto">
                        {matching.matched.map((item) => (
                          <div key={item.expense.id} className="grid gap-2 border-b border-edge px-4 py-3 last:border-b-0 md:grid-cols-[1fr_auto_1fr_auto] md:items-center">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-content">{item.expense.vendor || 'Receipt'}</p>
                              <p className="text-2xs text-content-muted">{item.expense.authorName || 'Crew'} · {item.expense.transactionDate || 'no date'}</p>
                            </div>
                            <ArrowRight className="hidden h-4 w-4 text-content-subtle md:block" />
                            <div className="min-w-0">
                              <p className="truncate text-sm text-content">{item.purchase.vendorName || 'QBO purchase'}</p>
                              <p className="text-2xs text-content-muted">{item.purchase.accountName} · {item.purchase.txnDate}</p>
                            </div>
                            <div className="text-right">
                              <p className="font-mono text-sm font-semibold tabular-nums text-content">{money(item.purchase.amount)}</p>
                              <StatusChip tone={item.score >= 115 ? 'success' : 'info'} size="sm">Score {item.score}</StatusChip>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <div className="space-y-4">
                    <Card>
                      <CardHeader title="Unmatched receipts" icon={AlertTriangle} />
                      <p className="font-mono text-2xl font-semibold text-warning">{matching.stats.unmatchedExpenses}</p>
                      <p className="mt-1 text-2xs text-content-muted">
                        {matching.unmapped.length} require a card-account mapping. Others need the charge posted in QBO or receipt correction.
                      </p>
                    </Card>
                    <Card>
                      <CardHeader title="Personal reimbursements" icon={FileText} />
                      <p className="font-mono text-2xl font-semibold text-content">{personalBills.length}</p>
                      <p className="mt-1 text-2xs text-content-muted">Approved personal charges ready to create as Bills.</p>
                      <Button className="mt-3" block variant="secondary" onClick={syncPersonal} loading={busy} disabled={!personalBills.length}>
                        Create reimbursement Bills
                      </Button>
                    </Card>
                  </div>
                </div>
              )}

              {tab === 'reports' && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <ReportTable title="Profit & Loss" report={pnl} />
                  <ReportTable title="Balance Sheet" report={balance} />
                </div>
              )}

              {tab === 'setup' && (
                <Suspense fallback={<div className="flex items-center justify-center py-16 text-content-muted"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading accounting setup…</div>}>
                  <ExpenseAccountingLazy expenses={expenses} users={users} currentUser={currentUser} />
                </Suspense>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
