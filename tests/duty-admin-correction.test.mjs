import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildDutyTimePatch } from '../api/duty-admin-action.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');
const HOUR = 3600_000;

test('a corrected 12-hour duty clears stale OVER_14 approval for linked records', () => {
  const on = Date.parse('2026-09-08T13:55:00Z');
  const off = on + 12 * HOUR;
  const patch = buildDutyTimePatch({
    dutyOnAt: on,
    dutyOffAt: on + 24 * HOUR,
    status: 'off',
    findingApprovals: {
      OVER_14: { status: 'approved' },
      LOCATION: { status: 'approved' },
    },
    adminEdits: [],
  }, {
    dutyOnAt: on,
    dutyOffAt: off,
    over14: false,
    verification: {
      over14VerifiedAt: null,
      over14VerifiedBy: null,
      over14VerificationSource: null,
    },
    now: Date.parse('2026-09-09T12:00:00Z'),
    actorName: 'Jake Cambria',
    note: 'Corrected duty off from next morning to same-day evening.',
  });
  assert.equal(patch.dutyOffAt - patch.dutyOnAt, 12 * HOUR);
  assert.equal(patch.over14, false);
  assert.equal(patch.findingApprovals.OVER_14, undefined);
  assert.deepEqual(patch.findingApprovals.LOCATION, { status: 'approved' });
  assert.equal(patch.adminEdits[0].to.dutyOffAt, off);
  assert.match(patch.adminEdits[0].note, /Corrected duty off/);
});

test('an actual over-14 correction retains its approval disposition', () => {
  const on = 1_000_000;
  const approval = { status: 'approved', approvedByName: 'Jake Cambria' };
  const patch = buildDutyTimePatch({
    dutyOnAt: on,
    dutyOffAt: on + 24 * HOUR,
    status: 'off',
    findingApprovals: { OVER_14: approval },
  }, {
    dutyOnAt: on,
    dutyOffAt: on + 15 * HOUR,
    over14: true,
    verification: { over14VerifiedAt: 2_000_000 },
    now: 2_000_000,
    actorName: 'Jake Cambria',
  });
  assert.deepEqual(patch.findingApprovals.OVER_14, approval);
});

test('duty correction drawer shows saved versus after-save duration in a timezone-aware editor', async () => {
  const report = await source('src/AdminDutyReport.jsx');
  assert.match(report, /TzAwareDateTimeInput/);
  assert.match(report, /Currently saved duty/);
  assert.match(report, /After-save preview/);
  assert.match(report, /Outstanding findings reflect the currently saved timestamps/);
  assert.match(report, /This correction will clear the OVER_14 finding/);
});

