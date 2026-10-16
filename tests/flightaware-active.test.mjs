import assert from 'node:assert/strict';
import test from 'node:test';
import { selectActiveFlight, positionSaysAirborne } from '../src/flightaware-active.js';
import {
  boardAirbornePlan,
  boardLegPhase,
  placeBoardAircraft,
} from '../src/flight-board-tv.js';

const EIGHT_THIRTY_SEVEN = Date.parse('2026-08-10T12:37:00Z');

test('an open flight with actual_out or progress is the active flight', () => {
  const outOnly = selectActiveFlight([
    { fa_flight_id: 'landed', actual_off: 't', actual_on: 't2' },
    { fa_flight_id: 'out', actual_out: '2026-08-10T12:10:00Z', progress_percent: 0 },
  ]);
  assert.equal(outOnly.fa_flight_id, 'out');

  const progressOnly = selectActiveFlight([
    { fa_flight_id: 'filed', progress_percent: 0 },
    { fa_flight_id: 'enroute', progress_percent: 40 },
    { fa_flight_id: 'cancelled', progress_percent: 50, cancelled: true },
  ]);
  assert.equal(progressOnly.fa_flight_id, 'enroute');
  assert.equal(selectActiveFlight([{ actual_off: 't', actual_on: 'landed' }]), null);
});

test('production position docs count as airborne without a strict boolean', () => {
  assert.equal(positionSaysAirborne({ airborne: true }), true);
  assert.equal(positionSaysAirborne({ airborne: 'true' }), true);
  assert.equal(positionSaysAirborne({ airborne: false, actualOff: '2026-08-10T12:10:00Z' }), true);
  assert.equal(positionSaysAirborne({ airborne: false, actualOut: '2026-08-10T12:10:00Z' }), true);
  assert.equal(positionSaysAirborne({ airborne: false, progressPercent: 42 }), true);
  assert.equal(positionSaysAirborne({ airborne: false, groundspeed: 420, altitude: 41000 }), true);
  assert.equal(positionSaysAirborne({
    airborne: false,
    actualOff: '2026-08-10T08:00:00Z',
    actualOn: '2026-08-10T10:00:00Z',
    groundspeed: 0,
  }), false);
  assert.equal(positionSaysAirborne({ airborne: false, groundspeed: 12, altitude: 0 }), false);
  assert.equal(positionSaysAirborne(null), false);
});

test('a 9:00 departure is airborne at 8:37 even when FlightAware says parked', () => {
  const flying = {
    uid: 'n341',
    start: '2026-08-10T13:00:00Z',
    end: '2026-08-10T14:30:00Z',
    info: { tail: 'N341CJ', from: 'IAD', to: 'GYH', tripCode: 'K7GYHX' },
  };
  const later = {
    uid: 'later',
    start: '2026-08-10T15:00:00Z',
    end: '2026-08-10T17:00:00Z',
    info: { tail: 'N341CJ', from: 'GYH', to: 'TEB', tripCode: 'L8TEBQ' },
  };
  const landed = {
    uid: 'done',
    start: '2026-08-10T11:00:00Z',
    end: '2026-08-10T12:20:00Z',
    info: { tail: 'N999XX', from: 'TEB', to: 'PBI', tripCode: 'D0NEXX' },
  };
  const positions = {
    N341CJ: { airborne: false, origin: 'KIAD', destination: 'KGYH', groundspeed: 0 },
    N999XX: { airborne: false, actualOff: '2026-08-10T11:05:00Z', actualOn: '2026-08-10T12:15:00Z' },
  };
  const states = new Map([['done', { completed: true }]]);
  const plan = boardAirbornePlan({
    trips: [flying, later, landed],
    positions,
    tripStates: states,
    now: EIGHT_THIRTY_SEVEN,
  });
  assert.equal(plan.get('N341CJ')?.uid, 'n341');
  assert.equal(plan.has('N999XX'), false);
  assert.equal(boardLegPhase({ trip: flying, stepPhase: 'pending', airborneTrip: plan.get('N341CJ'), now: EIGHT_THIRTY_SEVEN }), 'airborne');
  assert.equal(boardLegPhase({ trip: later, stepPhase: 'pending', airborneTrip: plan.get('N341CJ'), now: EIGHT_THIRTY_SEVEN }), 'pending');
  assert.equal(boardLegPhase({ trip: landed, stepPhase: 'landed', airborneTrip: null, now: EIGHT_THIRTY_SEVEN }), 'landed');

  const placed = placeBoardAircraft([
    { id: 'N341CJ', tail: 'N341CJ', lat: 38.94, lon: -77.46, airborne: false, departureLabel: '9:00 AM EDT' },
  ], {
    plan,
    positions,
    now: EIGHT_THIRTY_SEVEN,
    timeZone: 'America/New_York',
  });
  const marker = placed.find((item) => item.tail === 'N341CJ');
  assert.equal(marker.airborne, true);
  assert.equal(marker.tripId, 'K7GYHX');
  assert.equal(marker.origin, 'IAD');
  assert.equal(marker.destination, 'KGYH');
  assert.equal(marker.departureLabel, null);
  assert.match(marker.etaLabel, /AM|PM/);
  assert.ok(Number.isFinite(marker.lat) && Number.isFinite(marker.lon));
});

test('actual_out without coordinates still places the icon on the route', () => {
  const trip = {
    uid: 'out',
    start: '2026-08-10T12:00:00Z',
    end: '2026-08-10T14:00:00Z',
    info: { tail: 'N651TW', from: 'APF', to: 'DFW', tripCode: 'R4NCBX' },
  };
  const plan = boardAirbornePlan({
    trips: [trip],
    positions: {
      N651TW: { airborne: false, actualOut: '2026-08-10T12:05:00Z', origin: 'KAPF', destination: 'KDFW' },
    },
    now: Date.parse('2026-08-10T13:00:00Z'),
  });
  assert.equal(plan.get('N651TW')?.uid, 'out');
  const placed = placeBoardAircraft([], {
    plan,
    positions: { N651TW: { airborne: false, actualOut: '2026-08-10T12:05:00Z' } },
    now: Date.parse('2026-08-10T13:00:00Z'),
    timeZone: 'America/New_York',
  });
  const marker = placed.find((item) => item.tail === 'N651TW');
  assert.equal(marker.airborne, true);
  assert.equal(marker.tripId, 'R4NCBX');
  assert.ok(marker.lat > 26 && marker.lat < 33);
});

test('a landing recorded after departure is not promoted', () => {
  const trip = {
    uid: 'down',
    start: '2026-08-10T12:00:00Z',
    end: '2026-08-10T14:00:00Z',
    info: { tail: 'N20UF', from: 'TEB', to: 'PBI', tripCode: 'M8VTQD' },
  };
  const plan = boardAirbornePlan({
    trips: [trip],
    positions: { N20UF: { airborne: false, actualOff: '2026-08-10T12:04:00Z', actualOn: '2026-08-10T13:40:00Z' } },
    now: Date.parse('2026-08-10T13:50:00Z'),
  });
  assert.equal(plan.has('N20UF'), false);
  assert.equal(boardLegPhase({
    trip,
    stepPhase: 'pending',
    airborneTrip: null,
    now: Date.parse('2026-08-10T15:10:00Z'),
  }), 'landed');
});
