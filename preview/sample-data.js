// Sample operating day used only by the marketing/QA preview harness.
//
// Nothing here ships in the application bundle. The point is to drive the REAL
// components with realistic data so captured imagery is the genuine interface,
// not a mockup. Everything is derived from the active tenant in tenants.js, so
// the same harness can present the product as any operator, and nothing below
// names a specific one. Every person, customer and registration is invented.

import { tenant } from './tenants.js';

const HOUR = 3600_000;
const MIN = 60_000;

const T = tenant();

export const TENANT = T;
export const COMPANY = T.company;
export const COMPANY_LEGAL = T.companyLegal;
export const DOMAIN = T.domain;
export const CHARTER_INBOX = T.charterInbox;

/** firstname@domain, which is how the sample accounts are addressed. */
export const emailFor = (person) => `${person.first.toLowerCase()}@${T.domain}`;

// Anchored a few hours behind "now" rather than to a fixed clock time, so a
// capture taken at any hour shows a live day: legs already flown, legs airborne
// right now, and legs still to come. A fixed anchor put every trip in the past
// by the evening, which made the pilot's screens read as empty.
export const BASE = Date.now() - 4 * HOUR;
export const at = (hours) => new Date(BASE + hours * HOUR);

/** Field coordinates for every airport either tenant's day touches. */
const AIRPORTS = {
  ACK: [41.2531, -70.0602], APF: [26.1526, -81.7753], AUS: [30.1975, -97.6664],
  BNA: [36.1245, -86.6782], CHS: [32.8986, -80.0405], DFW: [32.8998, -97.0403],
  FLL: [26.0726, -80.1527], FXE: [26.1973, -80.1707], HYA: [41.6693, -70.2804],
  IAD: [38.9531, -77.4565], MCO: [28.4312, -81.3081], MDW: [41.7868, -87.7522],
  OPF: [25.9070, -80.2784], PBI: [26.6832, -80.0956], RSW: [26.5362, -81.7552],
  SRQ: [27.3954, -82.5544], TEB: [40.8501, -74.0608], TVC: [44.7414, -85.5822],
};

const coordsOf = (code) => AIRPORTS[code] || AIRPORTS[T.base] || [26.1526, -81.7753];

function bearing([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360);
}

/**
 * The operating day, as offsets in hours from BASE. This is the single source
 * for the in-memory trips, the synthesized schedule feed, the live positions and
 * the duty records, so none of them can drift apart. Crew are referenced by
 * index into the tenant's roster, so a tenant declares its people once.
 */
export const SCHEDULE = T.schedule.map((leg) => ({
  ...leg,
  pic: T.crew[leg.picIdx].name,
  sic: T.crew[leg.sicIdx].name,
  picUid: T.crew[leg.picIdx].uid,
  sicUid: T.crew[leg.sicIdx].uid,
}));

/** Named handles for the legs the sample day gives a particular role. */
const LEG = {
  flownEarlier: SCHEDULE[0],
  airborne: SCHEDULE[1],        // the pilot whose phone the booklet shows
  airborneSecond: SCHEDULE[2],
  preflight: SCHEDULE[3],
  laterSameTail: SCHEDULE[4],
  positioning: SCHEDULE[5],
};

export const FLEET_TAILS = T.fleet.map((a) => a.tail);

export const AIRCRAFT_BY_TAIL = Object.fromEntries(T.fleet.map((a, i) => [
  a.tail,
  {
    displayName: a.displayName,
    icaoType: a.type,
    homeBase: `K${a.home}`,
    serialNumber: `${a.type}-${520 + i * 37}`,
  },
]));

export const CONFIG = {
  fleetTails: FLEET_TAILS,
  fleetConfigured: true,
  aircraftByTail: AIRCRAFT_BY_TAIL,
  trackingEnabled: true,
  dutyTrackerEnabled: true,
};

/** A contact address per customer, and none for the operator's own legs. */
const BROKER_EMAIL = Object.fromEntries([
  ...T.customers.map((name) => [
    name,
    `charter@${name.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 18)}.com`,
  ]),
  [T.company, ''],
]);

