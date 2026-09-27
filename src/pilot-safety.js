/**
 * Pilot safety rating.
 *
 * Pure scoring for a Part 135 charter crewmember. Hour minimums and which
 * requirements count are operator settings (app-config/pilot-safety). The
 * numbers shipped here are the Wyvern Registered Standard, split by PIC and
 * SIC. An admin can replace them. The result is the operator’s own rating,
 * not a live WYVERN Ltd audit.
 *
 * Experience comes from the pilot logbook, with last-90-day and last-12-month
 * flight time filled from duty records when the logbook leaves them blank.
 * Checks, training, and the medical come from the existing pilot-currencies
 * record. Certificate level and type ratings fall back to the airman
 * certificate already stored in pilot-docs when the logbook field is blank.
 * The medical falls back the same way. Certificate numbers, dates of birth,
 * addresses, and document files are never read by this module.
 */

import { computeMedicalStatus, computeStatus } from './currency-status.js';

export const TIER = Object.freeze({
  MEETS: 'meets',
  CAUTION: 'caution',
  DOES_NOT_MEET: 'doesNotMeet',
});

export const TIER_LABELS = Object.freeze({
  meets: 'Meets',
  caution: 'Meets',
  doesNotMeet: 'Does Not Meet',
});

export const CRITERIA_NAME = 'Wyvern Registered Standard';
export const CRITERIA_VERSION = 'registered-standard-1';

/** Logbook fields the hours editor reads. Scoring uses POSITION_HOUR_FIELDS. */
export const HOUR_FIELDS = Object.freeze([
  { key: 'totalTime', label: 'Total time' },
  { key: 'pic', label: 'PIC time' },
  { key: 'sic', label: 'SIC time' },
  { key: 'fixedWing', label: 'Fixed-wing' },
  { key: 'rotorWing', label: 'Rotor-wing' },
  { key: 'singleEngine', label: 'Single-engine' },
  { key: 'multiEngine', label: 'Multi-engine' },
  { key: 'multiEngine90', label: 'Multi-engine last 90 days' },
  { key: 'multiEngine12', label: 'Multi-engine last 12 months' },
  { key: 'turbine', label: 'Turbine' },
  { key: 'instrument', label: 'Instrument' },
  { key: 'night', label: 'Night' },
  { key: 'last90Days', label: 'Last 90 days' },
  { key: 'last12Months', label: 'Last 12 months' },
  { key: 'timeInType', label: 'Time in type', perType: true },
]);

/** Wyvern Registered Standard hour minimums, PIC value then SIC value. */
export const POSITION_HOUR_FIELDS = Object.freeze([
  { key: 'totalTime', label: 'Total time', pic: 2500, sic: 1000 },
  { key: 'pic', label: 'PIC time', pic: 1000, sic: 0 },
  { key: 'fixedWing', label: 'Fixed-wing', pic: 2000, sic: 1000 },
  { key: 'multiEngine', label: 'Multi-engine', pic: 1000, sic: 50 },
  { key: 'multiEngine12', label: 'Multi-engine last 12 months', pic: 150, sic: 50 },
  { key: 'multiEngine90', label: 'Multi-engine last 90 days', pic: 30, sic: 30 },
  { key: 'instrument', label: 'Instrument', pic: 100, sic: 50 },
  { key: 'turbine', label: 'Turbine', pic: 1000, sic: 30 },
  { key: 'timeInType', label: 'Total time in type', pic: 200, sic: 30, perType: true },
  { key: 'picTimeInType', label: 'PIC time in type', pic: 100, sic: 0, perType: true },
]);

const MEDICAL_CLASS_RANK = Object.freeze({
  First: 3,
  Second: 2,
  Third: 1,
  BasicMed: 0,
});

/** Credit a requirement status contributes to the 0–100 score. N/A is omitted. */
const STATUS_CREDIT = Object.freeze({
  current: 1,
  noExpiration: 1,
  caution: 0.85,
  warning: 0.65,
  critical: 0.4,
  expired: 0,
  unknown: 0,
});

const STATUS_RANK = Object.freeze({
  expired: 6,
  critical: 5,
  warning: 4,
  caution: 3,
  unknown: 2,
  current: 1,
  noExpiration: 1,
  na: 0,
});

/**
 * Interval metadata for the currency keys this rating reads. Mirrors the
 * intervals on CURRENCY_TYPES in firebase-currency.js. Operator-defined items
 * have no interval; their due date is whatever was entered on Currency.
 */
const CHECK_TYPES = Object.freeze({
  groundOralGeneral293a: { intervalMonths: 12, graceMonths: 1 },
  groundOral293a_LR60: { intervalMonths: 12, graceMonths: 1 },
  groundOral293a_CE525: { intervalMonths: 12, graceMonths: 1 },
  groundOral293a_SF50: { intervalMonths: 12, graceMonths: 1 },
  groundOral293a_untyped: { intervalMonths: 12, graceMonths: 1 },
  sim293b_LR60: { intervalMonths: 12, graceMonths: 1 },
  sim293b_CE525: { intervalMonths: 12, graceMonths: 1 },
  sim293b_SF50: { intervalMonths: 12, graceMonths: 1 },
  sim293b_untyped: { intervalMonths: 12, graceMonths: 1 },
  competencyCheck293: { intervalMonths: 12, graceMonths: 1 },
  instrumentCheck297: { intervalMonths: 6, graceMonths: 1 },
  lineCheck299: { intervalMonths: 12, graceMonths: 1 },
  recurrentTraining351: { intervalMonths: 12, graceMonths: 1 },
  crmTraining330: { operatorDefined: true },
  hazmatTraining: { intervalMonths: 24, graceMonths: 1 },
  tfsspTraining: { operatorDefined: true },
});

const AIRCRAFT_KNOWLEDGE_KEYS = [
  'groundOral293a_LR60',
  'groundOral293a_CE525',
  'groundOral293a_SF50',
  'groundOral293a_untyped',
];

const COMPETENCY_KEYS = [
  'sim293b_LR60',
  'sim293b_CE525',
  'sim293b_SF50',
  'sim293b_untyped',
  'competencyCheck293',
];

/**
 * Catalog of requirements the rating knows how to score. Admins turn each
 * one on or off and can rename the broker-facing label. Which currency keys
 * and intervals apply stays here so a settings typo cannot point at the
 * wrong check.
 */
export const REQUIREMENT_CATALOG = Object.freeze([
  { id: 'medical', label: 'Medical certificate', kind: 'medical', required: true },
  { id: 'certificate', label: 'Airman certificate', kind: 'certificate', required: true },
  { id: 'instrumentRating', label: 'Instrument rating', kind: 'instrumentRating', required: true },
  { id: 'multiEngineRating', label: 'Multi-engine rating', kind: 'multiEngineRating', required: true },
  {
    id: 'groundOral293',
    label: '§135.293 written/oral competency',
    kind: 'currency',
    key: 'groundOralGeneral293a',
    required: true,
  },
  {
    id: 'aircraftKnowledge293',
    label: '§135.293 aircraft knowledge',
    kind: 'currency-group',
    keys: AIRCRAFT_KNOWLEDGE_KEYS,
    required: true,
  },
  {
    id: 'competency293',
    label: '§135.293 competency check',
    kind: 'currency-group',
    keys: COMPETENCY_KEYS,
    required: true,
  },
  {
    id: 'instrumentCheck297',
    label: '§135.297 PIC instrument proficiency check',
    kind: 'currency',
    key: 'instrumentCheck297',
    picOnly: true,
    required: true,
  },
  {
    id: 'lineCheck299',
    label: '§135.299 PIC line check',
    kind: 'currency',
    key: 'lineCheck299',
    picOnly: true,
    required: true,
  },
  {
    id: 'recurrentTraining351',
    label: 'Recurrent training',
    kind: 'currency',
    key: 'recurrentTraining351',
    required: true,
  },
  {
    id: 'crmTraining330',
    label: 'CRM training',
    kind: 'currency',
    key: 'crmTraining330',
    required: true,
  },
  {
    id: 'hazmatTraining',
    label: 'Hazardous materials training',
    kind: 'currency',
    key: 'hazmatTraining',
    required: true,
  },
  {
    id: 'securityTraining',
    label: 'Security training',
    kind: 'currency',
    key: 'tfsspTraining',
    required: true,
  },
  {
    id: 'drugAlcohol',
    label: 'Drug and alcohol program',
    kind: 'drugAlcohol',
    required: true,
  },
]);

