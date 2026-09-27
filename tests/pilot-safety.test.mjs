import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STANDARDS_NOTE,
  brokerPilotReport,
  brokerWithholdReasons,
  buildBrokerCrewReports,
  evaluatePilot,
  normalizeCertificateLevel,
  normalizeLogbook,
  normalizeStandards,
  parseAirmanCertificate,
  picAtpWarning,
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
    medical: { class: 'First', expirationDate: ymd(400), lastDate: ymd(-40) },
    basicIndoctrination: current,
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
      fixedWing: 4700,
      rotorWing: 0,
      multiEngine: 4100,
      multiEngine90: 40,
      multiEngine12: 200,
      turbine: 3600,
      night: 640,
      instrument: 410,
      last90Days: 48,
      last12Months: 312,
      timeInType: [{ type: 'Citation XLS+', hours: 860, picHours: 400 }],
    },
    certificate: {
      level: 'ATP',
      instrument: true,
      multiEngine: true,
      typeRatings: ['Citation XLS+'],
      typeVerified: true,
      country: 'United States',
    },
    background: { employment: 'Full Time', accident: false, enforcement: false },
    drugAlcohol: { enrolled: true, enrolledDate: ymd(-400), programName: 'Company program' },
    internalNotes: 'Home address 1 Secret Street',
    certificateNumber: 'SHOULD-NOT-APPEAR',
    ...overrides,
  };
}

const pilot = { uid: 'pilot-1', name: 'Maxwell Hagberg' };

test('shipped standards are the Wyvern Registered Standard by position', () => {
  const standards = normalizeStandards(null);
  assert.equal(standards.customized, false);
  assert.match(standards.sourceNote, /Registered Standard/);
  assert.equal(standards.sourceNote, DEFAULT_STANDARDS_NOTE);
  assert.equal(standards.positions.PIC.hours.totalTime, 2500);
  assert.equal(standards.positions.SIC.hours.totalTime, 1000);
  assert.equal(standards.positions.PIC.hours.pic, 1000);
  assert.equal(standards.positions.SIC.hours.pic, 0);
  assert.equal(standards.positions.PIC.hours.fixedWing, 2000);
  assert.equal(standards.positions.SIC.hours.fixedWing, 1000);
  assert.equal(standards.positions.PIC.hours.multiEngine, 1000);
  assert.equal(standards.positions.SIC.hours.multiEngine, 50);
  assert.equal(standards.positions.PIC.hours.multiEngine12, 150);
  assert.equal(standards.positions.SIC.hours.multiEngine12, 50);
  assert.equal(standards.positions.PIC.hours.multiEngine90, 30);
  assert.equal(standards.positions.SIC.hours.multiEngine90, 30);
  assert.equal(standards.positions.PIC.hours.instrument, 100);
  assert.equal(standards.positions.SIC.hours.instrument, 50);
  assert.equal(standards.positions.PIC.hours.turbine, 1000);
  assert.equal(standards.positions.SIC.hours.turbine, 30);
  assert.equal(standards.positions.PIC.hours.timeInType, 200);
  assert.equal(standards.positions.SIC.hours.timeInType, 30);
  assert.equal(standards.positions.PIC.hours.picTimeInType, 100);
  assert.equal(standards.positions.SIC.hours.picTimeInType, 0);
  assert.equal(standards.positions.PIC.medicalClass, 'First');
  assert.equal(standards.positions.SIC.medicalClass, 'Second');
  assert.equal(standards.positions.PIC.medicalMonths, 12);
  assert.equal(standards.positions.SIC.medicalMonths, 12);
  assert.equal(standards.positions.PIC.atpCertificate, true);
  assert.equal(standards.positions.SIC.atpCertificate, false);
  assert.equal(standards.positions.PIC.indoctrination, true);
  assert.equal(standards.positions.SIC.indoctrination, true);
  assert.equal(standards.positions.PIC.lineCheck, true);
  assert.equal(standards.positions.SIC.lineCheck, false);
  assert.equal(standards.positions.PIC.lineCheckMonths, 7);
  assert.equal(standards.positions.PIC.ipc, true);
  assert.equal(standards.positions.SIC.ipc, false);
  assert.equal(standards.positions.PIC.ipcMonths, 6);
  assert.equal(standards.positions.PIC.maxActiveTypes, 2);
  assert.equal(standards.positions.SIC.maxActiveTypes, 2);
  assert.equal(standards.positions.PIC.confirmedType, true);
  assert.equal(standards.positions.SIC.confirmedType, false);
  assert.equal(standards.positions.PIC.aircraftMonths, 12);
  assert.equal(standards.positions.SIC.motionSimulator, true);
  assert.equal(standards.criteriaName, 'Wyvern Registered Standard');
});

