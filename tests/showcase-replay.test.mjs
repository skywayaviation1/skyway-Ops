import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { lookupCoords } from '../src/airport-coords.js';
import { demoShowcasePayload } from '../src/showcase-demo.js';
import {
  PUBLIC_LEG_KEYS,
  SHOWCASE_CACHE_MS,
  SHOWCASE_HOLD_MS,
  SHOWCASE_LOOP_MS,
  SHOWCASE_MAX_LEG_MS,
  SHOWCASE_MIN_LEG_MS,
  SHOWCASE_PLAY_MS,
  bearingDeg,
  buildShowcaseArchive,
  frameActors,
  initialPlayMs,
  interpolateGreatCircle,
  isCompletedShowcaseLeg,
  SHOWCASE_TOKEN_ALPHABET,
  isShowcaseToken,
  normalizeShowcaseToken,
  parseShowcaseHistoryCsv,
  parseShowcasePath,
  playbackWindow,
  projectShowcaseLeg,
  publicShowcaseBody,
  sampleRoute,
  scheduleShowcasePlayback,
  selectShowcaseLegs,
  showcaseColorKey,
  showcaseDayKey,
  showcaseSnapshot,
  showcaseUrl,
  zonedStartOfYearMs,
} from '../src/showcase-replay.js';
import { handleShowcaseReplay } from '../api/showcase-replay.js';
import { handleShowcaseAdmin } from '../api/showcase-admin.js';
import { mintShowcaseToken } from '../api/_showcase.js';

const root = path.resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-21T16:00:00.000Z');
const YEAR_START = Date.parse('2026-01-01T05:00:00.000Z');

const COORDS = {
  TEB: { lat: 40.8501, lng: -74.0608 },
  MIA: { lat: 25.7959, lng: -80.287 },
  OPF: { lat: 25.907, lng: -80.2784 },
  NAS: { lat: 25.039, lng: -77.4662 },
  LAS: { lat: 36.084, lng: -115.1537 },
};

function lookup(code) {
  return COORDS[String(code || '').toUpperCase()] || null;
}

