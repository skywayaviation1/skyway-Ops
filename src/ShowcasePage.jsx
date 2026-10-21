// Full-screen trade-show replay. No sign-in. The token in the path is
// checked by /api/showcase-replay; a miss renders not found.
//
// Aircraft are canvas strokes on top of the shared dark basemap. The loop
// is a fixed 1920×1080 frame, scaled by the same ratio as the office TV.

import React, { useEffect, useRef, useState } from 'react';
import TvDesignFrame from './TvDesignFrame.jsx';
import { applyBasemap, loadLeaflet } from './tracking-map.js';
import { placeForAirport } from './showcase-places.js';
import {
  PUBLIC_LEG_KEYS,
  SHOWCASE_LOOP_MS,
  SHOWCASE_PLAY_MS,
  formatShowcaseCount,
  formatShowcaseDate,
  frameActors,
  initialPlayMs,
  isShowcaseToken,
  legEndpoints,
  playbackWindow,
  pointAlong,
  sampleRoute,
  scheduleShowcasePlayback,
  showcaseSnapshot,
  showcaseTailColor,
} from './showcase-replay.js';

const BG = '#060a10';
const LINE = 'rgba(186, 214, 224, 0.16)';
const TEXT = '#e7eef3';
const MUTED = 'rgba(231, 238, 243, 0.62)';
const FONT = "'DM Sans', system-ui, sans-serif";

function publicLegs(legs) {
  const out = [];
  for (const raw of legs || []) {
    const leg = {};
    let ok = true;
    for (const key of PUBLIC_LEG_KEYS) {
      if (raw?.[key] == null || raw[key] === '') ok = false;
      leg[key] = raw?.[key];
    }
    if (ok) out.push(leg);
  }
  return out;
}

