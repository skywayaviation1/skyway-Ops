import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import handler, {
  canSignMapKitToken,
  createMapKitToken,
  decodeMapKitToken,
  isAllowedMapKitOrigin,
  isNativeMapKitOrigin,
  mapKitConfigured,
  planMapKitToken,
  requestOrigin,
  tokenAllowsOrigin,
} from '../api/apple-mapkit-token.js';
import {
  isMapKitAssetUrl,
  mapKitTokenUrl,
  nextAppleBasemapAction,
  watchAppleMapKit,
} from '../src/mapkit-fallback.js';
import { standardBasemapSpec } from '../src/tracking-map.js';

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

test('request origin follows the caller and does not let APPLE_MAPKIT_ORIGIN override it', () => {
  const original = process.env.APPLE_MAPKIT_ORIGIN;
  try {
    delete process.env.APPLE_MAPKIT_ORIGIN;
    assert.equal(requestOrigin({
      headers: {
        'x-forwarded-host': 'skyway-ops-git-fix.vercel.app',
        'x-forwarded-proto': 'https',
      },
    }), 'https://skyway-ops-git-fix.vercel.app');
    assert.equal(requestOrigin({
      headers: { origin: 'https://www.skyway.app' },
    }), 'https://www.skyway.app');
    assert.equal(requestOrigin({
      headers: { host: 'www.skyway.app', 'x-forwarded-proto': 'https' },
    }), 'https://www.skyway.app');
    process.env.APPLE_MAPKIT_ORIGIN = 'https://ops.example.com/';
    assert.equal(requestOrigin({ headers: {} }), 'https://ops.example.com');
    assert.equal(requestOrigin({
      headers: {
        host: 'www.skyway.app',
        'x-forwarded-proto': 'https',
      },
      url: '/api/apple-mapkit-token?origin=capacitor://localhost&platform=native',
    }), 'capacitor://localhost');
    assert.equal(isAllowedMapKitOrigin('https://135ops.app'), true);
    assert.equal(isAllowedMapKitOrigin('https://www.135ops.app'), true);
    assert.equal(isAllowedMapKitOrigin('https://evil.example'), false);
    assert.equal(isNativeMapKitOrigin('capacitor://localhost'), true);
    assert.equal(isNativeMapKitOrigin('https://localhost'), true);
    assert.equal(isNativeMapKitOrigin('http://localhost:5173'), false);
  } finally {
    if (original === undefined) delete process.env.APPLE_MAPKIT_ORIGIN;
    else process.env.APPLE_MAPKIT_ORIGIN = original;
  }
});

test('native callers get an origin-less signed token, not a website-locked one', () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const websiteToken = `${part({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' })}.`
    + `${part({ iss: 'TEAM123', iat: 123, origin: 'skyway.app', scope: 'mapkit_js' })}.`
    + `${Buffer.alloc(64).toString('base64url')}`;
  const nativePlan = planMapKitToken({
    origin: 'capacitor://localhost',
    suppliedToken: websiteToken,
    canSign: true,
  });
  assert.equal(nativePlan.ok, true);
  assert.equal(nativePlan.mode, 'dynamic-native');
  assert.equal(nativePlan.signOrigin, null);
  const blocked = planMapKitToken({
    origin: 'capacitor://localhost',
    suppliedToken: websiteToken,
    canSign: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);
  const preview = planMapKitToken({
    origin: 'https://skyway-ops-git-fix.vercel.app',
    suppliedToken: websiteToken,
    canSign: true,
  });
  assert.equal(preview.mode, 'dynamic');
  assert.equal(preview.signOrigin, 'https://skyway-ops-git-fix.vercel.app');
  const production = planMapKitToken({
    origin: 'https://www.skyway.app',
    suppliedToken: `${part({ alg: 'ES256' })}.${part({ origin: 'www.skyway.app', scope: 'mapkit_js' })}.sig`,
    canSign: true,
  });
  assert.equal(production.mode, 'static');
  assert.equal(tokenAllowsOrigin(
    `${part({ alg: 'ES256' })}.${part({ origin: '*.vercel.app', scope: 'mapkit_js' })}.sig`,
    'https://skyway-ops-git-fix.vercel.app',
  ), true);
});

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

