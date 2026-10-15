import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  TV_PAGE_MS,
  TV_PAGE_ROWS,
  buildTvBoardRow,
  buildTvMapScene,
  isTvBoardRequest,
  tvBoardScale,
  tvPageSize,
  tvPageSlice,
} from '../src/flight-board-tv.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOW = Date.parse('2026-08-10T19:00:00Z');

test('the 1080p frame scales by min(viewport / 1920, viewport / 1080) and 4K is double', () => {
  assert.equal(tvBoardScale(1920, 1080), 1);
  assert.equal(tvBoardScale(3840, 2160), 2);
  assert.equal(tvBoardScale(1280, 720), 1280 / 1920);
  assert.equal(tvPageSize(1920, 1080), TV_PAGE_ROWS);
  assert.equal(tvPageSize(3840, 2160), 8);
  assert.equal(TV_PAGE_MS, 12_000);
});

test('rows page every 12 seconds and wrap, and a short list stays on one page', () => {
  const rows = Array.from({ length: 10 }, (_, index) => index);
  const first = tvPageSlice(rows, NOW, { originMs: NOW, pageSize: 8, intervalMs: TV_PAGE_MS });
  assert.equal(first.index, 0);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.rows, [0, 1, 2, 3, 4, 5, 6, 7]);

  const second = tvPageSlice(rows, NOW + 12_000, { originMs: NOW, pageSize: 8, intervalMs: TV_PAGE_MS });
  assert.equal(second.index, 1);
  assert.deepEqual(second.rows, [8, 9]);

  const wrapped = tvPageSlice(rows, NOW + 24_000, { originMs: NOW, pageSize: 8, intervalMs: TV_PAGE_MS });
  assert.equal(wrapped.index, 0);
  assert.deepEqual(wrapped.rows, first.rows);

  const single = tvPageSlice([1, 2, 3], NOW + 12_000, { originMs: NOW, pageSize: 8 });
  assert.equal(single.pageCount, 1);
  assert.equal(single.index, 0);
  assert.deepEqual(single.rows, [1, 2, 3]);
});

