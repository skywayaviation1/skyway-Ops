// Full-screen trade-show replay. No sign-in. The token in the path is
// checked by /api/showcase-replay; a miss renders not found.
//
// Aircraft, trails, landings, and the finale are canvas strokes on top of
// the shared dark basemap. The loop is a fixed 1920×1080 frame, scaled by
// the same ratio as the office TV.

import React, { useEffect, useRef, useState } from 'react';
import TvDesignFrame from './TvDesignFrame.jsx';
import { applyBasemap, loadLeaflet } from './tracking-map.js';
import {
  drawAirports,
  drawLiveRoute,
  drawPlane,
  drawSettledRoute,
} from './showcase-draw.js';
import {
  PUBLIC_LEG_KEYS,
  SHOWCASE_HOLD_MS,
  SHOWCASE_LOOP_MS,
  SHOWCASE_PLAY_MS,
  formatShowcaseCount,
  formatShowcaseDate,
  frameActors,
  initialPlayMs,
  isShowcaseToken,
  normalizeShowcaseToken,
  legEndpoints,
  playbackWindow,
  pointAlong,
  sampleRoute,
  scheduleShowcasePlayback,
  showcaseSnapshot,
} from './showcase-replay.js';

const BG = '#070c14';
const LINE = 'rgba(214, 226, 234, 0.14)';
const TEXT = '#f4f7fa';
const MUTED = 'rgba(214, 226, 234, 0.62)';
const ACCENT = '#3FA9CC';
const FONT = "'Inter', 'DM Sans', system-ui, sans-serif";

