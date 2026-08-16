import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  altitudeFromFeet,
  buildDispatchEditUrl,
  buildForeFlightFlightViewUrl,
  buildForeFlightMapsUrl,
  normalizeIcao,
  publicForeFlightConfig,
  tripToDispatchFlight,
} from '../src/foreflight.js';
import { verifyForeFlightWebhook } from '../api/_foreflight-crypto.js';

const root = path.resolve(import.meta.dirname, '..');
async function source(file) {
  return readFile(path.join(root, file), 'utf8');
}

test('normalizeIcao prefixes 3-letter US codes', () => {
  assert.equal(normalizeIcao('apf'), 'KAPF');
  assert.equal(normalizeIcao('KAPF'), 'KAPF');
  assert.equal(normalizeIcao('MYNN'), 'MYNN');
});

test('maps deep link includes performance tokens', () => {
  const url = buildForeFlightMapsUrl({
    from: 'APF',
    to: 'GON',
    cruiseKts: 380,
    burnGph: 180,
    cruiseFt: 39000,
    tail: 'n444am',
  });
  assert.equal(
    url,
    'foreflightmobile://maps/search?q=KAPF+KGON+380kts+180gph+39000ft+N444AM',
  );
  assert.equal(buildForeFlightFlightViewUrl('abc-123'), 'foreflightmobile://flights/view?id=abc-123');
  assert.equal(
    buildDispatchEditUrl('org-1', 'flight-2'),
    'https://dispatch.foreflight.com/flight/org-1_flight-2/edit',
  );
});

test('tripToDispatchFlight builds a Create Flight body', () => {
  const flight = tripToDispatchFlight({
    uid: 'trip-1',
    start: '2030-01-15T18:00:00.000Z',
    info: {
      from: 'APF',
      to: 'BCT',
      tail: 'N123AB',
      pic: 'Jane Pilot',
      sic: 'John Copilot',
      pax: 2,
      legType: 'REVENUE',
    },
  }, {
    cruiseFt: 39000,
    routeNotes: 'DCT',
    alternate: 'MIA',
    crew: [
      { position: 'PIC', crewId: 'jane@example.com' },
      { position: 'SIC', crewId: 'john@example.com' },
    ],
  });

  assert.equal(flight.departure, 'KAPF');
  assert.equal(flight.destination, 'KBCT');
  assert.equal(flight.aircraftRegistration, 'N123AB');
  assert.equal(flight.scheduledTimeOfDeparture, '2030-01-15T18:00:00Z');
  assert.equal(flight.alternate, 'KMIA');
  assert.equal(flight.routeToDestination.route, 'DCT');
  assert.deepEqual(flight.routeToDestination.altitude, { altitude: 390, unit: 'FL' });
  assert.equal(flight.load.people, 4);
  assert.equal(flight.crew.length, 2);
  assert.equal(flight.tripId, 'trip-1');
});

test('altitudeFromFeet prefers flight levels above 180', () => {
  assert.deepEqual(altitudeFromFeet(41000), { altitude: 410, unit: 'FL' });
  assert.deepEqual(altitudeFromFeet(5500), { altitude: 5500, unit: 'FT' });
});

test('publicForeFlightConfig never exposes the API key', () => {
  const pub = publicForeFlightConfig({
    apiKey: 'secret-key',
    webhookSecret: 'whsec',
    organisationName: 'Demo Ops',
    enabled: true,
  });
  assert.equal(pub.connected, true);
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.hasWebhookSecret, true);
  assert.equal(pub.organisationName, 'Demo Ops');
  assert.equal('apiKey' in pub, false);
  assert.equal('webhookSecret' in pub, false);
});

test('webhook signature verification accepts HMAC hex and auth headers', () => {
  const secret = 'test-secret';
  const body = Buffer.from(JSON.stringify([{ flightId: 'f1', changeType: 'Filing' }]), 'utf8');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const salt = crypto.randomBytes(16);
  const auth = crypto.createHmac('sha256', secret).update(salt).digest('base64');

  const ok = verifyForeFlightWebhook({
    rawBody: body,
    secret,
    signatureHeader: signature,
    authHeader: auth,
    saltHeader: salt.toString('base64'),
  });
  assert.equal(ok.ok, true);

  const bad = verifyForeFlightWebhook({
    rawBody: body,
    secret,
    signatureHeader: 'nope',
    authHeader: auth,
    saltHeader: salt.toString('base64'),
  });
  assert.equal(bad.ok, false);
});

test('ForeFlight API routes are wired from the UI', async () => {
  const app = await source('src/App.jsx');
  const plan = await source('src/ForeFlightPlan.jsx');
  const settings = await source('src/ForeFlightSettingsPanel.jsx');
  assert.match(app, /ForeFlightPlanLazy/);
  assert.match(app, /ForeFlightSettingsPanelLazy/);
  assert.match(plan, /\/api\/foreflight-sync-trip/);
  assert.match(plan, /\/api\/foreflight-action/);
  assert.match(settings, /\/api\/foreflight-config/);
  assert.match(settings, /\/api\/foreflight-status/);
  assert.match(await source('api/_foreflight.js'), /\/api\/foreflight-webhook/);
  assert.match(await source('api/foreflight-webhook.js'), /x-foreflight-signature/);
});

test('server helper talks to the public Dispatch host', async () => {
  const helper = await source('api/_foreflight.js');
  assert.match(helper, /public-api\.foreflight\.com/);
  assert.match(helper, /x-api-key/);
  assert.match(helper, /x-vendorId/);
  assert.match(helper, /\/public\/api\/Flights/);
  assert.match(helper, /\/public\/api\/apiKeyInfo\/WebHook/);
  assert.doesNotMatch(await source('api/foreflight-status.js'), /apiKey:/);
});
