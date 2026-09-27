import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { brokerPilotReport, evaluatePilot } from '../src/pilot-safety.js';
import {
  findWyvernConflicts,
  isActiveWyvernStatus,
  matchWyvernPilot,
  parseWyvernText,
  planWyvernImport,
  wyvernCurrencyPatch,
  wyvernLogbookDraft,
} from '../src/wyvern-import.js';

const root = path.resolve(import.meta.dirname, '..');

const users = [
  { uid: 'ada', name: 'Ada Lovelace', email: 'ada@example.test', approved: true },
  { uid: 'grace', name: 'Grace Hopper', email: 'grace@example.test', approved: true },
  { uid: 'sam-1', name: 'Sam Lee', email: 'sam.one@example.test', approved: true },
  { uid: 'sam-2', name: 'Sam Lee', email: 'sam.two@example.test', approved: true },
  { uid: 'cade', name: 'Cade A. Kaftel', email: 'someone-else@example.test', approved: true },
];

test('active status accepts the words an ACES export is likely to use', () => {
  assert.equal(isActiveWyvernStatus('Active'), true);
  assert.equal(isActiveWyvernStatus('Active Pilot'), true);
  assert.equal(isActiveWyvernStatus(true), true);
  assert.equal(isActiveWyvernStatus('Inactive'), false);
  assert.equal(isActiveWyvernStatus(''), false);
  assert.equal(isActiveWyvernStatus(undefined), false);
});

test('JSON aliases become hours, a medical, and Part 135 checks', () => {
  const parsed = parseWyvernText(JSON.stringify({
    pilots: [{
      pilotName: 'Hopper, Grace',
      emailAddress: 'grace@example.test',
      phone: '(555) 010-0100',
      wyvernId: 'ACES-SAMPLE-9',
      status: 'Active',
      certificate: {
        grade: 'Airline Transport Pilot',
        ratings: 'Instrument, Multi-engine',
        typeRatings: ['CE-525'],
        certificateNumber: 'DO-NOT-IMPORT-9',
      },
      medical: { class: '1st Class', expiration: '06/30/2027' },
      flightHours: {
        totalTime: '4,200',
        PIC: 1800,
        turbine: 1600,
        asOf: '2026-09-01',
        timeInType: [{ aircraft: 'Citation CJ3', hours: 900 }],
      },
      training: [
        { name: '§135.293 written/oral competency', completed: '2026-01-15', due: '2027-01-31' },
        { name: '§135.297 IPC', completedOn: '2026-02-01', dueDate: '2026-08-31' },
        { code: '135.330', name: 'CRM', completed: '2026-03-01', due: '2027-03-31' },
      ],
      documents: [
        { type: 'Passport', documentNumber: 'DO-NOT-IMPORT-PPT', expiry: '2030-01-01' },
      ],
    }],
  }));
  assert.equal(parsed.records.length, 1);
  const record = parsed.records[0];
  assert.equal(record.name, 'Grace Hopper');
  assert.equal(record.active, true);
  assert.equal(record.hours.totalTime, 4200);
  assert.equal(record.hours.pic, 1800);
  assert.equal(record.hoursAsOf, '2026-09-01');
  assert.equal(record.certificate.level, 'ATP');
  assert.equal(record.certificate.instrument, true);
  assert.equal(record.certificate.multiEngine, true);
  assert.deepEqual(record.certificate.typeRatings, ['CE-525']);
  assert.equal(record.medical.class, 'First');
  assert.equal(record.medical.expirationDate, '2027-06-30');
  assert.equal(record.checks.groundOralGeneral293a.completedOn, '2026-01-15');
  assert.equal(record.checks.instrumentCheck297.dueOn, '2026-08-31');
  assert.equal(record.checks.crmTraining330.completedOn, '2026-03-01');
  assert.equal(record.checks.sim293b_CE525, undefined);
  const draft = wyvernLogbookDraft(null, record, { uid: 'grace', pilotName: 'Grace Hopper', now: 100 });
  const blob = JSON.stringify(draft);
  assert.equal(blob.includes('DO-NOT-IMPORT'), false);
  assert.equal(blob.includes('555'), false);
  assert.equal(draft.wyvern.source, 'Wyvern');
  assert.equal(draft.wyvern.id, 'ACES-SAMPLE-9');
  assert.equal(draft.wyvern.importedAt, 100);
  const currency = wyvernCurrencyPatch(null, record, 100);
  assert.equal(currency.medical.class, 'First');
  assert.equal(currency.medical.expirationDate, '2027-06-30');
  assert.equal(currency.instrumentCheck297.lastDate, '2026-02-01');
  assert.equal(currency.wyvernSource, 'Wyvern');
  assert.equal(JSON.stringify(currency).includes('DO-NOT-IMPORT'), false);
});

