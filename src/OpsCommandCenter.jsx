// src/OpsCommandCenter.jsx
//
// The home-screen view for OPS, ADMIN, and SALES roles. Replaces the
// pilot-personalized PilotHomeScreen for these users because they don't
// fly trips themselves — they need a FLEET-WIDE overview, not "my next
// trip."
//
// What's shown:
//   1. Header strip — current time, day-count strip (today/12h/tomorrow/week),
//      fleet status (X/Y active, AOG count)
//   2. Today's operations stats — flights today, flight hours total, unique
//      aircraft in service, unique airports involved
//   3. Per-aircraft table — every tail in the fleet with its day's activity:
//      status pill, leg count, hours scheduled, crew assigned, next dep
//   4. Embedded FlightBoard (compact) — same as PilotHomeScreen, repeating
//      here so an ops manager sees the live map without switching screens
//   5. Quick actions strip — same as PilotHomeScreen for consistency
//
// What's deferred to later turns:
//   - Weather grid for today's airports (Turn 2)
//   - Action items: pending squawks, expenses needing review, missing
//     manifests, expiring crew docs (Turn 3)
//
// Role gating happens at the call site in App.jsx — this component
// assumes the caller has already decided to render it.
//
// Data source: `trips` is the full allTrips array passed from App.jsx.
// We derive per-aircraft views by grouping. No new data fetching here.
// `users` is passed so we can look up crew details if needed.

import React, { useMemo, useState, useEffect, Suspense, lazy } from 'react';
import { Loader2, Calendar, FileText, Mail, AlertCircle, Plane, Clock, Cloud } from 'lucide-react';

const FlightBoardLazy = lazy(() => import('./FlightBoard.jsx'));

// The fleet — single source of truth for "which aircraft do we operate."
// Hardcoded because it doesn't change daily, and a dynamic derivation
// from `trips` would miss aircraft that aren't flying today.
// If a tail joins or leaves the fleet, update this list.
const FLEET = ['N20UF', 'N168ZZ', 'N286N', 'N444AM', 'N651TW', 'N551FP', 'N85AH', 'N525CR'];

// Aircraft type lookup — purely cosmetic, shown next to the tail. Kept
// here so we don't need a Firestore call for static metadata.
const AIRCRAFT_TYPE = {
  N20UF:  'Citation V',
  N168ZZ: 'Learjet 60',
  N286N:  'Citation Excel',
  N444AM: 'King Air 350',
  N651TW: 'Falcon 50',
  N551FP: 'CJ3',
  N85AH:  'Hawker 800',
  N525CR: 'CJ2+',
};

// ====================================================================
// Helpers
// ====================================================================

function startOfDay(d = new Date()) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}
function endOfDay(d = new Date()) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function timeBasedGreeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Late night';
}

// Hours between trip.start and trip.end, rounded to 1 decimal. Returns
// 0 if either is missing or the result is negative (bad data).
function tripDurationHours(t) {
  if (!t?.start || !t?.end) return 0;
  const s = new Date(t.start).getTime();
  const e = new Date(t.end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round(((e - s) / 3600000) * 10) / 10;
}

// Classify a trip's timing relative to "now". Used to bucket flights into
// in-progress / next-12h / scheduled-later.
function classify(trip, now) {
  if (!trip?.start) return 'unknown';
  const start = new Date(trip.start).getTime();
  const end = trip.end ? new Date(trip.end).getTime() : null;
  if (end && end < now) return 'past';
  if (start <= now && (end == null || end >= now)) return 'active';
  if (start <= now + 12 * 3600 * 1000) return 'imminent';
  return 'upcoming';
}

// Is this an actual flight (vs. a HOLD / MX / TRAINING block)? The iCal
// parser collapses HOLD into legType='REPO' so we have to check the raw
// category field as well as legType.
function isFlightTrip(t) {
  if (!t || !t.info) return false;
  if (t.info.isFlight === false) return false;
  const rawCat = String(t.info.category || '').toUpperCase();
  if (['HOLD', 'MX', 'TRAINING'].includes(rawCat)) return false;
  // Same-airport "flight" with no route = HOLD masquerading. Strip
  // K-prefix before comparing because the same airport can appear as
  // KPBI or PBI on either side of the same leg.
  const norm = (c) => {
    const u = String(c || '').toUpperCase().trim();
    return u.length === 4 && u.startsWith('K') ? u.slice(1) : u;
  };
  if (t.info.from && t.info.to && norm(t.info.from) === norm(t.info.to)) return false;
  return true;
}

// Format a time string like "10:23 AM" from an ISO. Defensive — returns
// "—" on bad input.
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return '—'; }
}