export const brokerEmailFor = (customer) => BROKER_EMAIL[customer] ?? '';

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
    toFbo: 'Atlantic Aviation',
  },
}));

/**
 * Live fleet positions.
 *
 * Legs in the air right now are interpolated along their route; everything else
 * holds its last known ground position, which is the behaviour the fleet map is
 * built around — an aircraft never disappears just because it is not flying.
 */
export function fleetPositions(now = Date.now()) {
  const out = {};

  for (const leg of SCHEDULE) {
    const start = at(leg.startH).getTime();
    const end = at(leg.endH).getTime();
    if (now < start || now > end) continue;

    const from = coordsOf(leg.from);
    const to = coordsOf(leg.to);
    const progress = Math.min(0.97, Math.max(0.03, (now - start) / (end - start)));
    out[leg.tail] = {
      ident: leg.tail,
      airborne: true,
      latitude: from[0] + (to[0] - from[0]) * progress,
      longitude: from[1] + (to[1] - from[1]) * progress,
      heading: bearing(from, to),
      altitude: 41000,
      groundspeed: 448,
      origin: `K${leg.from}`,
      destination: `K${leg.to}`,
      actualOff: new Date(start).toISOString(),
      estimatedOn: new Date(end).toISOString(),
      progressPercent: Math.round(progress * 100),
      polledAt: now - 40_000,
      dataFresh: true,
    };
  }

  T.fleet.forEach((aircraft, index) => {
    if (out[aircraft.tail]) return;
    // One tail is deliberately left without coordinates, which exercises the
    // home-base fallback the fleet map relies on.
    if (index === T.fleet.length - 1) {
      out[aircraft.tail] = {
        ident: aircraft.tail, airborne: false, polledAt: now - 40_000, dataFresh: true,
      };
      return;
    }
    const [lat, lon] = coordsOf(aircraft.home);
    const groundedFor = (3 + index * 4) * HOUR;
    out[aircraft.tail] = {
      ident: aircraft.tail,
      airborne: false,
      groundedAt: `K${aircraft.home}`,
      groundedLat: lat,
      groundedLon: lon,
      groundedSince: new Date(now - groundedFor).toISOString(),
      lastKnownLatitude: lat,
      lastKnownLongitude: lon,
      lastKnownAirport: `K${aircraft.home}`,
      lastKnownAt: now - groundedFor,
      polledAt: now - 40_000,
      dataFresh: true,
    };
  });

  return out;
}

const step = (ms, author) => ({ timestamp: ms, author });

const DOBS = ['4/18/71', '9/2/74', '1/30/68', '11/7/80'];

