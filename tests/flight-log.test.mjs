import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { nextOooi } from '../api/_trip-oooi.js';
import {
  classifyAircraft,
  mergeFlightEntries,
  nightHoursBetween,
  planFlightLogSync,
  proposeLegCredits,
  rollUpPilotHours,
} from '../src/flight-log.js';
import { brokerPilotReport, evaluatePilot } from '../src/pilot-safety.js';
import { findWyvernConflicts, wyvernLogbookDraft } from '../src/wyvern-import.js';

const root = path.resolve(import.meta.dirname, '..');
const miami = { lat: 25.7959, lng: -80.287 };
const lookup = (code) => (String(code).toUpperCase() === 'KMIA' || String(code).toUpperCase() === 'MIA' ? miami : null);

function trip({
  uid = 'leg-1',
  start = '2026-09-20T14:00:00.000Z',
  end = '2026-09-20T16:12:00.000Z',
  pic = 'Ada Lovelace',
  sic = 'Grace Hopper',
  from = 'TVC',
  to = 'IAD',
  tail = 'N286N',
  category = 'REVENUE',
  isFlight = true,
} = {}) {
  return {
    uid,
    start: new Date(start),
    end: new Date(end),
    info: { pic, sic, from, to, tail, category, isFlight, aircraftType: 'Citation CJ3' },
  };
}

const users = [
  { uid: 'ada', name: 'Ada Lovelace' },
  { uid: 'grace', name: 'Grace Hopper' },
];

test('night time uses civil twilight and flags a missing airport', () => {
  const overnight = nightHoursBetween(
    '2026-01-15T02:00:00.000Z',
    '2026-01-15T03:00:00.000Z',
    'KMIA',
    'KMIA',
    lookup,
  );
  const midday = nightHoursBetween(
    '2026-06-15T16:00:00.000Z',
    '2026-06-15T17:00:00.000Z',
    'KMIA',
    'KMIA',
    lookup,
  );
  const missing = nightHoursBetween(
    '2026-01-15T02:00:00.000Z',
    '2026-01-15T03:00:00.000Z',
    'KMIA',
    'ZZZZ',
    lookup,
  );
  assert.ok(overnight.hours >= 0.8, overnight.hours);
  assert.equal(overnight.status, 'computed');
  assert.equal(midday.hours, 0);
  assert.equal(midday.status, 'computed');
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.hours, null);
});

test('FlightAware block time wins, and the schedule is used only after the leg ends', () => {
  const now = Date.parse('2026-09-21T00:00:00.000Z');
  const ended = trip();
  const withActual = proposeLegCredits({
    trips: [ended],
    tripStates: {
      'leg-1': {
        oooi: {
          actualOut: '2026-09-20T14:10:00.000Z',
          actualOff: '2026-09-20T14:16:00.000Z',
          actualOn: '2026-09-20T16:00:00.000Z',
          actualIn: '2026-09-20T16:06:00.000Z',
        },
      },
    },
    aircraftByTail: { N286N: { displayName: 'Citation CJ3', icaoType: 'C25B' } },
    users,
    now,
    lookup,
  });
  assert.equal(withActual.length, 2);
  assert.equal(withActual.find((entry) => entry.role === 'PIC').blockHours, 1.9);
  assert.equal(withActual.find((entry) => entry.role === 'PIC').flightHours, 1.7);
  assert.equal(withActual[0].timeSource, 'flightaware');
  assert.equal(withActual.find((entry) => entry.uid === 'ada').role, 'PIC');
  assert.equal(withActual.find((entry) => entry.uid === 'grace').role, 'SIC');

  const scheduled = proposeLegCredits({ trips: [ended], users, now, lookup });
  assert.equal(scheduled[0].timeSource, 'schedule');
  assert.equal(scheduled[0].blockHours, 2.2);

  const future = proposeLegCredits({
    trips: [trip({ end: '2026-09-22T16:00:00.000Z' })],
    users,
    now,
    lookup,
  });
  assert.equal(future.length, 0);

  const hold = proposeLegCredits({
    trips: [trip({ category: 'HOLD', isFlight: false })],
    users,
    now,
    lookup,
  });
  assert.equal(hold.length, 0);
});