export const CERTIFICATE_LEVELS = Object.freeze([
  { id: 'ATP', label: 'ATP', rank: 3 },
  { id: 'Commercial', label: 'Commercial', rank: 2 },
  { id: 'Private', label: 'Private', rank: 1 },
]);

export const DEFAULT_STANDARDS_NOTE =
  'Wyvern Registered Standard defaults, by position (PIC and SIC). These are the starting minimums for this operator and can be replaced. They are not a live WYVERN Ltd audit result.';

function positionHourDefaults(seat) {
  const hours = {};
  for (const field of POSITION_HOUR_FIELDS) {
    hours[field.key] = seat === 'SIC' ? field.sic : field.pic;
  }
  return hours;
}

function defaultPosition(seat) {
  const pic = seat !== 'SIC';
  return {
    hours: positionHourDefaults(seat),
    medicalClass: pic ? 'First' : 'Second',
    medicalMonths: 12,
    indoctrination: true,
    lineCheck: pic,
    lineCheckMonths: pic ? 7 : 0,
    ipc: pic,
    ipcMonths: pic ? 6 : 0,
    maxActiveTypes: 2,
    confirmedType: pic,
    aircraftMonths: 12,
    recurrentMonths: 12,
    simulatorMonths: 12,
    motionSimulator: true,
  };
}

function requirementDefaults() {
  return REQUIREMENT_CATALOG.map((item) => ({
    id: item.id,
    label: item.label,
    required: item.required !== false,
  }));
}

export const DEFAULT_PILOT_SAFETY_STANDARDS = Object.freeze({
  customized: false,
  criteriaName: CRITERIA_NAME,
  criteriaVersion: CRITERIA_VERSION,
  sourceNote: DEFAULT_STANDARDS_NOTE,
  standingRole: 'PIC',
  weights: Object.freeze({ experience: 55, requirements: 45 }),
  tiers: Object.freeze({ meetsAt: 85, cautionAt: 70 }),
  certificate: Object.freeze({
    minimumLevel: 'Commercial',
    requireInstrument: true,
    requireMultiEngine: true,
  }),
  positions: Object.freeze({
    PIC: Object.freeze({ ...defaultPosition('PIC'), hours: Object.freeze(positionHourDefaults('PIC')) }),
    SIC: Object.freeze({ ...defaultPosition('SIC'), hours: Object.freeze(positionHourDefaults('SIC')) }),
  }),
  requirements: Object.freeze(requirementDefaults().map((item) => Object.freeze({ ...item }))),
});

function cloneDefaults() {
  return {
    customized: false,
    criteriaName: CRITERIA_NAME,
    criteriaVersion: CRITERIA_VERSION,
    sourceNote: DEFAULT_STANDARDS_NOTE,
    standingRole: 'PIC',
    weights: { ...DEFAULT_PILOT_SAFETY_STANDARDS.weights },
    tiers: { ...DEFAULT_PILOT_SAFETY_STANDARDS.tiers },
    certificate: { ...DEFAULT_PILOT_SAFETY_STANDARDS.certificate },
    positions: {
      PIC: { ...defaultPosition('PIC'), hours: positionHourDefaults('PIC') },
      SIC: { ...defaultPosition('SIC'), hours: positionHourDefaults('SIC') },
    },
    requirements: DEFAULT_PILOT_SAFETY_STANDARDS.requirements.map((item) => ({ ...item })),
  };
}

function readPosition(raw, seat, fallback) {
  const source = raw?.positions?.[seat];
  const next = {
    ...fallback,
    hours: { ...fallback.hours },
  };
  if (!source || typeof source !== 'object') return next;
  for (const field of POSITION_HOUR_FIELDS) {
    const minimum = finiteNumber(source.hours?.[field.key]);
    if (minimum != null) next.hours[field.key] = minimum;
  }
  if (typeof source.medicalClass === 'string' && MEDICAL_CLASS_RANK[medicalClassLabel(source.medicalClass)] != null) {
    next.medicalClass = medicalClassLabel(source.medicalClass);
  }
  for (const key of ['medicalMonths', 'lineCheckMonths', 'ipcMonths', 'maxActiveTypes', 'aircraftMonths', 'recurrentMonths', 'simulatorMonths']) {
    const value = finiteNumber(source[key]);
    if (value != null) next[key] = value;
  }
  for (const key of ['indoctrination', 'lineCheck', 'ipc', 'confirmedType', 'motionSimulator']) {
    if (typeof source[key] === 'boolean') next[key] = source[key];
  }
  return next;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function clampWeight(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function normalizeStandards(raw) {
  const standards = cloneDefaults();
  if (!raw || typeof raw !== 'object') return standards;
  standards.customized = raw.customized === true;
  if (typeof raw.sourceNote === 'string' && raw.sourceNote.trim()) {
    standards.sourceNote = raw.sourceNote.trim().slice(0, 400);
  }
  standards.standingRole = raw.standingRole === 'SIC' ? 'SIC' : 'PIC';

  const exp = clampWeight(raw.weights?.experience, standards.weights.experience);
  const req = clampWeight(raw.weights?.requirements, 100 - exp);
  const sum = exp + req;
  standards.weights = sum === 100
    ? { experience: exp, requirements: req }
    : { experience: exp, requirements: Math.max(0, 100 - exp) };

  const meetsAt = clampWeight(raw.tiers?.meetsAt, standards.tiers.meetsAt);
  let cautionAt = clampWeight(raw.tiers?.cautionAt, standards.tiers.cautionAt);
  if (cautionAt >= meetsAt) cautionAt = Math.max(0, meetsAt - 1);
  standards.tiers = { meetsAt, cautionAt };

  const minLevel = String(raw.certificate?.minimumLevel || standards.certificate.minimumLevel);
  standards.certificate.minimumLevel = CERTIFICATE_LEVELS.some((level) => level.id === minLevel)
    ? minLevel
    : 'Commercial';
  if (typeof raw.certificate?.requireInstrument === 'boolean') {
    standards.certificate.requireInstrument = raw.certificate.requireInstrument;
  }
  if (typeof raw.certificate?.requireMultiEngine === 'boolean') {
    standards.certificate.requireMultiEngine = raw.certificate.requireMultiEngine;
  }

  standards.positions.PIC = readPosition(raw, 'PIC', standards.positions.PIC);
  standards.positions.SIC = readPosition(raw, 'SIC', standards.positions.SIC);
  // Older saved settings stored one hour table. Apply it to the PIC column.
  if (raw.hours?.minimums && !raw.positions) {
    for (const field of POSITION_HOUR_FIELDS) {
      const minimum = finiteNumber(raw.hours.minimums[field.key]);
      if (minimum != null) standards.positions.PIC.hours[field.key] = minimum;
    }
  }

  const savedReqs = Array.isArray(raw.requirements) ? raw.requirements : [];
  standards.requirements = standards.requirements.map((item) => {
    const saved = savedReqs.find((entry) => entry && entry.id === item.id);
    if (!saved) return item;
    const label = typeof saved.label === 'string' && saved.label.trim()
      ? saved.label.trim().slice(0, 80)
      : item.label;
    return {
      id: item.id,
      label,
      required: typeof saved.required === 'boolean' ? saved.required : item.required,
    };
  });
  return standards;
}

export function emptyLogbook(uid = '', pilotName = '') {
  return {
    uid,
    pilotName,
    hours: {
      totalTime: null,
      pic: null,
      sic: null,
      fixedWing: null,
      rotorWing: null,
      singleEngine: null,
      multiEngine: null,
      multiEngine90: null,
      multiEngine12: null,
      turbine: null,
      night: null,
      instrument: null,
      last90Days: null,
      last12Months: null,
      last6Months: null,
      landings: null,
      timeInType: [],
    },
    certificate: {
      level: '',
      instrument: null,
      multiEngine: null,
      typeRatings: [],
      typeVerified: null,
      country: '',
    },
    background: {
      employment: '',
      accident: null,
      enforcement: null,
    },
    drugAlcohol: {
      enrolled: null,
      enrolledDate: '',
      programName: '',
    },
    internalNotes: '',
    wyvern: null,
    baseline: null,
    hoursMeta: null,
  };
}

function copyHourBag(raw) {
  const hours = emptyLogbook().hours;
  if (!raw || typeof raw !== 'object') return hours;
  for (const field of HOUR_FIELDS) {
    if (field.perType) continue;
    hours[field.key] = finiteNumber(raw[field.key]);
  }
  hours.last6Months = finiteNumber(raw.last6Months);
  hours.landings = finiteNumber(raw.landings);
  const types = Array.isArray(raw.timeInType) ? raw.timeInType : [];
  hours.timeInType = types.slice(0, 24).map((entry) => ({
    type: String(entry?.type || '').trim().slice(0, 80),
    hours: finiteNumber(entry?.hours),
    picHours: finiteNumber(entry?.picHours),
  })).filter((entry) => entry.type);
  return hours;
}

function normalizeBaseline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(raw.asOf || '') ? raw.asOf : '';
  const source = raw.source === 'Wyvern' || raw.source === 'manual' ? raw.source : '';
  if (!asOf && !source && !raw.hours) return null;
  return { asOf, source, hours: copyHourBag(raw.hours) };
}

function normalizeHoursMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(raw.asOf || '') ? raw.asOf : '';
  const flown = raw.flownSince && typeof raw.flownSince === 'object' ? raw.flownSince : {};
  const meta = {
    asOf,
    baselineAsOf: /^\d{4}-\d{2}-\d{2}$/.test(raw.baselineAsOf || '') ? raw.baselineAsOf : '',
    baselineSource: raw.baselineSource === 'Wyvern' || raw.baselineSource === 'manual' ? raw.baselineSource : '',
    flownSince: {
      totalTime: finiteNumber(flown.totalTime) || 0,
      pic: finiteNumber(flown.pic) || 0,
      sic: finiteNumber(flown.sic) || 0,
      multiEngine: finiteNumber(flown.multiEngine) || 0,
      turbine: finiteNumber(flown.turbine) || 0,
      night: finiteNumber(flown.night) || 0,
      landings: finiteNumber(flown.landings) || 0,
    },
    last6Months: finiteNumber(raw.last6Months),
    nightUncomputed: Number.isFinite(Number(raw.nightUncomputed)) ? Math.max(0, Math.round(Number(raw.nightUncomputed))) : 0,
    note: String(raw.note || '').slice(0, 400),
  };
  if (!meta.asOf && !meta.note && !meta.baselineAsOf) return null;
  return meta;
}

