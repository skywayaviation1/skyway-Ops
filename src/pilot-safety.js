/**
 * Pilot safety rating.
 *
 * Pure scoring for a Part 135 charter crewmember. Hour minimums and which
 * requirements count are operator settings (app-config/pilot-safety). The
 * numbers shipped here are industry-typical charter defaults — a starting
 * point an admin can replace — and are not a WYVERN Ltd PASS / Wingman score.
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
  meets: 'Meets Standard',
  caution: 'Caution',
  doesNotMeet: 'Does Not Meet',
});

export const HOUR_FIELDS = Object.freeze([
  { key: 'totalTime', label: 'Total time', minimum: 2500, required: true },
  { key: 'pic', label: 'Pilot in command', minimum: 1500, required: true },
  { key: 'sic', label: 'Second in command', minimum: 500, required: false },
  { key: 'multiEngine', label: 'Multi-engine', minimum: 500, required: true },
  { key: 'turbine', label: 'Turbine', minimum: 500, required: true },
  { key: 'night', label: 'Night', minimum: 100, required: true },
  { key: 'instrument', label: 'Instrument', minimum: 75, required: true },
  { key: 'last90Days', label: 'Last 90 days', minimum: 15, required: true },
  { key: 'last12Months', label: 'Last 12 months', minimum: 100, required: true },
  { key: 'timeInType', label: 'Time in type', minimum: 100, required: true, perType: true },
]);

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
  'Industry-typical Part 135 turbine charter defaults. Not a WYVERN Ltd PASS or Wingman score. Replace these when the operator’s own or Wyvern criteria are confirmed.';

function hourDefaults() {
  const minimums = {};
  const required = {};
  for (const field of HOUR_FIELDS) {
    minimums[field.key] = field.minimum;
    required[field.key] = field.required;
  }
  return { minimums, required };
}

function requirementDefaults() {
  return REQUIREMENT_CATALOG.map((item) => ({
    id: item.id,
    label: item.label,
    required: item.required !== false,
  }));
}

const hourSeed = hourDefaults();

export const DEFAULT_PILOT_SAFETY_STANDARDS = Object.freeze({
  customized: false,
  sourceNote: DEFAULT_STANDARDS_NOTE,
  standingRole: 'PIC',
  weights: Object.freeze({ experience: 55, requirements: 45 }),
  tiers: Object.freeze({ meetsAt: 85, cautionAt: 70 }),
  certificate: Object.freeze({
    minimumLevel: 'Commercial',
    requireInstrument: true,
    requireMultiEngine: true,
  }),
  hours: Object.freeze({
    minimums: Object.freeze({ ...hourSeed.minimums }),
    required: Object.freeze({ ...hourSeed.required }),
  }),
  requirements: Object.freeze(requirementDefaults().map((item) => Object.freeze({ ...item }))),
});

function cloneDefaults() {
  return {
    customized: false,
    sourceNote: DEFAULT_STANDARDS_NOTE,
    standingRole: 'PIC',
    weights: { ...DEFAULT_PILOT_SAFETY_STANDARDS.weights },
    tiers: { ...DEFAULT_PILOT_SAFETY_STANDARDS.tiers },
    certificate: { ...DEFAULT_PILOT_SAFETY_STANDARDS.certificate },
    hours: {
      minimums: { ...DEFAULT_PILOT_SAFETY_STANDARDS.hours.minimums },
      required: { ...DEFAULT_PILOT_SAFETY_STANDARDS.hours.required },
    },
    requirements: DEFAULT_PILOT_SAFETY_STANDARDS.requirements.map((item) => ({ ...item })),
  };
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

  for (const field of HOUR_FIELDS) {
    const minimum = finiteNumber(raw.hours?.minimums?.[field.key]);
    if (minimum != null) standards.hours.minimums[field.key] = minimum;
    if (typeof raw.hours?.required?.[field.key] === 'boolean') {
      standards.hours.required[field.key] = raw.hours.required[field.key];
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
      multiEngine: null,
      turbine: null,
      night: null,
      instrument: null,
      last90Days: null,
      last12Months: null,
      timeInType: [],
    },
    certificate: {
      level: '',
      instrument: null,
      multiEngine: null,
      typeRatings: [],
    },
    drugAlcohol: {
      enrolled: null,
      enrolledDate: '',
      programName: '',
    },
    internalNotes: '',
    wyvern: null,
  };
}

function normalizeWyvernStamp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const importedAt = Number(raw.importedAt);
  const stamp = {
    id: String(raw.id || '').trim().slice(0, 80),
    source: 'Wyvern',
    importedAt: Number.isFinite(importedAt) ? importedAt : null,
    hoursAsOf: /^\d{4}-\d{2}-\d{2}$/.test(raw.hoursAsOf || '') ? raw.hoursAsOf : '',
    verificationStatus: String(raw.verificationStatus || '').slice(0, 80),
    position: String(raw.position || '').slice(0, 40),
  };
  const empty = !stamp.id
    && stamp.importedAt == null
    && !stamp.hoursAsOf
    && !stamp.verificationStatus
    && !stamp.position;
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
  for (const field of HOUR_FIELDS) {
    if (field.perType) continue;
    book.hours[field.key] = finiteNumber(raw.hours?.[field.key]);
  }
  const types = Array.isArray(raw.hours?.timeInType) ? raw.hours.timeInType : [];
  book.hours.timeInType = types.slice(0, 24).map((entry) => ({
    type: String(entry?.type || '').trim().slice(0, 40),
    hours: finiteNumber(entry?.hours),
  })).filter((entry) => entry.type);
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
  const enrolled = raw.drugAlcohol?.enrolled;
  book.drugAlcohol.enrolled = enrolled === true ? true : enrolled === false ? false : null;
  book.drugAlcohol.enrolledDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.drugAlcohol?.enrolledDate || '')
    ? raw.drugAlcohol.enrolledDate
    : '';
  book.drugAlcohol.programName = String(raw.drugAlcohol?.programName || '').slice(0, 80);
  book.internalNotes = String(raw.internalNotes || '').slice(0, 2000);
  book.wyvern = normalizeWyvernStamp(raw.wyvern);
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

export function brokerStatusLabel(status) {
  switch (status) {
    case 'current':
    case 'noExpiration':
      return 'Current';
    case 'caution':
    case 'warning':
    case 'critical':
      return 'Expiring soon';
    case 'expired':
      return 'Expired';
    default:
      return 'Not on file';
  }
}

export function medicalBrokerLabel(status) {
  switch (status) {
    case 'current':
    case 'noExpiration':
      return 'Valid';
    case 'caution':
    case 'warning':
    case 'critical':
      return 'Expiring soon';
    case 'expired':
      return 'Expired';
    default:
      return 'Not on file';
  }
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
  return { level, instrument, multiEngine, typeRatings, levelSource };
}

function resolveMedical(currencyDoc, pilotDocs, todayMs) {
  const fromCurrency = currencyDoc?.medical;
  if (fromCurrency?.expirationDate || fromCurrency?.class) {
    const status = computeMedicalStatus(fromCurrency, todayMs);
    return {
      class: medicalClassLabel(fromCurrency.class) || '',
      status: status.status,
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
    return { class: med.class, status: status.status, source: 'medical-certificate' };
  }
  return { class: '', status: 'unknown', source: 'missing' };
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

/**
 * Score one pilot.
 *
 * Tier is rule-based, on purpose:
 *   Does Not Meet — a required hour is missing or short, a required item is
 *     expired or not on file, the certificate is below the minimum, or the
 *     drug and alcohol program is not confirmed.
 *   Caution — nothing above, but a required item is expiring soon.
 *   Meets Standard — every required hour is met and every required item is current.
 * The 0–100 score is the weighted average of those same inputs so the
 * breakdown and the number describe one thing. Thresholds in settings are
 * the operator’s published bands; the rules above decide the tier.
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
  const seat = role === 'SIC' || role === 'PIC' ? role : standards.standingRole;
  const certificate = resolveCertificate(book, pilotDocs);
  const medical = resolveMedical(currencyDoc, pilotDocs, todayMs);

  const experience = [];
  for (const field of HOUR_FIELDS) {
    const required = standards.hours.required[field.key] !== false;
    const minimum = standards.hours.minimums[field.key];
    let actual = null;
    let source = 'missing';
    let detail = '';
    if (field.perType) {
      const resolved = timeInTypeActual(book.hours.timeInType, focusType);
      actual = resolved.actual;
      source = resolved.source === 'logbook' ? 'logbook' : 'missing';
      if (focusType && resolved.matchedType) detail = resolved.matchedType;
      else if (focusType) detail = `No entry for ${focusType}`;
      else if (resolved.matchedType) detail = `Best type on file: ${resolved.matchedType}`;
    } else if (book.hours[field.key] != null) {
      actual = book.hours[field.key];
      source = 'logbook';
    } else if ((field.key === 'last90Days' || field.key === 'last12Months') && dutyHours?.[field.key] != null) {
      actual = dutyHours[field.key];
      source = 'duty';
      detail = 'From duty flight time';
    }
    const ratio = !required
      ? 1
      : actual == null || minimum == null
        ? 0
        : Math.max(0, Math.min(1, actual / (minimum || 1)));
    let state = 'meets';
    if (!required) state = 'optional';
    else if (actual == null) state = 'missing';
    else if (minimum != null && actual < minimum) state = 'short';
    experience.push({
      key: field.key,
      label: field.label,
      actual,
      actualDisplay: formatHours(actual),
      minimum: required ? minimum : null,
      required,
      ratio,
      state,
      source,
      detail,
    });
  }

  const savedById = Object.fromEntries(standards.requirements.map((item) => [item.id, item]));
  const requirements = [];
  for (const defn of REQUIREMENT_CATALOG) {
    const saved = savedById[defn.id] || { id: defn.id, label: defn.label, required: true };
    const included = requirementApplies(defn, saved, seat, standards);
    let status = 'na';
    let completedOn = null;
    let dueOn = null;
    let detail = '';
    if (included) {
      if (defn.kind === 'medical') {
        status = medical.status;
        detail = medical.class ? `${medical.class} class` : '';
      } else if (defn.kind === 'certificate') {
        const needed = levelRank(standards.certificate.minimumLevel);
        if (!certificate.level) status = 'unknown';
        else if (levelRank(certificate.level) >= needed) status = 'current';
        else status = 'expired';
        detail = certificate.level || 'Not on file';
      } else if (defn.kind === 'instrumentRating') {
        status = certificate.instrument === true ? 'current' : certificate.instrument === false ? 'expired' : 'unknown';
        detail = certificate.instrument === true ? 'Held' : certificate.instrument === false ? 'Not held' : 'Not on file';
      } else if (defn.kind === 'multiEngineRating') {
        status = certificate.multiEngine === true ? 'current' : certificate.multiEngine === false ? 'expired' : 'unknown';
        detail = certificate.multiEngine === true ? 'Held' : certificate.multiEngine === false ? 'Not held' : 'Not on file';
      } else if (defn.kind === 'drugAlcohol') {
        if (book.drugAlcohol.enrolled === true) status = 'current';
        else if (book.drugAlcohol.enrolled === false) status = 'expired';
        else status = 'unknown';
        completedOn = book.drugAlcohol.enrolledDate || null;
        detail = book.drugAlcohol.enrolled === true
          ? (book.drugAlcohol.programName || 'Enrolled')
          : book.drugAlcohol.enrolled === false
            ? 'Not enrolled'
            : 'Not on file';
      } else if (defn.kind === 'currency') {
        const result = checkResult(currencyDoc, defn.key, todayMs);
        status = result.status;
        dueOn = result.dueDate || null;
        completedOn = currencyDoc?.[defn.key]?.lastDate || null;
      } else if (defn.kind === 'currency-group') {
        const result = groupResult(currencyDoc, defn.keys, todayMs);
        status = result.status;
        dueOn = result.dueDate || null;
        completedOn = result.completedOn || null;
      }
    }
    const credit = !included ? null : (STATUS_CREDIT[status] ?? 0);
    requirements.push({
      id: defn.id,
      label: saved.label || defn.label,
      included,
      required: saved.required !== false,
      status,
      statusLabel: included ? (
        defn.kind === 'medical' ? medicalBrokerLabel(status) : brokerStatusLabel(status)
      ) : 'N/A',
      credit,
      completedOn,
      dueOn,
      detail,
      picOnly: defn.picOnly === true,
    });
  }

  const expLines = experience.filter((line) => line.required);
  const reqLines = requirements.filter((line) => line.included);
  const rawScore = scoreExperience(expLines, standards.weights.experience)
    + scoreRequirements(reqLines, standards.weights.requirements);
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const hardFailures = [];
  for (const line of expLines) {
    if (line.state === 'missing') hardFailures.push(`${line.label} is not on file.`);
    else if (line.state === 'short') {
      hardFailures.push(`${line.label} is ${line.actualDisplay}, below the ${line.minimum} minimum.`);
    }
  }
  const expiring = [];
  for (const line of reqLines) {
    if (line.status === 'expired') {
      hardFailures.push(`${line.label} is expired${line.dueOn ? ` (due ${line.dueOn})` : ''}.`);
    } else if (line.status === 'unknown') {
      hardFailures.push(`${line.label} is not on file.`);
    } else if (['caution', 'warning', 'critical'].includes(line.status)) {
      expiring.push(`${line.label} is expiring soon${line.dueOn ? ` (due ${line.dueOn})` : ''}.`);
    }
  }

  let tier = TIER.MEETS;
  if (hardFailures.length > 0) tier = TIER.DOES_NOT_MEET;
  else if (expiring.length > 0) tier = TIER.CAUTION;

  const reasons = tier === TIER.MEETS
    ? ['Every required hour minimum is met and every required item is current.']
    : [...hardFailures, ...expiring];

  return {
    uid: book.uid || pilot.uid || '',
    pilotName: pilot.name || book.pilotName || '',
    role: seat,
    score,
    tier,
    tierLabel: TIER_LABELS[tier],
    usingDefaultStandards: standards.customized !== true,
    standardsNote: standards.sourceNote,
    weights: standards.weights,
    tiers: standards.tiers,
    reasons,
    experience,
    requirements,
    certificate: {
      level: certificate.level,
      instrument: certificate.instrument,
      multiEngine: certificate.multiEngine,
      typeRatings: certificate.typeRatings,
      levelSource: certificate.levelSource,
    },
    medical: {
      class: medical.class,
      status: medical.status,
      statusLabel: medicalBrokerLabel(medical.status),
      source: medical.source,
    },
    drugAlcohol: {
      enrolled: book.drugAlcohol.enrolled,
      enrolledDate: book.drugAlcohol.enrolledDate,
      programName: book.drugAlcohol.programName,
    },
    timeInType: book.hours.timeInType.map((entry) => ({
      type: entry.type,
      hours: entry.hours,
    })),
    focusType: focusType || null,
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
export function brokerPilotReport(evaluation, {
  operatorName = '',
  operatorLegalName = '',
  generatedAt = new Date().toISOString(),
  aircraftType = null,
} = {}) {
  const ev = evaluation || {};
  const report = {
    operatorName: String(operatorName || '').slice(0, 80),
    operatorLegalName: String(operatorLegalName || '').slice(0, 120),
    pilotName: String(ev.pilotName || '').slice(0, 80),
    role: ev.role === 'SIC' ? 'SIC' : 'PIC',
    aircraftType: aircraftType ? String(aircraftType).slice(0, 80) : null,
    generatedAt: String(generatedAt),
    score: Number.isFinite(ev.score) ? ev.score : 0,
    tier: TIER_LABELS[ev.tier] ? ev.tier : TIER.DOES_NOT_MEET,
    tierLabel: TIER_LABELS[ev.tier] || TIER_LABELS.doesNotMeet,
    standardsNote: String(ev.standardsNote || DEFAULT_STANDARDS_NOTE).slice(0, 400),
    usingDefaultStandards: ev.usingDefaultStandards !== false,
    summary: Array.isArray(ev.reasons) ? ev.reasons.map((line) => String(line)).slice(0, 24) : [],
    certificate: {
      level: ev.certificate?.level || 'Not on file',
      instrument: ev.certificate?.instrument === true ? 'Yes' : ev.certificate?.instrument === false ? 'No' : 'Not on file',
      multiEngine: ev.certificate?.multiEngine === true ? 'Yes' : ev.certificate?.multiEngine === false ? 'No' : 'Not on file',
      typeRatings: asStringList(ev.certificate?.typeRatings),
    },
    medical: {
      class: ev.medical?.class || 'Not on file',
      status: ev.medical?.statusLabel || medicalBrokerLabel(ev.medical?.status),
    },
    hours: (ev.experience || []).filter((line) => line.required && line.key !== 'timeInType').map((line) => ({
      label: line.label,
      hours: line.actualDisplay,
      minimum: line.minimum,
      state: line.state,
      source: line.source === 'duty' ? 'Duty records' : line.source === 'logbook' ? 'Logbook' : 'Not on file',
    })),
    timeInType: (ev.timeInType || []).map((entry) => ({
      type: String(entry.type || '').slice(0, 40),
      hours: formatHours(entry.hours),
    })),
    timeInTypeScored: (ev.experience || []).find((line) => line.key === 'timeInType')
      ? {
          hours: (ev.experience || []).find((line) => line.key === 'timeInType').actualDisplay,
          minimum: (ev.experience || []).find((line) => line.key === 'timeInType').minimum,
          state: (ev.experience || []).find((line) => line.key === 'timeInType').state,
          detail: (ev.experience || []).find((line) => line.key === 'timeInType').detail || '',
        }
      : null,
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
 * One sanitized report per assigned seat on a trip. The same pilot in the
 * same seat on two legs appears once. PIC and SIC are scored against that
 * seat, so a PIC-only line check is not charged to the SIC.
 */
export function buildBrokerCrewReports({
  legs = [],
  aircraftType = null,
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

  return seats.map((seat) => {
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
    return brokerPilotReport(evaluation, {
      operatorName: operator.name || operator.operatorName || '',
      operatorLegalName: operator.legalName || operator.operatorLegalName || '',
      generatedAt,
      aircraftType: seat.aircraftType,
    });
  });
}