test('a CJ3 credit is multi-engine turbine time in type, and a second pass does not write again', () => {
  const aircraft = classifyAircraft({ displayName: 'Citation CJ3', icaoType: 'C25B' });
  assert.equal(aircraft.multiEngine, true);
  assert.equal(aircraft.turbine, true);
  const desired = proposeLegCredits({
    trips: [trip()],
    aircraftByTail: { N286N: { displayName: 'Citation CJ3', icaoType: 'C25B' } },
    users,
    now: Date.parse('2026-09-21T00:00:00.000Z'),
    lookup,
  });
  const pic = desired.find((entry) => entry.role === 'PIC');
  assert.equal(pic.aircraftType, 'Citation CJ3');
  assert.equal(pic.turbine, true);
  assert.equal(pic.multiEngine, true);
  assert.equal(pic.landings, 1);
  const first = mergeFlightEntries(desired, []);
  assert.equal(first.writes.length, 2);
  const second = mergeFlightEntries(desired, first.entries);
  assert.equal(second.writes.length, 0);
});

test('a manual correction is kept, a cancelled leg is voided, and a missing trip is kept', () => {
  const now = Date.parse('2026-09-21T00:00:00.000Z');
  const desired = proposeLegCredits({ trips: [trip()], users, now, lookup });
  const corrected = { ...desired[0], blockHours: 3, manualOverride: true, status: 'credited' };
  const kept = mergeFlightEntries(desired, [corrected]);
  assert.equal(kept.writes.length, 1);
  assert.equal(kept.entries.find((entry) => entry.role === 'PIC').blockHours, 3);

  const orphan = {
    id: 'ada__leg_PIC_old',
    uid: 'ada',
    role: 'PIC',
    tripUid: 'old-trip',
    status: 'credited',
    blockHours: 1.2,
    manual: false,
    manualOverride: false,
  };
  const plan = planFlightLogSync({
    trips: [trip({ category: 'HOLD', isFlight: false })],
    existingEntries: [{ ...desired[0], status: 'credited' }, orphan],
    logbooks: {},
    users,
    now,
    lookup,
  });
  assert.equal(plan.entryWrites.some((entry) => entry.id === desired[0].id && entry.status === 'void'), true);
  assert.equal(plan.entries.some((entry) => entry.id === orphan.id && entry.status === 'credited'), true);
  assert.equal(planFlightLogSync({ trips: null, existingEntries: [orphan] }).entryWrites.length, 0);
});