test('a pilot who meets every default minimum qualifies for PIC and SIC', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(rating.tier, 'meets');
  assert.equal(rating.tierLabel, 'Meets');
  assert.deepEqual(rating.qualifiesFor, ['PIC', 'SIC']);
  assert.equal(rating.positions.PIC.tier, 'meets');
  assert.equal(rating.positions.SIC.tier, 'meets');
  assert.ok(rating.score >= 85);
  assert.equal(rating.reasons.length, 1);
  assert.match(rating.reasons[0], /PIC and SIC Registered Standard/);
});

test('an expiring requirement with hours met is caution and still meets the chip', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ recurrentTraining351: { dueDate: ymd(18), lastDate: ymd(-300) } }),
    todayMs: today,
  });
  assert.equal(rating.tier, 'caution');
  assert.equal(rating.tierLabel, 'Meets');
  assert.equal(rating.requirements.find((item) => item.id === 'recurrentTraining351').statusLabel, 'Expires in 30 Days');
  assert.match(rating.reasons.join(' '), /Expires in 30 Days/);
});

test('short hours fail PIC and can still qualify SIC, and an expired PIC line check fails PIC', () => {
  const short = evaluatePilot({
    pilot,
    logbook: logbook({ hours: { ...logbook().hours, turbine: 180 } }),
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(short.positions.PIC.tier, 'doesNotMeet');
  assert.equal(short.positions.SIC.tier, 'meets');
  assert.deepEqual(short.qualifiesFor, ['SIC']);
  const turbine = short.gapAnalysis.find((row) => row.label === 'Turbine');
  assert.equal(turbine.picMet, false);
  assert.equal(turbine.sicMet, true);
  assert.match(turbine.pilotValue, /180/);

  const expired = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({ lineCheck299: { dueDate: ymd(-5) } }),
    role: 'PIC',
    todayMs: today,
  });
  assert.equal(expired.tier, 'doesNotMeet');
  assert.match(expired.reasons.join(' '), /Line check is Expired/);
});

test('raising a PIC minimum changes that position without a code change', () => {
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
  assert.equal(rating.positions.PIC.tier, 'doesNotMeet');
  assert.equal(rating.positions.SIC.tier, 'meets');
  const total = rating.gapAnalysis.find((row) => row.label === 'Total time');
  assert.equal(total.picCriteria, '9000');
  assert.equal(total.picMet, false);
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
  assert.equal(rating.medical.statusLabel, 'Current');
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
  assert.equal(report.crew[0].pilotName, 'Maxwell Hagberg');
  assert.equal(report.crew[0].rows[0].label, 'ATP Certificate');
  assert.equal(report.crew[0].rows[0].value, 'ATP');
  assert.equal(report.crew[0].certificateType, 'Airline Transport Pilot');
  assert.equal(report.crew[0].typeRating, 'Citation XLS+');
  assert.equal(report.crew[0].country, undefined);
  assert.equal(report.crew[0].rows.find((row) => row.label === 'Medical').value, 'Class 1');
  assert.equal(report.crew[0].rows.find((row) => row.label === 'Total Flight Time').value, '4820 Hrs');
  assert.equal(report.crew[0].rows.find((row) => row.label === 'Fixed-Wing Time').value, '4700 / 2310 Hrs');
  assert.equal(report.crew[0].rows.find((row) => row.label === 'Time in Type').value, '860 / 400 Hrs');
  assert.equal(report.crew[0].rows.some((row) => row.label === 'Line Check'), false);
  assert.equal(report.crew[0].rows.some((row) => row.label === 'Employment Status'), false);
  assert.equal(report.generatedAt, '2026-09-27T15:00:00.000Z');
  assert.equal(report.gapAnalysis, undefined);
  assert.equal(report.chips, undefined);
  assert.equal(blob.includes('Does Not Meet'), false);
});

