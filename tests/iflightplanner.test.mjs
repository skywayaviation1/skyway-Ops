import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  airportMatches,
  deploymentContext,
  describeProviderResult,
  missingCredentialNames,
  normalizeFboCsv,
  normalizeFboRecord,
  parseCsv,
  publicIFlightPlannerStatus,
  summarizeAirportFbos,
} from '../api/_iflightplanner.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('CSV parser handles quoted commas, escaped quotes, and CRLF', () => {
  assert.deepEqual(
    parseCsv('Airport,FBO,Note\r\nKAPF,"Naples Aviation, LLC","Says ""hello"""\r\n'),
    [
      ['Airport', 'FBO', 'Note'],
      ['KAPF', 'Naples Aviation, LLC', 'Says "hello"'],
    ],
  );
});

test('FBO records normalize airport, contact, and posted prices', () => {
  const record = normalizeFboRecord({
    'Airport ICAO': 'KAPF',
    'Airport Name': 'Naples Municipal',
    'FBO Name': 'Naples Aviation',
    Phone: '239-555-0100',
    Website: 'example.com',
    'Fuel Provider': 'World Fuel',
    'Jet A Full Service Price': '$6.49',
    'Jet A Self Service Price': '5.99',
    '100LL Self Service Price': '6.20',
    'Jet A Full Service Updated': '2026-08-24',
  });
  assert.equal(record.airport, 'KAPF');
  assert.equal(record.airportName, 'Naples Municipal');
  assert.equal(record.name, 'Naples Aviation');
  assert.equal(record.fuelBrand, 'World Fuel');
  assert.deepEqual(
    record.fuelPrices.map(({ fuelType, service, price }) => ({ fuelType, service, price })),
    [
      { fuelType: '100LL', service: 'Self service', price: 6.2 },
      { fuelType: 'Jet A', service: 'Full service', price: 6.49 },
      { fuelType: 'Jet A', service: 'Self service', price: 5.99 },
    ],
  );
});

test('invalid and non-price values do not become fuel prices', () => {
  const record = normalizeFboRecord({
    ICAO: 'KTEB',
    BusinessName: 'Example FBO',
    'Jet A Full Service Price': 'Call',
    '100LL Updated Date': '2026-08-24',
    'MOGAS Price': '-1',
  });
  assert.deepEqual(record.fuelPrices, []);
});

test('CSV normalization retains raw provider columns for forward compatibility', () => {
  const result = normalizeFboCsv(
    'ICAO,Business Name,Jet A Price,New Provider Field\n'
    + 'KHPN,Million Air,7.25,provider-value\n',
  );
  assert.deepEqual(result.headers, ['ICAO', 'Business Name', 'Jet A Price', 'New Provider Field']);
  assert.equal(result.records[0].raw['New Provider Field'], 'provider-value');
});

test('normalization tolerates alternate provider header naming', () => {
  const record = normalizeFboRecord({
    'Airport Code ICAO': 'KSRQ',
    'Business Location Name': 'Alternate Header Aviation',
    'Retail Jet A FS Price': '6.70',
    'Retail 100LL SS Price': '6.10',
  });
  assert.equal(record.airport, 'KSRQ');
  assert.equal(record.name, 'Alternate Header Aviation');
  assert.deepEqual(
    record.fuelPrices.map(({ fuelType, service }) => ({ fuelType, service })),
    [
      { fuelType: '100LL', service: 'Self service' },
      { fuelType: 'Jet A', service: 'Full service' },
    ],
  );
});

test('airport matching tolerates FAA and U.S. ICAO forms', () => {
  const kApf = { airport: 'KAPF' };
  assert.equal(airportMatches(kApf, 'APF'), true);
  assert.equal(airportMatches(kApf, 'KAPF'), true);
  assert.equal(airportMatches(kApf, 'TEB'), false);
  assert.equal(airportMatches({ airport: 'APF' }, 'KAPF'), true);
});

