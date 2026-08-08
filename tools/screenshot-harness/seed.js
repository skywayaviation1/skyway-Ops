/* Seeds the in-memory dataset before the app mounts.
 *
 * Wherever the app exposes a write function, the seed calls it rather than
 * hand-writing documents: the records then carry exactly the shape the read
 * paths and legality engine expect.
 */

import { readDoc, seedDoc } from './mock/store.js';
import { CURRENT_USER_UID, FLEET, PILOTS, USERS, fleetType } from './data/roster.js';
import { buildPositions, buildTripStates, HOUR, MIN } from './data/schedule.js';

import { createMelDeferral, createSquawk, upsertAircraft } from '../../src/firebase-maint.js';
import { adminAddBackfillPeriod, startDuty } from '../../src/firebase-duty-v2.js';
import { savePilotCurrency } from '../../src/firebase-currency.js';
import { createAML } from '../../src/firebase-aml.js';

const DAY = 24 * HOUR;

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function seedAll(now = Date.now()) {
  seedUsers();
  seedTrips(now);
  await seedFleetRecords();
  await seedMaintenance(now);
  await seedDuty(now);
  await seedCurrency(now);
  await seedAml(now);
  seedExpenses(now);
  seedWear(now);
  seedWallet();
  seedLodging(now);
  seedAog(now);
  seedFleetPositions(now);
  seedConfig();
}

function seedFleetPositions(now) {
  // The flight board reads positions the FlightAware cron writes to Firestore,
  // rather than calling the API itself.
  for (const position of buildPositions(now)) {
    seedDoc(`flightaware-state/${position.ident}`, {
      ...position,
      cachedAt: now - 40 * 1000,
      updatedAt: now - 40 * 1000,
    });
  }
}

function seedConfig() {
  // Live tracking and the duty tracker are admin-controlled feature flags.
  seedDoc('flightaware/config', {
    trackingEnabled: true,
    dutyTrackerEnabled: true,
    dutyAlertEmails: ['d.whitfield@flyskyway.com', 'm.ruiz@flyskyway.com'],
  });
}

function seedUsers() {
  for (const user of USERS) {
    seedDoc(`users/${user.uid}`, {
      name: user.name,
      email: user.email,
      role: user.role,
      title: user.title || '',
      certificateNumber: user.certificateNumber || null,
      approved: true,
      active: true,
      createdAt: Date.now() - 400 * DAY,
    });
  }
}

function seedTrips(now) {
  const byName = {};
  for (const user of USERS) byName[user.name] = user;
  for (const { id, data } of buildTripStates(now, byName)) {
    seedDoc(`trip-state/${id}`, data);
  }
}

async function seedFleetRecords() {
  for (const aircraft of FLEET) {
    await upsertAircraft(aircraft.tail, {
      model: aircraft.type,
      homeBase: aircraft.base,
      active: true,
    });
  }
}

const SQUAWKS = [
  {
    tail: 'N20UF',
    description: 'Left main brake wear indicator at limit. Aircraft grounded pending brake assembly replacement — parts on order from Elliott Aviation.',
    grounding: true,
    byName: 'Hank Boyle',
    byRole: 'maint',
    ageHours: 62,
  },
  {
    tail: 'N168ZZ',
    description: 'Cabin aft divider light flickering intermittently on ground power. Cosmetic only, no ops impact.',
    byName: 'Anthony Pruitt',
    byRole: 'crew',
    ageHours: 26,
  },
  {
    tail: 'N444AM',
    description: 'Copilot windshield heat annunciator slow to extinguish after start. Monitored on last three legs.',
    byName: 'Ken Alvarez',
    byRole: 'crew',
    ageHours: 9,
  },
  {
    tail: 'N551FP',
    description: 'No. 2 engine oil consumption trending 0.4 qt above fleet average. Trend monitoring opened.',
    byName: 'Luis Ferrer',
    byRole: 'maint',
    ageHours: 44,
  },
  {
    tail: 'N286N',
    description: 'Forward baggage door seal scuffed. Deferred under MEL 52-10-01 pending seal delivery.',
    byName: 'Miles Turner',
    byRole: 'crew',
    ageHours: 130,
  },
];