test('totals are the baseline plus block time after the as-of date', () => {
  const baseline = {
    asOf: '2026-09-01',
    source: 'Wyvern',
    hours: {
      totalTime: 100,
      pic: 80,
      sic: 20,
      multiEngine: 100,
      turbine: 90,
      night: 10,
      instrument: 40,
      last90Days: 30,
      last6Months: 40,
      last12Months: 80,
      landings: 50,
      timeInType: [{ type: 'Citation CJ3', hours: 25 }],
    },
  };
  const entries = [
    {
      uid: 'ada',
      status: 'credited',
      role: 'PIC',
      blockHours: 2,
      blockIn: '2026-09-20T16:00:00.000Z',
      aircraftType: 'Citation CJ3',
      multiEngine: true,
      turbine: true,
      nightHours: 0.5,
      nightStatus: 'computed',
      landings: 1,
    },
    {
      uid: 'ada',
      status: 'credited',
      role: 'PIC',
      blockHours: 4,
      blockIn: '2026-09-01T18:00:00.000Z',
      aircraftType: 'Citation CJ3',
      multiEngine: true,
      turbine: true,
      nightStatus: 'computed',
      nightHours: 0,
      landings: 1,
    },
  ];
  const rolled = rollUpPilotHours({
    baseline,
    entries,
    now: Date.parse('2026-09-21T00:00:00.000Z'),
  });
  assert.equal(rolled.hours.totalTime, 102);
  assert.equal(rolled.hours.pic, 82);
  assert.equal(rolled.hours.instrument, 40);
  assert.equal(rolled.hours.turbine, 92);
  assert.equal(rolled.hours.landings, 51);
  assert.equal(rolled.hours.timeInType.find((entry) => entry.type === 'Citation CJ3').hours, 27);
  assert.equal(rolled.flownSince.totalTime, 2);
  assert.ok(rolled.hours.last90Days > 2);
  assert.ok(rolled.hours.last90Days < 30);

  const rating = evaluatePilot({
    pilot: { uid: 'ada', name: 'Ada Lovelace' },
    logbook: {
      uid: 'ada',
      hours: rolled.hours,
      baseline,
      hoursMeta: rolled.meta,
      certificate: { level: 'ATP', instrument: true, multiEngine: true, typeRatings: ['CE-525'] },
      drugAlcohol: { enrolled: true },
    },
    currencyDoc: {
      medical: { class: 'First', expirationDate: '2027-06-30' },
      groundOralGeneral293a: { lastDate: '2026-06-01' },
      instrumentCheck297: { lastDate: '2026-06-01' },
      lineCheck299: { lastDate: '2026-06-01' },
      recurrentTraining351: { lastDate: '2026-06-01' },
      crmTraining330: { lastDate: '2026-06-01' },
      hazmatTraining: { lastDate: '2026-06-01' },
      tfsspTraining: { lastDate: '2026-06-01' },
    },
    todayMs: Date.parse('2026-09-21T00:00:00.000Z'),
  });
  const report = brokerPilotReport(rating, { operatorName: 'Example Air', generatedAt: '2026-09-21T00:00:00.000Z' });
  assert.equal(report.hoursAsOf, '2026-09-21');
  assert.equal(report.baselineAsOf, '2026-09-01');
  const blob = JSON.stringify(report);
  assert.equal(blob.includes('555'), false);
  assert.equal(blob.includes('DO-NOT-IMPORT'), false);
  assert.equal(Object.hasOwn(report, 'wyvern'), false);
});

test('a Wyvern import becomes the baseline and ignores hours already flown since', () => {
  const record = {
    name: 'Ada Lovelace',
    hours: { turbine: 500, totalTime: 4000 },
    hoursAsOf: '2026-09-01',
    wyvernId: 'ACES-SAMPLE-3',
  };
  const draft = wyvernLogbookDraft({
    uid: 'ada',
    hours: { turbine: 520, totalTime: 4020 },
    baseline: {
      asOf: '2026-08-01',
      source: 'Wyvern',
      hours: { turbine: 400, totalTime: 3900 },
    },
  }, record, { uid: 'ada', pilotName: 'Ada Lovelace', now: Date.parse('2026-09-27T15:00:00.000Z') });
  assert.equal(draft.baseline.asOf, '2026-09-01');
  assert.equal(draft.baseline.source, 'Wyvern');
  assert.equal(draft.baseline.hours.turbine, 500);
  assert.equal(draft.hours.turbine, 500);
  const conflicts = findWyvernConflicts({
    hours: { turbine: 520 },
    baseline: draft.baseline,
  }, null, record, { uid: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' });
  assert.equal(conflicts.some((item) => item.field === 'turbine'), false);
});

test('a later FlightAware event keeps an earlier out time', () => {
  const merged = nextOooi(
    { actualOut: '2026-09-20T14:00:00.000Z', actualOff: '2026-09-20T14:06:00.000Z' },
    { actualOn: '2026-09-20T16:00:00.000Z', actualIn: '2026-09-20T16:06:00.000Z' },
  );
  assert.equal(merged.actualOut, '2026-09-20T14:00:00.000Z');
  assert.equal(merged.actualIn, '2026-09-20T16:06:00.000Z');
  assert.equal(nextOooi(merged, { actualOn: merged.actualOn }), null);
});

test('the rebuild script refuses to run without a service account', () => {
  const result = spawnSync(process.execPath, ['scripts/rebuild-pilot-hours.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FIREBASE_SERVICE_ACCOUNT_JSON: '' },
  });
  assert.equal(result.status, 2);
});