test('CSV columns and US dates map onto the same record', () => {
  const parsed = parseWyvernText([
    'Pilot,Email,Status,Total Time,Turbine,135.297 Completed,135.297 Due',
    'Ada Lovelace,ada@example.test,Active,"4,200",1800,01/15/2026,07/31/2026',
    'Grace Hopper,grace@example.test,Inactive,9000,4000,,',
  ].join('\n'), 'pilots.csv');
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].hours.totalTime, 4200);
  assert.equal(parsed.records[0].checks.instrumentCheck297.completedOn, '2026-01-15');
  assert.equal(parsed.records[0].checks.instrumentCheck297.dueOn, '2026-07-31');
  assert.equal(parsed.records[1].active, false);
});

test('matching prefers email, then name, then a stored Wyvern ID', () => {
  const byEmail = matchWyvernPilot({
    name: 'Grace Hopper',
    email: 'ada@example.test',
    active: true,
  }, users, {});
  assert.equal(byEmail.user.uid, 'ada');
  assert.equal(byEmail.reason, 'email');

  const byName = matchWyvernPilot({ name: 'Hopper, Grace', email: '', active: true }, users, {});
  assert.equal(byName.user.uid, 'grace');
  assert.equal(byName.reason, 'name');

  const middle = matchWyvernPilot({ name: 'Cade Kaftel', email: '', active: true }, users, {});
  assert.equal(middle.user.uid, 'cade');
  assert.equal(middle.reason, 'name');

  const ambiguous = matchWyvernPilot({ name: 'Sam Lee', email: '', active: true }, users, {});
  assert.equal(ambiguous.user, null);
  assert.equal(ambiguous.ambiguous, true);

  const byId = matchWyvernPilot({
    name: 'Someone New',
    email: '',
    wyvernId: 'ACES-SAMPLE-1',
    active: true,
  }, users, { ada: { wyvern: { id: 'ACES-SAMPLE-1' } } });
  assert.equal(byId.user.uid, 'ada');
  assert.equal(byId.reason, 'wyvern id');
});

test('only active pilots are planned, and conflicts are the values that would change', () => {
  const parsed = parseWyvernText(JSON.stringify({
    pilots: [
      { name: 'Grace Hopper', email: 'ada@example.test', status: 'Active', flightHours: { turbine: 200 } },
      { name: 'Grace Hopper', email: 'grace@example.test', status: 'Terminated', flightHours: { turbine: 50 } },
      { name: 'Nora Pell', email: 'nora@example.test', status: 'Active', flightHours: { totalTime: 10 } },
    ],
  }));
  const plan = planWyvernImport(parsed.records, {
    users,
    logbooks: { ada: { hours: { turbine: 100 }, certificate: { typeRatings: [] } } },
    currencies: {},
  });
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].record.name, 'Grace Hopper');
  const ada = plan.rows.find((row) => row.record.email === 'ada@example.test');
  assert.equal(ada.bucket, 'conflict');
  assert.equal(ada.conflicts.some((item) => item.field === 'turbine'), true);
  assert.equal(ada.conflicts.some((item) => item.field === 'Pilot name'), true);
  const nora = plan.rows.find((row) => row.record.name === 'Nora Pell');
  assert.equal(nora.bucket, 'unmatched');
  assert.equal(nora.include, false);
});

test('a re-import updates the same hours and does not duplicate time in type', () => {
  const record = parseWyvernText(JSON.stringify({
    pilots: [{
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      status: 'Active',
      wyvernId: 'ACES-SAMPLE-3',
      flightHours: {
        turbine: 500,
        timeInType: [{ type: 'Citation CJ3', hours: 120 }],
      },
    }],
  })).records[0];
  const existing = {
    uid: 'ada',
    pilotName: 'Ada Lovelace',
    hours: {
      totalTime: 4000,
      turbine: 100,
      timeInType: [
        { type: 'Citation CJ3', hours: 80 },
        { type: 'Citation XLS+', hours: 40 },
      ],
    },
    wyvern: { id: 'ACES-SAMPLE-3', source: 'Wyvern', importedAt: 1 },
  };
  const first = wyvernLogbookDraft(existing, record, { uid: 'ada', now: 50 });
  const second = wyvernLogbookDraft(first, record, { uid: 'ada', now: 60 });
  assert.equal(second.hours.turbine, 500);
  assert.equal(second.hours.totalTime, 4000);
  assert.equal(second.hours.timeInType.length, 2);
  assert.equal(second.hours.timeInType.find((entry) => entry.type === 'Citation CJ3').hours, 120);
  assert.equal(second.hours.timeInType.find((entry) => entry.type === 'Citation XLS+').hours, 40);
  assert.equal(second.wyvern.importedAt, 60);
  assert.equal(second.wyvern.id, 'ACES-SAMPLE-3');
  const again = findWyvernConflicts(second, null, record, users[0]);
  assert.equal(again.some((item) => item.field === 'turbine'), false);
});

