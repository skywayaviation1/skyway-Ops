import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { lookupCoords } from '../src/airport-coords.js';
import { demoShowcasePayload } from '../src/showcase-demo.js';
import { airportCity, placeForAirport, stateFromPoint } from '../src/showcase-places.js';
import {
  PUBLIC_LEG_KEYS,
  SHOWCASE_CACHE_MS,
  SHOWCASE_CELEBRATE_MS,
  SHOWCASE_HOLD_MS,
  SHOWCASE_LOOP_MS,
  SHOWCASE_MAX_LEG_MS,
  SHOWCASE_MIN_LEG_MS,
  SHOWCASE_PLAY_MS,
  activeMilestone,
  bearingDeg,
  frameActors,
  initialPlayMs,
  interpolateGreatCircle,
  isCompletedShowcaseLeg,
  isShowcaseToken,
  milestoneCrossings,
  parseShowcasePath,
  playbackWindow,
  projectShowcaseLeg,
  publicShowcaseBody,
  sampleRoute,
  scheduleShowcasePlayback,
  selectShowcaseLegs,
  showcaseCallouts,
  showcaseSnapshot,
  showcaseUrl,
  zonedStartOfYearMs,
} from '../src/showcase-replay.js';
import { handleShowcaseReplay } from '../api/showcase-replay.js';
import { handleShowcaseAdmin } from '../api/showcase-admin.js';

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
  ], { now: NOW, lookupCoords: lookup });
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
  const selected = selectShowcaseLegs([early, sameDay, later], { now: NOW, lookupCoords: lookup });
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

test('counters grow as legs finish and rank routes from airport codes', () => {
  const selected = selectShowcaseLegs([
    raw(),
    raw({
      from: 'MIA',
      to: 'NAS',
      tail: 'N882SK',
      departure: '2026-07-01T14:00:00.000Z',
      arrival: '2026-07-01T16:00:00.000Z',
    }),
  ], { now: NOW, lookupCoords: lookup });
  const body = publicShowcaseBody(selected, NOW);
  const span = playbackWindow(body);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const early = showcaseSnapshot(scheduled, 0, placeForAirport, span);
  assert.equal(early.flights, 0);
  const done = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS, placeForAirport, span);
  assert.equal(done.flights, 2);
  assert.ok(done.nm > 800);
  assert.ok(done.sm > done.nm);
  assert.ok(done.hours > 4);
  assert.equal(done.airports, 3);
  assert.ok(done.states >= 2);
  assert.ok(done.countries >= 2);
  assert.equal(done.topDestinations[0].label === 'MIA' || done.topDestinations[0].label === 'NAS', true);
  assert.ok(done.topRoutes.some((row) => row.label === 'TEB → MIA'));
  assert.equal(placeForAirport('TEB', 40.85, -74.06).state, 'NJ');
  assert.equal(placeForAirport('MIA', 25.8, -80.29).state, 'FL');
  assert.equal(placeForAirport('NAS', 25.04, -77.47).country, 'Bahamas');
  assert.equal(placeForAirport('DCA', 38.85, -77.04).state, 'VA');
  assert.equal(placeForAirport('PNS', 30.47, -87.19).state, 'FL');
  assert.equal(stateFromPoint(41.97, -87.9), 'IL');
  assert.equal(stateFromPoint(33.94, -118.4), 'CA');
  assert.equal(stateFromPoint(47.45, -122.3), 'WA');
  assert.equal(stateFromPoint(39.86, -104.67), 'CO');
  assert.equal(stateFromPoint(32.9, -97.04), 'TX');
  assert.equal(stateFromPoint(36.08, -115.15), 'NV');
  assert.equal(stateFromPoint(21.32, -157.92), 'HI');
  assert.equal(stateFromPoint(61.17, -150), 'AK');
  assert.equal(stateFromPoint(42.36, -71.01), 'MA');
  assert.equal(stateFromPoint(33.64, -84.43), 'GA');
  assert.equal(stateFromPoint(30.44, -84.28), 'FL');
});

