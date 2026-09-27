import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { brokerPilotReport, evaluatePilot } from '../src/pilot-safety.js';
import { buildWyvernHoursPush, wyvernOutboundStatus, WYVERN_HOURS_SCHEMA } from '../src/wyvern-outbound.js';
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
  assert.equal(isActiveWyvernStatus('Active on Roster'), true);
  assert.equal(isActiveWyvernStatus('Full Time'), false);
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

test('names match across case, a missing middle name, and a repeated surname', () => {
  const crew = [
    { uid: 'jordan', name: 'Jordan Hale', email: 'jordan@example.test', approved: true },
    { uid: 'mina', name: 'Mina Quinn Pell', email: 'mina@example.test', approved: true },
    { uid: 'ruth', name: 'Mina Ruth Pell', email: 'ruth@example.test', approved: true },
  ];
  assert.equal(matchWyvernPilot({ name: 'JORDAN hale', active: true }, crew, {}).user.uid, 'jordan');
  assert.equal(matchWyvernPilot({ name: 'Mina Pell', active: true }, [crew[1]], {}).user.uid, 'mina');
  assert.equal(matchWyvernPilot({ name: 'Mina Pell Pell', active: true }, [crew[1]], {}).user.uid, 'mina');
  const ambiguous = matchWyvernPilot({ name: 'Mina Pell', active: true }, crew, {});
  assert.equal(ambiguous.user, null);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(matchWyvernPilot({ name: 'Mina Alan Pell', active: true }, [crew[1]], {}).user, null);
});