function raw(overrides = {}) {
  return {
    uid: 'leg-secret-uid',
    tripCode: 'SECRET1',
    customer: 'Northwind Charter',
    broker: 'Secret Broker',
    pic: 'Ada Lovelace',
    sic: 'Grace Hopper',
    pax: ['Hidden Person'],
    price: 25000,
    crew: ['Ada Lovelace'],
    from: 'TEB',
    to: 'MIA',
    tail: 'N551SK',
    departure: '2026-06-02T14:00:00.000Z',
    arrival: '2026-06-02T17:15:00.000Z',
    category: 'REVENUE',
    isFlight: true,
    cancelled: false,
    ...overrides,
  };
}

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function memoryDb({ config = null, legs = [], users = {} } = {}) {
  const state = { config, legs, users };
  let legReads = 0;
  const db = {
    state,
    legReads: () => legReads,
    collection(name) {
      if (name === 'showcase') {
        return {
          doc() {
            return {
              async get() {
                return { exists: state.config != null, data: () => state.config };
              },
              async set(value) {
                state.config = state.config ? { ...state.config, ...value } : { ...value };
              },
            };
          },
        };
      }
      if (name === 'users') {
        return {
          doc(id) {
            return {
              async get() {
                const value = state.users[id];
                return { exists: !!value, data: () => value || {} };
              },
            };
          },
        };
      }
      if (name === 'legs') {
        const query = {
          orderBy() { return query; },
          limit() { return query; },
          startAfter() { return query; },
          async get() {
            legReads += 1;
            return {
              empty: state.legs.length === 0,
              size: state.legs.length,
              docs: state.legs.map((data, index) => ({
                id: `L${index}`,
                data: () => ({ ...data }),
              })),
            };
          },
        };
        return query;
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return db;
}

test('the showcase year starts at midnight Eastern', () => {
  assert.equal(zonedStartOfYearMs(NOW), YEAR_START);
  assert.equal(zonedStartOfYearMs(Date.parse('2026-01-01T04:30:00.000Z')), Date.parse('2025-01-01T05:00:00.000Z'));
});

test('completed legs keep only the public fields', () => {
  const selected = selectShowcaseLegs([
    raw(),
    raw({ category: 'REPO', from: 'MIA', to: 'NAS', tail: 'N882SK', departure: '2026-06-03T14:00:00.000Z', arrival: '2026-06-03T16:00:00.000Z' }),
    raw({ cancelled: true }),
    raw({ category: 'HOLD' }),
    raw({ category: 'TRAINING' }),
    raw({ isFlight: false }),
    raw({ from: 'MIA', to: 'MIA' }),
    raw({ tail: '' }),
    raw({ from: 'ZZZ', to: 'QQQ' }),
    raw({ departure: '2025-12-31T22:00:00.000Z', arrival: '2026-01-01T01:00:00.000Z' }),
    raw({ departure: '2026-01-01T04:30:00.000Z', arrival: '2026-01-01T07:00:00.000Z' }),
    raw({ departure: '2026-10-21T18:00:00.000Z', arrival: '2026-10-21T21:00:00.000Z' }),
  ], { now: NOW, lookupCoords: lookup, historyRows: [] });
  assert.equal(selected.legs.length, 2);
  assert.equal(selected.legs[0].tail, 'N551SK');
  assert.equal(selected.legs[1].category, undefined);
  const body = publicShowcaseBody(selected, NOW);
  assert.deepEqual(Object.keys(body.legs[0]), [...PUBLIC_LEG_KEYS]);
  const blob = JSON.stringify(body);
  for (const secret of ['Northwind', 'Secret Broker', 'Ada Lovelace', 'Grace Hopper', 'SECRET1', '25000', 'leg-secret-uid', 'Hidden Person']) {
    assert.equal(blob.includes(secret), false, secret);
  }
  assert.equal(isCompletedShowcaseLeg(raw({ category: 'MX' }), { now: NOW, yearStart: YEAR_START }), false);
  assert.equal(projectShowcaseLeg(raw({ from: 'NOPE', to: 'NADA' }), lookup), null);
});

test('real airport lookup still drops private schedule fields', () => {
  const selected = selectShowcaseLegs([raw({
    from: 'KTEB',
    to: 'KMIA',
    customer: 'Northwind Charter',
    price: 82000,
  })], { now: NOW, lookupCoords });
  assert.equal(selected.legs.length, 1);
  assert.ok(Math.abs(selected.legs[0].fromLat - 40.85) < 0.2);
  assert.ok(Math.abs(selected.legs[0].toLat - 25.8) < 0.3);
  assert.equal(JSON.stringify(selected.legs[0]).includes('Northwind'), false);
  assert.equal(JSON.stringify(selected.legs[0]).includes('82000'), false);
});

test('the great-circle route bows north and the icon heads along it', () => {
  const jfk = { lat: 40.6413, lng: -73.7781 };
  const lhr = { lat: 51.47, lng: -0.4543 };
  const mid = interpolateGreatCircle(jfk, lhr, 0.5);
  assert.ok(mid.lat > (jfk.lat + lhr.lat) / 2, `mid lat ${mid.lat}`);
  assert.equal(interpolateGreatCircle(jfk, lhr, 0).lat, jfk.lat);
  assert.ok(Math.abs(interpolateGreatCircle(jfk, lhr, 1).lng - lhr.lng) < 0.001);
  const north = bearingDeg({ lat: 26, lng: -80 }, { lat: 27, lng: -80 });
  const east = bearingDeg({ lat: 26, lng: -80 }, { lat: 26, lng: -79 });
  assert.ok(north < 5 || north > 355, `north ${north}`);
  assert.ok(Math.abs(east - 90) < 5, `east ${east}`);
  const samples = sampleRoute(jfk, lhr, 8);
  assert.equal(samples.length, 9);
  assert.ok(samples[4].lat > samples[0].lat);
});

test('the year plays in 2.5 minutes, holds 8 seconds, and overlaps same-day flights', () => {
  assert.ok(SHOWCASE_PLAY_MS >= 120_000 && SHOWCASE_PLAY_MS <= 180_000);
  assert.equal(SHOWCASE_HOLD_MS, 8_000);
  assert.equal(SHOWCASE_LOOP_MS, SHOWCASE_PLAY_MS + SHOWCASE_HOLD_MS);
  assert.equal(SHOWCASE_CACHE_MS, 15 * 60 * 1000);
  assert.ok(SHOWCASE_MIN_LEG_MS >= 3_000 && SHOWCASE_MAX_LEG_MS <= 12_000);

  const early = raw({ departure: '2026-01-05T14:00:00.000Z', arrival: '2026-01-05T17:00:00.000Z' });
  const sameDay = raw({
    tail: 'N882SK',
    from: 'MIA',
    to: 'OPF',
    departure: '2026-01-05T16:00:00.000Z',
    arrival: '2026-01-05T16:40:00.000Z',
  });
  const later = raw({
    tail: 'N100SK',
    from: 'OPF',
    to: 'LAS',
    departure: '2026-06-10T14:00:00.000Z',
    arrival: '2026-06-10T19:00:00.000Z',
  });
  const selected = selectShowcaseLegs([early, sameDay, later], { now: NOW, lookupCoords: lookup, historyRows: [] });
  const body = publicShowcaseBody(selected, NOW);
  const span = playbackWindow(body);
  assert.equal(span.abbreviated, false);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const [a, b, c] = scheduled;
  assert.ok(a.playStart <= b.playStart);
  assert.ok(b.playStart < a.playEnd, 'same-day flights share the screen');
  assert.ok(c.playStart > a.playEnd, 'a flight months later starts after the earlier one lands');
  assert.ok(c.playEnd <= SHOWCASE_PLAY_MS);

  const mid = frameActors(scheduled, (a.playStart + a.playEnd) / 2);
  assert.ok(mid.active.length >= 1);
  const hold = frameActors(scheduled, SHOWCASE_PLAY_MS + 1000);
  assert.equal(hold.holding, true);
  assert.equal(hold.active.length, 0);
  assert.equal(hold.finished.length, 3);
  assert.equal(initialPlayMs({ at: 'hold' }), SHOWCASE_PLAY_MS);
  assert.equal(initialPlayMs({ reducedMotion: true }), SHOWCASE_PLAY_MS);
  assert.equal(initialPlayMs({ at: 0.5 }), SHOWCASE_PLAY_MS / 2);
});

test('a short stored archive plays its own dates and says the year is incomplete', () => {
  const storedFrom = '2026-10-10T14:00:00.000Z';
  const body = publicShowcaseBody({
    yearStart: YEAR_START,
    now: NOW,
    legs: [projectShowcaseLeg(raw({ departure: storedFrom, arrival: '2026-10-10T17:00:00.000Z' }), lookup)],
  }, NOW);
  const span = playbackWindow(body);
  assert.equal(span.abbreviated, true);
  assert.equal(span.start, Date.parse(storedFrom));
});

test('counters grow as legs finish', () => {
  const selected = selectShowcaseLegs([
    raw(),
    raw({
      from: 'MIA',
      to: 'NAS',
      tail: 'N882SK',
      departure: '2026-07-01T14:00:00.000Z',
      arrival: '2026-07-01T16:00:00.000Z',
    }),
  ], { now: NOW, lookupCoords: lookup, historyRows: [] });
  const body = publicShowcaseBody(selected, NOW);
  const span = playbackWindow(body);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const early = showcaseSnapshot(scheduled, 0, span);
  assert.equal(early.flights, 0);
  const done = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS, span);
  assert.equal(done.flights, 2);
  assert.ok(done.nm > 800);
  assert.ok(done.sm > done.nm);
  assert.ok(done.hours > 4);
  assert.equal(done.airports, 3);
  assert.equal(done.topDestinations, undefined);
  assert.equal(done.leaderboard, undefined);
});

test('demo flights cover the year without private fields', () => {
  const body = demoShowcasePayload(NOW);
  assert.ok(body.legs.length > 200, `legs ${body.legs.length}`);
  assert.equal(playbackWindow(body).abbreviated, false);
  assert.deepEqual(Object.keys(body.legs[0]), [...PUBLIC_LEG_KEYS]);
  assert.equal(JSON.stringify(body).includes('customer'), false);
  const span = playbackWindow(body);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const mid = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS * 0.45, span);
  assert.ok(mid.active >= 2, `active ${mid.active}`);
  assert.ok(mid.flights > 40, `flights ${mid.flights}`);
  const hold = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS + 500, span);
  assert.equal(hold.flights, body.legs.length);
  assert.equal(hold.active, 0);
  assert.ok(hold.airports > 8);
  const finale = initialPlayMs({ at: 'finale' });
  assert.ok(finale > SHOWCASE_PLAY_MS && finale < SHOWCASE_LOOP_MS);
});

