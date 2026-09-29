// Trip-page invoice actions. The AOG drawer has the same approve, decline,
// and mark-paid controls. CFS never sees this.

import React, { useEffect, useState } from 'react';
import { Button } from './ui.jsx';
import { auth } from './firebase.js';

async function opsPost(body) {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch('/api/aog-recovery-ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function AogInvoiceOps({ tripId }) {
  const [invoice, setInvoice] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!tripId) return undefined;
    opsPost({ action: 'invoice-for-trip', tripId })
      .then((data) => { if (!cancelled) setInvoice(data.invoice || null); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [tripId]);

  if (!invoice) {
    return error ? <p className="text-2xs text-danger">{error}</p> : null;
  }

  async function decide(decision) {
    setBusy(true);
    setError('');
    try {
      const data = await opsPost({ action: 'invoice-decide', coverageId: invoice.coverageId, decision });
      setInvoice(data.invoice);
      setNote(decision === 'approve' ? 'Invoice approved. 100% coverage is bound.' : 'Invoice declined. The broker can still pay by card.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function markPaid() {
    setBusy(true);
    setError('');
    try {
      const data = await opsPost({ action: 'invoice-paid', coverageId: invoice.coverageId });
      setInvoice(data.invoice);
      setNote('Premium marked paid on the charter invoice.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full rounded-lg border border-edge bg-surface px-3 py-2">
      <p className="text-xs font-semibold text-content">AOG premium</p>
      <p className="mt-1 text-2xs text-content-muted">Payment: {invoice.paymentLabel || invoice.paymentStatus || '—'}</p>
      {invoice.lineItem && <p className="mt-1 text-2xs text-content-muted">{invoice.lineItem}</p>}
      {invoice.invoiceRequestStatus === 'pending' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy} onClick={() => decide('approve')}>Approve invoice</Button>
          <Button size="sm" variant="danger-outline" loading={busy} onClick={() => decide('decline')}>Decline invoice</Button>
        </div>
      )}
      {invoice.paymentStatus === 'invoice_unpaid' && (
        <Button className="mt-2" size="sm" variant="primary" loading={busy} onClick={markPaid}>Mark premium paid</Button>
      )}
      {note && <p className="mt-1 text-2xs text-success">{note}</p>}
      {error && <p className="mt-1 text-2xs text-danger">{error}</p>}
    </div>
  );
}
