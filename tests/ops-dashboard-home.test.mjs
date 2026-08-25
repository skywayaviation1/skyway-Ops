import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  actualFlightMsForTrip,
  buildOnDutyRows,
  buildTodayFlightRows,
  flightPhase,
  groupOnDutyCrews,
  pilotMatchesAssignment,
} from '../src/ops-dashboard-data.js';

const root = path.resolve(import.meta.dirname, '..');
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const NOW_MS = NOW.getTime();
const at = (hours) => new Date(NOW_MS + hours * 3600_000);

function trip(overrides = {}) {
  return {
    uid: overrides.uid || 'trip-1',
    start: overrides.start || at(-2),
    end: overrides.end || at(1),
    info: {
      tail: overrides.tail || 'N444AM',
      from: overrides.from || 'IAD',
      to: overrides.to || 'HYA',
      pic: overrides.pic || 'Maxwell Hagberg',
      sic: overrides.sic || 'Timothy Woods',
      isFlight: true,
    },
  };
}

test('pilot assignment matching handles full names and punctuation', () => {
  assert.equal(pilotMatchesAssignment('Maxwell Hagberg', 'Hagberg, Maxwell'), true);
  assert.equal(pilotMatchesAssignment('Maxwell T Hagberg', 'Maxwell Hagberg'), true);
  assert.equal(pilotMatchesAssignment('Jake Smith', 'Timothy Woods'), false);
});

test('actual airborne time prefers FlightAware-fired status timestamps', () => {
  const value = actualFlightMsForTrip(
    trip(),
    {
      statuses: {
        wheels_up: { timestamp: NOW_MS - 90 * 60000 },
        landed: { timestamp: NOW_MS - 10 * 60000 },
      },
    },
    null,
    NOW_MS,
  );
  assert.equal(value, 80 * 60000);
});

test('live FlightAware actualOff provides elapsed flight time', () => {
  const t = trip();
  const position = {
    ident: 'N444AM',
    origin: 'KIAD',
    destination: 'KHYA',
    airborne: true,
    actualOff: new Date(NOW_MS - 45 * 60000).toISOString(),
  };
  assert.equal(actualFlightMsForTrip(t, null, position, NOW_MS), 45 * 60000);
  assert.equal(flightPhase(t, null, position, NOW_MS), 'airborne');
});

test('today flight board is sorted and carries scheduled vs actual time', () => {
  const first = trip({ uid: 'first', start: at(-3), end: at(-1) });
  const second = trip({ uid: 'second', tail: 'N286N', start: at(2), end: at(4) });
  const states = new Map([[
    'first',
    {
      statuses: {
        wheels_up: { timestamp: NOW_MS - 3 * 3600_000 },
        landed: { timestamp: NOW_MS - 75 * 60000 },
      },
    },
  ]]);
  const rows = buildTodayFlightRows([second, first], states, {}, NOW_MS);
  assert.deepEqual(rows.map((row) => row.uid), ['first', 'second']);
  assert.equal(rows[0].scheduledMs, 2 * 3600_000);
  assert.equal(rows[0].actualMs, 105 * 60000);
  assert.equal(rows[0].phase, 'landed');
  assert.equal(rows[1].phase, 'scheduled');
});

