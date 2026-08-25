import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, DollarSign,
  MapPin, Plane, Plus, RotateCcw, Search, ShieldCheck, Trash2, Users,
} from 'lucide-react';
import {
  AVAILABILITY_RULES,
  aircraftProfile,
  formatDuration,
  planLiveLegAssignments,
} from './availability-engine.js';
import {
  resolveAircraftMeta,
  resolveManagedTails,
} from './fleet-config.js';
import {
  subscribeAllOnDuty,
  subscribeOutsideReportForAllPilots,
  subscribeRecentForAllPilots,
} from './firebase-duty-v2.js';
import { formatLocalDate, formatLocalTime } from './airports.js';

const MINUTE_MS = 60_000;
let nextLegId = 1;

function defaultZuluInput(offsetHours = 1) {
  const date = new Date(Date.now() + offsetHours * 60 * MINUTE_MS);
  date.setUTCMinutes(Math.ceil(date.getUTCMinutes() / 15) * 15, 0, 0);
  return date.toISOString().slice(0, 16);
}

function zuluInputFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function parseZuluInput(value) {
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function createLeg(from = 'APF', to = 'TEB', departureZulu = defaultZuluInput()) {
  return { id: `live-${nextLegId++}`, from, to, departureZulu };
}

function zulu(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')} `
    + `${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}Z`;
}

function local(ms, airport) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const time = formatLocalTime(date, airport);
  return `${formatLocalDate(date, airport)} · ${time.time}${time.tz ? ` ${time.tz}` : ''}`;
}

function money(value) {
  if (!Number.isFinite(value)) return 'Not configured';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
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
    byId.set(row?.id || `${row?.pilotUid}-${row?.dutyOnAt}`, row);
  }
  return [...byId.values()];
}

function RulePill({ children }) {
  return (
    <span className="rounded border border-edge bg-surface-raised px-2 py-1 font-mono text-[10px] text-content-muted">
      {children}
    </span>
  );
}

function PriceStat({ label, value, tone = 'text-content', sub }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-sunken p-3">
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[9px] text-content-subtle">{sub}</div>}
    </div>
  );
}

function TypeFilters({ options, selected, onChange }) {
  const set = new Set(selected);
  const toggle = (id) => {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange([...set]);
  };
  return (
    <div>
      <div className="mb-1 text-[10px] tracking-widest text-content-subtle" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        AIRCRAFT TYPES TO CHECK · MULTI-SELECT
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onChange([])}
          className={`rounded border px-2.5 py-1.5 font-mono text-[10px] ${
            selected.length === 0
              ? 'border-accent-border bg-accent-soft text-accent'
              : 'border-edge bg-surface-sunken text-content-muted'
          }`}
        >
          ALL TYPES
        </button>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => toggle(option.id)}
            className={`rounded border px-2.5 py-1.5 font-mono text-[10px] ${
              set.has(option.id)
                ? 'border-accent-border bg-accent-soft text-accent'
                : 'border-edge bg-surface-sunken text-content-muted'
            }`}
          >
            {option.label} · {option.count}
          </button>
        ))}
      </div>
    </div>
  );
}

function LegEditor({ leg, index, canRemove, onChange, onRemove }) {
  const set = (field, value) => onChange({ ...leg, [field]: value });
  return (
    <div className="rounded-lg border border-edge bg-surface-sunken p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold tracking-widest text-accent">
          LIVE LEG {index + 1}
        </span>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1.5 text-content-subtle hover:bg-danger-soft hover:text-danger"
            title="Remove live leg"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_1.35fr] sm:items-center">
        <input
          value={leg.from}
          onChange={(event) => set('from', event.target.value.toUpperCase())}
          placeholder="FROM"
          maxLength={8}
          className="rounded border border-edge bg-surface px-3 py-2 font-mono text-sm uppercase text-content outline-none focus:border-accent"
        />
        <ArrowRight className="hidden h-4 w-4 text-content-subtle sm:block" />
        <input
          value={leg.to}
          onChange={(event) => set('to', event.target.value.toUpperCase())}
          placeholder="TO"
          maxLength={8}
          className="rounded border border-edge bg-surface px-3 py-2 font-mono text-sm uppercase text-content outline-none focus:border-accent"
        />
        <input
          type="datetime-local"
          value={leg.departureZulu}
          onChange={(event) => set('departureZulu', event.target.value)}
          className="rounded border border-edge bg-surface px-3 py-2 font-mono text-xs text-content outline-none focus:border-accent"
          title="Requested departure in Zulu"
        />
      </div>
      <div className="mt-1 text-[9px] text-content-subtle">Requested departure is entered in Zulu.</div>
    </div>
  );
}

