import assert from 'node:assert/strict';
import test from 'node:test';

import { etDayBounds } from '../src/duty-crew-change.js';
import { planScheduleResync } from '../src/duty-schedule-resync.js';
import { LIMITS } from '../src/duty-limits.js';

const HOUR = 3600_000;

function leg({ id, start, end, pic, sic, tail = 'N444AM' }) {
  return {
    uid: id,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    info: { tail, pic, sic, from: 'TEB', to: 'PBI', category: 'REVENUE' },
  };
}

test('Oct 1 resync links Daniel then Kameron and clears the single-pilot 8h and 16h flags', () => {
  const day = etDayBounds(2026, 10, 1);
  const on = day.start + 8 * HOUR;
  const danielOff = on + 5 * HOUR;
  const kameronOn = danielOff + 10 * 60_000;
  const off = on + 14 * HOUR;
  const users = [
    { uid: 'uid-matt', name: 'Matt Hale', role: 'crew' },
    { uid: 'uid-daniel', name: 'Daniel Cho', role: 'crew' },
    { uid: 'uid-kameron', name: 'Kameron Blake', role: 'crew' },
  ];
  const periods = [
    {
      id: 'matt-1',
      pilotUid: 'uid-matt',
      pilotName: 'Matt Hale',
      role: 'SIC',
      crewType: 'two',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: on,
      dutyOffAt: danielOff,
      flightTimeMs: 0,
      partnerPeriodId: null,
      tail: 'N444AM',
    },
    {
      id: 'matt-2',
      pilotUid: 'uid-matt',
      pilotName: 'Matt Hale',
      role: 'SIC',
      crewType: 'single',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: kameronOn,
      dutyOffAt: off,
      flightTimeMs: 9.3 * HOUR,
      partnerPeriodId: null,
      tail: 'N444AM',
    },
    {
      id: 'daniel-1',
      pilotUid: 'uid-daniel',
      pilotName: 'Daniel Cho',
      role: 'PIC',
      crewType: 'two',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: on,
      dutyOffAt: danielOff,
      flightTimeMs: 3.1 * HOUR,
      partnerPeriodId: null,
      tail: 'N444AM',
    },
    {
      id: 'kameron-1',
      pilotUid: 'uid-kameron',
      pilotName: 'Kameron Blake',
      role: 'PIC',
      crewType: 'single',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: kameronOn,
      dutyOffAt: off,
      flightTimeMs: 6.2 * HOUR,
      partnerPeriodId: null,
      tail: 'N444AM',
    },
  ];
  const trips = [
    leg({ id: 'am', start: on + HOUR, end: on + 3 * HOUR, pic: 'Daniel Cho', sic: 'Matt Hale' }),
    leg({ id: 'pm', start: kameronOn + HOUR, end: kameronOn + 4 * HOUR, pic: 'Kameron Blake', sic: 'Matt Hale' }),
  ];
  const plan = planScheduleResync({
    periods,
    trips,
    users,
    scope: { kind: 'day', day: '2026-10-01' },
    now: off + 2 * HOUR,
    actorName: 'Jake',
    reason: 'Rebuild Oct 1 crew links after the swap',
  });
  assert.equal(plan.ok, true);
  const matt2 = plan.writes.find((write) => write.id === 'matt-2');
  assert.ok(matt2);
  assert.equal(matt2.patch.crewType, 'two');
  assert.equal(matt2.patch.partnerPeriodId, 'kameron-1');
  assert.equal(matt2.patch.dutyOnAt, undefined);
  assert.equal(matt2.patch.dutyOffAt, undefined);
  assert.equal(matt2.patch.flightTimeMs, undefined);
  assert.equal(matt2.patch.adminEdits.at(-1).by, 'Jake');
  assert.equal(matt2.patch.adminEdits.at(-1).reason, 'Rebuild Oct 1 crew links after the swap');
  assert.equal(matt2.patch.adminEdits.at(-1).from.flightTimeMs, 9.3 * HOUR);
  assert.equal(matt2.patch.adminEdits.at(-1).to.flightTimeMs, 9.3 * HOUR);

  const matt1 = plan.writes.find((write) => write.id === 'matt-1');
  assert.equal(matt1.patch.partnerPeriodId, 'daniel-1');
  const daniel = plan.writes.find((write) => write.id === 'daniel-1');
  assert.equal(daniel.patch.partnerPeriodId, 'matt-1');
  assert.equal(daniel.patch.flightTimeMs, undefined);
  const kameron = plan.writes.find((write) => write.id === 'kameron-1');
  assert.equal(kameron.patch.crewType, 'two');
  assert.equal(kameron.patch.partnerPeriodId, 'matt-2');

  const mattChange = plan.changes.find((change) => change.id === 'matt-2');
  assert.equal(mattChange.limitsBefore.singlePilotFlag, true);
  assert.equal(mattChange.limitsBefore.extendedRest16, true);
  assert.equal(mattChange.limitsBefore.restRequiredMs, LIMITS.EXTENDED_REST_TIER_3_MS);
  assert.equal(mattChange.limitsAfter.singlePilotFlag, false);
  assert.equal(mattChange.limitsAfter.extendedRest16, false);
  assert.equal(mattChange.limitsAfter.restRequiredMs, LIMITS.REST_REQUIRED_BEFORE_MS);
  assert.equal(mattChange.timesUnchanged, true);
  assert.equal(mattChange.flightUnchanged, true);
});

