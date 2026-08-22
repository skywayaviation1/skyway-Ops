import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  computeMedicalStatus,
  computeStatus,
} from '../src/currency-status.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFile(path.join(root, file), 'utf8');

test('Part 135 checks use calendar months and show their grace month', () => {
  const type = { intervalMonths: 12, graceMonths: 1 };
  const duringGrace = computeStatus(
    { lastDate: '2025-08-15' },
    null,
    Date.UTC(2026, 8, 15),
    type,
  );
  assert.equal(duringGrace.dueDate, '2026-08-31');
  assert.equal(duringGrace.graceDate, '2026-09-30');
  assert.notEqual(duringGrace.status, 'expired');

  const afterGrace = computeStatus(
    { lastDate: '2025-08-15' },
    null,
    Date.UTC(2026, 9, 1),
    type,
  );
  assert.equal(afterGrace.status, 'expired');
});

test('exact-day, explicit due, N/A, and non-expiring items remain supported', () => {
  const exact = computeStatus(
    { lastDate: '2026-01-01' },
    90,
    Date.UTC(2026, 2, 1),
    { interval: 90 },
  );
  assert.equal(exact.dueDate, '2026-04-01');

  const explicit = computeStatus(
    { dueDate: '2026-12-31' },
    null,
    Date.UTC(2026, 5, 1),
    { operatorDefined: true },
  );
  assert.equal(explicit.dueDate, '2026-12-31');

  assert.equal(computeStatus({ notApplicable: true }, null, Date.now(), {}).status, 'na');
  assert.equal(computeStatus({ present: true }, null, Date.now(), { noExpiration: true }).status, 'noExpiration');
  assert.equal(computeStatus({}, null, Date.now(), { noExpiration: true }).status, 'unknown');
});

test('medical uses the entered certificate expiration', () => {
  const result = computeMedicalStatus(
    { expirationDate: '2026-12-31' },
    Date.UTC(2026, 0, 1),
  );
  assert.equal(result.dueDate, '2026-12-31');
  assert.equal(result.status, 'current');
});

test('currency catalog includes core, conditional, and special-role requirements', async () => {
  const text = await source('src/firebase-currency.js');
  const requiredKeys = [
    // FAA baseline / Part 135 recent experience
    'takeoffLanding',
    'nightCurrency',
    'instrumentCurrency',
    'flightReview61_56',
    'sicQualification61_55',
    'picQualification135_243',
    'sicQualification135_245',
    // Universal/aircraft-specific Part 135 checks
    'groundOralGeneral293a',
    'sim293b_LR60',
    'sim293b_CE525',
    'sim293b_SF50',
    'sim293b_untyped',
    'instrumentCheck297',
    'lineCheck299',
    // Recurrent subjects / Subpart K
    'recurrentTraining351',
    'crmTraining330',
    'emergencyTraining',
    'windshearIcingTraining',
    'hazmatTraining',
    // Conditional check-pilot / instructor qualifications
    'checkPilotObservation339',
    'checkPilotFstdRecency337',
    'flightInstructorObservation340',
    'flightInstructorFstdRecency338',
  ];
  for (const key of requiredKeys) {
    assert.match(text, new RegExp(`['"]${key}['"]`), `${key} missing from currency catalog`);
  }

  assert.match(
    text,
    /key: 'recurrentTraining351'[\s\S]*?intervalMonths: 12/,
    '§§135.343/351 must be 12 calendar months, not six months',
  );
  assert.match(
    text,
    /key: 'instrumentCheck297'[\s\S]*?intervalMonths: 6/,
    '§135.297 must remain a six-calendar-month PIC IFR check',
  );
  assert.match(
    text,
    /key: 'hazmatTraining'[\s\S]*?intervalMonths: 24/,
    '§135.505 hazmat training must use 24 months',
  );
  assert.match(text, /applicability:/, 'conditional requirements need applicability text');
  assert.match(text, /citation:/, 'requirements need regulatory citations');
});

test('currency UI exposes applicability and calendar-month cadence', async () => {
  const text = await source('src/PilotCurrency.jsx');
  assert.match(text, /Applies:/);
  assert.match(text, /calendar-month cadence/);
  assert.match(text, /approved training program and OpSpecs remain controlling/);
  assert.match(text, /Grace through/);
});
