import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Phone } from 'lucide-react';
import { Button, Card, StatusChip } from './ui.jsx';
import { brand } from './brand.js';
import { SKYWAY_CALLER_ID_DISPLAY } from './fbo-call.js';

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
      fromFbo: state.fromFbo || trip.info?.fromFbo,
      toFbo: state.toFbo || trip.info?.toFbo,
    },
  };
}

export default function TripFboCalls({
  trip,
  currentUser,
  fromFbo,
  toFbo,
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

  const state = {
    fromFbo,
    toFbo,
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
  }, [trip?.uid, fromFbo, toFbo, hasCatering, paxOverride, passengers, preloadedPax, tripSheetNotes]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (Array.isArray(fboCalls)) setCalls(fboCalls);
  }, [fboCalls]);

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
  const materialChanged = results.some((row) => {
    const match = calls.filter((call) => call.purpose === row.purpose && call.status !== 'cancelled').at(-1);
    return match && row.hash && match.factsHash && match.factsHash !== row.hash;
  });

  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-content">FBO calls</h2>
        <p className="mt-1 text-sm leading-relaxed text-content-muted">
          {brand.name} automated ops assistant. Caller ID {brand.contactPhone || SKYWAY_CALLER_ID_DISPLAY}.
          Ops must arm each trip. The agent will not guess hours or passenger names except the
          lead passenger for ground transportation.
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
                {row.ok ? 'Ready to arm' : 'Blocked'}
              </StatusChip>
            </div>
            {row.facts && (
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-content-subtle">FBO</dt>
                <dd className="text-content">{row.facts.fboName || '—'}</dd>
                <dt className="text-content-subtle">Airport</dt>
                <dd className="font-mono text-content">{row.facts.airport || '—'}</dd>
                <dt className="text-content-subtle">Phone</dt>
                <dd className="font-mono text-content">{row.facts.phoneDisplay || 'Not in iFlightPlanner'}</dd>
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
            {!row.ok && (
              <ul className="mt-2 list-disc pl-5 text-sm text-warning">
                {(row.blockers || []).map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </Card>
        ))}
      </div>
      {canArm && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={Phone}
            loading={busy === 'arm'}
            onClick={() => run('arm')}
            disabled={!results.some((row) => row.ok)}
          >
            Arm FBO calls
          </Button>
          {materialChanged && (
            <Button variant="secondary" loading={busy === 'update'} onClick={() => run('update')}>
              Queue update call
            </Button>
          )}
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
              </div>
              {call.summary && <p className="mt-1 text-sm text-content-muted">{call.summary}</p>}
              {call.confirmations && (
                <p className="mt-1 text-xs text-content-subtle">
                  {Object.entries(call.confirmations)
                    .filter(([, value]) => value === true || typeof value === 'string')
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {!preview && !error && (
        <p className="text-sm text-content-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Checking iFlightPlanner…</p>
      )}
    </div>
  );
}