async function seedMaintenance(now) {
  for (const squawk of SQUAWKS) {
    const id = await createSquawk({
      tail: squawk.tail,
      description: squawk.description,
      grounding: squawk.grounding,
      byName: squawk.byName,
      byRole: squawk.byRole,
      byUid: USERS.find((user) => user.name === squawk.byName)?.uid || null,
    });
    // createSquawk stamps "now"; back-date so the board shows real age.
    const path = `maint-squawks/${id}`;
    seedDoc(path, {
      ...readDoc(path),
      reportedAt: now - squawk.ageHours * HOUR,
      createdAt: now - squawk.ageHours * HOUR,
      updatedAt: now - squawk.ageHours * HOUR,
    });
  }

  await createMelDeferral({
    tail: 'N286N',
    category: 'C',
    description: 'Forward baggage compartment door seal damaged',
    melItemRef: '52-10-01',
    partDeferred: 'Forward baggage door seal',
    melItemDescription: 'Baggage compartment doors — seal may be inoperative provided door latching and locking is verified before each departure.',
    remarks: 'Seal on order, ETA 4 days. Latch check added to preflight.',
    deferredAt: now - 5 * DAY,
  });

  await createMelDeferral({
    tail: 'N651TW',
    category: 'B',
    description: 'No. 2 landing light inoperative',
    melItemRef: '33-40-01',
    partDeferred: 'Right wing landing light',
    melItemDescription: 'Landing lights — one may be inoperative provided operations are conducted in day VMC only.',
    remarks: 'Day VMC restriction briefed to crews. Bulb arriving tomorrow.',
    deferredAt: now - 2 * DAY,
  });
}

/* ---------------------------------------------------------------------------
   Duty and rest
   ------------------------------------------------------------------------- */

const DUTY_HISTORY_DAYS = 46;

/* Standing crew pairings — the seat each pilot normally occupies. */
const SEAT = {
  'Ken Alvarez': 'PIC',
  'Sarah Boyd': 'SIC',
  'Devin Cross': 'PIC',
  'Rachel Nakamura': 'SIC',
  'Anthony Pruitt': 'PIC',
  'Grace Lindstrom': 'SIC',
  'Miles Turner': 'PIC',
  'Owen Wexler': 'SIC',
};

/* Crews fly multi-day trips, so duty history comes in blocks: three days on,
 * four off, staggered per pairing. Hours vary the way real trips do, and one
 * day runs past the 14-hour regular limit so the legality engine has something
 * true to flag. */
const PAIRINGS = [
  { pic: 'Ken Alvarez', sic: 'Sarah Boyd', base: 'TPA', tail: 'N444AM', offset: 0 },
  { pic: 'Devin Cross', sic: 'Rachel Nakamura', base: 'OPF', tail: 'N525CR', offset: 2 },
  { pic: 'Anthony Pruitt', sic: 'Grace Lindstrom', base: 'DAL', tail: 'N168ZZ', offset: 4 },
  { pic: 'Miles Turner', sic: 'Owen Wexler', base: 'PBI', tail: 'N551FP', offset: 5 },
];

const DAY_HOURS = [11.4, 9.2, 12.6, 8.6, 10.9, 13.2, 9.7, 11.1, 10.2, 12.9, 8.9, 11.8];

