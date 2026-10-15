import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  TV_DENSITY,
  TV_FONT_FLOOR,
  TV_HEADER_PX,
  boardWeatherAirports,
  buildTvAircraftCard,
  buildTvBoardRow,
  buildTvMapScene,
  formatBoardWeather,
  isTvBoardRequest,
  tvAircraftStrip,
  tvBoardScale,
  tvLegLayout,
  tvListHeight,
} from '../src/flight-board-tv.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOW = Date.parse('2026-08-10T19:00:00Z');

test('the 1080p frame scales by min(viewport / 1920, viewport / 1080) and 4K is double', () => {
  assert.equal(tvBoardScale(1920, 1080), 1);
  assert.equal(tvBoardScale(3840, 2160), 2);
  assert.equal(tvBoardScale(1280, 720), 1280 / 1920);
});

test('every leg fits one view: a short list stays large, a busy day uses two columns', () => {
  const strip = tvAircraftStrip(8);
  const listHeight = tvListHeight(8);
  assert.equal(TV_HEADER_PX + strip.height + listHeight, 1080);
  assert.equal(strip.rows, 1);

  const quiet = tvLegLayout(3, listHeight);
  assert.equal(quiet.columns, 1);
  assert.equal(quiet.density, TV_DENSITY.lg);
  assert.ok(quiet.rowHeight * quiet.rows <= listHeight);

  const busy = tvLegLayout(16, listHeight);
  assert.equal(busy.columns, 2);
  assert.equal(busy.rows, 8);
  assert.ok(busy.rowHeight * busy.rows <= listHeight + 0.001);
  assert.ok(busy.density.time >= TV_FONT_FLOOR);
  assert.equal(busy.density, TV_DENSITY.lg);

  const packed = tvLegLayout(40, listHeight);
  assert.equal(packed.columns, 2);
  assert.ok(packed.rowHeight * packed.rows <= listHeight + 0.001);
  assert.ok(packed.density.time >= TV_FONT_FLOOR);
  assert.ok(packed.density.route >= TV_FONT_FLOOR);
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

test('aircraft cards and leg weather use the trip id and the METAR fields', () => {
  const card = buildTvAircraftCard({
    tail: 'N444AM',
    telemetry: {
      airborne: true,
      destination: 'KHYA',
      estimatedOn: '2026-08-10T20:12:00Z',
    },
    trips: [{
      uid: 'now',
      start: new Date(NOW - 30 * 60_000),
      end: new Date(NOW + 72 * 60_000),
      info: { tail: 'N444AM', from: 'IAD', to: 'HYA', isFlight: true, tripCode: 'WEQVQD', tripNumber: '104281' },
    }],
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(card.statusLabel, 'AIRBORNE');
  assert.equal(card.tripId, 'WEQVQD');
  assert.equal(card.timeKind, 'eta');
  assert.equal(card.weatherAirport, 'KHYA');
  assert.doesNotMatch(JSON.stringify(card), /104281/);

  const parked = buildTvAircraftCard({
    tail: 'N20UF',
    telemetry: { airborne: false, groundedAt: 'KTEB' },
    trips: [{
      uid: 'next',
      start: new Date(NOW + 90 * 60_000),
      end: new Date(NOW + 3 * 3600_000),
      info: { tail: 'N20UF', from: 'TEB', to: 'PBI', isFlight: true, tripCode: 'M8VTQD', tripNumber: '1005' },
    }],
    now: NOW,
    timeZone: 'America/New_York',
  });
  assert.equal(parked.statusLabel, 'ON GROUND');
  assert.equal(parked.tripId, 'M8VTQD');
  assert.equal(parked.timeKind, 'etd');
  assert.equal(parked.location, 'KTEB');
  assert.equal(parked.weatherAirport, 'KTEB');
  assert.doesNotMatch(JSON.stringify(parked), /1005/);

  const wx = formatBoardWeather({
    flightCategory: 'IFR',
    windDir: 180,
    windKt: 16,
    windGustKt: 24,
    visibilitySm: 2,
    ceilingFt: 700,
  });
  assert.equal(wx.category, 'IFR');
  assert.equal(wx.wind, '180°/16kt G24');
  assert.equal(wx.visibility, '2 SM');
  assert.equal(wx.ceiling, '700 ft');
  assert.match(wx.line, /IFR/);
  assert.equal(formatBoardWeather(null), null);
  assert.equal(formatBoardWeather({ flightCategory: 'VFR', windDir: 0, windKt: 0, visibilitySm: 10, ceilingFt: null }).ceiling, 'CLR');

  const codes = boardWeatherAirports(
    [{ from: 'IAD', to: 'HYA' }, { from: 'TEB', to: 'PBI' }],
    [card, parked],
  );
  assert.deepEqual(codes, ['KHYA', 'KIAD', 'KPBI', 'KTEB']);
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
  assert.match(board, /<TrackingMap[\s\S]*followFleet[\s\S]*frameAllTails=\{true\}[\s\S]*passive[\s\S]*radarDefault=\{true\}/);
  assert.doesNotMatch(board, /tvPageSlice|TV_PAGE_MS|data-board-page/);
  assert.match(board, /\/api\/airport-weather/);
  assert.match(board, /data-board-fleet/);
  assert.match(compact, /<RouteMap/);
  assert.match(compact, /TAIL · ROUTE/);
  assert.match(compact, /FLIGHT_ROW_GRID/);
  assert.match(board, /WX RADAR/);
  assert.doesNotMatch(compact, /<TrackingMap/);
  assert.doesNotMatch(compact, /followFleet/);
  assert.doesNotMatch(compact, /\bpassive\b/);
  assert.doesNotMatch(compact, /frameAllTails/);
  assert.doesNotMatch(compact, /radarDefault/);
  assert.doesNotMatch(compact, /data-board-fleet/);

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
