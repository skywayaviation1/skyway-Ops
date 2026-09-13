// One projection of fleet telemetry into map markers, shared by Tracking and
// the administrator dashboard. Airborne aircraft use live ADS-B/FlightAware
// coordinates; grounded aircraft use their latest landing position, preserved
// last-known coordinates, then schedule/home-base inference as a final fallback.

import { lookupCoords } from './airport-coords.js';
import { normalizeFleetTails } from './fleet-config.js';

function toMs(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function finitePoint(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function airportPoint(code) {
  const point = lookupCoords(code);
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    ? { lat: point.lat, lon: point.lng }
    : null;
}

export function scheduleLocationForTail(tail, trips, now = Date.now()) {
  const normalized = String(tail || '').toUpperCase();
  const legs = (Array.isArray(trips) ? trips : [])
    .filter((trip) => String(trip?.info?.tail || '').toUpperCase() === normalized)
    .slice()
    .sort((a, b) => (toMs(a.start) || 0) - (toMs(b.start) || 0));

  const active = legs.find((trip) => {
    const start = toMs(trip.start);
    const end = toMs(trip.end);
    return start != null && start <= now && (end == null || end >= now);
  });
  if (active?.info?.from) return { airport: active.info.from, source: 'active-origin' };

  const completed = legs
    .filter((trip) => (toMs(trip.end) || Infinity) < now)
    .sort((a, b) => (toMs(b.end) || 0) - (toMs(a.end) || 0))[0];
  if (completed?.info?.to) return { airport: completed.info.to, source: 'schedule-arrival' };

  const next = legs.find((trip) => (toMs(trip.start) || 0) > now);
  if (next?.info?.from) return { airport: next.info.from, source: 'next-origin' };
  return null;
}

export function resolveFleetMapPosition({
  tail,
  telemetry,
  trips = [],
  aircraftMeta = null,
  now = Date.now(),
}) {
  const p = telemetry || {};
  if (p.airborne === true) {
    const live = finitePoint(p.latitude, p.longitude);
    if (live) {
      return {
        ...live,
        airborne: true,
        source: 'live',
        airport: null,
        at: p.polledAt || p.lastKnownAt || null,
      };
    }
  }

  const grounded = finitePoint(p.groundedLat, p.groundedLon);
  if (grounded) {
    return {
      ...grounded,
      airborne: false,
      source: 'last-landing',
      airport: p.groundedAt || p.lastKnownAirport || null,
      at: p.groundedSince || p.lastKnownAt || p.polledAt || null,
    };
  }

  const lastKnown = finitePoint(p.lastKnownLatitude, p.lastKnownLongitude);
  if (lastKnown) {
    return {
      ...lastKnown,
      airborne: false,
      source: 'last-known',
      airport: p.lastKnownAirport || p.groundedAt || null,
      at: p.lastKnownAt || p.polledAt || null,
    };
  }

  // Older Firestore records may only have latitude/longitude from the last
  // airborne poll. Keep that last known point instead of dropping the tail.
  const legacy = finitePoint(p.latitude, p.longitude);
  if (legacy) {
    return {
      ...legacy,
      airborne: false,
      source: 'last-known',
      airport: p.groundedAt || null,
      at: p.polledAt || null,
    };
  }

  const scheduled = scheduleLocationForTail(tail, trips, now);
  if (scheduled) {
    const point = airportPoint(scheduled.airport);
    if (point) {
      return {
        ...point,
        airborne: false,
        source: scheduled.source,
        airport: scheduled.airport,
        at: null,
      };
    }
  }

  const homeBase = aircraftMeta?.homeBase;
  const home = airportPoint(homeBase);
  if (home) {
    return {
      ...home,
      airborne: false,
      source: 'home-base',
      airport: homeBase,
      at: null,
    };
  }
  return null;
}

/** Airport code first, then any coordinates FlightAware already supplied. */
export function resolveAirportPoint(code, apiLat, apiLon) {
  const hit = airportPoint(code);
  if (hit) return hit;
  return finitePoint(apiLat, apiLon);
}

export function formatLastUpdate(value, now = Date.now()) {
  const ms = toMs(value);
  if (ms == null) return null;
  const delta = now - ms;
  if (delta < 45_000) return 'just now';
  if (delta < 3600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86400_000) return `${Math.max(1, Math.round(delta / 3600_000))}h ago`;
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Origin/destination pins, remainder path, and altitude trail for the
 * selected tail. Shared by the home dashboard and any other fleet map that
 * already has a `buildFleetMapScene` result.
 */
export function buildSelectedFlightOverlay({ telemetry = null, trackPoints = [] } = {}) {
  const airports = [];
  const routes = [];
  let projected = null;
  const trail = Array.isArray(trackPoints) && trackPoints.length >= 2 ? trackPoints : null;
  const p = telemetry || {};
  const airborne = p.airborne === true;

  if (airborne) {
    const originPos = resolveAirportPoint(p.origin, p.originLat, p.originLon);
    const destPos = resolveAirportPoint(p.destination, p.destinationLat, p.destinationLon);
    if (originPos) airports.push({ code: p.origin, lat: originPos.lat, lon: originPos.lon, tone: 'origin' });
    if (destPos) airports.push({ code: p.destination, lat: destPos.lat, lon: destPos.lon, tone: 'destination' });
    const live = finitePoint(p.latitude, p.longitude);
    if (live && destPos) projected = [[live.lat, live.lon], [destPos.lat, destPos.lon]];
    if (live && originPos && !trail) {
      routes.push({
        points: [[originPos.lat, originPos.lon], [live.lat, live.lon]],
        color: '#3FA9CC',
        weight: 3,
        opacity: 0.8,
      });
    }
  } else {
    const grounded = resolveAirportPoint(p.groundedAt, p.groundedLat, p.groundedLon);
    const lastOrigin = resolveAirportPoint(p.lastOrigin, p.lastOriginLat, p.lastOriginLon);
    if (grounded) {
      airports.push({
        code: p.groundedAt,
        lat: grounded.lat,
        lon: grounded.lon,
        tone: 'destination',
      });
    }
    if (lastOrigin) {
      airports.push({
        code: p.lastOrigin,
        lat: lastOrigin.lat,
        lon: lastOrigin.lon,
        tone: 'origin',
        small: true,
      });
    }
    if (grounded && lastOrigin && !trail) {
      routes.push({
        points: [[lastOrigin.lat, lastOrigin.lon], [grounded.lat, grounded.lon]],
        color: '#10b981',
        weight: 2.5,
        opacity: 0.6,
      });
    }
  }

  return { airports, routes, trail, projected };
}

export function withSelectedFlightScene(scene, overlay, { selectedTail = null } = {}) {
  const aircraft = (scene?.aircraft || []).map((item) => ({
    ...item,
    showLabel: item.airborne === true || item.id === selectedTail,
  }));
  return {
    ...scene,
    aircraft,
    airports: overlay?.airports || [],
    routes: overlay?.routes || [],
    trail: overlay?.trail || null,
    projected: overlay?.projected || null,
  };
}

export function buildFleetMapScene({
  fleetTails = [],
  positions = {},
  trips = [],
  aircraftByTail = {},
  now = Date.now(),
}) {
  const aircraft = [];
  const unlocated = [];
  for (const tail of normalizeFleetTails(fleetTails)) {
    const telemetry = positions?.[tail] || null;
    const point = resolveFleetMapPosition({
      tail,
      telemetry,
      trips,
      aircraftMeta: aircraftByTail?.[tail],
      now,
    });
    if (!point) {
      unlocated.push(tail);
      continue;
    }
    aircraft.push({
      id: tail,
      tail,
      lat: point.lat,
      lon: point.lon,
      heading: point.airborne && Number.isFinite(telemetry?.heading) ? telemetry.heading : 0,
      altitude: point.airborne && Number.isFinite(telemetry?.altitude) ? telemetry.altitude : null,
      groundspeed: point.airborne && Number.isFinite(telemetry?.groundspeed) ? telemetry.groundspeed : null,
      airborne: point.airborne,
      groundedAt: point.airport,
      positionSource: point.source,
      positionAt: point.at,
      showLabel: true,
    });
  }
  return {
    aircraft,
    airports: [],
    routes: [],
    trail: null,
    projected: null,
    unlocated,
  };
}