test('airport summary identifies the cheapest provider per fuel type', () => {
  const records = normalizeFboCsv(
    'ICAO,FBO Name,Jet A Full Service Price,100LL Self Service Price\n'
    + 'KAPF,FBO One,7.10,6.20\n'
    + 'KAPF,FBO Two,6.55,6.40\n'
    + 'KTEB,FBO Three,9.00,\n',
  ).records;
  const summary = summarizeAirportFbos(records, 'APF');
  assert.equal(summary.fbos.length, 2);
  assert.equal(summary.lowestByFuel['Jet A'].price, 6.55);
  assert.equal(summary.lowestByFuel['Jet A'].fboName, 'FBO Two');
  assert.equal(summary.lowestByFuel['100LL'].price, 6.2);
});

test('the token request satisfies both documented media types', async () => {
  const client = await source('api/_iflightplanner.js');
  // Their written OAuth instructions say x-www-form-urlencoded; their OpenAPI
  // schema declares the same endpoint as application/json. Trying the form
  // first and falling back to JSON means neither reading can break auth.
  assert.match(client, /mediaType: 'application\/x-www-form-urlencoded'/);
  assert.match(client, /mediaType: 'application\/json'/);
  assert.match(client, /new URLSearchParams\(\{ grant_type: 'client_credentials' \}\)/);
  assert.match(client, /for \(const attempt of attempts\)/);
  // Scope belongs only to multi-instance apps.
  assert.match(client, /IFLIGHTPLANNER_SCOPE/);
});

test('OAuth credentials remain server-side and use client credentials with Basic auth', async () => {
  const client = await source('api/_iflightplanner.js');
  assert.match(client, /IFLIGHTPLANNER_CLIENT_ID/);
  assert.match(client, /IFLIGHTPLANNER_CLIENT_SECRET/);
  assert.match(client, /Authorization: `Basic/);
  assert.match(client, /grant_type: 'client_credentials'/);
  assert.match(client, /Authorization: `Bearer/);

  const browser = await source('src/AirportFboData.jsx');
  assert.doesNotMatch(browser, /IFLIGHTPLANNER_CLIENT/);
  assert.doesNotMatch(browser, /oauth2\/token/);
});

test('FBO endpoint is authenticated, bounded, and returns only requested airports', async () => {
  const endpoint = await source('api/iflightplanner-fbos.js');
  assert.match(endpoint, /verifyIdToken\(idToken, true\)/);
  assert.match(endpoint, /maximum of 10 airports/i);
  assert.match(endpoint, /summarizeAirportFbos\(dataset\.records, airport\)/);
  assert.match(endpoint, /private, no-store/);
});

test('Airport & Fuel is a role-gated Flights tab with uplift-cost UI', async () => {
  const app = await source('src/App.jsx');
  assert.match(app, /AirportFboDataLazy = lazy\(\(\) => import\('\.\/AirportFboData\.jsx'\)\)/);
  assert.match(app, /\{ id: 'airport-data', label: 'Airport & Fuel'[\s\S]*?roles: \['crew', 'sales', 'ops', 'admin'\]/);
  assert.match(app, /children: \['schedule', 'availability', 'airport-data'/);
  assert.match(app, /section === 'airport-data'/);

  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /Planned uplift/);
  assert.match(component, /Number\(fuel\.price\) \* gallons/);
  assert.match(component, /\/api\/iflightplanner-fbos/);
  assert.match(component, /Confirm price, fees, and availability|report\.disclaimer/);
});

test('airport lookup combines location, weather, NOTAM, FBO, and raw provider data', async () => {
  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /\/api\/airport-coords-lookup/);
  assert.match(component, /\/api\/airport-weather\?icao=/);
  assert.match(component, /\/api\/faa-notams\?icao=/);
  assert.match(component, /Open map/);
  assert.match(component, /Current weather/);
  assert.match(component, /Active NOTAMs/);
  assert.match(component, /All provider data/);
  // Failure of the commercial feed must not hide safety/context data from the
  // other sources.
  assert.match(component, /airport location, weather, and NOTAMs below are live/);
});

