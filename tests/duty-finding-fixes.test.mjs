import assert from 'node:assert/strict';
import test from 'node:test';

import { attentionFixture } from '../src/duty-attention-fixture.js';
import {
  applyPlanToPeriods,
  counterparts,
  fixKindForIssue,
  issuesFor,
  planFindingFix,
  recordIssues,
  undoPlan,
} from '../src/duty-findings.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-11T19:10:00.000Z');

function issue(periods, id, code, now = NOW) {
  return (issuesFor(periods, now).get(id) || []).find((row) => row.code === code) || null;
}

function apply(periods, plan) {
  assert.equal(plan.ok, true, plan.error || 'plan failed');
  return applyPlanToPeriods(periods, plan);
}

test('Oct 1 cards match the reported finding labels', () => {
  const periods = attentionFixture(NOW);
  const matt = issue(periods, 'duty-matt-oct1', 'FLIGHT_LIMIT');
  const daniel = issue(periods, 'duty-daniel-oct1', 'ONE_WAY_PAIR');
  const samOff = issue(periods, 'duty-sam-long', 'MISSING_OFF');
  const samOver = issue(periods, 'duty-sam-long', 'OVERLAP');
  const samDeclined = issue(periods, 'duty-sam-long', 'DECLINED');
  const samHours = issue(periods, 'duty-sam-long', 'OVER_14');
  assert.equal(matt.label, '9.3h single-pilot flight exceeds 8h');
  assert.equal(daniel.label, 'Partner link is not reciprocal');
  assert.equal(samOff.label, 'Closed record has no duty-off time');
  assert.equal(samOver.label, 'Overlaps another record for this pilot');
  assert.equal(samDeclined.label, 'Pilot declined paired duty');
  assert.equal(samHours.label, 'Regular duty 455.3h exceeds 14h');
  assert.equal(issue(periods, 'duty-sam-sep28-a', 'OVERLAP').label, 'Overlaps another record for this pilot');
  assert.equal(fixKindForIssue('FLIGHT_LIMIT'), 'link');
  assert.equal(fixKindForIssue('ONE_WAY_PAIR'), 'reciprocal');
  assert.equal(fixKindForIssue('OVERLAP'), 'overlap');
});

test('linking Matt to Daniel clears the 8-hour flag and makes the link reciprocal', () => {
  const periods = attentionFixture(NOW);
  const plan = planFindingFix({
    kind: 'link',
    periods,
    periodId: 'duty-matt-oct1',
    partnerPeriodId: 'duty-daniel-oct1',
    reason: 'Oct 1 was a two-pilot crew',
    now: NOW,
  });
  const next = apply(periods, plan);
  const matt = next.find((period) => period.id === 'duty-matt-oct1');
  const daniel = next.find((period) => period.id === 'duty-daniel-oct1');
  assert.equal(matt.crewType, 'two');
  assert.equal(matt.partnerPeriodId, daniel.id);
  assert.equal(daniel.partnerPeriodId, matt.id);
  assert.equal(matt.flightTimeMs, 9.3 * HOUR);
  assert.equal(matt.dutyOnAt, periods.find((period) => period.id === matt.id).dutyOnAt);
  assert.equal(issue(next, matt.id, 'FLIGHT_LIMIT'), null);
  assert.equal(issue(next, daniel.id, 'ONE_WAY_PAIR'), null);
  const mattLimits = plan.limits.find((row) => row.pilotUid === 'pilot-matt');
  assert.equal(mattLimits.before.singlePilotFlag, true);
  assert.equal(mattLimits.after.singlePilotFlag, false);
  assert.equal(mattLimits.after.extendedRest16, false);
});

test('make reciprocal is one write on both records and refuses a blank reason', () => {
  const periods = attentionFixture(NOW);
  const missing = planFindingFix({
    kind: 'reciprocal',
    periods,
    periodId: 'duty-daniel-oct1',
    reason: '   ',
    now: NOW,
  });
  assert.equal(missing.ok, false);
  const plan = planFindingFix({
    kind: 'reciprocal',
    periods,
    periodId: 'duty-daniel-oct1',
    reason: 'Daniel already points at Matt',
    now: NOW,
  });
  const next = apply(periods, plan);
  assert.equal(next.find((period) => period.id === 'duty-matt-oct1').partnerPeriodId, 'duty-daniel-oct1');
  assert.equal(issue(next, 'duty-daniel-oct1', 'ONE_WAY_PAIR'), null);
  assert.equal(issue(next, 'duty-matt-oct1', 'FLIGHT_LIMIT'), null);
});

