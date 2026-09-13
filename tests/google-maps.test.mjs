import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import googleMapsConfigHandler from '../api/google-maps-config.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('Google Maps config endpoint reports missing key without a fake success', () => {
  const original = process.env.GOOGLE_MAPS_API_KEY;
  try {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const res = responseCapture();
    googleMapsConfigHandler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.configured, false);
    assert.deepEqual(res.body.missing, ['GOOGLE_MAPS_API_KEY']);
  } finally {
    if (original === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = original;
  }
});

test('Google Maps config endpoint returns deployment browser key without caching', () => {
  const original = process.env.GOOGLE_MAPS_API_KEY;
  try {
    process.env.GOOGLE_MAPS_API_KEY = 'restricted-browser-key';
    const res = responseCapture();
    googleMapsConfigHandler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { configured: true, key: 'restricted-browser-key' });
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  } finally {
    if (original === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = original;
  }
});

test('Google Maps client loader uses runtime configuration and auth failure handling', async () => {
  const loader = await source('src/google-maps.js');
  assert.match(loader, /\/api\/google-maps-config/);
  assert.match(loader, /maps\.googleapis\.com\/maps\/api\/js/);
  assert.match(loader, /gm_authFailure/);
  assert.match(loader, /onGoogleMapsAuthFailure/);
  assert.doesNotMatch(loader, /GOOGLE_MAPS_API_KEY/);
});

test('shared tracking map prefers Apple, then Google, then tile fallbacks', async () => {
  const map = await source('src/TrackingMap.jsx');
  assert.match(map, /loadAppleMapKit\(\)\.catch/);
  assert.match(map, /loadGoogleMaps\(\)\.catch/);
  assert.match(map, /new google\.Map/);
  assert.match(map, /setMapProvider\('google'\)/);
  assert.match(map, /applyBasemap/);
  assert.match(map, /Google Maps authorization failed; using standard basemap/);
  assert.match(map, /Basemap by Google Maps/);
  const appleFirst = map.indexOf('loadAppleMapKit');
  const googleFirst = map.indexOf('loadGoogleMaps');
  assert.ok(appleFirst > 0 && googleFirst > appleFirst);
});

test('CARTO tiles are removed from map fallbacks', async () => {
  const files = [
    'src/tracking-map.js',
    'src/TrackingMap.jsx',
    'src/FlightBoard.jsx',
    'src/FleetTrackingPanel.jsx',
  ];
  for (const file of files) {
    const text = await source(file);
    assert.doesNotMatch(text, /basemaps\.cartocdn\.com/);
    assert.doesNotMatch(text, /carto\.com/i);
  }
});

test('Google Maps loads only from map surfaces, not the app shell', async () => {
  const app = await source('src/App.jsx');
  const index = await source('index.html');
  assert.doesNotMatch(app, /loadGoogleMaps|google-maps\.js|maps\.googleapis\.com/);
  assert.doesNotMatch(index, /maps\.googleapis\.com|GOOGLE_MAPS/);
  const map = await source('src/TrackingMap.jsx');
  assert.match(map, /from '\.\/google-maps\.js'/);
});
