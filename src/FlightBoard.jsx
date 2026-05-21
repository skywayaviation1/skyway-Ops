// FlightBoard.jsx — full-screen TV display showing today's flight schedule
// with a route map. Designed for a 1080p (or 4K) TV viewed from across
// a room: oversized text, high contrast, no interaction required, auto-
// refreshes the underlying data via the existing Firestore listeners.
//
// Layout (16:9 landscape):
//   ┌────────────────────────┬──────────────────────────┐
//   │                        │                          │
//   │  FLIGHT LIST           │  ROUTE MAP               │
//   │  (~58% width)          │  (~42% width)            │
//   │                        │                          │
//   └────────────────────────┴──────────────────────────┘
//
// What's shown:
//   - All today's trips (Eastern), sorted by departure time
//   - Each row: status pill, tail, route, time, crew, pax
//   - Map: airport markers + dashed great-circle lines for upcoming
//     trips, solid bolder lines for in-progress, faded for completed
//
// What's NOT shown (deliberate, on record):
//   - Real-time aircraft positions (no live tracking API integrated)
//   - Trails of past positions (depends on live tracking)
//   - Weather overlays
//   - ATC/airspace info
//
// To enable live tracking later: add a position-feed integration (e.g.
// FlightAware AeroAPI) writing to a Firestore collection `flight-positions`
// keyed by tail. Then this component just subscribes to that collection
// and renders the live positions as additional markers on the map.

import React, { useEffect, useMemo, useState } from 'react';
import { lookupCoords } from './airport-coords.js';

// ====================================================================
// CONSTANTS
// ====================================================================

const STATUS_STEPS = [
  { id: 'crew_onsite',     label: 'CREW' },
  { id: 'aircraft_ready',  label: 'A/C' },
  { id: 'catering_aboard', label: 'CTR',     revenueOnly: true },
  { id: 'pax_arrived',     label: 'PAX IN',  revenueOnly: true },
  { id: 'pax_boarded',     label: 'PAX BRD', revenueOnly: true },
  { id: 'taxi_dep',        label: 'TAXI' },
  { id: 'wheels_up',       label: 'UP' },
  { id: 'landed',          label: 'DOWN' },
];

// Map bounding box — covers continental US, southern Canada, Caribbean.
// If a flight references an airport outside this box, the marker would
// be clipped off-screen — those will draw at the box edge instead.
const MAP_BOUNDS = {
  minLng: -130, maxLng: -60,
  minLat: 15,   maxLat: 52,
};

// SVG viewBox for the map. Higher resolution = better detail on 4K TVs.
const MAP_W = 800;
const MAP_H = 500;

// ====================================================================
// MAP PROJECTION
// ====================================================================

/**
 * Equirectangular projection. Acceptable for North American operations —
 * distortion is minimal in this latitude range. NOT acceptable for global
 * routes (would need Mercator or similar) but we don't operate trans-
 * oceanic, so this is fine.
 *
 * Input:  { lat, lng }
 * Output: { x, y } in the MAP_W x MAP_H coordinate space
 */
