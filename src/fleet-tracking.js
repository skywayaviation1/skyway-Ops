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