test('a route with no tail keeps its own color', () => {
  assert.equal(showcaseColorKey({ tail: '', from: 'TEB', to: 'ASE' }), 'TEB-ASE');
  assert.equal(showcaseColorKey({ tail: 'N551SK', from: 'TEB', to: 'ASE' }), 'N551SK');
});

test('history rows are primary, future dates wait, and Firestore fills the gap after the file', () => {
  const history = [
    { date: '2026-01-02', from: 'TEB', to: 'MIA', block: 3.2 },
    { date: '2026-10-15', from: 'MIA', to: 'OPF', block: 0.6 },
    { date: '2026-10-22', from: 'OPF', to: 'TEB', block: 3.4 },
    { date: '2026-06-01', from: 'ZZZ', to: 'QQQ', block: 1.1 },
    { date: '2026-03-01', from: 'TEB', to: 'TEB', block: 0.4 },
  ];
  const stored = [
    raw({
      from: 'KTEB',
      to: 'KMIA',
      tail: 'N551SK',
      customer: 'Northwind Charter',
      departure: '2026-01-02T16:00:00.000Z',
      arrival: '2026-01-02T20:00:00.000Z',
    }),
    raw({
      from: 'OPF',
      to: 'LAS',
      tail: 'N100SK',
      departure: '2026-10-20T15:00:00.000Z',
      arrival: '2026-10-20T19:30:00.000Z',
    }),
  ];
  const earlyCoverage = history.filter((row) => row.date <= '2026-10-15');
  const withGap = buildShowcaseArchive({
    historyRows: earlyCoverage,
    storedLegs: stored,
    now: NOW,
    lookupCoords: lookup,
  });
  assert.deepEqual(withGap.unresolved, ['QQQ', 'ZZZ']);
  assert.equal(withGap.legs.length, 3);
  const january = withGap.legs.find((leg) => leg.from === 'TEB' && leg.to === 'MIA');
  assert.equal(january.tail, 'N551SK');
  assert.equal(january.block, 3.2);
  assert.equal(showcaseDayKey(Date.parse(january.departure)), '2026-01-02');
  const added = withGap.legs.find((leg) => leg.tail === 'N100SK');
  assert.equal(added.from, 'OPF');
  assert.equal(added.to, 'LAS');
  assert.equal(added.block, 4.5);
  assert.equal(JSON.stringify(withGap.legs).includes('Northwind'), false);

  const covered = buildShowcaseArchive({
    historyRows: history,
    storedLegs: stored,
    now: NOW,
    lookupCoords: lookup,
  });
  assert.equal(covered.legs.some((leg) => leg.tail === 'N100SK'), false);
  assert.equal(covered.legs.some((leg) => showcaseDayKey(Date.parse(leg.departure)) > '2026-10-21'), false);
  assert.equal(covered.legs.some((leg) => leg.from === 'OPF' && leg.to === 'TEB'), false);
  const body = publicShowcaseBody(covered, NOW);
  assert.equal(body.archive, 'history');
  assert.equal(playbackWindow(body).abbreviated, false);
  assert.equal(playbackWindow(body).start, YEAR_START);
});