test('token endpoint signs a native request without copying APPLE_MAPKIT_ORIGIN into the JWT', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const original = {
    token: process.env.APPLE_MAPKIT_TOKEN,
    team: process.env.APPLE_MAPKIT_TEAM_ID,
    key: process.env.APPLE_MAPKIT_KEY_ID,
    privateKey: process.env.APPLE_MAPKIT_PRIVATE_KEY,
    origin: process.env.APPLE_MAPKIT_ORIGIN,
  };
  try {
    delete process.env.APPLE_MAPKIT_TOKEN;
    process.env.APPLE_MAPKIT_TEAM_ID = 'TEAM123';
    process.env.APPLE_MAPKIT_KEY_ID = 'KEY123';
    process.env.APPLE_MAPKIT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    process.env.APPLE_MAPKIT_ORIGIN = 'https://skyway.app';
    assert.equal(canSignMapKitToken(), true);
    const res = responseCapture();
    handler({
      method: 'GET',
      url: '/api/apple-mapkit-token?origin=capacitor://localhost&platform=native',
      headers: { host: 'www.skyway.app', 'x-forwarded-proto': 'https' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'dynamic-signing-native');
    assert.equal(res.body.originRestricted, false);
    const payload = decodeMapKitToken(res.body.token).payload;
    assert.equal(payload.iss, 'TEAM123');
    assert.equal(Object.hasOwn(payload, 'origin'), false);
    assert.equal(payload.scope, 'mapkit_js');
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'capacitor://localhost');
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('APPLE_MAPKIT_TOKEN', original.token);
    restore('APPLE_MAPKIT_TEAM_ID', original.team);
    restore('APPLE_MAPKIT_KEY_ID', original.key);
    restore('APPLE_MAPKIT_PRIVATE_KEY', original.privateKey);
    restore('APPLE_MAPKIT_ORIGIN', original.origin);
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
  const fallback = await source('src/mapkit-fallback.js');
  assert.match(loader, /cdn\.apple-mapkit\.com/);
  assert.match(`${loader}\n${fallback}`, /\/api\/apple-mapkit-token/);
  assert.match(loader, /mapKitTokenUrl/);
  assert.match(loader, /authorizationCallback\(done\)/);
  assert.match(loader, /libraries: \['full-map'\]/);
  assert.match(loader, /__skywayAuthFailure/);
  assert.doesNotMatch(loader, /APPLE_MAPKIT_PRIVATE_KEY/);
});

test('shared TrackingMap uses Apple for imagery and Leaflet for operations overlays', async () => {
  const map = await source('src/TrackingMap.jsx');
  assert.match(map, /loadAppleMapKit\(\)\.catch/);
  assert.match(map, /new kit\.Map/);
  assert.match(map, /appleMapType\(kit, basemapDefault\)/);
  assert.match(map, /syncAppleRegion/);
  assert.match(map, /style=\{\{ background: 'transparent' \}\}/);
  assert.match(map, /visibility: 'hidden'/);
  assert.match(map, /watchAppleMapKit/);
  // Existing operational layers remain: no aircraft/trail/radar regression.
  assert.match(map, /createRadarLayer/);
  assert.match(map, /drawAltitudeTrail/);
  assert.match(map, /aircraftIcon/);
  assert.match(map, /Apple Maps runtime error; trying next basemap/);
});

test('all tracking surfaces continue using the shared map component', async () => {
  const app = await source('src/App.jsx');
  const broker = await source('src/TripTrack.jsx');
  const operator = await source('src/OperatorFlightPortal.jsx');
  const dashboard = await source('src/OpsDashboard.jsx');
  assert.match(app, /<TrackingMap/);
  assert.match(broker, /<TrackingMap/);
  assert.match(operator, /<TrackingMap/);
  assert.match(dashboard, /FleetTrackingPanel/);
});

test('TV Flight Board uses Apple Maps with Leaflet operational overlays', async () => {
  const board = await source('src/FlightBoard.jsx');
  assert.match(board, /loadAppleMapKit\(\)\.catch/);
  assert.match(board, /new apple\.Map/);
  assert.match(board, /appleMapType\(apple, 'terrain'\)/);
  assert.match(board, /syncAppleRegion/);
  assert.match(board, /style=\{\{ background: 'transparent' \}\}/);
  assert.match(board, /visibility: 'hidden'/);
  assert.match(board, /watchAppleMapKit/);
  assert.match(board, /APPLE MAPS/);
  // Keep the existing route, aircraft, and weather layers.
  assert.match(board, /L\.polyline/);
  assert.match(board, /L\.marker/);
  assert.match(board, /RainViewer/);
  assert.match(board, /Apple Maps runtime error; using standard basemap/);
});

test('fallback stays on Esri and only reveals Apple after tiles or a hard failure', () => {
  assert.equal(nextAppleBasemapAction({}), 'wait');
  assert.equal(nextAppleBasemapAction({ authFailure: true, tilesLoaded: true }), 'fallback');
  assert.equal(nextAppleBasemapAction({ runtimeError: true }), 'fallback');
  assert.equal(nextAppleBasemapAction({ tilesLoaded: true }), 'apple');
  assert.equal(nextAppleBasemapAction({
    timedOut: true,
    configurationReady: true,
    canObserveTiles: true,
  }), 'fallback');
  assert.equal(nextAppleBasemapAction({
    timedOut: true,
    configurationReady: true,
    canObserveTiles: false,
  }), 'apple');
  assert.match(standardBasemapSpec('dark', 'dark').tiles[0].url, /World_Dark_Gray_Base/);
  assert.match(standardBasemapSpec('dark', 'light').tiles[0].url, /World_Light_Gray_Base/);
  assert.match(standardBasemapSpec('satellite', 'light').tiles[0].url, /World_Imagery/);
  assert.equal(mapKitTokenUrl({ native: false }), '/api/apple-mapkit-token');
  assert.equal(
    mapKitTokenUrl({
      native: true,
      pageOrigin: 'capacitor://localhost',
      apiBase: 'https://www.skyway.app/',
    }),
    'https://www.skyway.app/api/apple-mapkit-token?origin=capacitor%3A%2F%2Flocalhost&platform=native',
  );
  assert.equal(isMapKitAssetUrl('https://cdn.apple-mapkit.com/ma/bootstrap'), true);
  assert.equal(isMapKitAssetUrl('https://gsp10.apple-mapkit.com/tile'), true);
  assert.equal(isMapKitAssetUrl('https://www.skyway.app/api/apple-mapkit-token'), false);
  assert.equal(isMapKitAssetUrl(new URL('https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js')), true);
});

test('an auth error stored before the watcher exists falls back immediately', async () => {
  const listeners = new Map();
  const mapkit = {
    __skywayAuthFailure: { status: 'Unauthorized' },
    addEventListener(name, fn) {
      const list = listeners.get(name) || [];
      list.push(fn);
      listeners.set(name, list);
    },
    removeEventListener(name, fn) {
      listeners.set(name, (listeners.get(name) || []).filter((item) => item !== fn));
    },
  };
  const result = await new Promise((resolve) => {
    watchAppleMapKit(mapkit, {
      timeoutMs: 50,
      onReady: () => resolve('apple'),
      onFailure: (info) => resolve(info.reason),
    });
  });
  assert.equal(result, 'error');
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

