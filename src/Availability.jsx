import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Clock,
  Loader2, MapPin, Plane, Search, ShieldCheck, Users,
} from 'lucide-react';
import {
  AVAILABILITY_RULES,
  formatDuration,
  parseRouting,
  rankTailAvailability,
} from './availability-engine.js';
import {
  resolveAircraftMeta,
  resolveManagedTails,
} from './fleet-config.js';
import {
  subscribeAllOnDuty,
  subscribeRecentForAllPilots,
} from './firebase-duty-v2.js';
import { formatLocalDate, formatLocalTime } from './airports.js';

const MINUTE_MS = 60_000;

function defaultZuluInput() {
  const date = new Date(Date.now() + 60 * MINUTE_MS);
  date.setUTCMinutes(Math.ceil(date.getUTCMinutes() / 15) * 15, 0, 0);
  return date.toISOString().slice(0, 16);
}

function parseZuluInput(value) {
  if (!value) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function zulu(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')} `
    + `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function airportLocal(ms, airport) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const local = formatLocalTime(date, airport);
  const day = formatLocalDate(date, airport);
  return `${day} · ${local.time}${local.tz ? ` ${local.tz}` : ''}`;
}

function operationalTripCount(trips) {
  return (trips || []).filter((trip) => (
    trip?.info?.isFlight !== false
    && trip?.info?.isOps !== false
    && !['HOLD', 'MX', 'TRAINING'].includes(String(trip?.info?.category || '').toUpperCase())
  )).length;
}

function resolveCrewName(user) {
  return String(user?.jetinsightName || user?.name || user?.displayName || '').trim();
}

function eligiblePilot(user) {
  return Boolean(user?.uid || user?.id)
    && user?.approved !== false
    && user?.active !== false
    && ['crew', 'pilot', 'admin', 'ops', 'chief-pilot', 'chief_pilot'].includes(
      String(user?.role || '').toLowerCase(),
    )
    && resolveCrewName(user);
}

function mergeDutyRows(recent, active) {
  const byId = new Map();
  for (const row of [...(recent || []), ...(active || [])]) {
    const key = row?.id || `${row?.pilotUid}-${row?.dutyOnAt}`;
    byId.set(key, row);
  }
  return [...byId.values()];
}

function RulePill({ children }) {
  return (
    <span
      className="rounded border border-edge bg-surface-raised px-2 py-1 text-[10px] text-content-muted"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
    >
      {children}
    </span>
  );
}

function Stat({ label, value, tone = 'text-content' }) {
  return (
    <div className="rounded border border-edge bg-surface-sunken p-2.5">
      <div className="text-[10px] text-content-subtle" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {label}
      </div>
      <div className={`mt-1 font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );
}

