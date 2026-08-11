// Sample operating day used only by the marketing/QA preview harness.
//
// Nothing here ships in the application bundle. The point is to drive the REAL
// components with realistic data so captured imagery is the genuine interface,
// not a mockup. Names, brokers and passengers are invented.

const HOUR = 3600_000;
const MIN = 60_000;

// Anchored a few hours behind "now" rather than to a fixed clock time, so a
// capture taken at any hour shows a live day: legs already flown, legs airborne
// right now, and legs still to come. A fixed anchor put every trip in the past
// by the evening, which made the pilot's screens read as empty.
export const BASE = Date.now() - 4 * HOUR;
export const at = (hours) => new Date(BASE + hours * HOUR);

/**
 * The operating day, as offsets in hours from BASE. This is the single source
 * for both the in-memory trips and the synthesized schedule feed, so the two
 * can never drift apart.
 */
export const SCHEDULE = [
  { uid: 'sky-1003', tail: 'N286N', customer: 'Monarch Air Group', from: 'TVC', to: 'IAD', type: 'Charter', pax: 4, pic: 'Cade Kaftel', sic: 'Jenelle Szelest', startH: 0.2, endH: 2.4 },
  { uid: 'sky-1001', tail: 'N444AM', customer: 'Outlier Jets', from: 'IAD', to: 'HYA', type: 'Charter', pax: 4, pic: 'Maxwell Hagberg', sic: 'Timothy Woods', startH: 2.8, endH: 4.4 },
  { uid: 'sky-1004', tail: 'N651TW', customer: 'Jet Linx Aviation', from: 'APF', to: 'DFW', type: 'Charter', pax: 3, pic: 'Melissa Rippy', sic: 'Andre Cole', startH: 3.2, endH: 6.1 },
  { uid: 'sky-1005', tail: 'N20UF', customer: 'Private Jet Co', from: 'TEB', to: 'PBI', type: 'Charter', pax: 7, pic: 'Dana Whitfield', sic: 'Grant Ellis', startH: 4.6, endH: 7.4 },
  { uid: 'sky-1002', tail: 'N444AM', customer: 'Outlier Jets', from: 'HYA', to: 'TEB', type: 'Charter', pax: 4, pic: 'Maxwell Hagberg', sic: 'Timothy Woods', startH: 8, endH: 9.4 },
  { uid: 'sky-1006', tail: 'N551FP', customer: 'Skyway Aviation', from: 'PBI', to: 'OPF', type: 'Positioning', pax: 0, pic: 'Rosa Delgado', sic: 'Kyle Brenner', startH: 9, endH: 9.9 },
  { uid: 'sky-1007', tail: 'N168ZZ', customer: 'Victor US Flight Management', from: 'FXE', to: 'MDW', type: 'Charter', pax: 5, pic: 'Victor Alvarez', sic: 'Nina Park', startH: 10.5, endH: 13.4 },
  { uid: 'sky-1008', tail: 'N525CR', customer: 'Coastal Air Charter', from: 'FLL', to: 'CHS', type: 'Charter', pax: 4, pic: 'Ian McPherson', sic: 'Bree Coleman', startH: 12, endH: 13.6 },
];

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

const BROKER_EMAIL = {
  'Outlier Jets': 'charter@outlierjets.com',
  'Monarch Air Group': 'ops@monarchair.com',
  'Jet Linx Aviation': 'sales@jetlinx.com',
  'Private Jet Co': 'charter@privatejet.co',
  'Victor US Flight Management': 'trips@victorusfm.com',
  'Coastal Air Charter': 'charter@coastalair.com',
  'Skyway Aviation': '',
};

export const TRIPS = SCHEDULE.map((s) => ({
  uid: s.uid,
  id: s.uid,
  start: at(s.startH),
  end: at(s.endH),
  info: {
    tail: s.tail,
    from: s.from,
    to: s.to,
    pic: s.pic,
    sic: s.sic,
    pax: s.pax,
    broker: BROKER_EMAIL[s.customer] ?? '',
    customer: s.customer,
    legType: s.pax > 0 ? 'REVENUE' : 'REPO',
    category: s.pax > 0 ? 'REVENUE' : 'REPO',
    isFlight: true,
    aircraftType: AIRCRAFT_BY_TAIL[s.tail]?.displayName || '',
    fromFbo: 'Signature Flight Support',
    toFbo: 'Ross Aviation',
  },
}));

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

