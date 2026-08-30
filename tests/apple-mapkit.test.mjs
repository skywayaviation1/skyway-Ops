import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createMapKitToken,
  decodeMapKitToken,
  mapKitConfigured,
  requestOrigin,
  tokenAllowsOrigin,
} from '../api/apple-mapkit-token.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

const decodePart = (part) => JSON.parse(
  Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
);

test('MapKit token is an origin-bound, short-lived ES256 JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.parse('2026-08-28T12:00:00Z');
  const token = createMapKitToken({
    teamId: 'TEAM123',
    keyId: 'KEY123',
    privateKey: privatePem,
    origin: 'https://ops.example.com',
    now,
  });
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  assert.deepEqual(decodePart(headerPart), {
    alg: 'ES256', kid: 'KEY123', typ: 'JWT',
  });
  const payload = decodePart(payloadPart);
  assert.equal(payload.iss, 'TEAM123');
  assert.equal(payload.origin, 'https://ops.example.com');
  assert.equal(payload.scope, 'mapkit_js');
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp - payload.iat, 15 * 60);

  const signature = Buffer.from(
    signaturePart.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  assert.equal(signature.length, 64, 'ES256 JWT uses a 64-byte P1363 signature');
  assert.equal(verify(
    'sha256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature,
  ), true);
});