// Convert an iCal status string to a display pill. Each tail's overall
// "today status" is derived from the most-advanced status across its
// today's legs.
function statusPill(state) {
  if (state === 'airborne') return { label: 'AIRBORNE', cls: 'border-cyan-400/60 bg-cyan-500/10 text-cyan-300', pulse: true };
  if (state === 'preflight') return { label: 'PREFLIGHT', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300', pulse: false };
  if (state === 'scheduled') return { label: 'SCHEDULED', cls: 'border-slate-700 bg-slate-900/40 text-slate-300', pulse: false };
  if (state === 'completed') return { label: 'COMPLETED', cls: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400/80', pulse: false };
  if (state === 'aog') return { label: 'AOG', cls: 'border-red-500/60 bg-red-500/10 text-red-400', pulse: true };
  return { label: 'IDLE', cls: 'border-slate-800 bg-slate-900/20 text-slate-500', pulse: false };
}

// ====================================================================
// Component
// ====================================================================

export default function OpsCommandCenter({ currentUser, trips, users, onSelectTrip, onSwitchSection }) {
  // ---- 1. Time + refresh ----
  // Re-render every 60s so the "now"-relative stats refresh without a
  // full page reload. Not 1s — that would cause excessive re-renders for
  // little gain (this is a dashboard, not a stopwatch).
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // ---- 2. Filter to flight trips ----
  // Exclude HOLD/MX/TRAINING blocks from all counts. These show as ground
  // events on the schedule but aren't operationally "flights."
  const flights = useMemo(() => {
    if (!Array.isArray(trips)) return [];
    return trips.filter(isFlightTrip);
  }, [trips]);

  // ---- 3. Bucket flights by timing ----
  const buckets = useMemo(() => {
    const dayStart = startOfDay().getTime();
    const dayEnd = endOfDay().getTime();
    const tomorrowEnd = endOfDay(new Date(Date.now() + 86400_000)).getTime();
    const weekEnd = Date.now() + 7 * 86400_000;

    const today = [], tomorrow = [], thisWeek = [], next12h = [], airborne = [];
    for (const t of flights) {
      if (!t.start) continue;
      const s = new Date(t.start).getTime();
      const cls = classify(t, now);
      if (cls === 'active') airborne.push(t);
      if (cls === 'imminent') next12h.push(t);
      if (s >= dayStart && s <= dayEnd) today.push(t);
      else if (s > dayEnd && s <= tomorrowEnd) tomorrow.push(t);
      if (s >= Date.now() && s <= weekEnd) thisWeek.push(t);
    }
    today.sort((a, b) => new Date(a.start) - new Date(b.start));
    return { today, tomorrow, thisWeek, next12h, airborne };
  }, [flights, now]);

  // ---- 4. Per-aircraft daily snapshot ----
  // Group today's flights by tail. For each fleet aircraft, derive:
  //   - flight count today
  //   - total flight hours scheduled today
  //   - overall status (airborne > preflight > scheduled > completed > idle)
  //   - crew on the first/active leg of the day
  //   - next departure time
  const aircraftRows = useMemo(() => {
    const byTail = {};
    for (const t of buckets.today) {
      const tail = String(t.info?.tail || '').toUpperCase();
      if (!tail) continue;
      if (!byTail[tail]) byTail[tail] = [];
      byTail[tail].push(t);
    }
    return FLEET.map((tail) => {
      const todayLegs = (byTail[tail] || []).sort((a, b) => new Date(a.start) - new Date(b.start));
      const legCount = todayLegs.length;
      const hours = todayLegs.reduce((sum, t) => sum + tripDurationHours(t), 0);
      // Determine overall day state for this tail. Take the highest-priority
      // state across legs: airborne > preflight > scheduled > completed.
      // If no legs today, IDLE.
      let state = 'idle';
      let activeLeg = null;
      for (const leg of todayLegs) {
        const cls = classify(leg, now);
        if (cls === 'active') {
          state = 'airborne';
          activeLeg = leg;
          break;
        }
        if (cls === 'imminent' && state !== 'airborne') {
          state = 'preflight';
          if (!activeLeg) activeLeg = leg;
        }
        if (cls === 'upcoming' && (state === 'idle' || state === 'completed')) {
          state = 'scheduled';
          if (!activeLeg) activeLeg = leg;
        }
        if (cls === 'past' && state === 'idle') {
          state = 'completed';
        }
      }
      // Pick the leg to show pilot/route from: active if any, else next
      // upcoming, else last completed (so completed days still show crew).
      const showLeg = activeLeg
        || todayLegs.find((l) => classify(l, now) === 'imminent' || classify(l, now) === 'upcoming')
        || todayLegs[todayLegs.length - 1]
        || null;
      // Find next departure across all upcoming legs for this tail (not
      // just today's — if today's are done, show tomorrow's first leg).
      let nextDep = null;
      for (const t of flights) {
        if (String(t.info?.tail || '').toUpperCase() !== tail) continue;
        if (!t.start) continue;
        const s = new Date(t.start).getTime();
        if (s < now) continue;
        if (!nextDep || s < nextDep.ms) {
          nextDep = { ms: s, leg: t };
        }
      }
      return {
        tail,
        type: AIRCRAFT_TYPE[tail] || '',
        legCount,
        hours: Math.round(hours * 10) / 10,
        state,
        showLeg,
        nextDep,
      };
    });
  }, [buckets.today, flights, now]);

  // ---- 5. Today's airports (unique) ----
  // Build a deduplicated set of airports across today's legs. The weather
  // grid (Turn 2) will consume this — for now just expose the count.
  const todaysAirports = useMemo(() => {
    const set = new Set();
    for (const t of buckets.today) {
      if (t.info?.from) set.add(String(t.info.from).toUpperCase());
      if (t.info?.to)   set.add(String(t.info.to).toUpperCase());
    }
    return Array.from(set).sort();
  }, [buckets.today]);

  // ---- 6. Top-line stats ----
  const stats = useMemo(() => {
    const totalHoursToday = buckets.today.reduce((s, t) => s + tripDurationHours(t), 0);
    const activeFleetCount = aircraftRows.filter((r) => r.state !== 'idle' && r.state !== 'aog').length;
    const aogCount = aircraftRows.filter((r) => r.state === 'aog').length;
    return {
      flightsToday: buckets.today.length,
      airborneNow: buckets.airborne.length,
      next12h: buckets.next12h.length,
      tomorrowCount: buckets.tomorrow.length,
      weekCount: buckets.thisWeek.length,
      totalHoursToday: Math.round(totalHoursToday * 10) / 10,
      airportsToday: todaysAirports.length,
      activeFleetCount,
      aogCount,
    };
  }, [buckets, aircraftRows, todaysAirports.length]);

  // ---- 7. Render ----
  const userName = currentUser?.callsign || currentUser?.name?.split(' ')[0] || 'Ops';
  const greeting = timeBasedGreeting();
  const dateStr = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex-1 overflow-y-auto scroll-area bg-slate-950">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-5">

        {/* === Header strip === */}
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl md:text-4xl tracking-wide text-slate-100"
            style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.05em' }}>
            {greeting}, {userName}
          </h1>
          <span className="text-[10px] tracking-widest text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            · OPERATIONS COMMAND
          </span>
          <span className="text-[10px] tracking-widest text-slate-500 ml-auto"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {dateStr}
          </span>
        </div>

        {/* === Top-line stats (operations summary) === */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          <StatTile label="AIRBORNE" value={stats.airborneNow} tone={stats.airborneNow > 0 ? 'cyan' : 'muted'} pulse={stats.airborneNow > 0} />
          <StatTile label="TODAY" value={stats.flightsToday} tone="bright" />
          <StatTile label="NEXT 12H" value={stats.next12h} tone={stats.next12h > 0 ? 'amber' : 'muted'} />
          <StatTile label="TOMORROW" value={stats.tomorrowCount} tone="muted" />
          <StatTile label="THIS WEEK" value={stats.weekCount} tone="muted" />
          <StatTile label="HRS TODAY" value={stats.totalHoursToday.toFixed(1)} tone="muted" suffix="h" />
          <StatTile label="FLEET ACTIVE" value={`${stats.activeFleetCount}/${FLEET.length}`} tone="muted" />
          <StatTile label="AOG" value={stats.aogCount} tone={stats.aogCount > 0 ? 'red' : 'muted'} />
        </div>

        {/* === Per-aircraft fleet table === */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-xs tracking-[0.2em] text-slate-300"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              FLEET · TODAY
            </h2>
            <span className="text-[10px] text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {FLEET.length} AIRCRAFT
            </span>
          </div>

          <div className="border border-slate-800 bg-slate-900/30 overflow-hidden">
            {/* Header row */}
            <div className="grid items-center gap-3 px-3 py-2 border-b border-slate-800 text-[10px] tracking-widest text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace', gridTemplateColumns: '100px 110px 60px 60px 1fr 110px 110px' }}>
              <div>TAIL</div>
              <div>STATUS</div>
              <div className="text-right">LEGS</div>
              <div className="text-right">HRS</div>
              <div>ROUTE · CREW</div>
              <div>NEXT DEP</div>
              <div></div>
            </div>

            {aircraftRows.map((row) => (
              <AircraftRow
                key={row.tail}
                row={row}
                now={now}
                onSelectTrip={onSelectTrip}
              />
            ))}
          </div>
        </section>

        {/* === Today's airports (preview for weather grid) ===
            For now just a chip strip showing which airports are involved
            today. Turn 2 will replace this with a full weather grid. */}
        {todaysAirports.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs tracking-[0.2em] text-slate-300"
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
                AIRPORTS · TODAY
              </h2>
              <span className="text-[10px] text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {todaysAirports.length} {todaysAirports.length === 1 ? 'AIRPORT' : 'AIRPORTS'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {todaysAirports.map((code) => (
                <div key={code}
                  className="px-3 py-1.5 border border-slate-700 bg-slate-900/40 text-slate-300 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em' }}>
                  {code}
                </div>
              ))}
              <div className="px-3 py-1.5 border border-cyan-500/30 bg-cyan-500/5 text-cyan-400/70 text-[10px] tracking-widest flex items-center gap-1.5"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <Cloud className="w-3 h-3" />
                WEATHER GRID — COMING SOON
              </div>
            </div>
          </section>
        )}

        {/* === Embedded flight board (compact) ===
            Same component the TRACKING screen uses, in compact mode.
            Ops users see the live flight rows + map without leaving home. */}
        <section>
          <Suspense fallback={
            <div className="border border-slate-800 bg-slate-900/30 p-6 text-center text-slate-500"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
              LOADING FLIGHT BOARD
            </div>
          }>
            <FlightBoardLazy allTrips={trips} compact />
          </Suspense>
        </section>

        {/* === Quick actions strip === */}
        <section>
          <h2 className="text-xs tracking-[0.2em] text-slate-500 mb-2"
            style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
            QUICK ACTIONS
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <QuickAction icon={Calendar} label="ALL TRIPS"  onClick={() => onSwitchSection?.('schedule')} />
            <QuickAction icon={FileText} label="MANIFESTS"  onClick={() => onSwitchSection?.('manifests')} />
            <QuickAction icon={Mail}     label="EXPENSES"   onClick={() => onSwitchSection?.('expenses')} />
            <QuickAction icon={AlertCircle} label="REPORT"  onClick={() => onSwitchSection?.('reports')} />
          </div>
        </section>

      </div>
    </div>
  );
}