test('the 2026 route file plays through today in Eastern time', async () => {
  const csv = await readFile(path.join(root, 'data/showcase-legs-2026.csv'), 'utf8');
  const rows = parseShowcaseHistoryCsv(csv);
  assert.equal(rows.length, 4038);
  const throughToday = rows.filter((row) => row.date >= '2026-01-01' && row.date <= '2026-10-21');
  assert.equal(throughToday.length, 3766);
  assert.equal(throughToday.reduce((sum, row) => sum + Math.round(row.block * 10), 0), 60651);
  assert.deepEqual(lookupCoords('DJT'), lookupCoords('PBI'));
  assert.deepEqual(lookupCoords('KDJT'), lookupCoords('PBI'));

  const selected = buildShowcaseArchive({
    historyRows: rows,
    storedLegs: [],
    now: NOW,
    lookupCoords,
  });
  assert.deepEqual(selected.unresolved, []);
  assert.equal(selected.archive, 'history');
  assert.equal(selected.legs.length, 3717);
  assert.equal(selected.legs.reduce((sum, leg) => sum + Math.round(leg.block * 10), 0), 60407);
  assert.equal(selected.legs.every((leg) => leg.tail === ''), true);
  assert.equal(selected.legs.some((leg) => leg.from === 'DJT' || leg.to === 'DJT'), true);
  const dates = new Set(selected.legs.map((leg) => showcaseDayKey(Date.parse(leg.departure))));
  assert.equal(dates.has('2026-10-21'), true);
  assert.equal([...dates].some((date) => date > '2026-10-21' || date < '2026-01-01'), false);

  const body = publicShowcaseBody(selected, NOW);
  assert.equal(body.archive, 'history');
  assert.equal(playbackWindow(body).abbreviated, false);
  assert.deepEqual(Object.keys(body.legs[0]), [...PUBLIC_LEG_KEYS]);
  const span = playbackWindow(body);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const hold = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS + 500, span);
  assert.equal(hold.flights, 3717);
  assert.equal(Math.round(hold.hours * 10), 60407);
  assert.ok(hold.airports > 50);

  const token = 'd'.repeat(43);
  const db = memoryDb({ config: { token, enabled: true }, legs: [] });
  const res = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, res, {
    db,
    now: NOW,
    lookupCoords,
    cache: { token: '', day: '', at: 0, body: null },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.archive, 'history');
  assert.equal(res.body.legs.length, 3717);
  assert.equal(res.body.legs.reduce((sum, leg) => sum + Math.round(leg.block * 10), 0), 60407);
});