function MovementLine({ movement }) {
  const repo = movement.kind?.startsWith('reposition');
  return (
    <div className="grid grid-cols-[72px_1fr_auto] gap-2 border-b border-edge/60 py-2 last:border-0">
      <span className={`font-mono text-[9px] tracking-widest ${repo ? 'text-warning' : 'text-accent'}`}>
        {repo ? 'REPOSITION' : 'LIVE'}
      </span>
      <div>
        <div className="font-mono text-xs text-content">{movement.label}</div>
        <div className="text-[9px] text-content-subtle">
          {movement.distanceNm} nm · {formatDuration(movement.flightMinutes)} flight · {formatDuration(movement.blockMinutes)} block
        </div>
      </div>
      <div className="text-right font-mono text-[9px] text-content-muted">
        <div>{zulu(movement.startMs)}</div>
        <div>{zulu(movement.endMs)}</div>
      </div>
    </div>
  );
}

function OptionButton({ option, selected, onSelect }) {
  const unavailable = !option.ok;
  return (
    <button
      type="button"
      onClick={() => onSelect(option.tail)}
      className={`w-full rounded-lg border p-2.5 text-left ${
        selected
          ? 'border-accent-border bg-accent-soft'
          : unavailable
            ? 'border-danger-border/40 bg-danger-soft/40'
            : 'border-edge bg-surface-sunken hover:border-accent-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-mono text-xs font-semibold text-content">{option.tail}</span>
          <span className="ml-2 text-[10px] text-content-subtle">{option.profile?.label || option.icaoType}</span>
        </div>
        <span className={`font-mono text-[9px] ${
          unavailable ? 'text-danger' : option.delayMinutes ? 'text-warning' : 'text-success'
        }`}>
          {unavailable ? 'NO FIT' : option.delayMinutes ? `+${formatDuration(option.delayMinutes)}` : 'ON TIME'}
        </span>
      </div>
      {option.ok && (
        <div className="mt-1 grid grid-cols-3 gap-1 text-[9px] text-content-muted">
          <span>Repo {formatDuration(option.repositionMinutes)}</span>
          <span>Cost {money(option.pricing.cost)}</span>
          <span>Sell {money(option.pricing.sell)}</span>
        </div>
      )}
    </button>
  );
}

function PlannedLeg({ proposal, assignment, onAssign }) {
  const selected = proposal.selected;
  return (
    <div className="rounded-xl border border-edge bg-surface">
      <div className="border-b border-edge p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft font-mono text-[10px] font-bold text-accent">
                {proposal.index + 1}
              </span>
              <span className="font-mono text-sm font-semibold text-content">
                {proposal.from} <ArrowRight className="mx-1 inline h-3.5 w-3.5 text-accent" /> {proposal.to}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-content-muted">
              Requested {zulu(proposal.requestedStartMs)} · {local(proposal.requestedStartMs, proposal.from)}
            </div>
          </div>
          <label className="min-w-[15rem]">
            <span className="mb-1 block text-[9px] tracking-widest text-content-subtle">SELECT TAIL FOR THIS LEG</span>
            <select
              value={assignment || ''}
              onChange={(event) => onAssign(event.target.value)}
              className="w-full rounded border border-edge bg-surface-sunken px-3 py-2 font-mono text-xs text-content outline-none focus:border-accent"
            >
              <option value="">Recommended · {proposal.recommendedTail || 'No fit'}</option>
              {proposal.options.map((option) => (
                <option key={option.tail} value={option.tail}>
                  {option.tail} · {option.ok
                    ? `${option.delayMinutes ? `${formatDuration(option.delayMinutes)} delay` : 'on time'} · cost ${money(option.pricing.cost)} · sell ${money(option.pricing.sell)}`
                    : 'no verified fit'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.28fr)]">
        <div>
          <div className="mb-2 text-[9px] tracking-widest text-content-subtle">TAIL RECOMMENDATIONS</div>
          <div className="space-y-1.5">
            {proposal.options.map((option) => (
              <OptionButton
                key={option.tail}
                option={option}
                selected={selected?.tail === option.tail}
                onSelect={onAssign}
              />
            ))}
          </div>
        </div>

        <div>
          {!selected?.ok ? (
            <div className="rounded border border-danger-border bg-danger-soft p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-danger">
                <AlertTriangle className="h-4 w-4" /> Selected tail has no verified fit
              </div>
              <ul className="mt-2 space-y-1 text-xs text-content-muted">
                {(selected?.reasons || ['Choose another tail or adjust the requested departure']).map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-base font-semibold text-content">{selected.tail}</span>
                  <span className="ml-2 text-xs text-content-muted">{selected.profile.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[10px] ${selected.delayMinutes ? 'text-warning' : 'text-success'}`}>
                    {selected.delayMinutes ? `DELAY ${formatDuration(selected.delayMinutes)}` : 'FITS REQUESTED'}
                  </span>
                  {selected.crewFit?.status === 'legal' && (
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-success">
                      <ShieldCheck className="h-3 w-3" /> CREW LEGAL
                    </span>
                  )}
                </div>
              </div>

              {selected.consumedPositioning?.length > 0 && (
                <div className="rounded border border-success-border bg-success-soft p-2 text-[10px] text-success">
                  Replaces scheduled repo: {selected.consumedPositioning.map((leg) => leg.label).join(', ')}.
                </div>
              )}
              {selected.warnings?.map((warning) => (
                <div key={warning} className="rounded border border-warning-border bg-warning-soft p-2 text-[10px] text-warning">
                  {warning}
                </div>
              ))}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <PriceStat label="Leg cost" value={money(selected.pricing.cost)} sub="Live + reposition block" />
                <PriceStat label="Leg sell" value={money(selected.pricing.sell)} sub="Live block only" />
                <PriceStat
                  label="Margin"
                  value={money(selected.pricing.margin)}
                  tone={selected.pricing.margin != null && selected.pricing.margin < 0 ? 'text-danger' : 'text-success'}
                />
                <PriceStat label="Reposition" value={formatDuration(selected.repositionMinutes)} sub={`${selected.repositionDistanceNm} nm`} />
              </div>

              <div className="rounded border border-edge bg-surface-sunken px-3">
                {selected.movements.map((movement) => (
                  <MovementLine key={movement.id} movement={movement} />
                ))}
              </div>
              <div className="grid gap-2 text-[9px] text-content-subtle sm:grid-cols-2">
                <div>Previous: {selected.previous ? `${selected.previous.label} · ${zulu(selected.previous.endMs)}` : `Home ${selected.homeBase || 'not set'}`}</div>
                <div>Next: {selected.next ? `${selected.next.label} · ${zulu(selected.next.startMs)}` : 'No scheduled leg'}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AvailabilityPlanner({ allTrips = [], config = {}, users = [] }) {
  const [legs, setLegs] = useState(() => [createLeg()]);
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [picUid, setPicUid] = useState('');
  const [sicUid, setSicUid] = useState('');
  const [query, setQuery] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [error, setError] = useState(null);
  const [recentDuty, setRecentDuty] = useState([]);
  const [activeDuty, setActiveDuty] = useState([]);
  const [outsideFlying, setOutsideFlying] = useState([]);

  useEffect(() => {
    const recent = subscribeRecentForAllPilots(3, setRecentDuty);
    const active = subscribeAllOnDuty(setActiveDuty);
    const outside = subscribeOutsideReportForAllPilots(3, setOutsideFlying);
    return () => { recent?.(); active?.(); outside?.(); };
  }, []);

  const pilots = useMemo(
    () => users.filter(eligiblePilot).sort((a, b) => resolveCrewName(a).localeCompare(resolveCrewName(b))),
    [users],
  );
  const managedTails = useMemo(() => resolveManagedTails(config), [config]);
  const fleet = useMemo(() => managedTails.map((tail) => {
    const meta = resolveAircraftMeta(tail, config);
    const scheduledInfo = allTrips.find((trip) => (
      String(trip?.info?.tail || '').toUpperCase() === tail
      && (trip?.info?.aircraftType || trip?.info?.acType)
    ))?.info;
    const icaoType = meta.icaoType || scheduledInfo?.aircraftType || scheduledInfo?.acType || '';
    return {
      tail,
      icaoType,
      typeFilterId: icaoType || 'UNCONFIGURED',
      homeBase: meta.homeBase || '',
      displayName: meta.displayName || aircraftProfile(icaoType).label,
      costPerBlockHour: meta.costPerBlockHour,
      sellPerBlockHour: meta.sellPerBlockHour,
    };
  }), [managedTails, config, allTrips]);
  const typeOptions = useMemo(() => {
    const byType = new Map();
    for (const aircraft of fleet) {
      const id = aircraft.typeFilterId;
      const current = byType.get(id) || {
        id,
        label: id === 'UNCONFIGURED' ? 'Type not set' : `${id} · ${aircraftProfile(id).label}`,
        count: 0,
      };
      current.count += 1;
      byType.set(id, current);
    }
    return [...byType.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [fleet]);
  const dutyPeriods = useMemo(() => mergeDutyRows(recentDuty, activeDuty), [recentDuty, activeDuty]);

  function selectedCrew() {
    const build = (uid, role) => {
      const user = pilots.find((pilot) => (pilot.uid || pilot.id) === uid);
      return user ? { uid, name: resolveCrewName(user), role } : null;
    };
    return [build(picUid, 'PIC'), build(sicUid, 'SIC')].filter(Boolean);
  }

  const plan = useMemo(() => {
    if (!query) return null;
    return planLiveLegAssignments({
      legs: query.legs,
      fleet,
      allTrips,
      selectedTypeIds: query.selectedTypes,
      assignments,
      crew: query.crew,
      dutyPeriods,
      outsideFlying,
    });
  }, [query, fleet, allTrips, assignments, dutyPeriods, outsideFlying]);

  function updateLeg(id, next) {
    setLegs((current) => current.map((leg) => (leg.id === id ? next : leg)));
    setQuery(null);
  }

  function addLeg() {
    setLegs((current) => {
      const previous = current[current.length - 1];
      const priorMs = parseZuluInput(previous?.departureZulu) || Date.now();
      return [...current, createLeg(previous?.to || '', '', zuluInputFromMs(priorMs + 4 * 60 * MINUTE_MS))];
    });
    setQuery(null);
  }

  function addRoundTrip() {
    setLegs((current) => {
      if (!current.length) return [createLeg()];
      const first = current[0];
      const last = current[current.length - 1];
      if (!first.from || !last.to) return current;
      const priorMs = parseZuluInput(last.departureZulu) || Date.now();
      return [...current, createLeg(last.to, first.from, zuluInputFromMs(priorMs + 24 * 60 * MINUTE_MS))];
    });
    setQuery(null);
  }

  function analyze(event) {
    event.preventDefault();
    setError(null);
    if (picUid && sicUid && picUid === sicUid) {
      setError('PIC and SIC must be different people.');
      return;
    }
    const normalized = legs.map((leg) => ({
      id: leg.id,
      from: String(leg.from || '').trim().toUpperCase(),
      to: String(leg.to || '').trim().toUpperCase(),
      requestedStartMs: parseZuluInput(leg.departureZulu),
    }));
    if (normalized.some((leg) => !leg.from || !leg.to || leg.from === leg.to || !Number.isFinite(leg.requestedStartMs))) {
      setError('Every live leg needs different FROM/TO airports and a valid Zulu departure.');
      return;
    }
    if (normalized.some((leg) => leg.requestedStartMs < Date.now() - 5 * MINUTE_MS)) {
      setError('A requested departure is in the past.');
      return;
    }
    const chronological = [...normalized].sort((a, b) => a.requestedStartMs - b.requestedStartMs);
    if (chronological.some((leg, index) => index > 0 && leg.requestedStartMs <= chronological[index - 1].requestedStartMs)) {
      setError('Each live leg needs a later requested departure than the one before it.');
      return;
    }
    setAssignments({});
    setQuery({ legs: normalized, selectedTypes, crew: selectedCrew() });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-shell">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Plane className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold text-content">Trip Availability & Pricing</h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-content-muted">
              Build one-way, round-trip, or multi-leg live requests. Rank every eligible tail per leg,
              choose the aircraft assignment, and price the complete trip.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <RulePill>45m TURN</RulePill><RulePill>10h FLIGHT / 24h</RulePill>
            <RulePill>14h DUTY</RulePill><RulePill>10h REST</RulePill>
            <RulePill>45m PRE · 30m POST</RulePill>
          </div>
        </div>

        <form onSubmit={analyze} className="space-y-4 rounded-xl border border-edge bg-surface p-4">
          <div className="space-y-2">
            {legs.map((leg, index) => (
              <LegEditor
                key={leg.id}
                leg={leg}
                index={index}
                canRemove={legs.length > 1}
                onChange={(next) => updateLeg(leg.id, next)}
                onRemove={() => {
                  setLegs((current) => current.filter((item) => item.id !== leg.id));
                  setAssignments((current) => {
                    const next = { ...current };
                    delete next[leg.id];
                    return next;
                  });
                  setQuery(null);
                }}
              />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={addLeg} className="inline-flex items-center gap-1.5 rounded border border-edge px-3 py-2 text-xs text-content-muted hover:border-accent-border hover:text-accent">
              <Plus className="h-3.5 w-3.5" /> ADD LIVE LEG
            </button>
            <button type="button" onClick={addRoundTrip} className="inline-flex items-center gap-1.5 rounded border border-edge px-3 py-2 text-xs text-content-muted hover:border-accent-border hover:text-accent">
              <RotateCcw className="h-3.5 w-3.5" /> ADD ROUND TRIP RETURN
            </button>
          </div>

          <TypeFilters options={typeOptions} selected={selectedTypes} onChange={(types) => { setSelectedTypes(types); setQuery(null); }} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.2fr]">
            <label>
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle">PIC · OPTIONAL</span>
              <select value={picUid} onChange={(event) => setPicUid(event.target.value)} className="w-full rounded border border-edge bg-surface-sunken px-3 py-2.5 text-sm text-content">
                <option value="">Aircraft fit only</option>
                {pilots.map((pilot) => <option key={pilot.uid || pilot.id} value={pilot.uid || pilot.id}>{resolveCrewName(pilot)}</option>)}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[10px] tracking-widest text-content-subtle">SIC · OPTIONAL</span>
              <select value={sicUid} onChange={(event) => setSicUid(event.target.value)} className="w-full rounded border border-edge bg-surface-sunken px-3 py-2.5 text-sm text-content">
                <option value="">Not assigned</option>
                {pilots.map((pilot) => <option key={pilot.uid || pilot.id} value={pilot.uid || pilot.id}>{resolveCrewName(pilot)}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-accent-contrast hover:opacity-90">
                <Search className="h-4 w-4" /> RECOMMEND TAILS & PRICE TRIP
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded border border-edge bg-surface-sunken px-3 py-2 text-[10px] text-content-muted">
            <Clock className="h-3.5 w-3.5" />
            {fleet.length} tails · {allTrips.length} schedule entries · {dutyPeriods.length} duty · {outsideFlying.length} outside-flight records
          </div>
        </form>

        {error && <div className="rounded border border-danger-border bg-danger-soft p-3 text-sm text-danger">{error}</div>}

        {plan && (
          <>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="mb-3 flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-accent" />
                <h2 className="text-sm font-semibold text-content">Whole-trip pricing</h2>
                <span className={`ml-auto font-mono text-[10px] ${plan.ok ? 'text-success' : 'text-danger'}`}>
                  {plan.ok ? 'ALL LEGS FIT' : 'SELECTION NEEDS ATTENTION'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                <PriceStat label="Operating cost" value={money(plan.totals?.cost)} sub="Live + reposition block" />
                <PriceStat label="Sell price" value={money(plan.totals?.sell)} sub="Live block only" />
                <PriceStat
                  label="Gross margin"
                  value={money(plan.totals?.margin)}
                  tone={plan.totals?.margin != null && plan.totals.margin < 0 ? 'text-danger' : 'text-success'}
                />
                <PriceStat label="Live block" value={formatDuration(plan.totals?.liveBlockMinutes)} />
                <PriceStat label="Reposition block" value={formatDuration(plan.totals?.repositionBlockMinutes)} />
              </div>
              {plan.totals?.missingRates?.length > 0 && (
                <div className="mt-3 rounded border border-warning-border bg-warning-soft p-2 text-[10px] text-warning">
                  Add rates in Settings → Managed fleet: {plan.totals.missingRates.join(', ')}.
                </div>
              )}
              <p className="mt-2 text-[9px] text-content-subtle">
                Operating cost applies to all live and reposition block. Sell rate applies to requested live block only.
                Taxes, fees, crew, handling, deicing, overnight, and third-party charges are not included.
              </p>
            </div>

            <div className="space-y-4">
              {plan.legs.map((proposal) => (
                <PlannedLeg
                  key={proposal.id}
                  proposal={proposal}
                  assignment={assignments[proposal.id] || ''}
                  onAssign={(tail) => setAssignments((current) => ({ ...current, [proposal.id]: tail }))}
                />
              ))}
            </div>
          </>
        )}

        {!plan && (
          <div className="rounded-xl border border-dashed border-edge p-10 text-center">
            <Users className="mx-auto h-8 w-8 text-content-subtle" />
            <div className="mt-3 text-sm font-semibold text-content">Build the requested trip above</div>
            <p className="mt-1 text-xs text-content-muted">
              Add each live leg with its own departure, then choose one or several aircraft types to compare.
            </p>
          </div>
        )}

        <div className="rounded border border-warning-border bg-warning-soft p-3 text-[10px] text-warning">
          Planning estimate only. Confirm winds, runway performance, maintenance/MEL, crew, taxes,
          airport/handling fees, and approved manual/OpSpecs before quoting or accepting.
        </div>
      </div>
    </div>
  );
}

