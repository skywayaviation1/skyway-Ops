// Public AOG election page. No Skyway login — the unguessable link is the
// credential. Card entry happens on Stripe Checkout, not on this page.

import React, { useEffect, useState } from 'react';
import { Button, Card, StatusChip } from './ui.jsx';
import { fmtMoney } from './aog-recovery.js';

function useToken() {
  const params = new URLSearchParams(window.location.search);
  return {
    token: params.get('token') || '',
    result: params.get('result') || '',
  };
}

async function post(token, body) {
  const response = await fetch('/api/aog-recovery-public', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-edge py-2 text-sm">
      <span className="text-content-muted">{label}</span>
      <span className="text-right font-medium text-content">{value || '—'}</span>
    </div>
  );
}

export default function AogCoverageOffer() {
  const { token, result } = useToken();
  const [coverage, setCoverage] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [fullName, setFullName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load(attempt = 0) {
      if (!token) {
        setError('This coverage link is missing.');
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(`/api/aog-recovery-public?token=${encodeURIComponent(token)}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.coverage) throw new Error(data.error || 'This coverage link is not valid');
        if (cancelled) return;
        setCoverage(data.coverage);
        setError('');
        if (result === 'success' && data.coverage?.paymentStatus !== 'paid' && attempt < 8) {
          setTimeout(() => load(attempt + 1), 2000);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, result]);

  async function sign(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await post(token, { action: 'sign', fullName, agreed });
      setCoverage(data.coverage);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError('');
    try {
      const data = await post(token, { action: 'checkout' });
      if (data.url) window.location.assign(data.url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="aog-public-sheet sw-sheet bg-surface-sunken text-content">
      <div className="sw-sheet-panel sw-sheet-fill">
      <div className="sw-sheet-body">
      <div className="mx-auto w-full max-w-xl px-4 py-6">
        <img src="/skyway-logo-nav.png" alt="Skyway Aviation" width="148" height="36" className="h-9 w-auto" />
        <p className="mt-4 text-2xs uppercase tracking-[0.16em] text-content-muted">Skyway Aviation · Charter Flight Support</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold leading-tight">Keep the trip moving if the aircraft goes AOG</h1>
        <p className="mt-2 text-sm text-content-muted">50% recovery coverage is included with the charter. 100% raises that protection. You pay only the premium — the trip total is not charged.</p>

        <div className="mt-4 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
          Placeholder terms — Jake will replace this document before live use.
        </div>

        {loading && <p className="mt-8 text-sm text-content-muted">Loading the trip…</p>}
        {!loading && error && <p className="mt-8 text-sm text-danger" role="alert">{error}</p>}

        {!loading && coverage && (
          <Card className="mt-6">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Trip</h2>
              <StatusChip tone={coverage.paymentStatus === 'paid' ? 'success' : 'info'} size="sm">{coverage.coverageLabel}</StatusChip>
            </div>
            <Row label="Trip ID" value={coverage.tripId} />
            <Row label="Broker" value={coverage.brokerCompany} />
            <Row label="Aircraft" value={[coverage.tail, coverage.aircraftType].filter(Boolean).join(' · ')} />
            <Row label="Route" value={coverage.route} />
            <Row label="Dates" value={coverage.datesLabel} />
            <Row label="Trip total" value={Number(coverage.tripTotal) > 0 ? fmtMoney(coverage.tripTotal) : 'Pending trip total'} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <section aria-label={coverage.includedLine || 'Included 50%'} className="rounded-lg border border-edge bg-surface-sunken p-3">
                <p className="text-2xs uppercase tracking-[0.14em] text-content-muted">Included with the charter</p>
                <p className="mt-1 text-2xl font-semibold">50%</p>
                <p className="text-sm">No charge</p>
                <p className="mt-2 text-sm">Coverage value: {coverage.includedValueLabel || 'pending trip total'}</p>
                <p className="mt-2 text-sm font-medium">{coverage.includedLine}</p>
              </section>
              <section aria-label={coverage.upgradeLine || 'Upgrade 100%'} className="rounded-lg border border-accent bg-accent-soft p-3">
                <p className="text-2xs uppercase tracking-[0.14em] text-content-muted">Upgrade</p>
                <p className="mt-1 text-2xl font-semibold">100%</p>
                <p className="text-sm">{coverage.upgradeAvailable || coverage.paymentStatus === 'paid' ? `Premium ${fmtMoney(coverage.premium)}. The trip total is not charged.` : '100% is not offered for this aircraft until a premium rate is published.'}</p>
                <p className="mt-2 text-sm">Coverage value: {coverage.upgradeValueLabel || 'pending trip total'}</p>
                <p className="mt-2 text-sm font-medium">{coverage.upgradeLine}</p>
              </section>
            </div>

            {coverage.paymentStatus === 'paid' && (
              <p className="mt-4 text-sm text-success">Payment received. You are covered at 100%. A confirmation email follows once Stripe’s notice is recorded.</p>
            )}
            {result === 'success' && coverage.paymentStatus !== 'paid' && (
              <p className="mt-4 text-sm text-content-muted">Stripe accepted the return to this page. Coverage is confirmed only after the signed webhook records the premium.</p>
            )}
            {result === 'cancel' && coverage.paymentStatus !== 'paid' && (
              <p className="mt-4 text-sm text-content-muted">Payment was canceled. You can pay the premium when you are ready. 50% coverage stays in place.</p>
            )}
            {!coverage.upgradeAvailable && coverage.paymentStatus !== 'paid' && coverage.coverageLevel !== 'included_50' && (
              <p className="mt-4 text-sm">This trip is already recorded at {coverage.coverageLabel}. There is nothing to pay.</p>
            )}
            {coverage.coverageLevel === 'included_50' && !coverage.upgradeAvailable && (
              <p className="mt-4 text-sm">50% coverage is included. 100% is not offered for this aircraft until a premium rate is published.</p>
            )}

            {coverage.upgradeAvailable && (
              <>
                <h2 className="mb-2 mt-6 text-sm font-semibold">Coverage terms</h2>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface-sunken p-3 text-xs leading-relaxed text-content-muted">{coverage.termsText}</pre>
                {coverage.signed ? (
                  <div className="mt-4">
                    <p className="text-sm">Signed by {coverage.signedName}.</p>
                    <Button className="mt-3" variant="primary" loading={busy} onClick={pay}>
                      Pay {fmtMoney(coverage.premium)} premium
                    </Button>
                    <p className="mt-2 text-2xs text-content-muted">Card details are entered on Stripe. Skyway never sees the card number. The trip total is not charged.</p>
                  </div>
                ) : (
                  <form className="mt-4 space-y-3" onSubmit={sign}>
                    <label className="block text-sm">
                      <span className="mb-1 block text-content-muted">Full name</span>
                      <input
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        autoComplete="name"
                        required
                        className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                      />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(event) => setAgreed(event.target.checked)}
                        className="mt-1"
                        required
                      />
                      <span>I agree to these terms and elect 100% AOG coverage for this trip. I will pay the premium shown, and only the premium.</span>
                    </label>
                    <Button type="submit" variant="primary" loading={busy} disabled={!agreed || fullName.trim().length < 5}>
                      Sign election
                    </Button>
                  </form>
                )}
              </>
            )}
          </Card>
        )}
        <p className="aog-end mt-6 text-xs text-content-muted">End of offer</p>
      </div>
      </div>
      </div>
    </main>
  );
}
