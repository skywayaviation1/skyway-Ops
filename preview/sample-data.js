// Sample operating day used only by the marketing/QA preview harness.
//
// Nothing here ships in the application bundle. The point is to drive the REAL
// components with realistic data so captured imagery is the genuine interface,
// not a mockup. Names, brokers and passengers are invented.

const HOUR = 3600_000;
const MIN = 60_000;

const dayAnchor = () => {
  const d = new Date();
  d.setHours(6, 0, 0, 0);
  return d.getTime();
};

export const BASE = dayAnchor();
export const at = (hours) => new Date(BASE + hours * HOUR);

export const FLEET_TAILS = [
  'N20UF', 'N168ZZ', 'N286N', 'N444AM', 'N525CR', 'N551FP', 'N651TW', 'N85AH',
];

export const AIRCRAFT_BY_TAIL = {
  N444AM: { displayName: 'Citation XLS+', icaoType: 'C56X', homeBase: 'KIAD', serialNumber: '560-6012' },
  N286N: { displayName: 'Challenger 300', icaoType: 'CL30', homeBase: 'KTVC', serialNumber: '20411' },
  N651TW: { displayName: 'Phenom 300', icaoType: 'E55P', homeBase: 'KAPF', serialNumber: '50500489' },
  N20UF: { displayName: 'King Air 350i', icaoType: 'BE20', homeBase: 'KTEB', serialNumber: 'FL-1088' },
  N168ZZ: { displayName: 'Learjet 75', icaoType: 'LJ75', homeBase: 'KFXE', serialNumber: '45-521' },
  N551FP: { displayName: 'Citation CJ3+', icaoType: 'C25B', homeBase: 'KPBI', serialNumber: '525B-0490' },
  N85AH: { displayName: 'Sikorsky S-76', icaoType: 'S76', homeBase: 'KOPF', serialNumber: '760812' },
  N525CR: { displayName: 'Citation M2', icaoType: 'C25A', homeBase: 'KFLL', serialNumber: '525-0995' },
};

export const CONFIG = {
  fleetTails: FLEET_TAILS,
  fleetConfigured: true,
  aircraftByTail: AIRCRAFT_BY_TAIL,
  trackingEnabled: true,
  dutyTrackerEnabled: true,
};

function leg({ uid, tail, from, to, startH, endH, pic, sic, pax, broker, category = 'REVENUE' }) {
  return {
    uid,
    id: uid,
    start: at(startH),
    end: at(endH),
    info: {
      tail, from, to, pic, sic, pax, broker,
      legType: category,
      category,
      isFlight: true,
      aircraftType: AIRCRAFT_BY_TAIL[tail]?.displayName || '',
      fromFbo: 'Signature Flight Support',
      toFbo: 'Ross Aviation',
    },
  };
}

export const TRIPS = [
  leg({ uid: 'sky-1001', tail: 'N444AM', from: 'IAD', to: 'HYA', startH: 3, endH: 5.1, pic: 'Maxwell Hagberg', sic: 'Timothy Woods', pax: 6, broker: 'charter@outlierjets.com' }),
  leg({ uid: 'sky-1002', tail: 'N444AM', from: 'HYA', to: 'TEB', startH: 8.5, endH: 9.9, pic: 'Maxwell Hagberg', sic: 'Timothy Woods', pax: 6, broker: 'charter@outlierjets.com' }),
  leg({ uid: 'sky-1003', tail: 'N286N', from: 'TVC', to: 'IAD', startH: 2, endH: 4.2, pic: 'Cade Kaftel', sic: 'Jenelle Szelest', pax: 4, broker: 'ops@monarchair.com' }),
  leg({ uid: 'sky-1004', tail: 'N651TW', from: 'APF', to: 'DFW', startH: 5.5, endH: 8.4, pic: 'Melissa Rippy', sic: 'Andre Cole', pax: 3, broker: 'sales@jetlinx.com' }),
  leg({ uid: 'sky-1005', tail: 'N20UF', from: 'TEB', to: 'PBI', startH: 7, endH: 9.8, pic: 'Dana Whitfield', sic: 'Grant Ellis', pax: 7, broker: 'charter@privatejet.co' }),
  leg({ uid: 'sky-1006', tail: 'N551FP', from: 'PBI', to: 'OPF', startH: 11, endH: 11.9, pic: 'Rosa Delgado', sic: 'Kyle Brenner', pax: 2, broker: 'ops@skybroker.io' }),
  leg({ uid: 'sky-1007', tail: 'N168ZZ', from: 'FXE', to: 'MDW', startH: 12.5, endH: 15.4, pic: 'Victor Alvarez', sic: 'Nina Park', pax: 5, broker: 'trips@victorusfm.com' }),
  leg({ uid: 'sky-1008', tail: 'N525CR', from: 'FLL', to: 'CHS', startH: 14, endH: 15.6, pic: 'Ian McPherson', sic: 'Bree Coleman', pax: 4, broker: 'charter@coastalair.com' }),
];