function MovementRow({ movement }) {
  const reposition = movement.kind?.startsWith('reposition');
  return (
    <div className="grid grid-cols-[74px_1fr_auto] items-start gap-2 border-b border-edge/60 py-2 last:border-0">
      <span
        className={`mt-0.5 text-[9px] tracking-widest ${reposition ? 'text-warning' : 'text-accent'}`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        {reposition ? 'REPOSITION' : 'REQUEST'}
      </span>
      <div>
        <div className="font-mono text-xs text-content">{movement.label}</div>
        <div className="mt-0.5 text-[10px] text-content-subtle">
          {movement.distanceNm} nm · {formatDuration(movement.flightMinutes)} flight
          {' · '}{formatDuration(movement.blockMinutes)} block
        </div>
      </div>
      <div className="text-right font-mono text-[10px] text-content-muted">
        <div>{zulu(movement.startMs)}</div>
        <div>{zulu(movement.endMs)}</div>
      </div>
    </div>
  );
}

function CrewResult({ crewFit }) {
  if (crewFit?.status === 'not-checked') {
    return (
      <div className="rounded border border-warning-border bg-warning-soft p-3 text-xs text-warning">
        Aircraft fit only. Select PIC/SIC to verify duty, rest, and rolling flight time.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {crewFit.members.map((member) => (
        <div key={member.uid || member.name} className="rounded border border-edge bg-surface-sunken p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-content">
              {member.role ? `${member.role} · ` : ''}{member.name}
            </div>
            <span className={`font-mono text-[10px] ${member.legal ? 'text-success' : 'text-danger'}`}>
              {member.legal ? 'LEGAL' : 'LIMIT'}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="CONTINUOUS DUTY" value={formatDuration(member.dutyMinutes)} />
            <Stat label="ROLLING 24H FLIGHT" value={formatDuration(member.maxRollingFlightMinutes)} />
            <Stat label="REST BEFORE DUTY" value={member.restMinutes == null ? 'No prior duty' : formatDuration(member.restMinutes)} />
            <Stat label="DUTY WINDOW" value={`${zulu(member.dutyStartMs)}–${zulu(member.dutyEndMs).split(' ')[1] || ''}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultCard({ result, index, origin }) {
  if (!result.ok) {
    return (
      <div className="rounded-xl border border-danger-border bg-danger-soft p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-danger" />
            <span className="font-mono text-sm font-semibold text-content">{result.tail}</span>
          </div>
          <span className="font-mono text-[10px] text-danger">NO VERIFIED FIT</span>
        </div>
        <ul className="mt-2 space-y-1">
          {(result.reasons || ['No schedule gap found in the next 7 days']).map((reason) => (
            <li key={reason} className="text-xs text-content-muted">• {reason}</li>
          ))}
        </ul>
      </div>
    );
  }

  const fits = result.delayMinutes === 0;
  return (
    <details
      open={index === 0}
      className={`rounded-xl border ${index === 0 ? 'border-accent-border bg-accent-soft' : 'border-edge bg-surface'}`}
    >
      <summary className="cursor-pointer list-none p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className={`flex h-8 w-8 items-center justify-center rounded-full font-mono text-xs font-bold ${
              index === 0 ? 'bg-accent text-accent-contrast' : 'bg-surface-raised text-content-muted'
            }`}>
              {index + 1}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-base font-semibold text-content">{result.tail}</span>
                <span className="text-xs text-content-muted">{result.profile.label}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`font-mono text-[10px] ${fits ? 'text-success' : 'text-warning'}`}>
                  {fits ? 'FITS REQUESTED TIME' : `DELAY ${formatDuration(result.delayMinutes)}`}
                </span>
                {result.crewFit.status === 'legal' && (
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-success">
                    <ShieldCheck className="h-3 w-3" /> CREW LEGAL
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <div className="font-mono text-sm text-content">{zulu(result.startMs)}</div>
              <div className="text-[10px] text-content-subtle">{airportLocal(result.startMs, origin)}</div>
            </div>
            <ChevronDown className="h-4 w-4 text-content-subtle" />
          </div>
        </div>
      </summary>

      <div className="border-t border-edge px-4 pb-4 pt-3">
        {result.warnings?.map((warning) => (
          <div key={warning} className="mb-2 rounded border border-warning-border bg-warning-soft p-2 text-[11px] text-warning">
            {warning}
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="REQUEST FLIGHT" value={formatDuration(result.requestFlightMinutes)} />
          <Stat label="REQUEST BLOCK" value={formatDuration(result.requestBlockMinutes)} />
          <Stat label="REPOSITION" value={formatDuration(result.repositionMinutes)} tone={result.repositionMinutes ? 'text-warning' : 'text-success'} />
          <Stat label="REPOSITION NM" value={`${result.repositionDistanceNm} nm`} />
        </div>

        <div className="mt-3 rounded border border-edge bg-surface-sunken px-3">
          {result.movements.map((movement) => (
            <MovementRow key={movement.id} movement={movement} />
          ))}
        </div>

        <div className="mt-3">
          <CrewResult crewFit={result.crewFit} />
        </div>

        <div className="mt-3 grid gap-2 text-[10px] text-content-subtle sm:grid-cols-2">
          <div>
            <span className="text-content-muted">Previous tail leg: </span>
            {result.previous ? `${result.previous.label} · in ${zulu(result.previous.endMs)}` : `Home base ${result.homeBase || 'not set'}`}
          </div>
          <div>
            <span className="text-content-muted">Next tail leg: </span>
            {result.next ? `${result.next.label} · out ${zulu(result.next.startMs)}` : 'None in active schedule'}
          </div>
        </div>
      </div>
    </details>
  );
}

export default function Availability({ allTrips = [], config = {}, users = [] }) {
  const [routing, setRouting] = useState('APF TEB');
  const [departureZulu, setDepartureZulu] = useState(defaultZuluInput);
  const [picUid, setPicUid] = useState('');
  const [sicUid, setSicUid] = useState('');
  const [query, setQuery] = useState(null);
  const [error, setError] = useState(null);
  const [recentDuty, setRecentDuty] = useState([]);
  const [activeDuty, setActiveDuty] = useState([]);

  useEffect(() => {
    const unsubRecent = subscribeRecentForAllPilots(3, setRecentDuty);
    const unsubActive = subscribeAllOnDuty(setActiveDuty);
    return () => {
      unsubRecent?.();
      unsubActive?.();
    };
  }, []);

  const pilots = useMemo(
    () => users.filter(eligiblePilot).sort((a, b) => resolveCrewName(a).localeCompare(resolveCrewName(b))),
    [users],
  );
  const managedTails = useMemo(() => resolveManagedTails(config), [config]);
  const fleet = useMemo(() => managedTails.map((tail) => {
    const meta = resolveAircraftMeta(tail, config);
    const scheduledType = allTrips.find((trip) => (
      String(trip?.info?.tail || '').toUpperCase() === tail
      && (trip?.info?.aircraftType || trip?.info?.acType)
    ))?.info;
    return {
      tail,
      icaoType: meta.icaoType || scheduledType?.aircraftType || scheduledType?.acType || '',
      homeBase: meta.homeBase || '',
      displayName: meta.displayName || '',
    };
  }), [managedTails, config, allTrips]);

  const dutyPeriods = useMemo(
    () => mergeDutyRows(recentDuty, activeDuty),
    [recentDuty, activeDuty],
  );

  const results = useMemo(() => {
    if (!query) return [];
    return rankTailAvailability({
      fleet,
      allTrips,
      route: query.route,
      requestedStartMs: query.requestedStartMs,
      crew: query.crew,
      dutyPeriods,
    });
  }, [query, fleet, allTrips, dutyPeriods]);

  function selectedCrew() {
    const build = (uid, role) => {
      const user = pilots.find((pilot) => (pilot.uid || pilot.id) === uid);
      return user ? { uid, name: resolveCrewName(user), role } : null;
    };
    return [build(picUid, 'PIC'), build(sicUid, 'SIC')].filter(Boolean);
  }

  function analyze(event) {
    event.preventDefault();
    setError(null);
    const route = parseRouting(routing);
    const requestedStartMs = parseZuluInput(departureZulu);
    if (route.length < 2) {
      setError('Enter at least two airports, for example APF TEB or APF-TEB-ACK.');
      return;
    }
    if (requestedStartMs == null) {
      setError('Enter a valid requested departure in Zulu.');
      return;
    }
    if (requestedStartMs < Date.now() - 5 * MINUTE_MS) {
      setError('Requested departure is in the past.');
      return;
    }
    if (picUid && sicUid && picUid === sicUid) {
      setError('PIC and SIC must be different people.');
      return;
    }
    setQuery({ route, requestedStartMs, crew: selectedCrew() });
  }

  const available = results.filter((result) => result.ok);
  const best = available[0];

  return (
    <div className="flex-1 overflow-y-auto bg-surface-shell">
      <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Plane className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold text-content">Aircraft Availability</h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-content-muted">
              Insert a routing into the active schedule, including required repositioning,
              performance-derived block time, aircraft turns, and optional crew legality.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <RulePill>45m TURN</RulePill>
            <RulePill>10h FLIGHT / 24h</RulePill>
            <RulePill>14h DUTY</RulePill>
            <RulePill>10h REST</RulePill>
            <RulePill>45m PRE · 30m POST</RulePill>
          </div>
        </div>

        <form onSubmit={analyze} className="rounded-xl border border-edge bg-surface p-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="lg:col-span-2">
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                ROUTING
              </span>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle" />
                <input
                  value={routing}
                  onChange={(event) => setRouting(event.target.value.toUpperCase())}
                  placeholder="APF TEB ACK"
                  className="w-full rounded-lg border border-edge bg-surface-sunken py-2.5 pl-9 pr-3 font-mono text-sm text-content focus:border-accent-border focus:outline-none"
                />
              </div>
              <div className="mt-1 text-[10px] text-content-subtle">
                Multiple legs allowed; 45-minute turns are inserted between them.
              </div>
            </label>

            <label>
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                REQUESTED DEPARTURE · ZULU
              </span>
              <input
                type="datetime-local"
                value={departureZulu}
                onChange={(event) => setDepartureZulu(event.target.value)}
                className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 font-mono text-sm text-content focus:border-accent-border focus:outline-none"
              />
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-accent-contrast hover:opacity-90"
              >
                <Search className="h-4 w-4" /> FIND BEST FIT
              </button>
            </div>

            <label>
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                PIC · OPTIONAL
              </span>
              <select
                value={picUid}
                onChange={(event) => setPicUid(event.target.value)}
                className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 text-sm text-content focus:border-accent-border focus:outline-none"
              >
                <option value="">Aircraft fit only</option>
                {pilots.map((pilot) => (
                  <option key={pilot.uid || pilot.id} value={pilot.uid || pilot.id}>{resolveCrewName(pilot)}</option>
                ))}
              </select>
            </label>

            <label>
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                SIC · OPTIONAL
              </span>
              <select
                value={sicUid}
                onChange={(event) => setSicUid(event.target.value)}
                className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 text-sm text-content focus:border-accent-border focus:outline-none"
              >
                <option value="">Not assigned</option>
                {pilots.map((pilot) => (
                  <option key={pilot.uid || pilot.id} value={pilot.uid || pilot.id}>{resolveCrewName(pilot)}</option>
                ))}
              </select>
            </label>

            <div className="flex items-end lg:col-span-2">
              <div className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2.5">
                <Clock className="h-4 w-4 text-content-subtle" />
                <div className="text-[11px] text-content-muted">
                  Live input: <span className="font-mono text-content">{fleet.length} managed tails</span>
                  {' · '}
                  <span className="font-mono text-content">{operationalTripCount(allTrips)} scheduled flight legs</span>
                  {' · '}
                  <span className="font-mono text-content">{dutyPeriods.length} recent/active duty records</span>
                </div>
              </div>
            </div>
          </div>
        </form>

        {error && (
          <div className="rounded-lg border border-danger-border bg-danger-soft p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {query && (
          <>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-mono text-sm text-content">
                    {query.route.map((airport, index) => (
                      <span key={`${airport}-${index}`} className="inline-flex items-center gap-2">
                        {index > 0 && <ArrowRight className="h-3.5 w-3.5 text-accent" />}
                        {airport}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-content-muted">
                    Requested {zulu(query.requestedStartMs)} · {airportLocal(query.requestedStartMs, query.route[0])}
                  </div>
                </div>
                {best ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <span className="text-xs text-content-muted">
                      Best: <span className="font-mono font-semibold text-content">{best.tail}</span>
                      {' · '}
                      {best.delayMinutes ? `${formatDuration(best.delayMinutes)} delay` : 'requested time'}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-danger">
                    <AlertTriangle className="h-4 w-4" /> No verified fit in seven days
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {results.map((result, index) => (
                <ResultCard
                  key={result.tail}
                  result={result}
                  index={index}
                  origin={query.route[0]}
                />
              ))}
            </div>
          </>
        )}

        {!query && (
          <div className="rounded-xl border border-dashed border-edge p-10 text-center">
            <Users className="mx-auto h-8 w-8 text-content-subtle" />
            <div className="mt-3 text-sm font-semibold text-content">Ready to check the live schedule</div>
            <p className="mx-auto mt-1 max-w-xl text-xs text-content-muted">
              Enter the requested routing and Zulu departure. Add crew to include their
              planned schedule and recorded duty in the result.
            </p>
          </div>
        )}

        <div className="rounded-lg border border-warning-border bg-warning-soft p-3 text-[11px] text-warning">
          Planning assumptions: scheduled block is counted conservatively when actual flight time
          is unavailable; performance uses still-air cruise plus climb/descent and taxi allowance.
          Confirm winds, runway/performance, maintenance status, and crew assignment before accepting a request.
        </div>
      </div>
    </div>
  );
}

