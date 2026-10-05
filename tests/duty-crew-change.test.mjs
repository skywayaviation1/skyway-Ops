import assert from 'node:assert/strict';
import test from 'node:test';

import {
  etDayBounds,
  extendedRestForPeriod,
  flightTimeChecks,
  planDutyOff,
  planOct1CrewCorrection,
  planRelink,
  resolveDutyEndScope,
  restOutlook,
  wasClosedByPartnerDutyOff,
} from '../src/duty-crew-change.js';
import { evaluateCurrent, LIMITS } from '../src/duty-legality.js';

const HOUR = 3600_000;

function period(patch) {
  return {
    id: 'p1',
    pilotUid: 'matt',
    pilotName: 'Matt Hale',
    role: 'SIC',
    crewType: 'two',
    assignmentType: 'unscheduled',
    status: 'on',
    confirmStatus: 'self-attested',
    dutyOnAt: 1_000_000,
    dutyOffAt: null,
    flightTimeMs: 0,
    partnerPeriodId: 'daniel-period',
    adminEdits: [],
    ...patch,
  };
}

test('paired duty-off without a choice does not close anyone', () => {
  const decision = resolveDutyEndScope({ hasOpenPartner: true, replacement: null, scope: undefined });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'end-scope-required');

  const plan = planDutyOff({
    period: period({ id: 'matt-period' }),
    partner: period({ id: 'daniel-period', pilotUid: 'daniel', pilotName: 'Daniel Cho', role: 'PIC', partnerPeriodId: 'matt-period' }),
    dutyOffAt: 1_000_000 + 5 * HOUR,
    scope: undefined,
    actorName: 'Daniel Cho',
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.writes, undefined);
});

