import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STANDARDS_NOTE,
  brokerPilotReport,
  buildBrokerCrewReports,
  evaluatePilot,
  normalizeStandards,
  summarizeDutyFlightHours,
} from '../src/pilot-safety.js';

const root = path.resolve(import.meta.dirname, '..');
const today = Date.UTC(2026, 8, 27);

function ymd(offsetDays) {
  return new Date(today + offsetDays * 86400000).toISOString().slice(0, 10);
}

function currency(overrides = {}) {
  const current = { lastDate: ymd(-60) };
  const later = { dueDate: ymd(200) };
  const na = { notApplicable: true };
  return {
    medical: { class: 'First', expirationDate: ymd(400) },
    groundOralGeneral293a: current,
    groundOral293a_CE525: current,
    groundOral293a_LR60: na,
    groundOral293a_SF50: na,
    groundOral293a_untyped: na,
    sim293b_CE525: current,
    sim293b_LR60: na,
    sim293b_SF50: na,
    sim293b_untyped: na,
    competencyCheck293: na,
    instrumentCheck297: current,
    lineCheck299: current,
    recurrentTraining351: current,
    crmTraining330: later,
    hazmatTraining: current,
    tfsspTraining: later,
    ...overrides,
  };
}

function logbook(overrides = {}) {
  return {
    hours: {
      totalTime: 4820,
      pic: 2310,
      sic: 900,
      multiEngine: 4100,
      turbine: 3600,
      night: 640,
      instrument: 410,
      last90Days: 48,
      last12Months: 312,
      timeInType: [{ type: 'Citation XLS+', hours: 860 }],
    },
    certificate: {
      level: 'ATP',
      instrument: true,
      multiEngine: true,
      typeRatings: ['Citation XLS+'],
    },
    drugAlcohol: { enrolled: true, enrolledDate: ymd(-400), programName: 'Company program' },
    internalNotes: 'Home address 1 Secret Street',
    certificateNumber: 'SHOULD-NOT-APPEAR',
    ...overrides,
  };
}

const pilot = { uid: 'pilot-1', name: 'Maxwell Hagberg' };

test('shipped standards are labeled as defaults and are not a Wyvern score', () => {
  const standards = normalizeStandards(null);
  assert.equal(standards.customized, false);
  assert.match(standards.sourceNote, /Not a WYVERN/);
  assert.equal(standards.sourceNote, DEFAULT_STANDARDS_NOTE);
  assert.equal(standards.hours.minimums.totalTime, 2500);
  assert.equal(standards.certificate.minimumLevel, 'Commercial');
});

test('a pilot who meets every default minimum is Meets Standard', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(rating.tier, 'meets');
  assert.equal(rating.tierLabel, 'Meets Standard');
  assert.ok(rating.score >= 85);
  assert.equal(rating.reasons.length, 1);
});

test('an expiring requirement with hours met is Caution', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ hazmatTraining: { dueDate: ymd(18) } }),
    todayMs: today,
  });
  assert.equal(rating.tier, 'caution');
  assert.match(rating.reasons.join(' '), /Hazmat|Hazardous materials/i);
  assert.match(rating.reasons.join(' '), /expiring soon/i);
});

test('short hours or an expired check does not meet the standard', () => {
  const short = evaluatePilot({
    pilot,
    logbook: logbook({ hours: { ...logbook().hours, turbine: 180 } }),
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(short.tier, 'doesNotMeet');
  assert.match(short.reasons.join(' '), /Turbine is 180/);

  const expired = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ lineCheck299: { dueDate: ymd(-5) } }),
    todayMs: today,
  });
  assert.equal(expired.tier, 'doesNotMeet');
  assert.match(expired.reasons.join(' '), /line check is expired/i);
});

test('raising a minimum changes the tier without a code change', () => {
  const standards = normalizeStandards({
    customized: true,
    hours: { minimums: { totalTime: 9000 }, required: { totalTime: true } },
  });
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency(),
    standards,
    todayMs: today,
  });
  assert.equal(rating.tier, 'doesNotMeet');
  assert.match(rating.reasons.join(' '), /9000/);
});

test('SIC is not failed for a PIC-only check', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ lineCheck299: { dueDate: ymd(-30) }, instrumentCheck297: { dueDate: ymd(-30) } }),
    role: 'SIC',
    todayMs: today,
  });
  assert.equal(rating.tier, 'meets');
  assert.equal(rating.requirements.find((item) => item.id === 'lineCheck299').included, false);
});

test('duty flight time fills a blank 90-day and 12-month figure', () => {
  const hours = logbook().hours;
  const rating = evaluatePilot({
    pilot,
    logbook: logbook({
      hours: { ...hours, last90Days: null, last12Months: null },
    }),
    currencyDoc: currency(),
    dutyHours: summarizeDutyFlightHours([
      { pilotUid: 'pilot-1', dutyOnAt: today - 10 * 86400000, flightTimeMs: 20 * 3600000, confirmStatus: 'self-attested' },
      { pilotUid: 'pilot-1', dutyOnAt: today - 200 * 86400000, flightTimeMs: 100 * 3600000, confirmStatus: 'self-attested' },
    ], 'pilot-1', today),
    todayMs: today,
  });
  const recent = rating.experience.find((line) => line.key === 'last90Days');
  const year = rating.experience.find((line) => line.key === 'last12Months');
  assert.equal(recent.source, 'duty');
  assert.equal(recent.actual, 20);
  assert.equal(year.actual, 120);
  assert.equal(rating.tier, 'meets');
});

