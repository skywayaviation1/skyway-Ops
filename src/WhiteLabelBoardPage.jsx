// Public white-label operations wall. No sign-in. The token in the path is
// the only credential, and every fact on screen comes from /api/white-label-board.

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useWhiteLabelLogo } from './use-white-label-logo.js';

const FlightBoardLazy = lazy(() => import('./FlightBoard.jsx'));
const NO_AIRCRAFT = {};

function tokenOk(token) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(token || ''));
}

export default function WhiteLabelBoardPage({ token }) {
  const valid = tokenOk(token);
  const [payload, setPayload] = useState(null);
  const [missing, setMissing] = useState(!valid);
  const seen = useRef(false);
  const logoUrl = useWhiteLabelLogo(token, Boolean(valid && payload?.hasLogo));

  useEffect(() => {
    if (!valid) return undefined;
    let cancelled = false;
    let robots = document.querySelector('meta[name="robots"]');
    const createdRobots = !robots;
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex');

    const load = async () => {
      try {
        const response = await fetch(`/api/white-label-board?token=${encodeURIComponent(token)}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          if (!cancelled && !seen.current) setMissing(true);
          return;
        }
        const data = await response.json();
        if (cancelled || !data || data.ok !== true) {
          if (!cancelled && !seen.current) setMissing(true);
          return;
        }
        seen.current = true;
        if (!cancelled) {
          setPayload(data);
          setMissing(false);
          if (data.companyName) document.title = `${data.companyName} · Operations`;
        }
      } catch {
        if (!cancelled && !seen.current) setMissing(true);
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (createdRobots && robots?.parentNode) robots.parentNode.removeChild(robots);
    };
  }, [token, valid]);

  const trips = useMemo(() => (payload?.trips || []).map((trip) => ({
    uid: trip.uid,
    start: trip.start,
    end: trip.end,
    info: {
      tail: trip.info?.tail || '',
      from: trip.info?.from || '',
      to: trip.info?.to || '',
      tripCode: trip.info?.tripCode || null,
      isFlight: trip.info?.isFlight !== false,
      isOps: trip.info?.isOps !== false,
    },
  })), [payload]);

  const positions = payload?.positions || null;
  const weather = payload?.weather || null;
  const freshness = payload?.freshness || null;
  const brand = useMemo(() => (payload ? {
    companyName: payload.companyName,
    accent: payload.accentColor,
    poweredBy: payload.poweredBy !== false,
    logoUrl,
  } : null), [payload, logoUrl]);

  if (!payload) {
    return (
      <div
        data-white-label-board=""
        className="flex h-screen w-screen items-center justify-center bg-[#060a10] px-6 text-center text-slate-400"
        style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}
      >
        {missing ? 'This operations board is unavailable.' : 'Loading board…'}
      </div>
    );
  }

  return (
    <div data-white-label-board="" className="h-screen w-screen overflow-hidden">
      <Suspense fallback={<div className="h-screen w-screen bg-[#060a10]" />}>
        <FlightBoardLazy
          allTrips={trips}
          fleetTails={Array.isArray(payload.tails) ? payload.tails : []}
          aircraftByTail={NO_AIRCRAFT}
          timeZone="America/New_York"
          brand={brand}
          isolated
          externalPositions={positions}
          externalWeather={weather}
          externalDiag={freshness}
        />
      </Suspense>
    </div>
  );
}