test('resync refuses to write without a reason and skips another day', () => {
  const missing = planScheduleResync({
    periods: [],
    trips: [],
    users: [],
    scope: { kind: 'day', day: '2026-10-01' },
    reason: '   ',
  });
  assert.equal(missing.ok, false);

  const day = etDayBounds(2026, 10, 1);
  const on = day.start + 8 * HOUR;
  const plan = planScheduleResync({
    periods: [{
      id: 'matt-1',
      pilotUid: 'uid-matt',
      pilotName: 'Matt Hale',
      crewType: 'single',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: on,
      dutyOffAt: on + 6 * HOUR,
      flightTimeMs: 2 * HOUR,
      role: 'SIC',
    }],
    trips: [leg({ id: 'am', start: on, end: on + 2 * HOUR, pic: 'Daniel Cho', sic: 'Matt Hale' })],
    users: [
      { uid: 'uid-matt', name: 'Matt Hale' },
      { uid: 'uid-daniel', name: 'Daniel Cho' },
    ],
    scope: { kind: 'day', day: '2026-10-02' },
    reason: 'Wrong day',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.writes.length, 0);
});

test('pilot scope still updates the reciprocal partner link inside the range', () => {
  const day = etDayBounds(2026, 10, 1);
  const on = day.start + 9 * HOUR;
  const plan = planScheduleResync({
    periods: [
      {
        id: 'matt-1',
        pilotUid: 'uid-matt',
        pilotName: 'Matt Hale',
        crewType: 'single',
        status: 'off',
        dutyOnAt: on,
        dutyOffAt: on + 4 * HOUR,
        flightTimeMs: 2 * HOUR,
        role: 'SIC',
        confirmStatus: 'self-attested',
      },
      {
        id: 'daniel-1',
        pilotUid: 'uid-daniel',
        pilotName: 'Daniel Cho',
        crewType: 'single',
        status: 'off',
        dutyOnAt: on,
        dutyOffAt: on + 4 * HOUR,
        flightTimeMs: 2 * HOUR,
        role: 'PIC',
        confirmStatus: 'self-attested',
      },
    ],
    trips: [leg({ id: 'am', start: on, end: on + 2 * HOUR, pic: 'Daniel Cho', sic: 'Matt Hale' })],
    users: [
      { uid: 'uid-matt', name: 'Matt Hale' },
      { uid: 'uid-daniel', name: 'Daniel Cho' },
    ],
    scope: { kind: 'pilot', pilotUid: 'uid-matt', startDay: '2026-10-01', endDay: '2026-10-01' },
    reason: 'Matt was left unlinked',
  });
  assert.equal(plan.ok, true);
  const ids = plan.writes.map((write) => write.id).sort();
  assert.deepEqual(ids, ['daniel-1', 'matt-1']);
  assert.equal(plan.writes.every((write) => write.patch.flightTimeMs === undefined), true);
});