function sizeCanvas(canvas, width, height) {
  const dpr = 2;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function strokeChain(ctx, points, from, to, color, width, alpha) {
  if (!points || to - from < 1) return;
  ctx.beginPath();
  let pen = false;
  for (let i = from; i <= to; i += 1) {
    const point = points[i];
    if (!point) continue;
    if (!pen) {
      ctx.moveTo(point.x, point.y);
      pen = true;
      continue;
    }
    const prev = points[i - 1];
    if (prev && Math.hypot(point.x - prev.x, point.y - prev.y) > 320) {
      ctx.moveTo(point.x, point.y);
      continue;
    }
    ctx.lineTo(point.x, point.y);
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPlane(ctx, x, y, heading, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((heading * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.quadraticCurveTo(2.2, -4, 8, 8);
  ctx.lineTo(0, 3.5);
  ctx.lineTo(-8, 8);
  ctx.quadraticCurveTo(-2.2, -4, 0, -13);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(6, 10, 16, 0.85)';
  ctx.stroke();
  ctx.restore();
}

function fitProject(points, width, height) {
  const merc = points.map((point) => {
    const lat = Math.max(-85, Math.min(85, point.lat));
    const x = (point.lng + 180) / 360;
    const s = Math.sin((lat * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return { x, y };
  });
  const minX = Math.min(...merc.map((p) => p.x));
  const maxX = Math.max(...merc.map((p) => p.x));
  const minY = Math.min(...merc.map((p) => p.y));
  const maxY = Math.max(...merc.map((p) => p.y));
  const padL = 56;
  const padT = 112;
  const padR = 430;
  const padB = 156;
  const spanX = Math.max(0.02, maxX - minX);
  const spanY = Math.max(0.02, maxY - minY);
  const scale = Math.min((width - padL - padR) / spanX, (height - padT - padB) / spanY);
  const originX = padL + ((width - padL - padR) - spanX * scale) / 2;
  const originY = padT + ((height - padT - padB) - spanY * scale) / 2;
  return (lat, lng) => {
    const clamped = Math.max(-85, Math.min(85, lat));
    const x = (lng + 180) / 360;
    const s = Math.sin((clamped * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return { x: originX + (x - minX) * scale, y: originY + (y - minY) * scale };
  };
}

function RankSlots({ title, prefix }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 650, letterSpacing: '0.16em', color: MUTED }}>{title}</div>
      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontSize: 12, color: 'rgba(231,238,243,0.38)', fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>
            <span data-rank={`${prefix}-label-${index}`} style={{ fontSize: 18, fontWeight: 600, letterSpacing: '0.04em' }}>—</span>
            <span data-rank={`${prefix}-count-${index}`} style={{ fontSize: 18, fontWeight: 650, color: '#5eead4', fontVariantNumeric: 'tabular-nums' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Counter({ label, count, hint }) {
  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      padding: '12px 14px',
      borderRadius: 14,
      background: 'rgba(8, 14, 22, 0.88)',
      border: `1px solid ${LINE}`,
    }}>
      <div style={{ fontSize: 11, fontWeight: 650, letterSpacing: '0.14em', color: MUTED }}>{label}</div>
      <div data-count={count} style={{ marginTop: 4, fontSize: 34, fontWeight: 650, lineHeight: '36px', fontVariantNumeric: 'tabular-nums' }}>0</div>
      {hint && <div data-count={hint} style={{ marginTop: 2, fontSize: 13, color: MUTED, fontVariantNumeric: 'tabular-nums' }} />}
    </div>
  );
}

function Shell({ children }) {
  return (
    <TvDesignFrame marker="data-showcase">
      <div style={{
        width: '100%',
        height: '100%',
        background: BG,
        color: TEXT,
        fontFamily: FONT,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {children}
      </div>
    </TvDesignFrame>
  );
}

function StatusScreen({ title, detail }) {
  return (
    <Shell>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <img src="/skyway-logo-nav-reverse.png" alt="Skyway" style={{ height: 42 }} />
        <div style={{ fontSize: 40, fontWeight: 650 }}>{title}</div>
        {detail && <div style={{ fontSize: 16, color: MUTED }}>{detail}</div>}
      </div>
    </Shell>
  );
}

export default function ShowcasePage({ token = '' }) {
  const [phase, setPhase] = useState('loading');
  const [payload, setPayload] = useState(null);
  const rootRef = useRef(null);
  const mapRef = useRef(null);
  const settledRef = useRef(null);
  const liveRef = useRef(null);

  useEffect(() => {
    document.documentElement.style.background = BG;
    document.body.style.background = BG;
    let dead = false;
    const params = new URLSearchParams(window.location.search);
    (async () => {
      if (import.meta.env.DEV && window.__SHOWCASE_PAYLOAD__?.legs) {
        if (!dead) {
          setPayload(window.__SHOWCASE_PAYLOAD__);
          setPhase('ready');
        }
        return;
      }
      if (import.meta.env.DEV && params.get('fixture') === '1') {
        const mod = await import('./showcase-demo.js');
        if (!dead) {
          setPayload(mod.demoShowcasePayload(Date.now()));
          setPhase('ready');
        }
        return;
      }
      if (!isShowcaseToken(token)) {
        if (!dead) setPhase('missing');
        return;
      }
      try {
        const res = await fetch(`/api/showcase-replay?token=${encodeURIComponent(token)}`);
        if (dead) return;
        if (res.status === 404) {
          setPhase('missing');
          return;
        }
        if (!res.ok) {
          setPhase('error');
          return;
        }
        const body = await res.json();
        if (!body || !Array.isArray(body.legs)) {
          setPhase('error');
          return;
        }
        setPayload(body);
        setPhase('ready');
      } catch {
        if (!dead) setPhase('error');
      }
    })();
    return () => { dead = true; };
  }, [token]);

  useEffect(() => {
    if (phase === 'loading') document.title = 'Moving with Skyway';
    else if (phase === 'missing') document.title = 'Not found';
    else document.title = `Moving with Skyway — ${payload?.year || ''}`.trim();
  }, [phase, payload]);

  useEffect(() => {
    if (phase !== 'ready' || !payload || !rootRef.current) return undefined;
    const root = rootRef.current;
    const mapNode = mapRef.current;
    const settledCanvas = settledRef.current;
    const liveCanvas = liveRef.current;
    let dead = false;
    let map = null;
    let raf = 0;
    let project = null;
    let projected = [];
    let drawn = new Set();
    let resetSettled = true;
    let lastLoop = -1;
    const shown = { flights: 0, nm: 0, sm: 0, hours: 0, airports: 0, states: 0, countries: 0 };
    let listSig = '';

    const span = playbackWindow(payload);
    const scheduled = scheduleShowcasePlayback(publicLegs(payload.legs), span).map((leg, index) => {
      const ends = legEndpoints(leg);
      return { ...leg, id: index, samples: sampleRoute(ends.from, ends.to) };
    });
    const note = root.querySelector('[data-showcase-note]');
    if (note) {
      if (!scheduled.length) {
        note.textContent = `No completed flights stored for ${payload.year} yet.`;
      } else if (span.abbreviated && payload.storedFrom) {
        const from = formatShowcaseDate(Date.parse(payload.storedFrom));
        note.textContent = `Recorded flights begin ${from.day}. Earlier ${payload.year} legs were not stored.`;
      } else {
        note.textContent = 'Completed flights, year to date';
      }
    }

    const dev = import.meta.env.DEV;
    const params = dev ? new URLSearchParams(window.location.search) : new URLSearchParams();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    const freeze = reduced || (dev && params.get('freeze') === '1');
    const speed = dev ? Math.max(0.25, Math.min(40, Number(params.get('speed')) || 1)) : 1;
    let elapsed = initialPlayMs({ at: dev ? params.get('at') : null, reducedMotion: reduced });
    let lastTick = performance.now();

    const counts = {};
    root.querySelectorAll('[data-count]').forEach((node) => { counts[node.dataset.count] = node; });

    function syncLists(snapshot) {
      const sig = `${snapshot.flights}|${snapshot.topDestinations.map((row) => row.label).join()}|${snapshot.topRoutes.map((row) => row.label).join()}|${snapshot.tails.map((row) => row.tail).join()}`;
      if (sig === listSig) return;
      listSig = sig;
      const write = (prefix, rows) => {
        for (let i = 0; i < 5; i += 1) {
          const label = root.querySelector(`[data-rank="${prefix}-label-${i}"]`);
          const count = root.querySelector(`[data-rank="${prefix}-count-${i}"]`);
          if (!label || !count) continue;
          label.textContent = rows[i]?.label || '—';
          count.textContent = rows[i] ? formatShowcaseCount(rows[i].count) : '';
        }
      };
      write('dest', snapshot.topDestinations);
      write('route', snapshot.topRoutes);
      const fleet = root.querySelector('[data-showcase-fleet]');
      if (fleet) {
        fleet.replaceChildren(...snapshot.tails.map((row) => {
          const item = document.createElement('span');
          item.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:650;letter-spacing:0.04em';
          const swatch = document.createElement('span');
          swatch.style.cssText = `width:8px;height:8px;border-radius:99px;background:${row.color}`;
          item.append(swatch, document.createTextNode(row.tail));
          return item;
        }));
      }
    }

    function paint(playMs) {
      const width = mapNode.clientWidth || 1920;
      const height = mapNode.clientHeight || 1080;
      const resized = settledCanvas.width !== Math.floor(width * 2) || settledCanvas.height !== Math.floor(height * 2);
      const settledCtx = sizeCanvas(settledCanvas, width, height);
      const liveCtx = sizeCanvas(liveCanvas, width, height);
      if (resized) resetSettled = true;
      if (!project) return;
      if (projected.length !== scheduled.length || resetSettled) {
        projected = scheduled.map((leg) => leg.samples.map((sample) => project(sample.lat, sample.lng)));
        settledCtx.clearRect(0, 0, width, height);
        drawn = new Set();
        resetSettled = false;
      }
      const actors = frameActors(scheduled, playMs);
      for (const leg of actors.finished) {
        if (drawn.has(leg.id)) continue;
        const points = projected[leg.id];
        strokeChain(settledCtx, points, 0, points.length - 1, showcaseTailColor(leg.tail), 1.7, 0.34);
        drawn.add(leg.id);
      }
      liveCtx.clearRect(0, 0, width, height);
      for (const leg of actors.active) {
        const points = projected[leg.id];
        if (!points) continue;
        const along = pointAlong(leg.samples, leg.f);
        const head = Math.max(1, Math.round(leg.f * (points.length - 1)));
        const glowFrom = Math.max(0, head - Math.ceil(points.length * 0.22));
        const color = showcaseTailColor(leg.tail);
        strokeChain(liveCtx, points, 0, head, color, 1.5, 0.28);
        strokeChain(liveCtx, points, glowFrom, head, color, 5, 0.22);
        strokeChain(liveCtx, points, glowFrom, head, '#f4fffd', 2.1, 0.95);
        const at = project(along.lat, along.lng);
        drawPlane(liveCtx, at.x, at.y, along.heading, color);
      }

      const snapshot = showcaseSnapshot(scheduled, playMs, placeForAirport, span);
      const ease = (key, target) => {
        if (playMs < lastLoop) shown[key] = 0;
        const rate = freeze || speed > 1 ? 0.55 : 0.18;
        const next = freeze || Math.abs(target - shown[key]) < 0.6
          ? target
          : shown[key] + (target - shown[key]) * rate;
        shown[key] = next;
        return next;
      };
      if (counts.flights) counts.flights.textContent = formatShowcaseCount(Math.round(ease('flights', snapshot.flights)));
      if (counts.nm) counts.nm.textContent = formatShowcaseCount(Math.round(ease('nm', snapshot.nm)));
      if (counts.sm) counts.sm.textContent = `${formatShowcaseCount(Math.round(ease('sm', snapshot.sm)))} statute mi`;
      if (counts.hours) counts.hours.textContent = formatShowcaseCount(ease('hours', snapshot.hours), snapshot.hours >= 100 ? 0 : 1);
      if (counts.airports) counts.airports.textContent = formatShowcaseCount(Math.round(ease('airports', snapshot.airports)));
      if (counts.places) {
        const states = Math.round(ease('states', snapshot.states));
        const countries = Math.round(ease('countries', snapshot.countries));
        counts.places.textContent = `${formatShowcaseCount(states)}  /  ${formatShowcaseCount(countries)}`;
      }
      const date = formatShowcaseDate(snapshot.dateMs);
      const dateNode = root.querySelector('[data-showcase-date]');
      const yearNode = root.querySelector('[data-showcase-year]');
      const holdNode = root.querySelector('[data-showcase-hold]');
      const bar = root.querySelector('[data-showcase-progress]');
      if (dateNode) dateNode.textContent = date.day;
      if (yearNode) yearNode.textContent = date.year;
      if (holdNode) holdNode.style.opacity = snapshot.holding ? '1' : '0';
      if (bar) {
        const p = snapshot.holding ? 1 : Math.max(0, Math.min(1, playMs / SHOWCASE_PLAY_MS));
        bar.style.width = `${(p * 100).toFixed(2)}%`;
      }
      syncLists(snapshot);
      root.setAttribute('data-showcase-ready', '1');
      root.setAttribute('data-showcase-phase', snapshot.holding ? 'hold' : 'play');
      root.setAttribute('data-showcase-flights', String(snapshot.flights));
      root.setAttribute('data-showcase-active', String(snapshot.active));
    }

    function loop(now) {
      if (dead) return;
      const dt = Math.min(40, now - lastTick);
      lastTick = now;
      if (!freeze) elapsed += dt * speed;
      const playMs = elapsed % SHOWCASE_LOOP_MS;
      if (lastLoop >= 0 && playMs < lastLoop) {
        resetSettled = true;
        shown.flights = 0;
        shown.nm = 0;
        shown.sm = 0;
        shown.hours = 0;
        shown.airports = 0;
        shown.states = 0;
        shown.countries = 0;
        listSig = '';
      }
      paint(playMs);
      lastLoop = playMs;
      if (!freeze) raf = requestAnimationFrame(loop);
    }

    function arm(projectFn) {
      project = projectFn;
      projected = [];
      resetSettled = true;
      raf = requestAnimationFrame(loop);
    }

    (async () => {
      const points = scheduled.flatMap((leg) => leg.samples);
      const fallback = () => {
        const projector = fitProject(
          points.length ? points : [{ lat: 39, lng: -96 }],
          mapNode.clientWidth || 1920,
          mapNode.clientHeight || 1080,
        );
        arm(projector);
      };
      try {
        const L = await loadLeaflet();
        if (dead) return;
        map = L.map(mapNode, {
          zoomControl: false,
          attributionControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          boxZoom: false,
          keyboard: false,
          tap: false,
          zoomSnap: 0.25,
        });
        map.getContainer().style.background = BG;
        applyBasemap(L, map, 'dark', 'dark');
        const pairs = scheduled.flatMap((leg) => [[leg.fromLat, leg.fromLng], [leg.toLat, leg.toLng]]);
        const bounds = pairs.length ? L.latLngBounds(pairs) : null;
        if (bounds?.isValid()) {
          map.fitBounds(bounds, {
            paddingTopLeft: [48, 108],
            paddingBottomRight: [420, 150],
            maxZoom: 6,
            animate: false,
          });
        } else {
          map.setView([37.5, -96], 4);
        }
        map.invalidateSize();
        const onMove = () => { resetSettled = true; };
        map.on('move zoom resize', onMove);
        arm((lat, lng) => {
          const point = map.latLngToContainerPoint([lat, lng]);
          return { x: point.x, y: point.y };
        });
      } catch (error) {
        console.warn('[showcase] basemap unavailable', error?.message || error);
        if (!dead) fallback();
      }
    })();

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      if (map) {
        try { map.remove(); } catch { /* already gone */ }
      }
    };
  }, [phase, payload]);

  if (phase === 'missing') return <StatusScreen title="Not found" />;
  if (phase === 'error') return <StatusScreen title="The board could not load" detail="The replay will try again on the next refresh." />;
  if (phase !== 'ready' || !payload) return <StatusScreen title="Loading the year" />;

  return (
    <Shell>
      <div
        ref={rootRef}
        data-showcase-board=""
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: BG }}
      >
        <div ref={mapRef} className="showcase-map" style={{ position: 'absolute', inset: 0 }} />
        <canvas ref={settledRef} style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }} />
        <canvas ref={liveRef} style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }} />

        <header style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 5,
          height: 92,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '0 28px 12px',
          background: 'linear-gradient(180deg, rgba(6,10,16,0.94) 0%, rgba(6,10,16,0.72) 62%, rgba(6,10,16,0) 100%)',
        }}>
          <img
            src="/skyway-logo-nav-reverse.png"
            srcSet="/skyway-logo-nav-reverse.png 1x, /skyway-logo-nav-reverse@2x.png 2x"
            alt="Skyway"
            style={{ height: 40, width: 'auto' }}
          />
          <div style={{ width: 1, height: 36, background: LINE }} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 34, fontWeight: 650, letterSpacing: '-0.02em', lineHeight: '38px' }}>
              {`Moving with Skyway — ${payload.year}`}
            </h1>
            <div data-showcase-note="" style={{ marginTop: 4, fontSize: 15, color: MUTED }} />
          </div>
          <div style={{ marginLeft: 'auto', minWidth: 220, textAlign: 'right' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 10 }}>
              <div data-showcase-date="" style={{ fontSize: 36, fontWeight: 650, letterSpacing: '0.08em', lineHeight: '38px' }} />
              <div data-showcase-year="" style={{ fontSize: 16, color: MUTED }} />
            </div>
            <div data-showcase-hold="" style={{ height: 16, fontSize: 11, fontWeight: 650, letterSpacing: '0.16em', color: '#5eead4', opacity: 0 }}>
              YEAR TO DATE
            </div>
            <div style={{ marginLeft: 'auto', width: 220, height: 3, borderRadius: 99, background: 'rgba(231,238,243,0.12)' }}>
              <div data-showcase-progress="" style={{ height: '100%', width: 0, borderRadius: 99, background: '#5eead4' }} />
            </div>
          </div>
        </header>

        <aside style={{
          position: 'absolute',
          top: 100,
          right: 20,
          bottom: 132,
          width: 372,
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          padding: '18px 18px 16px',
          borderRadius: 18,
          background: 'rgba(8, 14, 22, 0.9)',
          border: `1px solid ${LINE}`,
          boxShadow: '-20px 0 48px rgba(0,0,0,0.28)',
          backdropFilter: 'blur(16px)',
        }}>
          <RankSlots title="TOP DESTINATIONS" prefix="dest" />
          <div style={{ height: 1, background: LINE }} />
          <RankSlots title="TOP ROUTES" prefix="route" />
          <div style={{ marginTop: 'auto' }}>
            <div style={{ fontSize: 12, fontWeight: 650, letterSpacing: '0.16em', color: MUTED }}>TAILS</div>
            <div data-showcase-fleet="" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }} />
          </div>
        </aside>

        <footer style={{
          position: 'absolute',
          left: 20,
          right: 412,
          bottom: 16,
          zIndex: 5,
          display: 'flex',
          gap: 10,
        }}>
          <Counter label="FLIGHTS" count="flights" />
          <Counter label="NAUTICAL MILES" count="nm" hint="sm" />
          <Counter label="FLIGHT HOURS" count="hours" />
          <Counter label="AIRPORTS SERVED" count="airports" />
          <Counter label="STATES / COUNTRIES" count="places" />
        </footer>
        <div style={{ position: 'absolute', left: 24, bottom: 4, zIndex: 5, fontSize: 10, color: 'rgba(231,238,243,0.38)' }}>
          Map data © Esri
        </div>
      </div>
    </Shell>
  );
}

