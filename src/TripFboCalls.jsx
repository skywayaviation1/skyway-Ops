import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Phone, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, StatusChip } from './ui.jsx';
import { brand } from './brand.js';
import FboCallListener from './FboCallListener.jsx';
import FboCallReview from './FboCallReview.jsx';
import { SKYWAY_CALLER_ID_DISPLAY, formatLocalMilitaryTime, toE164 } from './fbo-call.js';

const TONE = {
  completed: 'success',
  in_progress: 'accent',
  dialing: 'accent',
  armed: 'info',
  scheduled: 'info',
  retry: 'warning',
  failed: 'danger',
  needs_followup: 'danger',
  cancelled: 'neutral',
};

async function token() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

function payloadFrom(trip, state) {
  return {
    uid: trip.uid,
    start: trip.start,
    end: trip.end,
    info: {
      tail: trip.info?.tail,
      from: trip.info?.from,
      to: trip.info?.to,
      pax: trip.info?.pax,
      pic: trip.info?.pic,
      sic: trip.info?.sic,
      legType: trip.info?.legType,
    },
  };
}

function verificationSignature(row) {
  if (!row?.ok || !row.facts) return '';
  return [
    row.facts.fboName,
    row.facts.airport,
    row.facts.phoneE164,
  ].join('|');
}

