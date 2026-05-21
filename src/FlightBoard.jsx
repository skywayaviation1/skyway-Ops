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
 *   'airborne'   — wheels_up logged recently, landed not yet
 *   'landed'     — landed logged, OR wheels_up is so old the flight must be down
 *   'completed'  — trip marked complete
 *
 * Important: the "airborne" classification has a STALENESS GUARD. A trip
 * whose wheels_up timestamp is more than 12 hours ago, with no landed
 * timestamp, is NOT airborne — the crew just forgot to tap LANDED. We
 * treat it as 'landed' since the flight definitely terminated even if
 * the data doesn't reflect it. Without this guard, yesterday's flights
 * stay "airborne" forever on the board.
 */
export function tripPhase(trip, state) {
  if (state?.completed) return 'completed';
  const s = state?.statuses || {};
  if (s.landed) return 'landed';
  if (s.wheels_up) {
    // Staleness guard: if wheels_up is older than the longest plausible
    // flight time, the trip really landed but the flag wasn't updated.
    const upAt = s.wheels_up.at || 0;
    const ageMs = Date.now() - upAt;
    const MAX_AIRBORNE_MS = 12 * 60 * 60 * 1000;  // 12h
    if (upAt > 0 && ageMs > MAX_AIRBORNE_MS) {
      return 'landed';  // treat as landed since it definitely is by now
    }
    return 'airborne';
  }
  // Any pre-flight step counts as preflight
  for (const step of ['crew_onsite', 'aircraft_ready', 'catering_aboard', 'pax_arrived', 'pax_boarded', 'taxi_dep']) {
    if (s[step]) return 'preflight';
  }
  return 'pending';
}

// ====================================================================
// FLIGHT LIST ROW
// ====================================================================