async function seedDuty(now) {
  for (const pairing of PAIRINGS) {
    let sequence = 0;
    for (let daysBack = DUTY_HISTORY_DAYS; daysBack >= 3; daysBack -= 1) {
      // Three consecutive duty days out of every seven.
      if ((daysBack + pairing.offset) % 7 >= 3) continue;
      let dutyHours = DAY_HOURS[sequence % DAY_HOURS.length];
      // One deliberate excursion past the 14-hour regular-assignment limit.
      if (pairing.pic === 'Ken Alvarez' && daysBack === 24) dutyHours = 14.1;
      const startHour = 6 + (sequence % 3) * 2;
      const dutyOnAt = startOfLocalDay(now - daysBack * DAY) + startHour * HOUR + (sequence % 4) * 15 * MIN;
      const dutyOffAt = dutyOnAt + dutyHours * HOUR;
      const priorRestMs = ((daysBack + pairing.offset) % 7 === 0 ? 34 : 10.4 + (sequence % 6) * 0.8) * HOUR;

      for (const name of [pairing.pic, pairing.sic]) {
        // eslint-disable-next-line no-await-in-loop
        await adminAddBackfillPeriod({
          pilotUid: byName(name).uid,
          pilotName: name,
          editedBy: CURRENT_USER_UID,
          dutyOnAt,
          dutyOffAt,
          flightTimeMs: Math.min(dutyHours - 3.4, 8.4) * HOUR,
          crewType: 'two',
          assignmentType: 'regular',
          role: SEAT[name] || 'PIC',
          priorRestMs,
          location: pairing.base,
          tail: pairing.tail,
          note: 'Imported from JetInsight duty history',
        });
      }
      sequence += 1;
    }
  }

  // Crews on duty right now.
  await startDuty({
    pilotUid: byName('Ken Alvarez').uid,
    pilotName: 'Ken Alvarez',
    fitForDuty: true,
    assignmentType: 'regular',
    crewType: 'two',
    role: 'PIC',
    tail: 'N444AM',
    location: 'TEB',
    dutyOnAt: now - 5.4 * HOUR,
    priorRestMs: 12.6 * HOUR,
  });
  await startDuty({
    pilotUid: byName('Sarah Boyd').uid,
    pilotName: 'Sarah Boyd',
    fitForDuty: true,
    assignmentType: 'regular',
    crewType: 'two',
    role: 'SIC',
    tail: 'N444AM',
    location: 'TEB',
    dutyOnAt: now - 5.4 * HOUR,
    priorRestMs: 11.2 * HOUR,
  });
  await startDuty({
    pilotUid: byName('Devin Cross').uid,
    pilotName: 'Devin Cross',
    fitForDuty: true,
    assignmentType: 'regular',
    crewType: 'two',
    role: 'PIC',
    tail: 'N525CR',
    location: 'HPN',
    dutyOnAt: now - 1.3 * HOUR,
    priorRestMs: 15.4 * HOUR,
  });
  await startDuty({
    pilotUid: byName('Rachel Nakamura').uid,
    pilotName: 'Rachel Nakamura',
    fitForDuty: true,
    assignmentType: 'regular',
    crewType: 'two',
    role: 'SIC',
    tail: 'N525CR',
    location: 'HPN',
    dutyOnAt: now - 1.3 * HOUR,
    priorRestMs: 14.1 * HOUR,
  });

  // Yesterday's crew: off duty, inside required rest.
  for (const [name, hours] of [['Anthony Pruitt', 12.9], ['Grace Lindstrom', 12.9]]) {
    // eslint-disable-next-line no-await-in-loop
    await adminAddBackfillPeriod({
      pilotUid: byName(name).uid,
      pilotName: name,
      editedBy: CURRENT_USER_UID,
      dutyOnAt: now - (hours + 2.4) * HOUR,
      dutyOffAt: now - 2.4 * HOUR,
      flightTimeMs: 6.1 * HOUR,
      crewType: 'two',
      assignmentType: 'regular',
      role: SEAT[name],
      priorRestMs: 13.4 * HOUR,
      location: 'DAL',
      tail: 'N168ZZ',
      note: 'Closed at end of trip',
    });
  }
}