/** Live FlightAware/ADS-B snapshot: two airborne, the rest parked. */
export function fleetPositions(now = Date.now()) {
  return {
    N444AM: {
      ident: 'N444AM', airborne: true,
      latitude: 40.6431, longitude: -73.1259,
      heading: 62, altitude: 41000, groundspeed: 452,
      origin: 'KIAD', destination: 'KHYA',
      actualOff: new Date(now - 74 * MIN).toISOString(),
      estimatedOn: new Date(now + 26 * MIN).toISOString(),
      progressPercent: 74,
      polledAt: now - 40_000,
      dataFresh: true,
    },
    N651TW: {
      ident: 'N651TW', airborne: true,
      latitude: 30.2, longitude: -88.4,
      heading: 291, altitude: 39000, groundspeed: 438,
      origin: 'KAPF', destination: 'KDFW',
      actualOff: new Date(now - 51 * MIN).toISOString(),
      estimatedOn: new Date(now + 79 * MIN).toISOString(),
      progressPercent: 39,
      polledAt: now - 40_000,
      dataFresh: true,
    },
    N286N: {
      ident: 'N286N', airborne: false,
      groundedAt: 'KIAD', groundedLat: 38.9531, groundedLon: -77.4565,
      groundedSince: new Date(now - 3.1 * HOUR).toISOString(),
      lastKnownLatitude: 38.9531, lastKnownLongitude: -77.4565,
      lastKnownAirport: 'KIAD', lastKnownAt: now - 3.1 * HOUR,
      polledAt: now - 40_000, dataFresh: true,
    },
    N20UF: {
      ident: 'N20UF', airborne: false,
      groundedAt: 'KTEB', groundedLat: 40.8501, groundedLon: -74.0608,
      groundedSince: new Date(now - 15 * HOUR).toISOString(),
      polledAt: now - 40_000, dataFresh: true,
    },
    N168ZZ: {
      ident: 'N168ZZ', airborne: false,
      groundedAt: 'KFXE', groundedLat: 26.1973, groundedLon: -80.1707,
      groundedSince: new Date(now - 20 * HOUR).toISOString(),
      polledAt: now - 40_000, dataFresh: true,
    },
    N551FP: {
      ident: 'N551FP', airborne: false,
      groundedAt: 'KPBI', groundedLat: 26.6832, groundedLon: -80.0956,
      groundedSince: new Date(now - 9 * HOUR).toISOString(),
      polledAt: now - 40_000, dataFresh: true,
    },
    N85AH: {
      ident: 'N85AH', airborne: false,
      groundedAt: 'KOPF', groundedLat: 25.907, groundedLon: -80.2784,
      groundedSince: new Date(now - 30 * HOUR).toISOString(),
      polledAt: now - 40_000, dataFresh: true,
    },
    // Deliberately no coordinates: exercises the home-base fallback path.
    N525CR: { ident: 'N525CR', airborne: false, polledAt: now - 40_000, dataFresh: true },
  };
}

const step = (ms) => ({ timestamp: ms, author: 'Maxwell Hagberg' });

export function tripStates(now = Date.now()) {
  const map = new Map();
  map.set('sky-1001', {
    tripId: 'sky-1001',
    statuses: {
      crew_onsite: step(now - 3 * HOUR),
      aircraft_ready: step(now - 2.6 * HOUR),
      catering_aboard: step(now - 2.4 * HOUR),
      pax_arrived: step(now - 2.1 * HOUR),
      pax_boarded: step(now - 1.8 * HOUR),
      taxi_dep: step(now - 1.4 * HOUR),
      wheels_up: step(now - 74 * MIN),
    },
    completed: false, archived: false, hasCatering: true,
    fromFbo: 'Signature IAD', toFbo: 'Rectrix HYA',
    dispatcherUids: ['dispatch-1'],
    opsDisposition: 'monitoring',
  });
  map.set('sky-1003', {
    tripId: 'sky-1003',
    statuses: {
      crew_onsite: step(now - 6 * HOUR),
      aircraft_ready: step(now - 5.6 * HOUR),
      pax_arrived: step(now - 5.2 * HOUR),
      pax_boarded: step(now - 5 * HOUR),
      taxi_dep: step(now - 4.7 * HOUR),
      wheels_up: step(now - 4.5 * HOUR),
      landed: step(now - 3.1 * HOUR),
    },
    completed: true, completedAt: now - 3 * HOUR, archived: false, hasCatering: false,
  });
  map.set('sky-1004', {
    tripId: 'sky-1004',
    statuses: {
      crew_onsite: step(now - 2 * HOUR),
      aircraft_ready: step(now - 1.7 * HOUR),
      catering_aboard: step(now - 1.5 * HOUR),
      pax_boarded: step(now - 1.1 * HOUR),
      taxi_dep: step(now - 58 * MIN),
      wheels_up: step(now - 51 * MIN),
    },
    completed: false, archived: false, hasCatering: true,
  });
  map.set('sky-1005', {
    tripId: 'sky-1005',
    statuses: { crew_onsite: step(now - 20 * MIN), aircraft_ready: step(now - 8 * MIN) },
    completed: false, archived: false, hasCatering: true,
  });
  map.set('sky-1006', { tripId: 'sky-1006', statuses: {}, completed: false, hasCatering: true });
  map.set('sky-1007', { tripId: 'sky-1007', statuses: {}, completed: false, hasCatering: true });
  map.set('sky-1008', { tripId: 'sky-1008', statuses: {}, completed: false, hasCatering: false });
  return map;
}

