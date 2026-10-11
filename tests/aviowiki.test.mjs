import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CACHE_COLLECTION,
  CACHE_TTL_MS,
  aidsFromWebhookPayload,
  compareFeatured,
  createAviowikiRuntime,
  icaoCandidates,
  isFbo,
  normalizeFuelProduct,
  normalizeProvider,
  parseOurAirportsRunways,
  pricePerUsGallon,
  verifyAviowikiSignature,
} from '../api/_aviowiki.js';
import { handleAviowikiWebhook } from '../api/aviowiki-webhook.js';
import { mergeAirportView, mergeFuelPrices, sameAirport } from '../src/aviowiki-merge.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');
const TOKEN = 'test-token-do-not-log-123456';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async get(id) { return docs.has(id) ? docs.get(id) : null; },
    async set(id, data) { docs.set(id, structuredClone(data)); },
    async delete(id) { docs.delete(id); },
  };
}

const ktebAirport = {
  aid: 'APT-TEB1',
  icao: 'KTEB',
  iata: 'TEB',
  name: 'Teterboro',
  servedCity: 'Teterboro',
  elevation: 2.74,
  timeZone: 'America/New_York',
  coordinates: { latitude: 40.8501, longitude: -74.0608 },
};

function ktebFetch(calls) {
  return async (url) => {
    const pathName = new URL(url).pathname;
    const search = new URL(url).search;
    calls.push(`${pathName}${search}`);
    if (pathName === '/free/airports/icao/TEB') return jsonResponse({ error: 'missing' }, 404);
    if (pathName === '/free/airports/icao/KTEB') return jsonResponse(ktebAirport);
    if (pathName === '/airports/APT-TEB1') return jsonResponse(ktebAirport);
    if (pathName === '/airports/APT-TEB1/runways/all') {
      return jsonResponse([{
        aid: 'RWY-06',
        identifier: '06',
        tora: 2134,
        width: 45,
        surface: 'ASPHALT',
        edgeLights: true,
        helipad: false,
        magneticBearing: 60,
      }]);
    }
    if (pathName === '/airports/APT-TEB1/availability') {
      return jsonResponse({
        openingIndicator: 'SEE_TIMES',
        movement: [{ validFrom: '2026-10-11T06:00:00', validTo: '2026-10-11T23:00:00', status: 'FULL' }],
        ciq: [{ validFrom: '2026-10-11T08:00:00', validTo: '2026-10-11T20:00:00', status: 'LIMITED', info: { notes: 'Prior notice' } }],
        atc: [{ validFrom: '2026-10-11T06:00:00', validTo: '2026-10-11T23:00:00', status: 'FULL', info: { enRtfAvailable: true } }],
        arff: [{ validFrom: '2026-10-11T06:00:00', validTo: '2026-10-11T23:00:00', status: 'FULL', info: { icaoCatAirplane: 'IV', faaCatAirplane: 'B' } }],
      });
    }
    if (pathName === '/airports/APT-TEB1/operationalNotes') {
      return jsonResponse([{
        aid: 'ONA-1',
        kind: 'AIRPORT',
        category: 'RUNWAY',
        criticality: 'OPERATIONALLY_CRITICAL',
        source: 'NOTAM',
        notes: 'Runway 6/24 closed overnight.',
        validFrom: '2026-10-11T00:00:00',
        validTo: '2026-10-12T06:00:00',
      }]);
    }
    if (pathName === '/airports/APT-TEB1/providers/all') {
      return jsonResponse([
        {
          aid: 'PRV-FBO',
          parent: 'APT-TEB1',
          category: 'HANDLING',
          name: 'Signature Flight Support',
          phone: '+1 201 288 0000',
          email: 'teb@example.com',
          website: 'https://example.com/teb',
          vhf: 129.875,
          streetName: '111 Industrial Ave',
          locality: 'Teterboro',
          municipality: 'New Jersey',
          postalCode: '07608',
          paymentMethods: ['VISA', 'AVFUEL', 'WORLD_FUEL_SERVICES'],
          featuredOrder: -1,
          handlingProvider: {
            serviceLevel: 'FBO',
            terminalServices: ['DEDICATED_TERMINAL', 'CREW_SHOWERS'],
            aircraftServices: ['GPU_28V'],
          },
        },
        {
          aid: 'PRV-FUEL',
          parent: 'APT-TEB1',
          category: 'FUEL',
          name: 'Independent Fuel',
          featuredOrder: 3,
          paymentMethods: ['INVOICE'],
          fuelProvider: { serviceLevel: 'RESELLER' },
        },
        {
          aid: 'PRV-CATER',
          parent: 'APT-TEB1',
          category: 'CATERING',
          name: 'Ignored Caterer',
          featuredOrder: -1,
        },
        {
          aid: 'PRV-LATE',
          parent: 'APT-TEB1',
          category: 'HANDLING',
          name: 'Unverified Handler',
          featuredOrder: null,
          handlingProvider: { serviceLevel: 'HANDLER', terminalServices: [], aircraftServices: [] },
        },
      ]);
    }
    if (pathName === '/providers/PRV-FBO/fuelProducts/all') {
      return jsonResponse([
        { aid: 'FPR-1', type: 'JET_A1', unit: 'LTR', currency: 'EUR', price: 0.5, selfService: false },
        { aid: 'FPR-2', type: 'AVGAS_100LL', unit: 'USG', currency: 'USD', price: 6.2, selfService: true },
        { aid: 'FPR-3', type: 'JET_A', unit: 'USG', currency: 'USD', price: null },
      ]);
    }
    if (pathName === '/providers/PRV-FUEL/fuelProducts/all') return jsonResponse([]);
    if (pathName === '/providers/PRV-LATE/fuelProducts/all') return jsonResponse([]);
    return jsonResponse({ message: `unexpected ${pathName}` }, 500);
  };
}