function byName(name) {
  return USERS.find((user) => user.name === name);
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/* ---------------------------------------------------------------------------
   Currency and training
   ------------------------------------------------------------------------- */

const CURRENCY_PLAN = {
  'Ken Alvarez': { takeoffLanding: -6, nightCurrency: -21, instrumentCurrency: -44, competencyCheck293: -138, instrumentCheck297: -44, lineCheck299: -138, recurrentTraining351: -95, medical: 214, medicalClass: '1st Class' },
  'Sarah Boyd': { takeoffLanding: -3, nightCurrency: -35, instrumentCurrency: -166, competencyCheck293: -352, instrumentCheck297: -166, lineCheck299: -300, recurrentTraining351: -171, medical: 22, medicalClass: '1st Class' },
  'Devin Cross': { takeoffLanding: -8, nightCurrency: -12, instrumentCurrency: -61, competencyCheck293: -201, instrumentCheck297: -61, lineCheck299: -201, recurrentTraining351: -118, medical: 402, medicalClass: '1st Class' },
  'Rachel Nakamura': { takeoffLanding: -11, nightCurrency: -74, instrumentCurrency: -173, competencyCheck293: -246, instrumentCheck297: -173, lineCheck299: -246, recurrentTraining351: -184, medical: 58, medicalClass: '2nd Class' },
  'Anthony Pruitt': { takeoffLanding: -2, nightCurrency: -18, instrumentCurrency: -96, competencyCheck293: -119, instrumentCheck297: -96, lineCheck299: -119, recurrentTraining351: -41, medical: 311, medicalClass: '1st Class' },
  'Grace Lindstrom': { takeoffLanding: -4, nightCurrency: -29, instrumentCurrency: -181, competencyCheck293: -284, instrumentCheck297: -181, lineCheck299: -284, recurrentTraining351: -178, medical: -4, medicalClass: '2nd Class' },
  'Miles Turner': { takeoffLanding: -14, nightCurrency: -88, instrumentCurrency: -122, competencyCheck293: -309, instrumentCheck297: -122, lineCheck299: -309, recurrentTraining351: -151, medical: 127, medicalClass: '1st Class' },
  'Owen Wexler': { takeoffLanding: -9, nightCurrency: -47, instrumentCurrency: -88, competencyCheck293: -176, instrumentCheck297: -88, lineCheck299: -176, recurrentTraining351: -88, medical: 265, medicalClass: '2nd Class' },
};

async function seedCurrency(now) {
  for (const pilot of PILOTS) {
    const plan = CURRENCY_PLAN[pilot.name];
    if (!plan) continue;
    const updates = {};
    for (const key of ['takeoffLanding', 'nightCurrency', 'instrumentCurrency',
      'competencyCheck293', 'instrumentCheck297', 'lineCheck299', 'recurrentTraining351']) {
      updates[key] = { lastDate: isoDay(now + plan[key] * DAY) };
    }
    updates.medical = {
      class: plan.medicalClass,
      expirationDate: isoDay(now + plan.medical * DAY),
      notes: '',
    };
    // eslint-disable-next-line no-await-in-loop
    await savePilotCurrency(pilot.uid, updates, CURRENT_USER_UID, pilot.name);
  }
}

/* ---------------------------------------------------------------------------
   Aircraft maintenance log
   ------------------------------------------------------------------------- */

async function seedAml(now) {
  const entries = [
    {
      tail: 'N20UF',
      discrepancy: 'Left main brake wear pins below minimum limits on preflight inspection. Aircraft grounded pending brake assembly replacement.',
      byName: 'Hank Boyle',
      cert: 'A&P 3388174',
      aftt: '4182.6', hobbs: '4182.6', landings: '3610',
      ageDays: 3,
    },
    {
      tail: 'N286N',
      discrepancy: 'Forward baggage door seal damaged, air noise in cruise above FL300. Request seal replacement.',
      byName: 'Miles Turner',
      cert: 'ATP 3502988',
      aftt: '2914.2', hobbs: '2914.2', landings: '2488',
      ageDays: 5,
    },
    {
      tail: 'N444AM',
      discrepancy: 'Copilot windshield heat annunciator slow to extinguish after engine start. Occurred on three consecutive legs.',
      byName: 'Ken Alvarez',
      cert: 'ATP 3184472',
      aftt: '5620.8', hobbs: '5620.8', landings: '4901',
      ageDays: 8,
    },
    {
      tail: 'N168ZZ',
      discrepancy: 'Cabin aft divider light intermittent on ground power. Ballast replaced per AMM 33-20-00, ops check good.',
      byName: 'Luis Ferrer',
      cert: 'A&P 4102993',
      aftt: '9871.4', hobbs: '9871.4', landings: '7204',
      ageDays: 12,
    },
  ];

  for (const entry of entries) {
    const user = byName(entry.byName);
    const dateMs = now - entry.ageDays * DAY;
    // eslint-disable-next-line no-await-in-loop
    await createAML({
      date: isoDay(dateMs),
      tail: entry.tail,
      serialNumber: null,
      aftt: entry.aftt,
      hobbs: entry.hobbs,
      landings: entry.landings,
      discrepancy: entry.discrepancy,
      requestedBy: user?.uid || null,
      requestedByName: entry.byName,
      requestedByCert: entry.cert,
      createdAtClient: dateMs,
    });
  }
}

/* ---------------------------------------------------------------------------
   Expenses, wallet, lodging, wear, AOG
   ------------------------------------------------------------------------- */

const EXPENSES = [
  {
    vendor: 'Signature Flight Support TEB',
    subtotal: 1184.55, tax: 100.0, total: 1284.55,
    category: 'FBO Fees', by: 'Ken Alvarez', status: 'approved', paidWith: 'capital_one', ageDays: 0,
    lineItems: [
      { description: 'Ramp fee — King Air 350', amount: 385.0 },
      { description: 'Overnight hangar', amount: 640.0 },
      { description: 'Lav service', amount: 159.55 },
    ],
  },
  {
    vendor: 'Cafe Ludwig Catering',
    subtotal: 381.4, tax: 31.5, total: 412.9,
    category: 'Catering', by: 'Ken Alvarez', status: 'approved', paidWith: 'capital_one', ageDays: 0,
    lineItems: [
      { description: 'Breakfast platters (6)', amount: 246.0 },
      { description: 'Fruit and pastry tray', amount: 89.4 },
      { description: 'Delivery', amount: 46.0 },
    ],
  },
  {
    vendor: 'Atlantic Aviation PBI',
    subtotal: 2971.4, tax: 0, total: 2971.4,
    category: 'Fuel', by: 'Sarah Boyd', status: 'needs_review', paidWith: 'amex', ageDays: 1,
    lineItems: [{ description: 'Jet A — 412.6 gal @ 7.20', amount: 2971.4 }],
  },
  {
    vendor: 'Hyatt Place Aspen',
    subtotal: 640.0, tax: 48.0, total: 688.0,
    category: 'Crew Lodging', by: 'Anthony Pruitt', status: 'approved', paidWith: 'amex', ageDays: 1,
    lineItems: [{ description: 'Two crew rooms, one night', amount: 640.0 }],
  },
  {
    vendor: 'Uber',
    subtotal: 74.2, tax: 0, total: 74.2,
    category: 'Ground Transport', by: 'Grace Lindstrom', status: 'approved', paidWith: 'personal', ageDays: 2,
  },
  {
    vendor: 'Business Jet Center DAL',
    subtotal: 3410.18, tax: 0, total: 3410.18,
    category: 'Fuel', by: 'Anthony Pruitt', status: 'approved', paidWith: 'capital_one', ageDays: 3,
    lineItems: [{ description: 'Jet A — 486.4 gal @ 7.01', amount: 3410.18 }],
  },
  {
    vendor: 'Sheltair TPA',
    subtotal: 512.0, tax: 0, total: 512.0,
    category: 'Hangar', by: 'Miles Turner', status: 'approved', paidWith: 'capital_one', ageDays: 6, exported: true,
  },
];

function seedExpenses(now) {
  EXPENSES.forEach((expense, index) => {
    const user = byName(expense.by);
    const id = `demo-exp-${index}`;
    const at = now - expense.ageDays * DAY;
    seedDoc(`expenses/${id}`, {
      id,
      uid: user?.uid || CURRENT_USER_UID,
      authorUid: user?.uid || CURRENT_USER_UID,
      authorName: expense.by,
      vendor: expense.vendor,
      transactionDate: isoDay(at),
      category: expense.category,
      paidWith: expense.paidWith,
      subtotal: expense.subtotal,
      tax: expense.tax,
      tip: null,
      totalAmount: expense.total,
      lineItems: expense.lineItems || [],
      status: expense.status,
      approvedAt: expense.status === 'approved' ? at + 3 * HOUR : null,
      approvedBy: expense.status === 'approved' ? 'demo-acct-traynor' : null,
      approvedByName: expense.status === 'approved' ? 'Bill Traynor' : null,
      exportedAt: expense.exported ? at + 8 * HOUR : null,
      notes: '',
      receiptUrl: '/harness-assets/receipt.svg',
      receiptPath: `receipts/${id}.png`,
      parsedByAi: true,
      tail: index % 2 === 0 ? 'N444AM' : 'N168ZZ',
      createdAt: at,
      updatedAt: at,
    });
  });
}

const CARDS = [
  { nickname: 'Avfuel Contract Card', brand: 'avfuel', last4: '4417', pin: '8842', zip: '33607' },
  { nickname: 'Shell Aviation', brand: 'shell', last4: '9036', pin: '2251', zip: '33607' },
  { nickname: 'Amex Ops Purchasing', brand: 'amex', last4: '1008', pin: '', zip: '33607' },
  { nickname: 'Epic Fuel Card', brand: 'epic', last4: '7723', pin: '5590', zip: '33607' },
];

function seedWallet() {
  CARDS.forEach((card, index) => {
    const id = `demo-card-${index}`;
    seedDoc(`wallet-cards/${id}`, {
      id,
      ...card,
      cardBrand: card.brand,
      updatedAt: Date.now(),
      createdAt: Date.now() - 200 * DAY,
    });
  });
}

function seedLodging(now) {
  const stays = [
    { crew: 'Anthony Pruitt', hotel: 'Hyatt Place Aspen', city: 'Aspen, CO', conf: 'HY-4471902', tripUid: 'ji-2213', nights: 1, startOffset: 0 },
    { crew: 'Grace Lindstrom', hotel: 'Hyatt Place Aspen', city: 'Aspen, CO', conf: 'HY-4471903', tripUid: 'ji-2213', nights: 1, startOffset: 0 },
    { crew: 'Devin Cross', hotel: 'Harbor View Hotel', city: "Martha's Vineyard, MA", conf: 'MV-88214', tripUid: 'ji-2212', nights: 1, startOffset: 0 },
    { crew: 'Rachel Nakamura', hotel: 'Harbor View Hotel', city: "Martha's Vineyard, MA", conf: 'MV-88215', tripUid: 'ji-2212', nights: 1, startOffset: 0 },
    { crew: 'Sarah Boyd', hotel: 'Courtyard Van Nuys', city: 'Van Nuys, CA', conf: 'MR-77190244', tripUid: 'ji-2232', nights: 2, startOffset: 1 },
    { crew: 'Devin Cross', hotel: 'Courtyard Van Nuys', city: 'Van Nuys, CA', conf: 'MR-77190245', tripUid: 'ji-2232', nights: 2, startOffset: 1 },
    { crew: 'Miles Turner', hotel: 'Hutton Hotel Nashville', city: 'Nashville, TN', conf: 'HT-330918', tripUid: 'ji-2241', nights: 1, startOffset: 2 },
    { crew: 'Owen Wexler', hotel: 'Hutton Hotel Nashville', city: 'Nashville, TN', conf: 'HT-330919', tripUid: 'ji-2241', nights: 1, startOffset: 2 },
    { crew: 'Ken Alvarez', hotel: 'Charleston Place', city: 'Charleston, SC', conf: 'CP-11204', tripUid: 'ji-2243', nights: 1, startOffset: 3 },
  ];
  stays.forEach((stay, index) => {
    const user = byName(stay.crew);
    const id = `demo-lodging-${index}`;
    seedDoc(`travel-bookings/${id}`, {
      id,
      type: 'hotel',
      userUid: user?.uid || CURRENT_USER_UID,
      tripUid: stay.tripUid,
      hotelName: stay.hotel,
      hotelBrand: stay.hotel.includes('Hyatt') ? 'Hyatt' : (stay.hotel.includes('Courtyard') ? 'Marriott' : 'Independent'),
      city: stay.city,
      address: stay.city,
      confirmationCode: stay.conf,
      checkInDate: isoDay(now + stay.startOffset * DAY),
      checkOutDate: isoDay(now + (stay.startOffset + stay.nights) * DAY),
      startDate: isoDay(now + stay.startOffset * DAY),
      endDate: isoDay(now + (stay.startOffset + stay.nights) * DAY),
      nights: stay.nights,
      nightlyRate: 289,
      totalCost: 289 * stay.nights,
      bookedByName: 'Marco Ruiz',
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY,
    });
  });
}

function seedWear(now) {
  const items = [
    { tail: 'N444AM', key: 'nose_tire', status: 'good', landings: 4 },
    { tail: 'N444AM', key: 'main_tire_left', status: 'monitor', landings: 4 },
    { tail: 'N444AM', key: 'main_tire_right', status: 'good', landings: 4 },
    { tail: 'N444AM', key: 'brake_left', status: 'monitor', landings: 4 },
    { tail: 'N444AM', key: 'brake_right', status: 'good', landings: 4 },
    { tail: 'N20UF', key: 'brake_left', status: 'grounded', landings: 11 },
    { tail: 'N20UF', key: 'main_tire_left', status: 'replace_soon', landings: 11 },
    { tail: 'N168ZZ', key: 'nose_tire', status: 'good', landings: 7 },
    { tail: 'N168ZZ', key: 'brake_right', status: 'monitor', landings: 7 },
  ];
  items.forEach((item, index) => {
    const id = `${item.tail}_${item.key}`;
    seedDoc(`wear-items/${id}`, {
      id,
      tail: item.tail,
      itemKey: item.key,
      aircraftType: fleetType(item.tail) === 'Learjet 60' ? 'lear60' : 'cj3',
      status: item.status,
      landingsSinceCheck: item.landings,
      lastInspectedAt: now - (index + 1) * 6 * HOUR,
      lastInspectedByName: index % 2 === 0 ? 'Ken Alvarez' : 'Anthony Pruitt',
      photoUrl: '/harness-assets/placeholder.png',
      updatedAt: now - (index + 1) * 6 * HOUR,
      createdAt: now - 60 * DAY,
    });
  });
}

function seedAog(now) {
  const id = 'demo-aog-1';
  const declaredAt = now - 62 * HOUR;
  const reporter = byName('Hank Boyle');
  seedDoc(`aog-events/${id}`, {
    id,
    tail: 'N20UF',
    location: 'SDL',
    fboName: 'Scottsdale Jet Center',
    issueDescription: 'Left main brake wear pins below minimum limits found on preflight inspection. Brake assembly replacement required before return to service.',
    status: 'active',
    reportedAt: declaredAt,
    reportedBy: { uid: reporter?.uid || null, name: 'Hank Boyle', role: 'maint' },
    declaredEmailSent: true,
    coordination: {
      maintLead: 'Hank Boyle',
      technician: 'Luis Ferrer',
      vendor: 'Elliott Aviation — Scottsdale',
      opsContact: 'Marco Ruiz',
    },
    diagnostics: {
      pilotDiscrepancy: 'Brake wear pins flush with housing on LH main during preflight walkaround.',
      troubleshooting: 'Wear pin measurement confirmed below limit per AMM 32-42-00. No hydraulic leak found.',
      oemRecommendation: 'Replace brake assembly. Inspect wheel and axle sleeve on removal.',
    },
    parts: [
      {
        description: 'Brake assembly, LH main',
        partNumber: '5010847-3',
        quantity: 1,
        status: 'in_transit',
        eta: new Date(now + 18 * HOUR).toISOString(),
        vendor: 'Elliott Aviation',
        tracking: '1Z994A2X0399417',
      },
      {
        description: 'Wheel bearing grease, MIL-PRF-81322',
        partNumber: 'MOB-28',
        quantity: 2,
        status: 'delivered',
        vendor: 'Elliott Aviation',
      },
    ],
    shipTo: {
      fboName: 'Scottsdale Jet Center',
      address: '15115 N Airport Dr, Scottsdale AZ 85260',
      attn: 'Luis Ferrer / N20UF',
    },
    personnel: {
      techDeparture: 'Departed TPA on airline, 06:10 local',
      techArrivalEta: 'On site SDL 11:40 local',
      transport: 'Rental car arranged through FBO',
    },
    rtsEstimate: 'Tomorrow 16:00 local, pending brake assembly delivery',
    rtsEstimatePrevious: 'Today 18:00 local',
    currentStatus: 'Brake assembly in transit next-flight-out. Technician on site, wheel removed and axle inspected. Awaiting part to reassemble and complete ops check.',
    openItems: [
      'Confirm brake assembly delivery at FBO',
      'Torque check and leak check after install',
      'Log entry and RTS signature by DOM',
    ],
    nextUpdateDue: new Date(now + 4 * HOUR).toISOString(),
    recipients: ['d.whitfield@flyskyway.com', 'm.ruiz@flyskyway.com'],
    resolvedAt: null,
    resolvedBy: null,
    logEntries: [
      { timestamp: declaredAt, author: 'Hank Boyle', text: 'AOG declared at SDL. Brake wear pins below limits on LH main.' },
      { timestamp: declaredAt + 8 * HOUR, author: 'Hank Boyle', text: 'Elliott Aviation dispatched. Brake assembly located in Wichita, shipping next-flight-out.' },
      { timestamp: declaredAt + 22 * HOUR, author: 'Luis Ferrer', text: 'On site. Wheel removed, axle sleeve serviceable. Awaiting part.' },
      { timestamp: now - 3 * HOUR, author: 'Luis Ferrer', text: 'Tracking shows part out for delivery. RTS estimate updated to tomorrow 16:00 local.' },
    ],
    createdAt: declaredAt,
    updatedAt: now - 3 * HOUR,
  });
}