function publicLegs(legs) {
  const out = [];
  for (const raw of legs || []) {
    const leg = {};
    let ok = true;
    for (const key of PUBLIC_LEG_KEYS) {
      if (key === 'tail') {
        leg.tail = raw?.tail ? String(raw.tail) : '';
        continue;
      }
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
  const padL = 64;
  const padT = 112;
  const padR = 64;
  const padB = 168;
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

function turnBank(samples, fraction) {
  const behind = pointAlong(samples, Math.max(0, fraction - 0.08));
  const ahead = pointAlong(samples, Math.min(1, fraction + 0.08));
  let turn = ahead.heading - behind.heading;
  while (turn > 180) turn -= 360;
  while (turn < -180) turn += 360;
  return Math.max(-32, Math.min(32, turn * 0.5));
}

function Stat({ label, count, hint, hero = false, rule = false }) {
  return (
    <div style={{
      flex: hero ? 1.45 : 1,
      minWidth: 0,
      padding: hero ? '4px 36px 2px 8px' : '4px 28px 2px',
      borderLeft: rule ? `1px solid ${LINE}` : 'none',
    }}>
      <div style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: hero ? ACCENT : MUTED,
        lineHeight: '16px',
      }}>{label}</div>
      <div data-count={count} style={{
        marginTop: 8,
        fontSize: hero ? 76 : 44,
        fontWeight: 500,
        lineHeight: hero ? '76px' : '46px',
        letterSpacing: '-0.03em',
        color: TEXT,
      }}>0</div>
      {hint && (
        <div data-count={hint} style={{ marginTop: 2, fontSize: 14, fontWeight: 500, color: MUTED }} />
      )}
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
        <img src="/skyway-logo-nav-reverse.png" alt="Skyway" style={{ height: 48 }} />
        <div style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.02em' }}>{title}</div>
        {detail && <div style={{ fontSize: 18, color: MUTED }}>{detail}</div>}
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
      const presented = normalizeShowcaseToken(token);
      if (!isShowcaseToken(presented)) {
        if (!dead) setPhase('missing');
        return;
      }
      try {
        const res = await fetch(`/api/showcase-replay?token=${encodeURIComponent(presented)}`);
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
    const shown = { flights: 0, nm: 0, sm: 0, block: 0, airports: 0 };
    const velocity = { flights: 0, nm: 0, sm: 0, block: 0, airports: 0 };
    const pose = new Map();

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
        note.textContent = 'Every completed flight since January 1';
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

    function resetLoop() {
      resetSettled = true;
      shown.flights = 0;
      shown.nm = 0;
      shown.sm = 0;
      shown.block = 0;
      shown.airports = 0;
      for (const key of Object.keys(velocity)) velocity[key] = 0;
      pose.clear();
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
      let settledBudget = freeze ? actors.finished.length : 100;
      for (const leg of actors.finished) {
        if (drawn.has(leg.id)) continue;
        if (settledBudget <= 0) break;
        drawSettledRoute(settledCtx, projected[leg.id]);
        drawn.add(leg.id);
        settledBudget -= 1;
      }

      liveCtx.clearRect(0, 0, width, height);
      const holding = playMs >= SHOWCASE_PLAY_MS;
      const holdT = holding ? playMs - SHOWCASE_PLAY_MS : 0;

      const visits = new Map();
      for (const leg of actors.finished) {
        for (const end of [['from', 'fromLat', 'fromLng'], ['to', 'toLat', 'toLng']]) {
          const code = leg[end[0]];
          if (!code) continue;
          const row = visits.get(code);
          if (row) row.n += 1;
          else {
            const at = project(leg[end[1]], leg[end[2]]);
            visits.set(code, { code, x: at.x, y: at.y, n: 1 });
          }
        }
      }
      const dense = actors.active.length > 40;
      drawAirports(liveCtx, visits.values());

      for (const leg of actors.active) {
        const points = projected[leg.id];
        if (!points) continue;
        const along = pointAlong(leg.samples, leg.f);
        const head = Math.max(1, Math.round(leg.f * (points.length - 1)));
        drawLiveRoute(liveCtx, points, head, dense);
        const at = project(along.lat, along.lng);
        const targetBank = turnBank(leg.samples, leg.f);
        const prev = pose.get(leg.id) || { bank: targetBank };
        const bank = prev.bank + (targetBank - prev.bank) * (freeze ? 1 : 0.35);
        pose.set(leg.id, { bank });
        drawPlane(liveCtx, at.x, at.y, along.heading, bank);
      }

      const snapshot = showcaseSnapshot(scheduled, playMs, span);
      const ease = (key, target) => {
        if (playMs < lastLoop) shown[key] = 0;
        if (freeze || Math.abs(target - shown[key]) < 0.45) {
          shown[key] = target;
          velocity[key] = 0;
          return target;
        }
        if (speed > 1) {
          shown[key] += (target - shown[key]) * 0.62;
          return shown[key];
        }
        velocity[key] = velocity[key] * 0.7 + (target - shown[key]) * 0.18;
        shown[key] += velocity[key];
        return shown[key];
      };
      const writeCount = (key, text) => {
        const node = counts[key];
        if (!node) return;
        node.textContent = text;
      };
      writeCount('flights', formatShowcaseCount(Math.round(ease('flights', snapshot.flights))));
      writeCount('nm', formatShowcaseCount(Math.round(ease('nm', snapshot.nm))));
      if (counts.sm) counts.sm.textContent = `${formatShowcaseCount(Math.round(ease('sm', snapshot.sm)))} statute mi`;
      writeCount('block', formatShowcaseCount(ease('block', snapshot.hours), 1));
      writeCount('airports', formatShowcaseCount(Math.round(ease('airports', snapshot.airports))));
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
      const finaleT = holding ? Math.max(0, Math.min(1, (holdT - SHOWCASE_HOLD_MS * 0.42) / 1600)) : 0;
      const finale = root.querySelector('[data-showcase-finale]');
      if (finale) {
        finale.style.opacity = String(finaleT);
        finale.style.transform = `translateY(${(1 - finaleT) * 8}px)`;
      }
      root.setAttribute('data-showcase-ready', '1');
      root.setAttribute('data-showcase-phase', snapshot.holding ? 'hold' : 'play');
      root.setAttribute('data-showcase-flights', String(snapshot.flights));
      root.setAttribute('data-showcase-block', snapshot.hours.toFixed(1));
      root.setAttribute('data-showcase-active', String(snapshot.active));
      root.setAttribute('data-showcase-finale', finaleT > 0.85 ? '1' : '0');
    }

    function loop(now) {
      if (dead) return;
      const gap = Math.max(0, now - lastTick);
      const dt = speed > 1 ? Math.min(gap, 3000 / speed) : Math.min(40, gap);
      lastTick = now;
      // Dev captures can pin the playhead once the finale is up. The booth never sets this.
      if (!(freeze || (dev && window.__SHOWCASE_FREEZE__))) elapsed += dt * speed;
      const playMs = elapsed % SHOWCASE_LOOP_MS;
      if (lastLoop >= 0 && playMs < lastLoop) resetLoop();
      paint(playMs);
      lastLoop = playMs;
      raf = requestAnimationFrame(loop);
    }

    function arm(projectFn) {
      project = projectFn;
      projected = [];
      resetSettled = true;
      raf = requestAnimationFrame(loop);
    }

    (async () => {
      const fallback = () => {
        const points = scheduled.flatMap((leg) => leg.samples);
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
        map.getContainer().style.zIndex = '0';
        applyBasemap(L, map, 'dark', 'dark');
        const pairs = scheduled.flatMap((leg) => [[leg.fromLat, leg.fromLng], [leg.toLat, leg.toLng]]);
        const bounds = pairs.length ? L.latLngBounds(pairs) : null;
        if (bounds?.isValid()) {
          map.fitBounds(bounds, {
            paddingTopLeft: [64, 104],
            paddingBottomRight: [64, 156],
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
        <div ref={mapRef} className="showcase-map" style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(7,12,20,0.72) 0%, rgba(7,14,24,0.28) 16%, rgba(7,14,24,0.12) 72%, rgba(7,12,20,0.78) 100%)',
          }}
        />
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
          gap: 22,
          padding: '0 36px',
        }}>
          <img
            src="/skyway-logo-nav-reverse.png"
            srcSet="/skyway-logo-nav-reverse.png 1x, /skyway-logo-nav-reverse@2x.png 2x"
            alt="Skyway"
            style={{ height: 36, width: 'auto' }}
          />
          <div style={{ width: 1, height: 32, background: LINE }} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: '36px' }}>
              Moving with Skyway
              <span style={{ marginLeft: 14, fontWeight: 400, color: MUTED }}>{payload.year}</span>
            </h1>
            <div data-showcase-note="" style={{ marginTop: 4, fontSize: 15, fontWeight: 400, color: MUTED }} />
          </div>
          <div style={{ marginLeft: 'auto', width: 220, textAlign: 'right' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 8 }}>
              <div data-showcase-date="" style={{ fontSize: 18, fontWeight: 500, letterSpacing: '0.04em' }} />
              <div data-showcase-year="" style={{ fontSize: 14, color: MUTED }} />
            </div>
            <div data-showcase-hold="" style={{ height: 16, marginTop: 2, fontSize: 11, fontWeight: 600, letterSpacing: '0.16em', color: ACCENT, opacity: 0 }}>
              YEAR TO DATE
            </div>
            <div style={{ marginLeft: 'auto', marginTop: 8, width: 160, height: 2, borderRadius: 99, background: 'rgba(214,226,234,0.16)' }}>
              <div data-showcase-progress="" style={{ height: '100%', width: 0, borderRadius: 99, background: ACCENT }} />
            </div>
          </div>
        </header>

        <div
          data-showcase-finale=""
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 168,
            zIndex: 6,
            textAlign: 'center',
            pointerEvents: 'none',
            opacity: 0,
          }}
        >
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 16,
            padding: '12px 22px',
            borderRadius: 14,
            background: 'rgba(8, 14, 22, 0.82)',
            border: `1px solid ${LINE}`,
          }}>
            <img
              src="/skyway-logo-nav-reverse.png"
              srcSet="/skyway-logo-nav-reverse.png 1x, /skyway-logo-nav-reverse@2x.png 2x"
              alt=""
              style={{ height: 28, width: 'auto' }}
            />
            <div style={{ width: 1, height: 24, background: LINE }} />
            <div style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em', color: TEXT }}>
              Fly with Skyway
            </div>
          </div>
        </div>

        <footer style={{
          position: 'absolute',
          left: 28,
          right: 28,
          bottom: 22,
          zIndex: 5,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'stretch',
            padding: '16px 20px 14px',
            borderRadius: 16,
            background: 'rgba(8, 14, 22, 0.78)',
            border: `1px solid ${LINE}`,
          }}>
            <Stat label="Block hours" count="block" hero />
            <Stat label="Flights" count="flights" rule />
            <Stat label="Nautical miles" count="nm" hint="sm" rule />
            <Stat label="Airports" count="airports" rule />
          </div>
        </footer>
        <div style={{ position: 'absolute', right: 40, bottom: 6, zIndex: 5, fontSize: 11, letterSpacing: '0.02em', color: 'rgba(214,226,234,0.38)' }}>
          Map data © Esri
        </div>
      </div>
    </Shell>
  );
}
