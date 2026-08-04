// src/OpsDashboard.jsx
//
// The administrator home screen: an operations control board modelled on how
// a fractional-fleet OCC actually runs a day.
//
// The screen answers four questions, in the order a controller asks them:
//
//   1. Is the operation healthy right now?      — posture strip
//   2. What needs a human immediately?          — exception queue
//   3. Where is every aircraft and is it legal? — fleet board + live map
//   4. What does the rest of the day look like? — day timeline
//
// The previous command centre inferred aircraft status from the calendar
// alone, so an aircraft sitting AOG still read as "Scheduled" and a diverted
// aircraft read as on-plan. This board reads live FlightAware state, the
// maintenance module's airworthiness verdict, open AOG events and duty
// legality, so what it shows is what is actually happening.
//
// All derivation lives in ops-dashboard-data.js. This file subscribes,
// composes and renders.

import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, CalendarDays, ChevronRight, Clock,
  Gauge, Plane, ShieldAlert, Users, Wrench,
} from 'lucide-react';
import { Card, EmptyState, Spinner, StatusChip, cx } from './ui.jsx';
import {
  buildExceptions, buildFleetRows, buildTimeline, formatCountdown,
  isFlightLeg, normalizeTail, summarizeFleet, toMillis, MS_HOUR,
} from './ops-dashboard-data.js';
import { resolveManagedTails } from './fleet-config.js';

const TrackingMapLazy = lazy(() => import('./TrackingMap.jsx'));

const SEVERITY_TONE = { critical: 'danger', warning: 'warning', info: 'info' };

function fmtClock(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone,
    }).format(date);
  } catch {
    return '--:--';
  }
}

function fmtLegTime(value) {
  const ms = toMillis(value);
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ── Live operational data ───────────────────────────────────────────────
   Each source is optional. A dashboard that blanks out because one Firestore
   collection is unavailable is worse than one that renders the rest, so every
   subscription fails closed to an empty list. */

function useOpsData(enabled) {
  const [squawks, setSquawks] = useState([]);
  const [mel, setMel] = useState([]);
  const [positions, setPositions] = useState({});
  const [tripStates, setTripStates] = useState(null);
  const [aogEvents, setAogEvents] = useState([]);
  const [dutyPeriods, setDutyPeriods] = useState([]);
  const [pilotDocs, setPilotDocs] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [deriveStatus, setDeriveStatus] = useState(null);
  const [legalityFn, setLegalityFn] = useState(null);
  const [expirationFn, setExpirationFn] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const unsubs = [];

    const track = (fn) => { if (typeof fn === 'function') unsubs.push(fn); };
    const guard = (label, run) => run().catch((err) => {
      console.warn(`[OpsDashboard] ${label} unavailable:`, err?.message || err);
    });

    guard('maintenance', async () => {
      const m = await import('./firebase-maint.js');
      if (cancelled) return;
      // Store the function itself, not its result — setState treats a bare
      // function as an updater, so it has to be wrapped.
      setDeriveStatus(() => m.deriveAircraftStatus);
      track(m.subscribeSquawks?.((list) => !cancelled && setSquawks(list || [])));
      track(m.subscribeMel?.((list) => !cancelled && setMel(list || [])));
    });

    guard('fleet positions', async () => {
      const m = await import('./firebase-data.js');
      if (cancelled) return;
      track(m.subscribeFleetPositions?.((map) => !cancelled && setPositions(map || {})));
      track(m.subscribeAllTripStates?.((map) => !cancelled && setTripStates(map || null)));
    });

    guard('AOG events', async () => {
      const m = await import('./firebase-aog.js');
      if (cancelled) return;
      track(m.subscribeToAogEvents?.((list) => !cancelled && setAogEvents(list || [])));
    });

    guard('duty', async () => {
      const [duty, legality] = await Promise.all([
        import('./firebase-duty-v2.js'),
        import('./duty-legality.js'),
      ]);
      if (cancelled) return;
      setLegalityFn(() => legality.evaluateCurrent);
      track(duty.subscribeRecentForAllPilots?.(30, (list) => !cancelled && setDutyPeriods(list || [])));
    });

    guard('crew documents', async () => {
      const m = await import('./firebase-pilotdocs.js');
      if (cancelled) return;
      setExpirationFn(() => m.expirationStatus);
      track(m.subscribeToAllPilotDocs?.((list) => !cancelled && setPilotDocs(list || [])));
    });

    guard('expenses', async () => {
      const m = await import('./firebase-expenses.js');
      if (cancelled) return;
      track(m.subscribeToAllExpenses?.((list) => !cancelled && setExpenses(list || [])));
    });

    return () => {
      cancelled = true;
      for (const unsub of unsubs) {
        try { unsub(); } catch { /* already torn down */ }
      }
    };
  }, [enabled]);

  return {
    squawks, mel, positions, tripStates, aogEvents,
    dutyPeriods, pilotDocs, expenses,
    deriveStatus, legalityFn, expirationFn,
  };
}