test('a currency re-import keeps admin notes and refreshes the Wyvern dates', () => {
  const record = {
    medical: { class: 'Second', expirationDate: '2027-01-31' },
    checks: { lineCheck299: { completedOn: '2026-04-01', dueOn: '2027-04-30' } },
  };
  const existing = {
    medical: { class: 'First', expirationDate: '2026-01-31', notes: 'Keep this note' },
    lineCheck299: { lastDate: '2025-04-01', notes: 'Checkride remarks' },
  };
  const patch = wyvernCurrencyPatch(existing, record, 80);
  assert.equal(patch.medical.class, 'Second');
  assert.equal(patch.medical.notes, 'Keep this note');
  assert.equal(patch.lineCheck299.lastDate, '2026-04-01');
  assert.equal(patch.lineCheck299.dueDate, '2027-04-30');
  assert.equal(patch.lineCheck299.notes, 'Checkride remarks');
  const again = wyvernCurrencyPatch(patch, record, 90);
  assert.equal(again.lineCheck299.lastDate, '2026-04-01');
  assert.equal(again.wyvernImportedAt, 90);
});

test('the broker report still omits Wyvern import metadata and contact data', () => {
  const record = parseWyvernText(JSON.stringify({
    pilots: [{
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: '(555) 010-0199',
      status: 'Active',
      wyvernId: 'ACES-SAMPLE-4',
      certificate: { grade: 'ATP', certificateNumber: 'DO-NOT-IMPORT-4', instrumentRating: true, multiEngine: true },
      medical: { class: 'First', expiration: '2027-06-30' },
      flightHours: { totalTime: 5000, pic: 3000, multiEngine: 4000, turbine: 3000, night: 400, instrument: 200, last90Days: 40, last12Months: 400 },
    }],
  })).records[0];
  const draft = wyvernLogbookDraft(null, record, { uid: 'ada', pilotName: 'Ada Lovelace', now: 5 });
  const currency = wyvernCurrencyPatch(null, record, 5);
  const rating = evaluatePilot({
    pilot: { uid: 'ada', name: 'Ada Lovelace' },
    logbook: draft,
    currencyDoc: currency,
    todayMs: Date.UTC(2026, 8, 27),
  });
  const report = brokerPilotReport(rating, { operatorName: 'Example Air', generatedAt: '2026-09-27T00:00:00.000Z' });
  const blob = JSON.stringify(report);
  for (const banned of ['ACES-SAMPLE-4', '555', 'DO-NOT-IMPORT', 'ada@example.test', 'wyvernId']) {
    assert.equal(blob.includes(banned), false, banned);
  }
  assert.equal(Object.hasOwn(report, 'wyvern'), false);
  assert.equal(report.certificate.level, 'ATP');
  assert.equal(report.medical.class, 'First');
});

test('the sample preview file is fictitious and classifies active pilots', async () => {
  const text = await readFile(path.join(root, 'preview/fixtures/wyvern-sample.json'), 'utf8');
  assert.equal(text.includes('Fictitious'), true);
  const parsed = parseWyvernText(text, 'wyvern-sample.json');
  const plan = planWyvernImport(parsed.records, {
    users: [
      { uid: 'cade', name: 'Cade Kaftel', email: 'cade@flyskyway.com', approved: true },
      { uid: 'max', name: 'Maxwell Hagberg', email: 'maxwell@flyskyway.com', approved: true },
      { uid: 'tim', name: 'Timothy Woods', email: 'timothy@flyskyway.com', approved: true },
      { uid: 'mel', name: 'Melissa Rippy', email: 'melissa@flyskyway.com', approved: true },
    ],
    logbooks: {},
    currencies: {},
  });
  assert.equal(plan.rows.length, 5);
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.rows.find((row) => row.record.name === 'Timothy Woods').match.reason, 'name');
  assert.equal(plan.rows.find((row) => row.record.name === 'Nora Pell').bucket, 'unmatched');
  assert.equal(JSON.stringify(plan).includes('DO-NOT-IMPORT'), false);
});

test('the bulk script refuses to touch Firestore without a service account', () => {
  const result = spawnSync(process.execPath, [
    'scripts/import-wyvern.mjs',
    'preview/fixtures/wyvern-sample.json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FIREBASE_SERVICE_ACCOUNT_JSON: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.match(result.stderr, /No database changes were made/);
});