const PAX = T.passengers.map((full, i) => {
  const [firstName, ...rest] = full.split(' ');
  return {
    id: `p${i + 1}`,
    firstName,
    lastName: rest.join(' '),
    checkInStatus: 'matched',
    dob: DOBS[i % DOBS.length],
  };
});

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

  // The leg in the air: a full milestone timeline, signed by its captain.
  const air = LEG.airborne;
  map.set(air.uid, tripState({
    tripId: air.uid,
    passengers: PAX.map((pax) => ({ ...pax, preloadedRefId: pax.id, verifiedAt: now - 100 * MIN })),
    preloadedPax: PAX,
    brokerEmail: BROKER_EMAIL[air.customer] ?? '',
    statuses: {
      crew_onsite: step(now - 3 * HOUR, air.pic),
      aircraft_ready: step(now - 2.6 * HOUR, air.pic),
      catering_aboard: step(now - 2.4 * HOUR, air.sic),
      pax_arrived: step(now - 2.1 * HOUR, air.pic),
      pax_boarded: step(now - 1.8 * HOUR, air.sic),
      taxi_dep: step(now - 1.4 * HOUR, air.pic),
      wheels_up: step(now - 74 * MIN, air.pic),
    },
    completed: false, archived: false, hasCatering: true,
    fromFbo: `Signature ${air.from}`, toFbo: `Atlantic ${air.to}`,
    dispatcherUids: ['ops-1'],
  }));

  const flown = LEG.flownEarlier;
  const flownOut = at(flown.startH);
  const flownIn = at(flown.endH);
  map.set(flown.uid, tripState({
    tripId: flown.uid,
    oooi: {
      actualOut: flownOut.toISOString(),
      actualOff: new Date(flownOut.getTime() + 6 * MIN).toISOString(),
      actualOn: new Date(flownIn.getTime() - 8 * MIN).toISOString(),
      actualIn: flownIn.toISOString(),
      faFlightId: 'preview-sky-1003',
    },
    statuses: {
      crew_onsite: step(now - 11 * HOUR, flown.pic),
      aircraft_ready: step(now - 10.6 * HOUR, flown.pic),
      pax_arrived: step(now - 10.2 * HOUR, flown.sic),
      pax_boarded: step(now - 10 * HOUR, flown.sic),
      taxi_dep: step(now - 9.8 * HOUR, flown.pic),
      wheels_up: step(now - 9.5 * HOUR, flown.pic),
      landed: step(now - 8.1 * HOUR, flown.pic),
    },
    completed: true, completedAt: now - 3 * HOUR, archived: false, hasCatering: false,
  }));

  const second = LEG.airborneSecond;
  map.set(second.uid, tripState({
    tripId: second.uid,
    statuses: {
      crew_onsite: step(now - 2.4 * HOUR, second.pic),
      aircraft_ready: step(now - 2.1 * HOUR, second.pic),
      pax_boarded: step(now - 1.4 * HOUR, second.sic),
      taxi_dep: step(now - 1.1 * HOUR, second.pic),
      wheels_up: step(now - 51 * MIN, second.pic),
    },
    completed: false, archived: false, hasCatering: true,
  }));

  const pre = LEG.preflight;
  map.set(pre.uid, tripState({
    tripId: pre.uid,
    statuses: {
      crew_onsite: step(now - 20 * MIN, pre.pic),
      aircraft_ready: step(now - 8 * MIN, pre.pic),
    },
    completed: false, archived: false, hasCatering: true,
  }));

  // Remaining legs have no state yet, but still need the full shape.
  for (const leg of SCHEDULE) {
    if (map.has(leg.uid)) continue;
    map.set(leg.uid, tripState({
      tripId: leg.uid,
      hasCatering: leg.pax > 0,
      preloadedPax: leg.uid === LEG.laterSameTail.uid ? PAX.slice(0, 2) : [],
      brokerEmail: BROKER_EMAIL[leg.customer] ?? '',
    }));
  }

  return map;
}

export function dutyPeriods(now = Date.now()) {
  const air = LEG.airborne;
  const second = LEG.airborneSecond;
  const pre = LEG.preflight;
  const flown = LEG.flownEarlier;

  return [
    {
      id: 'duty-1', pilotUid: air.picUid, pilotName: air.pic,
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 4 * HOUR, dutyOffAt: null,
      flightTimeMs: 74 * MIN, location: `K${air.from}`, tail: air.tail, tripId: air.uid,
      role: 'PIC', crewType: 'two', assignmentType: 'regular', partnerPeriodId: 'duty-2',
      fitForDuty: true, priorRestMs: 11 * HOUR, over14: false,
    },
    {
      id: 'duty-2', pilotUid: air.sicUid, pilotName: air.sic,
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 4 * HOUR, dutyOffAt: null,
      flightTimeMs: 74 * MIN, location: `K${air.from}`, tail: air.tail, tripId: air.uid,
      role: 'SIC', crewType: 'two', assignmentType: 'regular', partnerPeriodId: 'duty-1',
      fitForDuty: true, priorRestMs: 10.5 * HOUR, over14: false,
    },
    {
      id: 'duty-3', pilotUid: second.picUid, pilotName: second.pic,
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 2.5 * HOUR, dutyOffAt: null,
      flightTimeMs: 51 * MIN, location: `K${second.from}`, tail: second.tail, tripId: second.uid,
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 12 * HOUR, over14: false,
    },
    {
      id: 'duty-4', pilotUid: pre.picUid, pilotName: pre.pic,
      status: 'on', confirmStatus: 'self-attested',
      dutyOnAt: now - 12.4 * HOUR, dutyOffAt: null,
      flightTimeMs: 5.2 * HOUR, location: `K${pre.from}`, tail: pre.tail, tripId: pre.uid,
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 10 * HOUR, over14: false,
    },
    {
      id: 'duty-5', pilotUid: flown.picUid, pilotName: flown.pic,
      status: 'off', confirmStatus: 'self-attested',
      dutyOnAt: now - 11 * HOUR, dutyOffAt: now - 2.6 * HOUR,
      flightTimeMs: 1.4 * HOUR, location: `K${flown.from}`, tail: flown.tail, tripId: flown.uid,
      role: 'PIC', crewType: 'two', assignmentType: 'regular',
      fitForDuty: true, priorRestMs: 12 * HOUR, over14: false,
    },
  ];
}

