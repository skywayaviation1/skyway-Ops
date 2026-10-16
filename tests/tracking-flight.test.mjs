import assert from 'node:assert/strict';
import test from 'node:test';
import { readTripId } from '../src/fleet-tracking.js';
import { buildFlightViewModel, selectFlightLeg } from '../src/tracking-flight.js';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);

function leg(overrides) {
  return {
    uid: 'sky-1001',
    start: new Date(NOW - 70 * 60_000),
    end: new Date(NOW + 40 * 60_000),
    info: {
      tail: 'N444AM',
      from: 'IAD',
      to: 'HYA',
      pax: 4,
      customer: 'Outlier Jets',
      tripCode: 'WEQVQD',
      aircraftType: 'Citation XLS+',
      isFlight: true,
      ...overrides?.info,
    },
    ...overrides,
    info: {
      tail: 'N444AM',
      from: 'IAD',
      to: 'HYA',
      pax: 4,
      customer: 'Outlier Jets',
      tripCode: 'WEQVQD',
      aircraftType: 'Citation XLS+',
      isFlight: true,
      ...overrides?.info,
    },
  };
}

test('selectFlightLeg prefers the airborne origin and destination over the clock', () => {
  const airborne = leg({});
  const next = leg({
    uid: 'sky-1002',
    start: new Date(NOW - 10 * 60_000),
    end: new Date(NOW + HOUR),
    info: { from: 'HYA', to: 'TEB', tripCode: 'P3LHXA' },
  });
  const chosen = selectFlightLeg('N444AM', [airborne, next], {
    airborne: true,
    origin: 'KIAD',
    destination: 'KHYA',
  }, NOW);
  assert.equal(chosen.uid, 'sky-1001');
});

test('flight view reads the trip id only through readTripId and hides a missing segment', () => {
  const trip = leg({});
  const states = new Map([
    [trip.uid, {
      statuses: { wheels_up: { timestamp: NOW - 50 * 60_000 } },
      tripSheetData: { flightNumber: '3218', tripCode: 'not-a-trip-id' },
      paxOverride: null,
    }],
  ]);
  const model = buildFlightViewModel({
    tail: 'n444am',
    telemetry: {
      airborne: true,
      origin: 'KIAD',
      destination: 'KHYA',
      altitude: 41000,
      groundspeed: 448,
      actualOff: new Date(NOW - 50 * 60_000).toISOString(),
      estimatedOn: new Date(NOW + 40 * 60_000).toISOString(),
      progressPercent: 62,
      polledAt: NOW - 20_000,
    },
    trips: [trip],
    tripStates: states,
    now: NOW,
    operatorName: 'Skyway Aviation',
  });

  assert.equal(model.tripId, readTripId(states.get(trip.uid), trip));
  assert.equal(model.tripId, 'WEQVQD');
  assert.equal(model.segmentId, '3218');
  assert.equal(model.customer, 'Outlier Jets');
  assert.equal(model.operator, 'Skyway Aviation');
  assert.equal(model.phase, 'enroute');
  assert.equal(model.originCity, 'Dulles');
  assert.equal(model.destinationCity, 'Hyannis');
  assert.equal(model.pax, 4);
  assert.ok(model.departure?.tz);
  assert.ok(model.arrival?.label?.includes(model.arrival.tz));
  assert.equal(model.progress, 62);
});

test('a numeric trip number and a missing flight number stay off the detail model', () => {
  const trip = leg({ info: { tripCode: '100341' } });
  const model = buildFlightViewModel({
    tail: 'N444AM',
    telemetry: { airborne: false, groundedAt: 'KHYA' },
    trips: [trip],
    tripStates: new Map([[trip.uid, { statuses: {}, tripSheetData: null }]]),
    now: NOW + 2 * HOUR,
    operatorName: 'Skyway Aviation',
  });
  assert.equal(model.tripId, null);
  assert.equal(model.segmentId, null);
});