test('setting duty-off and correcting the 455 hour clock clears those findings', () => {
  const periods = attentionFixture(NOW);
  const sam = periods.find((period) => period.id === 'duty-sam-long');
  const off = sam.dutyOnAt + 8 * HOUR;
  const plan = planFindingFix({
    kind: 'edit-times',
    periods,
    periodId: sam.id,
    dutyOnAt: sam.dutyOnAt,
    dutyOffAt: off,
    reason: 'Clock was left open after Sep 22',
    now: NOW,
  });
  const next = apply(periods, plan);
  assert.equal(issue(next, sam.id, 'MISSING_OFF'), null);
  assert.equal(issue(next, sam.id, 'OVER_14'), null);
  assert.equal(next.find((period) => period.id === sam.id).flightTimeMs, sam.flightTimeMs);
  const stillLong = planFindingFix({
    kind: 'set-off',
    periods,
    periodId: sam.id,
    dutyOffAt: sam.dutyOnAt + 20 * HOUR,
    reason: 'Trying to keep an illegal window',
    now: NOW,
  });
  assert.equal(stillLong.ok, false);
});

test('admin override clears a declined paired duty without changing times', () => {
  const periods = attentionFixture(NOW);
  const before = periods.find((period) => period.id === 'duty-sam-long');
  const plan = planFindingFix({
    kind: 'override-declined',
    periods,
    periodId: before.id,
    reason: 'Sam did fly the leg',
    actorName: 'Jake',
    now: NOW,
  });
  const next = apply(periods, plan);
  const after = next.find((period) => period.id === before.id);
  assert.equal(after.confirmStatus, 'admin-attested');
  assert.equal(after.overrideApprovedBy, 'Jake');
  assert.equal(after.dutyOnAt, before.dutyOnAt);
  assert.equal(issue(next, before.id, 'DECLINED'), null);
  assert.ok(issue(next, before.id, 'OVER_14'));
});

test('trim, delete, and merge repair Sam overlaps without adding flight time', () => {
  const periods = attentionFixture(NOW);
  const trimmedPlan = planFindingFix({
    kind: 'trim',
    periods,
    periodId: 'duty-sam-sep28-a',
    otherId: 'duty-sam-sep28-b',
    reason: 'Second record starts when the first ended',
    now: NOW,
  });
  const trimmed = apply(periods, trimmedPlan);
  const later = trimmed.find((period) => period.id === 'duty-sam-sep28-b');
  const earlier = trimmed.find((period) => period.id === 'duty-sam-sep28-a');
  assert.equal(later.dutyOnAt, earlier.dutyOffAt);
  assert.equal(later.flightTimeMs, 2 * HOUR);
  const withoutLong = trimmed.filter((period) => period.id !== 'duty-sam-long');
  assert.equal(counterparts(withoutLong.find((period) => period.id === earlier.id), withoutLong, NOW).length, 0);

  const deletePlan = planFindingFix({
    kind: 'delete-duplicate',
    periods,
    periodId: 'duty-sam-oct2-outer',
    otherId: 'duty-sam-oct2-inner',
    dropId: 'duty-sam-oct2-inner',
    reason: 'Inner record is a duplicate of the Oct 2 duty',
    now: NOW,
  });
  const deleted = apply(periods, deletePlan);
  assert.equal(deleted.find((period) => period.id === 'duty-sam-oct2-inner').recordStatus, 'superseded');
  assert.equal(deleted.find((period) => period.id === 'duty-sam-oct2-outer').flightTimeMs, 4 * HOUR);
  const oct2Left = counterparts(deleted.find((period) => period.id === 'duty-sam-oct2-outer'), deleted, NOW);
  assert.deepEqual(oct2Left.map((row) => row.other.id), ['duty-sam-long']);

  const mergePlan = planFindingFix({
    kind: 'merge',
    periods,
    periodId: 'duty-sam-sep28-a',
    otherId: 'duty-sam-sep28-b',
    reason: 'One duty, two records',
    now: NOW,
  });
  const merged = apply(periods, mergePlan);
  const keeper = merged.find((period) => period.id === 'duty-sam-sep28-a');
  assert.equal(keeper.flightTimeMs, 3.5 * HOUR);
  assert.equal(keeper.dutyOffAt, periods.find((period) => period.id === 'duty-sam-sep28-b').dutyOffAt);
  assert.equal(merged.find((period) => period.id === 'duty-sam-sep28-b').recordStatus, 'superseded');
});

