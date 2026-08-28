import { useEffect, useState } from 'react';
import {
  Check, Clipboard, ExternalLink, Link2, Loader2, Plane, Radio, RefreshCw,
  ShieldCheck, Unlink,
} from 'lucide-react';

const dateValue = (value) => (
  value instanceof Date ? value.toISOString() : value || null
);

export function isBrokeredTrip(trip, managedTails = []) {
  const tail = String(trip?.info?.tail || '').trim().toUpperCase();
  if (!trip?.info?.isFlight || !tail || ['TBD', 'TBA', 'UNKNOWN'].includes(tail)) return false;
  const managed = new Set((managedTails || []).map((value) => String(value).trim().toUpperCase()));
  return !managed.has(tail);
}

export default function BrokeredOperatorLink({ trip, currentUser }) {
  const [operatorName, setOperatorName] = useState('');
  const [operatorOpsEmail, setOperatorOpsEmail] = useState('');
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  async function call(action, extra = {}) {
    const { auth } = await import('./firebase.js');
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('Your session expired. Sign in again.');
    const response = await fetch('/api/operator-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        tripId: trip.uid,
        idToken,
        ...extra,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Operator link returned ${response.status}`);
    return data;
  }

  async function refresh() {
    try {
      const data = await call('status');
      setState(data);
      if (data.operatorName) setOperatorName(data.operatorName);
      if (data.operatorOpsEmail) setOperatorOpsEmail(data.operatorOpsEmail);
    } catch (error) {
      setMessage(error.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [trip.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mint() {
    setBusy(true);
    setMessage('');
    try {
      const data = await call('mint', {
        trip: {
          tail: trip.info?.tail,
          from: trip.info?.from,
          to: trip.info?.to,
          start: dateValue(trip.start),
          end: dateValue(trip.end),
          aircraftType: trip.info?.aircraftType || trip.info?.tripType,
          operatorName,
          opsEmail: operatorOpsEmail,
        },
      });
      setState(data);
      setMessage(
        'Crew link active. This tail is now temporarily included in FlightAware ADS-B polling.',
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm('Revoke this operating-crew link and stop temporary tail tracking?')) return;
    setBusy(true);
    setMessage('');
    try {
      await call('revoke');
      setState((current) => ({ ...(current || {}), active: false, url: null }));
      setMessage('Operator link revoked and temporary tracking disabled.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveContact() {
    setBusy(true);
    setMessage('');
    try {
      const data = await call('update-contact', { operatorName, opsEmail: operatorOpsEmail });
      setState(data);
      setMessage('Operator contact saved. The existing crew link is unchanged.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!state?.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage('Copy is unavailable. Select and copy the URL manually.');
    }
  }

  const updateCount = state?.updates?.length || 0;
  const repoCount = state?.repositioning?.length || 0;
  return (
    <div className="rounded-xl border border-violet-500/35 bg-violet-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Plane className="h-4 w-4 text-violet-300" />
            <h3 className="text-sm font-semibold text-content">Brokered operator crew link</h3>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-content-muted">
            Give this trip-scoped link to the operating crew. They can send milestones and file
            repositioning without a Skyway account. Activating it temporarily adds this outside
            tail to ADS-B polling for wheels-up, landing, position, and filed movement awareness.
          </p>
        </div>
        <span className={`rounded border px-2 py-1 font-mono text-[9px] ${
          state?.active
            ? 'border-success-border bg-success-soft text-success'
            : 'border-edge bg-surface-sunken text-content-subtle'
        }`}>
          {state?.active ? 'ACTIVE' : 'INACTIVE'}
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-content-subtle">
            Operating company
          </span>
          <input
            value={operatorName}
            onChange={(event) => setOperatorName(event.target.value)}
            placeholder="Brokered operator name"
            maxLength={160}
            className="w-full rounded border border-edge bg-surface-sunken px-3 py-2 text-xs text-content outline-none focus:border-violet-400"
            disabled={busy}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-content-subtle">
            Their operations email
          </span>
          <input
            type="email"
            value={operatorOpsEmail}
            onChange={(event) => setOperatorOpsEmail(event.target.value)}
            placeholder="ops@operator.com"
            maxLength={254}
            className="w-full rounded border border-edge bg-surface-sunken px-3 py-2 text-xs text-content outline-none focus:border-violet-400"
            disabled={busy}
          />
        </label>
      </div>
      <p className="mt-1 text-[9px] text-content-subtle">
        External crew updates are sent to Skyway Operations and this operator email.
      </p>

      {state?.active && state.url ? (
        <>
          <div className="mt-3 flex gap-1.5">
            <input
              readOnly
              value={state.url}
              onFocus={(event) => event.target.select()}
              className="min-w-0 flex-1 rounded border border-edge bg-surface-sunken px-2 py-2 font-mono text-[10px] text-content"
            />
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded border border-violet-500/40 px-2.5 text-[10px] text-violet-200 hover:bg-violet-500/10"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
              {copied ? 'COPIED' : 'COPY'}
            </button>
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded border border-edge px-2.5 text-content-muted hover:text-content"
              title="Preview operator portal"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-content-muted">
            <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3 text-success" /> ADS-B polling active</span>
            <span>{updateCount} crew update{updateCount === 1 ? '' : 's'}</span>
            <span>{repoCount} filed reposition{repoCount === 1 ? '' : 's'}</span>
          </div>
          {state.repositioning?.length > 0 && (
            <div className="mt-2 space-y-1">
              {state.repositioning.slice(-3).reverse().map((movement) => (
                <div key={movement.id} className="rounded border border-violet-500/20 bg-surface-sunken px-2 py-1.5 text-[10px] text-content-muted">
                  <span className="font-mono text-violet-200">
                    REPOSITION · {movement.from} → {movement.to}
                  </span>
                  <span className="ml-2">
                    {movement.departure ? new Date(movement.departure).toLocaleString() : 'time pending'}
                    {movement.author ? ` · ${movement.author}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={saveContact}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-cyan-500/40 px-2 py-2 text-[9px] text-cyan-200 hover:bg-cyan-500/10"
            >
              <Check className="h-3.5 w-3.5" /> SAVE CONTACT
            </button>
            <button
              type="button"
              onClick={mint}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-edge px-2 py-2 text-[9px] text-content-muted hover:text-content"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              ROTATE LINK
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-danger-border px-2 py-2 text-[9px] text-danger hover:bg-danger-soft"
            >
              <Unlink className="h-3.5 w-3.5" /> REVOKE
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={mint}
          disabled={busy}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded bg-violet-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          CREATE CREW UPDATE LINK & START TRACKING
        </button>
      )}

      {message && (
        <div className="mt-3 flex items-start gap-1.5 rounded border border-edge bg-surface-sunken p-2 text-[10px] text-content-muted">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" /> {message}
        </div>
      )}
    </div>
  );
}