test('the showcase cache refreshes when the Eastern date changes', async () => {
  const token = 'a'.repeat(43);
  const db = memoryDb({ config: { token, enabled: true }, legs: [raw()] });
  const cache = { token: '', day: '', at: 0, body: null };
  const evening = Date.parse('2026-10-21T03:55:00.000Z');
  const morning = Date.parse('2026-10-21T04:05:00.000Z');
  const first = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, first, {
    db, now: evening, lookupCoords: lookup, historyRows: [], cache,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(db.legReads(), 1);
  const next = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, next, {
    db, now: morning, lookupCoords: lookup, historyRows: [], cache,
  });
  assert.equal(next.statusCode, 200);
  assert.equal(db.legReads(), 2);
});

test('the public route is a token path and unknown tokens are not found', async () => {
  assert.equal(parseShowcasePath('/showcase/abc')?.token, 'abc');
  assert.equal(parseShowcasePath('/schedule'), null);
  assert.equal(parseShowcasePath('/showcase')?.token, '');
  assert.equal(isShowcaseToken('short'), false);
  assert.equal(isShowcaseToken('k7m2xq'), true);
  assert.equal(normalizeShowcaseToken('K7M2XQ'), 'k7m2xq');
  assert.equal(isShowcaseToken('K7M2XQ'), true);
  for (const bad of ['k7m2x0', 'k7m2xo', 'k7m2x1', 'k7m2xl', 'k7m2xi']) {
    assert.equal(isShowcaseToken(bad), false, bad);
  }
  const token = 'a'.repeat(43);
  assert.equal(isShowcaseToken(token), true);
  assert.equal(showcaseUrl(token), `https://skyway.app/showcase/${token}`);

  const db = memoryDb({
    config: { token, enabled: true },
    legs: [raw(), raw({ cancelled: true, customer: 'Northwind Charter', price: 25000 })],
  });
  const cache = { token: '', at: 0, body: null };
  const ok = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, ok, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'public, max-age=900');
  assert.equal(ok.body.legs.length, 1);
  assert.equal(JSON.stringify(ok.body).includes('Northwind'), false);
  assert.equal(JSON.stringify(ok.body).includes(token), false);
  assert.equal(db.legReads(), 1);

  const again = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, again, { db, now: NOW + 60_000, lookupCoords: lookup, historyRows: [], cache });
  assert.equal(again.statusCode, 200);
  assert.equal(db.legReads(), 1);

  const stale = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, stale, {
    db,
    now: NOW + SHOWCASE_CACHE_MS + 1000,
    lookupCoords: lookup, historyRows: [],
    cache,
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(db.legReads(), 2);

  for (const bad of ['nope', 'short-token', token.slice(0, -1) + 'b']) {
    const missed = responseCapture();
    await handleShowcaseReplay({ method: 'GET', query: { token: bad } }, missed, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache: { token: '', at: 0, body: null } });
    assert.equal(missed.statusCode, 404, bad);
    assert.equal(missed.body.error, 'Not found');
  }

  db.state.config = { token, enabled: false };
  const disabled = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, disabled, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache: { token: '', at: 0, body: null } });
  assert.equal(disabled.statusCode, 404);
});