const MAINT_TAIL = T.fleet[5].tail;

export const SQUAWKS = [
  {
    id: 'sq-1', tail: MAINT_TAIL, status: 'open', severity: 'monitor',
    description: 'Left main tire wear approaching limits',
    reportedAt: Date.now() - 26 * HOUR, reportedByName: T.staff[3].name,
    grounding: false,
  },
];

export const MEL_ITEMS = [
  {
    id: 'mel-1', tail: MAINT_TAIL, status: 'open', category: 'C',
    title: 'APU generator inoperative', melNumber: '49-40-01',
    deferredAt: Date.now() - 3 * 24 * HOUR,
    dueAt: Date.now() + 7 * 24 * HOUR,
  },
];

const person = (p) => ({
  uid: p.uid, id: p.uid, name: p.name, role: p.role,
  approved: true, active: true, email: emailFor(p),
});

export const USERS = [...T.crew.map(person), ...T.staff.map(person)];

// Field names follow the expense document the reporting helpers read
// (src/expense-export.js): uid, authorName, vendor, totalAmount, category from
// the QuickBooks account map, and transactionDate.
function expense({ id, crewIdx, legKey, category, vendor, totalAmount, daysAgo, card, method = 'Company card', notes = '', reconciled = false }) {
  const who = T.crew[crewIdx];
  const leg = LEG[legKey] || SCHEDULE[0];
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  return {
    id,
    uid: who.uid,
    authorName: who.name,
    authorEmail: emailFor(who),
    tripUid: leg.uid,
    tail: leg.tail,
    category,
    vendor: `${vendor} ${leg.from}`,
    totalAmount,
    currency: 'USD',
    paymentMethod: method,
    cardLast4: card || null,
    transactionDate: when.toISOString().slice(0, 10),
    createdAt: when.getTime(),
    receiptUrl: '#',
    notes,
    status: 'approved',
    ...(reconciled
      ? { qbTransactionId: `PUR-${1000 + Number(id.split('-')[1])}`, qboReconciledAt: when.getTime() }
      : {}),
  };
}

