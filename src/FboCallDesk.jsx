import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Phone, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState, PageHeader, StatusChip } from './ui.jsx';
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
  blocked: 'warning',
};

async function token() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

function fmt(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '—';
  }
}

export default function FboCallDesk({ currentUser }) {
  const canMutate = ['ops', 'admin'].includes(currentUser?.role);
  const [calls, setCalls] = useState([]);
  const [vendor, setVendor] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const idToken = await token();
      const response = await fetch('/api/fbo-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, action: 'desk' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setCalls(Array.isArray(data.calls) ? data.calls : []);
      setVendor(data.vendor || null);
    } catch (err) {
      setError(err.message || 'Could not load FBO calls');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(action, callId) {
    if (!canMutate) return;
    setBusyId(callId);
    try {
      const idToken = await token();
      const response = await fetch('/api/fbo-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, action, callId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Action failed');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId('');
    }
  }

  const sorted = useMemo(
    () => [...calls].sort((a, b) => (a.dialAt || 0) - (b.dialAt || 0)),
    [calls],
  );

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-surface-sunken p-4 md:p-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="FBO calls"
          subtitle={`${brand.name} automated ops assistant · caller ID ${brand.contactPhone || SKYWAY_CALLER_ID_DISPLAY}`}
          actions={(
            <Button variant="secondary" icon={RefreshCw} onClick={load}>Refresh</Button>
          )}
        />
        <Card className="mb-4" padded>
          <p className="text-sm leading-relaxed text-content-muted">
            Calls are never placed from the calendar automatically. Open a trip, review the verified
            FBO phone from iFlightPlanner, then arm departure and/or arrival. The agent speaks only
            those facts and may name the lead passenger only for ground transportation.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
                <StatusChip tone={vendor?.configured ? 'success' : 'warning'} size="sm">
                  {vendor?.configured ? 'Vapi ready' : 'Voice vendor keys missing on server'}
                </StatusChip>
            <StatusChip tone="neutral" size="sm">Twilio PSTN</StatusChip>
          </div>
        </Card>
        {error && (
          <p className="mb-3 flex items-start gap-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-content-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading calls…</p>
        ) : sorted.length === 0 ? (
          <EmptyState icon={Phone} title="No armed FBO calls" description="Arm a trip from the flight’s FBO calls tab." />
        ) : (
          <div className="space-y-3">
            {sorted.map((call) => (
              <Card key={call.id} padded={false}>
                <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-content">{call.fboName || 'FBO'} · {call.airport}</p>
                      <StatusChip tone={TONE[call.status] || 'neutral'} size="sm">{String(call.status || '').replace(/_/g, ' ')}</StatusChip>
                      {call.isUpdate && <StatusChip tone="warning" size="sm">Update</StatusChip>}
                    </div>
                    <p className="mt-1 font-mono text-xs text-content-muted">
                      {call.purpose} · {call.phone || 'no phone'} · dial {fmt(call.dialAt)}
                    </p>
                    <p className="mt-1 text-xs text-content-subtle">
                      {call.hoursKnown ? `Hours on file: ${call.hours}` : 'Hours not in iFlightPlanner — agent will not guess'}
                    </p>
                    {call.summary && <p className="mt-2 text-sm text-content">{call.summary}</p>}
                    {call.lastError && <p className="mt-2 text-sm text-danger">{call.lastError}</p>}
                    {call.transcript && (
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-2 text-[11px] text-content-muted">{call.transcript}</pre>
                    )}
                  </div>
                  {canMutate && ['armed', 'scheduled', 'retry', 'failed', 'needs_followup'].includes(call.status) && (
                    <div className="flex gap-2">
                      {['failed', 'needs_followup'].includes(call.status) && (
                        <Button size="sm" variant="secondary" loading={busyId === call.id} onClick={() => act('retry', call.id)}>Retry</Button>
                      )}
                      {['armed', 'scheduled', 'retry'].includes(call.status) && (
                        <Button size="sm" variant="secondary" loading={busyId === call.id} onClick={() => act('cancel', call.id)}>Cancel</Button>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
