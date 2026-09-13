import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFleetMapScene,
  buildSelectedFlightOverlay,
  formatLastUpdate,
  resolveAirportPoint,
  resolveFleetMapPosition,
  scheduleLocationForTail,
  withSelectedFlightScene,
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

test('selected airborne overlay adds origin, destination, trail and projected remainder', () => {
  const overlay = buildSelectedFlightOverlay({
    telemetry: {
      airborne: true,
      latitude: 40.1,
      longitude: -74.2,
      origin: 'IAD',
      destination: 'HYA',
    },
    trackPoints: [
      { lat: 38.95, lon: -77.45, altitude: 1200 },
      { lat: 40.1, lon: -74.2, altitude: 28000 },
    ],
  });
  assert.equal(overlay.airports.length, 2);
  assert.equal(overlay.airports[0].tone, 'origin');
  assert.equal(overlay.airports[1].tone, 'destination');
  assert.ok(overlay.trail);
  assert.deepEqual(overlay.projected[0], [40.1, -74.2]);
  assert.equal(overlay.routes.length, 0, 'trail replaces the origin-to-aircraft stub');
});

test('selected overlay without a trail draws the flown stub route', () => {
  const overlay = buildSelectedFlightOverlay({
    telemetry: {
      airborne: true,
      latitude: 40.1,
      longitude: -74.2,
      origin: 'IAD',
      destination: 'HYA',
    },
    trackPoints: [],
  });
  assert.equal(overlay.trail, null);
  assert.equal(overlay.routes.length, 1);
});

test('airport resolver prefers the curated table over API coordinates', () => {
  const iad = resolveAirportPoint('IAD', 1, 2);
  assert.ok(iad);
  assert.notEqual(iad.lat, 1);
});

test('scene helper keeps airborne labels and the selected grounded tail', () => {
  const scene = withSelectedFlightScene({
    aircraft: [
      { id: 'N444AM', airborne: true, showLabel: true },
      { id: 'N286N', airborne: false, showLabel: true },
      { id: 'N651TW', airborne: false, showLabel: true },
    ],
  }, { airports: [{ code: 'IAD' }], routes: [], trail: null, projected: null }, { selectedTail: 'N286N' });
  assert.equal(scene.aircraft.find((item) => item.id === 'N444AM').showLabel, true);
  assert.equal(scene.aircraft.find((item) => item.id === 'N286N').showLabel, true);
  assert.equal(scene.aircraft.find((item) => item.id === 'N651TW').showLabel, false);
  assert.equal(scene.airports[0].code, 'IAD');
});

test('last-update copy stays readable for live telemetry', () => {
  assert.equal(formatLastUpdate(NOW - 10_000, NOW), 'just now');
  assert.equal(formatLastUpdate(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(formatLastUpdate(null, NOW), null);
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