test('FAA 3-letter identifiers fall back to a K prefix', () => {
  assert.deepEqual(icaoCandidates('teb'), ['TEB', 'KTEB']);
  assert.deepEqual(icaoCandidates('KTEB'), ['KTEB']);
  assert.deepEqual(icaoCandidates('MYNN'), ['MYNN']);
  assert.deepEqual(icaoCandidates(''), []);
});

test('fuel prices convert litres and imperial gallons and flag non-USD', () => {
  const litres = normalizeFuelProduct({
    type: 'JET_A1', unit: 'LTR', currency: 'eur', price: '0.50', selfService: false,
  });
  assert.equal(litres.fuelType, 'Jet A-1');
  assert.equal(litres.price, 0.5);
  assert.equal(litres.unit, 'LTR');
  assert.equal(litres.currency, 'EUR');
  assert.equal(litres.pricePerGal, pricePerUsGallon(0.5, 'LTR'));
  assert.equal(litres.pricePerGal, Math.round(0.5 * 3.785411784 * 10000) / 10000);
  assert.equal(litres.nonUsd, true);
  assert.equal(litres.selfService, false);
  assert.equal(litres.source, 'aviowiki');

  const imperial = pricePerUsGallon(4, 'IMP');
  assert.equal(imperial, Math.round(4 * (3.785411784 / 4.54609) * 10000) / 10000);

  const usd = normalizeFuelProduct({ type: 'AVGAS_100LL', unit: 'USG', currency: 'USD', price: 6.2, selfService: true });
  assert.equal(usd.nonUsd, false);
  assert.equal(usd.pricePerGal, 6.2);
  assert.equal(usd.fuelType, '100LL');
  assert.equal(normalizeFuelProduct({ type: 'JET_A', price: 'Call' }), null);
});