/* ── Crew posture ───────────────────────────────────────────────────────── */

function buildCrewRows(dutyPeriods, evaluateCurrent, now) {
  if (!evaluateCurrent) return [];
  const byPilot = new Map();
  for (const period of dutyPeriods) {
    if (!period?.pilotUid) continue;
    if (!byPilot.has(period.pilotUid)) {
      byPilot.set(period.pilotUid, {
        uid: period.pilotUid,
        name: period.pilotName || 'Unknown pilot',
        periods: [],
      });
    }
    byPilot.get(period.pilotUid).periods.push(period);
  }

  return Array.from(byPilot.values()).map((pilot) => {
    const sorted = [...pilot.periods].sort((a, b) => (b.dutyOnAt || 0) - (a.dutyOnAt || 0));
    const active = sorted.find((p) => p.status === 'on') || null;
    let state = 'AVAILABLE';
    if (active) state = 'ON DUTY';
    else {
      const lastOff = sorted.find((p) => p.status === 'off');
      if (lastOff?.dutyOffAt && now - lastOff.dutyOffAt < 10 * MS_HOUR) state = 'RESTING';
    }
    let legality = { status: 'legal', blockers: [], warnings: [] };
    try {
      legality = evaluateCurrent(pilot.periods, [], now, active?.crewType || 'two');
    } catch (err) {
      console.warn('[OpsDashboard] legality evaluation failed:', err?.message || err);
    }
    return { ...pilot, active, state, legality };
  }).sort((a, b) => {
    const rank = (row) => (row.legality.status === 'illegal' ? 0
      : row.legality.status === 'warning' ? 1
        : row.state === 'ON DUTY' ? 2 : 3);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
}

/* ── Presentation ───────────────────────────────────────────────────────── */

function PostureTile({ icon: Icon, label, value, hint, tone = 'neutral' }) {
  const toneText = {
    neutral: 'text-content',
    accent: 'text-accent',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone] || 'text-content';

  return (
    <div className="rounded-xl border border-edge bg-surface p-3">
      <div className="flex items-center gap-1.5 text-content-subtle">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        <span className="truncate text-2xs font-medium">{label}</span>
      </div>
      <p className={cx('mt-1.5 font-mono text-2xl font-semibold leading-none tabular-nums', toneText)}>
        {value}
      </p>
      {hint && <p className="mt-1.5 truncate text-2xs text-content-subtle">{hint}</p>}
    </div>
  );
}

function FleetRow({ row, onSelectTrip }) {
  const { location } = row;
  const airborne = location.kind === 'airborne';
  const restricted = row.airworthiness.status === 'RESTRICTED';
  const grounded = row.state.id === 'AOG';

  return (
    <div
      className={cx(
        'grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 border-b border-edge px-3 py-3 last:border-b-0',
        'md:grid-cols-[8.5rem_7rem_1fr_1fr_5.5rem] md:items-center md:gap-3',
        grounded && 'bg-danger-soft',
      )}
    >
      {/* Identity */}
      <div className="flex items-center gap-2">
        <span
          className={cx(
            'h-2 w-2 shrink-0 rounded-full',
            grounded ? 'bg-danger' : airborne ? 'bg-accent' : restricted ? 'bg-warning' : 'bg-content-subtle',
            airborne && 'animate-pulse',
          )}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold leading-none text-content">{row.tail}</p>
          <p className="mt-1 truncate text-2xs text-content-subtle">
            {row.offFleet ? 'Off-fleet' : (row.type || 'Managed')}
          </p>
        </div>
      </div>

      {/* State */}
      <div className="md:justify-self-start">
        <StatusChip tone={row.state.tone} size="sm">{row.state.label}</StatusChip>
        {restricted && !grounded && (
          <p className="mt-1 text-2xs text-warning">MEL ×{row.airworthiness.melOpen}</p>
        )}
      </div>

      {/* Position */}
      <div className="col-span-2 min-w-0 md:col-span-1">
        {airborne ? (
          <>
            <p className="truncate font-mono text-xs text-content">{location.label}</p>
            <p className="mt-1 truncate text-2xs text-content-subtle">
              {location.altitude != null ? `FL${Math.round(location.altitude / 100)}` : '—'}
              {location.groundspeed != null ? ` · ${Math.round(location.groundspeed)} kt` : ''}
              {location.progress != null ? ` · ${Math.round(location.progress)}%` : ''}
            </p>
          </>
        ) : (
          <>
            <p className="truncate font-mono text-xs text-content">
              {grounded ? `AOG ${location.label}` : `On ground ${location.label}`}
            </p>
            <p className="mt-1 truncate text-2xs text-content-subtle">
              {grounded
                ? (row.airworthiness.reasons[0] || 'Grounding discrepancy open')
                : `${row.flightLegsToday} leg${row.flightLegsToday === 1 ? '' : 's'} · ${row.hoursToday.toFixed(1)}h today`}
            </p>
          </>
        )}
      </div>

      {/* Next movement */}
      <div className="col-span-2 min-w-0 md:col-span-1">
        {row.activeLeg || row.nextLeg ? (
          <button
            type="button"
            onClick={() => onSelectTrip?.((row.activeLeg || row.nextLeg).uid)}
            className="group w-full text-left"
          >
            <p className="flex items-center gap-1.5 truncate font-mono text-xs text-content group-hover:text-accent">
              {(row.activeLeg || row.nextLeg).info?.from || '???'}
              <ArrowRight className="h-3 w-3 shrink-0 text-accent" />
              {(row.activeLeg || row.nextLeg).info?.to || '???'}
            </p>
            <p className="mt-1 truncate text-2xs text-content-subtle">
              {row.activeLeg ? 'In progress · ' : ''}
              {fmtLegTime((row.activeLeg || row.nextLeg).start)}
              {(row.activeLeg || row.nextLeg).info?.pic
                ? ` · ${(row.activeLeg || row.nextLeg).info.pic.split(/\s+/)[0]}`
                : ' · no PIC'}
            </p>
          </button>
        ) : (
          <p className="text-2xs text-content-subtle">
            {row.completedToday > 0 ? 'Day complete' : 'Nothing scheduled'}
          </p>
        )}
      </div>

      {/* ETA / next off */}
      <div className="col-span-2 text-2xs text-content-subtle md:col-span-1 md:text-right">
        {airborne && location.eta ? (
          <>
            <span className="block text-content">ETA {fmtLegTime(location.eta)}</span>
            <span className="block">{formatCountdown(toMillis(location.eta) - Date.now())} out</span>
          </>
        ) : row.nextLeg ? (
          <>
            <span className="block text-content">{fmtLegTime(row.nextLeg.start)}</span>
            <span className="block">in {formatCountdown((toMillis(row.nextLeg.start) || 0) - Date.now())}</span>
          </>
        ) : (
          <span>—</span>
        )}
      </div>
    </div>
  );
}

function ExceptionQueue({ items, onSwitchSection, onSelectTrip }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No open exceptions"
        description="Every aircraft is airworthy, crew are legal, and nothing is waiting on a decision."
      />
    );
  }

  return (
    <div className="divide-y divide-edge">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => (item.tripUid ? onSelectTrip?.(item.tripUid) : onSwitchSection?.(item.section))}
          className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface-raised"
        >
          <span
            className={cx(
              'mt-1 h-2 w-2 shrink-0 rounded-full',
              item.severity === 'critical' ? 'bg-danger'
                : item.severity === 'warning' ? 'bg-warning' : 'bg-info',
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-content">{item.title}</span>
              <StatusChip tone={SEVERITY_TONE[item.severity]} size="sm">{item.group}</StatusChip>
            </span>
            <span className="mt-1 block truncate text-2xs text-content-muted">{item.detail}</span>
            {item.meta && <span className="mt-0.5 block truncate text-2xs text-content-subtle">{item.meta}</span>}
          </span>
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-content-subtle" />
        </button>
      ))}
    </div>
  );
}