function project({ lat, lng }) {
  const x = ((lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * MAP_W;
  const y = MAP_H - ((lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * MAP_H;
  // Clamp to viewBox so points just outside the box don't disappear.
  return {
    x: Math.max(0, Math.min(MAP_W, x)),
    y: Math.max(0, Math.min(MAP_H, y)),
  };
}

// Build a curved path (quadratic bezier) between two projected points
// to approximate a great-circle arc. For continental routes the
// difference between a straight line and a real geodesic is small but
// the curve makes the map feel more "flight-like" than ruler lines.
function curvePath(p1, p2) {
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  // Curvature: lift the midpoint perpendicular to the chord, magnitude
  // proportional to chord length so short legs barely curve and long
  // legs arch nicely.
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const k = -0.12; // negative lifts northward in screen coords
  const cx = mx - dy * k;
  const cy = my + dx * k * 0.3;
  return `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
}

// ====================================================================
// FLIGHT STATUS COMPUTATION
// ====================================================================

/**
 * Given a trip and its state, return one of:
 *   'pending'    — not yet departed, no status logged
 *   'preflight'  — crew onsite / a/c ready / pax actions logged, not in air
 *   'airborne'   — wheels_up logged, landed not yet
 *   'landed'     — landed logged
 *   'completed'  — trip marked complete
 *
 * Used both for the list pill and for picking the line color on the map.
 */
export function tripPhase(trip, state) {
  if (state?.completed) return 'completed';
  const s = state?.statuses || {};
  if (s.landed) return 'landed';
  if (s.wheels_up) return 'airborne';
  // Any pre-flight step counts as preflight
  for (const step of ['crew_onsite', 'aircraft_ready', 'catering_aboard', 'pax_arrived', 'pax_boarded', 'taxi_dep']) {
    if (s[step]) return 'preflight';
  }
  return 'pending';
}

// ====================================================================
// FLIGHT LIST ROW
// ====================================================================

function FlightRow({ trip, state }) {
  const phase = tripPhase(trip, state);
  const phaseColors = {
    pending:    { bg: 'bg-slate-800/60',     border: 'border-slate-700',     label: 'PENDING',  txt: 'text-slate-400' },
    preflight:  { bg: 'bg-amber-500/15',     border: 'border-amber-500/40',  label: 'PRE-FLT',  txt: 'text-amber-300' },
    airborne:   { bg: 'bg-cyan-500/25',      border: 'border-cyan-400/60',   label: 'AIRBORNE', txt: 'text-cyan-200' },
    landed:     { bg: 'bg-emerald-500/20',   border: 'border-emerald-500/40', label: 'LANDED',  txt: 'text-emerald-300' },
    completed:  { bg: 'bg-slate-700/40',     border: 'border-slate-600',     label: 'DONE',     txt: 'text-slate-400' },
  };
  const pc = phaseColors[phase];

  // Departure time in Eastern, HH:MM
  let timeStr = '--:--';
  try {
    timeStr = new Date(trip.start).toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
    }).replace(' ', '');
  } catch (_) {}

  return (
    <div className={`grid grid-cols-[80px_120px_180px_110px_1fr_60px] gap-3 items-center px-3 py-2.5 border-b border-slate-800 ${phase === 'airborne' ? 'bg-cyan-500/5' : ''}`}>
      {/* Status pill */}
      <div className={`text-center text-[11px] tracking-widest font-semibold px-2 py-1 border ${pc.bg} ${pc.border} ${pc.txt}`}
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {pc.label}
      </div>
      {/* Time */}
      <div className="text-2xl tabular-nums text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {timeStr}
      </div>
      {/* Tail + Route */}
      <div>
        <div className="text-xl text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
          {trip.info?.tail || '?'}
        </div>
        <div className="text-sm text-slate-400 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {trip.info?.from || '?'} → {trip.info?.to || '?'}
        </div>
      </div>
      {/* Type */}
      <div className="text-xs tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {trip.info?.legType === 'REVENUE' ? 'REVENUE' : 'REPO'}
      </div>
      {/* Crew */}
      <div className="text-sm text-slate-300 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {trip.info?.pic
          ? <>{trip.info.pic}{trip.info.sic && <span className="text-slate-500"> / {trip.info.sic}</span>}</>
          : <span className="text-slate-600">— no crew —</span>}
      </div>
      {/* Pax */}
      <div className="text-xl text-right text-slate-300 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {trip.info?.pax > 0 ? trip.info.pax : '—'}
      </div>
    </div>
  );
}

// ====================================================================
// ROUTE MAP
// ====================================================================

function RouteMap({ trips, stateMap }) {
  // Collect all (from, to) pairs with airport coords + trip metadata.
  // Build a deduped airport list for marker rendering.
  const routes = [];
  const airportSet = new Map(); // code → { coords, code }
  let missing = 0;
  trips.forEach((t) => {
    const fromCode = t.info?.from;
    const toCode = t.info?.to;
    const fromCoords = lookupCoords(fromCode);
    const toCoords = lookupCoords(toCode);
    if (!fromCoords || !toCoords) { missing++; return; }
    routes.push({
      uid: t.uid,
      from: fromCoords,
      to: toCoords,
      fromCode,
      toCode,
      phase: tripPhase(t, stateMap.get(t.uid)),
      tail: t.info?.tail || '',
    });
    if (fromCoords) airportSet.set(fromCode, { coords: fromCoords, code: fromCode });
    if (toCoords) airportSet.set(toCode, { coords: toCoords, code: toCode });
  });

  // Sort routes so airborne flights render LAST (on top of pending/completed).
  const phaseOrder = { completed: 0, landed: 1, pending: 2, preflight: 3, airborne: 4 };
  routes.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
        {/* Subtle grid background for visual context. 10° lat/lng lines. */}
        <g stroke="rgb(30,41,59)" strokeWidth="0.5" fill="none">
          {/* Vertical (lng) lines every 10° */}
          {[-130, -120, -110, -100, -90, -80, -70, -60].map((lng) => {
            const x = project({ lat: 30, lng }).x;
            return <line key={`v${lng}`} x1={x} y1={0} x2={x} y2={MAP_H} />;
          })}
          {/* Horizontal (lat) lines every 10° */}
          {[20, 30, 40, 50].map((lat) => {
            const y = project({ lat, lng: -90 }).y;
            return <line key={`h${lat}`} x1={0} y1={y} x2={MAP_W} y2={y} />;
          })}
        </g>

        {/* Route paths */}
        {routes.map((r) => {
          const p1 = project(r.from);
          const p2 = project(r.to);
          const d = curvePath(p1, p2);
          // Color + dash based on phase
          const style = {
            pending:    { stroke: 'rgb(100, 116, 139)', strokeWidth: 1.5, strokeDasharray: '4 4',  opacity: 0.5 },
            preflight:  { stroke: 'rgb(245, 158, 11)',  strokeWidth: 2,   strokeDasharray: '6 4',  opacity: 0.85 },
            airborne:   { stroke: 'rgb(34, 211, 238)',  strokeWidth: 3,   strokeDasharray: 'none', opacity: 1 },
            landed:     { stroke: 'rgb(16, 185, 129)',  strokeWidth: 2,   strokeDasharray: 'none', opacity: 0.6 },
            completed:  { stroke: 'rgb(71, 85, 105)',   strokeWidth: 1,   strokeDasharray: 'none', opacity: 0.3 },
          }[r.phase];
          return (
            <g key={r.uid}>
              <path d={d} fill="none" {...style} />
              {/* Tail label at the curve midpoint for airborne flights only */}
              {r.phase === 'airborne' && (() => {
                const mx = (p1.x + p2.x) / 2;
                const my = (p1.y + p2.y) / 2 - 16;
                return (
                  <text
                    x={mx} y={my}
                    fill="rgb(165, 243, 252)"
                    fontSize="11"
                    fontFamily="JetBrains Mono, monospace"
                    fontWeight="600"
                    textAnchor="middle"
                  >
                    {r.tail}
                  </text>
                );
              })()}
            </g>
          );
        })}

        {/* Airport markers */}
        {Array.from(airportSet.values()).map((a) => {
          const p = project(a.coords);
          return (
            <g key={a.code}>
              <circle cx={p.x} cy={p.y} r={3} fill="rgb(148, 163, 184)" stroke="rgb(15, 23, 42)" strokeWidth="0.5" />
              <text
                x={p.x + 5}
                y={p.y - 5}
                fill="rgb(148, 163, 184)"
                fontSize="9"
                fontFamily="JetBrains Mono, monospace"
              >
                {a.code}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 bg-slate-900/80 border border-slate-800 px-3 py-2 text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="flex items-center gap-2 mb-1">
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="rgb(34, 211, 238)" strokeWidth="3" /></svg>
          <span className="text-cyan-200">AIRBORNE</span>
        </div>
        <div className="flex items-center gap-2 mb-1">
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="rgb(245, 158, 11)" strokeWidth="2" strokeDasharray="6 4" /></svg>
          <span className="text-amber-300">PRE-FLIGHT</span>
        </div>
        <div className="flex items-center gap-2 mb-1">
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="rgb(100, 116, 139)" strokeWidth="1.5" strokeDasharray="4 4" /></svg>
          <span className="text-slate-400">PENDING</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="rgb(16, 185, 129)" strokeWidth="2" /></svg>
          <span className="text-emerald-300">LANDED</span>
        </div>
      </div>

      {/* Missing-airport diagnostic — quiet in the corner so it doesn't
          take screen space but lets ops see if the map is incomplete. */}
      {missing > 0 && (
        <div className="absolute bottom-3 right-3 bg-amber-500/20 border border-amber-500/40 text-amber-300 px-2 py-1 text-[10px]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {missing} route{missing === 1 ? '' : 's'} not mapped — airport coords missing
        </div>
      )}
    </div>
  );
}

// ====================================================================
// MAIN COMPONENT
// ====================================================================

/**
 * FlightBoard — props:
 *   allTrips    Array of trip objects from the schedule
 *
 * Subscribes to all trip states for status data. Re-renders on any change.
 * Filters to today's trips (Eastern) + anything still in progress.
 */
function FlightBoard({ allTrips }) {
  const [stateMap, setStateMap] = useState(new Map());
  const [, setTick] = useState(0); // forces a tick every minute for time display

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      const m = await import('./firebase-data.js');
      unsub = m.subscribeAllTripStates((map) => {
        setStateMap(map);
      });
    })();
    return () => { try { unsub(); } catch (_) {} };
  }, []);

  // Re-tick once a minute so the "now" time in the header updates and
  // the active filter rolls over correctly past midnight.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Active trips: today (Eastern) + anything in progress (started <24h
  // ago, not marked complete). Same logic as OpsConsole — keep
  // operationally consistent.
  const active = useMemo(() => {
    const now = Date.now();
    let todayStart = 0, todayEnd = now + 24 * 3600 * 1000;
    try {
      const etParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(now));
      const y = Number(etParts.find(p => p.type === 'year').value);
      const mo = Number(etParts.find(p => p.type === 'month').value);
      const d = Number(etParts.find(p => p.type === 'day').value);
      const naive = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
      const etStr = naive.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
      const offset = new Date(etStr).getTime() - new Date(utcStr).getTime();
      todayStart = naive.getTime() - offset;
      todayEnd = todayStart + 24 * 3600 * 1000;
    } catch (_) {}

    const candidate = (allTrips || []).filter((t) => {
      const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
      if (!Number.isFinite(ts)) return false;
      if (t.info && t.info.isOps === false) return false;
      if (t.info && t.info.from && t.info.from === t.info.to && !t.info.pax) return false;
      const s = stateMap.get(t.uid);
      if (s?.completed || s?.archived) return false;
      const startsToday = ts >= todayStart && ts < todayEnd;
      const inProgress = ts < now && ts > now - (24 * 60 * 60 * 1000);
      return startsToday || inProgress;
    });
    candidate.sort((a, b) => {
      const ta = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const tb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return ta - tb;
    });
    return candidate;
  }, [allTrips, stateMap]);

  // Summary stats for the header
  const stats = useMemo(() => {
    let airborne = 0, preflight = 0, pending = 0;
    active.forEach((t) => {
      const phase = tripPhase(t, stateMap.get(t.uid));
      if (phase === 'airborne') airborne++;
      else if (phase === 'preflight') preflight++;
      else if (phase === 'pending') pending++;
    });
    return { airborne, preflight, pending, total: active.length };
  }, [active, stateMap]);

  // Current time for the header
  let nowStr = '';
  try {
    nowStr = new Date().toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: 'America/New_York',
    });
  } catch (_) {}

  return (
    <div className="h-screen w-screen bg-slate-950 flex flex-col overflow-hidden">
      {/* Top banner */}
      <div className="px-6 py-4 border-b-2 border-cyan-500/30 bg-gradient-to-r from-slate-950 via-cyan-950/40 to-slate-950 flex items-center justify-between">
        <div>
          <h1 className="text-3xl tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            SKYWAY · FLIGHT BOARD
          </h1>
          <p className="text-sm text-slate-400 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nowStr}</p>
        </div>
        <div className="flex items-center gap-6" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <div className="text-center">
            <div className="text-4xl text-cyan-300 tabular-nums" style={{ fontWeight: 700 }}>{stats.airborne}</div>
            <div className="text-[10px] tracking-widest text-slate-400">AIRBORNE</div>
          </div>
          <div className="text-center">
            <div className="text-4xl text-amber-300 tabular-nums" style={{ fontWeight: 700 }}>{stats.preflight}</div>
            <div className="text-[10px] tracking-widest text-slate-400">PRE-FLIGHT</div>
          </div>
          <div className="text-center">
            <div className="text-4xl text-slate-300 tabular-nums" style={{ fontWeight: 700 }}>{stats.pending}</div>
            <div className="text-[10px] tracking-widest text-slate-400">PENDING</div>
          </div>
          <div className="text-center border-l border-slate-700 pl-6">
            <div className="text-4xl text-slate-100 tabular-nums" style={{ fontWeight: 700 }}>{stats.total}</div>
            <div className="text-[10px] tracking-widest text-slate-400">TOTAL TODAY</div>
          </div>
        </div>
      </div>

      {/* Split: list + map */}
      <div className="flex-1 grid grid-cols-[58%_42%] overflow-hidden">
        {/* Flight list */}
        <div className="border-r border-slate-800 overflow-y-auto">
          {/* Column headers */}
          <div className="grid grid-cols-[80px_120px_180px_110px_1fr_60px] gap-3 px-3 py-2 border-b border-slate-700 text-[10px] tracking-widest text-slate-500 sticky top-0 bg-slate-950 z-10"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <div className="text-center">STATUS</div>
            <div>TIME (ET)</div>
            <div>TAIL · ROUTE</div>
            <div>TYPE</div>
            <div>CREW</div>
            <div className="text-right">PAX</div>
          </div>
          {active.length === 0 ? (
            <div className="p-12 text-center text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NO ACTIVE FLIGHTS
            </div>
          ) : (
            active.map((t) => (
              <FlightRow key={t.uid} trip={t} state={stateMap.get(t.uid)} />
            ))
          )}
        </div>

        {/* Map */}
        <div className="bg-slate-950">
          <RouteMap trips={active} stateMap={stateMap} />
        </div>
      </div>
    </div>
  );
}

export default FlightBoard;
