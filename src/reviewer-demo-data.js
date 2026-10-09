// Fictional operating day for the App Review sandbox.
// Every person, customer, and registration here is invented. The seed script
// writes this into the named `appreview` database and can rebuild it on demand.

import { APP_REVIEWER_EMAIL } from './reviewer-account.js';

export const DEMO_TAILS = Object.freeze(['N551SK', 'N882SK']);

export const DEMO_AIRCRAFT_BY_TAIL = Object.freeze({
  N551SK: {
    displayName: 'Citation Latitude',
    icaoType: 'C68A',
    homeBase: 'KOPF',
    serialNumber: 'C68A-DEMO-551',
  },
  N882SK: {
    displayName: 'Citation XLS+',
    icaoType: 'C56X',
    homeBase: 'KOPF',
    serialNumber: 'C56X-DEMO-882',
  },
});

export const DEMO_PIC = 'Avery Lang';
export const DEMO_SIC = 'Jordan Hale';

const AIRPORTS = {
  OPF: [25.907, -80.2784],
  PBI: [26.6832, -80.0956],
  TEB: [40.8501, -74.0608],
  BOS: [42.3656, -71.0096],
  FXE: [26.1973, -80.1707],
};

function at(now, dayOffset, hour, minute) {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  d.setSeconds(0, 0);
  return d;
}

function iso(date) {
  return date.toISOString();
}

function localDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function trip({
  uid, start, end, tail, from, to, pax, customer, pic, sic, legType,
}) {
  const category = legType === 'REPO' ? 'REPO' : 'REVENUE';
  return {
    uid,
    start: iso(start),
    end: iso(end),
    info: {
      tail,
      from,
      to,
      pax,
      customer,
      broker: customer ? 'dispatch@northwind-demo.example' : '',
      pic,
      sic,
      legType,
      category,
      isFlight: true,
      isOps: true,
      aircraftType: DEMO_AIRCRAFT_BY_TAIL[tail]?.displayName || '',
      fromFbo: 'Signature Flight Support',
      toFbo: 'Atlantic Aviation',
      demoTrackingUrl: '/trip-track?token=demo-sandbox',
    },
  };
}

const PAX = [
  { id: 'pax-morgan', firstName: 'Morgan', lastName: 'Ellis', dob: '1984-03-12', weight: 168, gender: 'F' },
  { id: 'pax-riley', firstName: 'Riley', lastName: 'Chen', dob: '1991-11-02', weight: 154, gender: 'X' },
  { id: 'pax-samir', firstName: 'Samir', lastName: 'Patel', dob: '1976-07-28', weight: 182, gender: 'M' },
];

/**
 * Build the full sandbox snapshot. Dates are relative to `now` so a reset
 * always leaves upcoming and completed trips on the screens.
 */