test('checks and training do not gate the broker report', () => {
  const rating = evaluatePilot({
    pilot,
    logbook: logbook(),
    currencyDoc: currency({
      lineCheck299: { dueDate: ymd(-12) },
      instrumentCheck297: { dueDate: ymd(-12) },
    }),
    todayMs: today,
  });
  assert.equal(rating.positions.PIC.tier, 'doesNotMeet');
  const report = brokerPilotReport(rating, { generatedAt: '2026-09-27T15:00:00.000Z' });
  assert.equal(report.crew[0].role, 'Pilot-in-Command');
  assert.equal(brokerWithholdReasons(rating).some((line) => /Line check|Instrument proficiency|training/i.test(line)), false);
});

test('a crew that does not meet is omitted from the broker report', () => {
  const short = evaluatePilot({
    pilot,
    logbook: logbook({ hours: { ...logbook().hours, turbine: 10, timeInType: [{ type: 'Citation XLS+', hours: 10, picHours: 0 }] } }),
    currencyDoc: currency({ lineCheck299: { dueDate: ymd(-12) } }),
    todayMs: today,
  });
  assert.equal(short.positions.PIC.tier, 'doesNotMeet');
  assert.equal(short.positions.SIC.tier, 'doesNotMeet');
  assert.equal(brokerPilotReport(short, { generatedAt: '2026-09-27T15:00:00.000Z' }), null);
  const reasons = brokerWithholdReasons(short);
  assert.ok(reasons.some((line) => line.startsWith('PIC:') && /Turbine/.test(line)));
  const reports = buildBrokerCrewReports({
    legs: [{ pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+' }],
    users: [
      { uid: 'pilot-1', name: 'Maxwell Hagberg' },
      { uid: 'pilot-2', name: 'Timothy Woods' },
    ],
    logbooksByUid: {
      'pilot-1': logbook({ hours: { ...logbook().hours, turbine: 180 } }),
      'pilot-2': logbook(),
    },
    currenciesByUid: {
      'pilot-1': currency(),
      'pilot-2': currency(),
    },
    generatedAt: '2026-09-27T15:00:00.000Z',
    todayMs: today,
  });
  assert.deepEqual(reports, []);
});

test('a trip share builds one PASS report and keeps the SIC on the SIC standard', () => {
  const reports = buildBrokerCrewReports({
    legs: [
      { pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+', from: 'TVC', to: 'IAD', date: '2026-09-28', tail: 'N286N' },
      { pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+' },
    ],
    aircraft: { registration: 'N286N', type: 'Citation XLS+', serial: '560-0001' },
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
  assert.equal(reports.length, 1);
  assert.equal(reports[0].crew.length, 2);
  assert.equal(reports[0].crew[0].role, 'Pilot-in-Command');
  assert.equal(reports[0].crew[1].role, 'Second-in-Command');
  assert.equal(reports[0].crew[0].rows[0].label, 'ATP Certificate');
  assert.equal(reports[0].crew[0].rows[0].value, 'ATP');
  assert.equal(reports[0].crew[1].rows.some((row) => row.label === 'ATP Certificate'), false);
  assert.equal(reports[0].crew[1].rows.some((row) => row.label === 'Line Check'), false);
  assert.equal(reports[0].crew[0].rows.find((row) => row.label === 'Medical').value.includes('Class 1'), true);
  assert.equal(reports[0].gapAnalysis, undefined);
  assert.equal(JSON.stringify(reports).includes('Does Not Meet'), false);
  assert.equal(JSON.stringify(reports).includes('Secret Street'), false);
});

test('the broker share and the email route are wired to the sanitized report', async () => {
  const tripPublic = await readFile(path.join(root, 'api/trip-public.js'), 'utf8');
  const email = await readFile(path.join(root, 'api/pilot-report-email.js'), 'utf8');
  const screen = await readFile(path.join(root, 'src/PilotSafety.jsx'), 'utf8');
  assert.match(tripPublic, /crewReportsForTrip/);
  assert.match(email, /buildPilotReportPdf/);
  assert.match(email, /blocked/);
  assert.match(screen, /broker-withhold/);
  assert.match(screen, /\/api\/pilot-report-email/);
});

test('a PIC without a fixed-wing ATP is withheld and a rotor-wing ATP does not count', () => {
  const commercial = evaluatePilot({
    pilot,
    logbook: logbook({ certificate: { ...logbook().certificate, level: 'Commercial' } }),
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(commercial.positions.PIC.tier, 'doesNotMeet');
  assert.equal(commercial.positions.SIC.tier, 'meets');
  assert.equal(brokerPilotReport(commercial, { generatedAt: '2026-09-27T15:00:00.000Z' }).crew[0].role, 'Second-in-Command');
  assert.equal(brokerWithholdReasons(commercial).includes('PIC does not hold ATP'), true);
  assert.equal(picAtpWarning(commercial), 'PIC does not hold ATP');

  const rotor = normalizeLogbook(logbook({
    certificate: {
      ...logbook().certificate,
      level: 'Commercial / Instrument; Rotor-Wing Airline Transport Pilot',
    },
  }));
  assert.equal(rotor.certificate.level, 'Commercial');
  assert.equal(rotor.certificate.rotorLevel, 'ATP');
  const rotorRating = evaluatePilot({
    pilot,
    logbook: rotor,
    currencyDoc: currency(),
    todayMs: today,
  });
  assert.equal(rotorRating.certificate.level, 'Commercial');
  assert.equal(brokerWithholdReasons(rotorRating).includes('PIC does not hold ATP'), true);
  const hidden = buildBrokerCrewReports({
    legs: [{ pic: 'Maxwell Hagberg', sic: 'Timothy Woods', aircraftType: 'Citation XLS+' }],
    users: [
      { uid: 'pilot-1', name: 'Maxwell Hagberg' },
      { uid: 'pilot-2', name: 'Timothy Woods' },
    ],
    logbooksByUid: {
      'pilot-1': rotor,
      'pilot-2': logbook(),
    },
    currenciesByUid: {
      'pilot-1': currency(),
      'pilot-2': currency(),
    },
    generatedAt: '2026-09-27T15:00:00.000Z',
    todayMs: today,
  });
  assert.deepEqual(hidden, []);

  const waived = normalizeStandards({ positions: { PIC: { atpCertificate: false } } });
  const allowed = evaluatePilot({
    pilot,
    logbook: logbook({ certificate: { ...logbook().certificate, level: 'Commercial' } }),
    currencyDoc: currency(),
    standards: waived,
    todayMs: today,
  });
  assert.equal(allowed.positions.PIC.tier, 'meets');
  assert.equal(brokerPilotReport(allowed, { generatedAt: '2026-09-27T15:00:00.000Z' }).crew[0].role, 'Pilot-in-Command');
  assert.equal(brokerPilotReport(allowed).crew[0].rows.some((row) => row.label === 'ATP Certificate'), false);
  assert.equal(picAtpWarning(allowed, waived), '');
  assert.equal(normalizeCertificateLevel('Airline Transport Pilot'), 'ATP');
  assert.equal(normalizeCertificateLevel('Rotor-Wing Airline Transport Pilot'), '');
  assert.deepEqual(parseAirmanCertificate('Commercial / Instrument; Rotor-Wing Airline Transport Pilot'), {
    fixedWing: 'Commercial',
    rotorWing: 'ATP',
  });
});

test('the trip screen warns when a non-ATP pilot is assigned as PIC', async () => {
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const settings = await readFile(path.join(root, 'src/PilotSafetySettings.jsx'), 'utf8');
  assert.match(app, /pic-atp-warning/);
  assert.match(app, /picAtpWarning/);
  assert.match(settings, /ATP certificate required/);
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
