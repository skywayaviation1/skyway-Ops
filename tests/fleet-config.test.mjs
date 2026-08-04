import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MANAGED_TAILS,
  normalizeFleetTails,
  normalizeTail,
  resolveManagedTails,
  scheduledOnlyTails,
} from '../src/fleet-config.js';

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