function normalizeWyvernStamp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const importedAt = Number(raw.importedAt);
  const newHireHours = finiteNumber(raw.newHireHours);
  const dateOrBlank = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '');
  const stamp = {
    id: String(raw.id || '').trim().slice(0, 80),
    source: 'Wyvern',
    importedAt: Number.isFinite(importedAt) ? importedAt : null,
    hoursAsOf: dateOrBlank(raw.hoursAsOf),
    verificationStatus: String(raw.verificationStatus || '').slice(0, 80),
    position: String(raw.position || '').slice(0, 40),
    hiredOn: dateOrBlank(raw.hiredOn),
    base: String(raw.base || '').slice(0, 80),
    newHireHours,
    passStatus: String(raw.passStatus || '').slice(0, 80),
    certificateIssuedOn: dateOrBlank(raw.certificateIssuedOn),
    faaVerifiedOn: dateOrBlank(raw.faaVerifiedOn),
    backgroundCheckedOn: dateOrBlank(raw.backgroundCheckedOn),
  };
  const empty = !stamp.id
    && stamp.importedAt == null
    && !stamp.hoursAsOf
    && !stamp.verificationStatus
    && !stamp.position
    && !stamp.hiredOn
    && !stamp.base
    && stamp.newHireHours == null
    && !stamp.passStatus
    && !stamp.certificateIssuedOn
    && !stamp.faaVerifiedOn
    && !stamp.backgroundCheckedOn;
  return empty ? null : stamp;
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 24);
  }
  if (typeof value === 'string') {
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 24);
  }
  return [];
}

export function normalizeLogbook(raw, uid = '') {
  const book = emptyLogbook(uid || raw?.uid || '', raw?.pilotName || '');
  if (!raw || typeof raw !== 'object') return book;
  book.uid = uid || raw.uid || book.uid;
  book.pilotName = String(raw.pilotName || '').slice(0, 80);
  book.hours = copyHourBag(raw.hours);
  book.certificate.level = normalizeCertificateLevel(raw.certificate?.level);
  book.certificate.instrument = raw.certificate?.instrument === true
    ? true
    : raw.certificate?.instrument === false
      ? false
      : null;
  book.certificate.multiEngine = raw.certificate?.multiEngine === true
    ? true
    : raw.certificate?.multiEngine === false
      ? false
      : null;
  book.certificate.typeRatings = asStringList(raw.certificate?.typeRatings);
  book.certificate.typeVerified = raw.certificate?.typeVerified === true
    ? true
    : raw.certificate?.typeVerified === false
      ? false
      : null;
  book.certificate.country = String(raw.certificate?.country || '').slice(0, 40);
  const accident = raw.background?.accident;
  const enforcement = raw.background?.enforcement;
  book.background.employment = String(raw.background?.employment || '').slice(0, 40);
  book.background.accident = accident === true ? true : accident === false ? false : null;
  book.background.enforcement = enforcement === true ? true : enforcement === false ? false : null;
  const enrolled = raw.drugAlcohol?.enrolled;
  book.drugAlcohol.enrolled = enrolled === true ? true : enrolled === false ? false : null;
  book.drugAlcohol.enrolledDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.drugAlcohol?.enrolledDate || '')
    ? raw.drugAlcohol.enrolledDate
    : '';
  book.drugAlcohol.programName = String(raw.drugAlcohol?.programName || '').slice(0, 80);
  book.internalNotes = String(raw.internalNotes || '').slice(0, 2000);
  book.wyvern = normalizeWyvernStamp(raw.wyvern);
  book.baseline = normalizeBaseline(raw.baseline);
  book.hoursMeta = normalizeHoursMeta(raw.hoursMeta);
  return book;
}

export function normalizeCertificateLevel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'atp' || text.includes('airline transport')) return 'ATP';
  if (text.startsWith('comm')) return 'Commercial';
  if (text.startsWith('priv')) return 'Private';
  return '';
}

function levelRank(id) {
  return CERTIFICATE_LEVELS.find((level) => level.id === id)?.rank || 0;
}

function normalizeType(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function formatHours(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}

export function itemStatusLabel(status, daysUntil = null) {
  if (status === 'na') return 'Not Required';
  if (status === 'expired') return 'Expired';
  if (status === 'unknown' || !status) return 'Not Validated';
  const days = daysUntil == null || daysUntil === '' || !Number.isFinite(Number(daysUntil))
    ? null
    : Number(daysUntil);
  if (days != null && days >= 0 && days <= 7) return 'Expires in 7 Days';
  if (days != null && days > 7 && days <= 30) return 'Expires in 30 Days';
  if (status === 'critical') return 'Expires in 7 Days';
  if (status === 'warning') return 'Expires in 30 Days';
  if (status === 'current' || status === 'noExpiration' || status === 'caution') return 'Current';
  return 'Not Validated';
}

export function brokerStatusLabel(status, daysUntil = null) {
  return itemStatusLabel(status, daysUntil);
}

export function medicalBrokerLabel(status, daysUntil = null) {
  return itemStatusLabel(status, daysUntil);
}

export function statusToneName(label) {
  if (label === 'Current' || label === 'Meets' || label === 'None') return 'current';
  if (label === 'Expires in 30 Days' || label === 'Expires in 7 Days') return 'soon';
  if (label === 'Expired' || label === 'Not Validated' || label === 'Does Not Meet' || label === 'Yes') return 'bad';
  return 'muted';
}

function medicalClassLabel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === '1' || text.includes('first') || text.includes('class 1') || text.includes('class i')) return 'First';
  if (text === '2' || text.includes('second') || text.includes('class 2') || text.includes('class ii')) return 'Second';
  if (text === '3' || text.includes('third') || text.includes('class 3') || text.includes('class iii')) return 'Third';
  if (text.includes('basic')) return 'BasicMed';
  return '';
}