test('demo flights cover the year without private fields', () => {
  const body = demoShowcasePayload(NOW);
  assert.ok(body.legs.length > 200, `legs ${body.legs.length}`);
  assert.equal(playbackWindow(body).abbreviated, false);
  assert.deepEqual(Object.keys(body.legs[0]), [...PUBLIC_LEG_KEYS]);
  assert.equal(JSON.stringify(body).includes('customer'), false);
  const span = playbackWindow(body);
  const scheduled = scheduleShowcasePlayback(body.legs, span);
  const mid = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS * 0.45, placeForAirport, span);
  assert.ok(mid.active >= 2, `active ${mid.active}`);
  assert.ok(mid.flights > 40, `flights ${mid.flights}`);
  const hold = showcaseSnapshot(scheduled, SHOWCASE_PLAY_MS + 500, placeForAirport, span);
  assert.equal(hold.flights, body.legs.length);
  assert.equal(hold.active, 0);
  assert.ok(hold.states >= 8);
  assert.ok(hold.countries >= 3);
  assert.ok(hold.leaderboard.length >= 2);
  assert.ok(hold.leaderboard[0].nm >= hold.leaderboard[1].nm);
  assert.equal(hold.justLanded.tail.length > 0, true);
  const lines = showcaseCallouts(hold);
  assert.ok(lines.some((line) => line.startsWith('Just landed:')));
  assert.equal(JSON.stringify(lines).includes('customer'), false);
  assert.equal(JSON.stringify(lines).includes('broker'), false);
  const marks = milestoneCrossings(scheduled);
  const hundred = marks.find((row) => row.id === 'flights-100');
  assert.ok(hundred && hundred.at > 0 && hundred.at < SHOWCASE_PLAY_MS);
  assert.equal(activeMilestone(marks, 0), null);
  assert.equal(activeMilestone(marks, hundred.at + 400)?.id, 'flights-100');
  assert.equal(activeMilestone(marks, hundred.at + SHOWCASE_CELEBRATE_MS + 50), null);
  const finale = initialPlayMs({ at: 'finale' });
  assert.ok(finale > SHOWCASE_PLAY_MS && finale < SHOWCASE_LOOP_MS);
  assert.equal(airportCity('ASE'), 'Aspen');
  assert.equal(placeForAirport('ASE', 39.22, -106.87).city, 'Aspen');
  assert.equal(placeForAirport('ASE', 39.22, -106.87).state, 'CO');
});

test('the public route is a token path and unknown tokens are not found', async () => {
  assert.equal(parseShowcasePath('/showcase/abc')?.token, 'abc');
  assert.equal(parseShowcasePath('/schedule'), null);
  assert.equal(parseShowcasePath('/showcase')?.token, '');
  assert.equal(isShowcaseToken('short'), false);
  const token = 'a'.repeat(43);
  assert.equal(isShowcaseToken(token), true);
  assert.equal(showcaseUrl(token), `https://skyway.app/showcase/${token}`);

  const db = memoryDb({
    config: { token, enabled: true },
    legs: [raw(), raw({ cancelled: true, customer: 'Northwind Charter', price: 25000 })],
  });
  const cache = { token: '', at: 0, body: null };
  const ok = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, ok, { db, now: NOW, lookupCoords: lookup, cache });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'public, max-age=900');
  assert.equal(ok.body.legs.length, 1);
  assert.equal(JSON.stringify(ok.body).includes('Northwind'), false);
  assert.equal(JSON.stringify(ok.body).includes(token), false);
  assert.equal(db.legReads(), 1);

  const again = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, again, { db, now: NOW + 60_000, lookupCoords: lookup, cache });
  assert.equal(again.statusCode, 200);
  assert.equal(db.legReads(), 1);

  const stale = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, stale, {
    db,
    now: NOW + SHOWCASE_CACHE_MS + 1000,
    lookupCoords: lookup,
    cache,
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(db.legReads(), 2);

  for (const bad of ['nope', 'short-token', token.slice(0, -1) + 'b']) {
    const missed = responseCapture();
    await handleShowcaseReplay({ method: 'GET', query: { token: bad } }, missed, { db, now: NOW, lookupCoords: lookup, cache: { token: '', at: 0, body: null } });
    assert.equal(missed.statusCode, 404, bad);
    assert.equal(missed.body.error, 'Not found');
  }

  db.state.config = { token, enabled: false };
  const disabled = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token } }, disabled, { db, now: NOW, lookupCoords: lookup, cache: { token: '', at: 0, body: null } });
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
    lookupCoords: lookup,
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

  const oldLink = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'b'.repeat(43) } }, oldLink, { db, now: NOW, lookupCoords: lookup, cache: { token: '', at: 0, body: null } });
  assert.equal(oldLink.statusCode, 404);
  const newLink = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'c'.repeat(43) } }, newLink, { db, now: NOW, lookupCoords: lookup, cache: { token: '', at: 0, body: null } });
  assert.equal(newLink.statusCode, 200);

  const off = responseCapture();
  await handleShowcaseAdmin({ method: 'POST', body: { idToken: 'ops-session', action: 'disable' } }, off, deps);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.url, null);
  const gone = responseCapture();
  await handleShowcaseReplay({ method: 'GET', query: { token: 'c'.repeat(43) } }, gone, { db, now: NOW, lookupCoords: lookup, cache: { token: '', at: 0, body: null } });
  assert.equal(gone.statusCode, 404);
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
  assert.match(page, /TvDesignFrame/);
  assert.match(page, /canvas/);
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /\/api\/showcase-admin|ShowcaseAdminCard/);
  const admin = await readFile(path.join(root, 'src/ShowcaseAdminCard.jsx'), 'utf8');
  assert.match(admin, /\/api\/showcase-admin/);
  const replay = await readFile(path.join(root, 'api/showcase-replay.js'), 'utf8');
  assert.match(replay, /max-age=900/);
});