test('providers match the FBO card shape and sort verified first', () => {
  const fbo = normalizeProvider({
    aid: 'PRV-1',
    parent: 'APT-1',
    category: 'HANDLING',
    name: 'Signature',
    phone: '+1 201 555 0100',
    email: 'ops@example.com',
    website: 'example.com',
    vhf: 122.95,
    streetName: '1 Ramp Rd',
    locality: 'Teterboro',
    municipality: 'NJ',
    paymentMethods: ['AVFUEL'],
    featuredOrder: -1,
    handlingProvider: {
      serviceLevel: 'FBO',
      terminalServices: ['DEDICATED_TERMINAL'],
      aircraftServices: ['GPU_28V'],
    },
  }, [{ type: 'JET_A', unit: 'USG', currency: 'USD', price: 7, selfService: false }]);
  assert.equal(isFbo({ handlingProvider: { serviceLevel: 'FBO' } }), true);
  assert.equal(fbo.fbo, true);
  assert.equal(fbo.featured, true);
  assert.equal(fbo.verified, true);
  assert.equal(fbo.vhf, '122.950');
  assert.equal(fbo.address, '1 Ramp Rd, Teterboro, NJ');
  assert.deepEqual(fbo.paymentMethods, ['AVFUEL']);
  assert.deepEqual(fbo.services, ['Dedicated Terminal', 'GPU 28V']);
  assert.equal(fbo.fuelPrices[0].fuelType, 'Jet A');
  assert.equal(fbo.fuelPrices[0].pricePerGal, 7);
  for (const key of ['name', 'phone', 'email', 'website', 'vhf', 'address', 'paymentMethods', 'services', 'featured', 'fuelPrices']) {
    assert.ok(key in fbo, key);
  }

  const names = [
    { name: 'Later', featuredOrder: 2 },
    { name: 'Unreviewed', featuredOrder: null },
    { name: 'Verified', featuredOrder: -1 },
    { name: 'First', featuredOrder: 0 },
  ].sort(compareFeatured).map((provider) => provider.name);
  assert.deepEqual(names, ['Verified', 'First', 'Later', 'Unreviewed']);
});

test('KTEB lookup uses the K prefix, drops non handling/fuel providers, and coalesces', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inner = ktebFetch(calls);
  const fetchImpl = async (url) => {
    if (String(url).includes('/providers/all')) await gate;
    return inner(url);
  };
  const runtime = createAviowikiRuntime({
    env: { AVIOWIKI_API_TOKEN: TOKEN },
    fetchImpl,
    storeProvider: async () => memoryStore(),
  });
  const pending = Promise.all([runtime.getAirportFbos('TEB'), runtime.getAirportFbos('TEB')]);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  release();
  const [first, second] = await pending;
  assert.equal(calls.filter((call) => call.includes('/free/airports/icao/TEB')).length, 1);
  assert.equal(calls.filter((call) => call.includes('/free/airports/icao/KTEB')).length, 1);
  assert.equal(calls.filter((call) => call.includes('/providers/all')).length, 1);
  assert.equal(first.airport, 'KTEB');
  assert.equal(first.airportName, 'Teterboro');
  assert.deepEqual(first.fbos.map((fbo) => fbo.name), [
    'Signature Flight Support',
    'Independent Fuel',
    'Unverified Handler',
  ]);
  assert.equal(first.fbos[0].verified, true);
  assert.equal(first.fbos[0].fuelPrices.find((fuel) => fuel.fuelType === 'Jet A-1').nonUsd, true);
  assert.equal(second.fbos.length, 3);
  assert.equal(calls.some((call) => call.includes(TOKEN)), false);
});

test('cache TTLs are honored and stale data is served when aviowiki fails', async () => {
  const store = memoryStore();
  let clock = 1_700_000_000_000;
  let fail = false;
  const calls = [];
  const runtime = createAviowikiRuntime({
    env: { AVIOWIKI_API_TOKEN: TOKEN, AVIOWIKI_BASE_URL: 'https://api.aviowiki.com' },
    now: () => clock,
    storeProvider: async () => store,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (fail) throw new Error(`down ${TOKEN}`);
      return ktebFetch(calls)(url);
    },
  });
  const fresh = await runtime.getAirportBundle('KTEB');
  assert.equal(fresh.airport.name, 'Teterboro');
  assert.equal(fresh.airport.longitude, -74.0608);
  assert.equal(fresh.runways[0].identifier, '06');
  assert.ok(fresh.runways[0].lengthFt > 6000);
  assert.equal(fresh.availability.fireCover[0].detail.includes('ICAO IV'), true);
  assert.equal(fresh.notes[0].notes.includes('Runway 6/24'), true);
  assert.equal(store.docs.size > 0, true);
  assert.equal([...store.docs.values()].some((doc) => JSON.stringify(doc).includes(TOKEN)), false);

  clock += CACHE_TTL_MS.airport + 1000;
  fail = true;
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const stale = await runtime.getAirportBundle('KTEB');
    assert.equal(stale.stale, true);
    assert.equal(stale.airport.icao, 'KTEB');
  } finally {
    console.error = original;
  }
  assert.equal(logs.join('\n').includes(TOKEN), false);
});

