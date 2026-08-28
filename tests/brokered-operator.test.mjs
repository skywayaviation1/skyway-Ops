import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  signOperatorToken,
  verifyOperatorToken,
} from '../api/_operator-token.js';
import {
  MAX_BROKERED_TAILS_PER_POLL,
  normalizeFiledFlights,
  resolveCronFleetTails,
} from '../api/flightaware-cron-poll.js';
import {
  buildPassengerCheckInEmail,
  buildOperatorRepositionEmail,
  buildOperatorStatusEmail,
} from '../api/operator-flight.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('operator token is scoped to one trip and rejects tampering', () => {
  const original = process.env.OPERATOR_LINK_SECRET;
  try {
    process.env.OPERATOR_LINK_SECRET = 'test-operator-secret-long-enough';
    const token = signOperatorToken('trip-123', 123456789);
    assert.deepEqual(verifyOperatorToken(token), {
      ok: true,
      tripId: 'trip-123',
      issuedAt: 123456789,
    });
    assert.equal(verifyOperatorToken(`${token}x`).ok, false);
    assert.equal(verifyOperatorToken('').ok, false);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_LINK_SECRET;
    else process.env.OPERATOR_LINK_SECRET = original;
  }
});

test('active brokered tails join managed fleet polling and expire automatically', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const tails = resolveCronFleetTails({
    configured: true,
    managedTails: ['N100AA'],
  }, [
    { tail: 'N200BB', active: true, expiresAt: now + 60_000 },
    { tail: 'N300CC', active: true, expiresAt: now - 1 },
    { tail: 'N400DD', active: false, expiresAt: now + 60_000 },
    { tail: 'n100aa', active: true, expiresAt: now + 60_000 },
  ], now);
  assert.deepEqual(tails, ['N100AA', 'N200BB']);
});

test('temporary brokered polling is capped to control AeroAPI spend', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const temporary = Array.from({ length: MAX_BROKERED_TAILS_PER_POLL + 5 }, (_, index) => ({
    tail: `N${200 + index}BB`,
    active: true,
    expiresAt: now + (index + 1) * 60_000,
  }));
  const tails = resolveCronFleetTails({
    configured: true,
    managedTails: ['N100AA'],
  }, temporary, now);
  assert.equal(tails.length, 1 + MAX_BROKERED_TAILS_PER_POLL);
  assert.equal(tails[0], 'N100AA');
  assert.equal(tails.at(-1), `N${200 + MAX_BROKERED_TAILS_PER_POLL - 1}BB`);
});

test('FlightAware filed movements are bounded, sorted, and sanitized', () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const flights = normalizeFiledFlights([
    {
      fa_flight_id: 'later',
      origin: { code_icao: 'KAPF' },
      destination: { code_icao: 'KTEB' },
      scheduled_out: new Date(now + 5 * 3600_000).toISOString(),
      scheduled_in: new Date(now + 8 * 3600_000).toISOString(),
    },
    {
      fa_flight_id: 'first',
      origin: { code: 'KHPN' },
      destination: { code: 'KAPF' },
      scheduled_out: new Date(now + 2 * 3600_000).toISOString(),
    },
    {
      fa_flight_id: 'completed',
      origin: { code: 'KTEB' },
      destination: { code: 'KBOS' },
      scheduled_out: new Date(now).toISOString(),
      actual_on: new Date(now + 3600_000).toISOString(),
    },
    {
      fa_flight_id: 'too-far',
      origin: { code: 'KTEB' },
      destination: { code: 'KBOS' },
      scheduled_out: new Date(now + 80 * 3600_000).toISOString(),
    },
  ], now);
  assert.deepEqual(flights.map((flight) => flight.id), ['first', 'later']);
  assert.equal(flights[0].origin, 'KHPN');
  assert.equal(flights[0].destination, 'KAPF');
});