test('the active-pilot JSON maps hours, intervals, and warnings without storing a certificate number', () => {
  const parsed = parseWyvernText(JSON.stringify([{
    wyvern_name: 'jordan hale',
    roster_status: 'Active on Roster',
    pass_status: 'Available for PASS',
    employment_status: 'Full Time',
    pilot_base: 'Sample Base',
    date_of_hire: '2019-04-01',
    notes: 'DO-NOT-IMPORT-NOTE',
    capture_complete: false,
    certificate: {
      number: 'DO-NOT-KEEP-77',
      type: 'Commercial / Instrument',
      fixed_wing_ratings: 'Airplane Multiengine Land',
      issuing_country: 'United States',
      issue_date: '2018-06-01',
      last_faa_verification: '2024-02-02',
    },
    medical: { class: 'Class 1', check_date: '2024-03-10' },
    background: {
      faa_background_check_date: '2024-01-02',
      aid_records: 'No Reports on File for this airman',
      eis_records: 'Enforcement case SAMPLE-99 remains open',
    },
    experience: {
      last_updated: '2024-08-01',
      total: 4000,
      pic: 5000,
      turbine: 3000,
      instrument: 800,
      last_90_days: 40,
      last_12_months: 400,
      fixed_wing: { total: 3900, pic: 4000, '90_days': 30 },
      rotor_wing: { hours: { total: 100 }, landings: { '90_days': 2 } },
      single_engine: { total: 200 },
      multi_engine: { total: 3700, pic: 3800, '90_days': 12, '12_months': 180 },
      landings: { '90_days': 10, '12_months': 40 },
      by_type: [
        { type: 'CE-525, CE-525S', total: 900, pic: 1200 },
        { type: 'LR-60', total: 9000, pic: 10 },
      ],
      new_hire_adjustment: { hours_12_months_prior: 50 },
    },
    checks: {
      ipc: { date: '2024-01-15', expires: null, status: 'Current' },
      line_check: { date: '2024-01-15', expires: '2024-09-01', status: 'Current' },
      international_procedures: { date: '2023-05-01', expires: null, status: 'Current' },
      indoctrination: { date: '2020-05-01', expires: null, status: 'Current' },
      uprt: { date: null, expires: null, status: 'UPRT Not Verified' },
    },
    type_ratings: [{
      type: 'CE-525, CE-525S',
      verified_status: null,
      duty_assignment: 'PIC',
      aircraft_specific_check: { date: '2024-02-01', expires: null, status: 'Current' },
      recurrent_training: { date: '2024-06-01', expires: null, status: 'Current' },
      simulator_training: {
        date: '2024-06-02', expires: null, status: 'Current', sim_type: 'Full Motion', vendor: 'Sample Sim Co',
      },
      enhanced_pilot_training: { date: null, expires: null, status: 'EPT Not Verified' },
    }, {
      type: 'LR-60',
      verified_status: null,
      duty_assignment: 'PIC',
      recurrent_training: { date: '2023-11-01', expires: null, status: 'Current' },
      simulator_training: {
        date: '2023-11-01', expires: null, status: 'Current', sim_type: 'Full Motion', vendor: 'Sample Sim Co',
      },
    }],
    status_flags: [],
  }, {
    wyvern_name: 'Nora Pell',
    roster_status: 'Active on Roster',
    employment_status: 'Full Time',
    certificate: { type: 'Student Pilot' },
    status_flags: ['Type Not Verified'],
    type_ratings: [{ type: 'CE-525, CE-525S', verified_status: 'Type Not Verified', duty_assignment: 'SIC' }],
  }]), 'active-pilots.json');

  assert.equal(parsed.records.length, 2);
  const record = parsed.records[0];
  assert.equal(record.active, true);
  assert.equal(record.background.employment, 'Full Time');
  assert.equal(record.hours.totalTime, 4000);
  assert.equal(record.hours.pic, 5000);
  assert.equal(record.hours.fixedWing, 3900);
  assert.equal(record.hours.rotorWing, 100);
  assert.equal(record.hours.singleEngine, 200);
  assert.equal(record.hours.multiEngine, 3700);
  assert.equal(record.hours.multiEngine90, 12);
  assert.equal(record.hours.last90Days, 40);
  assert.equal(record.hours.landings, undefined);
  assert.equal(record.hoursAsOf, '2024-08-01');
  assert.deepEqual(record.certificate.typeRatings, ['CE-525, CE-525S', 'LR-60']);
  assert.equal(record.certificate.typeRatings.length, 2);
  assert.equal(record.certificate.level, 'Commercial');
  assert.equal(record.certificate.instrument, true);
  assert.equal(record.certificate.multiEngine, true);
  assert.equal(record.certificate.country, 'United States');
  assert.equal(record.certificate.typeVerified, true);
  assert.equal(record.position, 'PIC');
  assert.equal(record.medical.class, 'First');
  assert.equal(record.medical.issuedDate, '2024-03-10');
  assert.equal(record.medical.expirationDate, '2025-03-31');
  assert.equal(record.checks.instrumentCheck297.completedOn, '2024-01-15');
  assert.equal(record.checks.instrumentCheck297.dueOn, '2024-07-31');
  assert.equal(record.checks.lineCheck299.dueOn, '2024-09-01');
  assert.equal(record.checks.basicIndoctrination.completedOn, '2020-05-01');
  assert.equal(record.checks.basicIndoctrination.dueOn, '');
  assert.equal(record.checks.internationalProcedures.completedOn, '2023-05-01');
  assert.equal(record.checks.internationalProcedures.dueOn, '');
  assert.equal(record.checks.uprt, undefined);
  assert.equal(record.checks.recurrentTraining351.completedOn, '2023-11-01');
  assert.equal(record.checks.recurrentTraining351.dueOn, '2024-11-30');
  assert.equal(record.checks.sim293b_CE525.dueOn, '2025-06-30');
  assert.equal(record.checks.sim293b_CE525.notes, 'Full Motion · Sample Sim Co');
  assert.equal(/fixed[-\s]?base/i.test(record.checks.sim293b_CE525.notes), false);
  assert.equal(record.checks.groundOral293a_CE525.completedOn, '2024-02-01');
  assert.equal(record.background.accident, false);
  assert.equal(record.background.enforcement, true);
  assert.equal(record.newHireHours, 50);
  assert.equal(record.warnings.includes('PIC time is greater than total time'), true);
  assert.equal(record.warnings.includes('Fixed-wing PIC time is greater than fixed-wing total time'), true);
  assert.equal(record.warnings.includes('Multi-engine PIC time is greater than multi-engine total time'), true);
  assert.equal(record.warnings.includes('PIC time in type is greater than total time in type'), true);
  assert.equal(record.warnings.includes('Time in type is greater than total time'), true);
  assert.equal(record.warnings.includes('Wyvern marked this capture incomplete'), true);
  const stored = JSON.stringify(record);
  assert.equal(stored.includes('DO-NOT-KEEP-77'), false);
  assert.equal(stored.includes('DO-NOT-IMPORT-NOTE'), false);
  assert.equal(stored.includes('SAMPLE-99'), false);

  const other = parsed.records[1];
  assert.equal(other.certificate.level, '');
  assert.equal(other.certificate.typeVerified, false);
  assert.equal(other.warnings.includes('Certificate type was not recognized'), true);
  assert.deepEqual(other.certificate.typeRatings, ['CE-525, CE-525S']);

  const plan = planWyvernImport(parsed.records, {
    users: [{ uid: 'jordan', name: 'Jordan Hale', email: 'jordan@example.test', approved: true }],
    standards: { positions: { PIC: { ipcMonths: 9 } } },
  });
  const row = plan.rows.find((entry) => entry.record.name === 'jordan hale');
  assert.equal(row.bucket, 'matched');
  assert.equal(row.include, true);
  assert.equal(row.record.checks.instrumentCheck297.dueOn, '2024-10-31');
  assert.equal(row.record.checks.lineCheck299.dueOn, '2024-09-01');

  const draft = wyvernLogbookDraft(null, record, { uid: 'jordan', pilotName: 'Jordan Hale', now: 20 });
  const blob = JSON.stringify(draft);
  assert.equal(blob.includes('DO-NOT-KEEP-77'), false);
  assert.equal(blob.includes('DO-NOT-IMPORT-NOTE'), false);
  assert.equal(blob.includes('SAMPLE-99'), false);
  assert.equal(draft.certificate.country, 'United States');
  assert.equal(draft.certificate.typeVerified, true);
  assert.equal(draft.background.employment, 'Full Time');
  assert.equal(draft.background.accident, false);
  assert.equal(draft.background.enforcement, true);
  assert.equal(draft.hours.landings, null);
  assert.equal(draft.wyvern.passStatus, 'Available for PASS');
  assert.equal(draft.wyvern.base, 'Sample Base');
  assert.equal(draft.wyvern.hiredOn, '2019-04-01');
  assert.equal(draft.wyvern.newHireHours, 50);
  assert.equal(draft.wyvern.faaVerifiedOn, '2024-02-02');
  const currency = wyvernCurrencyPatch(null, record, 20);
  assert.equal(currency.medical.lastDate, '2024-03-10');
  assert.equal(currency.medical.expirationDate, '2025-03-31');
  assert.equal(currency.sim293b_CE525.notes, 'Full Motion · Sample Sim Co');
  assert.equal(currency.basicIndoctrination.lastDate, '2020-05-01');
  assert.equal(currency.basicIndoctrination.dueDate, undefined);
  assert.equal(JSON.stringify(currency).includes('SAMPLE-99'), false);
});

test('a future Wyvern hours push is shaped but not connected', () => {
  const status = wyvernOutboundStatus();
  assert.equal(status.ready, false);
  assert.equal(status.fmsUpdateApi.available, false);
  assert.equal(status.quarterlyExcelExport.available, false);
  const payload = buildWyvernHoursPush({
    pilotName: 'Ada Lovelace',
    baseline: { asOf: '2024-01-01', source: 'Wyvern' },
    hours: { totalTime: 10, pic: 4, timeInType: [{ type: 'CE-525', hours: 6, picHours: 2 }] },
  });
  assert.equal(payload.schema, WYVERN_HOURS_SCHEMA);
  assert.equal(payload.ready, false);
  assert.equal(payload.hours.total, 10);
  assert.equal(payload.hours.byType[0].pic, 2);
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
