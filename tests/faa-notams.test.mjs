import assert from 'node:assert/strict';
import test from 'node:test';

import handler, {
  AVWX_NOTAM_URL,
  DEFAULT_FAA_API_BASE,
  DEFAULT_FAA_TOKEN_URL,
  buildNotamPayload,
  createFaaAuthCircuit,
  faaEndpoints,
  fetchNotamsFromAvwx,
  isActive,
  mapAvwxNotam,
  resetNotamTestHooks,
  resolveNotams,
  setNotamTestHooks,
} from '../api/faa-notams.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const START = '2026-10-01T00:00:00Z';
const END = '2026-10-20T00:00:00Z';
const EXPIRED_END = '2026-10-01T00:00:00Z';

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
  };
}

function faaCreds(extra = {}) {
  return {
    FAA_NMS_CLIENT_ID: 'client-id',
    FAA_NMS_CLIENT_SECRET: 'client-secret',
    AVWX_API_KEY: 'avwx-test-key',
    ...extra,
  };
}

function runwayFeature() {
  return {
    properties: {
      notamId: '!JFK 06/021',
      classification: 'DOM',
      text: 'RWY 13L/31R CLSD',
      effectiveStart: START,
      effectiveEnd: END,
      qcode: 'QMRLC',
    },
  };
}

function avwxRunway({ number = { repr: '!JFK 06/021' }, end = END, raw = 'RWY 13L/31R CLSD' } = {}) {
  return {
    raw,
    sanitized: 'SANITIZED SHOULD LOSE TO RAW',
    number,
    type: { repr: 'NOTAMN', value: 'New' },
    qualifiers: { code: 'QMRLC', repr: 'ZNY/QMRLC/IV/NBO/A/000/999' },
    start_time: { repr: '2610010000', dt: START },
    end_time: { repr: '2610200000', dt: end },
  };
}

function avwxTaxiway() {
  return {
    raw: '',
    sanitized: '12/083 NOTAMN\nQ) ZJX/QMXLT/IV/NBO/A/000/999/2825N08118W005\nE) TWY A BTN WEST RAMP',
    number: '12/083',
    type: { repr: 'NOTAMN', value: 'New' },
    qualifiers: {
      repr: 'ZJX/QMXLT/IV/NBO/A/000/999/2825N08118W005',
      subject: { repr: 'MX', value: 'Taxiway' },
      condition: { repr: 'LT', value: 'Limited to' },
    },
    start_time: { dt: START },
    end_time: { repr: 'PERM', value: 'Permanent' },
  };
}

