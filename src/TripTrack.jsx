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
//   - Live position on a map (Google Maps) when the aircraft is airborne
//   - Post-flight track for completed legs (toggle to show)
//   - Status timeline per leg (departed / airborne / landed / etc.)
//
// What we DO NOT show (sanitization happens server-side too, this is belt+suspenders):
//   - Passenger names
//   - Crew contact info
//   - Internal notes
//   - Pricing / fees / fuel costs

import React, { useEffect, useMemo, useRef, useState } from 'react';
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

// Lightweight Google Maps loader — same key the main app already uses.
// We only load the script once.
let _mapsLoading = null;
function loadGoogleMaps(apiKey) {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
  if (_mapsLoading) return _mapsLoading;
  _mapsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry`;
    s.async = true;
    s.onload = () => resolve(window.google.maps);
    s.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(s);
  });
  return _mapsLoading;
}

function LiveMap({ position, legs, apiKey }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const aircraftMarkerRef = useRef(null);
  const legPolylinesRef = useRef([]);
  const [mapErr, setMapErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(apiKey).then((maps) => {
      if (cancelled || !containerRef.current) return;
      // Initial center: aircraft if airborne, else midpoint of all legs, else CONUS center.
      let center = { lat: 39.8283, lng: -98.5795 };
      if (position?.airborne && position.latitude && position.longitude) {
        center = { lat: position.latitude, lng: position.longitude };
      } else if (legs && legs.length) {
        // No coordinates for airports on the public payload, so we stay at CONUS.
        // Future enhancement: include lat/lng for from/to airports.
      }
      mapRef.current = new maps.Map(containerRef.current, {
        center,
        zoom: 5,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#0f172a' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#475569' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#0f172a' }] },
          { featureType: 'water', stylers: [{ color: '#020617' }] },
          { featureType: 'road', stylers: [{ color: '#1e293b' }] },
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        ],
      });
    }).catch((e) => {
      setMapErr(e.message || 'Map failed to load');
    });
    return () => { cancelled = true; };
  }, [apiKey]);

  // Update aircraft marker when position changes
  useEffect(() => {
    if (!mapRef.current || !window.google?.maps) return;
    const maps = window.google.maps;
    if (position?.airborne && position.latitude && position.longitude) {
      const pos = { lat: position.latitude, lng: position.longitude };
      if (!aircraftMarkerRef.current) {
        aircraftMarkerRef.current = new maps.Marker({
          position: pos,
          map: mapRef.current,
          icon: {
            path: 'M 0,-12 L 4,4 L 0,1 L -4,4 Z',
            fillColor: '#06b6d4',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5,
            scale: 1.8,
            rotation: position.heading || 0,
            anchor: new maps.Point(0, 0),
          },
        });
      } else {
        aircraftMarkerRef.current.setPosition(pos);
        const icon = aircraftMarkerRef.current.getIcon();
        if (icon) {
          icon.rotation = position.heading || 0;
          aircraftMarkerRef.current.setIcon(icon);
        }
      }
      mapRef.current.panTo(pos);
    } else if (aircraftMarkerRef.current) {
      aircraftMarkerRef.current.setMap(null);
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
        {leg.pic && (
          <div className="text-right">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PIC</div>
            <div className="text-sm text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>{leg.pic}</div>
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
  const apiKey = useMemo(() => {
    if (typeof window === 'undefined') return '';
    // The same key the main app uses, embedded at build time.
    return import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  }, []);

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
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Plane className="w-5 h-5 text-cyan-400" />
              <span className="text-xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
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
          <div className="flex items-center gap-2">
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

        {/* Map */}
        {apiKey
          ? <LiveMap position={position} legs={trip.legs} apiKey={apiKey} />
          : <div className="border border-slate-700 bg-slate-900/40 p-3 text-xs text-slate-500">
              Map unavailable (no API key).
            </div>
        }

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