export const EXPENSES = [
  expense({ id: 'exp-1', crewIdx: 0, legKey: 'airborne', category: 'Fuel', vendor: 'Signature Flight Support', totalAmount: 4820.55, daysAgo: 0, card: '4412', notes: 'Uplift 620 gal', reconciled: true }),
  expense({ id: 'exp-2', crewIdx: 0, legKey: 'airborne', category: 'Catering', vendor: 'Sky Provisions', totalAmount: 386.4, daysAgo: 0, card: '4412', notes: 'Fruit and cheese, 2 vegetarian', reconciled: true }),
  expense({ id: 'exp-3', crewIdx: 2, legKey: 'airborneSecond', category: 'Crew Meals', vendor: 'Terminal Cafe', totalAmount: 62.18, daysAgo: 0, method: 'Personal card', notes: 'Reimbursable' }),
  expense({ id: 'exp-4', crewIdx: 3, legKey: 'preflight', category: 'Ground Transport', vendor: 'Executive Car Service', totalAmount: 145, daysAgo: 1, card: '9903', reconciled: true }),
  expense({ id: 'exp-5', crewIdx: 1, legKey: 'laterSameTail', category: 'Crew Lodging', vendor: 'Harbour Hotel', totalAmount: 289.7, daysAgo: 1, method: 'Personal card', notes: 'Overnight crew rest' }),
  expense({ id: 'exp-6', crewIdx: 4, legKey: 'flownEarlier', category: 'FBO Fees', vendor: 'Airport Authority', totalAmount: 210, daysAgo: 2, card: '4412', reconciled: true }),
  expense({ id: 'exp-7', crewIdx: 0, legKey: 'laterSameTail', category: 'Hangar', vendor: 'Jet Center', totalAmount: 675, daysAgo: 3, card: '4412', notes: 'Overnight hangar' }),
  expense({ id: 'exp-8', crewIdx: 3, legKey: 'preflight', category: 'Fuel', vendor: 'Sheltair', totalAmount: 3915.2, daysAgo: 4, card: '9903', notes: 'Uplift 505 gal', reconciled: true }),
  expense({ id: 'exp-9', crewIdx: 2, legKey: 'airborneSecond', category: 'Supplies', vendor: 'Parts Counter', totalAmount: 118.44, daysAgo: 5, card: '4412' }),
  expense({ id: 'exp-10', crewIdx: 1, legKey: 'airborne', category: 'Crew Meals', vendor: 'Provisions', totalAmount: 84.9, daysAgo: 6, method: 'Personal card' }),
];

export const WALLET_CARDS = [
  { id: 'card-1', label: 'Capital One Spark', last4: '4412', holder: T.company, kind: 'company' },
  { id: 'card-2', label: 'Amex Business Platinum', last4: '9903', holder: T.company, kind: 'company' },
];

export const MANIFESTS = [
  {
    id: 'manifest-1', tail: LEG.airborne.tail, date: new Date(BASE).toISOString().slice(0, 10),
    legs: [{ tripUid: LEG.airborne.uid, from: LEG.airborne.from, to: LEG.airborne.to, pax: [] }],
    createdAt: BASE, updatedAt: BASE + HOUR,
  },
];

const ADMIN = T.staff[0];
const LEAD_PILOT = T.crew[0];

export const CURRENT_USER = {
  uid: ADMIN.uid, id: ADMIN.uid, name: ADMIN.name, callsign: ADMIN.first,
  role: 'admin', approved: true, active: true, email: emailFor(ADMIN),
  emailSignature: `${ADMIN.name}\n${ADMIN.title}\n${T.company}`,
};

export const PILOT_USER = {
  uid: LEAD_PILOT.uid, id: LEAD_PILOT.uid, name: LEAD_PILOT.name, callsign: LEAD_PILOT.first,
  role: 'crew', approved: true, active: true, email: emailFor(LEAD_PILOT),
  certType: 'ATP', certNumber: '3458291', jetinsightName: LEAD_PILOT.name,
};

