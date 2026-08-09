import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  DollarSign,
  ExternalLink,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { Button, Card, CardHeader, EmptyState, StatusChip, cx } from './ui.jsx';
import { agingBuckets } from './qbo-invoice.js';

function money(value) {
  return Number(value || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const today = () => new Date().toISOString().slice(0, 10);

async function workspaceApi(action, body = {}) {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Your accounting session expired');
  const response = await fetch('/api/quickbooks-workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken, action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `QuickBooks request failed (${response.status})`);
  return data;
}

/** Link straight into the same record in QuickBooks Online. */
function qboLink(environment, realmId, entity, id) {
  const host = environment === 'sandbox' ? 'https://sandbox.qbo.intuit.com' : 'https://qbo.intuit.com';
  return `${host}/app/${entity}?txnId=${encodeURIComponent(id)}&companyId=${encodeURIComponent(realmId || '')}`;
}

const STATUS_TONE = { paid: 'success', overdue: 'danger', open: 'warning' };

function InvoiceForm({ customers, items, onClose, onCreated }) {
  const [customerId, setCustomerId] = useState('');
  const [email, setEmail] = useState('');
  const [txnDate, setTxnDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ itemId: '', description: '', quantity: 1, unitPrice: 0 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const total = lines.reduce(
    (sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0),
    0,
  );

  const setLine = (index, patch) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await workspaceApi('createInvoice', {
        customerId, lines, txnDate, dueDate: dueDate || undefined, email: email || undefined, memo,
      });
      onCreated(data.invoice);
      onClose();
    } catch (err) {
      setError(err.message || 'Invoice could not be created');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <Card className="my-8 w-full max-w-3xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-content">New invoice</h2>
          <button type="button" onClick={onClose} className="text-content-subtle hover:text-content">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Customer</span>
            <select
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                const found = customers.find((customer) => customer.id === event.target.value);
                if (found?.email && !email) setEmail(found.email);
              }}
              className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
            >
              <option value="">Select a customer…</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Email invoice to</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="billing@broker.com"
              className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
            />
          </label>
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Invoice date</span>
            <input type="date" value={txnDate} onChange={(event) => setTxnDate(event.target.value)}
              className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content" />
          </label>
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Due date</span>
            <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)}
              className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content" />
          </label>
        </div>

        <div className="mt-4">
          <p className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Lines</p>
          <div className="mt-2 space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_5rem_7rem_2rem]">
                <select
                  value={line.itemId}
                  onChange={(event) => {
                    const item = items.find((candidate) => candidate.id === event.target.value);
                    setLine(index, {
                      itemId: event.target.value,
                      unitPrice: item?.unitPrice || line.unitPrice,
                      description: line.description || item?.name || '',
                    });
                  }}
                  className="min-w-0 rounded-lg border border-edge bg-surface-sunken px-2 py-2 text-xs text-content"
                >
                  <option value="">Product / service…</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <input
                  value={line.description}
                  onChange={(event) => setLine(index, { description: event.target.value })}
                  placeholder="Description"
                  className="min-w-0 rounded-lg border border-edge bg-surface-sunken px-2 py-2 text-xs text-content"
                />
                <input
                  type="number" min="0" step="0.01" value={line.quantity}
                  onChange={(event) => setLine(index, { quantity: event.target.value })}
                  className="min-w-0 rounded-lg border border-edge bg-surface-sunken px-2 py-2 text-right font-mono text-xs text-content"
                />
                <input
                  type="number" min="0" step="0.01" value={line.unitPrice}
                  onChange={(event) => setLine(index, { unitPrice: event.target.value })}
                  className="min-w-0 rounded-lg border border-edge bg-surface-sunken px-2 py-2 text-right font-mono text-xs text-content"
                />
                <button
                  type="button"
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  disabled={lines.length === 1}
                  className="text-content-subtle hover:text-danger disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <Button
            className="mt-2" size="sm" variant="secondary" icon={Plus}
            onClick={() => setLines((current) => [...current, { itemId: '', description: '', quantity: 1, unitPrice: 0 }])}
          >
            Add line
          </Button>
        </div>

        <label className="mt-4 block">
          <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Memo</span>
          <textarea
            value={memo} onChange={(event) => setMemo(event.target.value)} rows={2}
            className="mt-1 w-full resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
          />
        </label>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-2.5 text-xs text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-3 border-t border-edge pt-3">
          <span className="text-sm text-content-muted">Total</span>
          <span className="font-mono text-lg font-semibold tabular-nums text-content">{money(total)}</span>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!customerId} onClick={submit}>
              Create in QuickBooks
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function PaymentForm({ invoice, depositAccounts, onClose, onRecorded }) {
  const [amount, setAmount] = useState(String(invoice.balance.toFixed(2)));
  const [txnDate, setTxnDate] = useState(today);
  const [depositAccountId, setDepositAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await workspaceApi('recordPayment', {
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        amount: Number(amount),
        txnDate,
        depositAccountId: depositAccountId || undefined,
      });
      onRecorded(data.invoice);
      onClose();
    } catch (err) {
      setError(err.message || 'Payment could not be recorded');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-content">Receive payment</h2>
          <button type="button" onClick={onClose} className="text-content-subtle hover:text-content">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-1 text-2xs text-content-muted">
          Invoice {invoice.docNumber || invoice.id} · {invoice.customerName} · balance {money(invoice.balance)}
        </p>
        <label className="mt-4 block">
          <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Amount</span>
          <input
            type="number" min="0" step="0.01" value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-right font-mono text-sm text-content"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Payment date</span>
          <input type="date" value={txnDate} onChange={(event) => setTxnDate(event.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content" />
        </label>
        <label className="mt-3 block">
          <span className="text-2xs font-semibold uppercase tracking-wider text-content-subtle">Deposit to</span>
          <select value={depositAccountId} onChange={(event) => setDepositAccountId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content">
            <option value="">Undeposited funds (QuickBooks default)</option>
            {depositAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
        </label>
        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-2.5 text-xs text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={DollarSign} loading={busy} onClick={submit}>Record payment</Button>
        </div>
      </Card>
    </div>
  );
}

export default function QuickBooksWorkspace({ view = 'invoices' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('open');
  const [composing, setComposing] = useState(false);
  const [paying, setPaying] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [newCustomer, setNewCustomer] = useState({ name: '', email: '', phone: '' });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await workspaceApi('overview'));
    } catch (err) {
      setError(err.message || 'Could not load QuickBooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const invoices = data?.invoices || [];
  const aging = useMemo(() => data?.aging || agingBuckets(invoices), [data, invoices]);
  const visibleInvoices = useMemo(() => {
    if (filter === 'all') return invoices;
    return invoices.filter((invoice) => invoice.status === filter);
  }, [invoices, filter]);

  const replaceInvoice = (updated) => {
    if (!updated?.id) return;
    setData((current) => {
      if (!current) return current;
      const exists = current.invoices.some((invoice) => invoice.id === updated.id);
      const invoices = exists
        ? current.invoices.map((invoice) => (invoice.id === updated.id ? updated : invoice))
        : [updated, ...current.invoices];
      return { ...current, invoices, aging: agingBuckets(invoices) };
    });
  };

  const sendInvoice = async (invoice) => {
    setSendingId(invoice.id);
    setError('');
    setNotice('');
    try {
      const result = await workspaceApi('sendInvoice', { invoiceId: invoice.id, email: invoice.email || undefined });
      replaceInvoice(result.invoice);
      setNotice(`Invoice ${invoice.docNumber || invoice.id} emailed from QuickBooks.`);
    } catch (err) {
      setError(err.message || 'QuickBooks could not send the invoice');
    } finally {
      setSendingId(null);
    }
  };

  const addCustomer = async () => {
    setCreatingCustomer(true);
    setError('');
    try {
      const result = await workspaceApi('createCustomer', newCustomer);
      setData((current) => current && {
        ...current,
        customers: [result.customer, ...current.customers.filter((c) => c.id !== result.customer.id)],
      });
      setNotice(result.existing ? 'Customer already existed in QuickBooks.' : `Added ${result.customer.name}.`);
      setNewCustomer({ name: '', email: '', phone: '' });
    } catch (err) {
      setError(err.message || 'Customer could not be created');
    } finally {
      setCreatingCustomer(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-24 text-content-muted">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading QuickBooks…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data?.environmentMismatch && (
        <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          This company is connected in <strong>{data.environment}</strong> mode but the server is set to{' '}
          <strong>{data.serverEnvironment}</strong>. Disconnect and reconnect QuickBooks so live books are used.
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-success-border bg-success-soft p-3 text-xs text-success">
          <Check className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-3 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {view === 'customers' ? (
        <Card padded={false}>
          <CardHeader
            title="Customers"
            subtitle="Live from QuickBooks. New customers are created straight in the company file."
            icon={UserPlus}
            className="p-4 pb-2"
          />
          <div className="grid gap-2 border-t border-edge p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
            <input
              value={newCustomer.name}
              onChange={(event) => setNewCustomer((c) => ({ ...c, name: event.target.value }))}
              placeholder="Customer / broker name"
              className="rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
            />
            <input
              value={newCustomer.email}
              onChange={(event) => setNewCustomer((c) => ({ ...c, email: event.target.value }))}
              placeholder="Billing email"
              className="rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
            />
            <input
              value={newCustomer.phone}
              onChange={(event) => setNewCustomer((c) => ({ ...c, phone: event.target.value }))}
              placeholder="Phone"
              className="rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
            />
            <Button variant="primary" icon={Plus} loading={creatingCustomer} disabled={!newCustomer.name.trim()} onClick={addCustomer}>
              Add
            </Button>
          </div>
          <div className="border-t border-edge">
            {(data?.customers || []).length === 0 ? (
              <EmptyState icon={UserPlus} title="No customers in QuickBooks yet" />
            ) : data.customers.map((customer) => (
              <div key={customer.id} className="flex items-center gap-3 border-b border-edge px-4 py-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-content">{customer.name}</span>
                  <span className="block truncate text-2xs text-content-subtle">
                    {customer.email || 'No email'}{customer.phone ? ` · ${customer.phone}` : ''}
                  </span>
                </span>
                <span className="font-mono text-xs tabular-nums text-content-muted">{money(customer.balance)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              ['Open A/R', aging.total, 'accent'],
              ['Current', aging.current, 'success'],
              ['1–30 late', aging.d1to30, 'warning'],
              ['31–60 late', aging.d31to60, 'warning'],
              ['61–90 late', aging.d61to90, 'danger'],
              ['90+ late', aging.d90plus, 'danger'],
            ].map(([label, value, tone]) => (
              <Card key={label}>
                <p className="text-2xs text-content-muted">{label}</p>
                <p className={cx(
                  'mt-1 font-mono text-xl font-semibold tabular-nums',
                  { accent: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone],
                )}>
                  {money(value)}
                </p>
              </Card>
            ))}
          </div>

          <Card padded={false}>
            <div className="flex flex-wrap items-center gap-2 border-b border-edge p-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-content">Invoices</h2>
                <p className="text-2xs text-content-muted">
                  Created, emailed and paid directly in {data?.companyName || 'QuickBooks'}
                </p>
              </div>
              <div className="flex gap-1">
                {['open', 'overdue', 'paid', 'all'].map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={cx(
                      'rounded-lg px-2.5 py-1.5 text-2xs font-semibold capitalize',
                      filter === id ? 'bg-accent-soft text-accent' : 'text-content-muted hover:bg-surface-raised',
                    )}
                  >
                    {id}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>Refresh</Button>
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setComposing(true)}>New invoice</Button>
            </div>
            <div className="overflow-x-auto">
              {visibleInvoices.length === 0 ? (
                <EmptyState icon={DollarSign} title={`No ${filter === 'all' ? '' : filter} invoices`} />
              ) : (
                <table className="w-full min-w-[52rem] text-left">
                  <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-content-subtle">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Invoice</th>
                      <th className="px-4 py-2 font-semibold">Customer</th>
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Due</th>
                      <th className="px-4 py-2 text-right font-semibold">Total</th>
                      <th className="px-4 py-2 text-right font-semibold">Balance</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-t border-edge">
                        <td className="px-4 py-2 font-mono text-xs text-content">{invoice.docNumber || invoice.id}</td>
                        <td className="px-4 py-2 text-xs text-content">{invoice.customerName}</td>
                        <td className="px-4 py-2 font-mono text-2xs text-content-muted">{invoice.date}</td>
                        <td className="px-4 py-2 font-mono text-2xs text-content-muted">{invoice.dueDate || '—'}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-content">{money(invoice.total)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-content">{money(invoice.balance)}</td>
                        <td className="px-4 py-2">
                          <StatusChip tone={STATUS_TONE[invoice.status] || 'neutral'} size="sm">{invoice.status}</StatusChip>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm" variant="ghost" icon={Mail}
                              loading={sendingId === invoice.id}
                              onClick={() => sendInvoice(invoice)}
                            >
                              Email
                            </Button>
                            {invoice.balance > 0.005 && (
                              <Button size="sm" variant="secondary" icon={DollarSign} onClick={() => setPaying(invoice)}>
                                Pay
                              </Button>
                            )}
                            {data?.realmId && (
                              <a
                                href={qboLink(data.environment, data.realmId, 'invoice', invoice.id)}
                                target="_blank"
                                rel="noreferrer"
                                title="Open in QuickBooks Online"
                                className="rounded p-1.5 text-content-subtle hover:text-accent"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </>
      )}

      {composing && (
        <InvoiceForm
          customers={data?.customers || []}
          items={data?.items || []}
          onClose={() => setComposing(false)}
          onCreated={(invoice) => {
            replaceInvoice(invoice);
            setNotice(`Invoice ${invoice.docNumber || invoice.id} created in QuickBooks.`);
          }}
        />
      )}
      {paying && (
        <PaymentForm
          invoice={paying}
          depositAccounts={data?.depositAccounts || []}
          onClose={() => setPaying(null)}
          onRecorded={(invoice) => {
            replaceInvoice(invoice);
            setNotice('Payment recorded in QuickBooks.');
          }}
        />
      )}
    </div>
  );
}
