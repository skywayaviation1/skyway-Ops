import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFleetMapScene,
  resolveFleetMapPosition,
  scheduleLocationForTail,
} from '../src/fleet-tracking.js';
import {
  mergeFlightAwareState,
  resolveCronFleetTails,
} from '../api/flightaware-cron-poll.js';

const NOW = Date.parse('2026-08-10T12:00:00Z');

test('airborne aircraft use live ADS-B coordinates', () => {
  const point = resolveFleetMapPosition({
    tail: 'N444AM',
    telemetry: { airborne: true, latitude: 40.2, longitude: -74.5, polledAt: NOW },
    now: NOW,
  });
  assert.deepEqual(point, {
    lat: 40.2,
    lon: -74.5,
    airborne: true,
    source: 'live',
    airport: null,
    at: NOW,
  });
});

test('grounded aircraft use the latest landing coordinates', () => {
  const point = resolveFleetMapPosition({
    tail: 'N444AM',
    telemetry: {
      airborne: false,
      groundedAt: 'KHYA',
      groundedLat: 41.6693,
      groundedLon: -70.2804,
      groundedSince: '2026-08-10T10:00:00Z',
    },
    now: NOW,
  });
  assert.equal(point.source, 'last-landing');
  assert.equal(point.airport, 'KHYA');
  assert.equal(point.lat, 41.6693);
});

test('last-known coordinates survive a ground record with no airport coordinates', () => {
  const point = resolveFleetMapPosition({
    tail: 'N444AM',
    telemetry: {
      airborne: false,
      lastKnownLatitude: 41.6,
      lastKnownLongitude: -70.2,
      lastKnownAirport: 'KHYA',
      lastKnownAt: NOW - 1000,
    },
  });
  assert.equal(point.source, 'last-known');
  assert.equal(point.airport, 'KHYA');
});

test('schedule and home base locate aircraft with no telemetry', () => {
  const trips = [{
    info: { tail: 'N444AM', from: 'IAD', to: 'HYA' },
    start: new Date(NOW - 4 * 3600_000),
    end: new Date(NOW - 2 * 3600_000),
  }];
  assert.deepEqual(scheduleLocationForTail('N444AM', trips, NOW), {
    airport: 'HYA',
    source: 'schedule-arrival',
  });
  const scheduled = resolveFleetMapPosition({ tail: 'N444AM', trips, now: NOW });
  assert.equal(scheduled.airport, 'HYA');
  assert.equal(scheduled.source, 'schedule-arrival');

  const home = resolveFleetMapPosition({
    tail: 'N286N',
    trips: [],
    aircraftMeta: { homeBase: 'IAD' },
    now: NOW,
  });
  assert.equal(home.airport, 'IAD');
  assert.equal(home.source, 'home-base');
});

test('fleet scene includes airborne and grounded managed aircraft only', () => {
  const scene = buildFleetMapScene({
    fleetTails: ['N444AM', 'N286N'],
    positions: {
      N444AM: { airborne: true, latitude: 40, longitude: -74 },
      N286N: { airborne: false, groundedAt: 'IAD', groundedLat: 38.95, groundedLon: -77.45 },
      N999XX: { airborne: true, latitude: 20, longitude: -80 },
    },
    trips: [],
    now: NOW,
  });
  assert.deepEqual(scene.aircraft.map((item) => item.tail).sort(), ['N286N', 'N444AM']);
  assert.equal(scene.aircraft.find((item) => item.tail === 'N286N').airborne, false);
  assert.deepEqual(scene.unlocated, []);
});

test('managed fleet config controls the cron tail list', () => {
  assert.deepEqual(
    resolveCronFleetTails({ configured: true, managedTails: [' n444am ', 'N286N', 'N444AM'] }),
    ['N286N', 'N444AM'],
  );
  assert.deepEqual(resolveCronFleetTails({ configured: true, managedTails: [] }), []);
  assert.ok(resolveCronFleetTails(null).includes('N444AM'));
});

test('FlightAware merge preserves last known position during API gaps', () => {
  const previous = {
    ident: 'N444AM',
    airborne: false,
    groundedAt: 'KHYA',
    groundedLat: 41.66,
    groundedLon: -70.28,
    groundedSince: '2026-08-10T10:00:00Z',
    polledAt: NOW - 60000,
  };
  const empty = mergeFlightAwareState(previous, { ident: 'N444AM', airborne: false }, NOW);
  assert.equal(empty.groundedAt, 'KHYA');
  assert.equal(empty.lastKnownLatitude, 41.66);
  assert.equal(empty.dataFresh, true);

  const failed = mergeFlightAwareState(previous, {
    ident: 'N444AM',
    airborne: false,
    error: 'FA 503',
  }, NOW);
  assert.equal(failed.groundedAt, 'KHYA');
  assert.equal(failed.dataFresh, false);
  assert.equal(failed.error, 'FA 503');
});

test('a landing updates the persistent last-known point', () => {
  const merged = mergeFlightAwareState(
    { ident: 'N444AM', airborne: true, latitude: 40, longitude: -74 },
    {
      ident: 'N444AM',
      airborne: false,
      groundedAt: 'KHYA',
      groundedLat: 41.66,
      groundedLon: -70.28,
      groundedSince: '2026-08-10T11:00:00Z',
    },
    NOW,
  );
  assert.equal(merged.lastKnownAirport, 'KHYA');
  assert.equal(merged.lastKnownLatitude, 41.66);
  assert.equal(merged.latitude, 40, 'historical raw coordinate can remain but is not preferred');
});
