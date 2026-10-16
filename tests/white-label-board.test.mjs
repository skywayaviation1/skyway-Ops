import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { handleWhiteLabelAdmin } from '../api/white-label-boards.js';
import { clearWhiteLabelMemory, servePublicBoard } from '../api/white-label-board.js';
import { serveBoardLogo } from '../api/white-label-logo.js';
import {
  BOARD_CACHE_COLLECTION,
  BOARD_COLLECTION,
  FEED_CACHE_TTL_MS,
  LOGO_MAX_BYTES,
  cacheIsFresh,
  callerMayManageBoards,
  decodeLogoPayload,
  easternDayBounds,
  feedUrlAllowed,
  fetchIcs,
  generatePublicToken,
  inspectLogo,
  isPublicToken,
  loadBoardSchedule,
  publicBoardPath,
  publicPayloadLeaks,
  sanitizePosition,
  sanitizeSvg,
  tripsFromIcal,
} from '../src/white-label-board.js';

const root = path.resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-16T15:00:00Z');
const FEED = 'https://feeds.example.com/northstar/secret-calendar.ics';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ics() {
  return [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:leg-ns4k2q@secret.example',
    'DTSTART:20261016T140000Z',
    'DTEND:20261016T170000Z',
    'SUMMARY:[N510NS] Meridian Holdings (TEB - PBI) - Charter',
    'DESCRIPTION:Trip ID: NS4K2Q\\nTrip: #104281\\nPAX: 4\\nBroker: secret-broker@example.com\\nFeed: ' + FEED,
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:leg-number-only',
    'DTSTART:20261016T180000Z',
    'DTEND:20261016T200000Z',
    'SUMMARY:[N622NS] Meridian Holdings (APF - TEB) - Charter',
    'DESCRIPTION:Trip: #882211\\nPAX: 2',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:leg-yesterday',
    'DTSTART:20261016T030000Z',
    'DTEND:20261016T050000Z',
    'SUMMARY:[N734NS] Meridian Holdings (IAD - HYA) - Charter',
    'DESCRIPTION:Trip ID: YDAY01\\nPAX: 3',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:leg-hold',
    'DTSTART:20261016T150000Z',
    'DTEND:20261016T160000Z',
    'SUMMARY:[N510NS] Crew 525CR - Crew assignment',
    'DESCRIPTION:Trip ID: HOLD01\\nPAX: 0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function createStore() {
  const collections = new Map();
  function bag(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  function collection(name) {
    const filters = [];
    let limitCount = Infinity;
    let orderField = null;
    const api = {
      doc(id) {
        return {
          id,
          async get() {
            const data = bag(name).get(id);
            return { id, exists: data != null, data: () => (data ? { ...data } : undefined) };
          },
          async set(payload) { bag(name).set(id, { ...payload }); },
          async delete() { bag(name).delete(id); },
        };
      },
      where(field, op, value) {
        if (op !== '==') throw new Error(op);
        filters.push([field, value]);
        return api;
      },
      orderBy(field) { orderField = field; return api; },
      limit(count) { limitCount = count; return api; },
      async get() {
        let entries = [...bag(name).entries()].map(([id, data]) => ({ id, data: { ...data } }));
        for (const [field, value] of filters) entries = entries.filter((entry) => entry.data[field] === value);
        if (orderField) entries.sort((a, b) => (b.data[orderField] || 0) - (a.data[orderField] || 0));
        entries = entries.slice(0, limitCount);
        return {
          empty: entries.length === 0,
          size: entries.length,
          docs: entries.map((entry) => ({ id: entry.id, data: () => ({ ...entry.data }) })),
        };
      },
    };
    return api;
  }
  return {
    collection,
    dump(name) {
      return [...bag(name).entries()].map(([id, data]) => ({ id, ...data }));
    },
  };
}

function createBucket() {
  const files = new Map();
  return {
    files,
    file(path) {
      return {
        async save(body, options) {
          files.set(path, { body: Buffer.from(body), contentType: options?.metadata?.contentType || '' });
        },
        async download() {
          const item = files.get(path);
          if (!item) {
            const error = new Error('missing');
            error.code = 404;
            throw error;
          }
          return [item.body];
        },
        async delete() { files.delete(path); },
      };
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function authorize(idToken) {
  if (idToken === 'ops') return { uid: 'ops-1', name: 'Avery Chen', role: 'ops' };
  if (idToken === 'crew') return { uid: 'crew-1', name: 'Pat Crew', role: 'crew' };
  return null;
}

function fetchImplFactory(calls) {
  return async (url) => {
    calls.push(String(url));
    const href = String(url);
    if (href.includes('aviationweather.gov')) {
      const icao = new URL(href).searchParams.get('ids');
      return {
        ok: true,
        json: async () => [{ icaoId: icao, fltCat: 'VFR', wdir: 180, wspd: 8, visib: 10, clouds: [] }],
      };
    }
    if (href.includes('secret-calendar.ics')) {
      return { ok: true, status: 200, headers: { get() { return null; } }, text: async () => ics() };
    }
    return { ok: false, status: 404, headers: { get() { return null; } }, text: async () => 'missing' };
  };
}

const resolveHost = async () => ['8.8.8.8'];

function deps(db, bucket, calls = []) {
  return {
    authorize,
    db,
    bucket,
    now: () => NOW,
    fetchImpl: fetchImplFactory(calls),
    resolveHost,
  };
}

test('public tokens are unguessable and the path is /board/<token>', () => {
  const token = generatePublicToken();
  assert.equal(isPublicToken(token), true);
  assert.ok(token.length >= 20);
  assert.equal(publicBoardPath(token), `/board/${token}`);
  assert.equal(isPublicToken('short-token'), false);
  assert.equal(publicBoardPath('../admin'), null);
  assert.equal(callerMayManageBoards({ role: 'ops', active: true, approved: true }), true);
  assert.equal(callerMayManageBoards({ role: 'admin', active: true, approved: true }), true);
  assert.equal(callerMayManageBoards({ role: 'crew', active: true, approved: true }), false);
  assert.equal(callerMayManageBoards({ role: 'ops', active: false, approved: true }), false);
  assert.equal(callerMayManageBoards({ role: 'admin', appReviewer: true, active: true, approved: true }), false);
});

test('feed URLs are https hostnames, never private or local targets', () => {
  assert.equal(feedUrlAllowed(FEED), true);
  assert.equal(feedUrlAllowed('https://portal.jetinsight.com/schedule/a/b.ics'), true);
  assert.equal(feedUrlAllowed('http://portal.jetinsight.com/a.ics'), false);
  assert.equal(feedUrlAllowed('https://localhost/a.ics'), false);
  assert.equal(feedUrlAllowed('https://127.0.0.1/a.ics'), false);
  assert.equal(feedUrlAllowed('https://169.254.169.254/latest'), false);
  assert.equal(feedUrlAllowed('https://10.0.0.8/feed.ics'), false);
  assert.equal(feedUrlAllowed('https://calendar.example.internal/feed.ics'), false);
  assert.equal(feedUrlAllowed('https://user:pass@feeds.example.com/a.ics'), false);
  assert.equal(feedUrlAllowed('file:///etc/passwd'), false);
});

test('a redirect onto a private host is not followed', async () => {
  await assert.rejects(() => fetchIcs('https://ok.example/feed.ics', async (url) => {
    if (String(url).includes('ok.example')) {
      return { ok: false, status: 302, headers: { get: () => 'https://10.1.1.1/feed.ics' }, text: async () => '' };
    }
    throw new Error('followed private redirect');
  }, resolveHost));
});

test('today\'s trips keep the 6–7 character trip id and drop trip numbers and customer data', () => {
  const { start, end } = easternDayBounds(NOW);
  assert.ok(Date.parse('2026-10-16T14:00:00Z') >= start && Date.parse('2026-10-16T14:00:00Z') < end);
  assert.ok(Date.parse('2026-10-16T03:00:00Z') < start);
  const trips = tripsFromIcal(ics(), NOW);
  assert.deepEqual(trips.map((trip) => trip.info.tripCode), ['NS4K2Q', null]);
  assert.deepEqual(trips.map((trip) => trip.info.tail), ['N510NS', 'N622NS']);
  const blob = JSON.stringify(trips);
  assert.equal(blob.includes('#104281'), false);
  assert.equal(blob.includes('#882211'), false);
  assert.equal(blob.includes('Meridian'), false);
  assert.equal(blob.includes('secret-broker'), false);
  assert.equal(blob.includes(FEED), false);
  assert.equal(blob.includes('YDAY01'), false);
  assert.equal(blob.includes('HOLD01'), false);
  for (const trip of trips) {
    assert.deepEqual(Object.keys(trip.info).sort(), ['from', 'isFlight', 'isOps', 'tail', 'to', 'tripCode']);
  }
});

test('position sanitizer keeps map fields and drops AeroAPI internals', () => {
  const clean = sanitizePosition({
    airborne: true,
    latitude: 36.4,
    longitude: -77.1,
    altitude: 41000,
    groundspeed: 430,
    faFlightId: 'FA-SECRET-999',
    filedFlights: [{ trip: 'internal-skyway-trip' }],
    brokerEmail: 'dispatch@flyskyway.com',
    error: null,
  });
  assert.equal(clean.latitude, 36.4);
  assert.equal(clean.airborne, true);
  assert.equal(JSON.stringify(clean).includes('FA-SECRET-999'), false);
  assert.equal(JSON.stringify(clean).includes('internal-skyway-trip'), false);
  assert.equal(JSON.stringify(clean).includes('dispatch@'), false);
  assert.equal(sanitizePosition({ error: 'FA 500', airborne: false, latitude: 1 }), null);
});

test('logos are PNG, JPEG, or SVG and stay under 2MB', () => {
  const png = inspectLogo(PNG);
  assert.equal(png.ok, true);
  assert.equal(png.contentType, 'image/png');
  const jpeg = inspectLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]));
  assert.equal(jpeg.contentType, 'image/jpeg');
  const svg = inspectLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'));
  assert.equal(svg.contentType, 'image/svg+xml');
  assert.equal(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), null);
  assert.equal(inspectLogo(Buffer.alloc(LOGO_MAX_BYTES + 1, 1)).ok, false);
  const decoded = decodeLogoPayload({ dataBase64: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.equal(decoded.contentType, 'image/png');
});

test('the feed cache lasts about three minutes and falls back when the feed fails', async () => {
  assert.equal(FEED_CACHE_TTL_MS, 3 * 60 * 1000);
  assert.equal(cacheIsFresh(NOW - FEED_CACHE_TTL_MS + 1000, NOW), true);
  assert.equal(cacheIsFresh(NOW - FEED_CACHE_TTL_MS, NOW), false);
  const calls = [];
  const first = await loadBoardSchedule({
    feedUrl: FEED,
    now: NOW,
    fetchImpl: fetchImplFactory(calls),
    resolveHost,
    loadWeather: async () => ({ KTEB: { metar: { flightCategory: 'VFR', windKt: 8 } } }),
  });
  assert.equal(first.source, 'feed');
  assert.equal(first.trips[0].info.tripCode, 'NS4K2Q');
  const cached = await loadBoardSchedule({
    feedUrl: FEED,
    cached: first,
    now: NOW + 60_000,
    fetchImpl: async () => { throw new Error('should use cache'); },
    resolveHost,
  });
  assert.equal(cached.source, 'cache');
  const stale = await loadBoardSchedule({
    feedUrl: FEED,
    cached: { ...first, fetchedAt: NOW - FEED_CACHE_TTL_MS - 1 },
    now: NOW,
    fetchImpl: async () => { throw new Error('down'); },
    resolveHost,
  });
  assert.equal(stale.source, 'stale');
  assert.equal(stale.trips[0].info.tripCode, 'NS4K2Q');
  assert.equal(calls.some((url) => url.includes(FEED)), true);
});

test('admin setup creates, rotates, and disables a board without leaking the feed publicly', async () => {
  clearWhiteLabelMemory();
  const db = createStore();
  const bucket = createBucket();
  const calls = [];
  const base = deps(db, bucket, calls);

  const denied = mockRes();
  await handleWhiteLabelAdmin({ method: 'POST', body: { idToken: 'crew', action: 'list' } }, denied, base);
  assert.equal(denied.statusCode, 403);

  const anon = mockRes();
  await handleWhiteLabelAdmin({ method: 'POST', body: { action: 'list' } }, anon, base);
  assert.equal(anon.statusCode, 401);

  const badFeed = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: { idToken: 'ops', action: 'create', companyName: 'Northstar Charter', feedUrl: 'http://10.0.0.1/a.ics' },
  }, badFeed, base);
  assert.equal(badFeed.statusCode, 400);

  const created = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: {
      idToken: 'ops',
      action: 'create',
      companyName: 'Northstar Charter',
      accentColor: '#e2b15a',
      feedUrl: FEED,
      poweredBy: true,
      enabled: true,
      logo: { dataBase64: PNG.toString('base64'), contentType: 'image/png' },
    },
  }, created, base);
  assert.equal(created.statusCode, 200);
  const board = created.body.board;
  assert.equal(board.accentColor, '#E2B15A');
  assert.equal(board.poweredBy, true);
  assert.equal(isPublicToken(board.publicToken), true);
  assert.equal(board.publicPath, `/board/${board.publicToken}`);
  assert.equal(board.hasLogo, true);
  assert.equal(bucket.files.size, 1);

  await db.collection('flightaware-state').doc('N510NS').set({
    airborne: true,
    latitude: 36.4,
    longitude: -77.1,
    altitude: 41000,
    groundspeed: 430,
    polledAt: NOW - 60_000,
    faFlightId: 'FA-SECRET-999',
    filedFlights: [{ ident: 'internal-skyway-trip' }],
  });
  await db.collection('flightaware-state').doc('N999XX').set({
    airborne: true,
    latitude: 1,
    longitude: 2,
    brokerEmail: 'dispatch@flyskyway.com',
    faFlightId: 'OTHER-BOARD',
  });
  await db.collection(BOARD_COLLECTION).doc('other-board').set({
    companyName: 'Skyway Internal Desk',
    feedUrl: 'https://feeds.example.com/skyway/private.ics',
    publicToken: generatePublicToken(),
    enabled: true,
    accentColor: '#2DD4BF',
    updatedAt: NOW,
  });

  const pub = await servePublicBoard({
    db, token: board.publicToken, now: NOW, fetchImpl: fetchImplFactory(calls), resolveHost,
  });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.companyName, 'Northstar Charter');
  assert.equal(pub.body.accentColor, '#E2B15A');
  assert.equal(pub.body.poweredBy, true);
  assert.equal(pub.body.hasLogo, true);
  assert.equal(pub.body.trips[0].info.tripCode, 'NS4K2Q');
  assert.deepEqual(Object.keys(pub.body.positions), ['N510NS']);
  assert.equal(pub.body.positions.N510NS.latitude, 36.4);
  assert.equal(publicPayloadLeaks(pub.body, [FEED, 'Meridian', '#104281', '#882211', 'FA-SECRET-999', 'internal-skyway-trip', 'dispatch@flyskyway.com', 'Skyway Internal', 'private.ics']), false);
  const cache = db.dump(BOARD_CACHE_COLLECTION);
  assert.equal(JSON.stringify(cache).includes(FEED), false);
  assert.equal(Object.hasOwn(cache[0], 'feedUrl'), false);

  const againCalls = [];
  const again = await servePublicBoard({
    db, token: board.publicToken, now: NOW + 30_000, fetchImpl: fetchImplFactory(againCalls), resolveHost,
  });
  assert.equal(again.status, 200);
  assert.equal(againCalls.length, 0);

  const logo = await serveBoardLogo({ db, bucket, token: board.publicToken });
  assert.equal(logo.status, 200);
  assert.equal(logo.contentType, 'image/png');
  assert.equal(logo.body.equals(PNG), true);

  const rotated = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: { idToken: 'ops', action: 'regenerate', boardId: board.id },
  }, rotated, base);
  assert.equal(rotated.statusCode, 200);
  assert.notEqual(rotated.body.board.publicToken, board.publicToken);
  const oldLink = await servePublicBoard({ db, token: board.publicToken, now: NOW, fetchImpl: fetchImplFactory([]), resolveHost });
  assert.equal(oldLink.status, 404);
  assert.deepEqual(oldLink.body, { ok: false });
  const oldLogo = await serveBoardLogo({ db, bucket, token: board.publicToken });
  assert.equal(oldLogo.status, 404);

  const disabled = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: {
      idToken: 'ops',
      action: 'update',
      boardId: board.id,
      companyName: 'Northstar Charter',
      accentColor: '#E2B15A',
      feedUrl: FEED,
      poweredBy: false,
      enabled: false,
    },
  }, disabled, base);
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.body.board.enabled, false);
  assert.equal(disabled.body.board.poweredBy, false);
  const hidden = await servePublicBoard({
    db, token: rotated.body.board.publicToken, now: NOW, fetchImpl: fetchImplFactory([]), resolveHost,
  });
  assert.equal(hidden.status, 404);

  const checked = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: { idToken: 'ops', action: 'check-feed', feedUrl: FEED },
  }, checked, base);
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.tripsToday, 2);
  assert.deepEqual(checked.body.tails, ['N510NS', 'N622NS']);
  assert.equal(JSON.stringify(checked.body).includes(FEED), false);
  assert.equal(JSON.stringify(checked.body).includes('Meridian'), false);

  const removed = mockRes();
  await handleWhiteLabelAdmin({
    method: 'POST',
    body: { idToken: 'ops', action: 'delete', boardId: board.id },
  }, removed, base);
  assert.equal(removed.statusCode, 200);
  assert.equal(bucket.files.size, 0);
  assert.equal(db.dump(BOARD_COLLECTION).some((item) => item.id === board.id), false);
});

