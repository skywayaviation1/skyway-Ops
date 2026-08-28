import { useEffect, useMemo, useState } from 'react';
import {
  Check, Clock, FilePlus2, Loader2, MapPin, Plane, Radio, Send,
  ShieldCheck,
} from 'lucide-react';
import TrackingMap from './TrackingMap.jsx';
import { lookupCoords } from './airport-coords.js';

const STATUS_STEPS = [
  ['crew_onsite', 'Crew on site', 'Crew has arrived at the FBO and is preparing the aircraft.'],
  ['aircraft_ready', 'Aircraft ready', 'Aircraft is ready for passenger boarding.'],
  ['taxi_dep', 'Taxiing', 'Aircraft has begun taxiing for departure.'],
  ['wheels_up', 'Wheels up', 'Aircraft is airborne and en route.'],
  ['landed', 'Landed', 'Aircraft has landed at destination.'],
];

const zuluInput = (offsetHours = 1) => new Date(Date.now() + offsetHours * 3600000)
  .toISOString().slice(0, 16);
const zulu = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)}Z`;
};

export default function OperatorFlightPortal({ token }) {
  const [state, setState] = useState({ loading: true, error: '', trip: null });
  const [author, setAuthor] = useState(() => localStorage.getItem('skyway:operator-name') || '');
  const [company, setCompany] = useState(() => localStorage.getItem('skyway:operator-company') || '');
  const [note, setNote] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [routeCoords, setRouteCoords] = useState({});
  const [repo, setRepo] = useState({
    from: '', to: '', departure: zuluInput(), arrival: '', note: '',
  });

  async function load() {
    if (!token) {
      setState({ loading: false, error: 'No operator token provided', trip: null });
      return;
    }
    try {
      const response = await fetch(`/api/operator-flight?token=${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to load trip');
      setState({ loading: false, error: '', trip: data.trip });
      setRepo((current) => ({
        ...current,
        from: current.from || data.trip?.from || '',
        to: current.to || '',
      }));
    } catch (error) {
      setState({ loading: false, error: error.message || 'Unable to load trip', trip: null });
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // The bundled coordinate table covers common fleet airports; brokered lift
  // can use airports Skyway has never visited. Resolve those through the
  // server cache so the route map renders before the first ADS-B position.
  useEffect(() => {
    const trip = state.trip;
    if (!trip) return;
    const codes = [trip.from, trip.to].filter(Boolean);
    const local = Object.fromEntries(
      codes.map((code) => [code, lookupCoords(code)]).filter(([, value]) => value),
    );
    setRouteCoords(local);
    const missing = codes.filter((code) => !local[code]);
    if (!missing.length) return;
    let cancelled = false;
    fetch('/api/airport-coords-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: missing }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setRouteCoords((current) => ({ ...current, ...(data.coords || {}) }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [state.trip?.from, state.trip?.to]);

  async function sendAction(action, payload) {
    if (!author.trim()) {
      setMessage('Enter your name before sending an update.');
      return false;
    }
    setBusy(action);
    setMessage('');
    try {
      localStorage.setItem('skyway:operator-name', author.trim());
      localStorage.setItem('skyway:operator-company', company.trim());
      const response = await fetch(`/api/operator-flight?action=${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          author: author.trim(),
          company: company.trim(),
          ...payload,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Update failed');
      setMessage('Update sent to Skyway Operations.');
      await load();
      return true;
    } catch (error) {
      setMessage(error.message || 'Update failed');
      return false;
    } finally {
      setBusy('');
    }
  }

  const scene = useMemo(() => {
    const trip = state.trip;
    if (!trip) return { aircraft: [], airports: [], routes: [] };
    const adsb = trip.adsb;
    const from = routeCoords[trip.from] || lookupCoords(trip.from);
    const to = routeCoords[trip.to] || lookupCoords(trip.to);
    const airports = [
      from && { code: trip.from, lat: from.lat, lon: from.lng, tone: 'origin' },
      to && { code: trip.to, lat: to.lat, lon: to.lng, tone: 'destination' },
    ].filter(Boolean);
    const aircraft = adsb && Number.isFinite(adsb.latitude) && Number.isFinite(adsb.longitude)
      ? [{
        id: trip.tail,
        tail: trip.tail,
        lat: adsb.latitude,
        lon: adsb.longitude,
        heading: adsb.heading,
        altitude: adsb.altitude,
        groundspeed: adsb.groundspeed,
        airborne: adsb.airborne,
        showLabel: true,
      }]
      : [];
    const routes = from && to ? [{
      points: [[from.lat, from.lng], [to.lat, to.lng]],
      color: '#8b5cf6',
      dashed: true,
      opacity: 0.75,
    }] : [];
    return { aircraft, airports, routes };
  }, [state.trip, routeCoords]);

  if (state.loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading operator portal…</div>;
  }
  if (state.error || !state.trip) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-center text-red-300">{state.error || 'Trip unavailable'}</div>;
  }

  const trip = state.trip;
  const adsb = trip.adsb;
  const completedSteps = STATUS_STEPS.filter(([key]) => trip.statuses?.[key]).length;
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/95 px-4 py-4">
        <div className="mx-auto flex max-w-5xl flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] tracking-[0.2em] text-cyan-300">BROKERED OPERATOR CREW PORTAL</div>
            <h1 className="mt-1 text-xl font-semibold">{trip.tail} · {trip.from} → {trip.to}</h1>
            <div className="mt-1 text-xs text-slate-400">
              {trip.operatorName || 'Operating crew'} · Depart {zulu(trip.departure)}
            </div>
          </div>
          <div className={`rounded border px-3 py-2 text-xs ${adsb?.available ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 text-slate-400'}`}>
            <span className="inline-flex items-center gap-1.5"><Radio className="h-3.5 w-3.5" />{adsb?.available ? 'ADS-B TRACKING ACTIVE' : 'AWAITING ADS-B DATA'}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="h-[22rem] overflow-hidden rounded-xl border border-slate-800">
          <TrackingMap
            className="h-full w-full"
            scene={scene}
            selectedId={trip.tail}
            focusIds={[trip.tail]}
            fitKey={`${trip.tail}-${trip.from}-${trip.to}`}
            basemapDefault="satellite"
            radarDefault={false}
            showLegend={false}
            showTrailToggle={false}
            overlay={(
              <div className="rounded-lg border border-edge bg-surface/90 px-3 py-2 shadow-card backdrop-blur">
                <div className="font-mono text-[10px] font-semibold text-content">
                  {adsb?.available
                    ? `${trip.tail} · ${adsb.airborne ? 'AIRBORNE' : 'GROUND'}`
                    : `${trip.tail} · WAITING FOR FIRST ADS-B POLL`}
                </div>
                <div className="mt-0.5 text-[9px] text-content-muted">
                  {trip.from} → {trip.to}
                  {adsb?.polledAt ? ` · updated ${zulu(adsb.polledAt)}` : ' · route shown from schedule'}
                </div>
              </div>
            )}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['State', adsb?.airborne ? 'AIRBORNE' : 'GROUND'],
            ['Position', adsb?.origin && adsb?.destination ? `${adsb.origin} → ${adsb.destination}` : 'Awaiting movement'],
            ['Altitude', Number.isFinite(adsb?.altitude) ? `${adsb.altitude.toLocaleString()} ft` : '—'],
            ['Groundspeed', Number.isFinite(adsb?.groundspeed) ? `${adsb.groundspeed} kt` : '—'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
              <div className="text-[9px] uppercase tracking-wider text-slate-500">{label}</div>
              <div className="mt-1 font-mono text-sm text-slate-100">{value}</div>
            </div>
          ))}
        </div>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-cyan-300" />
            <h2 className="text-sm font-semibold">Send flight update</h2>
            <span className="ml-auto font-mono text-[10px] text-slate-500">
              {completedSteps}/{STATUS_STEPS.length} COMPLETE
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-cyan-400 transition-all"
              style={{ width: `${(completedSteps / STATUS_STEPS.length) * 100}%` }}
            />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Crew member name *" maxLength={120} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-400" />
            <input value={company} onChange={(event) => setCompany(event.target.value)} placeholder="Operating company" maxLength={160} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note" maxLength={500} className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-400" />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {STATUS_STEPS.map(([key, label]) => {
              const complete = Boolean(trip.statuses?.[key]);
              const selected = selectedStatus === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedStatus(key)}
                  disabled={busy !== '' || complete}
                  aria-pressed={selected}
                  className={`rounded border px-2 py-2 text-[10px] font-semibold transition-colors ${
                    complete
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : selected
                        ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200 ring-2 ring-cyan-400/20'
                        : 'border-slate-700 text-slate-300 hover:border-cyan-400 hover:bg-cyan-500/5'
                  }`}
                >
                  {complete ? <Check className="mx-auto mb-1 h-3.5 w-3.5" /> : <Clock className="mx-auto mb-1 h-3.5 w-3.5" />}
                  {label}
                </button>
              );
            })}
          </div>
          {selectedStatus && (
            <div className="mt-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
              <div className="text-[9px] font-semibold uppercase tracking-widest text-cyan-300">
                Selected update
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-100">
                {STATUS_STEPS.find(([key]) => key === selectedStatus)?.[1]}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {STATUS_STEPS.find(([key]) => key === selectedStatus)?.[2]}
              </div>
              {note && <div className="mt-2 text-xs text-slate-300">Crew note: {note}</div>}
              <button
                type="button"
                onClick={async () => {
                  const sent = await sendAction('status', { statusKey: selectedStatus, note });
                  if (sent) {
                    setSelectedStatus('');
                    setNote('');
                  }
                }}
                disabled={busy !== ''}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded bg-cyan-400 px-4 py-2.5 text-xs font-bold text-slate-950 disabled:opacity-60"
              >
                {busy === 'status' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                SEND SELECTED UPDATE
              </button>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-center gap-2"><FilePlus2 className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-semibold">File repositioning movement</h2></div>
          <p className="mt-1 text-[10px] text-slate-500">Only use this for an empty positioning flight associated with this charter.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <input value={repo.from} onChange={(event) => setRepo({ ...repo, from: event.target.value.toUpperCase() })} placeholder="FROM" maxLength={8} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-cyan-400" />
            <input value={repo.to} onChange={(event) => setRepo({ ...repo, to: event.target.value.toUpperCase() })} placeholder="TO" maxLength={8} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm outline-none focus:border-cyan-400" />
            <input type="datetime-local" value={repo.departure} onChange={(event) => setRepo({ ...repo, departure: event.target.value })} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs outline-none focus:border-cyan-400" title="Zulu departure" />
            <input type="datetime-local" value={repo.arrival} onChange={(event) => setRepo({ ...repo, arrival: event.target.value })} className="rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs outline-none focus:border-cyan-400" title="Zulu arrival (optional)" />
          </div>
          <div className="mt-2 flex gap-2">
            <input value={repo.note} onChange={(event) => setRepo({ ...repo, note: event.target.value })} placeholder="Optional reposition note" maxLength={500} className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-cyan-400" />
            <button
              type="button"
              disabled={busy !== '' || !repo.from || !repo.to || !repo.departure}
              onClick={async () => {
                const sent = await sendAction('reposition', {
                  ...repo,
                  departure: `${repo.departure}:00Z`,
                  arrival: repo.arrival ? `${repo.arrival}:00Z` : null,
                });
                if (sent) setRepo((current) => ({ ...current, to: '', arrival: '', note: '' }));
              }}
              className="rounded bg-cyan-400 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50"
            >
              FILE REPOSITION
            </button>
          </div>
        </section>

        {(adsb?.filedFlights?.length > 0 || trip.repositioning?.length > 0) && (
          <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-semibold">Movement awareness</h2></div>
            {trip.repositioning.map((movement) => (
              <div key={movement.id} className="mt-2 rounded border border-cyan-500/30 bg-cyan-500/5 p-2 text-xs">
                <span className="font-mono text-cyan-200">REPOSITION · {movement.from} → {movement.to}</span>
                <span className="ml-2 text-slate-500">{zulu(movement.departure)} · filed by {movement.author}</span>
              </div>
            ))}
            {adsb?.filedFlights?.map((movement) => (
              <div key={movement.id} className="mt-2 rounded border border-slate-800 p-2 text-xs">
                <span className="font-mono text-slate-300">FLIGHTAWARE FILED · {movement.origin} → {movement.destination}</span>
                <span className="ml-2 text-slate-500">{zulu(movement.scheduledOut)}</span>
              </div>
            ))}
            {adsb?.filedFlights?.length > 0 && (
              <p className="mt-2 text-[10px] text-amber-300/80">
                FlightAware filed movements are not automatically labeled repositioning because ADS-B data does not identify passenger carriage.
              </p>
            )}
          </section>
        )}

        {message && (
          <div className="flex items-start gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 p-3 text-xs text-cyan-200">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> {message}
          </div>
        )}
      </main>
    </div>
  );
}

