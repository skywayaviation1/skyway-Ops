// FBO desk: per-leg matching and the ops command center.
// Schedule data is synced up from the JetInsight feed the app already holds.
// Mail itself is sent by the serverless routes, not from the browser.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2, Check, Mail, Plane, RefreshCw, Send, ShieldAlert,
} from 'lucide-react';
import {
  Button, Card, CardHeader, EmptyState, MetricTile, PageHeader, StatusChip, cx,
} from './ui.jsx';
import {
  arrivalPlanView,
  arrivalView,
  deskCounts,
  legInSyncWindow,
  legSyncRecord,
  normalizeAirport,
  reminderView,
  validEmail,
} from './fbo-notify.js';

async function authHeaders() {
  const { auth } = await import('./firebase.js');
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Your session expired. Sign in again.');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function fboFetch(path, options = {}) {
  const headers = await authHeaders();
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'FBO request failed');
  }
  return data;
}

async function loadDirectory(airport) {
  if (!airport) return [];
  const data = await fboFetch(`/api/fbo-directory?airport=${encodeURIComponent(airport)}`);
  return data.directory || [];
}

async function saveDirectoryEntry(entry) {
  if (!entry?.airport || !entry?.aid) return null;
  return fboFetch('/api/fbo-directory', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

function directoryRow(rows, aid) {
  if (!aid) return null;
  return (rows || []).find((row) => row.aid === aid) || null;
}

function canWrite(user) {
  return user?.role === 'ops' || user?.role === 'admin';
}

function localDayRange(offsetDays) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { fromMs: start.getTime(), toMs: end.getTime() };
}

function rangeForFilter(dateFilter, customDate) {
  if (dateFilter === 'today') return localDayRange(0);
  if (dateFilter === 'tomorrow') return localDayRange(1);
  if (dateFilter === 'week') {
    const start = localDayRange(0);
    return { fromMs: start.fromMs, toMs: start.fromMs + 7 * 24 * 60 * 60 * 1000 };
  }
  if (dateFilter === 'date' && customDate) {
    const [year, month, day] = customDate.split('-').map(Number);
    if (!year || !month || !day) return {};
    const start = new Date(year, month - 1, day);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { fromMs: start.getTime(), toMs: end.getTime() };
  }
  return {};
}

function clock(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ToneStatus({ status }) {
  const tone = status === 'sent' || status === 'confirmed' || status === 'scheduled_manual'
    ? 'success'
    : status === 'failed' || status === 'question'
      ? 'danger'
      : status === 'needs_reconfirm'
      ? 'warning'
      : status === 'opened'
        ? 'info'
        : 'warning';
  const label = status === 'scheduled_manual' ? 'Marked scheduled'
    : status === 'needs_reconfirm' ? 'Needs re-confirm'
    : status === 'not_sent' ? 'Not sent'
      : status === 'reminder-failed' ? 'Failed'
        : String(status || 'scheduled').replace(/_/g, ' ');
  return <StatusChip tone={tone} size="sm">{label}</StatusChip>;
}

function Field({ label, value, onChange, placeholder, disabled, type = 'text' }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold text-content-subtle">{label}</span>
      <input
        type={type}
        value={value || ''}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-content outline-none focus:border-accent disabled:opacity-60"
      />
    </label>
  );
}

function SideCard({
  title,
  airport,
  side,
  providers,
  write,
  busy,
  directoryPreferred,
  onSelect,
  onSave,
  onConfirmMatch,
  extra,
}) {
  const [email, setEmail] = useState(side?.email || '');
  const [phone, setPhone] = useState(side?.phone || '');
  const [contact, setContact] = useState(side?.contact || '');
  const [preferred, setPreferred] = useState(directoryPreferred === true);
  const [optedOut, setOptedOut] = useState(side?.optedOut === true);
  useEffect(() => {
    setEmail(side?.email || '');
    setPhone(side?.phone || '');
    setContact(side?.contact || '');
    setPreferred(directoryPreferred === true);
    setOptedOut(side?.optedOut === true);
  }, [side?.email, side?.phone, side?.contact, side?.aid, side?.optedOut, directoryPreferred]);

  const missing = !validEmail(email);
  const listed = providers || [];
  const known = Boolean(side?.aid) && listed.some((item) => item.aid === side.aid);
  const choices = known || !side?.aid
    ? listed
    : [{ aid: side.aid, name: side.name || 'Saved FBO' }, ...listed];
  return (
    <Card className="min-w-0">
      <CardHeader
        title={title}
        subtitle={airport || 'Airport not set'}
        icon={Building2}
        action={(
          <StatusChip tone={side?.matchStatus && side.matchStatus !== 'unmatched' ? 'success' : 'warning'} size="sm">
            {side?.matchStatus || 'unmatched'}
          </StatusChip>
        )}
      />
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-content-subtle">FBO</span>
          <select
            aria-label={`${title} FBO`}
            disabled={!write || busy}
            value={side?.aid || ''}
            onChange={(event) => {
              const provider = choices.find((item) => item.aid === event.target.value);
              if (provider) onSelect(provider);
            }}
            className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-content outline-none focus:border-accent disabled:opacity-60"
          >
            <option value="">{side?.aid ? 'Choose an FBO' : (side?.name || 'Choose an FBO')}</option>
            {choices.map((provider) => (
              <option key={provider.aid} value={provider.aid}>{provider.name}</option>
            ))}
          </select>
          {side?.hintName && (
            <p className="mt-1 text-[11px] text-content-subtle">Name on the trip: {side.hintName}</p>
          )}
          {side?.matchScore > 0 && side?.matchStatus !== 'manual' && (
            <p className="mt-1 text-[11px] text-content-subtle">Match {Math.round(side.matchScore * 100)}%</p>
          )}
        </label>
        <Field label="Email" type="email" value={email} onChange={setEmail} disabled={!write} placeholder="csr@fbo.example" />
        {missing && <p className="text-[11px] text-warning">No email on file. Add one and it is saved for this airport.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone" value={phone} onChange={setPhone} disabled={!write} placeholder="(000) 000-0000" />
          <Field label="Contact" value={contact} onChange={setContact} disabled={!write} placeholder="CSR name" />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={preferred} onChange={(event) => setPreferred(event.target.checked)} disabled={!write} />
          Preferred FBO at this airport
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={optedOut} onChange={(event) => setOptedOut(event.target.checked)} disabled={!write} />
          Do not email this FBO
        </label>
        {write && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={Check}
              loading={busy}
              disabled={!side?.aid && !side?.name}
              onClick={() => onSave({ email, phone, contact, preferred, optedOut })}
            >
              Save contact
            </Button>
            {side?.matchStatus === 'suggested' && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={onConfirmMatch}>Confirm match</Button>
            )}
          </div>
        )}
        {extra}
      </div>
    </Card>
  );
}

