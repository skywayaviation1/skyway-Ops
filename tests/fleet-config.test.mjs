import assert from 'node:assert/strict';
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
  });
  const config = {
    aircraftByTail: {
      n20uf: { displayName: 'Verified Model', icaoType: 'c25b', homeBase: 'kteb' },
    },
  };
  // Stored keys are normalized by the admin endpoint before clients consume it.
  const normalized = normalizeAircraftByTail(config.aircraftByTail, ['N20UF']);
  assert.deepEqual(normalized.N20UF, {
    displayName: 'Verified Model',
    icaoType: 'C25B',
    serialNumber: '',
    homeBase: 'KTEB',
  });
  assert.equal(resolveAircraftMeta('N20UF', { aircraftByTail: normalized }).displayName, 'Verified Model');
});

test('metadata for schedule-only tails is excluded from fleet configuration', () => {
  const normalized = normalizeAircraftByTail({
    N20UF: { displayName: 'Managed' },
    NPARTNER: { displayName: 'Vendor' },
  }, ['N20UF']);
  assert.deepEqual(Object.keys(normalized), ['N20UF']);
});
