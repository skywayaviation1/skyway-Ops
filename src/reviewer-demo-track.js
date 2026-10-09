// Fixed public payload for the sandbox tracking link.
// This object is fictional. Serving it must not read company Firestore,
// FlightAware, or weather providers.

import { DEMO_TRACKING_TOKEN } from './reviewer-account.js';
import { buildReviewerDemo } from './reviewer-demo-data.js';

export function isDemoTrackingToken(token) {
  return String(token || '') === DEMO_TRACKING_TOKEN;
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