test('webhook signature, shared secret, and cache invalidation', async () => {
  const store = memoryStore();
  const runtime = createAviowikiRuntime({
    env: { AVIOWIKI_API_TOKEN: TOKEN },
    storeProvider: async () => store,
    fetchImpl: ktebFetch([]),
  });
  await runtime.getAirportFbos('KTEB');
  assert.equal(store.docs.size > 2, true);

  const secret = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const raw = JSON.stringify({
    event: 'DATA_CHANGE',
    timestamp: '2026-05-15T14:30:00',
    data: {
      type: 'PROVIDER',
      aid: 'PRV-FBO',
      action: 'UPDATE',
      url: 'https://api.aviowiki.com/providers/PRV-FBO',
    },
  });
  const stamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret).update(`${stamp}.${raw}`).digest('hex');
  assert.equal(verifyAviowikiSignature(raw, `t=${stamp},v1=${signature}`, secret), true);
  assert.equal(verifyAviowikiSignature(raw, `t=${stamp},v1=${'0'.repeat(signature.length)}`, secret), false);
  assert.equal(verifyAviowikiSignature(raw, `t=${Number(stamp) - (10 * 60 * 1000)},v1=${signature}`, secret), false);
  assert.deepEqual(aidsFromWebhookPayload(JSON.parse(raw)), ['PRV-FBO']);

  const res = {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handleAviowikiWebhook({
    method: 'POST',
    headers: { 'aviowiki-signature': `t=${stamp},v1=${signature}` },
    rawBody: raw,
  }, res, {
    env: { AVIOWIKI_WEBHOOK_SECRET: secret },
    invalidate: (aids) => runtime.invalidate(aids),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.invalidated > 0, true);
  const keys = [...store.docs.keys()];
  assert.equal(keys.some((key) => key.startsWith('prv_')), false);
  assert.equal(keys.some((key) => key.includes('PRV-FBO')), false);

  const open = {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handleAviowikiWebhook({ method: 'POST', headers: {}, rawBody: raw }, open, {
    env: {},
    invalidate: async () => [],
  });
  assert.equal(open.statusCode, 503);

  const bearer = {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handleAviowikiWebhook({
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    url: '/api/aviowiki-webhook',
    rawBody: raw,
  }, bearer, {
    env: { AVIOWIKI_WEBHOOK_SECRET: secret },
    invalidate: async () => ['prv_APT-TEB1'],
  });
  assert.equal(bearer.statusCode, 200);
});

test('OurAirports runway fallback keeps length, surface, and lights', () => {
  const csv = [
    'id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,he_ident',
    '1,1,KTEB,7000,150,ASPH,1,0,06,24',
    '2,2,KJFK,8400,200,CONC,1,0,13R,31L',
  ].join('\n');
  const runways = parseOurAirportsRunways(csv, ['TEB', 'KTEB']);
  assert.equal(runways.length, 1);
  assert.equal(runways[0].identifier, '06/24');
  assert.equal(runways[0].lengthFt, 7000);
  assert.equal(runways[0].source, 'ourairports');
  assert.equal(runways[0].lighted, true);
});

test('iFlightPlanner remains the US price and aviowiki is the fallback', () => {
  assert.equal(sameAirport('TEB', 'KTEB'), true);
  const prices = mergeFuelPrices(
    [
      { fuelType: 'Jet A', price: 9, pricePerGal: 9, currency: 'USD', unit: 'USG', nonUsd: false, selfService: false, service: 'Full service' },
      { fuelType: '100LL', price: 1.5, pricePerGal: pricePerUsGallon(1.5, 'LTR'), currency: 'EUR', unit: 'LTR', nonUsd: true, selfService: true, service: 'Self service' },
    ],
    [{ fuelType: 'Jet A', service: 'Full service', price: 6.4, updatedAt: '2026-10-01' }],
  );
  assert.equal(prices[0].source, 'iFlightPlanner');
  assert.equal(prices[0].price, 6.4);
  assert.equal(prices[0].updatedAt, '2026-10-01');
  assert.equal(prices[1].source, 'aviowiki');
  assert.equal(prices[1].fallback, true);
  assert.equal(prices[1].nonUsd, true);

  const view = mergeAirportView({
    requested: 'TEB',
    aviowikiAirport: {
      configured: true,
      source: 'aviowiki',
      airport: { icao: 'KTEB', name: 'Teterboro', elevationFt: 9 },
      runways: [{ identifier: '06', lengthFt: 7000, source: 'aviowiki' }],
      availability: { hoursSummary: '06:00-23:00 Full', hours: [], customs: [], atc: [], fireCover: [] },
      notes: [{ notes: 'Noise' }],
    },
    aviowikiFbos: {
      configured: true,
      airports: [{
        airport: 'KTEB',
        fbos: [{
          name: 'Signature Flight Support',
          phone: '201-555-0100',
          email: 'a@example.com',
          website: 'https://example.com',
          vhf: '129.875',
          address: '111 Industrial Ave',
          paymentMethods: ['AVFUEL'],
          services: ['Dedicated terminal'],
          featured: true,
          verified: true,
          fbo: true,
          fuelPrices: prices.filter((fuel) => fuel.source === 'aviowiki').concat([{
            fuelType: 'Jet A', price: 9, pricePerGal: 9, currency: 'USD', unit: 'USG', nonUsd: false, service: 'Full service',
          }]),
        }],
      }],
    },
    iflight: {
      airports: [{
        airport: 'TEB',
        fbos: [{
          name: 'Signature',
          fuelPrices: [{ fuelType: 'Jet A', service: 'Full service', price: 6.4, updatedAt: '2026-10-01' }],
        }],
      }],
    },
  });
  assert.equal(view.airport, 'KTEB');
  assert.equal(view.fbos[0].verified, true);
  assert.equal(view.fbos[0].fuelPrices[0].source, 'iFlightPlanner');
  assert.equal(view.fbos[0].fuelPrices[0].updatedAt, '2026-10-01');
  assert.equal(view.lowestByFuel['Jet A'].price, 6.4);
  assert.equal(view.availability.hoursSummary, '06:00-23:00 Full');
});

test('token stays server-side and the screen keeps both sources', async () => {
  const client = await source('api/_aviowiki.js');
  const fbos = await source('api/aviowiki-fbos.js');
  const airport = await source('api/aviowiki-airport.js');
  const webhook = await source('api/aviowiki-webhook.js');
  const browser = await source('src/AirportFboData.jsx');
  const docs = await source('docs/aviowiki-setup.md');

  assert.match(client, /AVIOWIKI_API_TOKEN/);
  assert.match(client, /Authorization: `Bearer \$\{token\}`/);
  assert.match(client, new RegExp(CACHE_COLLECTION));
  assert.equal(CACHE_TTL_MS.airport, 30 * 24 * 60 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.providers, 24 * 60 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.fuel, 6 * 60 * 60 * 1000);
  assert.match(client, /\/free\/airports\/icao\//);
  assert.match(client, /\/providers\/\$\{encodeURIComponent\(provider\.aid\)\}\/fuelProducts\/all/);
  assert.match(fbos, /authorizeFlightOps/);
  assert.match(fbos, /maximum of 10 airports/i);
  assert.match(airport, /authorizeFlightOps/);
  assert.match(client, /verifyIdToken\(idToken, true\)/);
  assert.match(client, /\['crew', 'pilot', 'sales', 'ops', 'admin'\]/);
  assert.match(webhook, /Aviowiki-Signature|aviowiki-signature/);
  assert.match(webhook, /AVIOWIKI_WEBHOOK_SECRET/);

  assert.doesNotMatch(browser, /AVIOWIKI_API_TOKEN/);
  assert.match(browser, /\/api\/iflightplanner-fbos/);
  assert.match(browser, /\/api\/aviowiki-fbos/);
  assert.match(browser, /\/api\/aviowiki-airport/);
  assert.match(browser, /Number\(fuel\.price\) \* gallons/);
  assert.match(browser, /Planned uplift/);
  assert.match(browser, /aviowiki fallback/);
  assert.match(browser, /Non-USD/);
  assert.match(browser, /Verified/);
  assert.match(docs, /https:\/\/www\.skyway\.app\/api\/aviowiki-webhook/);
  assert.match(docs, /AVIOWIKI_WEBHOOK_SECRET/);
  assert.match(docs, /Not set yet/);
});