test('portal-generated MapKit token is accepted only on its allowed domain', () => {
  // Signature contents are irrelevant to this local claim check; Apple still
  // verifies the real token cryptographically when the SDK uses it.
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${part({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' })}.`
    + `${part({ iss: 'TEAM123', iat: 123, origin: 'skyway.app', scope: 'mapkit_js' })}.`
    + `${Buffer.alloc(64).toString('base64url')}`;
  const decoded = decodeMapKitToken(token);
  assert.equal(decoded.payload.scope, 'mapkit_js');
  assert.equal(decoded.payload.origin, 'skyway.app');
  assert.equal(tokenAllowsOrigin(token, 'https://skyway.app'), true);
  assert.equal(tokenAllowsOrigin(token, 'https://preview.skyway.app'), false);
  assert.equal(tokenAllowsOrigin(token, 'https://not-skyway.app'), false);
});

test('wrong-scope and malformed static tokens are rejected', () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const wrongScope = `${part({ alg: 'ES256' })}.${part({
    origin: 'skyway.app',
    scope: 'maps_server_api',
  })}.signature`;
  assert.equal(tokenAllowsOrigin(wrongScope, 'https://skyway.app'), false);
  assert.equal(decodeMapKitToken('not-a-token'), null);
});

test('escaped newlines in the deployment private key are accepted', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const escaped = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .replace(/\n/g, '\\n');
  assert.doesNotThrow(() => createMapKitToken({
    teamId: 'TEAM123',
    keyId: 'KEY123',
    privateKey: escaped,
    origin: 'https://ops.example.com',
  }));
});

test('request origin follows forwarded deployment headers or explicit override', () => {
  const original = process.env.APPLE_MAPKIT_ORIGIN;
  try {
    delete process.env.APPLE_MAPKIT_ORIGIN;
    assert.equal(requestOrigin({
      headers: {
        'x-forwarded-host': 'preview.example.com',
        'x-forwarded-proto': 'https',
      },
    }), 'https://preview.example.com');
    process.env.APPLE_MAPKIT_ORIGIN = 'https://ops.example.com/';
    assert.equal(requestOrigin({ headers: {} }), 'https://ops.example.com');
  } finally {
    if (original === undefined) delete process.env.APPLE_MAPKIT_ORIGIN;
    else process.env.APPLE_MAPKIT_ORIGIN = original;
  }
});

test('configuration check returns booleans without exposing credential values', () => {
  const original = {
    token: process.env.APPLE_MAPKIT_TOKEN,
    team: process.env.APPLE_MAPKIT_TEAM_ID,
    key: process.env.APPLE_MAPKIT_KEY_ID,
    privateKey: process.env.APPLE_MAPKIT_PRIVATE_KEY,
  };
  try {
    delete process.env.APPLE_MAPKIT_TEAM_ID;
    delete process.env.APPLE_MAPKIT_KEY_ID;
    delete process.env.APPLE_MAPKIT_PRIVATE_KEY;
    delete process.env.APPLE_MAPKIT_TOKEN;
    assert.equal(mapKitConfigured(), false);
    process.env.APPLE_MAPKIT_TOKEN = 'portal-token';
    assert.equal(mapKitConfigured(), true);
    delete process.env.APPLE_MAPKIT_TOKEN;
    process.env.APPLE_MAPKIT_TEAM_ID = 'present';
    process.env.APPLE_MAPKIT_KEY_ID = 'present';
    process.env.APPLE_MAPKIT_PRIVATE_KEY = 'present';
    assert.equal(mapKitConfigured(), true);
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('APPLE_MAPKIT_TOKEN', original.token);
    restore('APPLE_MAPKIT_TEAM_ID', original.team);
    restore('APPLE_MAPKIT_KEY_ID', original.key);
    restore('APPLE_MAPKIT_PRIVATE_KEY', original.privateKey);
  }
});

test('MapKit loader uses the official SDK and server token callback', async () => {
  const loader = await source('src/apple-mapkit.js');
  assert.match(loader, /cdn\.apple-mapkit\.com/);
  assert.match(loader, /\/api\/apple-mapkit-token/);
  assert.match(loader, /authorizationCallback\(done\)/);
  assert.match(loader, /libraries: \['full-map'\]/);
  assert.doesNotMatch(loader, /APPLE_MAPKIT_PRIVATE_KEY/);
});

test('shared TrackingMap uses Apple for imagery and Leaflet for operations overlays', async () => {
  const map = await source('src/TrackingMap.jsx');
  assert.match(map, /loadAppleMapKit\(\)\.catch/);
  assert.match(map, /new apple\.Map/);
  assert.match(map, /appleMapType\(apple, basemapDefault\)/);
  assert.match(map, /syncAppleRegion/);
  assert.match(map, /style=\{\{ background: 'transparent' \}\}/);
  // Existing operational layers remain: no aircraft/trail/radar regression.
  assert.match(map, /createRadarLayer/);
  assert.match(map, /drawAltitudeTrail/);
  assert.match(map, /aircraftIcon/);
  assert.match(map, /Apple Maps runtime error; using standard basemap/);
});

test('all tracking surfaces continue using the shared map component', async () => {
  const app = await source('src/App.jsx');
  const broker = await source('src/TripTrack.jsx');
  const operator = await source('src/OperatorFlightPortal.jsx');
  const dashboard = await source('src/OpsDashboard.jsx');
  assert.match(app, /<TrackingMap/);
  assert.match(broker, /<TrackingMap/);
  assert.match(operator, /<TrackingMap/);
  assert.match(dashboard, /TrackingMapLazy/);
});

test('TV Flight Board uses Apple Maps with Leaflet operational overlays', async () => {
  const board = await source('src/FlightBoard.jsx');
  assert.match(board, /loadAppleMapKit\(\)\.catch/);
  assert.match(board, /new apple\.Map/);
  assert.match(board, /appleMapType\(apple, 'terrain'\)/);
  assert.match(board, /syncAppleRegion/);
  assert.match(board, /style=\{\{ background: 'transparent' \}\}/);
  assert.match(board, /APPLE MAPS/);
  // Keep the existing route, aircraft, and weather layers.
  assert.match(board, /L\.polyline/);
  assert.match(board, /L\.marker/);
  assert.match(board, /RainViewer/);
  assert.match(board, /Apple Maps runtime error; using standard basemap/);
});

test('MapKit credentials and private key never enter client source', async () => {
  const clientFiles = [
    await source('src/apple-mapkit.js'),
    await source('src/TrackingMap.jsx'),
    await source('src/FlightBoard.jsx'),
  ].join('\n');
  assert.doesNotMatch(clientFiles, /APPLE_MAPKIT_TEAM_ID/);
  assert.doesNotMatch(clientFiles, /APPLE_MAPKIT_KEY_ID/);
  assert.doesNotMatch(clientFiles, /APPLE_MAPKIT_PRIVATE_KEY/);
  assert.doesNotMatch(clientFiles, /APPLE_MAPKIT_TOKEN/);
});

