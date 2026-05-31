// TripTrack.jsx — PUBLIC broker-facing trip tracking page.
//
// Mounted by main.jsx when the URL path is /trip-track.  Reads ?token=...
// and hits /api/trip-public for sanitized trip data + live position.  No
// Firebase auth here — the page is intentionally usable by anyone with a
// valid token.
//
// What we show:
//   - Tail + aircraft type
//   - All legs of the trip (repositioning legs labeled clearly)
//   - For each leg: from → to, FBO names, scheduled times, actual times, PIC name
//   - Live position on a map (Leaflet + OpenStreetMap tiles) when airborne
//   - Post-flight track for completed legs (toggle to show)
//   - Status timeline per leg (departed / airborne / landed / etc.)
//
// What we DO NOT show (sanitization happens server-side too, this is belt+suspenders):
//   - Passenger names
//   - Crew contact info
//   - Internal notes
//   - Pricing / fees / fuel costs

import React, { useEffect, useRef, useState } from 'react';
import {
  Plane, MapPin, Clock, AlertCircle, RefreshCw, Loader2,
  ArrowRight, CheckCircle2, Circle,
} from 'lucide-react';
import { formatLocalTime, formatLocalDate } from './airports.js';

const POLL_MS = 120000; // refresh live position every 2 minutes

// Format an ISO timestamp as the LOCAL time at the given airport. Brokers
// expect to see times in the trip's own time zone — not whatever timezone
// their phone happens to be in. Falls back to device-local time with a
// short TZ abbreviation if the airport isn't in our timezone database
// (formatLocalTime handles that fallback internally).
function fmtAirportTime(iso, iataCode) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const { time, tz } = formatLocalTime(d, iataCode);
    const date = formatLocalDate(d, iataCode);
    return `${date} · ${time}${tz ? ' ' + tz : ''}`;
  } catch {
    return '—';
  }
}

// Compact time-only version (no date) for the hero card + status badges
// where the full date is redundant. Same TZ-aware fallback behavior.
function fmtAirportTimeShort(iso, iataCode) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const { time, tz } = formatLocalTime(d, iataCode);
    return `${time}${tz ? ' ' + tz : ''}`;
  } catch {
    return '—';
  }
}

