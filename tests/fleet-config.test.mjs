import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MANAGED_TAILS,
  normalizeFleetTails,
  normalizeTail,
  normalizeAircraftByTail,
  resolveAircraftMeta,
  resolveManagedTails,
  scheduledOnlyTails,
} from '../src/fleet-config.js';

const root = path.resolve(import.meta.dirname, '..');

test('tail normalization is stable and de-duplicates values', () => {
  assert.equal(normalizeTail(' n20uf '), 'N20UF');
  assert.deepEqual(
    normalizeFleetTails(['n20uf', ' N20UF ', 'n444am']),
    ['N20UF', 'N444AM'],
  );
});

test('older deployments use the default fleet', () => {
  assert.deepEqual(resolveManagedTails({}), [...DEFAULT_MANAGED_TAILS]);
  assert.deepEqual(resolveManagedTails({ fleetTails: [] }), [...DEFAULT_MANAGED_TAILS]);
});

test('an explicitly configured empty fleet remains empty', () => {
  assert.deepEqual(
    resolveManagedTails({ fleetConfigured: true, fleetTails: [] }),
    [],
  );
});

test('schedule-only aircraft are separated without removing their trips', () => {
  const trips = [
    { info: { tail: 'N20UF' } },
    { info: { tail: 'NPARTNER' } },
    { info: { tail: 'npartner' } },
  ];
  assert.deepEqual(scheduledOnlyTails(trips, ['N20UF']), ['NPARTNER']);
  assert.equal(trips.length, 3);
});

test('aircraft metadata is admin supplied and never guessed from a tail', () => {
  assert.deepEqual(resolveAircraftMeta('N20UF', {}), {
    displayName: '',
    icaoType: '',
    serialNumber: '',
    homeBase: '',
    costPerBlockHour: null,
    sellPerBlockHour: null,
  });
  const config = {
    aircraftByTail: {
      n20uf: {
        displayName: 'Verified Model',
        icaoType: 'c25b',
        homeBase: 'kteb',
        costPerBlockHour: '2450.55',
        sellPerBlockHour: 5250,
      },
    },
  };
  // Stored keys are normalized by the admin endpoint before clients consume it.
  const normalized = normalizeAircraftByTail(config.aircraftByTail, ['N20UF']);
  assert.deepEqual(normalized.N20UF, {
    displayName: 'Verified Model',
    icaoType: 'C25B',
    serialNumber: '',
    homeBase: 'KTEB',
    costPerBlockHour: 2450.55,
    sellPerBlockHour: 5250,
  });
  assert.equal(resolveAircraftMeta('N20UF', { aircraftByTail: normalized }).displayName, 'Verified Model');
});

test('fleet rates are non-negative finite block-hour amounts', () => {
  const normalized = normalizeAircraftByTail({
    N20UF: {
      costPerBlockHour: -10,
      sellPerBlockHour: 'not a number',
    },
    N444AM: {
      costPerBlockHour: 2_500.129,
      sellPerBlockHour: 9_999_999,
    },
  }, ['N20UF', 'N444AM']);
  assert.equal(normalized.N20UF.costPerBlockHour, 0);
  assert.equal(normalized.N20UF.sellPerBlockHour, null);
  assert.equal(normalized.N444AM.costPerBlockHour, 2500.13);
  assert.equal(normalized.N444AM.sellPerBlockHour, 1_000_000);
});

test('metadata for schedule-only tails is excluded from fleet configuration', () => {
  const normalized = normalizeAircraftByTail({
    N20UF: { displayName: 'Managed' },
    NPARTNER: { displayName: 'Vendor' },
  }, ['N20UF']);
  assert.deepEqual(Object.keys(normalized), ['N20UF']);
});

test('fleet settings expose and persist operating cost and sell rates', async () => {
  const ui = await readFile(path.join(root, 'src/AdminSettings.jsx'), 'utf8');
  assert.match(ui, /costPerBlockHour/);
  assert.match(ui, /sellPerBlockHour/);
  assert.match(ui, /Operating cost \/ block hour/);
  assert.match(ui, /Sell rate \/ live block hour/);

  const api = await readFile(path.join(root, 'api/admin-settings.js'), 'utf8');
  assert.match(api, /costPerBlockHour: meta\.costPerBlockHour/);
  assert.match(api, /sellPerBlockHour: meta\.sellPerBlockHour/);
});