function latestDoc(docs, docType) {
  const matches = (docs || []).filter((doc) => doc && doc.docType === docType);
  matches.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  return matches[0] || null;
}

function ratingsMention(text, pattern) {
  return pattern.test(String(text || ''));
}

/**
 * Flight time already captured on duty periods, in hours.
 * Used only when the logbook left recent-experience blank.
 */
export function summarizeDutyFlightHours(periods, uid, todayMs = Date.now()) {
  if (!uid) return { last90Days: null, last12Months: null };
  const start90 = todayMs - 90 * 86400000;
  const start12 = todayMs - 365 * 86400000;
  let last90 = 0;
  let last12 = 0;
  let any = false;
  for (const period of periods || []) {
    if (period?.pilotUid !== uid) continue;
    if (period.confirmStatus && !['self-attested', 'admin-attested'].includes(period.confirmStatus)) continue;
    const on = period.dutyOnAt;
    if (!Number.isFinite(on) || on > todayMs) continue;
    const hours = (Number(period.flightTimeMs) || 0) / 3600000;
    if (hours <= 0) continue;
    if (on >= start12) {
      last12 += hours;
      any = true;
    }
    if (on >= start90) last90 += hours;
  }
  if (!any) return { last90Days: null, last12Months: null };
  const round = (n) => Math.round(n * 10) / 10;
  return { last90Days: round(last90), last12Months: round(last12) };
}

function checkResult(currencyDoc, key, todayMs) {
  const type = CHECK_TYPES[key] || {};
  return computeStatus(currencyDoc?.[key], type.interval, todayMs, type);
}

function worstResult(results) {
  if (!results.length) return { status: 'unknown', dueDate: null, daysUntil: null };
  let worst = results[0];
  for (const result of results.slice(1)) {
    const rank = STATUS_RANK[result.status] || 0;
    const worstRank = STATUS_RANK[worst.status] || 0;
    if (rank > worstRank) worst = result;
    else if (
      rank === worstRank
      && result.daysUntil != null
      && (worst.daysUntil == null || result.daysUntil < worst.daysUntil)
    ) {
      worst = result;
    }
  }
  return worst;
}

/**
 * Aircraft-specific groups: unmarked types are not failures. N/A is ignored.
 * If at least one type is actually recorded, only those records count, and
 * the worst of them is the result. If nothing is recorded, the item is not
 * on file.
 */
function groupResult(currencyDoc, keys, todayMs) {
  const results = keys.map((key) => checkResult(currencyDoc, key, todayMs));
  const applicable = results.filter((result) => result.status !== 'na');
  if (applicable.length === 0) {
    return results.length > 0 && results.every((result) => result.status === 'na')
      ? { status: 'na', dueDate: null, daysUntil: null, completedOn: null }
      : { status: 'unknown', dueDate: null, daysUntil: null, completedOn: null };
  }
  const recorded = applicable.filter((result) => result.status !== 'unknown');
  const picked = worstResult(recorded.length ? recorded : applicable);
  const completedOn = completedDateFor(currencyDoc, keys, picked);
  return { ...picked, completedOn };
}

function completedDateFor(currencyDoc, keys, result) {
  const list = Array.isArray(keys) ? keys : [keys];
  const dates = list
    .map((key) => currencyDoc?.[key]?.lastDate)
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ''));
  if (dates.length === 0) return null;
  dates.sort();
  if (result?.status === 'expired' || result?.status === 'unknown') return dates[dates.length - 1];
  return dates[dates.length - 1];
}

function requirementApplies(defn, saved, role, standards) {
  if (saved && saved.required === false) return false;
  if (defn.picOnly && role === 'SIC') return false;
  if (defn.id === 'instrumentRating' && standards.certificate.requireInstrument === false) return false;
  if (defn.id === 'multiEngineRating' && standards.certificate.requireMultiEngine === false) return false;
  return true;
}

function resolveCertificate(logbook, pilotDocs) {
  const stored = logbook?.certificate || {};
  const onFile = latestDoc(pilotDocs, 'certificate');
  const level = stored.level || normalizeCertificateLevel(onFile?.certType);
  let instrument = stored.instrument;
  let multiEngine = stored.multiEngine;
  let typeRatings = asStringList(stored.typeRatings);
  let levelSource = stored.level ? 'logbook' : (level ? 'certificate' : 'missing');
  if (instrument == null && onFile && ratingsMention(onFile.ratings, /instrument/i)) {
    instrument = true;
  }
  if (multiEngine == null && onFile && ratingsMention(onFile.ratings, /multi[-\s]?engine|\bmel\b/i)) {
    multiEngine = true;
  }
  if (typeRatings.length === 0 && onFile?.ratings) {
    typeRatings = asStringList(onFile.ratings).filter((part) => !/instrument|commercial|atp|private|multi/i.test(part));
  }
  return {
    level,
    instrument,
    multiEngine,
    typeRatings,
    typeVerified: stored.typeVerified === true ? true : stored.typeVerified === false ? false : null,
    country: stored.country || '',
    levelSource,
  };
}

function resolveMedical(currencyDoc, pilotDocs, todayMs) {
  const fromCurrency = currencyDoc?.medical;
  if (fromCurrency?.expirationDate || fromCurrency?.class) {
    const status = computeMedicalStatus(fromCurrency, todayMs);
    return {
      class: medicalClassLabel(fromCurrency.class) || '',
      status: status.status,
      daysUntil: status.daysUntil,
      lastDate: /^\d{4}-\d{2}-\d{2}$/.test(fromCurrency.lastDate || '') ? fromCurrency.lastDate : '',
      source: 'currency',
    };
  }
  const onFile = latestDoc(pilotDocs, 'medical');
  if (onFile?.expiration) {
    const med = {
      class: medicalClassLabel(onFile.medicalClass),
      expirationDate: onFile.expiration,
    };
    const status = computeMedicalStatus(med, todayMs);
    return {
      class: med.class,
      status: status.status,
      daysUntil: status.daysUntil,
      lastDate: '',
      source: 'medical-certificate',
    };
  }
  return { class: '', status: 'unknown', daysUntil: null, lastDate: '', source: 'missing' };
}

function timeInTypeActual(entries, focusType) {
  const list = Array.isArray(entries) ? entries : [];
  if (focusType) {
    const wanted = normalizeType(focusType);
    const hit = list.find((entry) => normalizeType(entry.type) === wanted);
    return {
      actual: hit ? finiteNumber(hit.hours) ?? 0 : (list.length ? 0 : null),
      matchedType: hit?.type || null,
      source: hit ? 'logbook' : 'missing',
    };
  }
  if (list.length === 0) return { actual: null, matchedType: null, source: 'missing' };
  let best = list[0];
  for (const entry of list) {
    if ((finiteNumber(entry.hours) || 0) > (finiteNumber(best.hours) || 0)) best = entry;
  }
  return { actual: finiteNumber(best.hours), matchedType: best.type, source: 'logbook' };
}

function scoreExperience(lines, weight) {
  if (lines.length === 0) return weight;
  const avg = lines.reduce((sum, line) => sum + line.ratio, 0) / lines.length;
  return avg * weight;
}

function scoreRequirements(lines, weight) {
  if (lines.length === 0) return weight;
  const avg = lines.reduce((sum, line) => sum + line.credit, 0) / lines.length;
  return avg * weight;
}

function classMeets(actual, minimum) {
  if (!minimum) return true;
  if (!actual || MEDICAL_CLASS_RANK[actual] == null) return false;
  return MEDICAL_CLASS_RANK[actual] >= (MEDICAL_CLASS_RANK[minimum] || 0);
}

function checkDated(currencyDoc, key, months, todayMs) {
  const item = currencyDoc?.[key];
  if (item?.notApplicable === true) return { status: 'na', dueDate: null, daysUntil: null, completedOn: null };
  const completedOn = /^\d{4}-\d{2}-\d{2}$/.test(item?.lastDate || '') ? item.lastDate : null;
  if (months > 0) {
    const result = computeStatus(item, null, todayMs, { intervalMonths: months, graceMonths: 0 });
    return { ...result, completedOn };
  }
  if (completedOn || item?.present === true) {
    return { status: 'noExpiration', dueDate: null, daysUntil: null, completedOn };
  }
  return { status: 'unknown', dueDate: null, daysUntil: null, completedOn };
}

