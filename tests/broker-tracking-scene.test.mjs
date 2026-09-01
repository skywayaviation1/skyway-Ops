import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildBrokerRouteScene } from '../src/tracking-map.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const colors = {
  pending: '#64748b',
  airborne: '#3FA9CC',
  landed: '#10b981',
};

test('airborne broker map retains the full filed route beside flown breadcrumbs', () => {
  const coordinates = {
    KTEB: { lat: 40.8501, lng: -74.0608 },
    KPBI: { lat: 26.6832, lng: -80.0956 },
  };
  const trail = [
    { lat: 40.8, lon: -74.1, altitude_ft: 1000 },
    { lat: 35.0, lon: -77.0, altitude_ft: 35000 },
  ];
  const scene = buildBrokerRouteScene({
    legs: [{ from: 'KTEB', to: 'KPBI', status: { wheels_up: { at: Date.now() } } }],
    lookupCoords: (code) => coordinates[code] || null,
    position: { airborne: true, latitude: 35, longitude: -77 },
    trail,
    phaseForLeg: () => 'airborne',
    phaseColors: colors,
  });

  assert.equal(scene.routes.length, 1);
  assert.deepEqual(scene.routes[0].points, [
    [40.8501, -74.0608],
    [26.6832, -80.0956],
  ]);
  assert.equal(scene.routes[0].kind, 'filed');
  assert.equal(scene.routes[0].dashed, true);
  assert.equal(scene.routes[0].casing, true);
  assert.deepEqual(scene.projected, [
    [35, -77],
    [26.6832, -80.0956],
  ]);
});

test('FlightAware endpoint coordinates restore a filed route missing from the bundle', () => {
  const scene = buildBrokerRouteScene({
    legs: [{ from: 'ZZZ', to: 'YYY' }],
    lookupCoords: () => null,
    position: {
      origin: 'KZZZ',
      destination: 'KYYY',
      originLat: 30.1,
      originLon: -81.2,
      destinationLat: 31.3,
      destinationLon: -80.4,
    },
    phaseForLeg: () => 'airborne',
    phaseColors: colors,
  });
  assert.deepEqual(scene.routes[0].points, [
    [30.1, -81.2],
    [31.3, -80.4],
  ]);
  assert.equal(scene.airports.length, 2);
});

test('public tracking API and map renderer preserve route fallback and contrast', async () => {
  const publicApi = await source('api/trip-public.js');
  const trackingMap = await source('src/TrackingMap.jsx');
  const brokerPage = await source('src/TripTrack.jsx');
  assert.match(publicApi, /originLat: finite\(pos\.originLat\)/);
  assert.match(publicApi, /destinationLon: finite\(pos\.destinationLon\)/);
  assert.match(trackingMap, /if \(r\.casing\)/);
  assert.match(trackingMap, /scene\.projected\.forEach/);
  assert.match(brokerPage, /Filed route/);
  assert.match(brokerPage, /buildBrokerRouteScene/);
});

