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
  ClipboardList, Gauge, Hotel, MessageSquare, Navigation, Plane,
  Settings, ShieldAlert, Users, Wrench,
} from 'lucide-react';
import { Card, EmptyState, Spinner, StatusChip, cx } from './ui.jsx';
import {
  buildExceptions, buildFleetRows, buildOnDutyRows, buildTodayFlightRows,
  formatCountdown, groupOnDutyCrews,
  isFlightLeg, normalizeTail, summarizeFleet, toMillis, MS_HOUR,
} from './ops-dashboard-data.js';
import { resolveManagedTails } from './fleet-config.js';
import { buildFleetMapScene } from './fleet-tracking.js';
import { buildActiveOpsTrips, computeOutstanding } from './ops-readiness.js';

const TrackingMapLazy = lazy(() => import('./TrackingMap.jsx'));
const DashboardMailboxPreviewLazy = lazy(() => import('./DashboardMailboxPreview.jsx'));

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

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
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

function ModuleCard({ icon: Icon, title, value, detail, tone = 'neutral', onClick }) {
  const toneClass = {
    danger: 'text-danger',
    warning: 'text-warning',
    success: 'text-success',
    accent: 'text-accent',
    neutral: 'text-content',
  }[tone] || 'text-content';
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[8.5rem] flex-col rounded-xl border border-edge bg-surface p-4 text-left transition-colors hover:border-edge-strong hover:bg-surface-raised"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised group-hover:bg-surface">
          <Icon className="h-4 w-4 text-content-muted" />
        </span>
        <ArrowRight className="h-4 w-4 text-content-subtle transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="mt-3 text-sm font-semibold text-content">{title}</span>
      <span className={cx('mt-1 font-mono text-xl font-semibold tabular-nums', toneClass)}>{value}</span>
      <span className="mt-1 text-2xs leading-relaxed text-content-muted">{detail}</span>
    </button>
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
            {row.offFleet ? 'Schedule-only' : (row.type || 'Type not set')}
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

function ExceptionQueue({ items, onSwitchSection, onSelectTrip, onOpenDispatch }) {
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
          onClick={() => {
            if (item.dispatchView) onOpenDispatch?.(item.dispatchView);
            else if (item.tripUid) onSelectTrip?.(item.tripUid);
            else onSwitchSection?.(item.section);
          }}
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

const FLIGHT_PHASE = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  delayed: { label: 'Delayed', tone: 'warning' },
  preflight: { label: 'Preflight', tone: 'info' },
  airborne: { label: 'Airborne', tone: 'accent' },
  landed: { label: 'Landed', tone: 'success' },
  complete: { label: 'Complete', tone: 'success' },
};

function TodayFlightBoard({ rows, onSelectTrip }) {
  if (!rows.length) {
    return <EmptyState icon={CalendarDays} title="No flights scheduled today" />;
  }
  return (
    <div>
      <div className="hidden grid-cols-[5rem_6rem_1fr_6rem_6rem] gap-2 border-b border-edge bg-surface-sunken px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle md:grid">
        <span>Time</span><span>Tail</span><span>Route / crew</span><span>Status</span><span className="text-right">Sched / actual</span>
      </div>
      <div className="divide-y divide-edge">
        {rows.map((row) => {
          const phase = FLIGHT_PHASE[row.phase] || FLIGHT_PHASE.scheduled;
          return (
            <button
              key={row.uid}
              type="button"
              onClick={() => onSelectTrip?.(row.uid)}
              className="grid w-full grid-cols-[4.5rem_1fr_auto] gap-2 px-3 py-3 text-left hover:bg-surface-raised md:grid-cols-[5rem_6rem_1fr_6rem_6rem] md:items-center"
            >
              <span className="font-mono text-xs text-content">{fmtLegTime(row.startAt)}</span>
              <span className="font-mono text-xs font-semibold text-content">{row.tail || 'TBD'}</span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-content">{row.from || '???'} → {row.to || '???'}</span>
                <span className="mt-0.5 block truncate text-2xs text-content-subtle">
                  {[row.pic, row.sic].filter(Boolean).join(' / ') || 'Crew not assigned'}
                </span>
              </span>
              <StatusChip tone={phase.tone} size="sm">{phase.label}</StatusChip>
              <span className="col-span-3 text-right font-mono text-2xs tabular-nums text-content-muted md:col-span-1">
                {fmtDuration(row.scheduledMs)} / {row.actualMs > 0 ? fmtDuration(row.actualMs) : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Crews, not loose pilots: a two-pilot trip is dispatched as a pair. */
function OnDutyBoard({ crews, onSwitchSection }) {
  if (!crews.length) {
    return <EmptyState icon={Users} title="No crew currently on duty" />;
  }
  return (
    <div>
      <div className="hidden grid-cols-[1fr_5.5rem_5rem_5rem_7rem] gap-2 border-b border-edge bg-surface-sunken px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle md:grid">
        <span>Crew</span><span>Duty on</span><span>Time left</span><span>Aircraft</span><span className="text-right">Flight sched / actual</span>
      </div>
      <div className="divide-y divide-edge">
        {crews.map((crew) => (
          <button
            key={crew.id}
            type="button"
            onClick={() => onSwitchSection?.('duty')}
            className="grid w-full grid-cols-[1fr_auto] gap-2 px-3 py-3 text-left hover:bg-surface-raised md:grid-cols-[1fr_5.5rem_5rem_5rem_7rem] md:items-start"
          >
            <span className="min-w-0">
              {crew.members.map((member) => (
                <span key={member.uid} className="flex items-baseline gap-2">
                  <span className="w-7 shrink-0 font-mono text-[10px] font-semibold text-accent">
                    {member.role || '—'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-content">{member.name}</span>
                </span>
              ))}
              <span className="mt-1 block truncate text-2xs text-content-subtle">
                {crew.paired ? 'Two-pilot crew' : 'Single pilot'}
                {' · '}
                {crew.assignedTrips} scheduled leg{crew.assignedTrips === 1 ? '' : 's'}
              </span>
            </span>
            <span className="font-mono text-xs text-content-muted">{fmtLegTime(crew.dutyOnAt)}</span>
            <span className={cx(
              'font-mono text-xs font-semibold tabular-nums',
              crew.overLimit ? 'text-danger' : crew.remainingMs <= 2 * MS_HOUR ? 'text-warning' : 'text-content',
            )}>
              {crew.overLimit ? `+${fmtDuration(crew.overByMs)}` : fmtDuration(crew.remainingMs)}
            </span>
            <span className="font-mono text-xs text-content-muted">{crew.tail || '—'}</span>
            <span className="col-span-2 text-right font-mono text-xs tabular-nums text-content md:col-span-1">
              {fmtDuration(crew.scheduledFlightMs)} / {crew.actualFlightMs > 0 ? fmtDuration(crew.actualFlightMs) : '—'}
              <span className="block text-[9px] text-content-subtle">FlightAware airborne</span>
            </span>
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
  onOpenDispatch,
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
    aircraftByTail: config?.aircraftByTail || {},
    deriveAircraftStatus: deriveForTail,
    now,
  }), [fleetTails, trips, data.positions, data.tripStates, data.aogEvents, config?.aircraftByTail, deriveForTail, now]);
  const managedRows = useMemo(() => fleetRows.filter((row) => !row.offFleet), [fleetRows]);

  const crewRows = useMemo(
    () => buildCrewRows(data.dutyPeriods, data.legalityFn, now),
    [data.dutyPeriods, data.legalityFn, now],
  );
  const todayFlights = useMemo(
    () => buildTodayFlightRows(trips, data.tripStates, data.positions, now),
    [trips, data.tripStates, data.positions, now],
  );
  const onDutyCrews = useMemo(
    () => groupOnDutyCrews(buildOnDutyRows({
      dutyPeriods: data.dutyPeriods,
      trips,
      tripStates: data.tripStates,
      positions: data.positions,
      now,
    })),
    [data.dutyPeriods, trips, data.tripStates, data.positions, now],
  );

  const summary = useMemo(() => summarizeFleet(fleetRows, trips, now), [fleetRows, trips, now]);

  const exceptions = useMemo(() => buildExceptions({
    fleetRows,
    crewRows,
    squawks: data.squawks,
    pilotDocs: data.pilotDocs,
    expenses: data.expenses,
    trips,
    tripStates: data.tripStates,
    now,
    expirationStatus: data.expirationFn,
  }), [fleetRows, crewRows, data.squawks, data.pilotDocs, data.expenses, data.tripStates, data.expirationFn, trips, now]);
  const activeOpsTrips = useMemo(
    () => buildActiveOpsTrips(trips, data.tripStates, now),
    [trips, data.tripStates, now],
  );
  const flaggedTrips = useMemo(() => activeOpsTrips.filter((trip) => (
    computeOutstanding(trip, data.tripStates?.get?.(trip.uid), now)
      .some((item) => item.severity === 'critical' || item.severity === 'warn')
  )).length, [activeOpsTrips, data.tripStates, now]);
  const illegalCrew = crewRows.filter((row) => row.legality?.status === 'illegal').length;
  const crewWarnings = crewRows.filter((row) => row.legality?.status === 'warning').length;
  const maintenanceItems = data.squawks.filter((item) => item?.status !== 'closed').length
    + data.mel.filter((item) => item?.status !== 'cleared' && item?.status !== 'closed').length;

  const mapScene = useMemo(() => buildFleetMapScene({
    fleetTails,
    positions: data.positions,
    trips,
    aircraftByTail: config?.aircraftByTail || {},
    now,
  }), [fleetTails, data.positions, trips, config?.aircraftByTail, now]);

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

        {/* The map is the first operational surface: every managed aircraft,
            airborne live or at its most recent known ground position. */}
        <SectionCard
          title="Live fleet tracking"
          subtitle={`${mapScene.aircraft.length}/${fleetTails.length} managed aircraft located · ${summary.airborne} airborne`}
          icon={Navigation}
          count={fleetTails.length}
        >
          {mapScene.unlocated?.length > 0 && (
            <div className="border-b border-warning-border bg-warning-soft px-3 py-2 text-2xs text-warning">
              No known position for {mapScene.unlocated.join(', ')}. Add a home base in Settings or wait for the next FlightAware position.
            </div>
          )}
          <div className="h-[28rem] md:h-[34rem]">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner label="Loading fleet map" /></div>}>
              <TrackingMapLazy
                scene={mapScene}
                fitKey={`managed-fleet-${mapScene.aircraft.map((item) => `${item.id}:${item.airborne}`).join('|')}`}
                basemapDefault="dark"
                showTrailToggle={false}
                className="h-full w-full"
              />
            </Suspense>
          </div>
        </SectionCard>

        {/* Personal and shared mail at a glance. */}
        <div className="grid gap-4 xl:grid-cols-2">
          <SectionCard title="Personal email" subtitle="Your Microsoft 365 inbox" icon={MessageSquare}>
            <Suspense fallback={<div className="flex min-h-48 items-center justify-center"><Spinner label="Loading personal email" /></div>}>
              <DashboardMailboxPreviewLazy mode="personal" onOpen={() => onSwitchSection?.('mailbox')} />
            </Suspense>
          </SectionCard>
          <SectionCard title="Shared charter inbox" subtitle="charters@flyskyway.com" icon={MessageSquare}>
            <Suspense fallback={<div className="flex min-h-48 items-center justify-center"><Spinner label="Loading shared email" /></div>}>
              <DashboardMailboxPreviewLazy mode="shared" onOpen={() => onSwitchSection?.('inbox')} />
            </Suspense>
          </SectionCard>
        </div>

        {/* Today's movement and the crew available to operate it. */}
        <div className="grid gap-4 2xl:grid-cols-2">
          <SectionCard
            title="Today's flight board"
            subtitle="Schedule and live FlightAware status"
            icon={CalendarDays}
            count={todayFlights.length}
          >
            <TodayFlightBoard rows={todayFlights} onSelectTrip={onSelectTrip} />
          </SectionCard>
          <SectionCard
            title="Crew currently on duty"
            subtitle="PIC and SIC grouped by crew · 14-hour duty clock · scheduled versus FlightAware airborne time"
            icon={Users}
            count={onDutyCrews.length}
          >
            <OnDutyBoard crews={onDutyCrews} onSwitchSection={onSwitchSection} />
          </SectionCard>
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
              onOpenDispatch={onOpenDispatch}
            />
          </SectionCard>
        </div>

        {/* Feature modules — live workload, not a passive shortcut strip. */}
        <div>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-content">Run the operation</h2>
              <p className="mt-0.5 text-2xs text-content-muted">
                Each module opens directly into the workflow and shows its live workload.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <ModuleCard
              icon={Activity}
              title="Flight control"
              value={`${flaggedTrips}/${activeOpsTrips.length}`}
              detail={`${flaggedTrips} flagged · rolling 48-hour board`}
              tone={flaggedTrips ? 'warning' : 'success'}
              onClick={() => onOpenDispatch?.('control')}
            />
            <ModuleCard
              icon={CalendarDays}
              title="Schedule & feeds"
              value={summary.remainingToday}
              detail={`${summary.legsToday} legs today · ${summary.completedToday} completed`}
              tone={summary.remainingToday ? 'accent' : 'success'}
              onClick={() => onOpenDispatch?.('schedule')}
            />
            <ModuleCard
              icon={ClipboardList}
              title="Shift handoff"
              value="LOG"
              detail="Risks, decisions and pinned turnover notes"
              onClick={() => onOpenDispatch?.('handoff')}
            />
            <ModuleCard
              icon={Navigation}
              title="Live tracking"
              value={summary.airborne}
              detail={`${mapScene.aircraft.length} aircraft reporting position`}
              tone={summary.airborne ? 'accent' : 'neutral'}
              onClick={() => onSwitchSection?.('tracking')}
            />
            <ModuleCard
              icon={ShieldAlert}
              title="AOG recovery"
              value={summary.aog}
              detail={summary.aog ? 'Recovery action required' : 'No aircraft grounded'}
              tone={summary.aog ? 'danger' : 'success'}
              onClick={() => onSwitchSection?.('aog')}
            />
            <ModuleCard
              icon={Wrench}
              title="Maintenance"
              value={maintenanceItems}
              detail="Open squawks and MEL deferrals"
              tone={maintenanceItems ? 'warning' : 'success'}
              onClick={() => onSwitchSection?.('maint')}
            />
            <ModuleCard
              icon={Users}
              title="Crew legality"
              value={illegalCrew + crewWarnings}
              detail={`${illegalCrew} illegal · ${crewWarnings} approaching limits`}
              tone={illegalCrew ? 'danger' : crewWarnings ? 'warning' : 'success'}
              onClick={() => onSwitchSection?.('duty')}
            />
            <ModuleCard
              icon={Hotel}
              title="Lodging"
              value="OPEN"
              detail="Cross-trip crew hotel and transport coordination"
              onClick={() => onSwitchSection?.('lodging')}
            />
            <ModuleCard
              icon={MessageSquare}
              title="Operations comms"
              value="LIVE"
              detail="Trip channels, direct messages and push"
              onClick={() => onSwitchSection?.('comms')}
            />
            <ModuleCard
              icon={Settings}
              title="Organization settings"
              value={summary.total}
              detail="Managed aircraft · services · alert policy"
              onClick={() => onSwitchSection?.('settings')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
