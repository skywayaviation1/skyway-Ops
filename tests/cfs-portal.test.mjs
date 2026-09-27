import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cfsStaffAllows, cfsStaffFromList, readCfsStaff } from '../src/aog-recovery.js';
import { coverageLimitCentsFor, reportingFacts } from '../src/aog-reporting.js';
import { brokerComparison } from '../src/aog-offer-copy.js';
import {
  cfsTripProjection,
  dashboardSummary,
  filterPortalTrips,
  magicLinkDecision,
  magicLinkPayload,
  planCfsReminders,
  projectionLeaks,
  statementCsv,
  statementFor,
} from '../src/cfs-portal.js';

const trip = {
  id: 'cov-1',
  tripId: 'M8CFS2',
  coverageLevel: 'gifted_100',
  tripTotal: 20000,
  tripTotalCents: 2000000,
  upgradeMultiplier: 2,
  includedMultiplier: 1,
  aircraftType: 'Citation CJ3',
  tail: 'N318CS',
  route: 'KTEB → KPBI',
  routeFrom: 'KTEB',
  routeTo: 'KPBI',
  departDate: '2026-11-02',
  brokerCompany: 'Example Charter Group',
  brokerEmail: 'broker@example-charter.test',
  premium: 300,
  premiumCents: 30000,
  ratePercent: 1.5,
  cfsMarginCents: -100,
  paymentStatus: 'gifted',
  bindEmailSentAt: '2026-09-25T12:00:00.000Z',
  charterContractPath: 'trip-contracts/M8CFS2/charter-contract.pdf',
};

test('50% stores a 1x limit and 100% stores the upgrade multiplier', () => {
  const included = reportingFacts({ tripTotalCents: 2000000, coverageLevel: 'included_50', includedMultiplier: 1, upgradeMultiplier: 2 });
  assert.equal(included.coverageLimitCents, 2000000);
  assert.equal(included.coverageMultiplier, 1);
  const upgraded = reportingFacts({ tripTotalCents: 2500000, coverageLevel: 'purchased_100', upgradeMultiplier: 2 });
  assert.equal(upgraded.coverageLimitCents, 5000000);
  assert.equal(upgraded.coverageMultiplier, 2);
  const corrected = reportingFacts({ tripTotalCents: 1800000, coverageLevel: 'included_50', includedMultiplier: 1 });
  assert.equal(corrected.coverageLimitCents, 1800000);
  assert.equal(coverageLimitCentsFor(1800000, 'gifted_100', { upgradeMultiplier: 2 }), 3600000);
});

test('broker comparison names both tiers and the premium', () => {
  const view = brokerComparison({
    ...trip,
    coverageLevel: 'included_50',
    upgradeAvailable: true,
    premium: 300,
  });
  assert.equal(view.includedLine, 'Included: 50%, up to $20,000.00');
  assert.equal(view.upgradeLine, 'Upgrade: 100%, up to $40,000.00, premium $300.00');
});

test('CFS projection drops 50% trips and Skyway-only fields', () => {
  assert.equal(cfsTripProjection({ ...trip, coverageLevel: 'included_50' }), null);
  const safe = cfsTripProjection(trip, [{ from: 'KTEB', to: 'KPBI', start: '2026-11-02T14:00:00.000Z', end: '2026-11-02T17:00:00.000Z', tail: 'N318CS', passengers: ['A'] }]);
  assert.equal(safe.coverage, '100%');
  assert.equal(safe.coverageValueLabel, 'up to $40,000.00');
  assert.equal(safe.brokerCompany, 'Example Charter Group');
  assert.equal(safe.legs[0].from, 'KTEB');
  assert.equal(safe.legs[0].passengers, undefined);
  assert.equal(projectionLeaks(safe), false);
  assert.equal(Object.hasOwn(safe, 'premium'), false);
  assert.equal(Object.hasOwn(safe, 'brokerEmail'), false);
  assert.equal(Object.hasOwn(safe, 'ratePercent'), false);
});