function FlightRow({ trip, state, faPosition, phase }) {
  // Phase is now computed by parent (uses both Firestore status + live
  // FlightAware data). Fall back to local if not provided.
  if (!phase) phase = tripPhase(trip, state);
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

  // For airborne flights, replace the TYPE column with live ETA + time
  // remaining. Pulled from FlightAware's estimatedOn field.
  let etaCellContent = null;
  if (phase === 'airborne' && faPosition?.estimatedOn) {
    try {
      const etaDate = new Date(faPosition.estimatedOn);
      const remainMs = etaDate.getTime() - Date.now();
      const etaStr = etaDate.toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York',
      }).replace(' ', '');
      let remainStr = '';
      if (remainMs > 0) {
        const h = Math.floor(remainMs / 3600_000);
        const m = Math.floor((remainMs % 3600_000) / 60_000);
        remainStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
      } else {
        remainStr = 'landing';
      }
      etaCellContent = (
        <div>
          <div className="text-sm text-cyan-200 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ETA {etaStr}
          </div>
          <div className="text-[10px] text-cyan-400/80 tabular-nums tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {remainStr} left
          </div>
        </div>
      );
    } catch (_) {}
  }

  // Progress percent from FA (0-100). Used to draw the progress bar
  // below the row for airborne flights. Fall back to time-based
  // estimate if FA didn't provide one (this happens sometimes for
  // short hops): elapsed / total = elapsed / (eta - departure).
  let progressPct = null;
  if (phase === 'airborne') {
    if (Number.isFinite(faPosition?.progressPercent)) {
      progressPct = Math.max(0, Math.min(100, faPosition.progressPercent));
    } else if (faPosition?.estimatedOn && faPosition?.actualOff) {
      try {
        const departed = new Date(faPosition.actualOff).getTime();
        const arriving = new Date(faPosition.estimatedOn).getTime();
        const total = arriving - departed;
        const elapsed = Date.now() - departed;
        if (total > 0 && elapsed >= 0) {
          progressPct = Math.max(0, Math.min(100, (elapsed / total) * 100));
        }
      } catch (_) {}
    }
  }

  return (
    <div className={`border-b border-slate-800 ${phase === 'airborne' ? 'bg-cyan-500/5' : ''}`}>
      <div className="grid grid-cols-[80px_120px_180px_110px_1fr_60px] gap-3 items-center px-3 py-2.5">
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
        {/* TYPE column — replaced with ETA/remaining for airborne flights */}
        <div className="text-xs tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {etaCellContent || (trip.info?.legType === 'REVENUE' ? 'REVENUE' : 'REPO')}
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
      {/* Progress bar — only renders for airborne flights with progress
          data from FA. Shows the from/to airport codes at each end so
          even glanceable from across the room you know what's flying. */}
      {phase === 'airborne' && progressPct != null && (
        <div className="px-3 pb-2 -mt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-cyan-400 tabular-nums w-8 text-right" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {trip.info?.from || ''}
            </span>
            <div className="flex-1 h-1.5 bg-slate-800/80 rounded-sm relative overflow-visible">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-1000"
                style={{ width: `${progressPct}%` }}
              />
              {/* Plane icon at progress tip */}
              <div
                className="absolute top-1/2 w-2 h-2 -mt-1 rounded-full bg-cyan-300"
                style={{
                  left: `calc(${progressPct}% - 4px)`,
                  boxShadow: '0 0 6px rgba(34,211,238,0.9)',
                }}
              />
            </div>
            <span className="text-[10px] text-cyan-400 tabular-nums w-8" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {trip.info?.to || ''}
            </span>
            <span className="text-[10px] text-cyan-300 tabular-nums w-8 text-right" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {Math.round(progressPct)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ====================================================================
// ROUTE MAP
// ====================================================================

function RouteMap({ trips, stateMap, faPositions, effectivePhase }) {
  // Real US map via Leaflet + CARTO dark tiles. Same pattern as the
  // existing TrackingScreen so we get consistent rendering. Map shows:
  //   - All airport endpoints as small dots with code labels
  //   - Route lines colored by phase (cyan=airborne, amber=preflight,
  //     slate=pending, emerald=landed, dim=completed)
  //   - Airborne flights get a tail-number label AND a live aircraft
  //     marker at the FlightAware-reported lat/lng
  //
  // Breadcrumb trails (past positions of airborne flights) NOT yet
  // plotted — separate fetch per tail; planned for follow-up.

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
      const phase = effectivePhase
        ? effectivePhase(t, stateMap.get(t.uid))
        : tripPhase(t, stateMap.get(t.uid));
      r.push({
        uid: t.uid,
        from: f, to: o, fromCode, toCode,
        phase,
        tail: t.info?.tail || '',
      });
      apts.set(fromCode, { coords: f, code: fromCode });
      apts.set(toCode, { coords: o, code: toCode });
    });
    return { routes: r, airports: Array.from(apts.values()), missing: miss };
  }, [trips, stateMap, effectivePhase]);

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

    // Live aircraft markers — for each FA-reported airborne tail, drop a
    // plane icon at its actual lat/lng, rotated to its heading. This is
    // what makes the board feel "live" — the marker moves every 30s as
    // FA reports updated positions.
    //
    // The SVG plane icon is hand-rolled (avoids dependency on an icon
    // library) and rotated via CSS transform. Tail number floats above
    // the plane so it's identifiable from across the room.
    if (faPositions) {
      Object.values(faPositions).forEach((p) => {
        if (!p) return;
        // === Airborne: cyan plane at lat/lng, rotated to heading ===
        if (p.airborne === true) {
          const lat = p.latitude;
          const lon = p.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          const heading = Number.isFinite(p.heading) ? p.heading : 0;
          const altStr = Number.isFinite(p.altitude)
            ? (p.altitude >= 18000 ? `FL${Math.round(p.altitude / 100)}` : `${Math.round(p.altitude)}ft`)
            : '';
          const spdStr = Number.isFinite(p.groundspeed) ? `${Math.round(p.groundspeed)}kt` : '';
          const planeSvg = `
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style="transform: rotate(${heading}deg); transform-origin: center; filter: drop-shadow(0 0 4px rgba(34,211,238,0.7));">
              <path d="M12 2 L13.5 10 L22 12 L22 14 L13.5 14 L13 19 L15 21 L15 22 L12 21 L9 22 L9 21 L11 19 L10.5 14 L2 14 L2 12 L10.5 10 Z"
                    fill="#22d3ee" stroke="#0e7490" stroke-width="0.5"/>
            </svg>`;
          const labelHtml = `
            <div style="position: absolute; left: 32px; top: -4px; background: rgba(2,6,23,0.9); border: 1px solid #22d3ee; padding: 2px 5px; white-space: nowrap;">
              <div style="color: #a5f3fc; font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; line-height: 1;">${p.ident}</div>
              <div style="color: #67e8f9; font-family: 'JetBrains Mono', monospace; font-size: 9px; line-height: 1.4; margin-top: 1px;">${altStr} ${spdStr}</div>
            </div>`;
          const icon = L.divIcon({
            html: planeSvg + labelHtml,
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });
          layer.addLayer(L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1000 }));
          return;
        }
        // === Grounded: small grey aircraft icon at last-known parking. ===
        // This is what FA returns when the flight isn't yet detected as
        // airborne. Helps us see fleet locations even when no one is
        // flying yet, and is a visible signal that FA *sees* the tail
        // even if it hasn't picked up takeoff yet.
        if (p.airborne === false && Number.isFinite(p.groundedLat) && Number.isFinite(p.groundedLon)) {
          const planeSvg = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 2 L13.5 10 L22 12 L22 14 L13.5 14 L13 19 L15 21 L15 22 L12 21 L9 22 L9 21 L11 19 L10.5 14 L2 14 L2 12 L10.5 10 Z"
                    fill="#64748b" stroke="#1e293b" stroke-width="0.5"/>
            </svg>`;
          const labelHtml = `
            <div style="position: absolute; left: 20px; top: -2px; color: #94a3b8; font-family: 'JetBrains Mono', monospace; font-size: 10px; white-space: nowrap; text-shadow: 0 0 4px #020617, 0 0 4px #020617;">
              ${p.ident}${p.groundedAt ? ` · ${p.groundedAt}` : ''}
            </div>`;
          const icon = L.divIcon({
            html: planeSvg + labelHtml,
            className: '',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          layer.addLayer(L.marker([p.groundedLat, p.groundedLon], { icon, interactive: false, zIndexOffset: 500 }));
        }
      });
    }

    // Fit map to show all routes/airports with padding, unless there's
    // no data yet (then leave the default continental US view). Include
    // live FA positions in bounds so airborne aircraft stay visible
    // even if they're flying past their destination airport.
    if (airports.length > 0) {
      const allPoints = airports.map((a) => [a.coords.lat, a.coords.lng]);
      if (faPositions) {
        Object.values(faPositions).forEach((p) => {
          if (p && p.airborne && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
            allPoints.push([p.latitude, p.longitude]);
          }
        });
      }
      const bounds = L.latLngBounds(allPoints);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7, animate: false });
    }
  }, [ready, routes, airports, faPositions]);

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
  // FlightAware live data: keyed by tail. Each entry is the position
  // object returned by /api/flightaware-positions:
  //   { ident, airborne, latitude, longitude, heading, altitude,
  //     groundspeed, estimatedOn, progressPercent, ... }
  const [faPositions, setFaPositions] = useState({});
  const [trackingEnabled, setTrackingEnabled] = useState(true); // default true; subscription will confirm
  // Visible diagnostic — rendered on the board so we can see WHY FA
  // isn't showing data, without needing dev tools. Status is one of
  // 'ok', 'error', 'disabled', 'idle'. Cleared on success.
  const [faDiag, setFaDiag] = useState({ status: 'idle', message: 'Initializing…' });

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

  // Subscribe to the FlightAware tracking-enabled toggle. The board
  // respects the same kill switch the existing TRACKING screen uses,
  // so admins can turn off FA queries (e.g. to control cost) and the
  // board stops polling without needing a config change.
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try {
        const { db } = await import('./firebase.js');
        const { doc, onSnapshot } = await import('firebase/firestore');
        unsub = onSnapshot(doc(db, 'flightaware', 'config'), (snap) => {
          if (snap.exists()) {
            setTrackingEnabled(snap.data().trackingEnabled !== false);
          }
        });
      } catch (e) {
        console.warn('[board] FA config subscribe failed:', e);
      }
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
      // STRICT TODAY ONLY. Previous "today + last 24h in-progress" caught
      // phantom airborne trips from yesterday (where wheels_up was logged
      // but landed never was). The phase staleness guard in tripPhase()
      // handles those separately. Here we just want today's calendar.
      return ts >= todayStart && ts < todayEnd;
    });
    candidate.sort((a, b) => {
      const ta = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const tb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return ta - tb;
    });
    return candidate;
  }, [allTrips, stateMap]);

  // Distinct fleet tails appearing in today's flights — what we'll poll
  // FA for. Memo'd separately so the polling effect doesn't re-run on
  // every state change, only when the set of tails actually changes.
  const fleetTails = useMemo(() => {
    const set = new Set();
    active.forEach((t) => {
      const tail = (t.info?.tail || '').toUpperCase().trim();
      if (tail) set.add(tail);
    });
    return Array.from(set).sort();
  }, [active]);

  // Poll FlightAware positions for the fleet tails every 30s while the
  // board is open AND tracking is enabled. Same pattern as the existing
  // TrackingScreen; cost-controlled by the trackingEnabled toggle.
  // First call fires immediately, then interval-based.
  useEffect(() => {
    // EMERGENCY DISABLE: this hardcoded gate is here because the
    // FlightBoard's FA polling may have caused a rate-limit cascade
    // that broke the existing TRACKING tab. Until we confirm the
    // pipeline is healthy, the board polls nothing and uses status-
    // step data only. Set BOARD_FA_POLLING to true once verified.
    const BOARD_FA_POLLING = false;
    if (!BOARD_FA_POLLING) {
      setFaPositions({});
      setFaDiag({ status: 'disabled', message: 'Board FA polling temporarily disabled — see TRACKING tab for live data' });
      return;
    }
    if (!trackingEnabled) {
      setFaPositions({});
      setFaDiag({ status: 'disabled', message: 'FA tracking disabled in admin' });
      return;
    }
    if (fleetTails.length === 0) {
      setFaPositions({});
      setFaDiag({ status: 'idle', message: 'No active tails to poll' });
      return;
    }
    let cancelled = false;
    let timer = null;
    async function poll() {
      try {
        const { auth } = await import('./firebase.js');
        const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
        if (!idToken) {
          if (!cancelled) setFaDiag({ status: 'error', message: 'Not signed in — cannot poll FA' });
          return;
        }
        const r = await fetch('/api/flightaware-positions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, idents: fleetTails }),
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          if (!cancelled) setFaDiag({ status: 'error', message: `FA HTTP ${r.status}: ${text.slice(0, 80)}` });
          return;
        }
        const data = await r.json();
        const positions = Array.isArray(data?.positions) ? data.positions : [];
        if (cancelled) return;
        const map = {};
        let airborneCount = 0;
        for (const p of positions) {
          if (p && p.ident) {
            map[String(p.ident).toUpperCase()] = p;
            if (p.airborne) airborneCount++;
          }
        }
        setFaPositions(map);
        // Log the raw response when nothing is airborne — helps diagnose
        // why FA isn't seeing what crew/tracking-tab sees.
        if (airborneCount === 0 && positions.length > 0) {
          console.log('[board] FA returned 0 airborne. Raw positions:', positions);
        }
        setFaDiag({
          status: 'ok',
          message: `Polled ${fleetTails.length} tails · ${airborneCount} airborne · ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false })}`,
        });
      } catch (e) {
        if (!cancelled) setFaDiag({ status: 'error', message: 'FA poll exception: ' + (e?.message || 'unknown') });
      }
    }
    poll();
    // Poll every 15s per ops request. FlightAware caches at ~30s server
    // side so we won't actually get more granular data than that, but
    // 15s ensures we pick up updates as soon as the cache refreshes.
    timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [trackingEnabled, fleetTails.join(',')]);

  // Compute the effective phase for a trip using BOTH Firestore status
  // steps AND FlightAware live data. FA is ground truth for "is the
  // plane actually flying right now?" — if FA says airborne=true,
  // override our status-step-derived phase. If FA says airborne=false
  // AND wheels_up was logged, treat as landed (the flight terminated
  // even if nobody tapped LANDED). For tails we have no FA data on,
  // fall back to status-steps-only via tripPhase().
  const effectivePhase = (trip, state) => {
    const tail = (trip.info?.tail || '').toUpperCase();
    const fa = faPositions[tail];
    const stepPhase = tripPhase(trip, state);
    if (!fa) return stepPhase;
    if (fa.airborne === true) return 'airborne';
    // FA says not airborne. If our steps say airborne, we've been wrong —
    // the flight landed.
    if (stepPhase === 'airborne') return 'landed';
    return stepPhase;
  };

  // Filter active trips to those that are still relevant — hide trips
  // whose effective phase is `landed` or `completed`. The `active`
  // memo already filters by today-only, but a trip that started today,
  // flew, and landed (whether logged or determined via the 12h
  // staleness guard) shouldn't keep cluttering the board. Without this,
  // the morning's 6:59 AM repo would stay on the board all day.
  //
  // This memo also depends on faPositions so when FA reports a flight
  // has landed, that trip drops off the board immediately.
  const visible = useMemo(() => {
    return active.filter((t) => {
      const phase = effectivePhase(t, stateMap.get(t.uid));
      return phase !== 'landed' && phase !== 'completed';
    });
  }, [active, stateMap, faPositions]);

  // Summary stats for the header. Uses effectivePhase so FA contradictions
  // count: a tail FA reports as airborne shows in the AIRBORNE counter
  // even if status steps haven't caught up; a stale "airborne" tail FA
  // reports as not-flying gets demoted out of the counter.
  const stats = useMemo(() => {
    let airborne = 0, preflight = 0, pending = 0;
    visible.forEach((t) => {
      const phase = effectivePhase(t, stateMap.get(t.uid));
      if (phase === 'airborne') airborne++;
      else if (phase === 'preflight') preflight++;
      else if (phase === 'pending') pending++;
    });
    return { airborne, preflight, pending, total: visible.length };
  }, [visible, stateMap, faPositions]);

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
            {/* FA diagnostic — color-coded per status. Visible on the
                board so we can see why live data is or isn't appearing
                without needing dev tools. */}
            <p
              className={`text-[10px] mt-0.5 tracking-widest ${
                faDiag.status === 'ok' ? 'text-emerald-400/70'
                : faDiag.status === 'error' ? 'text-red-400'
                : faDiag.status === 'disabled' ? 'text-amber-400'
                : 'text-slate-500'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title={faDiag.message}
            >
              FA · {faDiag.message}
            </p>
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
          {visible.length === 0 ? (
            <div className="p-12 text-center text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NO ACTIVE FLIGHTS
            </div>
          ) : (
            visible.map((t) => (
              <FlightRow
                key={t.uid}
                trip={t}
                state={stateMap.get(t.uid)}
                faPosition={faPositions[(t.info?.tail || '').toUpperCase()]}
                phase={effectivePhase(t, stateMap.get(t.uid))}
              />
            ))
          )}
        </div>

        {/* Map */}
        <div className="bg-slate-950">
          <RouteMap
            trips={visible}
            stateMap={stateMap}
            faPositions={faPositions}
            effectivePhase={effectivePhase}
          />
        </div>
      </div>
    </div>
  );
}

export default FlightBoard;
