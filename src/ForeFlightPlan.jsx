/**
 * Trip → Flight Plan tab.
 *
 * Two layers:
 *   1. Dispatch sync (create/update/release via public-api.foreflight.com)
 *   2. Mobile deep links (maps search + flights/view) for filing on device
 *
 * ForeFlight does not offer an embeddable planner UI — filing still happens
 * inside ForeFlight after the plan is pushed or opened via deep link.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { brand } from './brand.js';
import {
  buildDispatchEditUrl,
  buildForeFlightFlightViewUrl,
  buildForeFlightMapsUrl,
  normalizeIcao,
} from './foreflight.js';

const AIRCRAFT_DEFAULTS = {
  C25B: { cruiseKts: 380, burnGph: 180, cruiseFt: 39000 },
  C25A: { cruiseKts: 360, burnGph: 165, cruiseFt: 39000 },
  C25: { cruiseKts: 340, burnGph: 150, cruiseFt: 39000 },
  C56X: { cruiseKts: 400, burnGph: 230, cruiseFt: 45000 },
  C680: { cruiseKts: 430, burnGph: 280, cruiseFt: 45000 },
  AS50: { cruiseKts: 130, burnGph: 55, cruiseFt: 5000 },
  EC30: { cruiseKts: 135, burnGph: 60, cruiseFt: 5000 },
};

function getAircraftDefaults(aircraftType) {
  if (!aircraftType) return { cruiseKts: 380, burnGph: 180, cruiseFt: 39000 };
  const key = String(aircraftType).toUpperCase().replace(/[\s-]/g, '');
  if (AIRCRAFT_DEFAULTS[key]) return AIRCRAFT_DEFAULTS[key];
  for (const k of Object.keys(AIRCRAFT_DEFAULTS)) {
    if (key.startsWith(k)) return AIRCRAFT_DEFAULTS[k];
  }
  return { cruiseKts: 380, burnGph: 180, cruiseFt: 39000 };
}

function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua)
    || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
}

function PlanField({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <label className="block">
      <span className="block text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(type === 'number' ? Number(e.target.value) || 0 : e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:border-cyan-500/50"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      />
    </label>
  );
}

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser.getIdToken();
}

export default function ForeFlightPlan({ trip, currentUser, users = [] }) {
  const from = trip?.info?.from || '';
  const to = trip?.info?.to || '';
  const tail = trip?.info?.tail || '';
  const aircraftType = trip?.info?.aircraftType || trip?.info?.acType || '';
  const etdIso = trip?.start || '';
  const acDefaults = getAircraftDefaults(aircraftType);

  const [cruiseKts, setCruiseKts] = useState(acDefaults.cruiseKts);
  const [burnGph, setBurnGph] = useState(acDefaults.burnGph);
  const [cruiseFt, setCruiseFt] = useState(acDefaults.cruiseFt);
  const [alternate, setAlternate] = useState('');
  const [routeNotes, setRouteNotes] = useState('');
  const [copied, setCopied] = useState(false);

  const [ffStatus, setFfStatus] = useState(null);
  const [link, setLink] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const canSync = ['admin', 'ops', 'pilot'].includes(currentUser?.role);

  const mapsUrl = buildForeFlightMapsUrl({
    from,
    to,
    cruiseKts: cruiseKts || acDefaults.cruiseKts,
    burnGph: burnGph || acDefaults.burnGph,
    cruiseFt: cruiseFt || acDefaults.cruiseFt,
    tail,
    etdIso,
  });
  const minimalUrl = buildForeFlightMapsUrl({ from, to });
  const fromIcao = normalizeIcao(from);
  const toIcao = normalizeIcao(to);
  const codesNormalized = (fromIcao !== from?.toUpperCase()) || (toIcao !== to?.toUpperCase());
  const onIos = isIosDevice();

  const ttSummary = [
    `AIRCRAFT: ${tail || '—'} ${aircraftType ? `(${aircraftType})` : ''}`,
    `ROUTE: ${from || '—'} → ${to || '—'}${alternate ? `  ALT: ${alternate}` : ''}`,
    `CRUISE: ${cruiseFt}ft @ ${cruiseKts}kts, ${burnGph}gph`,
    etdIso ? `ETD (Z): ${new Date(etdIso).toISOString().replace(/\.\d+Z$/, 'Z')}` : null,
    trip?.info?.pic ? `PIC: ${trip.info.pic}` : null,
    trip?.info?.sic ? `SIC: ${trip.info.sic}` : null,
    `SOULS ON BOARD: ${(trip?.info?.pax || 0) + (trip?.info?.pic ? 1 : 0) + (trip?.info?.sic ? 1 : 0)}`,
    routeNotes ? `NOTES: ${routeNotes}` : null,
  ].filter(Boolean).join('\n');

  const loadStatus = useCallback(async () => {
    if (!canSync) return;
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      const data = await r.json();
      if (r.ok) setFfStatus(data);
    } catch {
      /* non-fatal — deep links still work */
    }
  }, [canSync]);

  const refreshLinked = useCallback(async () => {
    if (!trip?.uid || !canSync) return;
    setError(null);
    try {
      const { db } = await import('./firebase.js');
      const { doc, getDoc } = await import('firebase/firestore');
      const snap = await getDoc(doc(db, 'trip-state', String(trip.uid)));
      const ff = snap.exists() ? snap.data()?.foreflight : null;
      setLink(ff || null);

      if (ff?.flightId && ffStatus?.connected) {
        const token = await idToken();
        const r = await fetch('/api/foreflight-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: token, action: 'getFlight', flightId: ff.flightId }),
        });
        const data = await r.json();
        if (r.ok) setDetail(data.result || null);
      }
    } catch (err) {
      setError(err.message || 'Could not refresh ForeFlight link');
    }
  }, [trip?.uid, canSync, ffStatus?.connected]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { refreshLinked(); }, [refreshLinked]);

  async function syncToDispatch({ release = false } = {}) {
    if (!canSync || busy) return;
    setBusy(release ? 'release' : 'sync');
    setError(null);
    setInfo(null);
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-sync-trip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: token,
          trip: {
            uid: trip.uid,
            start: trip.start instanceof Date ? trip.start.toISOString() : trip.start,
            info: {
              from: trip.info?.from,
              to: trip.info?.to,
              tail: trip.info?.tail,
              pic: trip.info?.pic,
              sic: trip.info?.sic,
              pax: trip.info?.pax,
              legType: trip.info?.legType,
              aircraftType,
            },
          },
          cruiseFt,
          routeNotes,
          alternate,
          users: (users || []).map((u) => ({
            email: u.email,
            name: u.name,
            jetinsightName: u.jetinsightName,
            displayName: u.displayName,
          })),
          release,
          releaseAsEditable: true,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLink(data.foreflight || null);
      setDetail(data.detail || null);
      setInfo(release
        ? `Released to crew in ForeFlight (${data.flightId}).`
        : `Synced to ForeFlight Dispatch (${data.mode}: ${data.flightId}).`);
      await loadStatus();
    } catch (err) {
      setError(err.message || 'Sync failed');
    } finally {
      setBusy(null);
    }
  }

  function copySummary() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(ttSummary).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  const flightViewUrl = buildForeFlightFlightViewUrl(link?.flightId);
  const dispatchUrl = buildDispatchEditUrl(ffStatus?.organisationUUID, link?.flightId);
  const connected = Boolean(ffStatus?.connected && ffStatus?.enabled);

  return (
    <div className="p-4 max-w-3xl space-y-4">
      <div className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
        <div className="text-[11px] text-amber-200/80" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          <strong className="text-amber-300">Pilot files the actual plan.</strong>
          {' '}{brand().name} pushes the trip into ForeFlight Dispatch (and opens Mobile deep links) so you can review, release, and file inside ForeFlight. This app does not file directly with the FAA.
        </div>
      </div>

      {error && (
        <div className="p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">{error}</div>
      )}
      {info && (
        <div className="p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">{info}</div>
      )}

      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>TRIP</span>
          <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{tail || '—'}</span>
        </div>
        <div className="flex items-center gap-3 text-lg" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          <span className="text-slate-100">{from || '—'}</span>
          <ArrowRight className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-100">{to || '—'}</span>
        </div>
        {etdIso && (
          <div className="text-[11px] text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ETD: {new Date(etdIso).toISOString().replace(/\.\d+Z$/, 'Z')}
          </div>
        )}
      </div>

      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PERFORMANCE</span>
          {aircraftType && (
            <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{aircraftType} defaults</span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <PlanField label="CRUISE ALT (ft)" value={cruiseFt} onChange={setCruiseFt} type="number" />
          <PlanField label="CRUISE SPEED (kts)" value={cruiseKts} onChange={setCruiseKts} type="number" />
          <PlanField label="FUEL BURN (gph)" value={burnGph} onChange={setBurnGph} type="number" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <PlanField label="ALTERNATE (optional)" value={alternate} onChange={setAlternate} placeholder="e.g. KJAX" />
          <PlanField label="ROUTE NOTES (optional)" value={routeNotes} onChange={setRouteNotes} placeholder="e.g. DCT WAYPT DCT" />
        </div>
      </div>

      {/* Dispatch API */}
      <div className="border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] tracking-widest text-cyan-400 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              FOREFLIGHT DISPATCH
            </div>
            <div className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
              Creates or updates the flight in Dispatch with aircraft, ETD, route, altitude, load, and matched crew emails. Release makes it visible on crew iPads.
            </div>
          </div>
          <button
            type="button"
            onClick={refreshLinked}
            className="p-1.5 text-slate-500 hover:text-cyan-300"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {!connected ? (
          <div className="text-[11px] text-amber-200/90" style={{ fontFamily: 'DM Sans, sans-serif' }}>
            Dispatch is not connected. An administrator must paste a ForeFlight Dispatch API key under Settings → ForeFlight Dispatch.
          </div>
        ) : (
          <>
            {link?.flightId && (
              <div className="text-[10px] text-slate-400 space-y-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Linked flight {link.flightId}
                </div>
                <div>Release: {detail?.releaseStatus || link.releaseStatus || '—'}</div>
                {detail?.filing?.recallNumber && <div>Recall: {detail.filing.recallNumber}</div>}
                {link.syncedAt && <div>Synced: {new Date(link.syncedAt).toLocaleString()}</div>}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!!busy || !canSync}
                onClick={() => syncToDispatch({ release: false })}
                className="py-2.5 text-xs tracking-widest border border-cyan-400/50 text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {busy === 'sync' ? <span className="inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> SYNCING…</span> : (link?.flightId ? 'UPDATE IN DISPATCH' : 'SYNC TO DISPATCH')}
              </button>
              <button
                type="button"
                disabled={!!busy || !canSync}
                onClick={() => syncToDispatch({ release: true })}
                className="py-2.5 text-xs tracking-widest border border-emerald-400/50 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {busy === 'release' ? <span className="inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> RELEASING…</span> : 'SYNC + RELEASE TO CREW'}
              </button>
            </div>
            {(dispatchUrl || flightViewUrl) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {dispatchUrl && (
                  <a
                    href={dispatchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    OPEN IN DISPATCH WEB →
                  </a>
                )}
                {flightViewUrl && (
                  <a
                    href={flightViewUrl}
                    className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    OPEN FLIGHT IN FOREFLIGHT MOBILE →
                  </a>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Mobile maps deep link */}
      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          OPEN IN FOREFLIGHT MAPS
        </div>
        <div className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          Loads the route on the ForeFlight Maps view with speed, fuel, altitude, tail and ETD pre-populated. From there, send to Flights to file.
        </div>
        {codesNormalized && (
          <div className="text-[10px] text-cyan-300/80 bg-cyan-500/5 border border-cyan-500/20 px-2 py-1.5"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            Codes normalized: {from} → <strong>{fromIcao}</strong>, {to} → <strong>{toIcao}</strong>
          </div>
        )}
        {!onIos && (
          <div className="text-[10px] text-amber-300/80" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            This link only works on iOS devices with ForeFlight installed.
          </div>
        )}
        <a
          href={mapsUrl || '#'}
          className={`block w-full text-center py-3 text-sm tracking-widest border transition-colors ${
            mapsUrl
              ? 'bg-cyan-500/10 border-cyan-400 text-cyan-300 hover:bg-cyan-500/20'
              : 'bg-slate-900 border-slate-800 text-slate-600 cursor-not-allowed pointer-events-none'
          }`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          OPEN IN FOREFLIGHT →
        </a>
        {minimalUrl && mapsUrl && minimalUrl !== mapsUrl && (
          <details className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <summary className="cursor-pointer hover:text-slate-300">Route not loading? Try minimal URL</summary>
            <a href={minimalUrl} className="block mt-2 w-full text-center py-2 text-xs tracking-widest border border-slate-700 text-slate-300 hover:bg-slate-800/50">
              OPEN ROUTE ONLY →
            </a>
          </details>
        )}
      </div>

      <div className="border border-slate-800 bg-slate-900/40 p-4">
        <div className="text-[10px] tracking-widest text-slate-500 mb-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          NEXT STEPS IN FOREFLIGHT
        </div>
        <ol className="space-y-2.5 text-[11px] text-slate-300" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          <li>1. Prefer <strong className="text-cyan-300">Sync to Dispatch</strong> when the operator has a Dispatch subscription — the flight appears in Dispatch with crew, load, and route.</li>
          <li>2. <strong className="text-cyan-300">Release to crew</strong> so assigned pilots see it on ForeFlight Mobile.</li>
          <li>3. Or use <strong className="text-cyan-300">Open in ForeFlight</strong> (Maps deep link), then Send To → Flights, and file from there.</li>
          <li>4. Filing, amendments, and cancellations after file stay inside ForeFlight (the API cannot modify a filed flight).</li>
        </ol>
      </div>

      <div className="border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FLIGHT PLAN SUMMARY</span>
          <button
            type="button"
            onClick={copySummary}
            className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300 transition-colors"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {copied ? '✓ COPIED' : 'COPY'}
          </button>
        </div>
        <pre className="text-[11px] text-slate-300 leading-relaxed whitespace-pre-wrap bg-slate-950 border border-slate-800 p-3"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
{ttSummary}
        </pre>
      </div>
    </div>
  );
}