test('certificate and medical on file are used when the logbook and currency are blank', () => {
  const book = logbook();
  book.certificate = { level: '', instrument: null, multiEngine: null, typeRatings: [] };
  const rating = evaluatePilot({
    pilot,
    logbook: book,
    currencyDoc: {},
    pilotDocs: [
      {
        docType: 'certificate',
        certType: 'Airline Transport Pilot',
        ratings: 'Instrument, Multi-engine, Citation XLS+',
        documentNumber: 'DO-NOT-SHOW-4491',
        dob: '1981-04-02',
        uploadedAt: 10,
      },
      {
        docType: 'medical',
        medicalClass: '1',
        expiration: ymd(300),
        documentNumber: 'MED-SECRET',
        uploadedAt: 11,
      },
    ],
    todayMs: today,
  });
  assert.equal(rating.certificate.level, 'ATP');
  assert.equal(rating.certificate.instrument, true);
  assert.equal(rating.certificate.multiEngine, true);
  assert.equal(rating.medical.class, 'First');
  assert.equal(rating.medical.statusLabel, 'Valid');
  assert.equal(rating.requirements.find((item) => item.id === 'certificate').status, 'current');
  assert.equal(rating.requirements.find((item) => item.id === 'medical').status, 'current');
});

test('the broker report keeps vetting facts and drops personal data', () => {
  const expiration = '2099-08-08';
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ medical: { class: 'First', expirationDate: expiration } }),
    pilotDocs: [{ docType: 'certificate', documentNumber: 'DO-NOT-SHOW-4491', dob: '1981-04-02', fileUrl: 'https://files.example/secret.pdf' }],
    todayMs: today,
  });
  const report = brokerPilotReport(rating, {
    operatorName: 'Skyway Aviation',
    operatorLegalName: 'Skyway Aviation Services',
    generatedAt: '2026-09-27T15:00:00.000Z',
    aircraftType: 'Citation XLS+',
  });
  const blob = JSON.stringify(report);
  for (const banned of [
    'DO-NOT-SHOW-4491',
    '1981-04-02',
    expiration,
    'Secret Street',
    'SHOULD-NOT-APPEAR',
    'fileUrl',
    'documentNumber',
    'certificateNumber',
    'homeAddress',
    'internalNotes',
  ]) {
    assert.equal(blob.includes(banned), false, banned);
  }
  assert.equal(report.pilotName, 'Maxwell Hagberg');
  assert.equal(report.medical.class, 'First');
  assert.equal(report.medical.status, 'Valid');
  assert.equal(report.certificate.level, 'ATP');
  assert.ok(report.hours.some((row) => row.label === 'Total time' && row.hours === '4820'));
  assert.ok(report.requirements.some((row) => /135\.293/.test(row.label)));
  assert.equal(report.generatedAt, '2026-09-27T15:00:00.000Z');
});

test('a trip share builds one report per seat and keeps the SIC on the SIC standard', () => {
  const reports = buildBrokerCrewReports({
    legs: [
      { pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+' },
      { pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+' },
    ],
    users: [
      { uid: 'pilot-1', name: 'Maxwell Hagberg' },
      { uid: 'pilot-2', name: 'Timothy Woods' },
    ],
    logbooksByUid: {
      'pilot-1': logbook(),
      'pilot-2': logbook(),
    },
    currenciesByUid: {
      'pilot-1': currency(),
      'pilot-2': currency({ lineCheck299: { dueDate: ymd(-30) } }),
    },
    operator: { name: 'Skyway Aviation', legalName: 'Skyway Aviation Services' },
    generatedAt: '2026-09-27T15:00:00.000Z',
    todayMs: today,
  });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].role, 'PIC');
  assert.equal(reports[0].tier, 'meets');
  assert.equal(reports[1].role, 'SIC');
  assert.equal(reports[1].tier, 'meets');
  assert.equal(JSON.stringify(reports).includes('Secret Street'), false);
});

test('the broker share and the email route are wired to the sanitized report', async () => {
  const tripPublic = await readFile(path.join(root, 'api/trip-public.js'), 'utf8');
  const email = await readFile(path.join(root, 'api/pilot-report-email.js'), 'utf8');
  const screen = await readFile(path.join(root, 'src/PilotSafety.jsx'), 'utf8');
  assert.match(tripPublic, /crewReportsForTrip/);
  assert.match(email, /buildPilotReportPdf/);
  assert.match(screen, /\/api\/pilot-report-email/);
});

test('rating editors live in Compliance / Currency', async () => {
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const admin = await readFile(path.join(root, 'src/AdminSettings.jsx'), 'utf8');
  const currency = await readFile(path.join(root, 'src/PilotCurrency.jsx'), 'utf8');
  const crewBoard = await readFile(path.join(root, 'src/CrewBoardV2.jsx'), 'utf8');
  assert.doesNotMatch(app, /id: 'pilot-rating'/);
  assert.match(app, /section === 'currency'/);
  assert.match(app, /roles: \['crew', 'sales', 'ops', 'admin'\]/);
  assert.doesNotMatch(admin, /PilotSafetySettings/);
  assert.match(currency, /IMPORT FROM WYVERN/);
  assert.match(currency, /RATING MINIMUMS/);
  assert.match(currency, /PilotSafetySettings/);
  assert.match(currency, /PilotSafetyLazy/);
  assert.match(currency, /COMPLIANCE · CURRENCY/);
  assert.match(crewBoard, /onOpenCompliance/);
  assert.doesNotMatch(crewBoard, /usePilotSafetyData\(currentUser, \{[^}]*trips/);
});
