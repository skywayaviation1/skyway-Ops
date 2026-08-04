import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  Plane,
  Plus,
  Radar,
  Save,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Button, Card, CardHeader, PageHeader, StatusChip, cx } from './ui.jsx';
import {
  normalizeFleetTails,
  normalizeTail,
  normalizeAircraftByTail,
  resolveManagedTails,
  scheduledOnlyTails,
} from './fleet-config.js';
import { DUTY_TRACKER_ENABLED } from './duty-feature.js';

const DEFAULT_ALERT_EMAILS = [
  'jim@flyskyway.com',
  'jake@flyskyway.com',
  'zack.taylor@flyskyway.com',
];

function TailRow({ tail, detail, tone = 'neutral', action }) {
  return (
    <div className="flex items-center gap-3 border-b border-edge px-3 py-3 last:border-b-0">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
        <Plane className="h-4 w-4 text-content-muted" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-semibold tracking-wide text-content">{tail}</p>
        <p className="text-2xs text-content-muted">{detail}</p>
      </div>
      <StatusChip tone={tone} size="sm">{tone === 'success' ? 'Managed' : 'Schedule only'}</StatusChip>
      {action}
    </div>
  );
}

function ToggleRow({ icon: Icon, title, description, checked, onChange, disabled = false }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 border-b border-edge px-3 py-4 last:border-b-0">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
        <Icon className="h-4 w-4 text-content-muted" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-content">{title}</span>
        <span className="block text-2xs leading-relaxed text-content-muted">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        disabled={disabled}
        className="h-5 w-5 rounded border-edge bg-surface accent-cyan-500"
      />
    </label>
  );
}

