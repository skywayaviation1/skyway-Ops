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
  drawRipples,
  drawSettledRoute,
  drawSparkles,
  drawStars,
  drawWave,
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
  legEndpoints,
  playbackWindow,
  pointAlong,
  sampleRoute,
  scheduleShowcasePlayback,
  showcaseColorKey,
  showcaseSnapshot,
  showcaseTailColor,
} from './showcase-replay.js';

const BG = '#060a10';
const LINE = 'rgba(186, 214, 224, 0.22)';
const TEXT = '#f4fbff';
const MUTED = 'rgba(231, 238, 243, 0.72)';
const FONT = "'DM Sans', system-ui, sans-serif";
const DISPLAY = "'Bebas Neue', 'Arial Narrow', Impact, sans-serif";

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
  const padL = 72;
  const padT = 128;
  const padR = 72;
  const padB = 176;
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

function Counter({ label, count, hint, hero = false }) {
  return (
    <div style={{
      flex: hero ? 1.35 : 1,
      minWidth: 0,
      padding: '14px 22px 12px',
      borderRadius: 18,
      background: 'rgba(8, 14, 22, 0.82)',
      border: hero ? '1px solid rgba(253, 230, 138, 0.45)' : `1px solid ${LINE}`,
    }}>
      <div style={{
        fontFamily: DISPLAY,
        fontSize: hero ? 22 : 18,
        letterSpacing: '0.16em',
        color: hero ? '#fde68a' : '#99f6e4',
        lineHeight: '22px',
      }}>{label}</div>
      <div data-count={count} style={{
        marginTop: 4,
        fontFamily: DISPLAY,
        fontSize: hero ? 72 : 52,
        lineHeight: hero ? '72px' : '52px',
        letterSpacing: '0.02em',
        color: hero ? '#fff7d6' : TEXT,
      }}>0</div>
      {hint && <div data-count={hint} style={{ marginTop: 0, fontSize: 15, color: MUTED, fontVariantNumeric: 'tabular-nums' }} />}
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
        <style>{`
          @keyframes showcase-twilight {
            0% { opacity: 0.55; }
            50% { opacity: 0.85; }
            100% { opacity: 0.55; }
          }
          .showcase-sky {
            animation: showcase-twilight 10s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .showcase-sky { animation: none; }
          }
        `}</style>
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
        <div style={{ fontFamily: DISPLAY, fontSize: 72, letterSpacing: '0.04em' }}>{title}</div>
        {detail && <div style={{ fontSize: 22, color: MUTED }}>{detail}</div>}
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
    let waveCursor = 0;
    const waveLit = new Set();
    let resetSettled = true;
    let lastLoop = -1;
    const shown = { flights: 0, nm: 0, sm: 0, block: 0, airports: 0 };
    const velocity = { flights: 0, nm: 0, sm: 0, block: 0, airports: 0 };
    const ripples = [];
    const pops = new Map();
    const pose = new Map();
    let landingsPrimed = false;
    const seenLandings = new Set();

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
      waveCursor = 0;
      waveLit.clear();
      shown.airports = 0;
      for (const key of Object.keys(velocity)) velocity[key] = 0;
      ripples.length = 0;
      pops.clear();
      pose.clear();
      landingsPrimed = false;
      seenLandings.clear();
    }

    function paint(playMs, now) {
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
        waveLit.clear();
        waveCursor = 0;
        resetSettled = false;
      }
      const actors = frameActors(scheduled, playMs);
      let settledBudget = freeze ? actors.finished.length : 100;
      for (const leg of actors.finished) {
        if (drawn.has(leg.id)) continue;
        if (settledBudget <= 0) break;
        drawSettledRoute(settledCtx, projected[leg.id], showcaseColorKey(leg));
        drawn.add(leg.id);
        settledBudget -= 1;
      }
      if (!landingsPrimed) {
        for (const leg of actors.finished) seenLandings.add(leg.id);
        landingsPrimed = true;
      } else {
        for (const leg of actors.finished) {
          if (seenLandings.has(leg.id)) continue;
          seenLandings.add(leg.id);
          const at = project(leg.toLat, leg.toLng);
          ripples.push({
            x: at.x,
            y: at.y,
            born: now,
            color: showcaseTailColor(showcaseColorKey(leg)),
            code: leg.to,
          });
          pops.set(leg.to, now);
          if (ripples.length > 8) ripples.shift();
        }
      }

      liveCtx.clearRect(0, 0, width, height);
      drawStars(liveCtx, width, height, now);
      const holding = playMs >= SHOWCASE_PLAY_MS;
      const holdT = holding ? playMs - SHOWCASE_PLAY_MS : 0;
      if (holding && scheduled.length <= 700) {
        drawWave(liveCtx, projected, scheduled, holdT, SHOWCASE_HOLD_MS);
      } else if (holding) {
        const travel = Math.max(0, Math.min(1, holdT / (SHOWCASE_HOLD_MS * 0.52)));
        const total = scheduled.length;
        let stamped = 0;
        for (let step = 0; step < total && stamped < 240; step += 1) {
          const index = (waveCursor + step) % total;
          if (waveLit.has(index)) continue;
          const delay = ((index % 19) / 19) * 0.16;
          const local = Math.max(0, Math.min(1, (travel - delay) / 0.84));
          if (local < 0.92) continue;
          const points = projected[index];
          if (points) drawSettledRoute(settledCtx, points, showcaseColorKey(scheduled[index]));
          waveLit.add(index);
          stamped += 1;
        }
        if (total) waveCursor = (waveCursor + 240) % total;
      }

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
      drawAirports(liveCtx, visits.values(), now, pops, dense);
      drawRipples(liveCtx, ripples, now);

      for (const leg of actors.active) {
        const points = projected[leg.id];
        if (!points) continue;
        const along = pointAlong(leg.samples, leg.f);
        const head = Math.max(1, Math.round(leg.f * (points.length - 1)));
        drawLiveRoute(liveCtx, points, head, showcaseColorKey(leg), dense);
        if (!dense) drawSparkles(liveCtx, points, head, now);
        const at = project(along.lat, along.lng);
        const targetBank = turnBank(leg.samples, leg.f);
        const prev = pose.get(leg.id) || { bank: targetBank };
        const bank = prev.bank + (targetBank - prev.bank) * (freeze ? 1 : 0.35);
        pose.set(leg.id, { bank });
        drawPlane(liveCtx, at.x, at.y, along.heading, bank, showcaseTailColor(showcaseColorKey(leg)), dense);
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
        finale.style.transform = `translateY(${(1 - finaleT) * 18}px)`;
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
      if (!freeze) elapsed += dt * speed;
      const playMs = elapsed % SHOWCASE_LOOP_MS;
      if (lastLoop >= 0 && playMs < lastLoop) resetLoop();
      paint(playMs, now);
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
            paddingTopLeft: [72, 120],
            paddingBottomRight: [72, 168],
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
          className="showcase-sky"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            background: 'radial-gradient(900px 280px at 18% -10%, rgba(94, 234, 212, 0.12), transparent 70%), linear-gradient(180deg, rgba(12, 18, 32, 0.45) 0%, rgba(6, 10, 16, 0) 22%)',
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
          height: 108,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '0 28px 8px',
          background: 'linear-gradient(180deg, rgba(6,10,16,0.94) 0%, rgba(6,10,16,0.55) 70%, rgba(6,10,16,0) 100%)',
        }}>
          <img
            src="/skyway-logo-nav-reverse.png"
            srcSet="/skyway-logo-nav-reverse.png 1x, /skyway-logo-nav-reverse@2x.png 2x"
            alt="Skyway"
            style={{ height: 48, width: 'auto' }}
          />
          <div style={{ width: 1, height: 46, background: LINE }} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontFamily: DISPLAY, fontSize: 64, fontWeight: 400, letterSpacing: '0.04em', lineHeight: '60px' }}>
              {`Moving with Skyway — ${payload.year}`}
            </h1>
            <div data-showcase-note="" style={{ marginTop: 2, fontSize: 18, color: MUTED }} />
          </div>
          <div style={{ marginLeft: 'auto', minWidth: 280, textAlign: 'right' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 12 }}>
              <div data-showcase-date="" style={{ fontFamily: DISPLAY, fontSize: 52, letterSpacing: '0.06em', lineHeight: '52px' }} />
              <div data-showcase-year="" style={{ fontSize: 20, color: MUTED }} />
            </div>
            <div data-showcase-hold="" style={{ height: 22, fontFamily: DISPLAY, fontSize: 22, letterSpacing: '0.16em', color: '#5eead4', opacity: 0 }}>
              YEAR TO DATE
            </div>
            <div style={{ marginLeft: 'auto', width: 260, height: 5, borderRadius: 99, background: 'rgba(231,238,243,0.14)' }}>
              <div data-showcase-progress="" style={{ height: '100%', width: 0, borderRadius: 99, background: 'linear-gradient(90deg, #5eead4, #fde68a)' }} />
            </div>
          </div>
        </header>

        <div
          data-showcase-finale=""
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 196,
            zIndex: 6,
            textAlign: 'center',
            pointerEvents: 'none',
            opacity: 0,
          }}
        >
          <div style={{
            display: 'inline-block',
            padding: '8px 40px 14px',
            borderRadius: 24,
            background: 'rgba(6, 10, 16, 0.78)',
            border: '1px solid rgba(186, 214, 224, 0.28)',
          }}>
            <div style={{ fontFamily: DISPLAY, fontSize: 92, lineHeight: '88px', letterSpacing: '0.06em', color: '#ffffff' }}>
              Fly with Skyway
            </div>
            <div style={{ marginTop: 2, fontSize: 22, fontWeight: 600, letterSpacing: '0.08em', color: '#99f6e4' }}>
              THE WHOLE YEAR, ONE LOOP
            </div>
          </div>
        </div>

        <footer style={{
          position: 'absolute',
          left: 28,
          right: 28,
          bottom: 24,
          zIndex: 5,
          display: 'flex',
          gap: 14,
        }}>
          <Counter label="BLOCK HOURS" count="block" hero />
          <Counter label="FLIGHTS" count="flights" />
          <Counter label="NAUTICAL MILES" count="nm" hint="sm" />
          <Counter label="AIRPORTS" count="airports" />
        </footer>
        <div style={{ position: 'absolute', right: 32, bottom: 6, zIndex: 5, fontSize: 11, color: 'rgba(231,238,243,0.4)' }}>
          Map data © Esri
        </div>
      </div>
    </Shell>
  );
}