export default function TripFboCalls({
  trip,
  currentUser,
  tripSheetUrl,
  tripSheetData,
  fromFbo,
  toFbo,
  fboCallDialOverrides = {},
  passengers = [],
  preloadedPax = [],
  hasCatering,
  paxOverride,
  tripSheetNotes,
  fboCalls,
}) {
  const canArm = ['ops', 'admin'].includes(currentUser?.role);
  const [preview, setPreview] = useState(null);
  const [calls, setCalls] = useState(Array.isArray(fboCalls) ? fboCalls : []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [verifiedFacts, setVerifiedFacts] = useState({});
  const [phoneOverrides, setPhoneOverrides] = useState(fboCallDialOverrides);
  const [phoneDrafts, setPhoneDrafts] = useState({});
  const [dialImmediately, setDialImmediately] = useState(true);

  const state = {
    tripSheetUrl,
    tripSheetData,
    fromFbo,
    toFbo,
    fboCallDialOverrides: phoneOverrides,
    passengers,
    preloadedPax,
    hasCatering,
    paxOverride,
    tripSheetNotes,
  };

  const refresh = useCallback(async () => {
    if (!trip?.uid) return;
    setError(null);
    try {
      const idToken = await token();
      const [previewRes, listRes] = await Promise.all([
        fetch('/api/fbo-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            action: 'preview',
            trip: payloadFrom(trip, state),
            state,
            purposes: ['departure', 'arrival'],
          }),
        }),
        fetch('/api/fbo-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, action: 'list', tripId: trip.uid }),
        }),
      ]);
      const previewData = await previewRes.json();
      const listData = await listRes.json();
      if (!previewRes.ok) throw new Error(previewData.error || 'Preview failed');
      setPreview(previewData);
      if (listRes.ok) setCalls(listData.calls || []);
    } catch (err) {
      setError(err.message || 'Could not load FBO call facts');
    }
  }, [
    trip?.uid,
    tripSheetUrl,
    tripSheetData,
    fromFbo,
    toFbo,
    hasCatering,
    paxOverride,
    passengers,
    preloadedPax,
    tripSheetNotes,
    phoneOverrides,
  ]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (Array.isArray(fboCalls)) setCalls(fboCalls);
  }, [fboCalls]);
  useEffect(() => {
    setPhoneOverrides(fboCallDialOverrides || {});
    setPhoneDrafts({});
    setVerifiedFacts({});
  }, [trip?.uid, fboCallDialOverrides]);

  async function savePhone(purpose, sheetPhone) {
    const entered = String(phoneDrafts[purpose] ?? phoneOverrides[purpose] ?? sheetPhone ?? '').trim();
    if (!toE164(entered)) {
      setError('Enter a valid phone number before saving.');
      return;
    }
    const next = { ...phoneOverrides };
    if (toE164(entered) === toE164(sheetPhone)) delete next[purpose];
    else next[purpose] = entered;
    setBusy(`phone-${purpose}`);
    setError(null);
    try {
      const { saveTripState } = await import('./firebase-data.js');
      await saveTripState(trip.uid, { fboCallDialOverrides: next });
      setPhoneOverrides(next);
      setVerifiedFacts((current) => ({ ...current, [purpose]: '' }));
    } catch (err) {
      setError(err.message || 'Could not save the call phone');
    } finally {
      setBusy('');
    }
  }

  async function run(action, extra = {}) {
    if (!canArm) return;
    setBusy(action);
    setError(null);
    try {
      const idToken = await token();
      const response = await fetch('/api/fbo-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          action,
          trip: payloadFrom(trip, state),
          state,
          purposes: ['departure', 'arrival'],
          ...extra,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const results = preview?.results || [];
  const latestCallFor = (row) => calls
    .filter((call) => call.purpose === row.purpose && call.status !== 'cancelled')
    .at(-1);
  const changedResults = results.filter((row) => {
    const match = latestCallFor(row);
    return match && row.hash && match.factsHash && match.factsHash !== row.hash;
  });
  const verifiedPurposes = results
    .filter((row) => verificationSignature(row) === verifiedFacts[row.purpose])
    .map((row) => row.purpose);
  const verifiedChanged = changedResults.every((row) => verifiedPurposes.includes(row.purpose));

  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-content">FBO calls</h2>
        <p className="mt-1 text-sm leading-relaxed text-content-muted">
          {brand.name} automated ops assistant. Caller ID {SKYWAY_CALLER_ID_DISPLAY}.
          FBO names and phone numbers come from the uploaded trip sheet. Verify the details, then arm
          the call. The agent will not guess hours or passenger names except the lead
          passenger for ground transportation.
        </p>
      </div>
      {error && (
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
        </p>
      )}
      <div className="grid gap-3">
        {results.map((row) => (
          <Card key={row.purpose} padded>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold capitalize text-content">{row.purpose} FBO</p>
              <StatusChip tone={row.ok ? 'success' : 'warning'} size="sm">
                {verificationSignature(row) === verifiedFacts[row.purpose]
                  ? 'Verified'
                  : (row.ok ? 'Ready to verify' : 'Blocked')}
              </StatusChip>
            </div>
            {row.facts && (
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-content-subtle">Trip sheet FBO</dt>
                <dd className="text-content">{row.facts.fboName || '—'}</dd>
                <dt className="text-content-subtle">Trip airport</dt>
                <dd className="font-mono text-content">{row.facts.airport || '—'}</dd>
                <dt className="text-content-subtle">Trip sheet phone</dt>
                <dd className="font-mono text-content">
                  {row.facts.phoneDisplay || 'Not on trip sheet'}
                  {row.facts.phoneSource === 'override' && (
                    <span className="ml-2 text-[10px] font-semibold uppercase text-warning">changed for calls</span>
                  )}
                </dd>
                <dt className="text-content-subtle">Scheduled</dt>
                <dd className="font-mono text-content">{row.facts.scheduledLocalLine || '—'}</dd>
                <dt className="text-content-subtle">Hours</dt>
                <dd className="text-content">{row.facts.hoursKnown ? row.facts.hours : 'Not on file — will not be guessed'}</dd>
                <dt className="text-content-subtle">Ground</dt>
                <dd className="text-content">
                  {row.facts.groundTransport
                    ? `Requested · lead passenger ${row.facts.leadPassengerName || 'not on file'}`
                    : 'Not requested · no passenger names'}
                </dd>
              </dl>
            )}
            {row.facts && canArm && (
              <div className="mt-3 rounded-lg border border-edge p-3">
                <label className="block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                  Phone number for this call
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="tel"
                    value={phoneDrafts[row.purpose] ?? row.facts.phoneDisplay ?? ''}
                    onChange={(event) => setPhoneDrafts((current) => ({
                      ...current,
                      [row.purpose]: event.target.value,
                    }))}
                    className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-sm text-content outline-none focus:border-accent"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `phone-${row.purpose}`}
                    onClick={() => savePhone(
                      row.purpose,
                      row.purpose === 'arrival'
                        ? tripSheetData?.toAirportPhone
                        : tripSheetData?.fromAirportPhone,
                    )}
                  >
                    Use number
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-content-subtle">
                  Change applies to this trip’s calls. Re-enter the trip-sheet number to restore it.
                </p>
              </div>
            )}
            {row.ok && canArm && (
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-edge bg-surface-sunken p-3 text-sm text-content">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={verificationSignature(row) === verifiedFacts[row.purpose]}
                  onChange={(event) => setVerifiedFacts((current) => ({
                    ...current,
                    [row.purpose]: event.target.checked ? verificationSignature(row) : '',
                  }))}
                />
                <span>
                  I verified the FBO, airport, and call phone shown above.
                </span>
              </label>
            )}
            {!row.ok && (
              <ul className="mt-2 list-disc pl-5 text-sm text-warning">
                {(row.blockers || []).map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </Card>
        ))}
      </div>
      {canArm && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 rounded-lg border border-edge bg-surface p-3 text-sm text-content">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={dialImmediately}
              onChange={(event) => setDialImmediately(event.target.checked)}
            />
            <span>
              Call immediately when armed
              <span className="block text-xs text-content-subtle">
                Arrival calls also get a follow-up two hours before arrival.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={Phone}
              loading={busy === 'arm'}
              onClick={() => run('arm', {
                purposes: verifiedPurposes,
                verifiedPurposes,
                dialImmediately,
              })}
              disabled={verifiedPurposes.length === 0}
            >
              Arm verified {verifiedPurposes.length === 1 ? 'call' : 'calls'}
            </Button>
            {changedResults.length > 0 && (
              <Button
                variant="secondary"
                loading={busy === 'update'}
                disabled={!verifiedChanged}
                onClick={() => run('update', { verifiedPurposes })}
              >
                Queue update call
              </Button>
            )}
          </div>
        </div>
      )}
      {calls.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">Call history</p>
          {calls.map((call) => (
            <div key={call.id} className="rounded-lg border border-edge p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold capitalize text-content">{call.purpose}</span>
                <StatusChip tone={TONE[call.status] || 'neutral'} size="sm">{String(call.status || '').replace(/_/g, ' ')}</StatusChip>
                {call.callPhase === 'arrival_reverification' && (
                  <StatusChip tone="info" size="sm">2-hour follow-up</StatusChip>
                )}
                {call.callPhase === 'retry' && <StatusChip tone="warning" size="sm">Retry</StatusChip>}
              </div>
              <p className="mt-1 font-mono text-xs text-content-subtle">
                {call.phone || 'No phone'} · {call.dialMode === 'immediate'
                  ? 'called when armed'
                  : `scheduled ${formatLocalMilitaryTime(call.dialAt, call.airport).line || '—'}`}
              </p>
              {call.summary && <p className="mt-1 text-sm text-content-muted">{call.summary}</p>}
              <FboCallReview call={call} canPlayRecording={canArm} />
              {canArm && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {['armed', 'scheduled', 'retry'].includes(call.status) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === 'dialNow'}
                      onClick={() => run('dialNow', { callId: call.id })}
                    >
                      Call now
                    </Button>
                  )}
                  {call.listenAvailable && <FboCallListener callId={call.id} />}
                  {['completed', 'failed', 'needs_followup', 'cancelled'].includes(call.status) && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={RotateCcw}
                        loading={busy === 'retry'}
                        onClick={() => run('retry', { callId: call.id })}
                      >
                        Retry call
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        loading={busy === 'delete'}
                        onClick={() => {
                          if (window.confirm('Delete this finished FBO call and its Skyway history?')) {
                            run('delete', { callId: call.id });
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!preview && !error && (
        <p className="text-sm text-content-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Reading FBO details from the trip sheet…</p>
      )}
    </div>
  );
}