export function FboLegPanel({ trip, fromFbo, toFbo, currentUser, statuses }) {
  const write = canWrite(currentUser);
  const [leg, setLeg] = useState(null);
  const [providers, setProviders] = useState({ from: [], to: [] });
  const [directory, setDirectory] = useState({ from: [], to: [] });
  const [globalLead, setGlobalLead] = useState(24);
  const [sendAtInput, setSendAtInput] = useState('');
  const [services, setServices] = useState('');
  const [notes, setNotes] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const record = useMemo(() => legSyncRecord(trip, {
    fromFboName: fromFbo,
    toFboName: toFbo,
    actualOff: statuses?.wheels_up?.timestamp,
    actualOut: statuses?.taxi_dep?.timestamp,
  }), [trip, fromFbo, toFbo, statuses?.wheels_up?.timestamp, statuses?.taxi_dep?.timestamp]);

  useEffect(() => {
    let cancel = false;
    fboFetch('/api/fbo-settings')
      .then((data) => {
        if (cancel) return;
        const hours = data.settings?.arrivalAutoLeadHours;
        setGlobalLead(hours == null ? null : hours);
      })
      .catch(() => {});
    return () => { cancel = true; };
  }, []);

  const reload = useCallback(async () => {
    if (!record.legUid) return;
    const data = await fboFetch(`/api/fbo-action?legUid=${encodeURIComponent(record.legUid)}`);
    setLeg(data.leg);
    setServices(data.leg?.arrival?.services || '');
    setNotes(data.leg?.arrival?.opsNotes || '');
  }, [record.legUid]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!legInSyncWindow(record) && record.isFlight === false) return;
      setError('');
      try {
        await fboFetch('/api/fbo-desk', {
          method: 'POST',
          body: JSON.stringify({ legs: [record], complete: false }),
        });
        await fboFetch('/api/fbo-action', {
          method: 'POST',
          body: JSON.stringify({ action: 'rematch', legUid: record.legUid, unlock: false }),
        });
        if (cancel) return;
        await reload();
        const [fromMatch, toMatch] = await Promise.all([
          fboFetch('/api/fbo-match', { method: 'POST', body: JSON.stringify({ airport: record.from, hints: [record.fromFboName].filter(Boolean) }) }),
          fboFetch('/api/fbo-match', { method: 'POST', body: JSON.stringify({ airport: record.to, hints: [record.toFboName].filter(Boolean) }) }),
        ]);
        if (!cancel) setProviders({ from: fromMatch.providers || [], to: toMatch.providers || [] });
        const [fromDirectory, toDirectory] = await Promise.all([
          loadDirectory(record.from),
          loadDirectory(record.to),
        ]);
        if (!cancel) setDirectory({ from: fromDirectory, to: toDirectory });
      } catch (err) {
        if (!cancel) setError(err.message);
      }
    })();
    return () => { cancel = true; };
  }, [record.legUid, record.from, record.to, record.fromFboName, record.toFboName, record.start, reload]);

  async function act(action, extra = {}, before) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (before) await before();
      const data = await fboFetch('/api/fbo-action', {
        method: 'POST',
        body: JSON.stringify({ action, legUid: record.legUid, ...extra }),
      });
      if (data.leg) {
        setLeg(data.leg);
        setServices(data.leg.arrival?.services || '');
        setNotes(data.leg.arrival?.opsNotes || '');
      } else {
        await reload();
      }
      if (action === 'save-contact' || action === 'select-fbo') {
        const airport = extra.side === 'arrival' ? record.to : record.from;
        const rows = await loadDirectory(airport);
        setDirectory((current) => ({
          ...current,
          [extra.side === 'arrival' ? 'to' : 'from']: rows,
        }));
      }
      setMessage('Saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!trip?.info?.isFlight && record.isFlight === false) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState icon={Plane} title="No FBO handling" description="This calendar block is not a flight leg." />
      </div>
    );
  }

  const departureView = reminderView(leg || {});
  const arrival = arrivalView(leg?.arrival || {});
  const plan = arrivalPlanView(leg || { ...record, arrival: {} }, globalLead);
  const shownLead = leg?.arrival?.scheduleDisabled || leg?.arrival?.leadHours === 'off'
    ? 'off'
    : (leg?.arrival?.leadHours ? String(leg.arrival.leadHours) : 'default');

  function saveLead(choice) {
    if (choice === 'off') {
      return act('set-arrival-schedule', { scheduleDisabled: true, leadHours: 'off', clearSendAt: true });
    }
    if (choice === 'default') {
      return act('set-arrival-schedule', { scheduleDisabled: false, leadHours: null, clearSendAt: true });
    }
    return act('set-arrival-schedule', { scheduleDisabled: false, leadHours: Number(choice), clearSendAt: true });
  }
  const tripId = record.tripId || 'Trip ID not on this leg';

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16 md:p-6">
      <PageHeader
        title="FBO handling"
        subtitle={`${record.tail || 'Tail'} · ${tripId} · ${record.from || '—'} → ${record.to || '—'}`}
        actions={write ? (
          <Button
            size="sm"
            variant={leg?.emailsDisabled ? 'secondary' : 'outline'}
            icon={ShieldAlert}
            onClick={() => act('set-disabled', { emailsDisabled: !leg?.emailsDisabled })}
          >
            {leg?.emailsDisabled ? 'Emails off for this trip' : 'Disable emails for this trip'}
          </Button>
        ) : null}
      />
      {error && <div className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm text-success">{message}</div>}
      {!leg && !error && <p className="text-sm text-content-muted">Matching FBOs…</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <SideCard
          title="Departure FBO"
          airport={record.from}
          side={{ ...(leg?.departure || {}), hintName: record.fromFboName || leg?.departure?.hintName }}
          providers={providers.from}
          directoryPreferred={directoryRow(directory.from, leg?.departure?.aid)?.preferred === true}
          write={write}
          busy={busy}
          onSelect={(provider) => act('select-fbo', { side: 'departure', ...provider }, () => saveDirectoryEntry({
            airport: record.from,
            aid: provider.aid,
            name: provider.name,
            email: provider.email,
            phone: provider.phone,
            contact: provider.contact,
          }))}
          onConfirmMatch={() => act('confirm-match', { side: 'departure' })}
          onSave={(contact) => act('save-contact', { side: 'departure', ...contact }, () => saveDirectoryEntry({
            airport: record.from,
            aid: leg?.departure?.aid,
            name: leg?.departure?.name,
            ...contact,
          }))}
          extra={(
            <div className="border-t border-edge pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-content-subtle">Departure reminder</span>
                <ToneStatus status={departureView.status} />
              </div>
              <p className="text-[12px] text-content-muted">
                {departureView.status === 'sent' && departureView.sentAt
                  ? `Sent ${clock(departureView.sentAt)}`
                  : 'Sends automatically 1 hour before departure.'}
                {departureView.error ? ` ${departureView.error}` : ''}
              </p>
              {write && (
                <Button className="mt-2" size="sm" variant="secondary" icon={Send} loading={busy} onClick={() => act('resend-departure')}>
                  Send reminder now
                </Button>
              )}
            </div>
          )}
        />
        <SideCard
          title="Arrival FBO"
          airport={record.to}
          side={{ ...(leg?.arrival || {}), hintName: record.toFboName || leg?.arrival?.hintName }}
          providers={providers.to}
          directoryPreferred={directoryRow(directory.to, leg?.arrival?.aid)?.preferred === true}
          write={write}
          busy={busy}
          onSelect={(provider) => act('select-fbo', { side: 'arrival', ...provider }, () => saveDirectoryEntry({
            airport: record.to,
            aid: provider.aid,
            name: provider.name,
            email: provider.email,
            phone: provider.phone,
            contact: provider.contact,
          }))}
          onConfirmMatch={() => act('confirm-match', { side: 'arrival' })}
          onSave={(contact) => act('save-contact', { side: 'arrival', ...contact }, () => saveDirectoryEntry({
            airport: record.to,
            aid: leg?.arrival?.aid,
            name: leg?.arrival?.name,
            ...contact,
          }))}
          extra={(
            <div className="space-y-2 border-t border-edge pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-content-subtle">Arrival</span>
                <ToneStatus status={arrival.status} />
              </div>
              <p className="text-sm text-content">{arrival.label}</p>
              <p className="text-[12px] text-content-muted">
                {plan.mode === 'off' || leg?.arrival?.scheduleDisabled
                  ? 'Advance arrival email is off for this trip.'
                  : plan.dueAt
                    ? `Arrival email scheduled ${clock(new Date(plan.dueAt).toISOString())}.`
                    : 'Arrival email is not scheduled yet.'}
                {plan.inboundStatus === 'sent'
                  ? ` Inbound sent ${clock(plan.inboundSentAt)}.`
                  : plan.departedAt
                    ? ' Aircraft has departed. Inbound email is next.'
                    : ' Inbound email waits for actual departure.'}
              </p>
              {arrival.notes && <p className="text-[12px] text-content-muted">{arrival.notes}</p>}
              {arrival.question && <p className="text-[12px] text-warning">{arrival.question}</p>}
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Services requested</span>
                <textarea
                  value={services}
                  disabled={!write}
                  onChange={(event) => setServices(event.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Notes to the FBO</span>
                <textarea
                  value={notes}
                  disabled={!write}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
                />
              </label>
              {write && (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Button size="sm" icon={Send} loading={busy} onClick={() => act('send-arrival', { services, notes })}>
                    Schedule arrival
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => act('manual-confirm', { note: manualNote })}>
                    Manual confirm
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act('mark-scheduled', { note: manualNote })}>
                    Mark scheduled
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy || plan.inboundStatus === 'sent'} onClick={() => act('mark-departed')}>
                    Departed
                  </Button>
                </div>
              )}
              {write && (
                <Field label="Ops note for a manual confirm" value={manualNote} onChange={setManualNote} placeholder="Who you spoke with" />
              )}
              {write && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Advance send</span>
                    <select
                      aria-label="Arrival lead time"
                      value={shownLead}
                      disabled={busy}
                      onChange={(event) => saveLead(event.target.value)}
                      className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm"
                    >
                      <option value="default">Default ({globalLead ? `${globalLead}h` : 'off'})</option>
                      <option value="off">Off for this trip</option>
                      <option value="6">6 hours before ETA</option>
                      <option value="12">12 hours before ETA</option>
                      <option value="24">24 hours before ETA</option>
                      <option value="2">2 hours before ETA</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Or send at</span>
                    <input
                      type="datetime-local"
                      aria-label="Arrival send time"
                      value={sendAtInput}
                      disabled={busy}
                      onChange={(event) => setSendAtInput(event.target.value)}
                      className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2 sm:col-span-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || !sendAtInput}
                      onClick={() => act('set-arrival-schedule', {
                        scheduleDisabled: false,
                        leadHours: null,
                        sendAt: new Date(sendAtInput).toISOString(),
                      })}
                    >
                      Schedule this time
                    </Button>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-sm text-content sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={directoryRow(directory.to, leg?.arrival?.aid)?.arrivalScheduleOff === true}
                      disabled={busy || !leg?.arrival?.aid}
                      onChange={(event) => act('set-arrival-schedule', {
                        scheduleDisabled: leg?.arrival?.scheduleDisabled === true,
                        leadHours: leg?.arrival?.leadHours ?? null,
                        sendAt: leg?.arrival?.sendAt || null,
                        clearSendAt: !leg?.arrival?.sendAt,
                        arrivalScheduleOff: event.target.checked,
                      })}
                    />
                    No advance emails for this FBO
                  </label>
                </div>
              )}
            </div>
          )}
        />
      </div>
    </div>
  );
}