test('a missing credential is reported by name, per deployment', () => {
  const original = {
    id: process.env.IFLIGHTPLANNER_CLIENT_ID,
    secret: process.env.IFLIGHTPLANNER_CLIENT_SECRET,
    env: process.env.VERCEL_ENV,
  };
  try {
    delete process.env.IFLIGHTPLANNER_CLIENT_ID;
    process.env.IFLIGHTPLANNER_CLIENT_SECRET = 'present';
    process.env.VERCEL_ENV = 'preview';
    assert.deepEqual(missingCredentialNames(), ['IFLIGHTPLANNER_CLIENT_ID']);

    const status = publicIFlightPlannerStatus();
    assert.equal(status.configured, false);
    assert.deepEqual(status.missingEnv, ['IFLIGHTPLANNER_CLIENT_ID']);
    // Naming the environment is what distinguishes "wrong credentials" from
    // "added to a different environment than the one being viewed".
    assert.equal(status.deployment.environment, 'preview');
    assert.equal(deploymentContext().environment, 'preview');

    process.env.IFLIGHTPLANNER_CLIENT_ID = 'present';
    assert.deepEqual(missingCredentialNames(), []);
    assert.equal(publicIFlightPlannerStatus().configured, true);
  } finally {
    if (original.id === undefined) delete process.env.IFLIGHTPLANNER_CLIENT_ID;
    else process.env.IFLIGHTPLANNER_CLIENT_ID = original.id;
    if (original.secret === undefined) delete process.env.IFLIGHTPLANNER_CLIENT_SECRET;
    else process.env.IFLIGHTPLANNER_CLIENT_SECRET = original.secret;
    if (original.env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original.env;
  }
});

test('the API host is configurable so production credentials can be used', () => {
  const original = process.env.IFLIGHTPLANNER_BASE_URL;
  try {
    delete process.env.IFLIGHTPLANNER_BASE_URL;
    let status = publicIFlightPlannerStatus();
    assert.equal(status.apiBase, 'https://dev.iflightplanner.com/api/v2');
    assert.equal(status.environmentKind, 'development');

    process.env.IFLIGHTPLANNER_BASE_URL = 'https://api.iflightplanner.com/api/v2/';
    status = publicIFlightPlannerStatus();
    assert.equal(status.apiBase, 'https://api.iflightplanner.com/api/v2');
    assert.equal(status.environmentKind, 'production');
  } finally {
    if (original === undefined) delete process.env.IFLIGHTPLANNER_BASE_URL;
    else process.env.IFLIGHTPLANNER_BASE_URL = original;
  }
});

test('the provider result envelope is read for its actual message', () => {
  // Their envelope puts descriptive text in messages[], not in `status`.
  assert.equal(
    describeProviderResult({
      status: 3,
      title: 'Not Authorized',
      messages: [{ type: 'Error', code: 'NO_LICENSE', message: 'Client is not licensed for this data set' }],
    }),
    'Not Authorized · Client is not licensed for this data set [NO_LICENSE]',
  );
  // A bare status number must never be presented as if it were a message.
  assert.equal(
    describeProviderResult({ status: 3 }),
    'provider returned result status 3 with no message',
  );
  assert.equal(describeProviderResult({ message: 'Direct message' }), 'Direct message');
  assert.equal(describeProviderResult(null, '<html>Gateway</html>'), '<html>Gateway</html>');
  assert.equal(describeProviderResult({}, ''), 'no response body');
});

test('a failing NOTAM source is explained in operational terms', async () => {
  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /function notamFailure/);
  assert.match(component, /FAA_NMS_CLIENT_ID and FAA_NMS_CLIENT_SECRET/);
  // Dispatchers must not read an empty NOTAM panel as a clear airport.
  assert.match(component, /NOTAMs unavailable — check another source before dispatch/);
});