test('board rows use the 6–7 character trip id and never a trip number', () => {
  const pending = buildTvBoardRow({
    trip: {
      uid: 'sky-1001',
      start: '2026-08-10T20:00:00Z',
      info: {
        tail: 'N444AM',
        from: 'IAD',
        to: 'HYA',
        pic: 'Ada Lovelace',
        sic: 'Grace Hopper',
        pax: 4,
        tripCode: 'WEQVQD',
        tripNumber: '104281',
      },
    },
    state: { statuses: { crew_onsite: { timestamp: 1 }, pax_boarded: { timestamp: 2 } } },
    phase: 'preflight',
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(pending.tripId, 'WEQVQD');
  assert.equal(pending.statusLabel, 'PRE-FLT');
  assert.equal(pending.stepLabel, 'PAX BOARDED');
  assert.equal(pending.timeKind, 'etd');
  assert.match(pending.timeLabel, /EDT/);
  assert.deepEqual(pending.crew, ['Ada Lovelace', 'Grace Hopper']);
  assert.equal(pending.from, 'IAD');
  assert.equal(pending.to, 'HYA');
  assert.doesNotMatch(JSON.stringify({
    tripId: pending.tripId,
    timeLabel: pending.timeLabel,
    tail: pending.tail,
    from: pending.from,
    to: pending.to,
    statusLabel: pending.statusLabel,
    stepLabel: pending.stepLabel,
  }), /104281/);

  const numeric = buildTvBoardRow({
    trip: {
      uid: 'sky-1005',
      start: '2026-08-10T22:00:00Z',
      info: {
        tail: 'N20UF',
        from: 'TEB',
        to: 'PBI',
        tripNumber: '104281',
        tripCode: '104281',
      },
    },
    phase: 'pending',
    now: NOW,
    timeZone: 'UTC',
  });
  assert.equal(numeric.tripId, null);
  assert.equal(numeric.timeKind, 'etd');

  const airborne = buildTvBoardRow({
    trip: {
      uid: 'leg-air',
      start: '2026-08-10T18:00:00Z',
      end: '2026-08-10T21:00:00Z',
      info: { tail: 'N651TW', from: 'APF', to: 'DFW', tripCode: 'R4NCBX', tripNumber: '88' },
    },
    phase: 'airborne',
    faPosition: { estimatedOn: '2026-08-10T20:12:00Z' },
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(airborne.tripId, 'R4NCBX');
  assert.equal(airborne.timeKind, 'eta');
  assert.equal(airborne.remainLabel, '1h 12m');
  assert.match(airborne.timeLabel, /4:12 PM EDT/);
  assert.equal(airborne.stepLabel, null);
});

test('the TV map scene keeps airborne ETA bubbles and parked ETD bubbles', () => {
  const scene = buildTvMapScene({
    fleetTails: ['N444AM', 'N20UF'],
    positions: {
      N444AM: {
        airborne: true,
        latitude: 40,
        longitude: -74,
        destination: 'KHYA',
        estimatedOn: '2026-08-10T20:00:00Z',
      },
      N20UF: {
        airborne: false,
        groundedAt: 'KTEB',
        groundedLat: 40.85,
        groundedLon: -74.06,
      },
    },
    trips: [
      {
        uid: 'now',
        start: new Date(NOW - 30 * 60_000),
        end: new Date(NOW + 40 * 60_000),
        info: { tail: 'N444AM', from: 'IAD', to: 'HYA', isFlight: true, tripCode: 'WEQVQD', tripNumber: '104281' },
      },
      {
        uid: 'next',
        start: new Date(NOW + 90 * 60_000),
        end: new Date(NOW + 3 * 3600_000),
        info: { tail: 'N20UF', from: 'TEB', to: 'PBI', isFlight: true, tripCode: 'M8VTQD', tripNumber: '1005' },
      },
    ],
    now: NOW,
    timeZone: 'America/New_York',
  });
  const air = scene.aircraft.find((item) => item.tail === 'N444AM');
  const ground = scene.aircraft.find((item) => item.tail === 'N20UF');
  assert.equal(air.showLabel, true);
  assert.equal(air.airborne, true);
  assert.equal(air.tripId, 'WEQVQD');
  assert.equal(air.destination, 'KHYA');
  assert.match(air.etaLabel, /EDT/);
  assert.equal(air.departureLabel, null);
  assert.equal(ground.showLabel, true);
  assert.equal(ground.airborne, false);
  assert.equal(ground.tripId, 'M8VTQD');
  assert.match(ground.departureLabel, /EDT/);
  assert.equal(ground.etaLabel, null);
  assert.doesNotMatch(`${air.tripId} ${ground.tripId} ${ground.departureLabel}`, /104281|1005/);
});

test('the full-screen board is the only path that mounts the passive fleet map', async () => {
  const board = await readFile(path.join(root, 'src/FlightBoard.jsx'), 'utf8');
  const gate = board.indexOf('if (!compact)');
  const legacy = board.indexOf('keep this schedule card', gate);
  assert.ok(gate > 0 && legacy > gate);
  const tv = board.slice(gate, legacy);
  const compact = board.slice(legacy);
  assert.match(tv, /<TvFlightBoard/);
  assert.doesNotMatch(tv, /<RouteMap/);
  assert.match(board, /<TrackingMap[\s\S]*followFleet[\s\S]*passive/);
  assert.match(compact, /<RouteMap/);
  assert.match(compact, /TAIL · ROUTE/);
  assert.match(compact, /FLIGHT_ROW_GRID/);
  assert.match(board, /WX RADAR/);
  assert.doesNotMatch(compact, /<TrackingMap/);
  assert.doesNotMatch(compact, /followFleet/);
  assert.doesNotMatch(compact, /\bpassive\b/);

  const map = await readFile(path.join(root, 'src/TrackingMap.jsx'), 'utf8');
  assert.match(map, /passive = false/);
  assert.match(map, /dragging: !passive/);
  assert.match(map, /scrollWheelZoom: !passive/);
  assert.match(map, /keyboard: !passive/);
  assert.match(map, /if \(!passive\)/);
  assert.match(map, /if \(!ready \|\| !followFleet \|\| passive/);

  const frame = await readFile(path.join(root, 'src/TvDesignFrame.jsx'), 'utf8');
  assert.match(frame, /min\(100vw \/ 1920, 100vh \/ 1080\)/);
  assert.match(frame, /tvBoardScale\(window\.innerWidth, window\.innerHeight\)/);
  assert.match(frame, /scale\(\$\{scale\}\)/);

  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /<FlightBoardLazy allTrips=\{trips\} compact \/>/);
  assert.match(app, /isTvBoardRequest\(window\.location\.search\)/);
  assert.match(app, /<BoardNeedsSignIn/);
  assert.match(app, /fleetTails=\{managedFleetTails\}/);
  const signedOut = app.indexOf("if (authState === 'signed-out')");
  const signIn = app.indexOf('<BoardNeedsSignIn', signedOut);
  const login = app.indexOf('<LoginScreen', signedOut);
  assert.ok(signedOut > 0 && signIn > signedOut && login > signIn);
  assert.equal(isTvBoardRequest('?board=1'), true);
  assert.equal(isTvBoardRequest('?board=0'), false);
  assert.equal(isTvBoardRequest(''), false);

  const sign = await readFile(path.join(root, 'src/BoardSignIn.jsx'), 'utf8');
  assert.match(sign, /This display needs a one-time Microsoft sign-in/);
});
