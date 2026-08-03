import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDutyPairBackfillPlan,
  complementaryRole,
  resolvePilot,
} from '../src/duty-pairing.js';

const HOUR = 3600_000;
const ON = new Date('2026-06-01T12:00:00Z').getTime();
const OFF = ON + 10 * HOUR;

const users = [
  { uid: 'pic-uid', name: 'Adrian Stitts', jetinsightName: 'ADRIAN J STITTS', role: 'crew', approved: true, active: true },
  { uid: 'sic-uid', name: 'Maria Santos', jetinsightName: 'MARIA C SANTOS', role: 'crew', approved: true, active: true },
  { uid: 'disabled', name: 'Disabled Pilot', role: 'crew', approved: true, active: false },
  { uid: 'flying-admin', name: 'Flying Admin', role: 'admin', approved: true, active: true },
];

function period(id, pilotUid, role, patch = {}) {
  return {
    id,
    pilotUid,
    pilotName: pilotUid === 'pic-uid' ? 'Adrian Stitts' : 'Maria Santos',
    role,
    crewType: 'two',
    assignmentType: 'regular',
    tail: 'N444AM',
    tripId: 'trip-1',
    dutyOnAt: ON,
    dutyOffAt: OFF,
    status: 'off',
    confirmStatus: 'self-attested',
    fitForDuty: true,
    flightTimeMs: 4 * HOUR,
    ...patch,
  };
}

const trips = [{
  uid: 'trip-1',
  start: new Date(ON + HOUR).toISOString(),
  end: new Date(ON + 5 * HOUR).toISOString(),
  info: { tail: 'N444AM', pic: 'ADRIAN J STITTS', sic: 'MARIA C SANTOS' },
}];

test('complementaryRole is symmetric', () => {
  assert.equal(complementaryRole('PIC'), 'SIC');
  assert.equal(complementaryRole('sic'), 'PIC');
  assert.equal(complementaryRole(null), null);
});

test('resolvePilot prefers JetInsight identity and excludes disabled accounts', () => {
  const result = resolvePilot('ADRIAN J STITTS', users);
  assert.equal(result.user.uid, 'pic-uid');
  assert.equal(result.reason, 'exact');
  assert.equal(resolvePilot('Disabled Pilot', users).user, null);
  assert.equal(resolvePilot('Flying Admin', users).user.uid, 'flying-admin');
});

test('links one unambiguous pair of existing records', () => {
  const pic = period('pic-uid_1', 'pic-uid', 'PIC');
  const sic = period('sic-uid_1', 'sic-uid', 'SIC', { dutyOnAt: ON + 5 * 60_000, dutyOffAt: OFF + 5 * 60_000 });
  const plan = buildDutyPairBackfillPlan({ periods: [pic, sic], users, trips });

  assert.deepEqual(plan.summary, { scanned: 2, links: 1, creates: 0, skipped: 0 });
  assert.deepEqual(plan.actions[0], {
    type: 'link',
    picId: pic.id,
    sicId: sic.id,
    evidence: 'same-tail-and-time',
  });
});

test('creates a missing SIC from an unambiguous trip assignment', () => {
  const pic = period('pic-uid_1', 'pic-uid', 'PIC');
  const plan = buildDutyPairBackfillPlan({ periods: [pic], users, trips });

  assert.equal(plan.summary.creates, 1);
  assert.equal(plan.actions[0].targetUid, 'sic-uid');
  assert.equal(plan.actions[0].targetRole, 'SIC');
  assert.equal(plan.actions[0].sourceId, pic.id);
});

test('creates a missing PIC when the existing record belongs to the SIC', () => {
  const sic = period('sic-uid_1', 'sic-uid', 'SIC');
  const plan = buildDutyPairBackfillPlan({ periods: [sic], users, trips });

  assert.equal(plan.summary.creates, 1);
  assert.equal(plan.actions[0].targetUid, 'pic-uid');
  assert.equal(plan.actions[0].targetRole, 'PIC');
});

test('repairs a dangling deterministic partner link without schedule data', () => {
  const pic = period('pic-uid_1', 'pic-uid', 'PIC', {
    partnerPeriodId: `sic-uid_${ON}`,
  });
  const plan = buildDutyPairBackfillPlan({ periods: [pic], users, trips: [] });

  assert.equal(plan.summary.creates, 1);
  assert.equal(plan.actions[0].evidence, 'dangling-partner-link');
  assert.equal(plan.actions[0].targetId, `sic-uid_${ON}`);
});

test('is idempotent when periods are already linked', () => {
  const pic = period('pic', 'pic-uid', 'PIC', { partnerPeriodId: 'sic' });
  const sic = period('sic', 'sic-uid', 'SIC', { partnerPeriodId: 'pic' });
  const plan = buildDutyPairBackfillPlan({ periods: [pic, sic], users, trips });

  assert.equal(plan.actions.length, 0);
});

test('repairs a one-way link when both records exist and agree', () => {
  const pic = period('pic', 'pic-uid', 'PIC', { partnerPeriodId: 'sic' });
  const sic = period('sic', 'sic-uid', 'SIC', { partnerPeriodId: null });
  const plan = buildDutyPairBackfillPlan({ periods: [pic, sic], users, trips: [] });

  assert.equal(plan.summary.links, 1);
  assert.equal(plan.actions[0].evidence, 'one-way-partner-link');
});

test('does not create when the target pilot has an overlapping record', () => {
  const pic = period('pic', 'pic-uid', 'PIC');
  const other = period('other', 'sic-uid', null, { tail: 'N12345', dutyOnAt: ON + HOUR, dutyOffAt: OFF - HOUR });
  const plan = buildDutyPairBackfillPlan({ periods: [pic, other], users, trips });

  assert.equal(plan.summary.creates, 0);
  assert.ok(plan.skips.some((skip) => skip.reason === 'counterpart-overlap-exists'));
});

test('skips ambiguous existing counterpart records', () => {
  const pic = period('pic', 'pic-uid', 'PIC');
  const sic1 = period('sic1', 'sic-uid', 'SIC');
  const sic2 = period('sic2', 'another-sic', 'SIC');
  const plan = buildDutyPairBackfillPlan({ periods: [pic, sic1, sic2], users, trips });

  assert.equal(plan.summary.links, 0);
  assert.ok(plan.skips.some((skip) => skip.reason === 'ambiguous-existing-counterpart'));
});