function groupDated(currencyDoc, keys, months, todayMs) {
  const results = keys.map((key) => checkDated(currencyDoc, key, months, todayMs));
  const applicable = results.filter((result) => result.status !== 'na');
  if (applicable.length === 0) {
    return { status: 'unknown', dueDate: null, daysUntil: null, completedOn: null };
  }
  const recorded = applicable.filter((result) => result.status !== 'unknown');
  return worstResult(recorded.length ? recorded : applicable);
}

function hourActual(book, key, dutyHours, focusType) {
  if (key === 'fixedWing') {
    if (book.hours.fixedWing != null) return { actual: book.hours.fixedWing, source: 'logbook', detail: '' };
    if (book.hours.totalTime != null) {
      return {
        actual: Math.max(0, Number(book.hours.totalTime) - (Number(book.hours.rotorWing) || 0)),
        source: 'derived',
        detail: 'Fixed-wing from total time',
      };
    }
    return { actual: null, source: 'missing', detail: '' };
  }
  if (key === 'timeInType' || key === 'picTimeInType') {
    const list = Array.isArray(book.hours.timeInType) ? book.hours.timeInType : [];
    const wanted = focusType ? normalizeType(focusType) : '';
    const hit = wanted
      ? list.find((entry) => normalizeType(entry.type) === wanted || normalizeType(entry.type).includes(wanted) || wanted.includes(normalizeType(entry.type)))
      : null;
    const chosen = hit || (key === 'picTimeInType'
      ? list.slice().sort((a, b) => (Number(b.picHours) || 0) - (Number(a.picHours) || 0))[0]
      : null);
    const resolved = chosen ? null : timeInTypeActual(list, focusType);
    if (key === 'picTimeInType') {
      const entry = chosen;
      return {
        actual: entry?.picHours ?? null,
        source: entry?.picHours != null ? 'logbook' : 'missing',
        detail: entry?.type || (focusType ? `No PIC time for ${focusType}` : ''),
      };
    }
    if (chosen) {
      return { actual: finiteNumber(chosen.hours), source: 'logbook', detail: chosen.type };
    }
    return {
      actual: resolved.actual,
      source: resolved.source === 'logbook' ? 'logbook' : 'missing',
      detail: resolved.matchedType || (focusType ? `No entry for ${focusType}` : ''),
    };
  }
  if (book.hours[key] != null) return { actual: book.hours[key], source: 'logbook', detail: '' };
  if ((key === 'last90Days' || key === 'last12Months') && dutyHours?.[key] != null) {
    return { actual: dutyHours[key], source: 'duty', detail: 'From duty flight time' };
  }
  return { actual: null, source: 'missing', detail: '' };
}

function failingStatus(label) {
  return label === 'Expired' || label === 'Not Validated';
}

function expiringStatus(label) {
  return label === 'Expires in 30 Days' || label === 'Expires in 7 Days';
}

function scorePosition(seat, position, ctx) {
  const experience = [];
  const requirements = [];
  const gaps = [];
  const hardFailures = [];
  const expiring = [];
  const noteGap = (row, ok, failure) => {
    gaps.push({ ...row, met: ok });
    if (!ok && failure) hardFailures.push(failure);
  };

  for (const field of POSITION_HOUR_FIELDS) {
    const minimum = Number(position.hours[field.key]) || 0;
    const resolved = hourActual(ctx.book, field.key, ctx.dutyHours, ctx.focusType);
    const required = minimum > 0;
    let state = 'meets';
    if (!required) state = 'optional';
    else if (resolved.actual == null) state = 'missing';
    else if (resolved.actual < minimum) state = 'short';
    const ratio = !required || minimum === 0
      ? 1
      : resolved.actual == null
        ? 0
        : Math.max(0, Math.min(1, resolved.actual / minimum));
    experience.push({
      key: field.key,
      label: field.label,
      actual: resolved.actual,
      actualDisplay: formatHours(resolved.actual),
      minimum: required ? minimum : 0,
      required,
      ratio,
      state,
      source: resolved.source,
      detail: resolved.detail || '',
    });
    const pilotValue = resolved.actual == null ? 'Not on file' : formatHours(resolved.actual);
    const met = state !== 'missing' && state !== 'short';
    noteGap(
      { id: `${seat}:${field.key}`, label: field.label, pilotValue, criterion: String(minimum) },
      met,
      state === 'missing'
        ? `${field.label} is not on file.`
        : state === 'short'
          ? `${field.label} is ${formatHours(resolved.actual)}, below the ${minimum} minimum.`
          : '',
    );
  }

  const classOk = classMeets(ctx.medical.class, position.medicalClass);
  const medicalLabel = itemStatusLabel(ctx.medical.status, ctx.medical.daysUntil);
  const medicalOk = classOk && !failingStatus(medicalLabel);
  noteGap(
    {
      id: `${seat}:medicalClass`,
      label: 'Minimum medical class',
      pilotValue: ctx.medical.class || 'Not on file',
      criterion: position.medicalClass === 'First' ? 'Class 1' : position.medicalClass === 'Second' ? 'Class 2' : position.medicalClass,
    },
    classOk,
    classOk ? '' : 'Minimum medical class is not met.',
  );
  noteGap(
    {
      id: `${seat}:medicalValidity`,
      label: 'Medical validity',
      pilotValue: medicalLabel,
      criterion: `${position.medicalMonths} months`,
    },
    !failingStatus(medicalLabel),
    failingStatus(medicalLabel) ? `Medical certificate is ${medicalLabel}.` : '',
  );
  requirements.push({
    id: 'medical',
    label: 'Medical certificate',
    included: true,
    required: true,
    status: medicalOk ? ctx.medical.status : (ctx.medical.class ? 'expired' : 'unknown'),
    statusLabel: medicalOk ? medicalLabel : (classOk ? medicalLabel : 'Not Validated'),
    completedOn: ctx.medical.lastDate || null,
    dueOn: null,
    detail: ctx.medical.class ? `${ctx.medical.class} class` : 'Not on file',
    credit: medicalOk ? (STATUS_CREDIT[ctx.medical.status] ?? 0) : 0,
  });
  if (medicalOk && expiringStatus(medicalLabel)) {
    expiring.push(`Medical certificate ${medicalLabel}.`);
  }
  requirements.push({
    id: 'certificate',
    label: 'Airman certificate',
    included: true,
    required: false,
    status: ctx.certificate.level ? 'current' : 'unknown',
    statusLabel: ctx.certificate.level ? 'Current' : 'Not Validated',
    completedOn: null,
    dueOn: null,
    detail: [ctx.certificate.level, ctx.certificate.country].filter(Boolean).join(' · ') || 'Not on file',
    credit: null,
  });

  const addCheck = (id, label, required, result, criterion) => {
    const statusLabel = required ? itemStatusLabel(result.status, result.daysUntil) : 'Not Required';
    requirements.push({
      id,
      label,
      included: required,
      required,
      status: required ? result.status : 'na',
      statusLabel,
      completedOn: result.completedOn || null,
      dueOn: result.dueDate || null,
      detail: result.completedOn || statusLabel,
      credit: !required ? null : (STATUS_CREDIT[result.status] ?? 0),
    });
    if (!required) {
      gaps.push({ id: `${seat}:${id}`, label, pilotValue: 'Not required', criterion, met: true });
      return;
    }
    const met = !failingStatus(statusLabel);
    noteGap(
      { id: `${seat}:${id}`, label, pilotValue: statusLabel, criterion },
      met,
      met ? '' : `${label} is ${statusLabel}.`,
    );
    if (met && expiringStatus(statusLabel)) expiring.push(`${label} ${statusLabel}.`);
  };

  addCheck(
    'indoctrination',
    'Indoctrination training',
    position.indoctrination === true,
    checkDated(ctx.currencyDoc, 'basicIndoctrination', 0, ctx.todayMs),
    'Required',
  );
  addCheck(
    'lineCheck299',
    'Line check',
    position.lineCheck === true,
    checkDated(ctx.currencyDoc, 'lineCheck299', position.lineCheckMonths, ctx.todayMs),
    position.lineCheck ? `${position.lineCheckMonths} months` : 'Not required',
  );
  addCheck(
    'instrumentCheck297',
    'Instrument proficiency check',
    position.ipc === true,
    checkDated(ctx.currencyDoc, 'instrumentCheck297', position.ipcMonths, ctx.todayMs),
    position.ipc ? `${position.ipcMonths} months` : 'Not required',
  );

  const typeCount = (ctx.certificate.typeRatings || []).length;
  const typesOk = typeCount <= (Number(position.maxActiveTypes) || 0);
  noteGap(
    { id: `${seat}:maxTypes`, label: 'Active type ratings', pilotValue: String(typeCount), criterion: String(position.maxActiveTypes) },
    typesOk,
    typesOk ? '' : `Active type ratings are ${typeCount}, above the ${position.maxActiveTypes} maximum.`,
  );

  const confirmed = (ctx.certificate.typeRatings || []).length > 0;
  const confirmedOk = position.confirmedType !== true || confirmed;
  noteGap(
    { id: `${seat}:confirmedType`, label: 'Confirmed type rating', pilotValue: confirmed ? (ctx.certificate.typeRatings || []).join(', ') : 'Not on file', criterion: position.confirmedType ? 'Required' : 'Not required' },
    confirmedOk,
    confirmedOk ? '' : 'Confirmed type rating is Not Validated.',
  );

  addCheck(
    'aircraftKnowledge293',
    'Aircraft-specific training',
    true,
    groupDated(ctx.currencyDoc, AIRCRAFT_KNOWLEDGE_KEYS, position.aircraftMonths, ctx.todayMs),
    `${position.aircraftMonths} months`,
  );
  addCheck(
    'recurrentTraining351',
    'Recurrent training',
    true,
    checkDated(ctx.currencyDoc, 'recurrentTraining351', position.recurrentMonths, ctx.todayMs),
    `${position.recurrentMonths} months`,
  );
  const simulator = groupDated(ctx.currencyDoc, COMPETENCY_KEYS, position.simulatorMonths, ctx.todayMs);
  addCheck('competency293', 'Simulator training', true, simulator, `${position.simulatorMonths} months`);
  const simNotes = COMPETENCY_KEYS.map((key) => ctx.currencyDoc?.[key]?.notes || '').join(' ');
  const fixedBase = /fixed[-\s]?base/i.test(simNotes);
  const motionOk = position.motionSimulator !== true || (!fixedBase && !failingStatus(itemStatusLabel(simulator.status, simulator.daysUntil)));
  noteGap(
    { id: `${seat}:motion`, label: 'Motion-based simulator', pilotValue: fixedBase ? 'Fixed base' : itemStatusLabel(simulator.status, simulator.daysUntil), criterion: position.motionSimulator ? 'Required' : 'Not required' },
    position.motionSimulator !== true || motionOk,
    motionOk ? '' : 'Motion-based simulator is Not Validated.',
  );

  const expLines = experience.filter((line) => line.required);
  const reqLines = requirements.filter((line) => line.included && line.credit != null);
  const rawScore = scoreExperience(expLines, ctx.standards.weights.experience)
    + scoreRequirements(reqLines, ctx.standards.weights.requirements);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  let tier = TIER.MEETS;
  if (hardFailures.length > 0) tier = TIER.DOES_NOT_MEET;
  else if (expiring.length > 0) tier = TIER.CAUTION;
  return {
    role: seat,
    tier,
    tierLabel: TIER_LABELS[tier],
    score,
    gaps,
    experience,
    requirements,
    hardFailures,
    expiring,
  };
}

