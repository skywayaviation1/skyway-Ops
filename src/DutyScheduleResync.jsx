import React, { useMemo, useState } from 'react';
import { AlertTriangle, Link2, Loader2, X } from 'lucide-react';
import { Button, StatusChip, notify } from './ui.jsx';

function schedulePayload(trips) {
  return (trips || []).map((trip) => ({
    uid: trip.uid || trip.id,
    start: trip.start instanceof Date ? trip.start.toISOString() : trip.start,
    end: trip.end instanceof Date ? trip.end.toISOString() : trip.end,
    info: {
      tail: trip.info?.tail || '',
      pic: trip.info?.pic || '',
      sic: trip.info?.sic || '',
      from: trip.info?.from || '',
      to: trip.info?.to || '',
      category: trip.info?.category || '',
      tripType: trip.info?.tripType || '',
    },
  })).filter((trip) => trip.uid && trip.start);
}

function todayEt() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

function hours(ms) {
  return Number.isFinite(ms) ? (ms / 3600000).toFixed(1) : '—';
}

async function runResync(body) {
  const { auth } = await import('./firebase.js');
  if (!auth.currentUser) throw new Error('You must be signed in');
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch('/api/duty-schedule-resync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Resync failed (${response.status})`);
  return result;
}

export default function DutyScheduleResync({ trips = [], pilots = [] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('day');
  const [day, setDay] = useState(todayEt);
  const [startDay, setStartDay] = useState(todayEt);
  const [endDay, setEndDay] = useState(todayEt);
  const [pilotUid, setPilotUid] = useState(pilots[0]?.uid || '');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const scheduleCount = useMemo(() => schedulePayload(trips).length, [trips]);

  const scope = kind === 'day'
    ? { kind, day }
    : kind === 'range'
      ? { kind, startDay, endDay }
      : { kind, pilotUid, startDay, endDay };

  const previewSync = async () => {
    setBusy(true);
    setConfirmed(false);
    try {
      const result = await runResync({
        mode: 'preview',
        trips: schedulePayload(trips),
        scope,
        reason,
      });
      setPreview(result);
    } catch (err) {
      notify.error(err?.message || 'Could not preview the schedule resync');
    } finally {
      setBusy(false);
    }
  };

  const applySync = async () => {
    if (!confirmed || !preview?.previewId) return;
    setBusy(true);
    try {
      const result = await runResync({ mode: 'apply', previewId: preview.previewId });
      setPreview(null);
      setConfirmed(false);
      notify.success(`Resync wrote ${result.written || 0} crew-link update${result.written === 1 ? '' : 's'}.`);
    } catch (err) {
      notify.error(err?.message || 'Could not apply the schedule resync');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" icon={Link2} onClick={() => setOpen(true)} data-testid="resync-open">
        Resync with schedule
      </Button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4">
          <div className="flex max-h-[100dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-xl border border-edge-strong bg-surface shadow-overlay sm:max-h-[90vh] sm:rounded-xl" data-testid="resync-panel">
            <div className="flex items-start justify-between gap-4 border-b border-edge p-4 sw-safe-top">
              <div>
                <h2 className="text-base font-semibold text-content">Resync with schedule</h2>
                <p className="mt-1 text-2xs leading-relaxed text-content-muted">
                  Rebuilds crew links from tail and trip assignments for one day, a date range,
                  or one pilot. Duty-on, duty-off, and flight time stay as recorded. Nothing is
                  written until you confirm the dry run.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-content-subtle hover:text-content" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Scope</span>
                  <select
                    value={kind}
                    onChange={(event) => { setKind(event.target.value); setPreview(null); }}
                    className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content"
                    data-testid="resync-scope"
                  >
                    <option value="day">One day</option>
                    <option value="range">Date range</option>
                    <option value="pilot">One pilot</option>
                  </select>
                </label>
                {kind === 'day' ? (
                  <label className="block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Day (Eastern)</span>
                    <input type="date" value={day} onChange={(event) => { setDay(event.target.value); setPreview(null); }} className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content" />
                  </label>
                ) : (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">From (Eastern)</span>
                      <input type="date" value={startDay} onChange={(event) => { setStartDay(event.target.value); setPreview(null); }} className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Through (Eastern)</span>
                      <input type="date" value={endDay} onChange={(event) => { setEndDay(event.target.value); setPreview(null); }} className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content" />
                    </label>
                  </>
                )}
                {kind === 'pilot' && (
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Pilot</span>
                    <select value={pilotUid} onChange={(event) => { setPilotUid(event.target.value); setPreview(null); }} className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content">
                      <option value="">Select a pilot</option>
                      {pilots.map((pilot) => <option key={pilot.uid} value={pilot.uid}>{pilot.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Reason (required)</span>
                <textarea
                  value={reason}
                  onChange={(event) => { setReason(event.target.value); setPreview(null); setConfirmed(false); }}
                  rows={2}
                  placeholder="Why are these crew links being rebuilt?"
                  className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content"
                  data-testid="resync-reason"
                />
              </label>
              <p className="text-2xs text-content-subtle">{scheduleCount} scheduled legs will be compared. Ambiguous matches are skipped.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={previewSync} disabled={busy || !reason.trim()} data-testid="resync-preview">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Dry-run preview
                </Button>
              </div>

              {preview && (
                <div data-testid="resync-diff" className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <StatusChip tone="info" size="sm">{preview.summary?.changes || 0} link updates</StatusChip>
                    <StatusChip tone="neutral" size="sm">{preview.summary?.warnings || 0} skipped</StatusChip>
                  </div>
                  {(preview.changes || []).length === 0 ? (
                    <p className="rounded-lg border border-edge bg-surface-sunken p-3 text-sm text-content-muted">No crew-link changes for this scope.</p>
                  ) : (
                    <div className="space-y-2">
                      {preview.changes.map((change) => (
                        <article key={change.id} className="rounded-lg border border-edge bg-surface-sunken p-3 text-xs">
                          <p className="font-semibold text-content">{change.pilotName || change.pilotUid}</p>
                          <p className="mt-1 text-content-muted">{change.tail || 'No tail'} · times unchanged</p>
                          <p className="mt-2 text-content">
                            Crew {change.before?.crewType || '—'} → {change.after?.crewType || '—'}
                            {' · '}
                            Link {change.before?.partnerPeriodId || 'none'} → {change.after?.partnerPeriodId || 'none'}
                          </p>
                          {change.limitsBefore && (
                            <p className="mt-1 text-content-muted">
                              Single-pilot flag {change.limitsBefore.singlePilotFlag ? 'yes' : 'no'} → {change.limitsAfter?.singlePilotFlag ? 'yes' : 'no'}
                              {' · '}
                              Rest {hours(change.limitsBefore.restRequiredMs)}h → {hours(change.limitsAfter?.restRequiredMs)}h
                              {' · '}
                              Flight {hours(change.limitsBefore.twoFlightMs)}h two-pilot / {hours(change.limitsBefore.singleFlightMs)}h single → {hours(change.limitsAfter?.twoFlightMs)}h / {hours(change.limitsAfter?.singleFlightMs)}h
                            </p>
                          )}
                          <p className="mt-2 text-content-subtle">{change.reason}</p>
                        </article>
                      ))}
                    </div>
                  )}
                  {(preview.warnings || []).length > 0 && (
                    <div className="rounded-lg border border-warning-border bg-warning-soft p-3 text-2xs text-content-muted">
                      <div className="mb-1 flex items-center gap-1 font-semibold text-content">
                        <AlertTriangle className="h-3.5 w-3.5 text-warning" /> Skipped
                      </div>
                      <ul className="space-y-1">
                        {preview.warnings.slice(0, 12).map((warning, index) => (
                          <li key={`${warning.pairingId || index}`}>{warning.day}: {warning.reason} {warning.detail ? `· ${warning.detail}` : ''}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <label className="flex items-start gap-2 text-xs text-content">
                    <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" data-testid="resync-confirm" />
                    <span>I reviewed the dry run. Write these crew-link changes and keep each pilot’s duty and flight times.</span>
                  </label>
                  <Button variant="primary" size="sm" onClick={applySync} disabled={busy || !confirmed || !(preview.changes || []).length} data-testid="resync-apply">
                    Write confirmed changes
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