test('on-duty board shows duty clock and scheduled versus actual FlightAware time', () => {
  const dutyOnAt = NOW_MS - 2 * 3600_000;
  const flight = trip({ start: at(-1), end: at(1) });
  const rows = buildOnDutyRows({
    dutyPeriods: [{
      pilotUid: 'pilot-1',
      pilotName: 'Maxwell Hagberg',
      status: 'on',
      confirmStatus: 'self-attested',
      dutyOnAt,
      tail: 'N444AM',
      role: 'PIC',
      flightTimeMs: 0,
    }],
    trips: [flight],
    tripStates: new Map([[
      flight.uid,
      { statuses: { wheels_up: { timestamp: NOW_MS - 30 * 60000 } } },
    ]]),
    positions: {
      N444AM: {
        ident: 'N444AM',
        origin: 'IAD',
        destination: 'HYA',
        airborne: true,
        actualOff: new Date(NOW_MS - 30 * 60000).toISOString(),
      },
    },
    now: NOW_MS,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remainingMs, 12 * 3600_000);
  assert.equal(rows[0].scheduledFlightMs, 2 * 3600_000);
  assert.equal(rows[0].actualFlightMs, 30 * 60000);
  assert.equal(rows[0].tail, 'N444AM');
});

test('pending paired duty is not shown as currently on duty', () => {
  const rows = buildOnDutyRows({
    dutyPeriods: [{
      pilotUid: 'sic',
      pilotName: 'Pending SIC',
      status: 'on',
      confirmStatus: 'pending',
      dutyOnAt: NOW_MS,
    }],
    now: NOW_MS,
  });
  assert.deepEqual(rows, []);
});

test('admin dashboard renders requested top-to-bottom surfaces', async () => {
  const source = await readFile(path.join(root, 'src/OpsDashboard.jsx'), 'utf8');
  const mapAt = source.indexOf('title="Live fleet tracking"');
  const mailAt = source.indexOf('title="Personal email"');
  const flightsAt = source.indexOf("title=\"Today's flight board\"");
  assert.ok(mapAt > 0 && mailAt > mapAt && flightsAt > mailAt);
  assert.match(source, /mode="personal"/);
  assert.match(source, /mode="shared"/);
  assert.match(source, /Crew currently on duty/);
  assert.match(source, /FlightAware airborne/);
});

test('duty board groups a two-pilot crew with PIC above SIC', () => {
  const dutyOnAt = NOW_MS - 2 * 3600_000;
  const rows = buildOnDutyRows({
    dutyPeriods: [
      { id: 'p-sic', pilotUid: 'sic', pilotName: 'Timothy Woods', status: 'on', confirmStatus: 'self-attested', dutyOnAt, tail: 'N444AM', role: 'SIC', partnerPeriodId: 'p-pic' },
      { id: 'p-pic', pilotUid: 'pic', pilotName: 'Maxwell Hagberg', status: 'on', confirmStatus: 'self-attested', dutyOnAt, tail: 'N444AM', role: 'PIC', partnerPeriodId: 'p-sic' },
    ],
    trips: [],
    now: NOW_MS,
  });
  const crews = groupOnDutyCrews(rows);
  assert.equal(crews.length, 1, 'a paired crew is one row, not two');
  assert.equal(crews[0].paired, true);
  assert.deepEqual(crews[0].members.map((m) => m.role), ['PIC', 'SIC']);
  assert.equal(crews[0].tail, 'N444AM');
});

test('crews are inferred from shared aircraft when duty records are not linked', () => {
  const dutyOnAt = NOW_MS - 3 * 3600_000;
  const rows = buildOnDutyRows({
    dutyPeriods: [
      { id: 'a', pilotUid: 'a', pilotName: 'Dana Whitfield', status: 'on', confirmStatus: 'self-attested', dutyOnAt, tail: 'N20UF', role: 'PIC' },
      { id: 'b', pilotUid: 'b', pilotName: 'Grant Ellis', status: 'on', confirmStatus: 'self-attested', dutyOnAt: dutyOnAt + 10 * 60_000, tail: 'N20UF', role: 'SIC' },
      { id: 'c', pilotUid: 'c', pilotName: 'Melissa Rippy', status: 'on', confirmStatus: 'self-attested', dutyOnAt, tail: 'N651TW', role: 'PIC' },
    ],
    trips: [],
    now: NOW_MS,
  });
  const crews = groupOnDutyCrews(rows);
  assert.equal(crews.length, 2);
  const paired = crews.find((c) => c.paired);
  assert.deepEqual(paired.members.map((m) => m.name), ['Dana Whitfield', 'Grant Ellis']);
  const solo = crews.find((c) => !c.paired);
  assert.equal(solo.members.length, 1);
  assert.equal(solo.members[0].name, 'Melissa Rippy');
});

test('same aircraft far apart in time is not treated as one crew', () => {
  const rows = buildOnDutyRows({
    dutyPeriods: [
      { id: 'a', pilotUid: 'a', pilotName: 'Early Captain', status: 'on', confirmStatus: 'self-attested', dutyOnAt: NOW_MS - 10 * 3600_000, tail: 'N286N', role: 'PIC' },
      { id: 'b', pilotUid: 'b', pilotName: 'Late Officer', status: 'on', confirmStatus: 'self-attested', dutyOnAt: NOW_MS - 30 * 60_000, tail: 'N286N', role: 'SIC' },
    ],
    trips: [],
    now: NOW_MS,
  });
  assert.equal(groupOnDutyCrews(rows).length, 2, 'a later relief pilot is its own crew');
});

test('crew duty clock reports the tightest limit in the pair', () => {
  const rows = buildOnDutyRows({
    dutyPeriods: [
      { id: 'a', pilotUid: 'a', pilotName: 'Captain', status: 'on', confirmStatus: 'self-attested', dutyOnAt: NOW_MS - 13 * 3600_000, tail: 'N1', role: 'PIC' },
      { id: 'b', pilotUid: 'b', pilotName: 'Officer', status: 'on', confirmStatus: 'self-attested', dutyOnAt: NOW_MS - 12 * 3600_000, tail: 'N1', role: 'SIC' },
    ],
    trips: [],
    now: NOW_MS,
  });
  const [crew] = groupOnDutyCrews(rows);
  assert.equal(crew.paired, true);
  assert.equal(crew.remainingMs, 3600_000, 'the captain runs out first, so the crew does');
});