export function FboLegSync({ trips, ready }) {
  const signature = useMemo(() => (trips || []).map((trip) => {
    const start = trip?.start instanceof Date ? trip.start.toISOString() : trip?.start;
    return `${trip?.uid}:${start}:${trip?.info?.from}:${trip?.info?.to}`;
  }).join('|'), [trips]);

  useEffect(() => {
    if (!ready) return undefined;
    let cancel = false;
    const timer = setTimeout(async () => {
      try {
        const legs = (trips || []).map((trip) => legSyncRecord(trip)).filter((leg) => leg.legUid && leg.isFlight !== false);
        const windowed = legs.filter((leg) => legInSyncWindow(leg));
        if (cancel) return;
        await fboFetch('/api/fbo-desk', {
          method: 'POST',
          body: JSON.stringify({ legs: windowed, complete: true }),
        });
      } catch (error) {
        console.warn('[fbo] schedule sync skipped:', error.message);
      }
    }, 1200);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [ready, signature, trips]);
  return null;
}

export function FboHomeCard({ onOpen }) {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    let cancel = false;
    fboFetch('/api/fbo-desk?status=open')
      .then((data) => { if (!cancel) setCounts(data.counts || null); })
      .catch(() => { if (!cancel) setCounts(null); });
    return () => { cancel = true; };
  }, []);
  if (!counts) return null;
  const attention = counts.open + counts.missingEmail + counts.questions + counts.reminderFailed;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-surface px-4 py-3 text-left transition-colors hover:border-accent"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold text-content">
          <Building2 className="h-4 w-4 text-accent" />
          FBO desk
          {attention > 0 && (
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{attention}</span>
          )}
        </span>
        <span className="mt-1 block text-[12px] text-content-muted">
          {counts.open} arrival{counts.open === 1 ? '' : 's'} not confirmed
          {counts.missingEmail ? ` · ${counts.missingEmail} missing email` : ''}
          {counts.questions ? ` · ${counts.questions} question${counts.questions === 1 ? '' : 's'}` : ''}
        </span>
      </span>
      <span className="text-sm font-semibold text-accent">Open</span>
    </button>
  );
}

