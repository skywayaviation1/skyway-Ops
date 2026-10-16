// Ops Tracking.
//
// Fleet overview is the full-bleed dark map of every managed tail. Choosing a
// tail opens the single-flight detail look. The map component is shared with
// the broker page and the home dashboard; those stay on presentation="ops".

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plane } from 'lucide-react';
import TrackingMap from './TrackingMap.jsx';
import TrackingFlightChrome from './TrackingFlightChrome.jsx';
import { getAppTimezone } from './app-timezone.js';
import { brand } from './brand.js';
import {
  buildFleetMapScene,
  buildSelectedFlightOverlay,
  formatLastUpdate,
  withSelectedFlightScene,
} from './fleet-tracking.js';
import { resolveManagedTails } from './fleet-config.js';
import { demoPositionsMap } from './reviewer-demo-track.js';
import { readReviewerDatabaseFlag } from './reviewer-sandbox.js';
import { aloftLevel, buildFlightViewModel } from './tracking-flight.js';
import { formatAltitude, formatSpeed } from './tracking-map.js';
import { useFullFlightTrack } from './use-flight-track.js';
import { cx } from './ui.jsx';

function useMedia(query) {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  ));
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

async function authHeaders() {
  const { auth } = await import('./firebase.js');
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

function useTripStates(provided) {
  const [local, setLocal] = useState(null);
  useEffect(() => {
    if (provided) return undefined;
    let cancelled = false;
    let unsubscribe = () => {};
    (async () => {
      try {
        const data = await import('./firebase-data.js');
        if (cancelled || typeof data.subscribeAllTripStates !== 'function') return;
        unsubscribe = data.subscribeAllTripStates((map) => {
          if (!cancelled) setLocal(map || new Map());
        });
      } catch (error) {
        console.warn('[tracking] trip-state subscription failed:', error?.message);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [provided]);
  return provided || local;
}

function useEndpointWeather(codes) {
  const key = codes.join(',');
  const [weather, setWeather] = useState({});
  useEffect(() => {
    if (readReviewerDatabaseFlag() || !key) {
      setWeather({});
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const headers = await authHeaders();
      if (!headers || cancelled) return;
      const list = key.split(',').filter(Boolean);
      const entries = await Promise.all(list.map(async (code) => {
        try {
          const response = await fetch(`/api/airport-weather?icao=${encodeURIComponent(code)}`, { headers });
          if (!response.ok) return [code, null];
          return [code, await response.json()];
        } catch {
          return [code, null];
        }
      }));
      if (!cancelled) setWeather(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [key]);
  return weather;
}

function useAloft(code) {
  const [levels, setLevels] = useState(null);
  useEffect(() => {
    if (readReviewerDatabaseFlag() || !code) {
      setLevels(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const headers = await authHeaders();
      if (!headers || cancelled) return;
      try {
        const response = await fetch(`/api/winds-aloft?icao=${encodeURIComponent(code)}`, { headers });
        if (!response.ok) {
          if (!cancelled) setLevels(null);
          return;
        }
        const data = await response.json();
        if (!cancelled) setLevels(Array.isArray(data.levels) ? data.levels : []);
      } catch {
        if (!cancelled) setLevels(null);
      }
    })();
    return () => { cancelled = true; };
  }, [code]);
  return levels;
}

function useAdvisories(codes) {
  const key = codes.join(',');
  const [advisories, setAdvisories] = useState({ count: 0, items: [] });
  useEffect(() => {
    if (!key) {
      setAdvisories({ count: 0, items: [] });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const headers = await authHeaders();
      const list = key.split(',').filter(Boolean);
      const batches = await Promise.all(list.map(async (code) => {
        try {
          const response = await fetch(`/api/faa-notams?icao=${encodeURIComponent(code)}`, {
            headers: headers || { Accept: 'application/json' },
          });
          if (!response.ok) return [];
          const data = await response.json();
          const significant = Array.isArray(data?.significantOnly) ? data.significantOnly : [];
          return significant.map((item, index) => ({
            id: `${code}-${item.id || item.notamId || index}`,
            icao: code,
            summary: item.summary || item.text || 'NOTAM',
          }));
        } catch {
          return [];
        }
      }));
      if (cancelled) return;
      const items = batches.flat();
      setAdvisories({ count: items.length, items });
    })();
    return () => { cancelled = true; };
  }, [key]);
  return advisories;
}

function useFlightDetail(tail, active) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!active || !tail || readReviewerDatabaseFlag()) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetail(null);
    (async () => {
      const headers = await authHeaders();
      if (!headers || cancelled) return;
      try {
        const response = await fetch(`/api/flightaware-flight-detail?ident=${encodeURIComponent(tail)}`, { headers });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setDetail(data.flight || null);
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => { cancelled = true; };
  }, [tail, active]);
  return detail;
}

export default function TrackingScreen({ trips, tripStates: providedStates, config }) {
  const fleetTails = useMemo(() => resolveManagedTails(config), [config]);
  const reviewer = readReviewerDatabaseFlag();
  const wide = useMedia('(min-width: 1024px)');
  const [mode, setMode] = useState('fleet');
  const [selectedTail, setSelectedTail] = useState(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [fleetSheet, setFleetSheet] = useState(false);
  const [tailStates, setTailStates] = useState(() => (reviewer ? demoPositionsMap() : {}));
  const [loadingFleet, setLoadingFleet] = useState(!reviewer);
  const [lastPolledAt, setLastPolledAt] = useState(null);
  const tripStates = useTripStates(providedStates);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    (async () => {
      try {
        const data = await import('./firebase-data.js');
        if (cancelled) return;
        unsubscribe = data.subscribeFleetPositions((map) => {
          if (cancelled) return;
          const incoming = map || {};
          const next = readReviewerDatabaseFlag()
            ? (Object.keys(incoming).length === 0 ? demoPositionsMap() : { ...demoPositionsMap(), ...incoming })
            : incoming;
          setTailStates(next);
          const latest = Object.values(next).reduce(
            (max, item) => Math.max(max, Number(item?.polledAt || 0)),
            0,
          );
          setLastPolledAt(latest || null);
          setLoadingFleet(false);
        });
      } catch (error) {
        console.warn('[tracking] fleet subscription failed:', error?.message);
        if (!cancelled) setLoadingFleet(false);
      }
    })();
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const flightMode = mode === 'flight' && Boolean(selectedTail);
  const selectedState = selectedTail ? tailStates[selectedTail] : null;
  const selectedAirborne = selectedState?.airborne === true;
  const { points: trackPoints } = useFullFlightTrack(flightMode ? selectedTail : null, selectedAirborne);

  const scene = useMemo(() => {
    const fleetScene = buildFleetMapScene({
      fleetTails,
      positions: tailStates,
      trips,
      tripStates,
      aircraftByTail: config?.aircraftByTail || {},
      timeZone: getAppTimezone() || undefined,
    });
    if (!flightMode) return fleetScene;
    const overlay = buildSelectedFlightOverlay({
      telemetry: selectedState,
      trackPoints,
    });
    const framed = withSelectedFlightScene(fleetScene, overlay, { selectedTail });
    return {
      ...framed,
      aircraft: framed.aircraft.filter((item) => item.id === selectedTail),
      routes: (framed.routes || []).map((route) => ({
        ...route,
        color: '#F7F8FA',
        dashed: true,
        weight: 3,
        opacity: 0.85,
      })),
    };
  }, [fleetTails, tailStates, trips, tripStates, config?.aircraftByTail, flightMode, selectedState, trackPoints, selectedTail]);

  const model = useMemo(() => {
    if (!flightMode) return null;
    return buildFlightViewModel({
      tail: selectedTail,
      telemetry: selectedState,
      trips,
      tripStates,
      aircraftMeta: config?.aircraftByTail?.[selectedTail] || null,
      detail: null,
      operatorName: brand().name,
    });
  }, [flightMode, selectedTail, selectedState, trips, tripStates, config?.aircraftByTail]);

  const detail = useFlightDetail(selectedTail, flightMode);
  const view = useMemo(() => {
    if (!model) return null;
    if (!detail) return model;
    return buildFlightViewModel({
      tail: selectedTail,
      telemetry: selectedState,
      trips,
      tripStates,
      aircraftMeta: config?.aircraftByTail?.[selectedTail] || null,
      detail,
      operatorName: brand().name,
    });
  }, [model, detail, selectedTail, selectedState, trips, tripStates, config?.aircraftByTail]);

  const wxCodes = useMemo(() => {
    if (!view) return [];
    return Array.from(new Set([view.originCode, view.destinationCode].filter(Boolean)));
  }, [view]);
  const weather = useEndpointWeather(flightMode ? wxCodes : []);
  const aloftLevels = useAloft(flightMode ? (view?.destinationCode || view?.originCode) : null);
  const aloft = useMemo(
    () => ({ level: aloftLevel(aloftLevels, view?.altitude) }),
    [aloftLevels, view?.altitude],
  );
  const advisories = useAdvisories(flightMode ? wxCodes : []);

  const openTail = useCallback((tail) => {
    setSelectedTail(tail);
    setMode('flight');
    setTimelineOpen(false);
    setFleetSheet(false);
  }, []);

  const backToFleet = useCallback(() => {
    setMode('fleet');
    setTimelineOpen(false);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('skyway-map-invalidate'));
  }, [mode, wide]);

  const airborneCount = fleetTails.filter((tail) => tailStates[tail]?.airborne === true).length;
  const fitKey = flightMode
    ? `${selectedTail}:${trackPoints.length >= 2 ? 'trail' : 'none'}:${selectedAirborne ? 'air' : 'gnd'}`
    : 'fleet';
  const fitInsets = flightMode
    ? (wide
      ? { top: 210, left: 320, right: 320, bottom: 210 }
      : { top: 188, left: 28, right: 72, bottom: 250 })
    : null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-slate-950">
      <TrackingMap
        scene={scene}
        selectedId={flightMode ? selectedTail : null}
        onSelectAircraft={openTail}
        fitKey={fitKey}
        focusIds={flightMode ? [selectedTail] : null}
        followFleet={!flightMode}
        basemapDefault={flightMode ? 'satellite' : 'dark'}
        presentation={flightMode ? 'flight' : 'ops'}
        fitInsets={fitInsets}
        className="absolute inset-0 h-full w-full"
      />

      {flightMode && view ? (
        <TrackingFlightChrome
          model={view}
          weather={weather}
          aloft={aloft}
          advisories={advisories}
          wide={wide}
          timelineOpen={timelineOpen}
          onToggleTimeline={() => setTimelineOpen((open) => !open)}
          onBack={backToFleet}
        />
      ) : (
        <FleetChrome
          tails={fleetTails}
          tailStates={tailStates}
          aircraft={scene.aircraft}
          loading={loadingFleet}
          airborneCount={airborneCount}
          lastPolledAt={lastPolledAt}
          wide={wide}
          sheetOpen={fleetSheet || wide}
          onToggleSheet={() => setFleetSheet((open) => !open)}
          onSelect={openTail}
        />
      )}
    </div>
  );
}

function FleetChrome({
  tails, tailStates, aircraft, loading, airborneCount, lastPolledAt, wide, sheetOpen, onToggleSheet, onSelect,
}) {
  const byTail = useMemo(() => new Map((aircraft || []).map((item) => [item.tail, item])), [aircraft]);
  const list = (
    <div className="flex max-h-[58vh] flex-col lg:max-h-[calc(100dvh-14rem)]">
      <div className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <h2 className="text-sm font-semibold text-white">Fleet</h2>
        <span className="font-mono text-[11px] text-slate-400">
          {airborneCount}/{tails.length} airborne
        </span>
      </div>
      <p className="px-1 pb-2 font-mono text-[10px] text-slate-500">
        {lastPolledAt
          ? `Updated ${new Date(lastPolledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
          : 'Awaiting first poll'}
      </p>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {loading && (
          <p className="flex items-center gap-2 px-1 py-3 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading positions
          </p>
        )}
        {tails.map((tail) => {
          const state = tailStates[tail] || {};
          const marker = byTail.get(tail);
          const airborne = state.airborne === true || marker?.airborne === true;
          const route = airborne
            ? [state.origin, state.destination].filter(Boolean).join(' → ')
            : (state.groundedAt ? `On ground ${state.groundedAt}` : 'No known position');
          return (
            <button
              key={tail}
              type="button"
              onClick={() => onSelect(tail)}
              className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-white/5"
            >
              <span className={cx(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                airborne ? 'bg-emerald-400' : 'bg-slate-500',
                airborne && 'sw-live-dot',
              )} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-white">{tail}</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
                    {airborne ? 'En route' : 'Ground'}
                  </span>
                </span>
                <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">{route}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-500">
                  {airborne
                    ? [formatAltitude(state.altitude), formatSpeed(state.groundspeed), formatLastUpdate(state.polledAt)].filter(Boolean).join(' · ')
                    : (formatLastUpdate(marker?.positionAt || state.polledAt) || '—')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="sw-safe-top pointer-events-auto absolute left-3 top-3 w-[min(22rem,calc(100%-1.5rem))] lg:left-4 lg:top-4">
        <div className="sw-flight-glass p-3">
          {wide ? list : (
            <>
              <button
                type="button"
                onClick={onToggleSheet}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Plane className="h-4 w-4 text-slate-300" />
                  Fleet
                </span>
                <span className="font-mono text-[11px] text-slate-400">{airborneCount}/{tails.length} airborne</span>
              </button>
              {sheetOpen && <div className="mt-3 border-t border-white/10 pt-3">{list}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
