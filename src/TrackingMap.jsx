/* =============================================================================
   TRACKING MAP
   =============================================================================
   The single map component behind the ops Tracking screen and the public
   broker tracking page. Callers hand it a normalized `scene` and it owns
   everything map-shaped: basemaps, weather radar, the altitude-coloured flight
   trail, aircraft and airport markers, fit/follow behaviour and fullscreen.

   Keeping the scene normalized is what lets one component serve both surfaces.
   Ops passes a whole fleet plus the selected aircraft's track log; the broker
   page passes one aircraft plus its legs. Neither knows anything about Leaflet.

   scene = {
     aircraft:  [{ id, tail, lat, lon, heading, altitude, groundspeed,
                   airborne, groundedAt }],
     airports:  [{ code, lat, lon, tone }],          // tone: origin|destination|neutral
     routes:    [{ points: [[lat,lon]…], color, dashed, weight, opacity }],
     trail:     track-log points | [lat,lon] pairs | [lon,lat] pairs,
     projected: [[lat,lon], [lat,lon]] | null,       // ahead-of-aircraft leg
   }
   ============================================================================= */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Layers, CloudRain, Maximize2, Minimize2, Crosshair, Loader2, Route, Check,
} from 'lucide-react';
import {
  loadLeaflet, BASEMAPS, BASEMAP_ORDER, applyBasemap, createRadarLayer,
  drawAltitudeTrail, ALTITUDE_LEGEND, altitudeColor, aircraftIcon, airportIcon,
  groundedIcon,
} from './tracking-map.js';
import {
  APPLE_BASEMAP_LABELS,
  appleMapType,
  loadAppleMapKit,
} from './apple-mapkit.js';
import { cx } from './ui.jsx';

const EMPTY_SCENE = { aircraft: [], airports: [], routes: [], trail: null, projected: null };