test('ops can mint, rotate, and disable the TV link', async () => {
  const tokens = ['b'.repeat(43), 'c'.repeat(43)];
  const db = memoryDb({
    legs: [raw()],
    users: {
      ops: { role: 'ops', active: true, approved: true, name: 'Skyway Ops' },
      crew: { role: 'crew', active: true, approved: true, name: 'Crew' },
    },
  });
  const deps = {
    db,
    now: NOW,
    lookupCoords: lookup, historyRows: [],
    mint: () => tokens.shift(),
    verifyIdToken: async (token) => {
      if (token === 'ops-session') return { uid: 'ops' };
      if (token === 'crew-session') return { uid: 'crew' };
      throw new Error('bad');
    },
  };
  const crew = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'crew-session', action: 'generate' } }, crew, deps);
  assert.equal(crew.statusCode, 403);

  const created = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'generate' } }, created, deps);
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.enabled, true);
  assert.equal(created.body.url, showcaseUrl('b'.repeat(43)));
  assert.equal(created.body.legCount, 1);
  assert.equal(created.headers['cache-control'], 'no-store');

  const kept = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'generate' } }, kept, deps);
  assert.equal(kept.body.url, showcaseUrl('b'.repeat(43)));

  const rotated = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'regenerate' } }, rotated, deps);
  assert.equal(rotated.body.url, showcaseUrl('c'.repeat(43)));

  const collided = ['k7m2xq', 'k7m2xq', 'p4n8wc'];
  const collisionDb = memoryDb({
    legs: [raw()],
    users: { ops: { role: 'ops', active: true, approved: true, name: 'Skyway Ops' } },
  });
  const collisionDeps = {
    db: collisionDb,
    now: NOW,
    lookupCoords: lookup,
    historyRows: [],
    mint: () => collided.shift(),
    verifyIdToken: async () => ({ uid: 'ops' }),
  };
  const firstCode = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'generate' } }, firstCode, collisionDeps);
  assert.equal(firstCode.body.url, showcaseUrl('k7m2xq'));
  const rotatedCode = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'regenerate' } }, rotatedCode, collisionDeps);
  assert.equal(rotatedCode.body.url, showcaseUrl('p4n8wc'));

  const oldLink = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'b'.repeat(43) } }, oldLink, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache: { token: '', at: 0, body: null } });
  assert.equal(oldLink.statusCode, 404);
  const newLink = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'c'.repeat(43) } }, newLink, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache: { token: '', at: 0, body: null } });
  assert.equal(newLink.statusCode, 200);

  const off = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'disable' } }, off, deps);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.url, null);
  const gone = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'c'.repeat(43) } }, gone, { db, now: NOW, lookupCoords: lookup, historyRows: [], cache: { token: '', at: 0, body: null } });
  assert.equal(gone.statusCode, 404);
});

