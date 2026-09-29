// Ops reports a real AOG: pick legs, confirm, then the server notifies CFS
// only when the trip is already covered at 100%.

import React, { useMemo, useState } from 'react';
import { Button } from './ui.jsx';
import { auth } from './firebase.js';

function newKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `aog-${Date.now()}`;
}

export default function AogIncidentReport({
  tripId,
  tail = '',
  aircraftType = '',
  legs = [],
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('edit');
  const [wholeTrip, setWholeTrip] = useState(true);
  const [picked, setPicked] = useState(() => Object.fromEntries(legs.map((leg) => [leg.id, true])));
  const [location, setLocation] = useState('');
  const [aogAt, setAogAt] = useState('');
  const [issue, setIssue] = useState('');
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);

  const chosen = useMemo(() => (
    wholeTrip ? legs : legs.filter((leg) => picked[leg.id])
  ), [legs, picked, wholeTrip]);

  function reset() {
    setStep('edit');
    setError('');
    setResult(null);
    setIdempotencyKey(newKey());
  }

  async function send() {
    setBusy(true);
    setError('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/aog-recovery-ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          action: 'report-aog',
          tripId,
          tail,
          aircraftType,
          legs,
          legIds: chosen.map((leg) => leg.id),
          wholeTrip,
          location,
          aogAt,
          issue,
          notes,
          contact,
          idempotencyKey,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not report the AOG');
      setResult(data);
      setStep('sent');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'inline-flex flex-col items-start' : 'mt-4'}>
      <Button size="sm" variant="outline" onClick={() => { setOpen((value) => !value); if (!open) reset(); }}>
        Report AOG
      </Button>
      {open && (
        <div className="mt-2 w-full max-w-md rounded-lg border border-edge bg-surface p-3" role="region" aria-label="Report AOG">
          {step === 'edit' && (
            <>
              <p className="text-sm font-semibold">Which part of the trip is AOG?</p>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={wholeTrip} onChange={(event) => setWholeTrip(event.target.checked)} />
                Whole trip
              </label>
              {!wholeTrip && legs.map((leg) => (
                <label key={leg.id} className="mt-1 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Leg ${leg.from} to ${leg.to}`}
                    checked={Boolean(picked[leg.id])}
                    onChange={(event) => setPicked((current) => ({ ...current, [leg.id]: event.target.checked }))}
                  />
                  {leg.from} → {leg.to}
                </label>
              ))}
              <label className="mt-3 block text-xs text-content-muted">
                Airport or location
                <input aria-label="Airport or location" value={location} onChange={(event) => setLocation(event.target.value)} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
              </label>
              <label className="mt-2 block text-xs text-content-muted">
                Time it went AOG
                <input aria-label="Time it went AOG" type="datetime-local" value={aogAt} onChange={(event) => setAogAt(event.target.value)} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
              </label>
              <label className="mt-2 block text-xs text-content-muted">
                Issue
                <textarea aria-label="Issue" value={issue} onChange={(event) => setIssue(event.target.value)} rows={2} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
              </label>
              <label className="mt-2 block text-xs text-content-muted">
                Notes
                <textarea aria-label="Notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
              </label>
              <label className="mt-2 block text-xs text-content-muted">
                Contact
                <input aria-label="Contact" value={contact} onChange={(event) => setContact(event.target.value)} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
              </label>
              {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
              <Button className="mt-3" size="sm" variant="primary" disabled={chosen.length === 0} onClick={() => setStep('confirm')}>
                Review and send
              </Button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <p className="text-sm font-semibold">Confirm this AOG report</p>
              <p className="mt-2 text-sm">{wholeTrip ? 'Whole trip' : `${chosen.length} leg${chosen.length === 1 ? '' : 's'}`} · {location || 'No location'} · {aogAt || 'No time'}</p>
              <p className="mt-1 text-sm">{issue}</p>
              {notes && <p className="mt-1 text-xs text-content-muted">{notes}</p>}
              {contact && <p className="mt-1 text-xs text-content-muted">{contact}</p>}
              {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStep('edit')}>Back</Button>
                <Button size="sm" variant="primary" loading={busy} onClick={send}>Confirm and notify</Button>
              </div>
            </>
          )}
          {step === 'sent' && result && (
            <>
              <p className="text-sm font-semibold">AOG report sent</p>
              <p className="mt-2 text-sm">{result.message}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
