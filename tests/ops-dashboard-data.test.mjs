import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExceptions,
  buildFleetRows,
  buildTimeline,
  isFlightLeg,
  summarizeFleet,
} from '../src/ops-dashboard-data.js';

const HOUR = 3600_000;
// Fixed midday anchor so the rolling-window assertions never straddle midnight.
const NOW = new Date('2026-08-03T15:00:00Z').getTime();

function leg(uid, tail, from, to, startOffsetH, durationH, info = {}) {
  return {
    uid,
    start: new Date(NOW + startOffsetH * HOUR),
    end: new Date(NOW + (startOffsetH + durationH) * HOUR),
    info: { tail, from, to, pic: 'ADRIAN J STITTS', isFlight: true, ...info },
  };
}

const airworthy = () => ({ status: 'AIRWORTHY', reasons: [], melOpen: 0 });

test('maintenance and training blocks are not counted as flight legs', () => {
  assert.equal(isFlightLeg(leg('a', 'N1', 'TEB', 'MIA', 1, 2)), true);
  assert.equal(isFlightLeg(leg('b', 'N1', 'FXE', 'FXE', 1, 2)), false, 'same airport');
  assert.equal(isFlightLeg(leg('c', 'N1', 'TEB', 'MIA', 1, 2, { category: 'MX' })), false);
  assert.equal(isFlightLeg(leg('d', 'N1', 'KTEB', 'TEB', 1, 2)), false, 'ICAO/IATA of one airport');
});

test('a live airborne position outranks the schedule', () => {
  const [row] = buildFleetRows({
    fleetTails: ['N286N'],
    trips: [leg('t1', 'N286N', 'TEB', 'MIA', -1, 3)],
    positions: { N286N: { airborne: true, altitude: 41000, groundspeed: 460, origin: 'KTEB', destination: 'KMIA' } },
    deriveAircraftStatus: airworthy,
    now: NOW,
  });
  assert.equal(row.state.id, 'AIRBORNE');
  assert.equal(row.location.kind, 'airborne');
  assert.equal(row.location.label, 'TEB → MIA');
});

test('an open AOG event grounds the aircraft before any squawk is written', () => {
  const [row] = buildFleetRows({
    fleetTails: ['N168ZZ'],
    trips: [leg('t1', 'N168ZZ', 'TEB', 'BOS', 2, 1)],
    positions: {},
    aogEvents: [{ tail: 'N168ZZ', status: 'active', issueDescription: 'Gear actuator leak' }],
    deriveAircraftStatus: airworthy,
    now: NOW,
  });
  assert.equal(row.state.id, 'AOG');
  assert.equal(row.airworthiness.status, 'AOG');
  assert.match(row.airworthiness.reasons[0], /Gear actuator/);
});

test('a resolved AOG event does not ground the aircraft', () => {
  const [row] = buildFleetRows({
    fleetTails: ['N168ZZ'],
    trips: [],
    positions: {},
    aogEvents: [{ tail: 'N168ZZ', status: 'resolved', issueDescription: 'Fixed' }],
    deriveAircraftStatus: airworthy,
    now: NOW,
  });
  assert.notEqual(row.state.id, 'AOG');
});

test('an MEL restricts without grounding, and still reports airborne', () => {
  const [row] = buildFleetRows({
    fleetTails: ['N551FP'],
    trips: [],
    positions: { N551FP: { airborne: true } },
    deriveAircraftStatus: () => ({ status: 'RESTRICTED', reasons: ['MEL 49-11-1'], melOpen: 1 }),
    now: NOW,
  });
  assert.equal(row.state.id, 'AIRBORNE', 'an MEL does not stop the aircraft flying');
  assert.equal(row.airworthiness.status, 'RESTRICTED');
});

test('the next departure is found across midnight, not just the calendar day', () => {
  const lateEvening = new Date('2026-08-03T23:50:00-04:00').getTime();
  const [row] = buildFleetRows({
    fleetTails: ['N444AM'],
    // Departs 01:30 the following calendar day.
    trips: [leg('t1', 'N444AM', 'PBI', 'ASE', (lateEvening - NOW) / HOUR + 1.7, 3)],
    positions: {},
    deriveAircraftStatus: airworthy,
    now: lateEvening,
  });
  assert.ok(row.nextLeg, 'overnight departure must still be surfaced');
  assert.equal(row.nextLeg.uid, 't1');
});