test('new showcase codes are six unambiguous characters and bad guesses are limited', async () => {
  const seen = new Set();
  for (let i = 0; i < 24; i += 1) {
    const code = mintShowcaseToken();
    assert.match(code, /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
    assert.equal(code.includes('0') || code.includes('1') || /[oli]/.test(code), false);
    assert.equal(SHOWCASE_TOKEN_ALPHABET.includes(code[0]), true);
    seen.add(code);
  }
  assert.ok(seen.size > 1);

  const token = 'k7m2xq';
  const db = memoryDb({ config: { token, enabled: true }, legs: [raw()] });
  const misses = new Map();
  const ip = '198.51.100.10';
  const deps = { db, now: NOW, lookupCoords: lookup, historyRows: [], misses, ip };
  const ok = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'K7M2XQ' } }, ok, deps);
  assert.equal(ok.statusCode, 200);

  for (let i = 0; i < 20; i += 1) {
    const missed = responseCapture();
    await handleShowcaseReplay({ method: 'GET', query: { token: 'zzzzzz' } }, missed, deps);
    assert.equal(missed.statusCode, 404);
  }
  const blocked = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'yyyyyy' } }, blocked, deps);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['retry-after'], '600');

  const stillLive = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, stillLive, deps);
  assert.equal(stillLive.statusCode, 200);

  const legacy = 'd'.repeat(43);
  const legacyDb = memoryDb({ config: { token: legacy, enabled: true }, legs: [raw()] });
  const legacyRes = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: legacy } }, legacyRes, {
    db: legacyDb, now: NOW, lookupCoords: lookup, historyRows: [], misses: new Map(), ip: '198.51.100.11',
  });
  assert.equal(legacyRes.statusCode, 200);
});

test('showcase rules deny every client and the page stays signed-out', async () => {
  const rules = await readFile(path.join(root, 'firebase/appusers-showcase.rules'), 'utf8');
  assert.match(rules, /match \/showcase\/\{id\}/);
  assert.match(rules, /allow read, write: if false/);
  assert.match(rules, /Do not deploy this file by itself/);
  assert.doesNotMatch(rules, /match \/legs\//);

  const main = await readFile(path.join(root, 'src/main.jsx'), 'utf8');
  assert.match(main, /ShowcasePage/);
  assert.match(main, /isShowcaseRoute/);
  assert.match(main, /!isShowcaseRoute/);
  const page = await readFile(path.join(root, 'src/ShowcasePage.jsx'), 'utf8');
  assert.match(page, /import\.meta\.env\.DEV && window\.__SHOWCASE_PAYLOAD__/);
  assert.match(page, /import\.meta\.env\.DEV && params\.get\('fixture'\) === '1'/);
  assert.match(page, /Earlier \$\{payload\.year\} legs were not stored/);
  assert.match(page, /Block hours/);
  assert.match(page, /Fly with Skyway/);
  assert.match(page, /Inter/);
  assert.doesNotMatch(page, /Bebas Neue|data-showcase-celebrate|data-showcase-callout|LONGEST ROUTES|TOP DESTINATIONS|STATES \/ COUNTRIES/);
  const replaySource = await readFile(path.join(root, 'src/showcase-replay.js'), 'utf8');
  assert.doesNotMatch(replaySource, /milestoneCrossings|showcaseCallouts|fb7185|fbbf24/);
  const draw = await readFile(path.join(root, 'src/showcase-draw.js'), 'utf8');
  assert.doesNotMatch(draw, /drawCelebration|drawSparkles|drawWave|drawRipples/);
  assert.match(draw, /#3FA9CC/);
  assert.match(page, /TvDesignFrame/);
  assert.match(page, /canvas/);
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /\/api\/showcase-admin|ShowcaseAdminCard/);
  const admin = await readFile(path.join(root, 'src/ShowcaseAdminCard.jsx'), 'utf8');
  assert.match(admin, /\/api\/showcase-admin/);
  assert.match(admin, /Copy link/);
  assert.match(admin, /aria-label="Trade show link"/);
  const replay = await readFile(path.join(root, 'api/showcase-replay.js'), 'utf8');
  assert.match(replay, /max-age=900/);
});
