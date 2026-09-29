// Trip-page control: ops records 100% coverage as added by Skyway and the
// server sends the CFS bind email. The broker is not charged.

import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from './ui.jsx';
import { auth } from './firebase.js';

function ymd(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export default function AogRecoveryGiftButton({ trip, brokerEmail }) {
  const [open, setOpen] = useState(false);
  const [aircraftType, setAircraftType] = useState(trip?.info?.aircraftType || '');
  const [tripTotal, setTripTotal] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function gift() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/aog-recovery-gift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          tripUid: trip?.uid || '',
          tripId: trip?.info?.tripCode || trip?.info?.tripId || '',
          tail: trip?.info?.tail || '',
          aircraftType,
          routeFrom: trip?.info?.from || '',
          routeTo: trip?.info?.to || '',
          departDate: ymd(trip?.start),
          returnDate: ymd(trip?.end),
          tripTotal,
          brokerCompany: trip?.info?.customer || '',
          brokerEmail: brokerEmail || trip?.info?.broker || '',
          checkoutEmail: brokerEmail || trip?.info?.broker || '',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not add coverage');
      setMessage(data.alreadyGifted ? '100% coverage was already added by Skyway.' : '100% coverage added by Skyway. CFS bind email queued.');
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start">
      <Button size="sm" variant="outline" icon={ShieldCheck} onClick={() => setOpen((value) => !value)}>
        Add 100% AOG
      </Button>
      {message && <p className="mt-1 max-w-xs text-2xs text-success">{message}</p>}
      {open && (
        <div className="mt-2 w-72 rounded-lg border border-edge bg-surface p-3 shadow-card">
          <p className="text-xs font-semibold text-content">Gift 100% coverage</p>
          <p className="mt-1 text-2xs text-content-muted">Added by Skyway. The broker is not charged. CFS receives the bind email.</p>
          <label className="mt-2 block text-2xs text-content-muted">
            Aircraft type
            <input
              value={aircraftType}
              onChange={(event) => setAircraftType(event.target.value)}
              className="mt-1 w-full rounded border border-edge bg-surface-sunken px-2 py-1 text-xs text-content"
            />
          </label>
          <label className="mt-2 block text-2xs text-content-muted">
            Trip total (optional)
            <input
              value={tripTotal}
              onChange={(event) => setTripTotal(event.target.value)}
              inputMode="decimal"
              className="mt-1 w-full rounded border border-edge bg-surface-sunken px-2 py-1 text-xs text-content"
            />
          </label>
          {error && <p className="mt-2 text-2xs text-danger" role="alert">{error}</p>}
          <Button className="mt-3" size="sm" variant="primary" loading={busy} onClick={gift}>
            Add coverage
          </Button>
        </div>
      )}
    </div>
  );
}
