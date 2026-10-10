// Fixed public payload for the sandbox tracking link.
// This object is fictional. Serving it must not read company Firestore,
// FlightAware, or weather providers.

import { DEMO_TRACKING_TOKEN } from './reviewer-account.js';
import { buildReviewerDemo } from './reviewer-demo-data.js';

export function isDemoTrackingToken(token) {
  return String(token || '') === DEMO_TRACKING_TOKEN;
}

/** Seeded fleet positions keyed by tail. Used when FlightAware is not called. */
export function demoPositionsMap(now = Date.now()) {
  const demo = buildReviewerDemo(now, 'app-reviewer');
  const map = {};
  for (const position of demo.positions) {
    const ident = String(position.id || position.ident || '').toUpperCase();
    if (!ident) continue;
    map[ident] = { ...position, ident };
  }
  return map;
}

/** Static flown path for the airborne demo tail. Grounded tails have no trail. */
export function demoTrackPoints(tail, now = Date.now()) {
  const id = String(tail || '').toUpperCase();
  if (id !== 'N551SK') return [];
  const demo = buildReviewerDemo(now, 'app-reviewer');
  const position = demo.positions.find((p) => p.id === 'N551SK');
  const active = demo.trips.find((t) => t.uid === 'demo-active');
  if (!position || !active) return [];
  const departed = new Date(active.start).getTime();
  const startLat = 26.6832;
  const startLon = -80.0956;
  const midLat = startLat + (position.latitude - startLat) * 0.5;
  const midLon = startLon + (position.longitude - startLon) * 0.5;
  return [
    { lat: startLat, lon: startLon, altitude: 1200, groundspeed: 180, time: departed },
    { lat: midLat, lon: midLon, altitude: 39000, groundspeed: 420, time: departed + (now - departed) / 2 },
    {
      lat: position.latitude,
      lon: position.longitude,
      altitude: position.altitude,
      groundspeed: position.groundspeed,
      time: now,
    },
  ];
}

/**
 * Flight detail the tracking panel can render without calling FlightAware.
 * N551SK is the airborne demo leg. N882SK is parked at TEB.
 */
export function demoFlightDetail(tail, now = Date.now()) {
  const id = String(tail || '').toUpperCase();
  const demo = buildReviewerDemo(now, 'app-reviewer');
  if (id === 'N551SK') {
    const active = demo.trips.find((t) => t.uid === 'demo-active');
    if (!active) return null;
    return {
      ident: 'N551SK',
      aircraftType: 'Citation Latitude',
      actualOff: active.start,
      actualOn: null,
      estimatedOn: active.end,
      scheduledOff: active.start,
      scheduledOn: active.end,
      origin: { code: 'KPBI', city: 'West Palm Beach' },
      destination: { code: 'KTEB', city: 'Teterboro' },
      routeDistance: 1040,
      demo: true,
    };
  }
  if (id === 'N882SK') {
    const parked = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    return {
      ident: 'N882SK',
      aircraftType: 'Citation XLS+',
      actualOff: parked,
      actualOn: parked,
      estimatedOn: null,
      scheduledOff: parked,
      scheduledOn: parked,
      origin: { code: 'KPBI', city: 'West Palm Beach' },
      destination: { code: 'KTEB', city: 'Teterboro' },
      demo: true,
    };
  }
  return null;
}

export function demoTrackingResponse(now = Date.now()) {
  const demo = buildReviewerDemo(now, 'app-reviewer');
  const active = demo.trips.find((t) => t.uid === 'demo-active');
  const position = demo.positions.find((p) => p.id === 'N551SK');
  const departed = new Date(active.start).getTime();
  return {
    ok: true,
    demo: true,
    trip: {
      tripId: 'demo-active',
      tripCode: 'DEMO',
      tail: 'N551SK',
      aircraftType: 'Citation Latitude',
      completed: false,
      completedAt: null,
      legs: [
        {
          legNumber: 1,
          from: active.info.from,
          to: active.info.to,
          fromFbo: 'Signature Flight Support',
          toFbo: 'Atlantic Aviation',
          departure: active.start,
          arrival: active.end,
          category: 'REVENUE',
          pic: 'Avery Lang',
          sic: 'Jordan Hale',
          pax: [],
          showPax: false,
          hasCatering: true,
          status: {
            wheels_up: { at: departed, completed: true },
          },
        },
      ],
      statuses: {},
    },
    position: {
      ident: 'N551SK',
      airborne: true,
      latitude: position.latitude,
      longitude: position.longitude,
      heading: position.heading,
      altitude: position.altitude,
      groundspeed: position.groundspeed,
      origin: 'KPBI',
      destination: 'KTEB',
      destinationCity: 'Teterboro',
      polledAt: now,
    },
    trail: [
      { lat: 26.6832, lon: -80.0956, altitude_ft: 0, groundspeed_kt: 140, time: departed },
      { lat: position.latitude, lon: position.longitude, altitude_ft: 41000, groundspeed_kt: 430, time: now },
    ],
    trailLive: true,
    weather: {},
  };
}