function ctx(overrides = {}) {
  return {
    env: faaCreds(),
    tokenCache: { token: null, expiresAt: 0 },
    circuit: createFaaAuthCircuit(),
    now: NOW,
    ...overrides,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function memoryDb(initial = {}) {
  const docs = new Map(Object.entries(initial));
  return {
    docs,
    collection() {
      return {
        doc(id) {
          return {
            async get() {
              if (!docs.has(id)) return { exists: false, data() { return undefined; } };
              return { exists: true, data() { return docs.get(id); } };
            },
            async set(value) { docs.set(id, value); },
          };
        },
      };
    },
  };
}

test('FAA endpoints default to production and honor overrides', () => {
  assert.deepEqual(faaEndpoints({}), {
    tokenUrl: DEFAULT_FAA_TOKEN_URL,
    apiBase: DEFAULT_FAA_API_BASE,
  });
  assert.equal(DEFAULT_FAA_TOKEN_URL, 'https://api-nms.aim.faa.gov/v1/auth/token');
  assert.equal(DEFAULT_FAA_API_BASE, 'https://api-nms.aim.faa.gov/nmsapi');
  assert.deepEqual(faaEndpoints({
    FAA_NMS_TOKEN_URL: 'https://faa.example/token',
    FAA_NMS_API_BASE: 'https://faa.example/nmsapi/',
  }), {
    tokenUrl: 'https://faa.example/token',
    apiBase: 'https://faa.example/nmsapi',
  });
});

test('mapAvwxNotam maps documented fields and classifies through the FAA rules', () => {
  const mapped = mapAvwxNotam(avwxRunway());
  assert.equal(mapped.id, '!JFK 06/021');
  assert.equal(mapped.classification, 'NOTAMN');
  assert.equal(mapped.text, 'RWY 13L/31R CLSD');
  assert.equal(mapped.qcode, 'QMRLC');
  assert.equal(mapped.type, 'RWY');
  assert.equal(mapped.severity, 'high');
  assert.equal(mapped.summary, 'RWY 13L/31R CLOSED');
  assert.equal(mapped.effectiveStart, Date.parse(START));
  assert.equal(mapped.effectiveEnd, Date.parse(END));

  const fromStringNumber = mapAvwxNotam(avwxRunway({ number: '06/021' }));
  assert.equal(fromStringNumber.id, '06/021');

  const taxiway = mapAvwxNotam(avwxTaxiway());
  assert.equal(taxiway.id, '12/083');
  assert.equal(taxiway.qcode, 'QMXLT');
  assert.equal(taxiway.type, 'TWY');
  assert.equal(taxiway.severity, 'low');
  assert.match(taxiway.text, /TWY A BTN WEST RAMP/);
  assert.equal(taxiway.effectiveEnd, null);
  assert.equal(isActive(taxiway, NOW), true);
});

test('isActive drops NOTAMs whose effective window has ended', () => {
  const expired = mapAvwxNotam(avwxRunway({ end: EXPIRED_END }));
  assert.equal(isActive(expired, NOW), false);
  const payload = buildNotamPayload('KJFK', [expired, mapAvwxNotam(avwxRunway())], 'avwx', NOW);
  assert.equal(payload.count, 1);
  assert.equal(payload.filteredCount, 1);
  assert.equal(payload.notams[0].id, '!JFK 06/021');
  assert.equal(payload.source, 'avwx');
});

test('fetchNotamsFromAvwx sends the raw API key and reads the data array', async () => {
  const calls = [];
  const items = await fetchNotamsFromAvwx('kjfk', {
    env: { AVWX_API_KEY: 'avwx-test-key' },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ meta: {}, data: [avwxRunway(), avwxTaxiway()] });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${AVWX_NOTAM_URL}/kjfk`);
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers.Authorization, 'avwx-test-key');
  assert.equal(calls[0].opts.headers.Authorization.startsWith('Bearer '), false);
  assert.equal(items.length, 2);
});

test('fetchNotamsFromAvwx treats 404 as an empty list and errors on auth failure', async () => {
  const empty = await fetchNotamsFromAvwx('KZZZ', {
    env: { AVWX_API_KEY: 'avwx-test-key' },
    fetchImpl: async () => jsonResponse({ error: 'not found' }, 404),
  });
  assert.deepEqual(empty, []);

  await assert.rejects(
    () => fetchNotamsFromAvwx('KJFK', {
      env: {},
      fetchImpl: async () => { throw new Error('should not be called'); },
    }),
    /AVWX_API_KEY not configured/,
  );

  await assert.rejects(
    () => fetchNotamsFromAvwx('KJFK', {
      env: { AVWX_API_KEY: 'avwx-test-key' },
      fetchImpl: async () => jsonResponse('{"error":"missing authorization"}', 401),
    }),
    /AVWX NOTAM fetch failed: 401/,
  );
});

test('resolveNotams uses FAA when it succeeds and does not call AVWX', async () => {
  const calls = [];
  const payload = await resolveNotams('KJFK', ctx({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/v1/auth/token')) {
        return jsonResponse({ access_token: 'faa-token', expires_in: 3600 });
      }
      return jsonResponse({ type: 'FeatureCollection', features: [runwayFeature()] });
    },
  }));
  assert.equal(payload.source, 'faa');
  assert.equal(payload.count, 1);
  assert.equal(payload.notams[0].id, '!JFK 06/021');
  assert.equal(payload.notams[0].type, 'RWY');
  assert.equal(payload.significantOnly.length, 1);
  assert.equal(calls.some((url) => url.includes('avwx.rest')), false);
  assert.equal(calls[0], DEFAULT_FAA_TOKEN_URL);
  assert.equal(calls[1], `${DEFAULT_FAA_API_BASE}/v1/notams?location=KJFK`);
});

test('resolveNotams sends FAA calls to configured URLs', async () => {
  const calls = [];
  await resolveNotams('KTEB', ctx({
    env: faaCreds({
      FAA_NMS_TOKEN_URL: 'https://faa.example/token',
      FAA_NMS_API_BASE: 'https://faa.example/nmsapi/',
    }),
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/token')) return jsonResponse({ access_token: 't', expires_in: 60 });
      return jsonResponse({ features: [] });
    },
  }));
  assert.deepEqual(calls, [
    'https://faa.example/token',
    'https://faa.example/nmsapi/v1/notams?location=KTEB',
  ]);
});

test('FAA 404 is an empty FAA result and does not fall back', async () => {
  const calls = [];
  const payload = await resolveNotams('KAAA', ctx({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('/token')) return jsonResponse({ access_token: 't', expires_in: 3600 });
      return jsonResponse('no notams', 404);
    },
  }));
  assert.equal(payload.source, 'faa');
  assert.equal(payload.count, 0);
  assert.equal(calls.some((url) => url.includes('avwx.rest')), false);
});

test('missing FAA credentials skip FAA and use AVWX', async () => {
  const calls = [];
  const payload = await resolveNotams('KJFK', ctx({
    env: { AVWX_API_KEY: 'avwx-test-key' },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ data: [avwxRunway()] });
    },
  }));
  assert.equal(payload.source, 'avwx');
  assert.equal(payload.notams[0].severity, 'high');
  assert.deepEqual(calls, [`${AVWX_NOTAM_URL}/KJFK`]);
});

test('FAA errors fall back to AVWX and filter expired reports', async () => {
  const calls = [];
  const payload = await resolveNotams('KJFK', ctx({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('api-nms.aim.faa.gov')) {
        return jsonResponse('upstream down', 503);
      }
      return jsonResponse({
        data: [avwxRunway({ end: EXPIRED_END, number: 'EXPIRED' }), avwxTaxiway()],
      });
    },
  }));
  assert.equal(payload.source, 'avwx');
  assert.equal(payload.count, 1);
  assert.equal(payload.notams[0].id, '12/083');
  assert.equal(payload.filteredCount, 0);
  assert.equal(calls.filter((url) => url.includes('avwx.rest')).length, 1);
});

test('repeated FAA 401s short-circuit later lookups to AVWX', async () => {
  const circuit = createFaaAuthCircuit({ threshold: 2, cooldownMs: 15 * 60 * 1000 });
  const tokenCache = { token: null, expiresAt: 0 };
  let faaCalls = 0;
  let avwxCalls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('avwx.rest')) {
      avwxCalls += 1;
      return jsonResponse({ data: [avwxRunway()] });
    }
    faaCalls += 1;
    return jsonResponse('{"error":"invalid_client"}', 401);
  };
  const base = { fetchImpl, circuit, tokenCache, env: faaCreds(), now: NOW };

  const first = await resolveNotams('KJFK', base);
  const second = await resolveNotams('KTEB', base);
  const faaAfterTwo = faaCalls;
  const third = await resolveNotams('KMCO', { ...base, now: NOW + 1000 });

  assert.equal(first.source, 'avwx');
  assert.equal(second.source, 'avwx');
  assert.equal(third.source, 'avwx');
  assert.equal(faaAfterTwo, 2);
  assert.equal(faaCalls, 2);
  assert.equal(avwxCalls, 3);
  assert.equal(circuit.bypassed(NOW + 1000), true);

  const recovered = await resolveNotams('KJFK', {
    ...base,
    now: NOW + 15 * 60 * 1000 + 1,
    fetchImpl: async (url) => {
      faaCalls += 1;
      if (String(url).includes('/token')) return jsonResponse({ access_token: 'recovered', expires_in: 3600 });
      return jsonResponse({ features: [runwayFeature()] });
    },
  });
  assert.equal(recovered.source, 'faa');
  assert.equal(circuit.bypassed(NOW + 15 * 60 * 1000 + 1), false);
});

test('both sources failing is a single error and the handler soft-fails', async () => {
  await assert.rejects(
    () => resolveNotams('KJFK', ctx({
      fetchImpl: async (url) => {
        if (String(url).includes('avwx.rest')) return jsonResponse('nope', 500);
        return jsonResponse('{"error":"invalid_client"}', 401);
      },
    })),
    (err) => {
      assert.match(err.message, /FAA: FAA token request failed: 401/);
      assert.match(err.message, /invalid_client/);
      assert.match(err.message, /AVWX: AVWX NOTAM fetch failed: 500/);
      return true;
    },
  );
});

test('handler caches the source and soft-fails when both providers fail', async () => {
  resetNotamTestHooks();
  try {
    const db = memoryDb({
      notam_KCACHE: {
        cachedAt: Date.now(),
        payload: {
          icao: 'KCACHE',
          fetchedAt: NOW,
          count: 1,
          filteredCount: 1,
          source: 'avwx',
          notams: [{ id: 'cached', severity: 'high', type: 'RWY' }],
          significantOnly: [{ id: 'cached', severity: 'high', type: 'RWY' }],
        },
      },
    });
    setNotamTestHooks({
      db,
      env: faaCreds(),
      fetchImpl: async () => { throw new Error('cache hit should not fetch'); },
    });
    const cachedRes = mockRes();
    await handler({ method: 'GET', headers: {}, query: { icao: 'kcache' } }, cachedRes);
    assert.equal(cachedRes.statusCode, 200);
    assert.equal(cachedRes.body.ok, true);
    assert.equal(cachedRes.body.cached, true);
    assert.equal(cachedRes.body.source, 'avwx');
    assert.equal(cachedRes.body.notams[0].id, 'cached');

    const calls = [];
    setNotamTestHooks({
      db,
      env: faaCreds({
        FAA_NMS_TOKEN_URL: 'https://faa.example/token',
        FAA_NMS_API_BASE: 'https://faa.example/nmsapi',
      }),
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes('faa.example')) return jsonResponse('down', 500);
        return jsonResponse({ data: [avwxRunway()] });
      },
    });
    const liveRes = mockRes();
    await handler({ method: 'GET', headers: {}, query: { icao: 'jfk' } }, liveRes);
    assert.equal(liveRes.body.ok, true);
    assert.equal(liveRes.body.cached, false);
    assert.equal(liveRes.body.source, 'avwx');
    assert.equal(liveRes.body.icao, 'KJFK');
    assert.equal(liveRes.body.count, 1);
    assert.equal(calls[0], 'https://faa.example/token');
    const stored = db.docs.get('notam_KJFK');
    assert.equal(stored.payload.source, 'avwx');
    assert.equal(stored.payload.notams[0].id, '!JFK 06/021');

    const again = mockRes();
    await handler({ method: 'GET', headers: {}, query: { icao: 'JFK' } }, again);
    assert.equal(again.body.cached, true);
    assert.equal(again.body.source, 'avwx');
    assert.equal(calls.length, 2);

    setNotamTestHooks({
      db,
      env: { FAA_NMS_CLIENT_ID: 'id', FAA_NMS_CLIENT_SECRET: 'secret' },
      fetchImpl: async () => jsonResponse('no', 503),
    });
    const failed = mockRes();
    await handler({ method: 'GET', headers: {}, query: { icao: 'KMMM' } }, failed);
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.body.ok, true);
    assert.equal(failed.body.source, null);
    assert.equal(failed.body.count, 0);
    assert.deepEqual(failed.body.notams, []);
    assert.deepEqual(failed.body.significantOnly, []);
    assert.match(failed.body.error, /AVWX_API_KEY not configured/);
  } finally {
    resetNotamTestHooks();
  }
});
