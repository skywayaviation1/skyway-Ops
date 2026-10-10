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

/** JetInsight trip IDs are 6–7 letters and digits. Numeric trip numbers are not. */
const TRIP_ID_PATTERN = /^[A-Z0-9]{6,7}$/;

export function readTripId(...sources) {
  const values = [];
  for (const source of sources) {
    if (source == null) continue;
    if (typeof source === 'string' || typeof source === 'number') {
      values.push(source);
      continue;
    }
    if (typeof source === 'object') {
      values.push(
        source.tripSheetData?.tripCode,
        source.tripCode,
        source.info?.tripCode,
        source.info?.tripId,
      );
    }
  }
  for (const value of values) {
    const code = String(value || '').trim().toUpperCase();
    if (TRIP_ID_PATTERN.test(code) && /[A-Z]/.test(code)) return code;
  }
  return null;
}

function stateForTrip(tripStates, uid) {
  if (!tripStates || !uid) return null;
  if (typeof tripStates.get === 'function') return tripStates.get(uid) || null;
  return tripStates[uid] || null;
}

function flightLegsForTail(tail, trips) {
  const normalized = String(tail || '').toUpperCase();
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => String(trip?.info?.tail || '').toUpperCase() === normalized)
    .filter((trip) => trip?.info?.isFlight !== false)
    .slice()
    .sort((a, b) => (toMs(a.start) || 0) - (toMs(b.start) || 0));
}

/**
 * Clock time plus a short zone name (`4:12 PM EDT`). The zone is part of the
 * string so a bubble never shows a bare clock time.
 */
export function formatMarkerTime(value, timeZone) {
  const ms = toMs(value);
  if (ms == null) return null;
  const options = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  if (timeZone) options.timeZone = timeZone;
  try {
    return new Date(ms).toLocaleTimeString('en-US', options);
  } catch {
    return new Date(ms).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'UTC',
    });
  }
}

/**
 * What the map bubble says. Airborne tails get the active trip's destination
 * and ETA. Grounded tails get the next flight's departure, not a flight number.
 */
export function fleetMarkerCallout({
  tail,
  telemetry = null,
  trips = [],
  tripStates = null,
  now = Date.now(),
  timeZone,
} = {}) {
  const legs = flightLegsForTail(tail, trips);
  const active = legs.find((trip) => {
    const start = toMs(trip.start);
    const end = toMs(trip.end);
    return start != null && start <= now && (end == null || end >= now);
  }) || null;
  const upcoming = legs.find((trip) => (toMs(trip.start) || 0) > now) || null;

  if (telemetry?.airborne === true) {
    const destination = telemetry.destination || active?.info?.to || null;
    return {
      tripId: readTripId(stateForTrip(tripStates, active?.uid), active),
      destination: destination ? String(destination).trim().toUpperCase() : null,
      etaLabel: formatMarkerTime(telemetry.estimatedOn || active?.end, timeZone),
      departureLabel: null,
    };
  }

  return {
    tripId: readTripId(stateForTrip(tripStates, upcoming?.uid), upcoming),
    destination: null,
    etaLabel: null,
    departureLabel: formatMarkerTime(upcoming?.start, timeZone),
  };
}

/** Positions the fleet map should frame: airborne tails, or every tail if none are airborne. */
export function fleetFitPositions(aircraft) {
  const located = (Array.isArray(aircraft) ? aircraft : []).filter(
    (item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon),
  );
  const airborne = located.filter((item) => item.airborne === true);
  return airborne.length > 0 ? airborne : located;
}

export function fleetFitSignature(aircraft) {
  return fleetFitPositions(aircraft)
    .map((item) => `${item.id}:${Number(item.lat).toFixed(3)},${Number(item.lon).toFixed(3)}`)
    .sort()
    .join('|');
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
    // Grounded departure bubbles stay up; only a parked tail with nothing
    // coming is quieted until it is selected.
    showLabel: item.airborne === true
      || Boolean(item.departureLabel)
      || Boolean(item.etaLabel)
      || item.id === selectedTail,
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
  tripStates = null,
  aircraftByTail = {},
  now = Date.now(),
  timeZone,
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
    const callout = fleetMarkerCallout({
      tail, telemetry, trips, tripStates, now, timeZone,
    });
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
      tripId: callout.tripId,
      destination: callout.destination,
      etaLabel: callout.etaLabel,
      departureLabel: callout.departureLabel,
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