test('exceptions rank critical before warning before info', () => {
  const fleetRows = buildFleetRows({
    fleetTails: ['N1', 'N2'],
    trips: [],
    positions: {},
    aogEvents: [{ tail: 'N1', status: 'active', issueDescription: 'Engine chip light' }],
    deriveAircraftStatus: (tail) => (tail === 'N2'
      ? { status: 'RESTRICTED', reasons: ['MEL 21-1'], melOpen: 1 }
      : airworthy()),
    now: NOW,
  });

  const items = buildExceptions({
    fleetRows,
    crewRows: [],
    squawks: [{ status: 'open', grounding: false, description: 'Reading light' }],
    expenses: [{ status: 'pending', vendor: 'Signature' }],
    trips: [],
    now: NOW,
  });

  const severities = items.map((i) => i.severity);
  assert.deepEqual(
    [...severities].sort((a, b) => severities.indexOf(a) - severities.indexOf(b)),
    severities,
    'already ordered',
  );
  assert.equal(items[0].severity, 'critical');
  assert.match(items[0].title, /N1 is AOG/);
  assert.ok(items.some((i) => i.severity === 'warning' && /MEL/.test(i.title)));
  assert.ok(items.some((i) => i.severity === 'info' && /expense/.test(i.title)));
});

test('a soon departure with no PIC is raised as critical, a distant one is not', () => {
  const soon = buildExceptions({
    fleetRows: [],
    crewRows: [],
    trips: [leg('t1', 'N1', 'TEB', 'MIA', 2, 2, { pic: '' })],
    now: NOW,
  });
  assert.ok(soon.some((i) => i.id === 'nocrew-t1' && i.severity === 'critical'));

  const distant = buildExceptions({
    fleetRows: [],
    crewRows: [],
    trips: [leg('t2', 'N1', 'TEB', 'MIA', 30, 2, { pic: '' })],
    now: NOW,
  });
  assert.equal(distant.some((i) => i.id === 'nocrew-t2'), false);
});

test('illegal crew are raised above crew approaching a limit', () => {
  const items = buildExceptions({
    fleetRows: [],
    crewRows: [
      { uid: 'p2', name: 'Warned Pilot', state: 'ON DUTY', legality: { status: 'warning', warnings: [{ message: 'Approaching 14h' }] } },
      { uid: 'p1', name: 'Illegal Pilot', state: 'ON DUTY', legality: { status: 'illegal', blockers: [{ message: 'Exceeded 14h duty' }] } },
    ],
    trips: [],
    now: NOW,
  });
  assert.match(items[0].title, /Illegal Pilot/);
  assert.equal(items[0].severity, 'critical');
});

test('fleet summary separates grounded aircraft from available ones', () => {
  const fleetRows = buildFleetRows({
    fleetTails: ['N1', 'N2', 'N3'],
    trips: [leg('t1', 'N2', 'TEB', 'MIA', -1, 2), leg('t2', 'N3', 'MIA', 'TEB', 3, 2)],
    positions: { N2: { airborne: true } },
    aogEvents: [{ tail: 'N1', status: 'active' }],
    deriveAircraftStatus: airworthy,
    now: NOW,
  });
  const summary = summarizeFleet(fleetRows, [leg('t1', 'N2', 'TEB', 'MIA', -1, 2), leg('t2', 'N3', 'MIA', 'TEB', 3, 2)], NOW);
  assert.equal(summary.total, 3);
  assert.equal(summary.aog, 1);
  assert.equal(summary.available, 2);
  assert.equal(summary.airborne, 1);
  assert.equal(summary.legsToday, 2);
});

test('the timeline window rolls with the clock and clamps overflowing legs', () => {
  const fleetRows = buildFleetRows({
    fleetTails: ['N1'],
    trips: [
      leg('past', 'N1', 'TEB', 'BOS', -10, 1),   // before the window
      leg('now', 'N1', 'BOS', 'TEB', -0.5, 2),   // straddles now
      leg('far', 'N1', 'TEB', 'LAX', 30, 5),     // beyond the window
    ],
    positions: {},
    deriveAircraftStatus: airworthy,
    now: NOW,
  });

  const timeline = buildTimeline(fleetRows, NOW);
  const ids = timeline.rows[0].blocks.map((b) => b.uid);
  assert.deepEqual(ids, ['now'], 'only legs intersecting the window are drawn');

  const block = timeline.rows[0].blocks[0];
  assert.ok(block.active, 'a leg spanning now is marked active');
  assert.ok(block.left >= 0 && block.left + block.width <= 100.01, 'stays inside the track');
  assert.ok(timeline.nowPct > 0 && timeline.nowPct < 100, 'now marker sits inside the window');
});