// ====================================================================
// Sub-components
// ====================================================================

function StatTile({ label, value, tone = 'muted', pulse = false, suffix = '' }) {
  const toneStyles = {
    cyan:   'border-cyan-500/40 bg-cyan-500/5',
    amber:  'border-amber-500/40 bg-amber-500/5',
    red:    'border-red-500/40 bg-red-500/5',
    muted:  'border-slate-800 bg-slate-900/40',
    bright: 'border-slate-700 bg-slate-900/60',
  };
  const valueColor = {
    cyan: 'text-cyan-300',
    amber: 'text-amber-300',
    red: 'text-red-400',
    muted: 'text-slate-300',
    bright: 'text-slate-100',
  }[tone];
  return (
    <div className={`p-3 border ${toneStyles[tone]}`}>
      <div className="text-[9px] tracking-widest text-slate-500 mb-1 flex items-center gap-1.5"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {pulse && <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></span>}
        {label}
      </div>
      <div className={`text-2xl md:text-3xl ${valueColor}`}
        style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.05em' }}>
        {value}{suffix && <span className="text-base text-slate-500 ml-1">{suffix}</span>}
      </div>
    </div>
  );
}

function AircraftRow({ row, now, onSelectTrip }) {
  const pill = statusPill(row.state);
  const showLeg = row.showLeg;
  const pic = showLeg?.info?.pic || '';
  const sic = showLeg?.info?.sic || '';
  const route = showLeg ? `${showLeg.info?.from || '—'} → ${showLeg.info?.to || '—'}` : '— · idle today';
  const nextDepStr = row.nextDep ? fmtTime(row.nextDep.leg.start) : '—';
  const nextDepDate = row.nextDep
    ? (new Date(row.nextDep.leg.start).toDateString() === new Date(now).toDateString()
        ? 'today'
        : new Date(row.nextDep.leg.start).toLocaleDateString([], { month: 'short', day: 'numeric' }))
    : '';

  const clickable = !!showLeg;
  const handleClick = () => {
    if (clickable && showLeg?.uid) onSelectTrip?.(showLeg.uid);
  };

  return (
    <div
      className={`grid items-center gap-3 px-3 py-3 border-b border-slate-800 last:border-b-0 ${clickable ? 'hover:bg-slate-900/40 cursor-pointer' : ''}`}
      style={{ gridTemplateColumns: '100px 110px 60px 60px 1fr 110px 110px' }}
      onClick={handleClick}
    >
      {/* TAIL */}
      <div>
        <div className="text-base text-slate-100 font-medium" style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.08em' }}>
          {row.tail}
        </div>
        {row.type && (
          <div className="text-[9px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {row.type.toUpperCase()}
          </div>
        )}
      </div>
      {/* STATUS */}
      <div>
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 border text-[10px] tracking-widest ${pill.cls}`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {pill.pulse && <span className="w-1 h-1 bg-current rounded-full animate-pulse"></span>}
          {pill.label}
        </span>
      </div>
      {/* LEGS */}
      <div className="text-right text-slate-300 text-sm" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {row.legCount > 0 ? row.legCount : '—'}
      </div>
      {/* HRS */}
      <div className="text-right text-slate-300 text-sm" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {row.hours > 0 ? row.hours.toFixed(1) : '—'}
      </div>
      {/* ROUTE + CREW */}
      <div className="min-w-0">
        <div className="text-sm text-slate-200 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {route}
        </div>
        {(pic || sic) && (
          <div className="text-[10px] text-slate-500 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {pic && <>PIC {pic}</>}
            {pic && sic && <span className="mx-2 text-slate-700">·</span>}
            {sic && <>SIC {sic}</>}
          </div>
        )}
      </div>
      {/* NEXT DEP */}
      <div>
        {row.nextDep ? (
          <>
            <div className="text-sm text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {nextDepStr}
            </div>
            <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {nextDepDate}
            </div>
          </>
        ) : (
          <span className="text-slate-700 text-sm" style={{ fontFamily: 'JetBrains Mono, monospace' }}>—</span>
        )}
      </div>
      {/* Click-through hint */}
      <div className="text-right">
        {clickable && (
          <span className="text-[10px] text-cyan-400/60 hover:text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            VIEW →
          </span>
        )}
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="p-4 border border-slate-800 bg-slate-900/30 hover:border-cyan-500/40 hover:bg-slate-900/60 transition-colors flex flex-col items-center gap-2 text-slate-300 hover:text-cyan-300"
    >
      <Icon className="w-5 h-5" />
      <span className="text-[11px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </span>
    </button>
  );
}