test('dashboard, filters, and the monthly statement use only CFS-visible trips', () => {
  const awaiting = cfsTripProjection(trip);
  const confirmed = cfsTripProjection({
    ...trip,
    id: 'cov-2',
    tripId: 'N6C2WT',
    cfsStatus: 'cfs_confirmed',
    cfsConfirmedAt: '2026-09-20T15:00:00.000Z',
    cfsCostCents: 64000,
    cfsConfirmedByName: 'Casey Stone',
    returnDate: '2026-11-04',
  });
  const summary = dashboardSummary([awaiting, confirmed], new Date('2026-09-27T12:00:00.000Z'));
  assert.equal(summary.awaiting, 1);
  assert.equal(summary.counts.all, 2);
  assert.equal(summary.counts.awaiting, 1);
  assert.equal(summary.counts.confirmed, 1);
  assert.equal(summary.confirmedThisMonth, 1);
  assert.equal(summary.boundValueCents, 4000000);
  const found = filterPortalTrips([awaiting, confirmed], { q: 'N6C2WT', status: 'confirmed' });
  assert.deepEqual(found.map((row) => row.tripId), ['N6C2WT']);
  const statement = statementFor([awaiting, confirmed], '2026-09');
  assert.equal(statement.rows.length, 1);
  assert.match(statementCsv(statement), /N6C2WT/);
  assert.match(statementCsv(statement), /4000000","64000/);
});

test('magic links stay on the allowlist and reminders fire twice at most', () => {
  const staff = readCfsStaff({});
  assert.equal(staff[0].email, 'charter@charterflightsupport.com');
  assert.equal(cfsStaffAllows('charter@charterflightsupport.com', staff), true);
  const next = cfsStaffFromList(['ops-cfs@charterflightsupport.com'], {
    previous: staff,
    actorEmail: 'jake@flyskyway.com',
    now: '2026-09-27T12:00:00.000Z',
  });
  assert.equal(next[0].email, 'ops-cfs@charterflightsupport.com');
  assert.equal(next[0].addedBy, 'jake@flyskyway.com');
  assert.equal(magicLinkDecision('nope@example.com', next).send, false);
  assert.equal(magicLinkDecision('not-an-email', next).ok, false);
  assert.equal(magicLinkDecision('ops-cfs@charterflightsupport.com', next).send, true);
  assert.deepEqual(magicLinkPayload({ emulator: false, link: 'https://example.test/cfs?link=abc' }), { ok: true });
  assert.equal(magicLinkPayload({ emulator: true, link: 'https://example.test/cfs?link=abc' }).devLink.includes('/cfs?link='), true);

  const now = new Date('2026-09-27T12:00:00.000Z');
  const due = planCfsReminders(trip, now);
  assert.deepEqual(due.map((row) => row.kind), ['bind_24h']);
  const departSoon = planCfsReminders({
    ...trip,
    bindEmailSentAt: '2026-09-27T10:00:00.000Z',
    departAtUtc: '2026-09-28T08:00:00.000Z',
  }, now);
  assert.deepEqual(departSoon.map((row) => row.kind), ['depart_24h']);
  assert.deepEqual(planCfsReminders({ ...trip, cfsStatus: 'cfs_confirmed' }, now), []);
  assert.deepEqual(planCfsReminders({ ...trip, coverageLevel: 'included_50' }, now), []);
  assert.deepEqual(planCfsReminders({ ...trip, cfsReminder24SentAt: '2026-09-26T12:00:00.000Z' }, now), []);
});

test('portal API and rules keep CFS off Skyway collections', async () => {
  const api = await readFile(new URL('../api/cfs-portal.js', import.meta.url), 'utf8');
  assert.match(api, /cfsTripProjection/);
  assert.match(api, /isCfsVisibleRecord/);
  assert.match(api, /createCustomToken/);
  assert.match(api, /role: 'cfs'/);
  assert.match(api, /preview is read-only/i);
  const rules = await readFile(new URL('../firestore/aog-recovery.rules', import.meta.url), 'utf8');
  assert.match(rules, /isCfsRole/);
  assert.match(rules, /request\.auth\.token\.role == 'cfs'/);
  assert.match(rules, /!isCfsRole\(\)/);
  assert.match(rules, /match \/cfsSessions\/\{id\}/);
  const reminders = await readFile(new URL('../api/cfs-portal-reminders.js', import.meta.url), 'utf8');
  assert.match(reminders, /planCfsReminders/);
  assert.match(reminders, /cfs_reminder_sent/);
  assert.equal(/50%/.test(reminders), false);
});