function mergeGapAnalysis(pic, sic) {
  const rows = [];
  const sicByLabel = new Map((sic.gaps || []).map((row) => [row.label, row]));
  for (const row of pic.gaps || []) {
    const other = sicByLabel.get(row.label);
    rows.push({
      label: row.label,
      pilotValue: row.pilotValue,
      picCriteria: row.criterion,
      sicCriteria: other?.criterion || '',
      picMet: row.met === true,
      sicMet: other ? other.met === true : false,
    });
  }
  return rows;
}

/**
 * Score one pilot against the PIC standard and the SIC standard.
 * A requested seat (a trip assignment) is the tier for that report.
 * With no seat, the pilot meets when at least one position meets.
 */
export function evaluatePilot({
  pilot = {},
  logbook = null,
  currencyDoc = null,
  pilotDocs = [],
  standards: rawStandards = null,
  dutyHours = null,
  role = null,
  focusType = null,
  todayMs = Date.now(),
} = {}) {
  const standards = normalizeStandards(rawStandards);
  const book = normalizeLogbook(logbook, pilot.uid || logbook?.uid || '');
  const certificate = resolveCertificate(book, pilotDocs);
  const medical = resolveMedical(currencyDoc, pilotDocs, todayMs);
  const ctx = {
    book, certificate, medical, currencyDoc, dutyHours, focusType, todayMs, standards,
  };
  const pic = scorePosition('PIC', standards.positions.PIC, ctx);
  const sic = scorePosition('SIC', standards.positions.SIC, ctx);
  const requested = role === 'SIC' || role === 'PIC' ? role : null;
  const qualifiesFor = [];
  if (pic.tier !== TIER.DOES_NOT_MEET) qualifiesFor.push('PIC');
  if (sic.tier !== TIER.DOES_NOT_MEET) qualifiesFor.push('SIC');
  const active = requested === 'SIC' ? sic : requested === 'PIC' ? pic : (qualifiesFor.includes('PIC') ? pic : sic);
  let tier = TIER.DOES_NOT_MEET;
  if (requested) tier = active.tier;
  else if (qualifiesFor.length === 0) tier = TIER.DOES_NOT_MEET;
  else if (qualifiesFor.some((seat) => (seat === 'SIC' ? sic : pic).tier === TIER.CAUTION)) tier = TIER.CAUTION;
  else tier = TIER.MEETS;

  const recent = [];
  for (const key of ['last90Days', 'last12Months']) {
    const resolved = hourActual(book, key, dutyHours, focusType);
    recent.push({
      key,
      label: key === 'last90Days' ? 'Last 90 days' : 'Last 12 months',
      actual: resolved.actual,
      actualDisplay: formatHours(resolved.actual),
      minimum: null,
      required: false,
      ratio: 1,
      state: 'optional',
      source: resolved.source,
      detail: resolved.detail || '',
    });
  }

  const hoursUpdatedAt = book.hoursMeta?.asOf || book.baseline?.asOf || '';
  const updatedMs = /^\d{4}-\d{2}-\d{2}$/.test(hoursUpdatedAt)
    ? Date.parse(`${hoursUpdatedAt}T00:00:00Z`)
    : null;
  const staleHours = updatedMs != null && todayMs - updatedMs > 92 * 86400000;
  const flags = [];
  if ((certificate.typeRatings || []).length > 0 && certificate.typeVerified !== true) flags.push('Type Not Verified');
  if (!currencyDoc?.uprt?.lastDate && !currencyDoc?.uprtTraining?.lastDate) flags.push('UPRT Not Verified');
  if (!currencyDoc?.enhancedPilotTraining?.lastDate && !currencyDoc?.ept?.lastDate) flags.push('EPT Not Verified');
  if (staleHours) flags.push('Total time last updated more than 3 months ago');

  const unmet = mergeGapAnalysis(pic, sic).filter((row) => !row.picMet || !row.sicMet);
  const reasons = [];
  if (tier === TIER.MEETS && qualifiesFor.length === 2) {
    reasons.push('Meets the PIC and SIC Registered Standard.');
  } else if (tier !== TIER.DOES_NOT_MEET && qualifiesFor.length === 1) {
    reasons.push(`Meets the ${qualifiesFor[0]} Registered Standard.`);
  }
  const explain = requested ? active : (qualifiesFor.includes('PIC') ? pic : active);
  reasons.push(...explain.hardFailures, ...explain.expiring);
  if (requested && requested !== 'PIC' && pic.tier === TIER.DOES_NOT_MEET) {
    reasons.push('Does not meet the PIC standard.');
  }
  if (!reasons.length) reasons.push('Does not meet the PIC or SIC Registered Standard.');

  const gapAnalysis = mergeGapAnalysis(pic, sic);

  return {
    uid: book.uid || pilot.uid || '',
    pilotName: pilot.name || book.pilotName || '',
    role: requested || (qualifiesFor.includes('PIC') ? 'PIC' : qualifiesFor[0] || 'PIC'),
    score: active.score,
    tier,
    tierLabel: TIER_LABELS[tier],
    qualifiesFor,
    positions: {
      PIC: { tier: pic.tier, tierLabel: pic.tierLabel, score: pic.score },
      SIC: { tier: sic.tier, tierLabel: sic.tierLabel, score: sic.score },
    },
    gapAnalysis,
    unmet,
    flags,
    hoursUpdatedAt,
    staleHours,
    usingDefaultStandards: standards.customized !== true,
    standardsNote: standards.sourceNote,
    criteriaName: standards.criteriaName || CRITERIA_NAME,
    criteriaVersion: standards.criteriaVersion || CRITERIA_VERSION,
    weights: standards.weights,
    tiers: standards.tiers,
    reasons,
    experience: [...active.experience, ...recent],
    requirements: active.requirements,
    certificate: {
      level: certificate.level,
      instrument: certificate.instrument,
      multiEngine: certificate.multiEngine,
      typeRatings: certificate.typeRatings,
      typeVerified: certificate.typeVerified,
      country: certificate.country,
      levelSource: certificate.levelSource,
    },
    medical: {
      class: medical.class,
      status: medical.status,
      statusLabel: medicalBrokerLabel(medical.status, medical.daysUntil),
      lastDate: medical.lastDate || '',
      source: medical.source,
    },
    background: {
      employment: book.background.employment,
      accident: book.background.accident,
      enforcement: book.background.enforcement,
    },
    drugAlcohol: {
      enrolled: book.drugAlcohol.enrolled,
      enrolledDate: book.drugAlcohol.enrolledDate,
      programName: book.drugAlcohol.programName,
    },
    timeInType: book.hours.timeInType.map((entry) => ({
      type: entry.type,
      hours: entry.hours,
      picHours: entry.picHours,
    })),
    focusType: focusType || null,
    hoursAsOf: book.hoursMeta?.asOf || book.baseline?.asOf || '',
    baselineAsOf: book.baseline?.asOf || '',
    baselineSource: book.baseline?.source || '',
    hoursNote: book.hoursMeta?.note || '',
    flownSince: book.hoursMeta?.flownSince || null,
    landings: book.hours.landings,
    last6Months: book.hours.last6Months,
  };
}
const BANNED_REPORT_KEYS = [
  'certificateNumber',
  'documentNumber',
  'dob',
  'dateOfBirth',
  'homeAddress',
  'address',
  'fileUrl',
  'filePath',
  'internalNotes',
  'expirationDate',
  'notes',
  'email',
  'phone',
  'wyvern',
  'wyvernId',
];