function ymd(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

const currentCheck = (daysAgo = 80) => ({ lastDate: ymd(-daysAgo) });
const dueOn = (daysAhead) => ({ dueDate: ymd(daysAhead) });
const notApplicable = () => ({ notApplicable: true });

/**
 * Logbooks and currency records for the preview harness.
 * Profiles are assigned by crew index so every tenant shows a mix:
 * meets standard, expiring soon, and does not meet.
 */
export function pilotSafetySeed() {
  const primary = T.fleet[0]?.displayName || 'Aircraft';
  const secondary = T.fleet[1]?.displayName || 'Aircraft 2';
  const baseHours = {
    totalTime: 4820,
    pic: 2310,
    sic: 2510,
    fixedWing: 4700,
    rotorWing: 0,
    singleEngine: 120,
    multiEngine: 4100,
    multiEngine90: 42,
    multiEngine12: 210,
    turbine: 3600,
    night: 640,
    instrument: 410,
    last90Days: 48,
    last12Months: 312,
    timeInType: [
      { type: primary, hours: 860, picHours: 410 },
      { type: secondary, hours: 240, picHours: 80 },
    ],
  };
  const checks = () => ({
    medical: { class: 'First', expirationDate: ymd(420), lastDate: ymd(-50) },
    basicIndoctrination: currentCheck(200),
    groundOralGeneral293a: currentCheck(60),
    groundOral293a_CE525: currentCheck(60),
    groundOral293a_LR60: notApplicable(),
    groundOral293a_SF50: notApplicable(),
    groundOral293a_untyped: notApplicable(),
    sim293b_CE525: currentCheck(50),
    sim293b_LR60: notApplicable(),
    sim293b_SF50: notApplicable(),
    sim293b_untyped: notApplicable(),
    competencyCheck293: notApplicable(),
    instrumentCheck297: currentCheck(40),
    lineCheck299: currentCheck(70),
    recurrentTraining351: currentCheck(90),
    crmTraining330: dueOn(220),
    hazmatTraining: currentCheck(30),
    tfsspTraining: dueOn(180),
  });
  const profiles = ['meets', 'caution', 'short', 'from-certificate', 'meets', 'meets', 'meets', 'unenrolled'];

  const logbooks = [];
  const currencies = [];
  const pilotDocs = [];

  T.crew.forEach((person, index) => {
    const profile = profiles[index] || 'meets';
    const hours = { ...baseHours, timeInType: baseHours.timeInType.map((entry) => ({ ...entry })) };
    const currency = { uid: person.uid, pilotName: person.name, ...checks() };
    const certificate = {
      level: 'ATP',
      instrument: true,
      multiEngine: true,
      typeRatings: ['CE-525', 'LR-60'],
      typeVerified: true,
      country: 'United States',
    };
    const background = { employment: 'Full Time', accident: false, enforcement: false };
    let drugAlcohol = {
      enrolled: true,
      enrolledDate: ymd(-800),
      programName: 'Company DOT/FAA program',
    };
    if (profile === 'caution') {
      currency.recurrentTraining351 = dueOn(18);
      certificate.level = 'Commercial';
    } else if (profile === 'short') {
      hours.turbine = 180;
      hours.timeInType = [{ type: primary, hours: 40, picHours: 12 }];
      currency.lineCheck299 = dueOn(-12);
      certificate.level = 'Commercial';
      certificate.typeVerified = false;
    } else if (profile === 'from-certificate') {
      certificate.level = '';
      certificate.instrument = null;
      certificate.multiEngine = null;
      certificate.typeRatings = [];
      pilotDocs.push({
        id: `pdoc-${person.uid}`,
        uid: person.uid,
        docType: 'certificate',
        certType: 'ATP',
        ratings: `Instrument, Multi-engine, ${primary}`,
        documentNumber: 'DO-NOT-SHOW-4491',
        dob: '1981-04-02',
        holderName: person.name,
        uploadedAt: Date.now() - 86400000,
      });
    } else if (profile === 'unenrolled') {
      drugAlcohol = { enrolled: false, enrolledDate: '', programName: '' };
    }
    const snapshot = {
      ...hours,
      timeInType: hours.timeInType.map((entry) => ({ ...entry })),
    };
    logbooks.push({
      uid: person.uid,
      pilotName: person.name,
      hours: snapshot,
      baseline: {
        asOf: ymd(-2),
        source: index === 4 ? 'Wyvern' : 'manual',
        hours: {
          ...snapshot,
          timeInType: snapshot.timeInType.map((entry) => ({ ...entry })),
        },
      },
      certificate,
      background,
      drugAlcohol,
      internalNotes: profile === 'meets' && index === 0 ? 'Home address must never reach a broker.' : '',
      updatedAt: Date.now(),
    });
    currencies.push(currency);
  });

  return { logbooks, currencies, pilotDocs };
}