test('operator-link mint registers temporary ADS-B tracking and revoke disables it', async () => {
  const link = await source('api/operator-link.js');
  assert.match(link, /collection\('brokered-tail-tracking'\)\.doc\(tripId\)/);
  assert.match(link, /active: true/);
  assert.match(link, /expiresAt/);
  assert.match(link, /active: false/);
  assert.match(link, /operatorTrackingExpiresAt/);
  assert.match(link, /operatorLinkRevoked/);
  assert.match(link, /opsEmail: clip\(input\?\.opsEmail/);
  assert.match(link, /Operating company ops email is invalid/);
  assert.match(link, /operatorOpsEmail: data\.operatorPortal\?\.opsEmail/);
});

test('operator portal exposes only scoped operational updates', async () => {
  const api = await source('api/operator-flight.js');
  assert.match(api, /verifyOperatorToken\(token\)/);
  assert.match(api, /ALLOWED_STATUS = new Set/);
  assert.match(api, /'wheels_up'/);
  assert.match(api, /'landed'/);
  assert.match(api, /action === 'reposition'/);
  assert.match(api, /runTransaction/);
  assert.match(api, /source: 'external-operator'/);
  assert.match(api, /data\.operatorPortal\?\.opsEmail/);
  assert.match(api, /STATUS_CONTENT/);
  assert.match(api, /Crew Arrival Notification/);
  assert.match(api, /Aircraft Ready for Passengers/);
  assert.match(api, /Wheels Up/);
  assert.match(api, /applySkywaySignature/);
  // No broker-contact, price, internal note, or ID-document projection.
  assert.doesNotMatch(api, /brokerEmail:/);
  assert.doesNotMatch(api, /pricing:/);
});

test('operator status email matches crew-side route and milestone content', () => {
  const email = buildOperatorStatusEmail({
    tail: 'N200BB',
    from: 'KAPF',
    to: 'KTEB',
  }, {
    statusKey: 'wheels_up',
    at: Date.parse('2026-09-01T14:00:00Z'),
    author: 'Captain Test',
    company: 'Partner Air',
    note: 'Smooth departure',
  });
  assert.equal(email.subject, 'Wheels Up — N200BB KAPF-KTEB');
  assert.match(email.html, /airborne and en route/);
  assert.match(email.html, /Captain Test/);
  assert.match(email.html, /Partner Air/);
  assert.match(email.html, /Smooth departure/);
  assert.match(email.html, /skyway-signature-applied/);
});

test('passenger check-in email notifies both ops teams without ID data', () => {
  const email = buildPassengerCheckInEmail({
    tail: 'N200BB',
    from: 'KAPF',
    to: 'KTEB',
  }, {
    passengerName: 'Jane Doe',
    author: 'Captain Test',
    company: 'Partner Air',
    overridden: false,
  });
  assert.equal(email.subject, 'Passenger Checked In — N200BB KAPF-KTEB');
  assert.match(email.html, /Jane Doe/);
  assert.match(email.html, /ID name matched manifest/);
  assert.doesNotMatch(email.html, /document number|date of birth|DOB/i);
});

test('operator reposition email contains filed route, times, and crew note', () => {
  const email = buildOperatorRepositionEmail({ tail: 'N200BB' }, {
    from: 'KHPN',
    to: 'KAPF',
    departure: '2026-09-01T14:00:00Z',
    arrival: '2026-09-01T16:30:00Z',
    author: 'Captain Test',
    company: 'Partner Air',
    note: 'Empty leg',
  });
  assert.equal(email.subject, 'Repositioning Filed — N200BB KHPN-KAPF');
  assert.match(email.html, /KHPN/);
  assert.match(email.html, /KAPF/);
  assert.match(email.html, /Empty leg/);
});

test('operator portal does not mislabel generic FlightAware filings as repositioning', async () => {
  const portal = await source('src/OperatorFlightPortal.jsx');
  assert.match(portal, /FLIGHTAWARE FILED/);
  assert.match(portal, /not automatically labeled repositioning/);
  assert.match(portal, /Only use this for an empty positioning flight/);
  assert.match(portal, /FILE REPOSITION/);
});

test('operator portal uses a select-review-send milestone workflow', async () => {
  const portal = await source('src/OperatorFlightPortal.jsx');
  assert.match(portal, /selectedStatus/);
  assert.match(portal, /aria-pressed=\{selected\}/);
  assert.match(portal, /Selected update/);
  assert.match(portal, /SEND SELECTED UPDATE/);
  assert.match(portal, /setSelectedStatus\(''\)/);
  assert.match(portal, /onClick=\{\(\) => setSelectedStatus\(key\)\}/);
});

test('external crew can report passenger arrival and boarded milestones', async () => {
  const portal = await source('src/OperatorFlightPortal.jsx');
  assert.match(portal, /\['pax_arrived', 'Passengers arrived'/);
  assert.match(portal, /\['pax_boarded', 'Passengers checked in'/);
  const api = await source('api/operator-flight.js');
  assert.match(api, /'pax_arrived'/);
  assert.match(api, /'pax_boarded'/);
  assert.match(api, /Passengers Arrived/);
  assert.match(api, /Passengers Checked In/);
});

test('operator passenger check-in is manifest-scoped and privacy-minimized', async () => {
  const api = await source('api/operator-flight.js');
  assert.match(api, /action === 'check-in'/);
  assert.match(api, /Passenger is not on this trip manifest/);
  assert.match(api, /requiresOverride: true/);
  assert.match(api, /checkInStatus: matched \? 'matched' : 'manual_override'/);
  assert.match(api, /preloadedRefId: passengerId/);
  assert.doesNotMatch(api, /documentNumber:/);
  assert.doesNotMatch(api, /dob:/i);

  const portal = await source('src/OperatorFlightPortal.jsx');
  assert.match(portal, /Passenger ID check-in/);
  assert.match(portal, /SCAN OR PHOTOGRAPH ID/);
  assert.match(portal, /CONFIRM CHECK-IN/);
  assert.match(portal, /capture="environment"/);
  assert.match(portal, /operatorToken: token/);
  assert.match(portal, /DOB and document number are not saved/);
});

test('ID parser accepts a bounded operator link without weakening staff auth', async () => {
  const parser = await source('api/parse-id.js');
  assert.match(parser, /verifyOperatorToken\(token\)/);
  assert.match(parser, /operatorIdScanCount/);
  assert.match(parser, /count >= 60/);
  assert.match(parser, /operatorTrackingExpiresAt/);
  assert.match(parser, /await authorizeOperatorScan\(admin, operatorToken\)/);
  // The existing Firebase user authorization path remains in place.
  assert.match(parser, /verifyIdToken\(idToken, true\)/);
  assert.match(parser, /\['crew', 'ops', 'admin'\]\.includes\(profile\.role\)/);
});

test('operator map resolves unknown airports and renders before ADS-B arrives', async () => {
  const portal = await source('src/OperatorFlightPortal.jsx');
  assert.match(portal, /\/api\/airport-coords-lookup/);
  assert.match(portal, /routeCoords/);
  assert.match(portal, /WAITING FOR FIRST ADS-B POLL/);
  assert.match(portal, /route shown from schedule/);
  // TrackingMap's own layers are absolute; without h-full its root collapses
  // to zero height even though the outer frame is 22rem tall.
  assert.match(portal, /<TrackingMap\s+className="h-full w-full"/);
  assert.match(portal, /fitKey=\{`\$\{trip\.tail\}-\$\{trip\.from\}-\$\{trip\.to\}`\}/);
});

test('brokered trip UI mints and manages a crew link', async () => {
  const component = await source('src/BrokeredOperatorLink.jsx');
  assert.match(component, /\/api\/operator-link/);
  assert.match(component, /CREATE CREW UPDATE LINK & START TRACKING/);
  assert.match(component, /ADS-B polling active/);
  assert.match(component, /REPOSITION/);
  assert.match(component, /Their operations email/);
  assert.match(component, /opsEmail: operatorOpsEmail/);
  assert.match(component, /Skyway Operations and this operator email/);

  const app = await source('src/App.jsx');
  assert.match(app, /BrokeredOperatorLinkLazy/);
  assert.match(app, /isBrokeredFlight/);
  assert.match(app, /!managedTailsForTrip\.includes\(tripTail\)/);
  assert.match(app, /<BrokeredOperatorLinkLazy trip=\{trip\}/);
});

test('public operator route mounts before authenticated app and skips its service worker', async () => {
  const main = await source('src/main.jsx');
  assert.match(main, /isOperatorFlightRoute/);
  assert.match(main, /<OperatorFlightPortal token=\{params\.get\('token'\) \|\| ''\}/);
  assert.match(main, /&& !isOperatorFlightRoute/);
});

test('existing FlightAware transition engine polls temporary brokered tails', async () => {
  const cron = await source('api/flightaware-cron-poll.js');
  assert.match(cron, /collection\('brokered-tail-tracking'\)\.get\(\)/);
  assert.match(cron, /resolveCronFleetTails\([\s\S]*?brokeredTracking/);
  assert.match(cron, /filedFlights = normalizeFiledFlights\(flights\)/);
  // Existing automatic milestone paths remain in place.
  assert.match(cron, /findMatchingTrip\(db, ident, current\.origin, eventTimeMs, 'wheels_up'\)/);
  assert.match(cron, /findMatchingTrip\(db, ident, current\.origin, eventTimeMs, 'landed'\)/);
});