function assertBrokerSafe(value, path = 'report') {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (BANNED_REPORT_KEYS.includes(key)) {
      throw new Error(`Broker report included ${path}.${key}`);
    }
    if (value[key] && typeof value[key] === 'object') assertBrokerSafe(value[key], `${path}.${key}`);
  }
}

/**
 * The document a broker is allowed to see. Built by copying named fields
 * only — caller objects are never spread into it.
 */
function chipLabel(tier) {
  return tier && tier !== TIER.DOES_NOT_MEET ? 'Meets' : 'Does Not Meet';
}

function scopedGaps(evaluations) {
  if (!evaluations) return null;
  const rows = [];
  for (const seat of ['PIC', 'SIC']) {
    const ev = evaluations[seat];
    if (!ev) continue;
    for (const row of ev.gapAnalysis || []) {
      const met = seat === 'SIC' ? row.sicMet === true : row.picMet === true;
      if (met) continue;
      rows.push({
        label: `${ev.pilotName || seat} · ${row.label}`,
        pilotValue: row.pilotValue,
        picCriteria: row.picCriteria,
        sicCriteria: row.sicCriteria,
        picMet: seat !== 'PIC',
        sicMet: seat !== 'SIC',
      });
    }
  }
  return rows;
}

function yesNoUnknown(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'None';
  return 'Not on file';
}

function addDaysIso(iso, days) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function crewFromEvaluation(ev) {
  const hours = {};
  for (const line of ev?.experience || []) {
    if (!line?.key || line.key === 'timeInType' || line.key === 'picTimeInType') continue;
    hours[line.key] = line.actualDisplay;
  }
  const typeLine = (ev?.experience || []).find((line) => line.key === 'timeInType');
  const picType = (ev?.experience || []).find((line) => line.key === 'picTimeInType');
  return {
    role: ev?.role === 'SIC' ? 'SIC' : 'PIC',
    pilotName: String(ev?.pilotName || '').slice(0, 80),
    status: chipLabel(ev?.tier),
    certificateType: ev?.certificate?.level || 'Not on file',
    country: ev?.certificate?.country || 'Not on file',
    typeRating: asStringList(ev?.certificate?.typeRatings).join(', ') || 'Not on file',
    medicalClass: ev?.medical?.class || 'Not on file',
    lastMedical: ev?.medical?.lastDate || '',
    medicalStatus: ev?.medical?.statusLabel || medicalBrokerLabel(ev?.medical?.status),
    employment: ev?.background?.employment || 'Not on file',
    accident: yesNoUnknown(ev?.background?.accident),
    enforcement: yesNoUnknown(ev?.background?.enforcement),
    hours,
    timeInType: typeLine?.actualDisplay || null,
    picTimeInType: picType?.actualDisplay || null,
    checks: (ev?.requirements || []).filter((line) => line.id !== 'certificate' && line.id !== 'medical').map((line) => ({
      label: line.label,
      status: line.statusLabel,
      completedOn: line.completedOn || '',
    })),
  };
}

/**
 * Broker-facing PASS-style report. Named fields only. Certificate numbers,
 * dates of birth, and addresses are not copied.
 */