test('merge refuses the 455 hour window and bulk repair skips it', () => {
  const periods = attentionFixture(NOW);
  const refused = planFindingFix({
    kind: 'merge',
    periods,
    periodId: 'duty-sam-long',
    otherId: 'duty-sam-sep28-a',
    reason: 'Do not fold a real leg into the open clock',
    now: NOW,
  });
  assert.equal(refused.ok, false);
  const bulk = planFindingFix({
    kind: 'fix-overlaps',
    periods,
    pilotUid: 'pilot-sam',
    reason: 'Clean Sam duplicates',
    now: NOW,
  });
  assert.equal(bulk.ok, true);
  assert.ok(bulk.warnings.some((warning) => warning.includes('455.3h')));
  const next = apply(periods, bulk);
  assert.equal(next.find((period) => period.id === 'duty-sam-long').dutyOnAt, periods.find((period) => period.id === 'duty-sam-long').dutyOnAt);
  assert.equal(next.find((period) => period.id === 'duty-sam-sep28-b').dutyOnAt, next.find((period) => period.id === 'duty-sam-sep28-a').dutyOffAt);
  assert.equal(next.find((period) => period.id === 'duty-sam-oct2-inner').recordStatus, 'superseded');
  assert.ok(issue(next, 'duty-sam-long', 'OVERLAP'));
  assert.ok(bulk.fingerprint);
  const again = planFindingFix({
    kind: 'fix-overlaps',
    periods: next,
    pilotUid: 'pilot-sam',
    reason: 'Nothing left that is safe',
    now: NOW,
  });
  assert.equal(again.ok, false);
});

test('undo restores the before snapshot and the finding comes back', () => {
  const periods = attentionFixture(NOW);
  const plan = planFindingFix({
    kind: 'override-declined',
    periods,
    periodId: 'duty-sam-long',
    reason: 'Accepted in error',
    now: NOW,
  });
  const next = apply(periods, plan);
  assert.equal(issue(next, 'duty-sam-long', 'DECLINED'), null);
  const audit = {
    id: 'audit-1',
    kind: 'override-declined',
    before: plan.before,
    after: plan.after,
    byName: 'Jake',
  };
  const undone = undoPlan(audit, { reason: 'Restore the decline', actorName: 'Jake', now: NOW });
  assert.equal(undone.ok, true);
  const restored = applyPlanToPeriods(next, { ok: true, after: undone.after });
  const sam = restored.find((period) => period.id === 'duty-sam-long');
  assert.equal(sam.confirmStatus, 'declined');
  assert.equal(issue(restored, sam.id, 'DECLINED').label, 'Pilot declined paired duty');
  assert.equal(undoPlan({ ...audit, undoneAt: NOW }, { reason: 'twice' }).ok, false);
});

test('unlink and swap keep each pilot flight time', () => {
  const periods = attentionFixture(NOW);
  const linked = apply(periods, planFindingFix({
    kind: 'link',
    periods,
    periodId: 'duty-matt-oct1',
    partnerPeriodId: 'duty-daniel-oct1',
    reason: 'Pair them',
    now: NOW,
  }));
  const kameron = {
    id: 'duty-kameron',
    pilotUid: 'pilot-kameron',
    pilotName: 'Kameron',
    role: 'SIC',
    tail: 'N168ZZ',
    status: 'off',
    confirmStatus: 'self-attested',
    fitForDuty: true,
    priorRestMs: 12 * HOUR,
    assignmentType: 'regular',
    crewType: 'single',
    dutyOnAt: periods[0].dutyOnAt + 6 * HOUR,
    dutyOffAt: periods[0].dutyOnAt + 10 * HOUR,
    flightTimeMs: 2 * HOUR,
  };
  const withKameron = [...linked, kameron];
  const swapped = apply(withKameron, planFindingFix({
    kind: 'swap',
    periods: withKameron,
    periodId: 'duty-matt-oct1',
    partnerPeriodId: 'duty-kameron',
    reason: 'Daniel swapped for Kameron',
    now: NOW,
  }));
  const matt = swapped.find((period) => period.id === 'duty-matt-oct1');
  const daniel = swapped.find((period) => period.id === 'duty-daniel-oct1');
  assert.equal(matt.partnerPeriodId, 'duty-kameron');
  assert.equal(matt.flightTimeMs, 9.3 * HOUR);
  assert.equal(daniel.partnerPeriodId, null);
  assert.equal(daniel.crewType, 'single');
  assert.ok(counterparts(matt, swapped, NOW).length >= 0);
  const issues = recordIssues(matt, new Map(swapped.map((period) => [period.id, period])), new Set(), NOW);
  assert.equal(issues.some((row) => row.code === 'FLIGHT_LIMIT'), false);
});
