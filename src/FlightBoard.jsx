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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { lookupCoords } from './airport-coords.js';

// ====================================================================
// LEAFLET LOADER
// ====================================================================
//
// Same pattern as the existing TrackingScreen — load Leaflet from unpkg
// CDN at runtime. No npm dependency. Requires TV to have internet, but
// since the whole app needs internet for Firestore anyway, this is fine.
// Pinned to a specific version + integrity hash for safety.

let _leafletLoadPromise = null;
function loadLeaflet() {
  if (_leafletLoadPromise) return _leafletLoadPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('Not in browser'));
  if (window.L) return Promise.resolve(window.L);
  _leafletLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
    link.crossOrigin = '';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.async = true;
    script.onload = () => window.L ? resolve(window.L) : reject(new Error('Leaflet failed to load'));
    script.onerror = () => reject(new Error('Failed to load Leaflet'));
    document.head.appendChild(script);
  });
  return _leafletLoadPromise;
}

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

// Phase → color (CSS color string used by Leaflet polylines)
const PHASE_COLORS = {
  pending:    '#64748b',  // slate-500
  preflight:  '#f59e0b',  // amber-500
  airborne:   '#22d3ee',  // cyan-400
  landed:     '#10b981',  // emerald-500
  completed:  '#475569',  // slate-600
};

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
  // Real US map via Leaflet + CARTO dark tiles. Same pattern as the
  // existing TrackingScreen so we get consistent rendering. Map shows:
  //   - All airport endpoints as small dots with code labels
  //   - Great-circle route lines colored by phase (cyan=airborne,
  //     amber=preflight, slate=pending, emerald=landed, dim=completed)
  //   - Airborne flights get a tail-number label on the route line
  //
  // Live aircraft positions and breadcrumb trails are NOT yet plotted
  // here — that's the FlightAware integration that comes next turn.

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(null);

  // Build the routes + airport set in a memo so we don't redo it on
  // every render — only when trips or status change.
  const { routes, airports, missing } = useMemo(() => {
    const r = [];
    const apts = new Map();
    let miss = 0;
    trips.forEach((t) => {
      const fromCode = t.info?.from;
      const toCode = t.info?.to;
      const f = lookupCoords(fromCode);
      const o = lookupCoords(toCode);
      if (!f || !o) { miss++; return; }
      r.push({
        uid: t.uid,
        from: f, to: o, fromCode, toCode,
        phase: tripPhase(t, stateMap.get(t.uid)),
        tail: t.info?.tail || '',
      });
      apts.set(fromCode, { coords: f, code: fromCode });
      apts.set(toCode, { coords: o, code: toCode });
    });
    return { routes: r, airports: Array.from(apts.values()), missing: miss };
  }, [trips, stateMap]);

  // Initialize the Leaflet map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const L = await loadLeaflet();
        if (cancelled || !containerRef.current) return;
        // Fit bounds to continental US by default; will adjust based on
        // actual route data below. This is the initial view.
        const map = L.map(containerRef.current, {
          center: [38, -95],          // geographic center of contiguous US
          zoom: 4,
          zoomControl: false,         // TV doesn't need zoom controls
          attributionControl: false,
          worldCopyJump: false,
          dragging: false,            // TV is a passive display, no panning
          scrollWheelZoom: false,
          doubleClickZoom: false,
          touchZoom: false,
          keyboard: false,
        });
        // CARTO dark tiles for high-contrast TV display. Two layers:
        // base tiles without labels first, then labels on top.
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
          maxZoom: 12, subdomains: 'abcd',
        }).addTo(map);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
          maxZoom: 12, subdomains: 'abcd',
        }).addTo(map);
        // Layer group for our route/marker overlays so we can clear and
        // redraw without disturbing the tile layers.
        const layer = L.layerGroup().addTo(map);
        mapRef.current = map;
        layerRef.current = layer;
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Map failed to load');
      }
    })();
    return () => {
      cancelled = true;
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch (_) {}
        mapRef.current = null;
        layerRef.current = null;
      }
    };
  }, []);

  // ResizeObserver: when the container changes size (TV orientation,
  // window resize), invalidate Leaflet's internal size cache so the
  // tiles re-render at the right dimensions.
  useEffect(() => {
    if (!ready || !mapRef.current || !containerRef.current) return;
    const ro = new ResizeObserver(() => {
      try { mapRef.current.invalidateSize(false); } catch (_) {}
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [ready]);

  // Redraw routes + markers when data changes.
  useEffect(() => {
    if (!ready || !mapRef.current || !layerRef.current) return;
    const L = window.L;
    const map = mapRef.current;
    const layer = layerRef.current;
    layer.clearLayers();

    // Sort routes so airborne renders last (on top of everything else)
    const phaseOrder = { completed: 0, landed: 1, pending: 2, preflight: 3, airborne: 4 };
    const sorted = [...routes].sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);

    // Draw route lines as great-circle polylines (Leaflet's polyline
    // wraps automatically; for continental US distances, a great-
    // circle is visually almost identical to a straight line, so we
    // use a simple two-point polyline. If you want true geodesic
    // curves, we'd need the leaflet-arc plugin.)
    sorted.forEach((r) => {
      const style = {
        color: PHASE_COLORS[r.phase] || PHASE_COLORS.pending,
        weight: r.phase === 'airborne' ? 4 : 2.5,
        opacity: r.phase === 'completed' ? 0.4 : (r.phase === 'landed' ? 0.65 : 1),
        dashArray: r.phase === 'pending' ? '6 6' : r.phase === 'preflight' ? '10 6' : null,
        lineCap: 'round',
        lineJoin: 'round',
      };
      const line = L.polyline([
        [r.from.lat, r.from.lng],
        [r.to.lat, r.to.lng],
      ], style);
      layer.addLayer(line);

      // For airborne flights, add a tail-number label at the midpoint
      if (r.phase === 'airborne' && r.tail) {
        const mid = [
          (r.from.lat + r.to.lat) / 2,
          (r.from.lng + r.to.lng) / 2,
        ];
        const icon = L.divIcon({
          html: `<div style="background: rgba(2,6,23,0.85); border: 1px solid #22d3ee; color: #a5f3fc; padding: 2px 6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; white-space: nowrap; border-radius: 2px;">${r.tail}</div>`,
          className: '',
          iconSize: [60, 18],
          iconAnchor: [30, 9],
        });
        layer.addLayer(L.marker(mid, { icon }));
      }
    });

    // Airport markers — small dots with codes
    airports.forEach((a) => {
      const icon = L.divIcon({
        html: `<div style="width: 6px; height: 6px; background: #94a3b8; border: 1px solid #1e293b; border-radius: 50%;"></div><div style="position: absolute; left: 10px; top: -4px; color: #94a3b8; font-family: 'JetBrains Mono', monospace; font-size: 10px; white-space: nowrap; text-shadow: 0 0 4px #020617, 0 0 4px #020617;">${a.code}</div>`,
        className: '',
        iconSize: [60, 12],
        iconAnchor: [3, 6],
      });
      layer.addLayer(L.marker([a.coords.lat, a.coords.lng], { icon, interactive: false }));
    });

    // Fit map to show all routes/airports with padding, unless there's
    // no data yet (then leave the default continental US view).
    if (airports.length > 0) {
      const bounds = L.latLngBounds(airports.map((a) => [a.coords.lat, a.coords.lng]));
      // Add ~12% padding so markers aren't right at the edges
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7, animate: false });
    }
  }, [ready, routes, airports]);

  return (
    <div className="relative w-full h-full bg-slate-950">
      <div ref={containerRef} className="w-full h-full" style={{ background: '#020617' }} />
      {err && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-red-400 text-sm" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Map failed to load: {err}
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-3 left-3 bg-slate-900/90 border border-slate-800 px-3 py-2 text-[11px] tracking-widest z-[1000]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="flex items-center gap-2 mb-1">
          <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#22d3ee" strokeWidth="4" /></svg>
          <span className="text-cyan-200">AIRBORNE</span>
        </div>
        <div className="flex items-center gap-2 mb-1">
          <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#f59e0b" strokeWidth="2.5" strokeDasharray="10 6" /></svg>
          <span className="text-amber-300">PRE-FLIGHT</span>
        </div>
        <div className="flex items-center gap-2 mb-1">
          <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#64748b" strokeWidth="2.5" strokeDasharray="6 6" /></svg>
          <span className="text-slate-400">PENDING</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="22" height="4"><line x1="0" y1="2" x2="22" y2="2" stroke="#10b981" strokeWidth="2.5" /></svg>
          <span className="text-emerald-300">LANDED</span>
        </div>
      </div>

      {missing > 0 && (
        <div className="absolute bottom-3 right-3 bg-amber-500/20 border border-amber-500/40 text-amber-300 px-2 py-1 text-[10px] z-[1000]" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
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
        <div className="flex items-center gap-5">
          <img
            src="/skyway-logo.png"
            srcSet="/skyway-logo.png 1x, /skyway-logo@2x.png 2x"
            alt="Skyway Aviation"
            className="h-14 w-auto"
            // High-DPI rendering helps the logo look crisp on 4K TVs
            style={{ imageRendering: '-webkit-optimize-contrast' }}
          />
          <div className="border-l border-cyan-500/30 pl-5">
            <h1 className="text-2xl tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
              FLIGHT BOARD
            </h1>
            <p className="text-sm text-slate-400 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nowStr}</p>
          </div>
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