test('rules deny client access and are not deployed as a full ruleset', async () => {
  const firestore = await readFile(path.join(root, 'firebase/appusers-white-label-boards.rules'), 'utf8');
  const storage = await readFile(path.join(root, 'firebase/storage-white-label.rules'), 'utf8');
  const firebase = await readFile(path.join(root, 'firebase.json'), 'utf8');
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const main = await readFile(path.join(root, 'src/main.jsx'), 'utf8');
  const page = await readFile(path.join(root, 'src/WhiteLabelBoardPage.jsx'), 'utf8');
  const setup = await readFile(path.join(root, 'src/WhiteLabelBoards.jsx'), 'utf8');

  assert.match(firestore, /DO NOT deploy this file by itself/);
  assert.match(firestore, /match \/white-label-boards\/\{boardId\}/);
  assert.match(firestore, /match \/white-label-feed-cache\/\{boardId\}/);
  assert.match(firestore, /allow read, write: if false/);
  assert.match(storage, /DO NOT deploy this file by itself/);
  assert.match(storage, /match \/white-label-boards\/\{boardId\}\/\{fileName\}/);
  assert.match(storage, /allow read, write: if false/);
  assert.doesNotMatch(firebase, /white-label/);

  assert.match(app, /id: 'white-label', label: 'TV boards'/);
  assert.match(app, /roles: \['ops', 'admin'\]/);
  assert.match(setup, /Powered by SKYWAY.app/);
  assert.ok(main.includes('WhiteLabelBoardPage token={whiteLabelMatch[1]}'));
  assert.ok(main.includes('match(/^\\/board\\/([A-Za-z0-9_-]{20,128})$/)'));
  assert.match(page, /\/api\/white-label-board\?token=/);
  assert.match(page, /isolated/);
  assert.doesNotMatch(page, /firebase/);
  assert.doesNotMatch(page, /aeroapi|flightaware\.com/i);
  assert.match(await readFile(path.join(root, 'src/FlightBoard.jsx'), 'utf8'), /if \(isolated\)/);
});