function FleetAircraftEditor({ tail, value, onChange, onRemove }) {
  const field = (name, placeholder, extra = '') => (
    <input
      value={value?.[name] || ''}
      onChange={(event) => onChange(name, event.target.value)}
      placeholder={placeholder}
      aria-label={`${tail} ${name}`}
      className={cx(
        'min-w-0 rounded-lg border border-edge bg-surface px-3 py-2 text-xs text-content outline-none focus:border-accent',
        extra,
      )}
    />
  );
  return (
    <div className="border-b border-edge p-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
          <Plane className="h-4 w-4 text-content-muted" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold tracking-wide text-content">{tail}</p>
          <p className="text-2xs text-content-muted">
            {value?.displayName || 'Aircraft type not set'}
          </p>
        </div>
        <StatusChip tone={value?.displayName ? 'success' : 'warning'} size="sm">
          {value?.displayName ? 'Configured' : 'Needs type'}
        </StatusChip>
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${tail} from fleet`}
          aria-label={`Remove ${tail} from managed fleet`}
          className="rounded-lg p-2 text-content-subtle transition-colors hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_7rem_8rem_8rem]">
        {field('displayName', 'Verified aircraft type / model')}
        {field('icaoType', 'ICAO type', 'font-mono uppercase')}
        {field('homeBase', 'Home base', 'font-mono uppercase')}
        {field('serialNumber', 'Serial number', 'font-mono')}
      </div>
    </div>
  );
}

export default function AdminSettings({
  currentUser,
  config,
  allTrips = [],
  trackingEnabled = true,
  onOpenAdvanced,
}) {
  const savedFleet = useMemo(() => resolveManagedTails(config), [config]);
  const [fleetTails, setFleetTails] = useState(savedFleet);
  const [aircraftByTail, setAircraftByTail] = useState(() => (
    normalizeAircraftByTail(config?.aircraftByTail, savedFleet)
  ));
  const [newTail, setNewTail] = useState('');
  const [tracking, setTracking] = useState(trackingEnabled !== false);
  const [dutyEmails, setDutyEmails] = useState(
    (config?.dutyAlertEmails?.length ? config.dutyAlertEmails : DEFAULT_ALERT_EMAILS).join(', '),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => setFleetTails(savedFleet), [savedFleet]);
  useEffect(() => {
    setAircraftByTail(normalizeAircraftByTail(config?.aircraftByTail, savedFleet));
  }, [config?.aircraftByTail, savedFleet]);
  useEffect(() => setTracking(trackingEnabled !== false), [trackingEnabled]);
  useEffect(() => {
    if (Array.isArray(config?.dutyAlertEmails) && config.dutyAlertEmails.length) {
      setDutyEmails(config.dutyAlertEmails.join(', '));
    }
  }, [config?.dutyAlertEmails]);

  const scheduleOnly = useMemo(
    () => scheduledOnlyTails(allTrips, fleetTails),
    [allTrips, fleetTails],
  );

  const addTail = (value = newTail) => {
    const tail = normalizeTail(value);
    if (!tail) return;
    setFleetTails((current) => normalizeFleetTails([...current, tail]));
    setAircraftByTail((current) => ({
      ...current,
      [tail]: current[tail] || { displayName: '', icaoType: '', homeBase: '', serialNumber: '' },
    }));
    setNewTail('');
    setMessage(null);
  };

  const removeTail = (tail) => {
    const hasScheduledTrips = scheduleOnly.includes(tail)
      || allTrips.some((trip) => normalizeTail(trip?.info?.tail) === tail);
    const prompt = hasScheduledTrips
      ? `${tail} has scheduled or historical trips. Remove it from the managed fleet? Trips and records will be kept and the aircraft will be labeled schedule-only.`
      : `Remove ${tail} from the managed fleet? Maintenance history will be kept.`;
    if (!window.confirm(prompt)) return;
    setFleetTails((current) => current.filter((item) => item !== tail));
    setAircraftByTail((current) => {
      const next = { ...current };
      delete next[tail];
      return next;
    });
    setMessage(null);
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Your administrator session expired. Sign in again.');
      const emails = dutyEmails
        .split(/[,;\s]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);
      const response = await fetch('/api/admin-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          idToken,
          fleetTails,
          aircraftByTail,
          trackingEnabled: tracking,
          dutyTrackerEnabled: DUTY_TRACKER_ENABLED,
          dutyAlertEmails: emails,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Settings could not be saved');
      setFleetTails(data.fleetTails || []);
      setAircraftByTail(data.aircraftByTail || {});
      setMessage({
        tone: 'success',
        text: data.removed?.length
          ? `Settings saved. ${data.removed.join(', ')} moved out of the managed fleet; schedules and records were preserved.`
          : 'Organization settings saved.',
      });
    } catch (error) {
      setMessage({ tone: 'danger', text: error.message || 'Settings could not be saved' });
    } finally {
      setBusy(false);
    }
  };

  if (currentUser?.role !== 'admin') {
    return (
      <div className="p-6">
        <Card>
          <CardHeader title="Administrator access required" icon={ShieldCheck} />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-surface-sunken p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <PageHeader
          title="Organization settings"
          subtitle="Shared controls for fleet, operations, duty and integrations. Changes apply to every user."
          actions={(
            <>
              <Button variant="secondary" icon={Wrench} onClick={onOpenAdvanced}>
                Advanced tools
              </Button>
              <Button variant="primary" icon={Save} loading={busy} onClick={save}>
                Save changes
              </Button>
            </>
          )}
        />

        {message && (
          <div className={cx(
            'mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm',
            message.tone === 'success'
              ? 'border-success-border bg-success-soft text-success'
              : 'border-danger-border bg-danger-soft text-danger',
          )}>
            {message.tone === 'success'
              ? <Check className="mt-0.5 h-4 w-4 shrink-0" />
              : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            {message.text}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]">
          <div className="space-y-4">
            <Card padded={false}>
              <div className="p-4 pb-3">
                <CardHeader
                  title="Managed fleet"
                  subtitle={`${fleetTails.length} aircraft count toward fleet availability, tracking and maintenance.`}
                  icon={Plane}
                />
                <form
                  className="flex gap-2"
                  onSubmit={(event) => { event.preventDefault(); addTail(); }}
                >
                  <input
                    value={newTail}
                    onChange={(event) => setNewTail(event.target.value.toUpperCase())}
                    placeholder="Add tail number"
                    aria-label="Tail number"
                    className="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-sm uppercase text-content outline-none focus:border-accent"
                  />
                  <Button type="submit" icon={Plus} disabled={!normalizeTail(newTail)}>Add</Button>
                </form>
              </div>
              <div className="border-t border-edge">
                {fleetTails.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-content-muted">
                    No managed aircraft. Add a tail above or promote one from the schedule.
                  </div>
                ) : fleetTails.map((tail) => (
                  <FleetAircraftEditor
                    key={tail}
                    tail={tail}
                    value={aircraftByTail[tail]}
                    onChange={(field, value) => setAircraftByTail((current) => ({
                      ...current,
                      [tail]: { ...(current[tail] || {}), [field]: value },
                    }))}
                    onRemove={() => removeTail(tail)}
                  />
                ))}
              </div>
            </Card>

            <Card padded={false}>
              <div className="p-4 pb-3">
                <CardHeader
                  title="Aircraft found on the schedule"
                  subtitle="These aircraft are not in your fleet. Their trips remain visible, but they do not count toward fleet availability."
                  icon={Radar}
                />
              </div>
              <div className="border-t border-edge">
                {scheduleOnly.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-content-muted">
                    Every scheduled tail is currently part of the managed fleet.
                  </div>
                ) : scheduleOnly.map((tail) => (
                  <TailRow
                    key={tail}
                    tail={tail}
                    detail="Retained on trips and operational history"
                    action={(
                      <Button size="sm" variant="secondary" icon={Plus} onClick={() => addTail(tail)}>
                        Add to fleet
                      </Button>
                    )}
                  />
                ))}
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <Card padded={false}>
              <div className="p-4 pb-3">
                <CardHeader title="Operational services" subtitle="Company-wide feature controls." icon={Settings} />
              </div>
              <div className="border-t border-edge">
                <ToggleRow
                  icon={Radar}
                  title="Live aircraft tracking"
                  description="Allow live FlightAware tracking throughout the application."
                  checked={tracking}
                  onChange={setTracking}
                />
                <ToggleRow
                  icon={ShieldCheck}
                  title="Duty and rest tracking"
                  description="Core safety and compliance feature. Always enabled for pilots and administrators."
                  checked={DUTY_TRACKER_ENABLED}
                  disabled
                />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Duty alert recipients"
                subtitle="Recipients for verified duty periods over 14 hours."
                icon={Bell}
              />
              <textarea
                value={dutyEmails}
                onChange={(event) => setDutyEmails(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent"
                placeholder="name@flyskyway.com, another@flyskyway.com"
              />
              <p className="mt-2 text-2xs text-content-subtle">Separate addresses with commas, spaces or new lines.</p>
            </Card>

            <Card>
              <CardHeader title="Advanced configuration" icon={Wrench} />
              <p className="mb-3 text-sm leading-relaxed text-content-muted">
                Data feed, FlightAware webhook, QuickBooks, FBO backfill, Wear training and tab-order tools remain available here.
              </p>
              <Button block variant="secondary" onClick={onOpenAdvanced}>Open advanced tools</Button>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