export default function TrackingMap({
  scene = EMPTY_SCENE,
  selectedId = null,
  onSelectAircraft,
  /** Change this value to request a re-fit (e.g. new selection, new trip). */
  fitKey = '',
  /**
   * Aircraft ids the fit should frame. Ops passes just the selected tail so
   * choosing an aircraft frames its flight rather than the whole country;
   * omit it to frame every aircraft in the scene.
   */
  focusIds = null,
  basemapDefault = 'dark',
  radarDefault = false,
  showLegend = true,
  showTrailToggle = true,
  className = '',
  style,
  /** Rendered inside the map frame, top-left — used for live status readouts. */
  overlay = null,
}) {
  const containerRef = useRef(null);
  const appleContainerRef = useRef(null);
  const frameRef = useRef(null);
  const mapRef = useRef(null);
  const appleMapRef = useRef(null);
  const appleErrorHandlerRef = useRef(null);
  const overlayGroupRef = useRef(null);
  const radarRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [basemap, setBasemap] = useState(basemapDefault);
  const [radarOn, setRadarOn] = useState(radarDefault);
  const [radarFrameAt, setRadarFrameAt] = useState(null);
  const [trailOn, setTrailOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [mapProvider, setMapProvider] = useState('checking');

  const aircraft = Array.isArray(scene.aircraft) ? scene.aircraft : [];
  const airports = Array.isArray(scene.airports) ? scene.airports : [];
  const routes = Array.isArray(scene.routes) ? scene.routes : [];

  /* ─── Init ─────────────────────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Apple Maps is the preferred basemap. Leaflet remains the overlay and
        // interaction engine for aircraft, trails and weather radar. If MapKit
        // credentials/CDN/domain authorization are unavailable, the existing
        // Leaflet basemap is used with no feature loss.
        const [L, apple] = await Promise.all([
          loadLeaflet(),
          loadAppleMapKit().catch((appleError) => {
            console.info('[tracking-map] Apple Maps unavailable; using standard basemap:', appleError.message);
            return null;
          }),
        ]);
        if (cancelled || !containerRef.current) return;
        const map = L.map(containerRef.current, {
          center: [39, -96],
          zoom: 4,
          minZoom: 2,
          maxZoom: 17,
          zoomControl: false,
          attributionControl: !apple,
          worldCopyJump: false,
        });
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        if (map.attributionControl) map.attributionControl.setPrefix(false);

        if (apple && appleContainerRef.current) {
          const appleMap = new apple.Map(appleContainerRef.current, {
            mapType: appleMapType(apple, basemapDefault),
            showsCompass: apple.FeatureVisibility?.Hidden,
            showsMapTypeControl: false,
            showsZoomControl: false,
            isRotationEnabled: false,
            isScrollEnabled: false,
            isZoomEnabled: false,
          });
          appleMapRef.current = appleMap;
          const syncAppleRegion = () => {
            try {
              const center = map.getCenter();
              const bounds = map.getBounds();
              const latitudeDelta = Math.max(0.0005, Math.abs(bounds.getNorth() - bounds.getSouth()));
              let longitudeDelta = Math.abs(bounds.getEast() - bounds.getWest());
              if (longitudeDelta > 180) longitudeDelta = 360 - longitudeDelta;
              longitudeDelta = Math.max(0.0005, longitudeDelta);
              const region = new apple.CoordinateRegion(
                new apple.Coordinate(center.lat, center.lng),
                new apple.CoordinateSpan(latitudeDelta, longitudeDelta),
              );
              if (typeof appleMap.setRegionAnimated === 'function') {
                appleMap.setRegionAnimated(region, false);
              } else {
                appleMap.region = region;
              }
            } catch {
              /* MapKit may still be finishing its first layout. */
            }
          };
          map.on('move zoom resize', syncAppleRegion);
          map.__swAppleSync = syncAppleRegion;
          const fallBackToStandard = (event) => {
            console.warn('[tracking-map] Apple Maps runtime error; using standard basemap', event);
            try { appleMap.destroy(); } catch { /* already torn down */ }
            appleMapRef.current = null;
            if (appleContainerRef.current) appleContainerRef.current.style.display = 'none';
            applyBasemap(L, map, basemapDefault);
            setMapProvider('standard');
          };
          if (typeof apple.addEventListener === 'function') {
            apple.addEventListener('error', fallBackToStandard);
            appleErrorHandlerRef.current = fallBackToStandard;
          }
          setTimeout(syncAppleRegion, 0);
          if (!cancelled) setMapProvider('apple');
        } else {
          applyBasemap(L, map, basemapDefault);
          if (!cancelled) setMapProvider('standard');
        }
        overlayGroupRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Map failed to load');
      }
    })();
    return () => {
      cancelled = true;
      if (radarRef.current) { radarRef.current.destroy(); radarRef.current = null; }
      if (mapRef.current) {
        if (mapRef.current.__swAppleSync) {
          mapRef.current.off('move zoom resize', mapRef.current.__swAppleSync);
        }
        try { mapRef.current.remove(); } catch { /* already torn down */ }
        mapRef.current = null;
        overlayGroupRef.current = null;
      }
      if (appleMapRef.current) {
        try { appleMapRef.current.destroy(); } catch { /* already torn down */ }
        appleMapRef.current = null;
      }
      if (
        appleErrorHandlerRef.current
        && window.mapkit
        && typeof window.mapkit.removeEventListener === 'function'
      ) {
        window.mapkit.removeEventListener('error', appleErrorHandlerRef.current);
        appleErrorHandlerRef.current = null;
      }
    };
    // basemapDefault is an initial value only; switching is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── Basemap switching ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (mapProvider === 'apple' && appleMapRef.current && window.mapkit) {
      appleMapRef.current.mapType = appleMapType(window.mapkit, basemap);
    } else if (mapProvider === 'standard') {
      applyBasemap(window.L, mapRef.current, basemap);
    }
  }, [ready, basemap, mapProvider]);

  /* ─── Weather radar ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    if (!radarOn) {
      if (radarRef.current) { radarRef.current.destroy(); radarRef.current = null; }
      setRadarFrameAt(null);
      return;
    }
    radarRef.current = createRadarLayer(window.L, mapRef.current, {
      opacity: 0.55,
      onFrame: (epochSeconds) => setRadarFrameAt(epochSeconds * 1000),
    });
    return () => {
      if (radarRef.current) { radarRef.current.destroy(); radarRef.current = null; }
    };
  }, [ready, radarOn]);

  /* ─── Keep Leaflet's size cache honest ─────────────────────────────────── */
  useEffect(() => {
    if (!ready || !mapRef.current || !containerRef.current) return;
    const map = mapRef.current;
    const invalidate = () => { try { map.invalidateSize(false); } catch { /* not mounted */ } };
    const ro = new ResizeObserver(invalidate);
    ro.observe(containerRef.current);
    // Panels that mount the map inside a hidden tab need an explicit nudge.
    window.addEventListener('skyway-map-invalidate', invalidate);
    return () => {
      ro.disconnect();
      window.removeEventListener('skyway-map-invalidate', invalidate);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const t = setTimeout(() => {
      try { mapRef.current.invalidateSize(false); } catch { /* not mounted */ }
    }, 220);
    return () => clearTimeout(t);
  }, [ready, fullscreen]);

  /* ─── Draw the scene ──────────────────────────────────────────────────── */
  useEffect(() => {
    if (!ready || !mapRef.current || !overlayGroupRef.current) return;
    const L = window.L;
    const group = overlayGroupRef.current;
    group.clearLayers();

    routes.forEach((r) => {
      if (!Array.isArray(r?.points) || r.points.length < 2) return;
      L.polyline(r.points, {
        color: r.color || '#64748b',
        weight: r.weight ?? 2.5,
        opacity: r.opacity ?? 0.85,
        dashArray: r.dashed ? '7 7' : undefined,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(group);
    });

    if (trailOn && scene.trail) {
      drawAltitudeTrail(L, group, scene.trail, { weight: 4, opacity: 0.95 });
    }

    if (Array.isArray(scene.projected) && scene.projected.length >= 2) {
      L.polyline(scene.projected, {
        color: '#3FA9CC', weight: 2.5, opacity: 0.5,
        dashArray: '6 8', lineCap: 'round', lineJoin: 'round',
      }).addTo(group);
    }

    airports.forEach((a) => {
      if (!Number.isFinite(a?.lat) || !Number.isFinite(a?.lon)) return;
      L.marker([a.lat, a.lon], {
        icon: airportIcon(L, { code: a.code, tone: a.tone || 'neutral', small: a.small }),
        interactive: false,
        zIndexOffset: 400,
      }).addTo(group);
    });

    // Parked aircraft first so airborne markers and their labels sit on top.
    aircraft
      .filter((a) => a.airborne !== true)
      .forEach((a) => {
        if (!Number.isFinite(a?.lat) || !Number.isFinite(a?.lon)) return;
        const selected = a.id === selectedId;
        const marker = L.marker([a.lat, a.lon], {
          icon: groundedIcon(L, { tail: a.tail, at: a.groundedAt, selected }),
          zIndexOffset: selected ? 700 : 50,
        }).addTo(group);
        if (onSelectAircraft) marker.on('click', () => onSelectAircraft(a.id));
      });

    aircraft
      .filter((a) => a.airborne === true)
      .forEach((a) => {
        if (!Number.isFinite(a?.lat) || !Number.isFinite(a?.lon)) return;
        const selected = a.id === selectedId;
        const marker = L.marker([a.lat, a.lon], {
          icon: aircraftIcon(L, {
            tail: a.tail,
            heading: a.heading ?? 0,
            altitude: a.altitude,
            groundspeed: a.groundspeed,
            selected,
            showLabel: a.showLabel !== false,
          }),
          zIndexOffset: selected ? 1000 : 200,
        }).addTo(group);
        if (onSelectAircraft) marker.on('click', () => onSelectAircraft(a.id));
      });
  }, [ready, scene, routes, airports, aircraft, selectedId, onSelectAircraft, trailOn]);

  /* ─── Fit ─────────────────────────────────────────────────────────────── */
  const fitScene = useCallback(() => {
    if (!mapRef.current) return;
    const L = window.L;
    const pts = [];
    const inFocus = (a) => !Array.isArray(focusIds) || focusIds.includes(a.id);
    aircraft.forEach((a) => {
      if (!inFocus(a)) return;
      if (Number.isFinite(a?.lat) && Number.isFinite(a?.lon)) pts.push([a.lat, a.lon]);
    });
    airports.forEach((a) => {
      if (Number.isFinite(a?.lat) && Number.isFinite(a?.lon)) pts.push([a.lat, a.lon]);
    });
    routes.forEach((r) => {
      if (Array.isArray(r?.points)) r.points.forEach((p) => pts.push(p));
    });
    // The flown trail is the whole point of the view — include every sample so
    // a path that bows well off the direct route stays fully on screen.
    if (scene.trail) {
      const norm = Array.isArray(scene.trail) ? scene.trail : [];
      norm.forEach((p) => {
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          pts.push(Math.abs(p[0]) > 90 ? [p[1], p[0]] : [p[0], p[1]]);
        } else if (p && Number.isFinite(p.lat ?? p.latitude) && Number.isFinite(p.lon ?? p.longitude)) {
          pts.push([p.lat ?? p.latitude, p.lon ?? p.longitude]);
        }
      });
    }
    if (pts.length >= 2) {
      try {
        mapRef.current.fitBounds(L.latLngBounds(pts), {
          padding: [40, 40], maxZoom: 10, animate: true, duration: 0.6,
        });
      } catch { /* degenerate bounds */ }
    } else if (pts.length === 1) {
      mapRef.current.setView(pts[0], 9, { animate: true });
    }
  }, [aircraft, airports, routes, scene.trail, focusIds]);

  // Re-fit when the caller signals a meaningful change (selection, trip, first
  // data arrival). Position updates alone must not steal the user's pan/zoom.
  const lastFitRef = useRef(null);
  useEffect(() => {
    if (!ready) return;
    if (lastFitRef.current === fitKey) return;
    const hasGeometry = aircraft.some((a) => Number.isFinite(a?.lat))
      || airports.some((a) => Number.isFinite(a?.lat));
    if (!hasGeometry) return;
    lastFitRef.current = fitKey;
    fitScene();
  }, [ready, fitKey, aircraft, airports, fitScene]);

  const radarLabel = radarFrameAt
    ? new Date(radarFrameAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  if (error) {
    return (
      <div className={cx('flex h-full items-center justify-center rounded-xl border border-edge bg-surface p-6 text-center text-2xs text-content-muted', className)}>
        Map unavailable ({error}). Position data is still listed below.
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      className={cx(
        'relative overflow-hidden bg-slate-950',
        fullscreen ? 'fixed inset-0 z-[2000]' : className,
      )}
      style={fullscreen ? undefined : style}
    >
      {/* Official MapKit JS owns the basemap image, including Apple legal
          attribution. Leaflet is transparent above it and draws operational
          overlays/interactions; it never requests or repackages Apple tiles. */}
      <div
        ref={appleContainerRef}
        className="absolute inset-0 h-full w-full"
        style={{ background: '#060c16' }}
      />
      <div
        ref={containerRef}
        className="absolute inset-0 h-full w-full"
        style={{ background: 'transparent' }}
      />

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-2xs text-content-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading map…
        </div>
      )}

      {overlay && (
        <div className="pointer-events-none absolute left-3 top-3 z-[500] max-w-[min(20rem,calc(100%-6rem))]">
          {overlay}
        </div>
      )}

      {/* Controls. Leaflet's own panes sit below z-400, so 500+ keeps these
          above tiles and markers without fighting the zoom control. */}
      <div className="absolute right-3 top-3 z-[500] flex flex-col items-end gap-2">
        <div className="flex gap-2">
          <MapButton
            icon={CloudRain}
            label={radarOn ? `Radar ${radarLabel || '…'}` : 'Radar'}
            active={radarOn}
            onClick={() => setRadarOn((v) => !v)}
            title="Toggle weather radar"
          />
          <MapButton
            icon={Layers}
            active={layersOpen}
            onClick={() => setLayersOpen((v) => !v)}
            title="Map layers"
          />
        </div>

        {layersOpen && (
          <div className="w-44 rounded-lg border border-edge bg-surface/95 p-1.5 shadow-overlay backdrop-blur">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Basemap</p>
            {BASEMAP_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => { setBasemap(id); setLayersOpen(false); }}
                className={cx(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-2xs transition-colors',
                  basemap === id ? 'bg-accent-soft font-semibold text-accent' : 'text-content hover:bg-surface-raised',
                )}
              >
                {mapProvider === 'apple' ? APPLE_BASEMAP_LABELS[id] : BASEMAPS[id].label}
                {basemap === id && <Check className="h-3.5 w-3.5" />}
              </button>
            ))}
            <p className="px-2 pb-1 pt-1.5 text-[9px] text-content-subtle">
              {mapProvider === 'apple' ? 'Basemap by Apple Maps' : 'Standard map fallback'}
            </p>
            {showTrailToggle && (
              <>
                <div className="my-1 border-t border-edge" />
                <button
                  type="button"
                  onClick={() => setTrailOn((v) => !v)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-2xs text-content transition-colors hover:bg-surface-raised"
                >
                  <span className="flex items-center gap-1.5"><Route className="h-3.5 w-3.5" /> Flight trail</span>
                  {trailOn && <Check className="h-3.5 w-3.5 text-accent" />}
                </button>
              </>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <MapButton icon={Crosshair} onClick={fitScene} title="Fit the whole flight on screen" />
          <MapButton
            icon={fullscreen ? Minimize2 : Maximize2}
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen map'}
          />
        </div>
      </div>

      {showLegend && trailOn && scene.trail && (
        <div className="absolute bottom-3 left-3 z-[500] rounded-lg border border-edge bg-surface/90 px-2.5 py-2 shadow-card backdrop-blur">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Altitude</p>
          <div className="flex items-center gap-1.5">
            {ALTITUDE_LEGEND.map((stop) => (
              <span key={stop.label} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: altitudeColor(stop.ft) }} />
                <span className="font-mono text-[9px] text-content-muted">{stop.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MapButton({ icon: Icon, label, active, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active ? true : undefined}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-lg border px-2.5 shadow-card backdrop-blur transition-colors',
        active
          ? 'border-accent-border bg-accent-soft text-accent'
          : 'border-edge bg-surface/90 text-content-muted hover:text-content',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label && <span className="font-mono text-[10px] font-semibold">{label}</span>}
    </button>
  );
}