export function FboEmailSafety() {
  const [settings, setSettings] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [lead, setLead] = useState('24');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancel = false;
    fboFetch('/api/fbo-settings')
      .then((data) => {
        if (cancel) return;
        setSettings(data.settings);
        setCanEdit(data.canEdit === true);
        setLead(data.settings?.arrivalAutoLeadHours ? String(data.settings.arrivalAutoLeadHours) : 'off');
      })
      .catch((error) => { if (!cancel) setMessage(error.message); });
    return () => { cancel = true; };
  }, []);

  async function save(next) {
    if (!canEdit) return;
    if (next.testMode === false) {
      const ok = window.confirm('Send FBO emails to the real FBO addresses? Test mode is currently catching every message.');
      if (!ok) return;
    }
    setBusy(true);
    setMessage('');
    try {
      const data = await fboFetch('/api/fbo-settings', {
        method: 'POST',
        body: JSON.stringify(next),
      });
      setSettings(data.settings);
      setLead(data.settings?.arrivalAutoLeadHours ? String(data.settings.arrivalAutoLeadHours) : 'off');
      setMessage(data.settings?.testMode ? 'Test mode is on. FBO mail goes to jake@flyskyway.com.' : 'FBO mail is live.');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  const testMode = settings ? settings.testMode !== false : true;
  return (
    <Card>
      <CardHeader
        title="FBO email safety"
        subtitle="Test mode is the default. Advance arrival mail goes out 24 hours before ETA unless you change it."
        icon={Mail}
      />
      <div className={cx(
        'mb-3 rounded-lg border px-3 py-2 text-sm',
        testMode ? 'border-warning-border bg-warning-soft text-warning' : 'border-success-border bg-success-soft text-success',
      )}>
        {testMode
          ? 'Test mode is ON. Every FBO email is redirected to jake@flyskyway.com and shows the intended recipient.'
          : 'Live. FBO emails go to the saved FBO address.'}
      </div>
      <label className="mb-3 block text-sm text-content">
        <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Automatic arrival email</span>
        <select
          aria-label="Automatic arrival lead time"
          value={lead}
          disabled={!canEdit || busy}
          onChange={(event) => {
            setLead(event.target.value);
            save({
              testMode,
              arrivalAutoLeadHours: event.target.value === 'off' ? null : Number(event.target.value),
            });
          }}
          className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent disabled:opacity-60"
        >
          <option value="off">Off — ops sends arrival emails</option>
          <option value="24">24 hours before ETA (default)</option>
          <option value="1">1 hour before ETA</option>
          <option value="2">2 hours before ETA</option>
          <option value="3">3 hours before ETA</option>
          <option value="6">6 hours before ETA</option>
          <option value="12">12 hours before ETA</option>
        </select>
      </label>
      {canEdit && (
        <Button
          variant={testMode ? 'primary' : 'secondary'}
          loading={busy}
          onClick={() => save({ testMode: !testMode, arrivalAutoLeadHours: lead === 'off' ? null : Number(lead) })}
        >
          {testMode ? 'Go live' : 'Return to test mode'}
        </Button>
      )}
      {message && <p className="mt-2 text-[12px] text-content-muted">{message}</p>}
    </Card>
  );
}

function LegRow({ leg, write, busy, onAction, onChanged, globalLead }) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const reminder = reminderView(leg);
  const arrival = arrivalView(leg.arrival || {});
  const plan = arrivalPlanView(leg, globalLead);
  const missingDep = !validEmail(leg.departure?.email);
  const missingArr = !validEmail(leg.arrival?.email);
  const targetSide = missingArr ? 'arrival' : 'departure';
  const target = targetSide === 'arrival' ? leg.arrival : leg.departure;

  return (
    <div className="border-b border-edge px-3 py-3 last:border-b-0 md:px-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-semibold text-content">{leg.tail || '—'}</span>
            <span className="text-sm text-content">{leg.from} → {leg.to}</span>
            <span className="font-mono text-[12px] text-content-muted">{leg.tripId || 'No trip ID'}</span>
          </div>
          <p className="mt-1 text-[12px] text-content-muted">{clock(leg.start)} departure · {clock(leg.end)} ETA</p>
          <p className="mt-1 text-[12px] text-content-muted">
            {plan.mode === 'off' || leg.arrival?.scheduleDisabled
              ? 'Advance arrival off'
              : plan.dueAt
                ? `Arrival email ${clock(new Date(plan.dueAt).toISOString())}`
                : 'Arrival email not scheduled'}
            {plan.inboundStatus === 'sent' ? ' · inbound sent' : plan.departedAt ? ' · departed' : ' · inbound waiting'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="text-[11px] text-content-subtle">Dep {leg.departure?.name || leg.fromFboName || 'unmatched'}</span>
            <ToneStatus status={reminder.status === 'failed' ? 'failed' : reminder.status} />
            <span className="text-[11px] text-content-subtle">Arr {leg.arrival?.name || leg.toFboName || 'unmatched'}</span>
            <ToneStatus status={arrival.status} />
            {(missingDep || missingArr) && <StatusChip tone="warning" size="sm">Missing email</StatusChip>}
          </div>
          {arrival.notes && <p className="mt-1 text-[12px] text-content-muted">{arrival.label}{arrival.notes ? ` — ${arrival.notes}` : ''}</p>}
          {arrival.question && <p className="mt-1 text-[12px] text-warning">{arrival.question}</p>}
        </div>
        {write && (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap md:max-w-sm md:justify-end">
            <Button size="sm" icon={Send} disabled={busy} onClick={() => onAction(leg, 'send-arrival')}>Schedule</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(leg, 'resend-departure')}>Resend reminder</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setOpen((value) => !value)}>
              {open ? 'Close' : 'Confirm / email'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || plan.inboundStatus === 'sent'} onClick={() => onAction(leg, 'mark-departed')}>
              Departed
            </Button>
          </div>
        )}
      </div>
      {open && write && (
        <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-surface-sunken p-3 sm:grid-cols-2">
          <Field label={`Email for ${target?.name || targetSide}`} value={email} onChange={setEmail} placeholder={target?.email || 'fbo@example.com'} />
          <Field label="Manual note" value={note} onChange={setNote} placeholder="Spoke with Alex at the desk" />
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              size="sm"
              disabled={busy || !validEmail(email)}
              onClick={() => onAction(leg, 'save-contact', {
                side: targetSide,
                email,
                aid: target?.aid,
                name: target?.name,
                phone: target?.phone,
                contact: target?.contact,
              })}
            >
              Save FBO email
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction(leg, 'manual-confirm', { note })}>
              Manual confirm
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(leg, 'mark-scheduled', { note })}>
              Mark scheduled
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FboDesk({ currentUser, onSelectTrip }) {
  const write = canWrite(currentUser);
  const [dateFilter, setDateFilter] = useState('upcoming');
  const [customDate, setCustomDate] = useState('');
  const [airport, setAirport] = useState('');
  const [status, setStatus] = useState('open');
  const [missingEmail, setMissingEmail] = useState(false);
  const [desk, setDesk] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const filters = useMemo(() => ({
    status,
    airport: normalizeAirport(airport),
    missingEmail,
    ...rangeForFilter(dateFilter, customDate),
  }), [status, airport, missingEmail, dateFilter, customDate]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.airport) params.set('airport', filters.airport);
    if (filters.missingEmail) params.set('missingEmail', '1');
    if (filters.fromMs) params.set('fromMs', String(filters.fromMs));
    if (filters.toMs) params.set('toMs', String(filters.toMs));
    const data = await fboFetch(`/api/fbo-desk?${params.toString()}`);
    setDesk(data);
  }, [filters]);

  useEffect(() => {
    let cancel = false;
    setError('');
    load().catch((err) => { if (!cancel) setError(err.message); });
    const timer = setInterval(() => {
      load().catch(() => {});
    }, 30000);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, [load]);

  async function onAction(leg, action, extra = {}) {
    setBusy(true);
    setError('');
    try {
      if (action === 'save-contact') {
        await saveDirectoryEntry({
          airport: extra.side === 'arrival' ? leg.to : leg.from,
          aid: extra.aid,
          name: extra.name,
          email: extra.email,
          phone: extra.phone,
          contact: extra.contact,
        });
      }
      await fboFetch('/api/fbo-action', {
        method: 'POST',
        body: JSON.stringify({ action, legUid: leg.legUid, ...extra }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const counts = desk?.counts || deskCounts(desk?.legs || []);
  const shown = desk?.legs || [];
  const notices = (desk?.notices || []).filter((notice) => notice.read !== true).slice(0, 5);

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-surface-sunken pb-16">
      <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
        <PageHeader
          title="FBO desk"
          subtitle="Arrivals that still need a schedule or a confirmation."
          actions={(
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => load().catch((err) => setError(err.message))}>
              Refresh
            </Button>
          )}
        />
        {desk?.settings?.testMode !== false && (
          <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
            Test mode is on. FBO emails redirect to jake@flyskyway.com with the intended recipient shown in the message.
          </div>
        )}
        {error && <div className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Need confirmation" value={counts.open || 0} tone="warning" icon={Plane} />
          <MetricTile label="Missing email" value={counts.missingEmail || 0} tone={counts.missingEmail ? 'warning' : 'success'} icon={Mail} />
          <MetricTile label="Questions" value={counts.questions || 0} tone={counts.questions ? 'danger' : 'success'} icon={Mail} />
          <MetricTile label="Reminder failed" value={counts.reminderFailed || 0} tone={counts.reminderFailed ? 'danger' : 'success'} icon={ShieldAlert} />
        </div>

        {notices.length > 0 && (
          <Card padded={false}>
            <div className="p-4 pb-2">
              <CardHeader title="FBO replies" subtitle="Confirmations and questions from the handling desk." icon={Mail} />
            </div>
            {notices.map((notice) => (
              <button
                key={notice.id}
                type="button"
                className="block w-full border-t border-edge px-4 py-3 text-left"
                onClick={() => onAction({ legUid: notice.legUid }, 'mark-notice-read', { noticeId: notice.id })}
              >
                <span className="text-sm font-semibold text-content">
                  {notice.csrName || 'FBO'} {notice.kind === 'question' ? 'asked a question' : 'confirmed'} · {notice.tail} {notice.tripId || ''}
                </span>
                <span className="mt-0.5 block text-[12px] text-content-muted">{notice.notes || notice.airport}</span>
              </button>
            ))}
          </Card>
        )}

        <Card padded={false}>
          <div className="flex flex-col gap-2 p-3 md:flex-row md:flex-wrap md:items-end">
            <label className="min-w-[9rem] flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Date</span>
              <select aria-label="Date filter" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm">
                <option value="upcoming">Upcoming</option>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="week">Next 7 days</option>
                <option value="date">Specific date</option>
              </select>
            </label>
            {dateFilter === 'date' && (
              <label className="min-w-[9rem]">
                <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Day</span>
                <input type="date" aria-label="Filter date" value={customDate} onChange={(event) => setCustomDate(event.target.value)} className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm" />
              </label>
            )}
            <label className="min-w-[7rem]">
              <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Airport</span>
              <input aria-label="Airport filter" value={airport} onChange={(event) => setAirport(event.target.value.toUpperCase())} placeholder="KAPF" className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 font-mono text-sm uppercase" />
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block text-[11px] font-semibold text-content-subtle">Status</span>
              <select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)} className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm">
                <option value="open">Not scheduled or confirmed</option>
                <option value="all">All upcoming</option>
                <option value="sent">Sent</option>
                <option value="opened">Opened</option>
                <option value="confirmed">Confirmed</option>
                <option value="question">Question</option>
                <option value="needs_reconfirm">Needs re-confirm</option>
                <option value="missing-email">Missing email</option>
                <option value="reminder-failed">Reminder failed</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-content">
              <input type="checkbox" checked={missingEmail} onChange={(event) => setMissingEmail(event.target.checked)} />
              Missing email
            </label>
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Check} title="Nothing waiting" description="Upcoming legs are either confirmed or not on the desk yet. Open a trip to match its FBOs." />
          ) : shown.map((leg) => (
            <LegRow
              key={leg.legUid}
              leg={leg}
              write={write}
              busy={busy}
              onAction={onAction}
              onChanged={load}
              globalLead={desk?.settings ? desk.settings.arrivalAutoLeadHours : 24}
            />
          ))}
        </Card>

        {write && onSelectTrip && shown[0] && (
          <Button variant="outline" onClick={() => onSelectTrip(shown[0].legUid)}>Open first leg</Button>
        )}

        {currentUser?.role === 'admin' && <FboEmailSafety />}

        {currentUser?.role === 'admin' && (desk?.audit || []).length > 0 && (
          <Card padded={false}>
            <div className="p-4 pb-2">
              <CardHeader title="Email audit" subtitle="Every FBO send, including test redirects." icon={Mail} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[12px]">
                <thead className="text-content-subtle">
                  <tr>
                    <th className="px-3 py-2 font-semibold">When</th>
                    <th className="px-3 py-2 font-semibold">Type</th>
                    <th className="px-3 py-2 font-semibold">Trip</th>
                    <th className="px-3 py-2 font-semibold">Intended</th>
                    <th className="px-3 py-2 font-semibold">Delivered</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {desk.audit.map((row) => (
                    <tr key={row.id} className="border-t border-edge">
                      <td className="px-3 py-2 whitespace-nowrap">{clock(row.at)}</td>
                      <td className="px-3 py-2">{row.type}</td>
                      <td className="px-3 py-2 font-mono">{row.tripId || row.legUid}</td>
                      <td className="px-3 py-2">{row.intendedTo}</td>
                      <td className="px-3 py-2">{row.deliveredTo}{row.testMode ? ' · test' : ''}</td>
                      <td className="px-3 py-2">{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

export function syncPayloads(trips) {
  return (trips || []).map((trip) => legSyncRecord(trip)).filter((leg) => legInSyncWindow(leg));
}
