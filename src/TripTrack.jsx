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
//   - Live position on a professional tracking map with selectable basemaps,
//     weather radar, and the aircraft's full altitude-coloured flight trail
//   - Departure / arrival weather (METAR + short TAF) for every airport
//   - Status timeline per leg (departed / airborne / landed / etc.)
//
// What we DO NOT show (sanitization happens server-side too, this is belt+suspenders):
//   - Passenger names
//   - Crew contact info
//   - Internal notes
//   - Pricing / fees / fuel costs

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plane, AlertCircle, RefreshCw, Loader2,
  ArrowRight, CheckCircle2, Circle, Cloud, Wind, Eye, Thermometer,
} from 'lucide-react';
import { formatLocalTime, formatLocalDate } from './airports.js';
// The same map component and visual language the ops Tracking screen uses, so
// a broker and a dispatcher are looking at the identical picture of the flight.
import { Wordmark } from './ui.jsx';
import TrackingMap from './TrackingMap.jsx';
import { flightCategoryStyle, normalizeTrail, distanceNm } from './tracking-map.js';
// FAA NOTAM badge — renders silently when no significant NOTAMs are active,
// shows a colored badge with click-to-expand panel when there are. We pass
// no getIdToken since the broker page is anonymous; the endpoint accepts
// unauthenticated reads for now (NOTAM data is public FAA info).
import FAANotamBadge from './FAANotamBadge.jsx';

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
  //   4. A future leg hasn't departed yet → SCHEDULED (the NEXT leg)
  //
  // The subtle bug this avoids: a 2-leg trip where leg 1 has landed and
  // leg 2 hasn't started yet. The naive "all landed → completed, else
  // scheduled with legs[0]" reports SCHEDULED for leg 1 (already flown).
  // We need to look forward — pick the first NOT-LANDED leg as the active
  // one when in scheduled state.
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
    } else {
      // Scheduled — but find the FIRST leg that hasn't landed yet (the
      // upcoming one). Falling back to legs[0] would point at an already-
      // flown earlier leg in multi-leg trips.
      const upcomingLeg = legs.find((l) => !l.status?.landed);
      if (upcomingLeg) {
        mode = 'scheduled';
        activeLeg = upcomingLeg;
      } else {
        // All landed (shouldn't reach here — the every-landed check above
        // should have caught it — but defensively pick the last leg).
        mode = 'completed';
        activeLeg = legs[legs.length - 1];
      }
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
    // "First departure" reads wrong when leg 1 has already landed and we're
    // showing leg 2 as the next upcoming. Use "Next departure" if any earlier
    // leg has already landed; "First departure" only when nothing has flown yet.
    const anyPriorLanded = legs.some((l) => l.legNumber < activeLeg.legNumber && l.status?.landed);
    const departureLabel = anyPriorLanded ? 'Next departure' : 'First departure';
    subtitle = (
      <>
        {departureLabel} {activeLeg.from} → {activeLeg.to}
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

// Phase colours matched to the ops flight board so the broker view reads as
// the same product. Cyan = airborne, amber = preflight, slate = pending,
// emerald = landed, dim slate = completed.
const BROKER_PHASE_COLORS = {
  pending:    '#64748b',
  preflight:  '#f59e0b',
  airborne:   '#3FA9CC',
  landed:     '#10b981',
  completed:  '#475569',
};

// Derive a phase per leg from its status timeline, using the same status step
// IDs the ops app records, with the same 12-hour staleness guard: a forgotten
// LANDED tap shouldn't leave a leg looking airborne forever.
function legPhase(leg) {
  const s = leg?.status || {};
  if (s.landed) return 'landed';
  if (s.wheels_up) {
    const upAt = s.wheels_up.at || 0;
    if (upAt > 0 && (Date.now() - upAt) > 12 * 60 * 60 * 1000) return 'landed';
    return 'airborne';
  }
  if (s.crew_onsite || s.aircraft_ready || s.taxi_dep ||
      s.catering_aboard || s.pax_arrived || s.pax_boarded) return 'preflight';
  return 'pending';
}

/**
 * Broker-facing flight map. Resolves the trip's airports to coordinates, then
 * hands a normalized scene to the shared TrackingMap, which owns basemaps,
 * weather radar, the altitude-coloured trail and fullscreen.
 *
 * The map always opens showing the aircraft's full flown trail — that is the
 * single thing a broker checking on a charter wants to see.
 */
function BrokerFlightMap({ position, legs, trail, trailLive, tail }) {
  const [coordsTick, setCoordsTick] = useState(0);
  const [coordsFn, setCoordsFn] = useState(null);
  const askedRef = useRef(new Set());

  // The bundled coords database is a large module; load it lazily so the
  // broker page's first paint isn't waiting on it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { lookupCoords } = await import('./airport-coords.js');
      if (!cancelled) setCoordsFn(() => lookupCoords);
    })();
    return () => { cancelled = true; };
  }, []);

  // Resolve any airport this trip references that isn't in the bundled DB —
  // smaller regional and non-US fields that brokers still need to see.
  useEffect(() => {
    if (!coordsFn || !Array.isArray(legs) || legs.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const missing = [];
      legs.forEach((leg) => {
        [leg.from, leg.to].forEach((code) => {
          if (!code) return;
          const c = String(code).toUpperCase().trim();
          if (!coordsFn(c) && !askedRef.current.has(c)) missing.push(c);
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
          for (const c of missing) askedRef.current.delete(c);
          return;
        }
        const data = await r.json();
        if (cancelled) return;
        if (data.cacheReady === false) {
          // The OurAirports cache is cold-starting; retry shortly.
          setTimeout(() => {
            for (const c of missing) askedRef.current.delete(c);
            setCoordsTick((t) => t + 1);
          }, 60000);
          return;
        }
        const { addDynamicCoords } = await import('./airport-coords.js');
        let added = 0;
        for (const [code, coords] of Object.entries(data.coords || {})) {
          const lat = coords?.lat;
          const lng = coords?.lng ?? coords?.lon;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            addDynamicCoords(code, lat, lng);
            added += 1;
          }
        }
        if (added > 0 && !cancelled) setCoordsTick((t) => t + 1);
      } catch {
        for (const c of missing) askedRef.current.delete(c);
      }
    })();
    return () => { cancelled = true; };
  }, [coordsFn, legs]);

  const normalizedTrail = useMemo(() => normalizeTrail(trail), [trail]);

  const scene = useMemo(() => {
    if (!coordsFn) return { aircraft: [], airports: [], routes: [], trail: null, projected: null };

    const airports = new Map();
    const routes = [];
    let projected = null;

    (legs || []).forEach((leg) => {
      const from = coordsFn(leg.from);
      const to = coordsFn(leg.to);
      if (!from || !to) return;
      const phase = legPhase(leg);

      if (!airports.has(String(leg.from).toUpperCase())) {
        airports.set(String(leg.from).toUpperCase(), {
          code: leg.from, lat: from.lat, lon: from.lng, tone: 'origin', small: true,
        });
      }
      airports.set(String(leg.to).toUpperCase(), {
        code: leg.to, lat: to.lat, lon: to.lng,
        tone: phase === 'landed' ? 'neutral' : 'destination', small: true,
      });

      // For the airborne leg the flown trail carries the actual path, so the
      // planned line would only duplicate it. We draw the remainder instead.
      if (phase === 'airborne') {
        const havePos = position?.airborne === true
          && Number.isFinite(position.latitude) && Number.isFinite(position.longitude);
        if (normalizedTrail.length >= 2) {
          const last = normalizedTrail[normalizedTrail.length - 1];
          projected = [[last.lat, last.lon], [to.lat, to.lng]];
        } else if (havePos) {
          routes.push({
            points: [[from.lat, from.lng], [position.latitude, position.longitude]],
            color: BROKER_PHASE_COLORS.airborne, weight: 3.5, opacity: 0.95,
          });
          projected = [[position.latitude, position.longitude], [to.lat, to.lng]];
        } else {
          routes.push({
            points: [[from.lat, from.lng], [to.lat, to.lng]],
            color: BROKER_PHASE_COLORS.airborne, weight: 3, opacity: 0.8, dashed: true,
          });
        }
        return;
      }

      const landed = phase === 'landed' || phase === 'completed';
      routes.push({
        points: [[from.lat, from.lng], [to.lat, to.lng]],
        color: BROKER_PHASE_COLORS[phase] || BROKER_PHASE_COLORS.pending,
        weight: landed ? 2 : 2.5,
        opacity: landed ? 0.5 : 0.85,
        dashed: phase === 'pending' || phase === 'preflight',
      });
    });

    const aircraft = [];
    if (position?.airborne === true
        && Number.isFinite(position.latitude) && Number.isFinite(position.longitude)) {
      aircraft.push({
        id: position.ident || tail || 'aircraft',
        tail: position.ident || tail || '',
        lat: position.latitude,
        lon: position.longitude,
        heading: position.heading ?? 0,
        altitude: position.altitude ?? null,
        groundspeed: position.groundspeed ?? null,
        airborne: true,
      });
    }

    return {
      aircraft,
      airports: Array.from(airports.values()),
      routes,
      trail: normalizedTrail.length >= 2 ? normalizedTrail : null,
      projected,
    };
  }, [coordsFn, legs, position, normalizedTrail, tail, coordsTick]);

  const flownNm = useMemo(() => {
    if (normalizedTrail.length < 2) return null;
    let total = 0;
    for (let i = 0; i < normalizedTrail.length - 1; i += 1) {
      const d = distanceNm(normalizedTrail[i], normalizedTrail[i + 1]);
      if (Number.isFinite(d)) total += d;
    }
    return Math.round(total);
  }, [normalizedTrail]);

  // Re-fit when the trail first arrives or the flight changes state, not on
  // every 2-minute position poll — that would fight the broker's own panning.
  const fitKey = `${tail || ''}:${normalizedTrail.length >= 2 ? 'trail' : 'plan'}:${position?.airborne ? 'air' : 'gnd'}`;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-700">
      <TrackingMap
        scene={scene}
        selectedId={scene.aircraft[0]?.id || null}
        fitKey={fitKey}
        basemapDefault="satellite"
        className="w-full"
        style={{ height: 'clamp(320px, 52vh, 560px)' }}
        overlay={normalizedTrail.length >= 2 ? (
          <div className="pointer-events-none rounded-lg border border-slate-700 bg-slate-950/85 px-2.5 py-2 backdrop-blur">
            <div className="text-[9px] uppercase tracking-wider text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {trailLive ? 'Flight trail · live' : 'Flight trail · flown'}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {normalizedTrail.length} points{flownNm ? ` · ${flownNm} nm` : ''}
            </div>
          </div>
        ) : null}
      />
    </section>
  );
}