test('a forbidden dataset is reported as entitlement, with the provider verbatim', async () => {
  const client = await source('api/_iflightplanner.js');
  // 403 is distinguished from a generic failure so the guidance can differ.
  assert.match(client, /error\.code = response\.status === 403/);
  assert.match(client, /'iflightplanner_forbidden'/);
  assert.match(client, /error\.providerMessage = providerMessage/);
  assert.match(client, /describeProviderResult\(result, body\)/);
  // The two datasets are licensed separately; fuel prices are still useful.
  assert.match(client, /fuelPriceDataUrl\(\), 'fuel price'/);

  const endpoint = await source('api/iflightplanner-status.js');
  assert.match(endpoint, /stage = error\.code === 'iflightplanner_auth_failed'/);
  assert.match(endpoint, /'entitlement'/);
  assert.match(endpoint, /IFLIGHTPLANNER_BASE_URL to the production API base/);
  assert.match(endpoint, /IFLIGHTPLANNER_SCOPE/);
  assert.match(endpoint, /providerMessage: error\.providerMessage/);
  // The endpoint publishes 200 and 401 only, so a 403 is a permission gate.
  assert.match(endpoint, /FBO & Fuel Price Data" permission/);

  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /feedCheck\.resolution\?\.length > 0/);
  assert.match(component, /feedCheck\.apiBase/);
});

test('the status endpoint proves the live provider path without leaking secrets', async () => {
  const endpoint = await source('api/iflightplanner-status.js');
  assert.match(endpoint, /profile\.role !== 'admin'/);
  assert.match(endpoint, /getFboDataset\(\{ force: true \}\)/);
  assert.match(endpoint, /forbidden \? 'entitlement' : 'data'/);
  assert.match(endpoint, /columns: dataset\.headers/);
  assert.doesNotMatch(endpoint, /process\.env\.IFLIGHTPLANNER_CLIENT_SECRET\b(?!\s*\))/);
});

test('airport coordinates come from the bundled table, not only the cron cache', async () => {
  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /import \{ lookupCoords \} from '\.\/airport-coords\.js'/);
  assert.match(component, /lookupCoords\(airport\)/);
  // The server cache is populated by a weekly cron, so it must not be the only
  // source or every airport reads "Location unavailable" until that runs.
  assert.match(component, /needLookup\.length === 0/);
  assert.match(component, /\.\.\.localCoords,/);
});

test('a provider outage names the missing variables and the serving environment', async () => {
  const component = await source('src/AirportFboData.jsx');
  assert.match(component, /providerMissingEnv/);
  assert.match(component, /providerDeployment/);
  assert.match(component, /Variables are scoped per environment/);
  // A zero count must not be presented as a healthy load.
  assert.match(component, /!report\.providerError && \(/);
  assert.match(component, /feedUnavailable/);
  // A failed NOTAM source must not look like "no NOTAMs".
  assert.match(component, /NOTAMs unavailable/);

  const endpoint = await source('api/iflightplanner-fbos.js');
  assert.match(endpoint, /missingEnv: error\.missingEnv \|\| status\.missingEnv/);
});

test('every operational flight exposes automatic origin and destination airport data', async () => {
  const app = await source('src/App.jsx');
  assert.match(app, /\{ id: 'airports', label: 'Airports', icon: Fuel/);
  assert.match(app, /children: pick\(\['sheet', 'weather', 'airports', 'plan'/);
  assert.match(app, /tab === 'airports'/);
  assert.match(app, /initialAirports=\{\[trip\.info\.from, trip\.info\.to\]\.filter\(Boolean\)\}/);
  assert.match(app, /autoSearch/);
  assert.match(app, /assignedFbos=\{\{/);
  assert.match(app, /Airport, FBO & fuel data/);
});