export function brokerPilotReport(evaluation, {
  operatorName = '',
  operatorLegalName = '',
  generatedAt = new Date().toISOString(),
  aircraftType = null,
  aircraft = null,
  itinerary = null,
  shareUrl = '',
  evaluations = null,
} = {}) {
  const ev = evaluation || {};
  const bySeat = evaluations || null;
  const picEval = bySeat?.PIC || ev;
  const sicEval = bySeat?.SIC || ev;
  const picCrew = crewFromEvaluation(bySeat?.PIC || { ...ev, role: 'PIC', tier: ev.positions?.PIC?.tier || ev.tier });
  const sicCrew = bySeat?.SIC
    ? crewFromEvaluation(bySeat.SIC)
    : null;
  const crew = sicCrew && sicCrew.pilotName && sicCrew.pilotName !== picCrew.pilotName
    ? [picCrew, sicCrew]
    : [picCrew];
  if (!bySeat && ev.positions) {
    picCrew.status = chipLabel(ev.positions.PIC?.tier);
    if (sicCrew == null) {
      crew[0].sicStatus = chipLabel(ev.positions.SIC?.tier);
    }
  }
  const aircraftBlock = {
    registration: String(aircraft?.registration || aircraft?.tail || '').slice(0, 16),
    type: String(aircraft?.type || aircraftType || '').slice(0, 80),
    serial: String(aircraft?.serial || aircraft?.serialNumber || '').slice(0, 40),
    year: String(aircraft?.year || '').slice(0, 8),
    seats: aircraft?.seats == null ? '' : String(aircraft.seats).slice(0, 8),
    insuranceExpiry: String(aircraft?.insuranceExpiry || '').slice(0, 20),
  };
  const hasAircraft = Boolean(aircraftBlock.registration || aircraftBlock.type);
  const report = {
    reportTitle: 'Pilot Report',
    criteriaName: ev.criteriaName || CRITERIA_NAME,
    criteriaVersion: ev.criteriaVersion || CRITERIA_VERSION,
    operatorName: String(operatorName || '').slice(0, 80),
    operatorLegalName: String(operatorLegalName || '').slice(0, 120),
    pilotName: picCrew.pilotName,
    role: ev.role === 'SIC' ? 'SIC' : 'PIC',
    aircraftType: aircraftBlock.type || null,
    generatedAt: String(generatedAt),
    expiresAt: addDaysIso(generatedAt, 90),
    shareUrl: String(shareUrl || '').slice(0, 300),
    hoursAsOf: ev.hoursAsOf || '',
    baselineAsOf: ev.baselineAsOf || '',
    hoursNote: String(ev.hoursNote || '').slice(0, 400),
    landings: ev.landings == null ? null : ev.landings,
    last6Months: ev.last6Months == null ? null : formatHours(ev.last6Months),
    score: Number.isFinite(ev.score) ? ev.score : 0,
    tier: TIER_LABELS[ev.tier] ? ev.tier : TIER.DOES_NOT_MEET,
    tierLabel: TIER_LABELS[ev.tier] || TIER_LABELS.doesNotMeet,
    qualifiesFor: Array.isArray(ev.qualifiesFor) ? ev.qualifiesFor.filter((seat) => seat === 'PIC' || seat === 'SIC') : [],
    standardsNote: String(ev.standardsNote || DEFAULT_STANDARDS_NOTE).slice(0, 400),
    usingDefaultStandards: ev.usingDefaultStandards !== false,
    summary: Array.isArray(ev.reasons) ? ev.reasons.map((line) => String(line)).slice(0, 24) : [],
    flags: Array.isArray(ev.flags) ? ev.flags.map((flag) => String(flag).slice(0, 80)).slice(0, 12) : [],
    waivers: [],
    chips: [
      { id: 'operator', label: 'Operator', status: operatorName ? 'Meets' : 'Does Not Meet' },
      ...(hasAircraft ? [{ id: 'aircraft', label: 'Aircraft', status: 'Meets' }] : []),
      { id: 'pic', label: 'PIC', status: chipLabel(bySeat?.PIC?.tier || ev.positions?.PIC?.tier || (ev.role === 'SIC' ? null : ev.tier)) },
      { id: 'sic', label: 'SIC', status: chipLabel(bySeat?.SIC?.tier || ev.positions?.SIC?.tier || (ev.role === 'SIC' ? ev.tier : null)) },
    ],
    operator: {
      name: String(operatorName || '').slice(0, 80),
      legalName: String(operatorLegalName || '').slice(0, 120),
    },
    itinerary: itinerary && (itinerary.from || itinerary.to) ? {
      from: String(itinerary.from || '').slice(0, 8),
      to: String(itinerary.to || '').slice(0, 8),
      date: String(itinerary.date || '').slice(0, 40),
      tail: String(itinerary.tail || aircraftBlock.registration || '').slice(0, 16),
    } : null,
    aircraft: aircraftBlock,
    crew,
    gapAnalysis: (scopedGaps(bySeat) || ev.gapAnalysis || []).slice(0, 40).map((row) => ({
      label: String(row.label || '').slice(0, 120),
      pilotValue: String(row.pilotValue || '').slice(0, 80),
      picCriteria: String(row.picCriteria || '').slice(0, 40),
      sicCriteria: String(row.sicCriteria || '').slice(0, 40),
      picMet: row.picMet === true,
      sicMet: row.sicMet === true,
    })),
    certificate: {
      level: ev.certificate?.level || 'Not on file',
      instrument: ev.certificate?.instrument === true ? 'Yes' : ev.certificate?.instrument === false ? 'No' : 'Not on file',
      multiEngine: ev.certificate?.multiEngine === true ? 'Yes' : ev.certificate?.multiEngine === false ? 'No' : 'Not on file',
      typeRatings: asStringList(ev.certificate?.typeRatings),
      country: ev.certificate?.country || 'Not on file',
    },
    medical: {
      class: ev.medical?.class || 'Not on file',
      status: ev.medical?.statusLabel || medicalBrokerLabel(ev.medical?.status),
      lastMedical: ev.medical?.lastDate || '',
    },
    hours: (ev.experience || []).filter((line) => line.required && line.key !== 'timeInType' && line.key !== 'picTimeInType').map((line) => ({
      label: line.label,
      hours: line.actualDisplay,
      minimum: line.minimum,
      state: line.state,
      source: line.source === 'duty' ? 'Duty records' : line.source === 'logbook' || line.source === 'derived' ? 'Logbook' : 'Not on file',
    })),
    timeInType: (ev.timeInType || []).map((entry) => ({
      type: String(entry.type || '').slice(0, 40),
      hours: formatHours(entry.hours),
      picHours: formatHours(entry.picHours),
    })),
    requirements: (ev.requirements || []).filter((line) => line.included).map((line) => ({
      label: line.label,
      status: line.statusLabel,
      completedOn: line.completedOn,
      dueOn: line.id === 'medical' ? null : line.dueOn,
    })),
  };
  assertBrokerSafe(report);
  return report;
}

function normalizePersonName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function matchCrewUser(displayName, users) {
  const target = normalizePersonName(displayName);
  if (!target) return null;
  const list = Array.isArray(users) ? users : [];
  const exact = list.find((user) => normalizePersonName(user?.name) === target);
  if (exact) return exact;
  const parts = target.split(' ');
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return list.find((user) => {
    const tokens = normalizePersonName(user?.name).split(' ');
    return tokens[0] === first && tokens[tokens.length - 1] === last;
  }) || null;
}

/**
 * One PASS-style report for the trip. PIC and SIC are scored against the
 * seat they are assigned, so a PIC-only line check is not charged to the SIC.
 * The same pilot in the same seat on two legs appears once.
 */
export function buildBrokerCrewReports({
  legs = [],
  aircraftType = null,
  aircraft = null,
  itinerary = null,
  shareUrl = '',
  users = [],
  logbooksByUid = {},
  currenciesByUid = {},
  pilotDocsByUid = {},
  standards = null,
  dutyHoursByUid = {},
  operator = {},
  generatedAt = new Date().toISOString(),
  todayMs = Date.now(),
} = {}) {
  const seats = [];
  const seen = new Set();
  for (const leg of legs || []) {
    const type = leg?.aircraftType || aircraftType || null;
    const add = (name, role) => {
      const clean = String(name || '').trim();
      if (!clean) return;
      const key = `${role}:${normalizePersonName(clean)}`;
      if (seen.has(key)) return;
      seen.add(key);
      seats.push({ name: clean, role, aircraftType: type });
    };
    add(leg?.pic ?? leg?.picName, 'PIC');
    add(leg?.sic ?? leg?.sicName, 'SIC');
  }
  if (seats.length === 0) return [];

  const evaluations = {};
  for (const seat of seats) {
    const user = matchCrewUser(seat.name, users);
    const uid = user?.uid || '';
    const evaluation = evaluatePilot({
      pilot: { uid, name: seat.name },
      logbook: uid ? logbooksByUid[uid] : null,
      currencyDoc: uid ? currenciesByUid[uid] : null,
      pilotDocs: uid ? pilotDocsByUid[uid] : [],
      standards,
      dutyHours: uid ? dutyHoursByUid[uid] : null,
      role: seat.role,
      focusType: seat.aircraftType,
      todayMs,
    });
    evaluation.pilotName = seat.name;
    evaluations[seat.role] = evaluation;
  }

  const leg = (legs || []).find((item) => item?.from || item?.to || item?.origin) || legs?.[0] || {};
  const route = itinerary || (leg.from || leg.to || leg.origin || leg.destination ? {
    from: leg.from || leg.origin || '',
    to: leg.to || leg.destination || '',
    date: leg.date || leg.departDate || '',
    tail: leg.tail || aircraft?.registration || aircraft?.tail || '',
  } : null);

  return [brokerPilotReport(evaluations.PIC || evaluations.SIC, {
    operatorName: operator.name || operator.operatorName || '',
    operatorLegalName: operator.legalName || operator.operatorLegalName || '',
    generatedAt,
    aircraftType: aircraftType || seats.find((seat) => seat.aircraftType)?.aircraftType || null,
    aircraft,
    itinerary: route,
    shareUrl,
    evaluations,
  })];
}