/**
 * Departure and arrival weather for the trip. Server-side the broker payload
 * only carries whitelisted METAR fields plus one TAF period — enough to answer
 * "is weather going to delay my charter" without exposing ops planning data.
 */
function WeatherPanel({ legs, weather }) {
  const stations = useMemo(() => {
    if (!weather || typeof weather !== 'object') return [];
    const order = [];
    const seen = new Set();
    (legs || []).forEach((leg) => {
      [[leg.from, 'Departure'], [leg.to, 'Arrival']].forEach(([code, role]) => {
        if (!code) return;
        const key = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (seen.has(key)) return;
        // The server keys weather by the identifier it queried, which may have
        // been normalized to ICAO (3-letter US codes get a K prefix).
        const entry = weather[key] || weather[`K${key}`];
        if (!entry) return;
        seen.add(key);
        order.push({ code, role, entry });
      });
    });
    return order;
  }, [legs, weather]);

  if (stations.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
        <Cloud className="h-4 w-4 text-cyan-400" /> WEATHER
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {stations.map((s) => (
          <BrokerWeatherCard key={s.code} code={s.code} role={s.role} data={s.entry} />
        ))}
      </div>
    </section>
  );
}

function BrokerWeatherCard({ code, role, data }) {
  const metar = data?.metar || null;
  const forecast = data?.forecast || null;
  const style = flightCategoryStyle(metar?.flightCategory);

  const wind = Number.isFinite(metar?.windKt)
    ? `${Number.isFinite(metar.windDir) ? String(metar.windDir).padStart(3, '0') : '---'}° at ${Math.round(metar.windKt)} kt${Number.isFinite(metar.windGustKt) ? ` (gusts ${Math.round(metar.windGustKt)})` : ''}`
    : null;

  return (
    <div className="border border-slate-700 bg-slate-900/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{code}</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {role}
          </div>
        </div>
        {metar?.flightCategory ? (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 border border-slate-700 px-2 py-1 text-[10px] font-bold"
            style={{ fontFamily: 'JetBrains Mono, monospace', color: style.dot }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.dot }} />
            {style.label}
          </span>
        ) : (
          <span className="shrink-0 text-[10px] text-slate-600" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            NO REPORT
          </span>
        )}
      </div>

      {metar && (
        <div className="mt-3 space-y-1.5 text-[11px] text-slate-400">
          {wind && (
            <div className="flex items-center gap-2">
              <Wind className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="text-slate-200">{wind}</span>
            </div>
          )}
          {metar.visibilitySm != null && (
            <div className="flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="text-slate-200">{metar.visibilitySm} sm visibility</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Cloud className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="text-slate-200">
              {Number.isFinite(metar.ceilingFt) ? `${metar.ceilingFt.toLocaleString()} ft ceiling` : 'No ceiling reported'}
            </span>
          </div>
          {Number.isFinite(metar.tempC) && (
            <div className="flex items-center gap-2">
              <Thermometer className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="text-slate-200">{Math.round(metar.tempC)}°C</span>
            </div>
          )}
        </div>
      )}

      {forecast?.flightCategory && (
        <div className="mt-3 border-t border-slate-800 pt-2 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          FORECAST <span style={{ color: flightCategoryStyle(forecast.flightCategory).dot }}>{forecast.flightCategory}</span>
          {Number.isFinite(forecast.windKt) ? ` · WIND ${String(forecast.windDir ?? 0).padStart(3, '0')}/${Math.round(forecast.windKt)}` : ''}
        </div>
      )}
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
  // Normalize pax to the structured-record shape so the renderer works
  // regardless of which payload version is persisted on the trip-state
  // doc. Old links were saved with `pax: ['Paul Smith', 'Nicole Smith']`
  // (string array). New links save `[{name, status, checkedInAt, walkUp}]`.
  // If we see strings, wrap them as pending records — better than showing
  // an empty list when the link wasn't rotated after the upgrade.
  const paxList = Array.isArray(leg.pax)
    ? leg.pax.map((p) => {
        if (typeof p === 'string') return { name: p, status: 'pending', checkedInAt: null, walkUp: false };
        if (p && typeof p === 'object' && p.name) return p;
        return null;
      }).filter(Boolean)
    : [];
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
            <div className="mt-2 flex items-center gap-2 text-2xl flex-wrap" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="tracking-wider">{leg.from || '???'}</span>
                {leg.from && <FAANotamBadge icao={leg.from} />}
              </span>
              <ArrowRight className="w-5 h-5 text-cyan-400" />
              <span className="inline-flex items-center gap-1.5">
                <span className="tracking-wider">{leg.to || '???'}</span>
                {leg.to && <FAANotamBadge icao={leg.to} />}
              </span>
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

const EMPTY_STATE = {
  loading: false, err: null, trip: null, position: null,
  trail: null, trailLive: false, weather: {},
};

export default function TripTrackPage({ token }) {
  const [state, setState] = useState({ ...EMPTY_STATE, loading: true });
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!token) {
      setState({ ...EMPTY_STATE, err: 'No tracking token provided.' });
      return;
    }
    try {
      const r = await fetch(`/api/trip-public?token=${encodeURIComponent(token)}`);
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setState({ ...EMPTY_STATE, err: data?.reason || 'unable to load trip' });
        return;
      }
      setState({
        loading: false,
        err: null,
        trip: data.trip,
        position: data.position,
        trail: data.trail || null,
        trailLive: data.trailLive === true,
        weather: data.weather || {},
      });
    } catch (e) {
      setState({ ...EMPTY_STATE, err: 'Could not reach the tracking service.' });
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

  const { trip, position, trail, trailLive, weather } = state;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 px-4 py-4 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Wordmark
              variant="compact"
              surface="dark"
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

        {/* Map opens on the aircraft's full flown trail. Basemap, weather radar
            and fullscreen controls live inside the map frame. */}
        <BrokerFlightMap
          position={position}
          legs={trip.legs}
          trail={trail}
          trailLive={trailLive}
          tail={trip.tail}
        />

        <WeatherPanel legs={trip.legs} weather={weather} />

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