const PAX = [
  { id: 'p1', firstName: 'Alexander', lastName: 'Whitmore', checkInStatus: 'matched', dob: '4/18/71' },
  { id: 'p2', firstName: 'Caroline', lastName: 'Whitmore', checkInStatus: 'matched', dob: '9/2/74' },
  { id: 'p3', firstName: 'Renard', lastName: 'Delacroix', checkInStatus: 'matched', dob: '1/30/68' },
  { id: 'p4', firstName: 'Sylvia', lastName: 'Ambrose', checkInStatus: 'matched', dob: '11/7/80' },
];

/**
 * Screens read many optional fields straight off the trip-state document, so a
 * partial object makes them fail on `undefined.filter(...)`. Every sample state
 * is completed to the full shape the real subscription returns.
 */
function tripState(overrides = {}) {
  return {
    statuses: {},
    passengers: [],
    preloadedPax: [],
    brokerEmail: '',
    autoNotify: false,
    completed: false,
    completedAt: null,
    archived: false,
    archivedAt: null,
    hasCatering: true,
    paxOverride: null,
    tripSheetUrl: null,
    tripSheetPath: null,
    tripSheetFilename: null,
    tripSheetUploadedAt: null,
    tripSheetUploadedBy: null,
    tripSheetNotes: null,
    tripSheetNotesEditedAt: null,
    tripSheetData: null,
    dispatcherUids: [],
    opsDisposition: 'monitoring',
    opsDispositionReason: '',
    opsUpdatedAt: null,
    opsUpdatedByName: '',
    opsLatestNote: '',
    opsLatestNoteAt: null,
    opsLatestNoteByName: '',
    fromFbo: null,
    toFbo: null,
    ...overrides,
  };
}