test('crew change ends only the departing pilot and keeps the original duty-on', () => {
  const on = Date.parse('2026-10-01T12:00:00Z');
  const off = on + 5 * HOUR;
  const matt = period({
    id: 'matt-period',
    dutyOnAt: on,
    pilotName: 'Matt Hale',
    role: 'SIC',
  });
  const daniel = period({
    id: 'daniel-period',
    pilotUid: 'daniel',
    pilotName: 'Daniel Cho',
    role: 'PIC',
    partnerPeriodId: 'matt-period',
    dutyOnAt: on,
  });
  const plan = planDutyOff({
    period: daniel,
    partner: matt,
    dutyOffAt: off,
    flightTimeMs: 3 * HOUR,
    replacement: { pilotUid: 'kameron', pilotName: 'Kameron Blake', role: 'PIC' },
    actorName: 'Daniel Cho',
    now: off,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.scope, 'self');
  assert.equal(plan.scopeReason, 'crew-change-defaults-to-own-duty');

  const danielWrite = plan.writes.find((write) => write.id === 'daniel-period');
  const mattWrite = plan.writes.find((write) => write.id === 'matt-period');
  const created = plan.writes.find((write) => write.op === 'create');

  assert.equal(danielWrite.patch.status, 'off');
  assert.equal(danielWrite.patch.dutyOffAt, off);
  assert.equal(mattWrite.patch.status, 'on');
  assert.equal(mattWrite.patch.dutyOnAt, on);
  assert.equal(mattWrite.patch.dutyOffAt, null);
  assert.equal(mattWrite.patch.crewType, 'two');
  assert.equal(mattWrite.patch.partnerPeriodId, created.id);
  assert.equal(created.doc.pilotUid, 'kameron');
  assert.equal(created.doc.dutyOnAt, off);
  assert.equal(created.doc.partnerPeriodId, 'matt-period');
  assert.equal(created.doc.confirmStatus, 'pending');
  assert.ok(mattWrite.patch.adminEdits.at(-1).from.dutyOnAt === on);
  assert.ok(mattWrite.patch.adminEdits.at(-1).to.dutyOnAt === on);
  assert.equal(wasClosedByPartnerDutyOff({ ...matt, ...mattWrite.patch }), false);
});

test('explicit whole-crew duty-off closes both and is not a mistaken partner close', () => {
  const on = Date.parse('2026-10-01T12:00:00Z');
  const off = on + 8 * HOUR;
  const plan = planDutyOff({
    period: period({ id: 'daniel-period', pilotUid: 'daniel', pilotName: 'Daniel Cho', role: 'PIC', dutyOnAt: on }),
    partner: period({ id: 'matt-period', dutyOnAt: on, partnerPeriodId: 'daniel-period' }),
    dutyOffAt: off,
    scope: 'crew',
    actorName: 'Daniel Cho',
    now: off,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.scope, 'crew');
  const matt = plan.writes.find((write) => write.id === 'matt-period').patch;
  assert.equal(matt.status, 'off');
  assert.equal(matt.closedByPartner, false);
  assert.equal(wasClosedByPartnerDutyOff({ status: 'off', ...matt }), false);
});

test('a partner-closed duty can be resumed and re-paired without a new duty-on', () => {
  const on = Date.parse('2026-10-01T12:00:00Z');
  const closedAt = on + 5 * HOUR;
  const joinAt = closedAt + 10 * 60_000;
  const matt = period({
    id: 'matt-period',
    status: 'off',
    dutyOnAt: on,
    dutyOffAt: closedAt,
    flightTimeMs: 3 * HOUR,
    closedByPartner: true,
    adminEdits: [{
      field: 'endDuty',
      note: 'Crew-synced duty off — closed automatically when Daniel (PIC) ended duty',
    }],
  });
  assert.equal(wasClosedByPartnerDutyOff(matt), true);
  const plan = planRelink({
    stayer: matt,
    partnerUser: { pilotUid: 'kameron', pilotName: 'Kameron Blake', role: 'PIC' },
    joinAt,
    actorName: 'Matt Hale',
    now: joinAt,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.resuming, true);
  const patch = plan.writes.find((write) => write.id === 'matt-period').patch;
  assert.equal(patch.status, 'on');
  assert.equal(patch.dutyOnAt, on);
  assert.equal(patch.dutyOffAt, null);
  assert.equal(patch.crewType, 'two');
  assert.equal(patch.adminEdits.at(-1).field, 'resumeContinuousDuty');
  const created = plan.writes.find((write) => write.op === 'create');
  assert.equal(created.doc.dutyOnAt, joinAt);
  assert.notEqual(created.doc.dutyOnAt, on);
});

test('single-to-paired conversion preserves duty-on and splits the limits', () => {
  const on = Date.parse('2026-10-01T12:00:00Z');
  const joinAt = on + 4 * HOUR;
  const matt = period({
    id: 'matt-single',
    crewType: 'single',
    partnerPeriodId: null,
    dutyOnAt: on,
    flightTimeMs: 4 * HOUR,
    role: 'PIC',
  });
  const plan = planRelink({
    stayer: matt,
    partnerUser: { pilotUid: 'kameron', pilotName: 'Kameron Blake', role: 'SIC' },
    joinAt,
    actorName: 'Matt Hale',
    now: joinAt,
  });
  const patch = plan.writes.find((write) => write.id === 'matt-single').patch;
  assert.equal(patch.dutyOnAt, on);
  assert.equal(patch.crewType, 'two');
  assert.equal(patch.crewSegments[0].crewType, 'single');
  assert.equal(patch.crewSegments[0].flightTimeMs, 4 * HOUR);
  assert.equal(patch.crewSegments.at(-1).crewType, 'two');
  const corrected = { ...matt, ...patch, confirmStatus: 'self-attested' };
  const checks = flightTimeChecks([corrected], joinAt + HOUR);
  const single = checks.find((check) => check.code === 'FT_24H_SINGLE');
  const two = checks.find((check) => check.code === 'FT_24H_TWO');
  assert.equal(single.severity, 'info');
  assert.equal(two, undefined);
});

test('9.3 hours with two pilots is not an 8-hour exceedance and does not require 16 hours rest', () => {
  const on = Date.parse('2026-10-01T12:00:00Z');
  const off = on + 12 * HOUR;
  const at = off + 10 * HOUR;
  const twoPilot = {
    id: 'matt-day',
    pilotUid: 'matt',
    dutyOnAt: on,
    dutyOffAt: off,
    status: 'off',
    confirmStatus: 'self-attested',
    assignmentType: 'unscheduled',
    crewType: 'two',
    flightTimeMs: 9.3 * HOUR,
    crewSegments: [
      { crewType: 'two', startedAt: on, endedAt: on + 5 * HOUR, flightTimeMs: 4 * HOUR, partnerName: 'Daniel Cho' },
      { crewType: 'two', startedAt: on + 5 * HOUR, endedAt: off, flightTimeMs: 5.3 * HOUR, partnerName: 'Kameron Blake' },
    ],
  };
  const legal = evaluateCurrent([twoPilot], [], at, 'two');
  assert.equal(legal.blockers.length, 0);
  const twoCheck = legal.checks.find((check) => check.code === 'FT_24H_TWO');
  assert.equal(twoCheck.severity, 'warn');
  assert.match(twoCheck.message, /10h/);
  assert.equal(legal.checks.some((check) => check.code === 'FT_24H_SINGLE'), false);
  const rest = legal.checks.find((check) => check.code === 'REST_24H');
  assert.equal(rest.details.requiredMs, LIMITS.REST_REQUIRED_BEFORE_MS);
  assert.equal(rest.severity, 'info');
  assert.equal(legal.status, 'warning');

  const single = { ...twoPilot, crewType: 'single', crewSegments: undefined };
  const flagged = evaluateCurrent([single], [], at, 'single');
  const singleCheck = flagged.checks.find((check) => check.code === 'FT_24H_SINGLE');
  assert.equal(singleCheck.severity, 'block');
  assert.match(singleCheck.message, /135\.267\(b\)/);
  const restSingle = extendedRestForPeriod(single);
  assert.equal(restSingle.requiredMs, LIMITS.EXTENDED_REST_TIER_3_MS);
  assert.equal(restSingle.rule, '14 CFR 135.267(d)');
  const outlook = restOutlook([single], at);
  assert.equal(outlook.blocked, true);
  assert.equal(outlook.requiredMs, 16 * HOUR);
});

test('Oct 1 correction restores one continuous two-pilot duty and clears the 16-hour block', () => {
  const day = etDayBounds(2026, 10, 1);
  assert.equal(new Date(day.start).toISOString(), '2026-10-01T04:00:00.000Z');
  const on = day.start + 8 * HOUR;
  const danielOff = on + 5 * HOUR;
  const singleOn = danielOff + 10 * 60_000;
  const off = on + 14 * HOUR;
  const morning = etDayBounds(2026, 10, 2).start + 8 * HOUR;
  const users = [
    { uid: 'uid-matt', name: 'Matt Hale', role: 'crew' },
    { uid: 'uid-daniel', name: 'Daniel Cho', role: 'crew' },
    { uid: 'uid-kameron', name: 'Kameron Blake', role: 'crew' },
    { uid: 'uid-other', name: 'Timothy Woods', role: 'crew' },
  ];
  const periods = [
    {
      id: 'uid-matt_' + on,
      pilotUid: 'uid-matt',
      pilotName: 'Matt Hale',
      role: 'SIC',
      crewType: 'two',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: on,
      dutyOffAt: danielOff,
      flightTimeMs: 0,
      partnerPeriodId: 'uid-daniel_' + on,
      adminEdits: [{
        field: 'endDuty',
        note: 'Crew-synced duty off — closed automatically when Daniel Cho (PIC) ended duty',
      }],
    },
    {
      id: 'uid-matt_' + singleOn,
      pilotUid: 'uid-matt',
      pilotName: 'Matt Hale',
      role: 'PIC',
      crewType: 'single',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: singleOn,
      dutyOffAt: off,
      flightTimeMs: 9.3 * HOUR,
      partnerPeriodId: null,
      adminEdits: [],
    },
    {
      id: 'uid-daniel_' + on,
      pilotUid: 'uid-daniel',
      pilotName: 'Daniel Cho',
      role: 'PIC',
      crewType: 'two',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: on,
      dutyOffAt: danielOff,
      flightTimeMs: 3.1 * HOUR,
      partnerPeriodId: 'uid-matt_' + on,
    },
    {
      id: 'uid-kameron_' + singleOn,
      pilotUid: 'uid-kameron',
      pilotName: 'Kameron Blake',
      role: 'SIC',
      crewType: 'single',
      status: 'off',
      confirmStatus: 'self-attested',
      dutyOnAt: singleOn,
      dutyOffAt: off,
      flightTimeMs: 6.2 * HOUR,
      partnerPeriodId: null,
    },
  ];

  const plan = planOct1CrewCorrection({ users, periods, now: morning, actorName: 'Jake' });
  assert.equal(plan.applicable, true);
  assert.equal(plan.continuous, true);
  assert.equal(plan.pilots.matt.matches[0].uid, 'uid-matt');
  assert.equal(plan.pilots.daniel.matches[0].uid, 'uid-daniel');
  assert.equal(plan.pilots.kameron.matches[0].uid, 'uid-kameron');
  assert.equal(plan.wrong16HourBlockCleared, true);
  assert.equal(plan.signOnAllowedAt0800EtOct2, true);
  assert.equal(plan.before.morningSignOn.rest.requiredMs, 16 * HOUR);
  assert.equal(plan.after.morningSignOn.rest.requiredMs, 10 * HOUR);

  const matt = plan.writes.find((write) => write.id === 'uid-matt_' + on).patch;
  assert.equal(matt.dutyOnAt, on);
  assert.equal(matt.dutyOffAt, off);
  assert.equal(matt.crewType, 'two');
  assert.equal(matt.flightTimeMs, 9.3 * HOUR);
  assert.equal(matt.crewSegments[0].partnerUid, 'uid-daniel');
  assert.equal(matt.crewSegments[1].partnerUid, 'uid-kameron');
  assert.equal(matt.adminEdits.at(-1).by, 'Jake');
  assert.ok(matt.adminEdits.at(-1).from);
  assert.ok(matt.adminEdits.at(-1).to);

  const superseded = plan.writes.find((write) => write.id === 'uid-matt_' + singleOn).patch;
  assert.equal(superseded.recordStatus, 'superseded');
  assert.equal(superseded.adminEdits.at(-1).from.flightTimeMs, 9.3 * HOUR);

  const daniel = plan.writes.find((write) => write.id === 'uid-daniel_' + on).patch;
  assert.equal(daniel.dutyOnAt, undefined);
  assert.equal(daniel.dutyOffAt, undefined);
  assert.equal(daniel.flightTimeMs, undefined);

  const kameron = plan.writes.find((write) => write.id === 'uid-kameron_' + singleOn).patch;
  assert.equal(kameron.crewType, 'two');
  assert.equal(kameron.flightTimeMs, undefined);
  assert.equal(kameron.partnerPeriodId, 'uid-matt_' + on);

  const corrected = {
    ...periods[0],
    ...matt,
    confirmStatus: 'self-attested',
  };
  const legality = evaluateCurrent([corrected, { ...periods[1], ...superseded }], [], morning, 'two');
  assert.equal(legality.blockers.length, 0);
  assert.equal(legality.checks.find((check) => check.code === 'REST_24H').details.requiredMs, 10 * HOUR);
  assert.equal(legality.checks.some((check) => check.code === 'FT_24H_SINGLE'), false);
});

test('ambiguous pilot names produce a report and no writes', () => {
  const plan = planOct1CrewCorrection({
    users: [
      { uid: 'a', name: 'Matt Hale' },
      { uid: 'b', name: 'Matt Ellis' },
      { uid: 'c', name: 'Daniel Cho' },
      { uid: 'd', name: 'Kameron Blake' },
    ],
    periods: [],
    now: Date.parse('2026-10-02T16:00:00Z'),
  });
  assert.equal(plan.applicable, false);
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.pilots.matt.matches.length, 2);
});
