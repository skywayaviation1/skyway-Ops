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
import { Loader2, Calendar, FileText, Mail, AlertCircle, Plane, Clock, Cloud, AlertTriangle, Receipt, Wrench, Wind, Users } from 'lucide-react';
// Live crew duty board (V2). Reads duty-periods-v2 collection,
// evaluates legality per pilot, shows on-duty / resting / available /
// illegal / warning state.
const CrewBoardV2Lazy = lazy(() => import('./CrewBoardV2.jsx'));

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
// Weather fetcher — duplicated from App.jsx for module isolation.
// 5-minute client cache, server has its own 10-minute Firestore cache.
// ====================================================================
const _wxCache = new Map();
const WX_CLIENT_TTL_MS = 5 * 60 * 1000;
async function fetchAirportWx(icao) {
  if (!icao) return null;
  const key = String(icao).toUpperCase();
  const now = Date.now();
  const cached = _wxCache.get(key);
  if (cached && (now - cached.fetchedAt) < WX_CLIENT_TTL_MS) return cached.data;
  try {
    const { auth } = await import('./firebase.js');
    const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    if (!idToken) return null;
    const r = await fetch(`/api/airport-weather?icao=${encodeURIComponent(key)}`, {
      headers: { 'Authorization': `Bearer ${idToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    _wxCache.set(key, { data, fetchedAt: now });
    return data;
  } catch (_) { return null; }
}

// IATA → ICAO normalization for the weather API. The endpoint adds the
// K prefix for 3-letter US codes automatically but Mexican/Caribbean/
// South American 3-letter IATA codes need explicit mapping. We rely on
// the trip data already giving us the 4-letter ICAO for non-US airports
// (FlightAware normalizes this) — for US airports we send the 3-letter
// and let the endpoint K-prefix it.
function toIcao(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return null;
  return c;
}

// Flight category styles — same palette as the existing weather UI
// elsewhere in the app for visual consistency.
function flightCategoryStyles(cat) {
  switch (cat) {
    case 'VFR':  return { text: 'text-emerald-400', border: 'border-emerald-500/40', dot: 'bg-emerald-400', tone: 'emerald' };
    case 'MVFR': return { text: 'text-blue-400',    border: 'border-blue-500/40',    dot: 'bg-blue-400',    tone: 'blue' };
    case 'IFR':  return { text: 'text-red-400',     border: 'border-red-500/40',     dot: 'bg-red-400',     tone: 'red' };
    case 'LIFR': return { text: 'text-fuchsia-400', border: 'border-fuchsia-500/40', dot: 'bg-fuchsia-400', tone: 'fuchsia' };
    default:     return { text: 'text-slate-500',   border: 'border-slate-700',      dot: 'bg-slate-500',   tone: 'slate' };
  }
}

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

  // ---- 1b. Live subscriptions: squawks + expenses + fleet + duty ----
  // These drive the Action Items panel and Crew Duty panel. All are
  // pre-existing Firestore subscriptions used elsewhere in the app —
  // we tap them here too. The imports are dynamic so they don't bloat
  // the initial bundle.
  const [squawks, setSquawks] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [fleet, setFleet] = useState([]); // maintenance fleet records (for AOG state)
  const [mel, setMel] = useState([]);
  // Duty state removed — CrewBoardV2 subscribes to duty-periods-v2 directly
  // and renders the crew status section itself. No need for parent state.

  useEffect(() => {
    let cancelled = false;
    const unsubs = [];
    (async () => {
      try {
        const m = await import('./firebase-maint.js');
        if (cancelled) return;
        if (m.subscribeSquawks)  unsubs.push(m.subscribeSquawks((list) => setSquawks(list)));
        if (m.subscribeFleet)    unsubs.push(m.subscribeFleet((list) => setFleet(list)));
        if (m.subscribeMel)      unsubs.push(m.subscribeMel((list) => setMel(list)));
      } catch (e) { console.warn('[OpsCommandCenter] maint subscribe failed:', e?.message); }
    })();
    (async () => {
      try {
        const m = await import('./firebase-expenses.js');
        if (cancelled) return;
        if (m.subscribeToAllExpenses) {
          unsubs.push(m.subscribeToAllExpenses((list) => setExpenses(list)));
        }
      } catch (e) { console.warn('[OpsCommandCenter] expense subscribe failed:', e?.message); }
    })();
    (async () => {
      try {
        // (Duty subscription removed during V2 migration. CrewBoardV2
        // mounts in this dashboard and subscribes to duty-periods-v2
        // directly. Nothing to do here.)
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
      for (const u of unsubs) { try { u && u(); } catch (_) {} }
    };
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

  // ---- 3b. AOG tails (derived from squawks with grounding=true) ----
  // A tail is AOG if it has any open squawk marked grounding. This is
  // the same logic the Maint tab uses to drive the AOG status badge.
  const aogTails = useMemo(() => {
    const set = new Set();
    for (const s of squawks) {
      if (!s || s.status === 'closed') continue;
      if (s.grounding === true && s.tail) {
        set.add(String(s.tail).toUpperCase());
      }
    }
    return set;
  }, [squawks]);

  // ---- 4. Per-aircraft daily snapshot ----
  // Group today's flights by tail. For each fleet aircraft, derive:
  //   - flight count today
  //   - total flight hours scheduled today
  //   - overall status (AOG > airborne > preflight > scheduled > completed > idle)
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
      // AOG check comes FIRST — if the aircraft is grounded, that overrides
      // any scheduling-derived status. Crew won't be flying it regardless.
      let state = aogTails.has(tail) ? 'aog' : 'idle';
      let activeLeg = null;
      if (state !== 'aog') {
        // Determine overall day state for this tail. Take the highest-priority
        // state across legs: airborne > preflight > scheduled > completed.
        // If no legs today, IDLE.
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
  }, [buckets.today, flights, now, aogTails]);

  // ---- 5. Today's airports (unique) ----
  // Build a deduplicated set of airports across today's legs. The weather
  // grid consumes this — we fetch METAR for each.
  const todaysAirports = useMemo(() => {
    const set = new Set();
    for (const t of buckets.today) {
      if (t.info?.from) set.add(String(t.info.from).toUpperCase());
      if (t.info?.to)   set.add(String(t.info.to).toUpperCase());
    }
    return Array.from(set).sort();
  }, [buckets.today]);

  // ---- 5b. Weather state ----
  // Fetch METAR for each airport in today's schedule. Re-fetch every 5
  // minutes (matches server cache TTL) so we don't hammer Firestore but
  // also don't show stale weather. Skip if there are no airports today.
  //
  // Each entry: { icao: 'KPBI', data: <api response> | null, loading: bool }
  // We use a Map keyed by ICAO. Failed fetches stay in the map with null
  // data so the UI can render "no data" instead of a spinner forever.
  const [wxByAirport, setWxByAirport] = useState(new Map());
  useEffect(() => {
    if (todaysAirports.length === 0) {
      setWxByAirport(new Map());
      return;
    }
    let cancelled = false;
    let timer = null;
    const fetchAll = async () => {
      // Mark loading for any airport not already in the map. Preserve
      // existing data while loading new data (no flash of empty state).
      setWxByAirport((prev) => {
        const next = new Map(prev);
        for (const code of todaysAirports) {
          if (!next.has(code)) next.set(code, { loading: true, data: null });
        }
        // Prune airports no longer in today's schedule.
        for (const k of next.keys()) {
          if (!todaysAirports.includes(k)) next.delete(k);
        }
        return next;
      });
      // Parallel fetch — server cache + client cache together mean these
      // are usually fast on warm dashboards.
      const results = await Promise.all(todaysAirports.map(async (code) => {
        const data = await fetchAirportWx(toIcao(code));
        return { code, data };
      }));
      if (cancelled) return;
      setWxByAirport((prev) => {
        const next = new Map(prev);
        for (const { code, data } of results) {
          next.set(code, { loading: false, data });
        }
        return next;
      });
    };
    fetchAll();
    // Refresh every 5 minutes
    timer = setInterval(fetchAll, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [todaysAirports.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

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

        {/* === Weather grid — METAR for every airport in today's schedule ===
            Each card shows IATA, flight category pill, wind, vis/ceiling,
            temp/dewpoint, "Updated Xm ago." Data refreshes every 5 minutes.
            Falls back gracefully — if a station has no METAR (small fields,
            international airports without ICAO reporting), the card still
            renders with "no data". */}
        {todaysAirports.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-xs tracking-[0.2em] text-slate-300"
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
                WEATHER · TODAY
              </h2>
              <span className="text-[10px] text-slate-500"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {todaysAirports.length} {todaysAirports.length === 1 ? 'AIRPORT' : 'AIRPORTS'} · METAR / TAF
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {todaysAirports.map((code) => (
                <WeatherCard key={code} code={code} entry={wxByAirport.get(code)} now={now} />
              ))}
            </div>
          </section>
        )}

        {/* === Action items — surfaces operational issues needing attention ===
            Open squawks, pending expense reviews, and current AOG list.
            All counts are derived from live Firestore subscriptions so
            these refresh in real time as ops triages issues. */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-xs tracking-[0.2em] text-slate-300"
              style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}>
              ACTION ITEMS
            </h2>
          </div>
          <ActionItemsPanel
            squawks={squawks}
            expenses={expenses}
            aogTails={aogTails}
            onSwitchSection={onSwitchSection}
          />
        </section>

        {/* === Crew duty / availability ===
            Lists pilots currently on duty with elapsed time, FAR 117
            14-hour limit warning, and PIC/SIC pair. Hidden when no one
            is on duty (no false-positive empty state to scroll past). */}
        {/* CREW · DUTY STATUS — V2 board. Pulls from duty-periods-v2
            (new schema). Replaces the old activeDuty-driven CrewDutyPanel
            which read from the legacy duty-state collection. The legacy
            subscription/state remains in this file as dead code so we
            can revert quickly if needed; safe to remove after stability. */}
        <Suspense fallback={
          <div className="border border-slate-800 bg-slate-900/30 p-3 text-[10px] tracking-widest text-slate-500"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CREW · LOADING…
          </div>
        }>
          <CrewBoardV2Lazy currentUser={currentUser} users={users} />
        </Suspense>

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

// ====================================================================
// WeatherCard — one airport's METAR summary
// ====================================================================
//
// Shows IATA + flight category color tag + wind + visibility + ceiling +
// temp/dewpoint + age. Graceful degradation: if entry is null, undefined,
// loading, or has no data, the card still renders with appropriate
// placeholder state. The METAR endpoint is best-effort — international
// airports without ICAO weather reporting just show "no data."
function WeatherCard({ code, entry, now }) {
  const loading = entry?.loading;
  const data = entry?.data;
  const metar = data?.metar || null;
  const cat = metar?.flightCategory || null;
  const styles = flightCategoryStyles(cat);

  // Format observed time as relative ("3m ago", "1h ago"). METAR reports
  // are usually under 1h old; anything more probably means the station
  // hasn't reported recently — useful signal for the dispatcher.
  //
  // observedTime from the API can be an ISO string, unix seconds, or
  // unix milliseconds depending on what NOAA returned. Normalize all
  // three. Unix seconds = small number (~1.7B); ms = ~1.7T.
  const observedMs = (() => {
    const raw = metar?.observedTime;
    if (raw == null) return null;
    if (typeof raw === 'number') {
      // Heuristic: anything below year 2100 in milliseconds is reasonable.
      // If the number is < 1e12 it's almost certainly seconds, not ms.
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string') {
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : null;
    }
    return null;
  })();
  const ageStr = observedMs
    ? (() => {
        const diff = Math.max(0, now - observedMs);
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        return `${hrs}h ${mins % 60}m ago`;
      })()
    : '—';

  // Wind formatting: "240° @ 12kt G18" or "VRB 4kt" or "CALM"
  const windStr = (() => {
    if (!metar) return null;
    const w = metar.windKt;
    const g = metar.windGustKt;
    const d = metar.windDir;
    if (w === 0 || w == null) return w === 0 ? 'CALM' : null;
    let s;
    if (d === 0 && w > 0) s = `VRB ${w}kt`;
    else if (d == null) s = `${w}kt`;
    else s = `${String(d).padStart(3, '0')}° @ ${w}kt`;
    if (g) s += ` G${g}`;
    return s;
  })();

  // Visibility — METAR can return "10+" (>10 SM) as a string; the parsed
  // endpoint normalizes this. Just stringify.
  const visStr = (() => {
    if (!metar) return null;
    const v = metar.visibilitySm;
    if (v == null) return null;
    if (typeof v === 'string') return `${v} SM`;
    return v >= 10 ? '10+ SM' : `${v} SM`;
  })();

  const ceilingStr = (() => {
    if (!metar) return null;
    const c = metar.ceilingFt;
    if (c == null) return 'unl';
    return `${c.toLocaleString()} ft`;
  })();

  const tempStr = (() => {
    if (!metar || metar.tempC == null) return null;
    const f = Math.round((metar.tempC * 9) / 5 + 32);
    const dp = metar.dewpointC != null ? Math.round((metar.dewpointC * 9) / 5 + 32) : null;
    return dp != null ? `${f}°/${dp}°F` : `${f}°F`;
  })();

  return (
    <div className={`border bg-slate-900/40 p-3 ${styles.border}`}>
      {/* Header: code + category pill */}
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-lg text-slate-100"
          style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.08em' }}>
          {code}
        </div>
        {cat ? (
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 border text-[10px] tracking-widest ${styles.border} ${styles.text}`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`}></span>
            {cat}
          </span>
        ) : loading ? (
          <span className="text-[10px] text-slate-600 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <Loader2 className="w-3 h-3 inline animate-spin" />
          </span>
        ) : (
          <span className="text-[10px] text-slate-600 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            NO DATA
          </span>
        )}
      </div>

      {/* Body: wind / vis / ceiling / temp */}
      {metar ? (
        <div className="space-y-1 text-[11px] text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {windStr && (
            <div className="flex items-center gap-1.5">
              <Wind className="w-3 h-3 text-slate-600" />
              <span className="text-slate-300">{windStr}</span>
            </div>
          )}
          {(visStr || ceilingStr) && (
            <div className="flex gap-3">
              {visStr && <span><span className="text-slate-600">VIS</span> <span className="text-slate-300">{visStr}</span></span>}
              {ceilingStr && <span><span className="text-slate-600">CIG</span> <span className="text-slate-300">{ceilingStr}</span></span>}
            </div>
          )}
          {tempStr && (
            <div><span className="text-slate-600">T/Dp</span> <span className="text-slate-300">{tempStr}</span></div>
          )}
          <div className="text-[9px] text-slate-600 pt-1">
            {ageStr}
          </div>
        </div>
      ) : loading ? (
        <div className="text-[10px] text-slate-600 py-4 text-center" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          loading…
        </div>
      ) : (
        <div className="text-[10px] text-slate-600 py-4 text-center" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          no weather reporting
        </div>
      )}

      {/* TAF — expandable forecast section. Hidden by default to keep the
          grid compact; click to expand. Shows first 3-4 forecast periods
          since beyond ~12h it's rarely operationally relevant.
          We render this even when METAR is missing because some stations
          publish TAFs without current METAR (rare but possible). */}
      <TafSection taf={data?.taf} now={now} />
    </div>
  );
}

// TafSection: collapsible forecast summary for a WeatherCard. Each period
// shows a flight category pill + the time window + the dominant change
// (wind/vis/cig). Designed to be SCANNABLE — not a full TAF reader.
function TafSection({ taf, now }) {
  const [expanded, setExpanded] = useState(false);

  const periods = useMemo(() => {
    if (!taf || !Array.isArray(taf.periods)) return [];
    // Filter to FUTURE periods (skip past forecast windows) and take the
    // next ~4 that span up to ~18 hours ahead. AWC TAFs come with several
    // dozen periods but most are very short windows — limiting keeps it
    // readable.
    const nowSec = Math.floor(now / 1000);
    const future = taf.periods.filter((p) => {
      // timeTo > now means the window hasn't ended yet
      const t = typeof p.timeTo === 'number' ? p.timeTo : (typeof p.timeTo === 'string' ? Math.floor(new Date(p.timeTo).getTime() / 1000) : null);
      return t == null || t > nowSec;
    });
    return future.slice(0, 4);
  }, [taf, now]);

  if (!periods.length) return null;

  return (
    <div className="mt-2 pt-2 border-t border-slate-800">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-[9px] text-slate-600 hover:text-slate-400 tracking-widest flex items-center gap-1.5"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        TAF · {periods.length} {periods.length === 1 ? 'PERIOD' : 'PERIODS'}
        <span className="text-slate-700">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {periods.map((p, i) => (
            <TafPeriodRow key={i} period={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// One TAF period row — time window + flight category + wind summary.
function TafPeriodRow({ period }) {
  const styles = flightCategoryStyles(period.flightCategory);

  // Time window — show "Zulu Day/Hour" format which is how dispatchers
  // read TAFs. e.g. "020600Z–021800Z". timeFrom/timeTo come as unix
  // seconds OR ISO strings depending on AWC's response.
  const fmtZ = (t) => {
    if (t == null) return '—';
    const ms = typeof t === 'number' ? t * 1000 : new Date(t).getTime();
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hr = String(d.getUTCHours()).padStart(2, '0');
    return `${day}${hr}Z`;
  };
  const winFrom = fmtZ(period.timeFrom);
  const winTo = fmtZ(period.timeTo);

  // Wind: same format as METAR display
  const windStr = (() => {
    const w = period.windKt;
    const g = period.windGustKt;
    const d = period.windDir;
    if (w == null) return null;
    if (w === 0) return 'CALM';
    let s;
    if (d == null) s = `${w}kt`;
    else s = `${String(d).padStart(3, '0')}° ${w}kt`;
    if (g) s += ` G${g}`;
    return s;
  })();

  return (
    <div className="flex items-baseline gap-2 text-slate-500">
      <span className="text-slate-600 tabular-nums w-[80px]">{winFrom}-{winTo}</span>
      {period.flightCategory && (
        <span className={`${styles.text} font-medium`}>{period.flightCategory}</span>
      )}
      {windStr && <span className="text-slate-400">{windStr}</span>}
      {period.changeIndicator && (
        <span className="text-slate-600 uppercase">{period.changeIndicator}</span>
      )}
    </div>
  );
}

// ====================================================================
// ActionItemsPanel — surfaces operational items needing attention
// ====================================================================
//
// Three buckets:
//   1. OPEN SQUAWKS — Maintenance issues across the fleet. Click → MAINT tab.
//      Grounding squawks (AOG) are flagged in red separately from normal
//      open squawks so a dispatcher sees AOG status at a glance.
//   2. PENDING EXPENSES — Crew submissions awaiting approval. Click →
//      EXPENSES tab. Counts both 'pending' and 'needs_review' statuses,
//      shows running $ total so it's obvious whether this is a $200
//      lunch backlog or a $20k catering bill.
//   3. AOG LIST — If any aircraft is grounded, list which tail(s) and
//      the highest-severity grounding squawk for each.
//
// All three are click-throughs to the relevant section so ops can act
// without losing their context.
function ActionItemsPanel({ squawks, expenses, aogTails, onSwitchSection }) {
  const openSquawks = useMemo(
    () => (Array.isArray(squawks) ? squawks.filter((s) => s && s.status !== 'closed') : []),
    [squawks]
  );
  const groundingSquawks = useMemo(
    () => openSquawks.filter((s) => s.grounding === true),
    [openSquawks]
  );
  const pendingExpenses = useMemo(() => {
    if (!Array.isArray(expenses)) return [];
    return expenses.filter((e) => e && (e.status === 'pending' || e.status === 'needs_review'));
  }, [expenses]);
  const pendingExpenseTotal = useMemo(() => {
    return pendingExpenses.reduce((sum, e) => {
      const amt = Number(e?.totalAmount || e?.amount || 0);
      return sum + (Number.isFinite(amt) ? amt : 0);
    }, 0);
  }, [pendingExpenses]);

  // Group grounding squawks by tail for the AOG list.
  const aogByTail = useMemo(() => {
    const map = {};
    for (const s of groundingSquawks) {
      const t = String(s.tail || '').toUpperCase();
      if (!t) continue;
      if (!map[t]) map[t] = [];
      map[t].push(s);
    }
    return map;
  }, [groundingSquawks]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
      {/* Open squawks tile */}
      <ActionTile
        icon={Wrench}
        label="OPEN SQUAWKS"
        count={openSquawks.length}
        accent={groundingSquawks.length > 0 ? 'red' : (openSquawks.length > 0 ? 'amber' : 'muted')}
        subtitle={
          groundingSquawks.length > 0
            ? `${groundingSquawks.length} grounding · ${openSquawks.length - groundingSquawks.length} non-grounding`
            : (openSquawks.length > 0 ? 'review and triage' : 'all clear')
        }
        onClick={() => onSwitchSection?.('maint')}
      />

      {/* Pending expenses tile */}
      <ActionTile
        icon={Receipt}
        label="PENDING EXPENSES"
        count={pendingExpenses.length}
        accent={pendingExpenses.length > 0 ? 'amber' : 'muted'}
        subtitle={
          pendingExpenses.length > 0
            ? `$${pendingExpenseTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} awaiting review`
            : 'no expenses pending'
        }
        onClick={() => onSwitchSection?.('expenses')}
      />

      {/* AOG list tile */}
      <ActionTile
        icon={AlertTriangle}
        label="AOG"
        count={aogTails.size}
        accent={aogTails.size > 0 ? 'red' : 'muted'}
        subtitle={
          aogTails.size > 0
            ? Array.from(aogTails).join(' · ')
            : 'no aircraft grounded'
        }
        onClick={() => onSwitchSection?.('maint')}
      />
    </div>
  );
}

function ActionTile({ icon: Icon, label, count, accent = 'muted', subtitle, onClick }) {
  const accents = {
    red:   { border: 'border-red-500/40 hover:border-red-400', bg: 'bg-red-500/5 hover:bg-red-500/10', text: 'text-red-400', label: 'text-red-300/70' },
    amber: { border: 'border-amber-500/40 hover:border-amber-400', bg: 'bg-amber-500/5 hover:bg-amber-500/10', text: 'text-amber-300', label: 'text-amber-300/70' },
    muted: { border: 'border-slate-800 hover:border-slate-700', bg: 'bg-slate-900/30 hover:bg-slate-900/60', text: 'text-slate-400', label: 'text-slate-500' },
  };
  const a = accents[accent];
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 border transition-colors ${a.border} ${a.bg}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className={`text-[10px] tracking-widest flex items-center gap-1.5 ${a.label}`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <Icon className="w-3.5 h-3.5" />
          {label}
        </div>
        <div className={`text-2xl ${a.text}`}
          style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.05em' }}>
          {count}
        </div>
      </div>
      <div className="text-[11px] text-slate-500 truncate"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        title={subtitle}>
        {subtitle}
      </div>
    </button>
  );
}

