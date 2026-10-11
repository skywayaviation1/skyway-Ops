// Public arrival confirmation. The CSR does not get a Skyway login.
// Trip details stay minimal: no passenger names.

import React, { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

export default function FboConfirmPage({ token }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let cancel = false;
    if (!token) {
      setError('This confirmation link is missing.');
      return undefined;
    }
    fetch(`/api/fbo-public?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (cancel) return;
        if (!response.ok) {
          setError(data.error || 'This link is not valid.');
          if (data.view) setView(data.view);
          return;
        }
        setView(data.view || null);
        if (data.view?.arrivalStatus === 'confirmed') setDone('confirmed');
      })
      .catch(() => { if (!cancel) setError('Skyway could not open this link.'); });
    return () => { cancel = true; };
  }, [token]);

  async function submit(kind) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/fbo-public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, csrName: name, notes, kind }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error || 'Could not save your response.');
        return;
      }
      setView(data.view || view);
      setDone(kind === 'question' ? 'question' : 'confirmed');
    } catch {
      setError('Could not reach Skyway. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-black px-4 py-5 text-center">
        <img src="/skyway-logo.png" alt="Skyway Aviation Services" className="mx-auto h-auto w-48 max-w-full" />
      </header>
      <main className="mx-auto w-full max-w-lg px-4 py-6 pb-16">
        <h1 className="text-xl font-semibold">Arrival confirmation</h1>
        <p className="mt-1 text-sm text-slate-400">Tell Skyway this aircraft is on your schedule. The ETA is subject to change.</p>

        {!view && !error && (
          <p className="mt-8 flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the arrival…
          </p>
        )}
        {error && <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{error}</p>}

        {view && (
          <dl className="mt-5 divide-y divide-slate-800 rounded-xl border border-slate-800">
            {[
              ['Tail', view.tail || '—'],
              ['Trip ID', view.tripId || '—'],
              ['Airport', [view.to, view.airportName].filter(Boolean).join(' · ') || '—'],
              ['FBO', view.fboName || '—'],
              ['ETA', view.eta || '—'],
              ['Passengers', view.passengers || '—'],
              ['Services', view.services || 'None listed'],
              ['Notes', view.notes || 'None'],
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 px-3 py-3">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="text-sm font-medium text-slate-100">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {view && !view.expired && done && (
          <div className="mt-5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-100">
            <p className="flex items-center gap-2 font-semibold">
              <Check className="h-4 w-4" />
              {done === 'question' ? 'Skyway has your question.' : "You're on our schedule."}
            </p>
            <p className="mt-1 text-emerald-200/80">Ops has been notified. For anything else, call {view.opsPhone} or email {view.opsEmail}.</p>
          </div>
        )}

        {view && !view.expired && !done && (
          <form
            className="mt-5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit('confirm');
            }}
          >
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-400">Your name</span>
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-sky-400"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-400">Notes or a question</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-sky-400"
              />
            </label>
            <button
              type="submit"
              disabled={busy || name.trim().length < 2}
              className="min-h-12 w-full rounded-lg bg-white px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {busy ? 'Sending…' : "You're on our schedule"}
            </button>
            <button
              type="button"
              disabled={busy || name.trim().length < 2 || notes.trim().length < 2}
              onClick={() => submit('question')}
              className="min-h-12 w-full rounded-lg border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-100 disabled:opacity-50"
            >
              Send a question
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