export function buildReviewerDemo(now = Date.now(), reviewerUid = 'app-reviewer') {
  const activeStart = new Date(now - 45 * 60 * 1000);
  const activeEnd = new Date(now + 2 * 60 * 60 * 1000);
  const yesterday = at(now, -1, 9, 30);
  const yesterdayEnd = at(now, -1, 12, 15);
  const yesterdayRepo = at(now, -1, 14, 0);
  const yesterdayRepoEnd = at(now, -1, 14, 40);
  const tomorrow = at(now, 1, 11, 0);
  const tomorrowEnd = at(now, 1, 13, 40);
  const later = at(now, 2, 15, 10);
  const laterEnd = at(now, 2, 18, 5);
  const older = at(now, -2, 16, 0);
  const olderEnd = at(now, -2, 16, 35);

  const trips = [
    trip({
      uid: 'demo-completed-older',
      start: older,
      end: olderEnd,
      tail: 'N882SK',
      from: 'PBI',
      to: 'FXE',
      pax: 2,
      customer: 'Harborline Sample Travel',
      pic: DEMO_PIC,
      sic: DEMO_SIC,
      legType: 'REVENUE',
    }),
    trip({
      uid: 'demo-completed-yesterday',
      start: yesterday,
      end: yesterdayEnd,
      tail: 'N551SK',
      from: 'TEB',
      to: 'OPF',
      pax: 4,
      customer: 'Northwind Demo Charter',
      pic: DEMO_PIC,
      sic: DEMO_SIC,
      legType: 'REVENUE',
    }),
    trip({
      uid: 'demo-completed-repo',
      start: yesterdayRepo,
      end: yesterdayRepoEnd,
      tail: 'N551SK',
      from: 'OPF',
      to: 'PBI',
      pax: 0,
      customer: '',
      pic: DEMO_PIC,
      sic: DEMO_SIC,
      legType: 'REPO',
    }),
    trip({
      uid: 'demo-active',
      start: activeStart,
      end: activeEnd,
      tail: 'N551SK',
      from: 'PBI',
      to: 'TEB',
      pax: 3,
      customer: 'Northwind Demo Charter',
      pic: DEMO_PIC,
      sic: DEMO_SIC,
      legType: 'REVENUE',
    }),
    trip({
      uid: 'demo-upcoming-tomorrow',
      start: tomorrow,
      end: tomorrowEnd,
      tail: 'N882SK',
      from: 'TEB',
      to: 'BOS',
      pax: 5,
      customer: 'Harborline Sample Travel',
      pic: DEMO_PIC,
      sic: DEMO_SIC,
      legType: 'REVENUE',
    }),
    trip({
      uid: 'demo-upcoming-later',
      start: later,
      end: laterEnd,
      tail: 'N551SK',
      from: 'BOS',
      to: 'PBI',
      pax: 3,
      customer: 'Northwind Demo Charter',
      pic: DEMO_SIC,
      sic: DEMO_PIC,
      legType: 'REVENUE',
    }),
  ];

  const active = trips.find((t) => t.uid === 'demo-active');
  const [fromLat, fromLon] = AIRPORTS[active.info.from];
  const [toLat, toLon] = AIRPORTS[active.info.to];
  const progress = 0.42;
  const latitude = fromLat + (toLat - fromLat) * progress;
  const longitude = fromLon + (toLon - fromLon) * progress;

  const manifestDate = localDate(activeStart);
  const manifestId = `${manifestDate}_N551SK`;

  return {
    reviewerProfile: {
      email: APP_REVIEWER_EMAIL,
      name: 'App Review',
      callsign: 'REVIEW',
      jetinsightName: DEMO_PIC,
      role: 'ops',
      approved: true,
      active: true,
      authProvider: 'password',
      appReviewer: true,
      sandbox: true,
      updatedAt: now,
    },
    users: [
      {
        uid: 'demo-pilot-jordan',
        email: 'jordan.hale@demo.invalid',
        name: DEMO_SIC,
        callsign: 'JORDAN',
        jetinsightName: DEMO_SIC,
        role: 'crew',
        approved: true,
        active: true,
        authProvider: 'sandbox',
        sandbox: true,
      },
    ],
    trips,
    tripStates: trips.map((t) => ({
      id: t.uid,
      preloadedPax: t.uid === 'demo-active' || t.uid === 'demo-completed-yesterday' ? PAX : [],
      passengers: [],
      statuses: t.uid.startsWith('demo-completed')
        ? { '1': { wheels_up: { at: new Date(t.start).getTime(), completed: true }, landed: { at: new Date(t.end).getTime(), completed: true } } }
        : {},
      brokerEmail: t.info.broker || '',
      autoNotify: false,
      hasCatering: t.info.pax > 0,
      fromFbo: t.info.fromFbo,
      toFbo: t.info.toFbo,
      demo: true,
      tripMeta: {
        tail: t.info.tail,
        from: t.info.from,
        to: t.info.to,
        start: t.start,
        legType: t.info.legType,
      },
    })),
    manifests: [
      {
        id: manifestId,
        date: manifestDate,
        tail: 'N551SK',
        hobbsOut: '2412.4',
        hobbsIn: '',
        hobbsTotal: '',
        waitTime: '',
        dutyTimeIn: '',
        dutyTimeOut: '06:40',
        dutyTimeTotal: '',
        status: 'draft',
        createdBy: 'sandbox',
        legs: [
          {
            tripUid: 'demo-active',
            from: 'PBI',
            to: 'TEB',
            timeOut: '',
            timeIn: '',
            total: '',
            airport: 'TEB',
            cycles: '1',
            nightLdgs: '0',
            passengers: PAX.map((p) => `${p.firstName} ${p.lastName}`),
            toWeight: '',
            maxAllowable: '',
            fwdCG: '',
            toCG: '',
            aftCG: '',
            numPax: PAX.length,
            configuration: 'A',
            legType: 'REVENUE',
            addedAt: now,
            addedBy: 'sandbox',
          },
        ],
      },
    ],
    duty: [
      {
        id: `${reviewerUid}_${now - 26 * 60 * 60 * 1000}`,
        pilotUid: reviewerUid,
        pilotName: 'App Review',
        location: 'TEB',
        tail: 'N551SK',
        tripId: 'demo-completed-yesterday',
        role: 'PIC',
        crewType: 'two',
        assignmentType: 'regular',
        fitForDuty: true,
        priorRestMs: 14 * 60 * 60 * 1000,
        dutyOnAt: yesterday.getTime() - 60 * 60 * 1000,
        dutyOffAt: yesterdayRepoEnd.getTime() + 30 * 60 * 1000,
        flightTimeMs: 3.5 * 60 * 60 * 1000,
        status: 'off',
        over14: false,
        overrideStatus: 'none',
        createdAt: yesterday.getTime(),
        updatedAt: yesterdayRepoEnd.getTime(),
      },
      {
        id: `${reviewerUid}_${now - 2 * 60 * 60 * 1000}`,
        pilotUid: reviewerUid,
        pilotName: 'App Review',
        location: 'PBI',
        tail: 'N551SK',
        tripId: 'demo-active',
        role: 'PIC',
        crewType: 'two',
        assignmentType: 'regular',
        fitForDuty: true,
        priorRestMs: 16 * 60 * 60 * 1000,
        dutyOnAt: now - 2 * 60 * 60 * 1000,
        dutyOffAt: null,
        flightTimeMs: 45 * 60 * 1000,
        status: 'on',
        over14: false,
        overrideStatus: 'none',
        createdAt: now - 2 * 60 * 60 * 1000,
        updatedAt: now,
      },
    ],
    fleet: {
      configured: true,
      managedTails: [...DEMO_TAILS],
      aircraftByTail: DEMO_AIRCRAFT_BY_TAIL,
      updatedAt: now,
      updatedByName: 'App Review sandbox',
    },
    positions: [
      {
        id: 'N551SK',
        ident: 'N551SK',
        airborne: true,
        latitude,
        longitude,
        heading: 28,
        altitude: 41000,
        groundspeed: 430,
        origin: 'KPBI',
        destination: 'KTEB',
        originLat: fromLat,
        originLon: fromLon,
        destinationLat: toLat,
        destinationLon: toLon,
        destinationCity: 'Teterboro',
        estimatedOn: iso(activeEnd),
        progressPercent: Math.round(progress * 100),
        polledAt: now,
        lastKnownAt: now,
        demo: true,
      },
      {
        id: 'N882SK',
        ident: 'N882SK',
        airborne: false,
        latitude: AIRPORTS.TEB[0],
        longitude: AIRPORTS.TEB[1],
        groundedLat: AIRPORTS.TEB[0],
        groundedLon: AIRPORTS.TEB[1],
        heading: 0,
        altitude: 0,
        groundspeed: 0,
        origin: 'KTEB',
        destination: 'KTEB',
        groundedAt: 'KTEB',
        groundedCity: 'Teterboro',
        groundedSince: now - 6 * 60 * 60 * 1000,
        polledAt: now,
        lastKnownAt: now,
        demo: true,
      },
    ],
  };
}