function DayTimeline({ timeline, onSelectTrip }) {
  return (
    <div className="px-3 pb-3">
      <div className="relative ml-[4.5rem] mb-1 h-4">
        {timeline.ticks.map((tick) => (
          <span
            key={tick.at}
            className="absolute -translate-x-1/2 font-mono text-[10px] text-content-subtle"
            style={{ left: `${tick.left}%` }}
          >
            {String(tick.label).padStart(2, '0')}
          </span>
        ))}
      </div>

      <div className="space-y-1">
        {timeline.rows.map((row) => (
          <div key={row.tail} className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono text-[11px] text-content-muted">{row.tail}</span>
            <div className="relative h-7 flex-1 overflow-hidden rounded-md border border-edge bg-surface-sunken">
              {timeline.ticks.slice(1, -1).map((tick) => (
                <span
                  key={tick.at}
                  className="absolute top-0 h-full w-px bg-edge"
                  style={{ left: `${tick.left}%` }}
                  aria-hidden="true"
                />
              ))}
              {row.blocks.map((block) => (
                <button
                  key={block.uid}
                  type="button"
                  onClick={() => onSelectTrip?.(block.uid)}
                  title={`${block.from} → ${block.to}`}
                  className={cx(
                    'absolute top-1 flex h-5 items-center justify-center overflow-hidden rounded px-1 text-[10px] font-medium',
                    block.active ? 'bg-accent text-accent-contrast'
                      : block.done ? 'bg-surface-raised text-content-subtle'
                        : block.isFlight ? 'bg-accent-soft text-accent' : 'bg-warning-soft text-warning',
                    'border',
                    block.active ? 'border-accent' : block.isFlight ? 'border-accent-border' : 'border-warning-border',
                  )}
                  style={{ left: `${block.left}%`, width: `${block.width}%` }}
                >
                  <span className="truncate">{block.from}–{block.to}</span>
                </button>
              ))}
              <span
                className="pointer-events-none absolute top-0 z-10 h-full w-0.5 bg-danger"
                style={{ left: `${timeline.nowPct}%` }}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CrewPanel({ rows, onSwitchSection }) {
  const onDuty = rows.filter((r) => r.state === 'ON DUTY');
  const attention = rows.filter((r) => r.legality.status !== 'legal');
  const shown = [...attention, ...onDuty.filter((r) => !attention.includes(r))].slice(0, 6);

  if (rows.length === 0) {
    return <EmptyState icon={Users} title="No duty records" description="Duty periods appear here once crew start logging." />;
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-2 px-3 pb-3">
        <PostureTile label="On duty" value={onDuty.length} tone="accent" />
        <PostureTile label="Resting" value={rows.filter((r) => r.state === 'RESTING').length} />
        <PostureTile
          label="Not legal"
          value={rows.filter((r) => r.legality.status === 'illegal').length}
          tone={rows.some((r) => r.legality.status === 'illegal') ? 'danger' : 'neutral'}
        />
      </div>
      <div className="divide-y divide-edge border-t border-edge">
        {shown.map((row) => (
          <button
            key={row.uid}
            type="button"
            onClick={() => onSwitchSection?.('duty')}
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-raised"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm text-content">{row.name}</span>
              <span className="block truncate text-2xs text-content-subtle">
                {row.state === 'ON DUTY' && row.active?.dutyOnAt
                  ? `On duty ${formatCountdown(Date.now() - row.active.dutyOnAt)}`
                  : row.state.toLowerCase()}
              </span>
            </span>
            <StatusChip
              tone={row.legality.status === 'illegal' ? 'danger'
                : row.legality.status === 'warning' ? 'warning' : 'success'}
              size="sm"
            >
              {row.legality.status === 'illegal' ? 'Illegal'
                : row.legality.status === 'warning' ? 'Watch' : 'Legal'}
            </StatusChip>
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, icon: Icon, count, action, children, className = '' }) {
  return (
    <Card padded={false} className={cx('overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-4 w-4 shrink-0 text-content-subtle" />}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-content">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-2xs text-content-subtle">{subtitle}</p>}
          </div>
          {count != null && (
            <span className="ml-1 shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-2xs text-content-muted">
              {count}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/* ── Screen ─────────────────────────────────────────────────────────────── */

export default function OpsDashboard({
  currentUser,
  trips = [],
  users = [],
  config = null,
  onSelectTrip,
  onSwitchSection,
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const data = useOpsData(currentUser?.role === 'admin' || currentUser?._impersonating === true);

  // The managed fleet. Tails that appear only on the schedule are added by
  // buildFleetRows and flagged off-fleet, so they stay visible without
  // distorting availability.
  const fleetTails = useMemo(() => resolveManagedTails(config), [config]);

  const deriveForTail = useMemo(() => {
    if (!data.deriveStatus) return null;
    return (tail) => data.deriveStatus(tail, data.squawks, data.mel);
  }, [data.deriveStatus, data.squawks, data.mel]);

  const fleetRows = useMemo(() => buildFleetRows({
    fleetTails,
    trips,
    positions: data.positions,
    tripStates: data.tripStates,
    aogEvents: data.aogEvents,
    deriveAircraftStatus: deriveForTail,
    now,
  }), [fleetTails, trips, data.positions, data.tripStates, data.aogEvents, deriveForTail, now]);
  const managedRows = useMemo(() => fleetRows.filter((row) => !row.offFleet), [fleetRows]);

  const crewRows = useMemo(
    () => buildCrewRows(data.dutyPeriods, data.legalityFn, now),
    [data.dutyPeriods, data.legalityFn, now],
  );

  const summary = useMemo(() => summarizeFleet(fleetRows, trips, now), [fleetRows, trips, now]);

  const exceptions = useMemo(() => buildExceptions({
    fleetRows,
    crewRows,
    squawks: data.squawks,
    pilotDocs: data.pilotDocs,
    expenses: data.expenses,
    trips,
    now,
    expirationStatus: data.expirationFn,
  }), [fleetRows, crewRows, data.squawks, data.pilotDocs, data.expenses, data.expirationFn, trips, now]);

  const timeline = useMemo(() => buildTimeline(fleetRows, now), [fleetRows, now]);

  const mapScene = useMemo(() => {
    const aircraft = [];
    for (const row of fleetRows) {
      const p = row.position;
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      aircraft.push({
        id: row.tail,
        tail: row.tail,
        lat: p.latitude,
        lon: p.longitude,
        heading: Number.isFinite(p.heading) ? p.heading : 0,
        altitude: Number.isFinite(p.altitude) ? p.altitude : null,
        groundspeed: Number.isFinite(p.groundspeed) ? p.groundspeed : null,
        airborne: p.airborne === true,
        groundedAt: p.groundedAt || null,
        showLabel: true,
      });
    }
    return { aircraft, airports: [], routes: [], trail: [], projected: null };
  }, [fleetRows]);

  const criticalCount = exceptions.filter((e) => e.severity === 'critical').length;
  const nowDate = new Date(now);
  const controllerName = (currentUser?.callsign || currentUser?.name || '').split(/\s+/)[0];

  const nextDeparture = useMemo(() => {
    const upcoming = trips
      .filter((t) => isFlightLeg(t) && (toMillis(t.start) || 0) > now)
      .sort((a, b) => (toMillis(a.start) || 0) - (toMillis(b.start) || 0));
    return upcoming[0] || null;
  }, [trips, now]);

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-slate-950">
      <div className="mx-auto max-w-[100rem] space-y-4 p-3 pb-10 md:p-5 lg:p-6">

        {/* Command header. Deliberately a div: theme-classy.css styles every
            <header> element as the dark app crown, which would render this
            block dark-on-dark in the light theme. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-2xs font-medium uppercase tracking-wider text-content-subtle">
              Operations control
            </p>
            <h1 className="mt-1 text-xl font-semibold text-content md:text-2xl">
              Fleet status{controllerName ? ` · ${controllerName}` : ''}
            </h1>
            <p className="mt-1 text-2xs text-content-muted">
              {criticalCount > 0
                ? `${criticalCount} item${criticalCount === 1 ? '' : 's'} need immediate action`
                : 'No critical exceptions open'}
              {nextDeparture
                ? ` · next departure ${nextDeparture.info?.tail || ''} in ${formatCountdown((toMillis(nextDeparture.start) || 0) - now)}`
                : ' · no further departures scheduled'}
            </p>
          </div>
          <div className="flex items-center gap-4 rounded-xl border border-edge bg-surface px-3 py-2">
            <div className="text-right">
              <p className="font-mono text-lg font-semibold leading-none text-content tabular-nums">
                {fmtClock(nowDate, 'UTC')}
              </p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-content-subtle">Zulu</p>
            </div>
            <span className="h-8 w-px bg-edge" aria-hidden="true" />
            <div className="text-right">
              <p className="font-mono text-lg font-semibold leading-none text-content tabular-nums">
                {fmtClock(nowDate, undefined)}
              </p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-content-subtle">Local</p>
            </div>
          </div>
        </div>

        {/* Posture strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <PostureTile
            icon={Plane} label="Available" value={`${summary.available}/${summary.total}`}
            hint={summary.restricted > 0 ? `${summary.restricted} on MEL` : 'Full airworthy fleet'}
            tone={summary.available < summary.total ? 'warning' : 'success'}
          />
          <PostureTile
            icon={Activity} label="Airborne" value={summary.airborne}
            hint={summary.airborne > 0 ? 'Live tracking active' : 'None in the air'}
            tone={summary.airborne > 0 ? 'accent' : 'neutral'}
          />
          <PostureTile
            icon={ShieldAlert} label="AOG" value={summary.aog}
            hint={summary.aog > 0 ? 'Recovery required' : 'None grounded'}
            tone={summary.aog > 0 ? 'danger' : 'success'}
          />
          <PostureTile
            icon={CalendarDays} label="Legs today" value={summary.legsToday}
            hint={`${summary.completedToday} flown · ${summary.remainingToday} to go`}
          />
          <PostureTile
            icon={Clock} label="Block hours" value={summary.hoursToday.toFixed(1)}
            hint="Scheduled today"
          />
          <PostureTile
            icon={AlertTriangle} label="Exceptions" value={exceptions.length}
            hint={criticalCount > 0 ? `${criticalCount} critical` : 'Nothing critical'}
            tone={criticalCount > 0 ? 'danger' : exceptions.length > 0 ? 'warning' : 'success'}
          />
        </div>

        {/* Fleet board + exception queue */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <SectionCard
            title="Fleet board"
            subtitle={summary.offFleet > 0
              ? `${summary.total} managed · ${summary.offFleet} schedule-only aircraft excluded`
              : 'Live position, airworthiness and next movement'}
            icon={Gauge}
            count={managedRows.length}
          >
            <div className="hidden grid-cols-[8.5rem_7rem_1fr_1fr_5.5rem] gap-3 border-b border-edge bg-surface-sunken px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle md:grid">
              <span>Aircraft</span>
              <span>State</span>
              <span>Position</span>
              <span>Current / next leg</span>
              <span className="text-right">ETA</span>
            </div>
            {managedRows.length === 0 ? (
              <EmptyState icon={Plane} title="No aircraft configured" description="Add tails to the fleet to populate the board." />
            ) : (
              managedRows.map((row) => (
                <FleetRow key={row.tail} row={row} onSelectTrip={onSelectTrip} />
              ))
            )}
          </SectionCard>

          <SectionCard
            title="Exceptions"
            subtitle="Ranked by operational cost"
            icon={AlertTriangle}
            count={exceptions.length}
          >
            <ExceptionQueue
              items={exceptions}
              onSwitchSection={onSwitchSection}
              onSelectTrip={onSelectTrip}
            />
          </SectionCard>
        </div>

        {/* Day timeline */}
        <SectionCard
          title="Next 24 hours"
          subtitle="Scheduled blocks by aircraft — the red line is now"
          icon={CalendarDays}
        >
          {timeline.rows.length === 0
            ? <EmptyState icon={CalendarDays} title="Nothing scheduled today" />
            : <DayTimeline timeline={timeline} onSelectTrip={onSelectTrip} />}
        </SectionCard>

        {/* Map + crew */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <SectionCard
            title="Live fleet map"
            subtitle={`${mapScene.aircraft.length} aircraft reporting position`}
            icon={Plane}
          >
            <div className="h-[22rem]">
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner label="Loading map" /></div>}>
                <TrackingMapLazy
                  scene={mapScene}
                  fitKey={`fleet-${mapScene.aircraft.length}`}
                  basemapDefault="dark"
                  showTrailToggle={false}
                  className="h-full w-full"
                />
              </Suspense>
            </div>
          </SectionCard>

          <SectionCard title="Crew posture" subtitle="Duty state and Part 135 legality" icon={Users}>
            <CrewPanel rows={crewRows} onSwitchSection={onSwitchSection} />
          </SectionCard>
        </div>

        {/* Maintenance shortcut strip */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            ['Dispatch', 'ops', Activity],
            ['Maintenance', 'maint', Wrench],
            ['Duty', 'duty', Users],
            ['Schedule', 'schedule', CalendarDays],
          ].map(([label, section, Icon]) => (
            <button
              key={section}
              type="button"
              onClick={() => onSwitchSection?.(section)}
              className="flex items-center justify-center gap-2 rounded-xl border border-edge bg-surface px-3 py-3 text-2xs font-semibold text-content-muted hover:border-edge-strong hover:text-content"
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
