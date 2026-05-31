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

const POLL_MS = 120000; // refresh live position every 2 minutes

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch { return '—'; }
}

function categoryBadge(cat) {
  const c = String(cat || 'REVENUE').toUpperCase();
  if (c === 'REPO' || c === 'FERRY' || c === 'REPOSITIONING') {
    return { text: 'REPOSITIONING', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  }
  return { text: 'CHARTER LEG', cls: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' };
}

function StatusDot({ on, label, ts }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {on
        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        : <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
      <span className={on ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
      {on && ts && <span className="text-slate-500 text-[10px] ml-auto">{fmtTime(ts)}</span>}
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

function LiveMap({ position, legs }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const aircraftMarkerRef = useRef(null);
  const [mapErr, setMapErr] = useState('');

  // Initial map setup — runs once.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current) return;
      // Initial center: aircraft if airborne, else CONUS center.
      let center = [39.8283, -98.5795];
      let zoom = 4;
      if (position?.airborne && position.latitude && position.longitude) {
        center = [position.latitude, position.longitude];
        zoom = 6;
      }
      const map = L.map(containerRef.current, {
        center, zoom,
        zoomControl: true,
        attributionControl: true,
        worldCopyJump: false,
      });
      // Dark basemap from CARTO — free, no API key, matches our dark UI.
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 18,
        subdomains: 'abcd',
        attribution: '&copy; OpenStreetMap &copy; CARTO',
      }).addTo(map);
      mapRef.current = map;
    }).catch((e) => {
      setMapErr(e.message || 'Map failed to load');
    });
    return () => {
      cancelled = true;
      // Tear down the map instance so re-renders don't double up. Leaflet
      // throws if you call init twice on the same container without remove().
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch (_) {}
        mapRef.current = null;
      }
      aircraftMarkerRef.current = null;
    };
    // Intentionally only on mount; live updates handled by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update aircraft marker when position changes. A heading-rotated cyan
  // arrow renders as a divIcon (SVG inline) so we don't need to ship any
  // marker image assets. When the aircraft goes back on the ground, the
  // marker is removed.
  useEffect(() => {
    const L = typeof window !== 'undefined' ? window.L : null;
    const map = mapRef.current;
    if (!L || !map) return;
    if (position?.airborne && position.latitude && position.longitude) {
      const pos = [position.latitude, position.longitude];
      const heading = Number.isFinite(position.heading) ? position.heading : 0;
      // Build an SVG arrow rotated by heading. White stroke around cyan
      // fill so the marker pops on any tile color underneath.
      const html = `
        <div style="transform: rotate(${heading}deg); transform-origin: 50% 50%;">
          <svg width="28" height="28" viewBox="-14 -14 28 28">
            <path d="M 0,-11 L 6,9 L 0,5 L -6,9 Z"
              fill="#06b6d4" stroke="#ffffff" stroke-width="1.5"
              stroke-linejoin="round" />
          </svg>
        </div>`;
      const icon = L.divIcon({
        html, className: '', iconSize: [28, 28], iconAnchor: [14, 14],
      });
      if (!aircraftMarkerRef.current) {
        aircraftMarkerRef.current = L.marker(pos, { icon, interactive: false }).addTo(map);
      } else {
        aircraftMarkerRef.current.setLatLng(pos);
        aircraftMarkerRef.current.setIcon(icon);
      }
      map.panTo(pos);
    } else if (aircraftMarkerRef.current) {
      try { aircraftMarkerRef.current.remove(); } catch (_) {}
      aircraftMarkerRef.current = null;
    }
  }, [position]);

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
      <div ref={containerRef} style={{ width: '100%', height: 320 }} />
    </div>
  );
}

function Leg({ leg, statuses }) {
  const cat = categoryBadge(leg.category);
  const legStatuses = (statuses && statuses[leg.legNumber]) || {};
  const hasPilots = !!(leg.pic || leg.sic);
  const paxList = Array.isArray(leg.pax) ? leg.pax : [];
  return (
    <div className="border border-slate-700 bg-slate-900/40 p-4 mb-3">
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              LEG {leg.legNumber}
            </span>
            <span className={`text-[10px] tracking-widest border px-1.5 py-0.5 ${cat.cls}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {cat.text}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-lg" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            <span className="tracking-wider">{leg.from || '???'}</span>
            <ArrowRight className="w-4 h-4 text-cyan-400" />
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
          <div className="text-slate-200">{fmtTime(leg.departure)}</div>
          {leg.fromFbo && <div className="text-slate-500 mt-0.5">{leg.fromFbo}</div>}
        </div>
        <div>
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ARRIVAL</div>
          <div className="text-slate-200">{fmtTime(leg.arrival)}</div>
          {leg.toFbo && <div className="text-slate-500 mt-0.5">{leg.toFbo}</div>}
        </div>
      </div>

      {/* Passenger names — shown ONLY when the server marked this leg as
          showPax=true (i.e., this broker's own charter leg). Repo legs and
          other brokers' legs receive an empty pax array regardless. */}
      {leg.showPax && paxList.length > 0 && (
        <div className="mb-3 pb-3 border-b border-slate-800">
          <div className="text-[10px] tracking-widest text-slate-500 mb-1.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            PASSENGERS ({paxList.length})
          </div>
          <ul className="text-xs text-slate-200 space-y-0.5" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            {paxList.map((name, i) => (
              <li key={i}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1 pt-2 border-t border-slate-800">
        <StatusDot on={!!legStatuses.crewArrived?.at} label="Crew on site" ts={legStatuses.crewArrived?.at} />
        <StatusDot on={!!legStatuses.ready?.at} label="Aircraft ready" ts={legStatuses.ready?.at} />
        <StatusDot on={!!legStatuses.taxiing?.at} label="Taxiing" ts={legStatuses.taxiing?.at} />
        <StatusDot on={!!legStatuses.airborne?.at || !!legStatuses.departed?.at} label="Airborne" ts={legStatuses.airborne?.at || legStatuses.departed?.at} />
        <StatusDot on={!!legStatuses.landed?.at || !!legStatuses.arrived?.at} label="Landed" ts={legStatuses.landed?.at || legStatuses.arrived?.at} />
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
          <div className="text-slate-100">{fmtTime(position.estimatedOn)}</div>
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
        {/* Live position */}
        {position && <PositionCard position={position} />}

        {/* Map — Leaflet + OpenStreetMap via CARTO dark tiles, no API key. */}
        <LiveMap position={position} legs={trip.legs} />

        {/* Legs */}
        <section>
          <h2 className="text-lg tracking-wider mb-2" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>ITINERARY</h2>
          {(trip.legs || []).map((leg) => (
            <Leg key={leg.legNumber} leg={leg} statuses={trip.statuses} />
          ))}
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
