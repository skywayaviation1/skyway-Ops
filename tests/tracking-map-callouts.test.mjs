import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { aircraftIcon, groundedIcon } from '../src/tracking-map.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const L = { divIcon: (opts) => opts };

test('airborne marker bubble shows the trip id, destination, and zoned ETA', () => {
  const icon = aircraftIcon(L, {
    tail: 'N444AM',
    tripId: 'WEQVQD',
    destination: 'KHYA',
    etaLabel: '4:12 PM EDT',
    altitude: 41000,
    groundspeed: 448,
  });
  assert.match(icon.html, /N444AM · WEQVQD/);
  assert.match(icon.html, /→ KHYA/);
  assert.match(icon.html, /ETA 4:12 PM EDT/);
  assert.doesNotMatch(icon.html, /104281/);
  assert.doesNotMatch(icon.html, /FL410/);
});

test('grounded marker bubble shows the next departure and not a trip number', () => {
  const icon = groundedIcon(L, {
    tail: 'N20UF',
    at: 'KTEB',
    tripId: 'M8VTQD',
    departureLabel: '6:30 PM EDT',
  });
  assert.match(icon.html, /N20UF · M8VTQD/);
  assert.match(icon.html, /DEP 6:30 PM EDT/);
  assert.match(icon.html, /KTEB/);
  assert.doesNotMatch(icon.html, /sky-1005/);
});

test('fleet maps follow airborne positions until the user pans, then Fit all resumes', async () => {
  const map = await readFile(path.join(root, 'src/TrackingMap.jsx'), 'utf8');
  assert.match(map, /followFleet = false/);
  assert.match(map, /fleetFitPositions\(aircraft\)/);
  assert.match(map, /label="Fit all"/);
  assert.match(map, /map\.on\('dragstart'/);
  assert.match(map, /map\.on\('zoomstart'/);
  assert.match(map, /userMovedRef\.current = false/);
  assert.match(map, /if \(!fittingRef\.current\) userMovedRef\.current = true/);
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  assert.match(app, /followFleet/);
  assert.match(app, /Trip\\s\*ID/);
  const panel = await readFile(path.join(root, 'src/FleetTrackingPanel.jsx'), 'utf8');
  assert.match(panel, /followFleet/);
});