// ====================================================================
// HERO CARD — overall trip status at the top of the broker page
// ====================================================================
// Computes the single most important state and renders it large for the
// broker to see at a glance.
function HeroCard({ trip, position }) {
  const legs = Array.isArray(trip?.legs) ? trip.legs : [];
  if (legs.length === 0) return null;

  // Find the "active" leg in priority order:
  //   1. A leg with wheels_up and not yet landed → IN FLIGHT
  //   2. A leg with any preflight status logged → ON THE GROUND
  //   3. All legs landed → COMPLETED
  //   4. Nothing started → SCHEDULED (first leg)
  let mode = 'scheduled';
  let activeLeg = legs[0];
  const airborneLeg = legs.find((l) => l.status?.wheels_up && !l.status?.landed);
  if (airborneLeg) {
    mode = 'airborne';
    activeLeg = airborneLeg;
  } else {
    const preflightLeg = legs.find((l) =>
      l.status && (l.status.crew_onsite || l.status.aircraft_ready || l.status.taxi_dep
                || l.status.catering_aboard || l.status.pax_arrived || l.status.pax_boarded)
      && !l.status.wheels_up && !l.status.landed
    );
    if (preflightLeg) {
      mode = 'preflight';
      activeLeg = preflightLeg;
    } else if (legs.every((l) => l.status?.landed)) {
      mode = 'completed';
      activeLeg = legs[legs.length - 1];
    }
  }

  // Visual palette per mode
  const palette = {
    airborne:  { label: 'IN FLIGHT',    badgeBg: 'bg-cyan-500/20',    badgeBorder: 'border-cyan-400/50',   text: 'text-cyan-300',  glow: 'shadow-[0_0_24px_rgba(34,211,238,0.15)]' },
    preflight: { label: 'ON THE GROUND',badgeBg: 'bg-amber-500/20',   badgeBorder: 'border-amber-400/50',  text: 'text-amber-200', glow: '' },
    scheduled: { label: 'SCHEDULED',    badgeBg: 'bg-slate-700/40',   badgeBorder: 'border-slate-600/50',  text: 'text-slate-200', glow: '' },
    completed: { label: 'COMPLETED',    badgeBg: 'bg-emerald-500/20', badgeBorder: 'border-emerald-400/50',text: 'text-emerald-300', glow: '' },
  }[mode];

  // Subtitle line varies by mode
  let subtitle = null;
  if (mode === 'airborne') {
    // ETA preferred from FA position; fall back to scheduled arrival
    const eta = position?.estimatedOn || activeLeg.arrival;
    subtitle = (
      <>
        {activeLeg.from} → {activeLeg.to}
        {eta && (
          <span className="text-slate-400 font-normal"> · ETA {fmtAirportTimeShort(eta, activeLeg.to)}</span>
        )}
      </>
    );
  } else if (mode === 'preflight') {
    subtitle = (
      <>
        Preparing for departure · {activeLeg.from} → {activeLeg.to}
        {activeLeg.departure && (
          <span className="text-slate-400 font-normal"> · STD {fmtAirportTimeShort(activeLeg.departure, activeLeg.from)}</span>
        )}
      </>
    );
  } else if (mode === 'completed') {
    subtitle = <>All legs completed · {legs.length === 1 ? '1 leg' : `${legs.length} legs`}</>;
  } else { /* scheduled */
    subtitle = (
      <>
        First departure {activeLeg.from} → {activeLeg.to}
        {activeLeg.departure && (
          <span className="text-slate-400 font-normal"> · {fmtAirportTimeShort(activeLeg.departure, activeLeg.from)}</span>
        )}
      </>
    );
  }

  return (
    <div className={`border ${palette.badgeBorder} ${palette.badgeBg} p-4 ${palette.glow}`}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`text-[10px] tracking-[0.2em] font-mono ${palette.text}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {palette.label}
        </div>
        {mode === 'airborne' && (
          <div className="flex items-center gap-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400"></span>
            </span>
            <span className="text-[9px] text-cyan-400 font-mono tracking-wider">LIVE</span>
          </div>
        )}
        {trip.tail && (
          <div className="ml-auto text-[10px] text-slate-500 font-mono tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {trip.tail}{trip.aircraftType ? ` · ${trip.aircraftType}` : ''}
          </div>
        )}
      </div>
      <div className={`text-2xl ${palette.text}`} style={{ fontFamily: 'Bebas Neue, sans-serif', letterSpacing: '0.04em' }}>
        {subtitle}
      </div>
      {mode === 'airborne' && position && (
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-slate-500 text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ALT</div>
            <div className="text-slate-100 font-mono">
              {Number.isFinite(position.altitude)
                ? (position.altitude >= 18000 ? `FL${Math.round(position.altitude/100)}` : `${Math.round(position.altitude).toLocaleString()} ft`)
                : '—'}
            </div>
          </div>
          <div>
            <div className="text-slate-500 text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>SPEED</div>
            <div className="text-slate-100 font-mono">
              {Number.isFinite(position.groundspeed) ? `${Math.round(position.groundspeed)} kt` : '—'}
            </div>
          </div>
          <div>
            <div className="text-slate-500 text-[10px] tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>HEADING</div>
            <div className="text-slate-100 font-mono">
              {Number.isFinite(position.heading) ? `${Math.round(position.heading)}°` : '—'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ====================================================================
// LIVE badge — small "LIVE" indicator with pulsing dot for the active leg
// ====================================================================
function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 border border-cyan-400/50 bg-cyan-500/20">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400"></span>
      </span>
      <span className="text-[9px] text-cyan-300 font-mono tracking-wider" style={{ fontFamily: 'JetBrains Mono, monospace' }}>LIVE</span>
    </span>
  );
}

// ====================================================================
// Per-leg progress bar
// ====================================================================
// Strategy:
//   - Pre-departure (no wheels_up): 0% (or scheduled-time-based if we want a "departing soon" feel — keeping it simple at 0)
//   - Airborne: linear from wheels_up → ETA (estimatedOn || scheduled arrival)
//   - Landed: 100%
//
// Returns null when there's nothing useful to show (a future leg with no
// timestamps yet) so the UI doesn't render a 0% bar everywhere.
function LegProgress({ leg, position }) {
  const status = leg?.status || {};
  // Landed = full bar
  if (status.landed) {
    return (
      <div className="w-full h-1 bg-slate-800 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: '100%' }} />
      </div>
    );
  }
  // Airborne = compute % between wheels_up and arrival/ETA
  if (status.wheels_up) {
    const start = status.wheels_up.at;
    // Prefer FA ETA if it pertains to this leg (matches the destination code),
    // otherwise fall back to scheduled arrival.
    let end = null;
    if (position?.estimatedOn && position.destination
        && String(position.destination).toUpperCase() === String(leg.to).toUpperCase()) {
      end = new Date(position.estimatedOn).getTime();
    }
    if (!end && leg.arrival) end = new Date(leg.arrival).getTime();
    if (start && end && end > start) {
      const now = Date.now();
      const pct = Math.max(2, Math.min(98, ((now - start) / (end - start)) * 100));
      return (
        <div className="w-full h-1 bg-slate-800 overflow-hidden">
          <div className="h-full bg-cyan-400 transition-all duration-1000" style={{ width: `${pct}%` }} />
        </div>
      );
    }
    // Airborne but no ETA — show indeterminate bar
    return (
      <div className="w-full h-1 bg-slate-800 overflow-hidden">
        <div className="h-full bg-cyan-400/50" style={{ width: '50%' }} />
      </div>
    );
  }
  // Nothing yet — empty bar
  return (
    <div className="w-full h-1 bg-slate-800 overflow-hidden">
      <div className="h-full bg-slate-700" style={{ width: '0%' }} />
    </div>
  );
}

function categoryBadge(cat) {
  const c = String(cat || 'REVENUE').toUpperCase();
  if (c === 'REPO' || c === 'FERRY' || c === 'REPOSITIONING') {
    return { text: 'REPOSITIONING', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  }
  return { text: 'CHARTER LEG', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' };
}

function StatusDot({ on, label, ts, iataCode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {on
        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        : <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
      <span className={on ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
      {on && ts && <span className="text-slate-500 text-[10px] ml-auto">{fmtAirportTime(ts, iataCode)}</span>}
    </div>
  );
}

// Lightweight Leaflet loader (no API key needed). Pinned to a specific
// version + integrity hashes — same approach used by FlightBoard.jsx.
// We only load the script + CSS once per page; further calls reuse the
// in-flight promise.
let _leafletLoading = null;
function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.L) return Promise.resolve(window.L);
  if (_leafletLoading) return _leafletLoading;
  _leafletLoading = new Promise((resolve, reject) => {
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
  return _leafletLoading;
}

// Phase colors matched to FlightBoard's RouteMap so the broker view feels
// like the same product. Cyan = airborne, amber = preflight, slate = pending,
// emerald = landed, dim slate = completed.
const BROKER_PHASE_COLORS = {
  pending:    '#64748b',
  preflight:  '#f59e0b',
  airborne:   '#22d3ee',
  landed:     '#10b981',
  completed:  '#475569',
};

// Derive a phase per leg from its status timeline. Uses the same status
// step IDs the ops app records (crew_onsite / aircraft_ready / taxi_dep /
// wheels_up / landed), with FlightBoard's 12-hour staleness guard.
function legPhase(leg) {
  const s = leg?.status || {};
  if (s.landed) return 'landed';
  if (s.wheels_up) {
    const upAt = s.wheels_up.at || 0;
    // 12h staleness guard: forgotten LANDED tap shouldn't leave a leg
    // permanently airborne. After 12h with no landed, treat as landed.
    if (upAt > 0 && (Date.now() - upAt) > 12 * 60 * 60 * 1000) return 'landed';
    return 'airborne';
  }
  if (s.crew_onsite || s.aircraft_ready || s.taxi_dep ||
      s.catering_aboard || s.pax_arrived || s.pax_boarded) return 'preflight';
  return 'pending';
}

function LiveMap({ position, legs }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);          // overlay group we can clear/redraw
  const aircraftMarkerRef = useRef(null);
  const [mapErr, setMapErr] = useState('');
  const [ready, setReady] = useState(false);
  // Bumped when async airport lookups resolve so routes that needed coords
  // get redrawn.
  const [coordsTick, setCoordsTick] = useState(0);

  // ====================================================================
  // Initial map setup — runs once.
  // ====================================================================
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current) return;
      const map = L.map(containerRef.current, {
        center: [38, -95],          // CONUS center; we fit-bounds below
        zoom: 4,
        zoomControl: true,
        attributionControl: true,
        worldCopyJump: false,
      });
      // Satellite base + dark labels overlay — same combination FlightBoard
      // uses on the ops dashboard. The dimmed tilePane keeps the satellite
      // from overwhelming the cyan overlays.
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 12,
        attribution: 'Tiles &copy; Esri',
      }).addTo(map);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
        maxZoom: 12, subdomains: 'abcd', opacity: 0.8,
        attribution: '&copy; CARTO',
      }).addTo(map);
      const tilePane = map.getPane('tilePane');
      if (tilePane) tilePane.style.filter = 'brightness(0.65) contrast(1.1) saturate(0.85)';
      // Overlay layer group — we clear and redraw routes/markers on data updates
      // without disturbing the tile layers underneath.
      const layer = L.layerGroup().addTo(map);
      mapRef.current = map;
      layerRef.current = layer;
      if (!cancelled) setReady(true);
    }).catch((e) => {
      setMapErr(e.message || 'Map failed to load');
    });
    return () => {
      cancelled = true;
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch (_) {}
        mapRef.current = null;
        layerRef.current = null;
      }
      aircraftMarkerRef.current = null;
    };
  }, []);

  // ====================================================================
  // Resolve any missing airport codes via the same server endpoint
  // FlightBoard uses (OurAirports). This lets broker pages show non-US
  // / smaller airports that aren't in the bundled coords DB.
  // ====================================================================
  const askedRef = useRef(new Set());
  useEffect(() => {
    if (!Array.isArray(legs) || legs.length === 0) return;
    let cancelled = false;
    (async () => {
      const { lookupCoords } = await import('./airport-coords.js');
      // Find codes referenced by this trip that aren't yet known.
      const missing = [];
      legs.forEach((leg) => {
        [leg.from, leg.to].forEach((code) => {
          if (!code) return;
          const c = String(code).toUpperCase().trim();
          if (!lookupCoords(c) && !askedRef.current.has(c)) missing.push(c);
        });
      });
      if (missing.length === 0) return;
      for (const c of missing) askedRef.current.add(c);
      try {
        const r = await fetch('/api/airport-coords-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: missing }),
        });
        if (!r.ok) {
          // Un-mark so a future render can retry on network blip
          for (const c of missing) askedRef.current.delete(c);
          return;
        }
        const data = await r.json();
        if (cancelled) return;
        if (data.cacheReady === false) {
          // OurAirports cache cold-starting; retry in a minute
          setTimeout(() => {
            for (const c of missing) askedRef.current.delete(c);
            setCoordsTick((t) => t + 1);
          }, 60_000);
          return;
        }
        const { addDynamicCoords } = await import('./airport-coords.js');
        let added = 0;
        for (const [code, coords] of Object.entries(data.coords || {})) {
          if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon || coords.lng)) {
            addDynamicCoords(code, coords.lat, coords.lon ?? coords.lng);
            added++;
          }
        }
        if (added > 0 && !cancelled) setCoordsTick((t) => t + 1);
      } catch (e) {
        for (const c of missing) askedRef.current.delete(c);
      }
    })();
    return () => { cancelled = true; };
  }, [legs]);

  // ====================================================================
  // Draw routes + airport markers + plane on every data change.
  // ====================================================================
  useEffect(() => {
    if (!ready || !mapRef.current || !layerRef.current) return;
    const L = window.L;
    const layer = layerRef.current;
    let cancelled = false;
    (async () => {
      const { lookupCoords } = await import('./airport-coords.js');
      if (cancelled) return;
      layer.clearLayers();
      aircraftMarkerRef.current = null;

      // Build resolved leg list (only legs whose airports we have coords for)
      const resolved = [];
      const aptSet = new Map();
      (legs || []).forEach((leg) => {
        const f = lookupCoords(leg.from);
        const o = lookupCoords(leg.to);
        if (!f || !o) return;
        resolved.push({ ...leg, fCoord: f, oCoord: o, phase: legPhase(leg) });
        aptSet.set(String(leg.from).toUpperCase(), { coords: f, code: leg.from });
        aptSet.set(String(leg.to).toUpperCase(), { coords: o, code: leg.to });
      });

      // Draw routes — colored by phase, mirroring FlightBoard's rules.
      resolved.forEach((r) => {
        if (r.phase === 'airborne') {
          const havePos = position
            && position.airborne === true
            && Number.isFinite(position.latitude)
            && Number.isFinite(position.longitude);
          if (havePos) {
            // Flown portion: origin → current position
            layer.addLayer(L.polyline(
              [[r.fCoord.lat, r.fCoord.lng], [position.latitude, position.longitude]],
              { color: '#22d3ee', weight: 4, opacity: 1, lineCap: 'round', lineJoin: 'round' }
            ));
            // Remaining: current → destination, dashed faint cyan
            layer.addLayer(L.polyline(
              [[position.latitude, position.longitude], [r.oCoord.lat, r.oCoord.lng]],
              { color: '#22d3ee', weight: 2.5, opacity: 0.5, dashArray: '6 6', lineCap: 'round', lineJoin: 'round' }
            ));
          } else {
            // Airborne but no FA position yet — full route as dashed cyan
            layer.addLayer(L.polyline(
              [[r.fCoord.lat, r.fCoord.lng], [r.oCoord.lat, r.oCoord.lng]],
              { color: '#22d3ee', weight: 3, opacity: 0.8, dashArray: '6 6', lineCap: 'round', lineJoin: 'round' }
            ));
          }
          return;
        }
        if (r.phase === 'landed' || r.phase === 'completed') {
          layer.addLayer(L.polyline(
            [[r.fCoord.lat, r.fCoord.lng], [r.oCoord.lat, r.oCoord.lng]],
            { color: '#10b981', weight: 2, opacity: 0.45, lineCap: 'round', lineJoin: 'round' }
          ));
          return;
        }
        // Pending / preflight
        layer.addLayer(L.polyline(
          [[r.fCoord.lat, r.fCoord.lng], [r.oCoord.lat, r.oCoord.lng]],
          {
            color: BROKER_PHASE_COLORS[r.phase] || BROKER_PHASE_COLORS.pending,
            weight: 2.5, opacity: 0.85,
            dashArray: r.phase === 'pending' ? '6 6' : '10 6',
            lineCap: 'round', lineJoin: 'round',
          }
        ));
      });

      // Airport dots + labels
      Array.from(aptSet.values()).forEach((a) => {
        const icon = L.divIcon({
          html: `<div style="width: 6px; height: 6px; background: #94a3b8; border: 1px solid #1e293b; border-radius: 50%;"></div><div style="position: absolute; left: 10px; top: -4px; color: #94a3b8; font-family: 'JetBrains Mono', monospace; font-size: 10px; white-space: nowrap; text-shadow: 0 0 4px #020617, 0 0 4px #020617;">${a.code}</div>`,
          className: '',
          iconSize: [60, 12],
          iconAnchor: [3, 6],
        });
        layer.addLayer(L.marker([a.coords.lat, a.coords.lng], { icon, interactive: false }));
      });

      // Live aircraft marker — cyan plane rotated to heading. Same SVG +
      // label style as FlightBoard's RouteMap for visual continuity.
      if (position && position.airborne === true
          && Number.isFinite(position.latitude)
          && Number.isFinite(position.longitude)) {
        const heading = Number.isFinite(position.heading) ? position.heading : 0;
        const altStr = Number.isFinite(position.altitude)
          ? (position.altitude >= 18000 ? `FL${Math.round(position.altitude / 100)}` : `${Math.round(position.altitude)}ft`)
          : '';
        const spdStr = Number.isFinite(position.groundspeed) ? `${Math.round(position.groundspeed)}kt` : '';
        const planeSvg = `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style="transform: rotate(${heading}deg); transform-origin: center; filter: drop-shadow(0 0 4px rgba(34,211,238,0.7));">
            <path d="M12 2 L13.5 10 L22 12 L22 14 L13.5 14 L13 19 L15 21 L15 22 L12 21 L9 22 L9 21 L11 19 L10.5 14 L2 14 L2 12 L10.5 10 Z"
                  fill="#22d3ee" stroke="#0e7490" stroke-width="0.5"/>
          </svg>`;
        const tailLabel = position.ident || '';
        const labelHtml = `
          <div style="position: absolute; left: 32px; top: -4px; background: rgba(2,6,23,0.9); border: 1px solid #22d3ee; padding: 2px 5px; white-space: nowrap;">
            <div style="color: #a5f3fc; font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; line-height: 1;">${tailLabel}</div>
            <div style="color: #67e8f9; font-family: 'JetBrains Mono', monospace; font-size: 9px; line-height: 1.4; margin-top: 1px;">${altStr} ${spdStr}</div>
          </div>`;
        const icon = L.divIcon({
          html: planeSvg + labelHtml,
          className: '',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        aircraftMarkerRef.current = L.marker(
          [position.latitude, position.longitude],
          { icon, interactive: false, zIndexOffset: 1000 }
        );
        layer.addLayer(aircraftMarkerRef.current);
      }

      // Fit map to all airports + plane position so the whole trip is visible.
      const points = Array.from(aptSet.values()).map((a) => [a.coords.lat, a.coords.lng]);
      if (position && position.airborne === true
          && Number.isFinite(position.latitude)
          && Number.isFinite(position.longitude)) {
        points.push([position.latitude, position.longitude]);
      }
      if (points.length >= 2) {
        try {
          mapRef.current.fitBounds(points, { padding: [40, 40], maxZoom: 8 });
        } catch (_) {}
      } else if (points.length === 1) {
        mapRef.current.setView(points[0], 6);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, position, legs, coordsTick]);

  if (mapErr) {
    return (
      <div className="border border-slate-700 bg-slate-900/40 p-8 text-center text-sm text-amber-300">
        <AlertCircle className="w-5 h-5 mx-auto mb-2" />
        Map unavailable. Position data still updates below.
      </div>
    );
  }

  return (
    <div className="border border-slate-700 overflow-hidden">
      <div ref={containerRef} style={{ width: '100%', height: 360 }} />
    </div>
  );
}

// Per-passenger row — name, status indicator, optional check-in timestamp,
// and a "NEW" badge for walk-ups (pax not on the original manifest).
function PaxRow({ pax, iataCode }) {
  const status = pax?.status || 'pending';
  let icon;
  let textClass;
  if (status === 'checked_in') {
    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    textClass = 'text-slate-100';
  } else if (status === 'no_show') {
    icon = <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
    textClass = 'text-slate-400 line-through';
  } else if (status === 'skipped') {
    icon = <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />;
    textClass = 'text-slate-500 line-through';
  } else { // pending
    icon = <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />;
    textClass = 'text-slate-300';
  }
  return (
    <div className="flex items-center gap-2 text-xs py-0.5">
      {icon}
      <span className={textClass} style={{ fontFamily: 'DM Sans, sans-serif' }}>{pax.name}</span>
      {pax.walkUp && (
        <span className="inline-flex items-center px-1 py-px border border-amber-500/50 bg-amber-500/15 text-amber-300 text-[9px] tracking-wider font-mono"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          NEW
        </span>
      )}
      {pax.checkedInAt && status === 'checked_in' && (
        <span className="text-slate-500 text-[10px] ml-auto" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtAirportTimeShort(pax.checkedInAt, iataCode)}
        </span>
      )}
    </div>
  );
}

function Leg({ leg, isActive, position }) {
  const cat = categoryBadge(leg.category);
  // Status lives directly on the leg (server-attached per-leg from each
  // trip-state doc). No need for the legacy statuses[leg.legNumber] map.
  const legStatuses = leg.status || {};
  const hasPilots = !!(leg.pic || leg.sic);
  const paxList = Array.isArray(leg.pax) ? leg.pax : [];
  const checkedInCount = paxList.filter((p) => p?.status === 'checked_in').length;
  // REVENUE legs show the pax check-in milestones too (CATERING, PAX ARRIVED, PAX BOARDED)
  const isRevenue = String(leg.category || '').toUpperCase() === 'REVENUE';

  return (
    <div className={`border ${isActive ? 'border-cyan-400/60 shadow-[0_0_24px_rgba(34,211,238,0.12)]' : 'border-slate-700'} bg-slate-900/40 mb-3 overflow-hidden`}>
      {/* Progress bar runs across the top edge of the card */}
      <LegProgress leg={leg} position={position} />

      <div className="p-4">
        <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                LEG {leg.legNumber}
              </span>
              <span className={`text-[10px] tracking-widest border px-1.5 py-0.5 ${cat.cls}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {cat.text}
              </span>
              {isActive && <LiveBadge />}
            </div>
            <div className="mt-2 flex items-center gap-2 text-2xl" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              <span className="tracking-wider">{leg.from || '???'}</span>
              <ArrowRight className="w-5 h-5 text-cyan-400" />
              <span className="tracking-wider">{leg.to || '???'}</span>
            </div>
          </div>
          {hasPilots && (
            <div className="text-right">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CREW</div>
              {leg.pic && (
                <div className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  <span className="text-slate-500 text-[10px] mr-1">PIC</span>{leg.pic}
                </div>
              )}
              {leg.sic && (
                <div className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  <span className="text-slate-500 text-[10px] mr-1">SIC</span>{leg.sic}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 text-xs">
          <div>
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>DEPARTURE</div>
            <div className="text-slate-200">{fmtAirportTime(leg.departure, leg.from)}</div>
            {leg.fromFbo && <div className="text-slate-500 mt-0.5">{leg.fromFbo}</div>}
          </div>
          <div>
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ARRIVAL</div>
            <div className="text-slate-200">{fmtAirportTime(leg.arrival, leg.to)}</div>
            {leg.toFbo && <div className="text-slate-500 mt-0.5">{leg.toFbo}</div>}
          </div>
        </div>

        {/* Passenger list with per-pax check-in indicators — shown ONLY
            when showPax=true (this broker's leg, not a repo leg). */}
        {leg.showPax && paxList.length > 0 && (
          <div className="mb-3 pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                PASSENGERS
              </div>
              <div className="text-[10px] text-slate-400 font-mono" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {checkedInCount} / {paxList.length} CHECKED IN
              </div>
            </div>
            <div>
              {paxList.map((p, i) => <PaxRow key={i} pax={p} iataCode={leg.from} />)}
            </div>
          </div>
        )}

        {/* Crew/aircraft milestones — same five steps for all legs. */}
        <div className="space-y-1 pt-2 border-t border-slate-800">
          <StatusDot on={!!legStatuses.crew_onsite?.at}    label="Crew on site"    ts={legStatuses.crew_onsite?.at}    iataCode={leg.from} />
          <StatusDot on={!!legStatuses.aircraft_ready?.at} label="Aircraft ready"  ts={legStatuses.aircraft_ready?.at} iataCode={leg.from} />
          {/* Revenue legs get catering + pax arrived / boarded milestones */}
          {isRevenue && (
            <>
              <StatusDot on={!!legStatuses.catering_aboard?.at} label="Catering on board" ts={legStatuses.catering_aboard?.at} iataCode={leg.from} />
              <StatusDot on={!!legStatuses.pax_arrived?.at}     label="Passengers arrived" ts={legStatuses.pax_arrived?.at}    iataCode={leg.from} />
              <StatusDot on={!!legStatuses.pax_boarded?.at}     label="Passengers boarded" ts={legStatuses.pax_boarded?.at}    iataCode={leg.from} />
            </>
          )}
          <StatusDot on={!!legStatuses.taxi_dep?.at}  label="Taxiing"  ts={legStatuses.taxi_dep?.at}  iataCode={leg.from} />
          <StatusDot on={!!legStatuses.wheels_up?.at} label="Airborne" ts={legStatuses.wheels_up?.at} iataCode={leg.from} />
          <StatusDot on={!!legStatuses.landed?.at}    label="Landed"   ts={legStatuses.landed?.at}    iataCode={leg.to} />
        </div>
      </div>
    </div>
  );
}

function PositionCard({ position }) {
  if (!position) return null;
  if (!position.airborne) {
    return (
      <div className="border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-400">
        Aircraft is currently on the ground.
      </div>
    );
  }
  return (
    <div className="border border-cyan-500/40 bg-cyan-500/5 p-3">
      <div className="text-[10px] tracking-widest text-cyan-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        AIRBORNE NOW
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <div className="text-slate-500 text-[10px]">ALT</div>
          <div className="text-slate-100">{position.altitude ? `${position.altitude.toLocaleString()} ft` : '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">SPEED</div>
          <div className="text-slate-100">{position.groundspeed ? `${position.groundspeed} kt` : '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">DEST</div>
          <div className="text-slate-100">{position.destination || '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-[10px]">ETA</div>
          <div className="text-slate-100">{fmtAirportTime(position.estimatedOn, position.destination)}</div>
        </div>
      </div>
    </div>
  );
}

export default function TripTrackPage({ token }) {
  const [state, setState] = useState({ loading: true, err: null, trip: null, position: null });
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!token) {
      setState({ loading: false, err: 'No tracking token provided.', trip: null, position: null });
      return;
    }
    try {
      const r = await fetch(`/api/trip-public?action=get&token=${encodeURIComponent(token)}`);
      const data = await r.json();
      if (!r.ok || !data.ok) {
        const reason = data?.reason || 'unable to load trip';
        setState({ loading: false, err: reason, trip: null, position: null });
        return;
      }
      setState({ loading: false, err: null, trip: data.trip, position: data.position });
    } catch (e) {
      setState({ loading: false, err: 'Could not reach the tracking service.', trip: null, position: null });
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(async () => {
      setRefreshing(true);
      await load();
      setRefreshing(false);
    }, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (state.loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-cyan-400" />
          <div className="text-sm text-slate-400">Loading trip…</div>
        </div>
      </div>
    );
  }

  if (state.err || !state.trip) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
          <h1 className="text-2xl tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            TRACKING LINK UNAVAILABLE
          </h1>
          <p className="text-sm text-slate-400 mb-2">
            {state.err === 'link expired after trip completion'
              ? 'This tracking link has expired. The trip has completed.'
              : state.err === 'link revoked' || state.err === 'link rotated'
              ? 'This tracking link is no longer active. Please contact Skyway for an updated link.'
              : state.err === 'trip not found'
              ? 'We could not locate this trip. Please contact Skyway.'
              : 'This tracking link is invalid or has expired.'}
          </p>
          <p className="text-xs text-slate-500 mt-4">
            Skyway Aviation Services · charters@flyskyway.com · 727-605-5000
          </p>
        </div>
      </div>
    );
  }

  const { trip, position } = state;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 px-4 py-4 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/skyway-logo-nav.png"
              srcSet="/skyway-logo-nav.png 1x, /skyway-logo-nav@2x.png 2x"
              alt="Skyway Aviation"
              className="h-7 w-auto shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Plane className="w-5 h-5 text-cyan-400 shrink-0" />
                <span className="text-xl tracking-wider truncate" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
                  {trip.tail || 'TRIP'}
                </span>
                {trip.tripCode && (
                  <span className="text-[10px] text-slate-500 tracking-widest ml-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {trip.tripCode}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                SKYWAY AVIATION SERVICES
                {trip.aircraftType ? ` · ${trip.aircraftType.toUpperCase()}` : ''}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {refreshing && <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />}
            <button
              onClick={load}
              className="p-1.5 text-slate-500 hover:text-slate-200"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {/* Hero card — overall trip state. Replaces the old "AIRBORNE NOW"
            position strip with a cleaner top-of-page status that always
            renders something useful (in flight / on the ground / scheduled
            / completed) instead of going blank when the aircraft is on
            the ground. */}
        <HeroCard trip={trip} position={position} />

        {/* Map — Leaflet + OpenStreetMap via CARTO dark tiles, no API key. */}
        <LiveMap position={position} legs={trip.legs} />

        {/* Legs */}
        <section>
          <h2 className="text-lg tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>ITINERARY</h2>
          {(trip.legs || []).map((leg) => {
            // The "active" leg is whichever one is currently airborne (or
            // mid-preflight if none airborne yet). Drives the LIVE badge,
            // border glow, and progress bar emphasis.
            const isAirborneLeg = !!(leg.status?.wheels_up && !leg.status?.landed);
            return (
              <Leg
                key={leg.legNumber}
                leg={leg}
                isActive={isAirborneLeg}
                position={isAirborneLeg ? position : null}
              />
            );
          })}
        </section>

        <footer className="text-[10px] text-slate-600 text-center py-6 border-t border-slate-800" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          QUESTIONS? · CHARTERS@FLYSKYWAY.COM · 727-605-5000
          <br />
          THIS LINK EXPIRES 24 HOURS AFTER FINAL LEG LANDING
        </footer>
      </main>
    </div>
  );
}
