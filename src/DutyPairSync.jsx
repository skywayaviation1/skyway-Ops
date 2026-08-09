import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Loader2, X } from 'lucide-react';
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
    },
  })).filter((trip) => trip.uid && trip.start);
}

async function runPairSync(mode, trips, over14Verified = false, previewId = null) {
  const { auth } = await import('./firebase.js');
  if (!auth.currentUser) throw new Error('You must be signed in');
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch('/api/duty-backfill-pairs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken,
      mode,
      trips: mode === 'preview' ? schedulePayload(trips) : undefined,
      previewId,
      over14Verified,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Duty sync failed (${response.status})`);
  return result;
}

export default function DutyPairSync({ trips = [] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [applied, setApplied] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [over14Verified, setOver14Verified] = useState(false);
  const scheduleCount = useMemo(() => schedulePayload(trips).length, [trips]);

  const previewSync = async () => {
    setBusy(true);
    setApplied(null);
    try {
      const result = await runPairSync('preview', trips);
      setPreview(result);
    } catch (err) {
      notify.error(err?.message || 'Could not audit paired duty');
    } finally {
      setBusy(false);
    }
  };

  const applySync = async () => {
    if (!confirmed || !preview) return;
    setBusy(true);
    try {
      // Apply is bound to the server-stored, 30-minute preview. The server
      // recomputes against current Firestore periods and never accepts an
      // action list from the browser.
      const result = await runPairSync('apply', trips, over14Verified, preview.previewId);
      setApplied(result);
      setPreview(null);
      setConfirmed(false);
      setOver14Verified(false);
      notify.success(`Paired-duty sync applied ${result.actionsApplied || 0} repairs.`);
    } catch (err) {
      notify.error(err?.message || 'Could not apply paired-duty repairs');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" icon={Link2} onClick={() => setOpen(true)}>
        Sync paired crew
      </Button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-edge-strong bg-surface shadow-overlay">
            <div className="flex items-start justify-between gap-4 border-b border-edge p-4">
              <div>
                <h2 className="text-base font-semibold text-content">Synchronize paired PIC/SIC duty</h2>
                <p className="mt-1 text-2xs leading-relaxed text-content-muted">
                  Audits the complete 365-day retention window. Missing counterpart records copy
                  the existing crewmember’s duty-on, duty-off, flight time, assignment, tail and
                  trip data, then both records are linked.
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-content-subtle hover:text-content" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="rounded-xl border border-warning-border bg-warning-soft p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div className="text-2xs leading-relaxed text-content-muted">
                    <strong className="text-content">Conservative matching only.</strong>{' '}
                    The system repairs dangling partner links, links a unique same-tail/time PIC-SIC
                    pair, or resolves a missing crewmember from an unambiguous trip assignment.
                    Ambiguous records are skipped for manual review — never guessed or overwritten.
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Summary label="Schedule legs supplied" value={scheduleCount} />
                <Summary label="Records scanned" value={preview?.summary?.scanned ?? '—'} />
                <Summary label="Links found" value={preview?.summary?.links ?? '—'} />
                <Summary label="Records to create" value={preview?.summary?.creates ?? '—'} />
              </div>

              {!preview && !applied && (
                <div className="rounded-xl border border-edge bg-surface-sunken p-4 text-center">
                  <p className="text-sm text-content">Run a read-only audit first.</p>
                  <p className="mt-1 text-2xs text-content-subtle">
                    Nothing is changed until an admin reviews the counts and confirms Apply.
                  </p>
                </div>
              )}

              {preview && (
                <>
                  <div className="rounded-xl border border-edge bg-surface-sunken p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone="success" size="sm">
                        {preview.summary.links} existing pair{preview.summary.links === 1 ? '' : 's'} to link
                      </StatusChip>
                      <StatusChip tone="info" size="sm">
                        {preview.summary.creates} missing record{preview.summary.creates === 1 ? '' : 's'} to create
                      </StatusChip>
                      <StatusChip tone="neutral" size="sm">
                        {preview.summary.skipped} skipped
                      </StatusChip>
                    </div>
                    {preview.sample?.length > 0 && (
                      <div className="mt-3 max-h-56 divide-y divide-edge overflow-y-auto border-t border-edge">
                        {preview.sample.map((action, index) => (
                          <div key={`${action.type}-${action.sourceId || action.picId}-${index}`} className="py-2 text-2xs">
                            <p className="font-medium text-content">
                              {action.type === 'create'
                                ? `Create ${action.targetRole} record for ${action.targetName}`
                                : `Link existing PIC and SIC records`}
                            </p>
                            <p className="mt-0.5 text-content-subtle">
                              {action.sourcePilot || 'Crew'} · {action.tail || 'no tail'} ·{' '}
                              {action.dutyOnAt ? new Date(action.dutyOnAt).toLocaleString() : 'unknown time'} · {action.evidence}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {(preview.summary.links + preview.summary.creates) > 0 && (
                    <div className="space-y-2">
                      {preview.summary.over14Creates > 0 && (
                        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-danger-border bg-danger-soft p-3">
                          <input
                            type="checkbox"
                            checked={over14Verified}
                            onChange={(event) => setOver14Verified(event.target.checked)}
                            className="mt-0.5 accent-red-500"
                          />
                          <span className="text-2xs leading-relaxed text-content-muted">
                            I verified {preview.summary.over14Creates} historical record{preview.summary.over14Creates === 1 ? '' : 's'}
                            {' '}actually exceeded 14 hours. Applying will email Jim, Jake, and Zack Taylor.
                          </span>
                        </label>
                      )}
                      <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-danger-border bg-danger-soft p-3">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                          className="mt-0.5 accent-red-500"
                        />
                        <span className="text-2xs leading-relaxed text-content-muted">
                          I reviewed this preview. Create/link these historical duty records with an
                          admin-attested audit entry. Existing periods will not be overwritten.
                        </span>
                      </label>
                    </div>
                  )}
                </>
              )}

              {applied && (
                <div className="rounded-xl border border-success-border bg-success-soft p-4">
                  <div className="flex items-center gap-2 text-success">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="text-sm font-semibold">Paired-duty sync complete</span>
                  </div>
                  <p className="mt-2 text-2xs text-content-muted">
                    {applied.actionsApplied} repairs applied · {applied.documentsWritten} documents written
                    {applied.runId ? ` · audit run ${applied.runId}` : ''}
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-edge p-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={previewSync} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {preview ? 'Refresh audit' : 'Preview repairs'}
                </Button>
                {preview && (preview.summary.links + preview.summary.creates) > 0 && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={applySync}
                    disabled={busy || !confirmed || (preview.summary.over14Creates > 0 && !over14Verified)}
                  >
                    Apply repairs
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Summary({ label, value }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-sunken p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-content-subtle">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-content">{value}</p>
    </div>
  );
}

