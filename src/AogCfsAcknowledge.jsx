// Public page for Charter Flight Support. No Skyway login. The link in the
// bind email is the credential. Skyway's premium is not shown.

import React, { useEffect, useState } from 'react';
import { Button } from './ui.jsx';
import { fmtMoney } from './aog-recovery.js';

function useToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-edge py-2 text-sm">
      <span className="text-content-muted">{label}</span>
      <span className="text-right font-medium text-content">{value || '—'}</span>
    </div>
  );
}

export default function AogCfsAcknowledge() {
  const token = useToken();
  const [coverage, setCoverage] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [cfsCost, setCfsCost] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  function applyCoverage(next) {
    setCoverage(next);
    const ack = next?.acknowledgement;
    if (!ack) return;
    setName(ack.name || '');
    setEmail(ack.email || '');
    setCfsCost(ack.cfsCost || '');
    setReference(ack.reference || '');
    setNotes(ack.notes || '');
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setError('This acknowledgement link is missing.');
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(`/api/aog-recovery-cfs?token=${encodeURIComponent(token)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.coverage) throw new Error(data.error || 'This acknowledgement link is not valid');
        if (cancelled) return;
        applyCoverage(data.coverage);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const response = await fetch('/api/aog-recovery-cfs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          name,
          email,
          cfsCost,
          reference,
          notes,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save the acknowledgement');
      applyCoverage(data.coverage);
      setSaved(data.unchanged
        ? 'This acknowledgement is already on file.'
        : 'Coverage acknowledged. Skyway ops and the broker have been notified.');
      if (data.emailError) setError(data.emailError);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const existing = coverage?.acknowledgement;

  return (
    <main className="sw-sheet bg-surface-sunken text-content">
      <div className="sw-sheet-panel sw-sheet-fill mx-auto w-full max-w-xl">
        <header className="sticky top-0 z-10 shrink-0 border-b border-edge bg-surface px-4 py-3">
          <p className="text-2xs uppercase tracking-[0.16em] text-content-muted">Charter Flight Support</p>
          <h1 className="mt-1 text-lg font-semibold">Acknowledge AOG coverage</h1>
        </header>
        <div className="sw-sheet-body px-4 py-4">
          {loading && <p className="text-sm text-content-muted">Loading the trip…</p>}
          {!loading && error && !coverage && <p className="text-sm text-danger" role="alert">{error}</p>}
          {coverage && (
            <>
              <h2 className="text-sm font-semibold">Trip</h2>
              <Row label="Trip ID" value={coverage.tripId} />
              <Row label="Broker" value={coverage.brokerCompany} />
              <Row label="Aircraft" value={[coverage.tail, coverage.aircraftType].filter(Boolean).join(' · ')} />
              <Row label="Route" value={coverage.route} />
              <Row label="Dates" value={coverage.datesLabel} />
              <Row label="Legs" value={coverage.legCount ? String(coverage.legCount) : ''} />
              <Row label="Coverage" value="100%" />
              <Row label="Contract trip total" value={fmtMoney(coverage.tripTotal)} />
              <Row label="Coverage value" value={coverage.coverageValueLabel || '—'} />

              {existing && (
                <div role="status" className="mt-4 rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
                  <p className="font-medium">Already acknowledged by {existing.name}</p>
                  <p className="mt-1 text-xs text-content-muted">
                    Coverage: 100%
                    {coverage.coverageValueLabel ? ` · Coverage value: ${coverage.coverageValueLabel}` : ''}
                    {existing.confirmedAt ? ` · ${new Date(existing.confirmedAt).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-content-muted">Submitting again updates the acknowledgement and notifies Skyway ops.</p>
                </div>
              )}

              <form className="mt-5 space-y-3" onSubmit={submit}>
                <label className="block text-sm">
                  <span className="mb-1 block text-content-muted">Your name</span>
                  <input aria-label="Your name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-content-muted">Your email</span>
                  <input aria-label="Your email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-content-muted">CFS cost (USD)</span>
                  <input aria-label="CFS cost" inputMode="decimal" value={cfsCost} onChange={(event) => setCfsCost(event.target.value)} required className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-content-muted">Policy or reference number (optional)</span>
                  <input aria-label="Policy or reference number" value={reference} onChange={(event) => setReference(event.target.value)} className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-content-muted">Notes (optional)</span>
                  <textarea aria-label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
                {saved && <p className="text-sm text-success" role="status">{saved}</p>}
                {error && coverage && <p className="text-sm text-danger" role="alert">{error}</p>}
                <Button type="submit" variant="primary" loading={busy}>
                  {existing ? 'Update acknowledgement' : 'Acknowledge coverage'}
                </Button>
              </form>
              <p className="pt-6 text-2xs text-content-subtle">End of acknowledgement</p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