export function dutyPeriods(now = Date.now()) {
  return [
    {
      id: 'duty-1', pilotUid: 'pilot-max', pilotName: 'Maxwell Hagberg',
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 4 * HOUR, dutyOffAt: null,
      flightTimeMs: 74 * MIN, location: 'KIAD', tail: 'N444AM', tripId: 'sky-1001',
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 11 * HOUR, over14: false,
    },
    {
      id: 'duty-2', pilotUid: 'pilot-tim', pilotName: 'Timothy Woods',
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 4 * HOUR, dutyOffAt: null,
      flightTimeMs: 74 * MIN, location: 'KIAD', tail: 'N444AM', tripId: 'sky-1001',
      role: 'SIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 10.5 * HOUR, over14: false,
    },
    {
      id: 'duty-3', pilotUid: 'pilot-mel', pilotName: 'Melissa Rippy',
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 2.5 * HOUR, dutyOffAt: null,
      flightTimeMs: 51 * MIN, location: 'KAPF', tail: 'N651TW', tripId: 'sky-1004',
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 12 * HOUR, over14: false,
    },
    {
      id: 'duty-4', pilotUid: 'pilot-dana', pilotName: 'Dana Whitfield',
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 12.4 * HOUR, dutyOffAt: null,
      flightTimeMs: 5.2 * HOUR, location: 'KTEB', tail: 'N20UF', tripId: 'sky-1005',
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 10 * HOUR, over14: false,
    },
    {
      id: 'duty-5', pilotUid: 'pilot-cade', pilotName: 'Cade Kaftel',
      status: 'off', confirmStatus: 'self-attested',
      dutyOnAt: now - 11 * HOUR, dutyOffAt: now - 2.6 * HOUR,
      flightTimeMs: 1.4 * HOUR, location: 'KTVC', tail: 'N286N', tripId: 'sky-1003',
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 12 * HOUR, over14: false,
    },
  ];
}

export const SQUAWKS = [
  {
    id: 'sq-1', tail: 'N168ZZ', status: 'open', severity: 'monitor',
    description: 'Left main tire wear approaching limits',
    reportedAt: Date.now() - 26 * HOUR, reportedByName: 'Nina Park',
    grounding: false,
  },
];

export const MEL_ITEMS = [
  {
    id: 'mel-1', tail: 'N168ZZ', status: 'open', category: 'C',
    title: 'APU generator inoperative', melNumber: '49-40-01',
    deferredAt: Date.now() - 3 * 24 * HOUR,
    dueAt: Date.now() + 7 * 24 * HOUR,
  },
];

export const USERS = [
  { uid: 'pilot-max', id: 'pilot-max', name: 'Maxwell Hagberg', role: 'crew', approved: true, active: true, email: 'max@flyskyway.com' },
  { uid: 'pilot-tim', id: 'pilot-tim', name: 'Timothy Woods', role: 'crew', approved: true, active: true, email: 'tim@flyskyway.com' },
  { uid: 'pilot-mel', id: 'pilot-mel', name: 'Melissa Rippy', role: 'crew', approved: true, active: true, email: 'melissa@flyskyway.com' },
  { uid: 'pilot-dana', id: 'pilot-dana', name: 'Dana Whitfield', role: 'crew', approved: true, active: true, email: 'dana@flyskyway.com' },
  { uid: 'ops-1', id: 'ops-1', name: 'Jordan Vance', role: 'ops', approved: true, active: true, email: 'jordan@flyskyway.com' },
  { uid: 'admin-1', id: 'admin-1', name: 'Jim Skyway', role: 'admin', approved: true, active: true, email: 'jim@flyskyway.com' },
];

export const CURRENT_USER = {
  uid: 'admin-1', id: 'admin-1', name: 'Jim Skyway', callsign: 'Jim',
  role: 'admin', approved: true, active: true, email: 'jim@flyskyway.com',
  emailSignature: 'Jim Skyway\nDirector of Operations\nSkyway Aviation',
};