export function tripStates(now = Date.now()) {
  const map = new Map();
  map.set('sky-1001', tripState({
    tripId: 'sky-1001',
    passengers: PAX.map((pax) => ({ ...pax, preloadedRefId: pax.id, verifiedAt: now - 100 * MIN })),
    preloadedPax: PAX,
    brokerEmail: 'charter@outlierjets.com',
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
  }));
  map.set('sky-1003', tripState({
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
  }));
  map.set('sky-1004', tripState({
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
  }));
  map.set('sky-1005', tripState({
    tripId: 'sky-1005',
    statuses: { crew_onsite: step(now - 20 * MIN), aircraft_ready: step(now - 8 * MIN) },
    completed: false, archived: false, hasCatering: true,
  }));
  map.set('sky-1006', tripState({ tripId: 'sky-1006', hasCatering: false }));
  map.set('sky-1007', tripState({ tripId: 'sky-1007' }));
  map.set('sky-1008', tripState({ tripId: 'sky-1008', hasCatering: false }));
  // Legs with no state yet still need the full shape.
  map.set('sky-1002', tripState({ tripId: 'sky-1002', preloadedPax: PAX.slice(0, 2), brokerEmail: 'charter@outlierjets.com' }));
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

const HR = 3600_000;

// Field names follow the expense document the reporting helpers read
// (src/expense-export.js): uid, authorName, vendor, totalAmount, category from
// the QuickBooks account map, and transactionDate.
function expense({ id, uid, authorName, tripUid, tail, category, vendor, totalAmount, daysAgo, card, method = 'Company card', notes = '', reconciled = false }) {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  return {
    id,
    uid,
    authorName,
    authorEmail: `${authorName.split(' ')[0].toLowerCase()}@flyskyway.com`,
    tripUid,
    tail,
    category,
    vendor,
    totalAmount,
    currency: 'USD',
    paymentMethod: method,
    cardLast4: card || null,
    transactionDate: at.toISOString().slice(0, 10),
    createdAt: at.getTime(),
    receiptUrl: '#',
    notes,
    status: 'approved',
    ...(reconciled ? { qbTransactionId: `PUR-${1000 + Number(id.split('-')[1])}`, qboReconciledAt: at.getTime() } : {}),
  };
}

export const EXPENSES = [
  expense({ id: 'exp-1', uid: 'pilot-max', authorName: 'Maxwell Hagberg', tripUid: 'sky-1001', tail: 'N444AM', category: 'Fuel', vendor: 'Signature Flight Support IAD', totalAmount: 4820.55, daysAgo: 0, card: '4412', notes: 'Uplift 620 gal', reconciled: true }),
  expense({ id: 'exp-2', uid: 'pilot-max', authorName: 'Maxwell Hagberg', tripUid: 'sky-1001', tail: 'N444AM', category: 'Catering', vendor: 'Rectrix Catering HYA', totalAmount: 386.4, daysAgo: 0, card: '4412', notes: 'Fruit and cheese, 2 vegetarian', reconciled: true }),
  expense({ id: 'exp-3', uid: 'pilot-mel', authorName: 'Melissa Rippy', tripUid: 'sky-1004', tail: 'N651TW', category: 'Crew Meals', vendor: 'Terminal Cafe APF', totalAmount: 62.18, daysAgo: 0, method: 'Personal card', notes: 'Reimbursable' }),
  expense({ id: 'exp-4', uid: 'pilot-dana', authorName: 'Dana Whitfield', tripUid: 'sky-1005', tail: 'N20UF', category: 'Ground Transport', vendor: 'Teterboro Car Service', totalAmount: 145, daysAgo: 1, card: '9903', reconciled: true }),
  expense({ id: 'exp-5', uid: 'pilot-tim', authorName: 'Timothy Woods', tripUid: 'sky-1002', tail: 'N444AM', category: 'Crew Lodging', vendor: 'Hyatt Place Hyannis', totalAmount: 289.7, daysAgo: 1, method: 'Personal card', notes: 'Overnight crew rest' }),
  expense({ id: 'exp-6', uid: 'pilot-cade', authorName: 'Cade Kaftel', tripUid: 'sky-1003', tail: 'N286N', category: 'FBO Fees', vendor: 'Traverse City Airport Authority', totalAmount: 210, daysAgo: 2, card: '4412', reconciled: true }),
  expense({ id: 'exp-7', uid: 'pilot-max', authorName: 'Maxwell Hagberg', tripUid: 'sky-1002', tail: 'N444AM', category: 'Hangar', vendor: 'Jet Aviation Teterboro', totalAmount: 675, daysAgo: 3, card: '4412', notes: 'Overnight hangar' }),
  expense({ id: 'exp-8', uid: 'pilot-dana', authorName: 'Dana Whitfield', tripUid: 'sky-1005', tail: 'N20UF', category: 'Fuel', vendor: 'Sheltair PBI', totalAmount: 3915.2, daysAgo: 4, card: '9903', notes: 'Uplift 505 gal', reconciled: true }),
  expense({ id: 'exp-9', uid: 'pilot-mel', authorName: 'Melissa Rippy', tripUid: 'sky-1004', tail: 'N651TW', category: 'Supplies', vendor: 'Aviall Parts Counter', totalAmount: 118.44, daysAgo: 5, card: '4412' }),
  expense({ id: 'exp-10', uid: 'pilot-tim', authorName: 'Timothy Woods', tripUid: 'sky-1001', tail: 'N444AM', category: 'Crew Meals', vendor: 'Provisions HYA', totalAmount: 84.9, daysAgo: 6, method: 'Personal card' }),
];

export const WALLET_CARDS = [
  { id: 'card-1', label: 'Capital One Spark', last4: '4412', holder: 'Skyway Aviation', kind: 'company' },
  { id: 'card-2', label: 'Amex Business Platinum', last4: '9903', holder: 'Skyway Aviation', kind: 'company' },
];

export const MANIFESTS = [
  {
    id: 'manifest-1', tail: 'N444AM', date: new Date(BASE).toISOString().slice(0, 10),
    legs: [{ tripUid: 'sky-1001', from: 'IAD', to: 'HYA', pax: [] }],
    createdAt: BASE, updatedAt: BASE + HR,
  },
];

export const CURRENT_USER = {
  uid: 'admin-1', id: 'admin-1', name: 'Jim Skyway', callsign: 'Jim',
  role: 'admin', approved: true, active: true, email: 'jim@flyskyway.com',
  emailSignature: 'Jim Skyway\nDirector of Operations\nSkyway Aviation',
};

export const PILOT_USER = {
  uid: 'pilot-max', id: 'pilot-max', name: 'Maxwell Hagberg', callsign: 'Max',
  role: 'crew', approved: true, active: true, email: 'max@flyskyway.com',
  certType: 'ATP', certNumber: '3458291', jetinsightName: 'Maxwell Hagberg',
};
