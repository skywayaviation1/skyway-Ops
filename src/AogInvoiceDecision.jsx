// Ops opens this from the invoice-request email. The token approves or
// declines. Nothing here is a CFS page.

import React, { useEffect, useState } from 'react';
import { Button, Card } from './ui.jsx';
import { fmtMoney } from './aog-recovery.js';

function useLink() {
  const params = new URLSearchParams(window.location.search);
  return {
    token: params.get('token') || '',
    decision: params.get('decision') === 'decline' ? 'decline' : 'approve',
  };
}

export default function AogInvoiceDecision() {
  const { token, decision } = useLink();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setError('This invoice link is missing.');
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(`/api/aog-recovery-invoice?token=${encodeURIComponent(token)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'This invoice link is not valid');
        if (!cancelled) setInvoice(data.invoice);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/aog-recovery-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not record the decision');
      setInvoice(data.invoice);
      setDone(decision === 'approve'
        ? 'Approved. 100% coverage is bound and the premium is on the charter invoice, unpaid.'
        : 'Declined. The broker can still pay the premium by card.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const approve = decision === 'approve';
  return (
    <main className="aog-public-sheet sw-sheet bg-surface-sunken text-content">
      <div className="sw-sheet-panel sw-sheet-fill">
        <div className="sw-sheet-body">
          <div className="mx-auto w-full max-w-xl px-4 py-6">
            <img src="/skyway-logo-nav.png" alt="Skyway Aviation" width="148" height="36" className="h-9 w-auto" />
            <p className="mt-4 text-2xs uppercase tracking-[0.16em] text-content-muted">Skyway Aviation</p>
            <h1 className="mt-2 font-serif text-3xl font-semibold leading-tight">{approve ? 'Approve this invoice request' : 'Decline this invoice request'}</h1>
            {loading && <p className="mt-6 text-sm text-content-muted">Loading the request…</p>}
            {error && <p className="mt-6 text-sm text-danger" role="alert">{error}</p>}
            {invoice && (
              <Card className="mt-6">
                <p className="text-sm">Trip {invoice.tripId || '—'}</p>
                <p className="mt-1 text-sm text-content-muted">{[invoice.tail, invoice.route, invoice.datesLabel].filter(Boolean).join(' · ')}</p>
                <p className="mt-3 text-sm">Broker {invoice.brokerCompany || '—'}</p>
                <p className="mt-1 text-sm">Requested by {invoice.requestedByName || '—'}{invoice.requestedByEmail ? ` · ${invoice.requestedByEmail}` : ''}</p>
                <p className="mt-3 text-sm font-semibold">Premium {fmtMoney(invoice.premium)}</p>
                {invoice.lineItem && <p className="mt-1 text-sm">Invoice line: {invoice.lineItem}</p>}
                <p className="mt-3 text-sm">Payment: {invoice.paymentLabel || invoice.paymentStatus || '—'}</p>
                {done && <p className="mt-4 text-sm text-success" role="status">{done}</p>}
                {!done && invoice.invoiceRequestStatus === 'pending' && (
                  <Button className="mt-4" variant={approve ? 'primary' : 'danger-outline'} loading={busy} onClick={submit}>
                    {approve ? 'Approve invoice' : 'Decline invoice'}
                  </Button>
                )}
                {!done && invoice.invoiceRequestStatus === 'approved' && (
                  <p className="mt-4 text-sm">This request is already approved. The premium is on the charter invoice.</p>
                )}
                {!done && invoice.invoiceRequestStatus === 'declined' && (
                  <p className="mt-4 text-sm">This request was already declined. The broker can still pay by card.</p>
                )}
              </Card>
            )}
            <p className="mt-6 text-xs text-content-muted">End of invoice decision</p>
          </div>
        </div>
      </div>
    </main>
  );
}
