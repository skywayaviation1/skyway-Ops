// Wyvern ACES pilot export → pilot logbook + currency.
//
// The export's field names are not stable, so this accepts a JSON array (or an
// object with pilots/records/data/crew) and a CSV with a header row. Aliases
// cover the names the owner described. Only pilots marked active are imported.
// Certificate numbers, dates of birth, addresses, and document files are never
// copied onto the logbook or the currency record.

import { parseAirmanCertificate, normalizeLogbook } from './pilot-safety.js';

export const WYVERN_SOURCE = 'Wyvern';

const HOUR_KEYS = [
  'totalTime', 'pic', 'sic', 'fixedWing', 'picFixedWing', 'rotorWing', 'singleEngine', 'multiEngine',
  'picMultiEngine', 'multiEngine90', 'multiEngine12', 'turbine', 'night', 'instrument', 'last90Days', 'last12Months',
  'landings', 'landings90', 'landings12',
];

const CHECK_KEYS = new Set([
  'groundOralGeneral293a',
  'groundOral293a_LR60',
  'groundOral293a_CE525',
  'groundOral293a_SF50',
  'groundOral293a_untyped',
  'sim293b_LR60',
  'sim293b_CE525',
  'sim293b_SF50',
  'sim293b_untyped',
  'competencyCheck293',
  'instrumentCheck297',
  'lineCheck299',
  'recurrentTraining351',
  'crmTraining330',
  'hazmatTraining',
  'tfsspTraining',
  'basicIndoctrination',
  'uprt',
  'enhancedPilotTraining',
  'internationalProcedures',
]);

const EVENT_RULES = [
  { id: 'groundOral293', patterns: [/135293.*(?:oral|written|ground)/, /groundoral/, /293written/, /293oral/] },
  { id: 'aircraftKnowledge293', patterns: [/135293.*aircraft/, /aircraftknowledge/, /293a2/, /293a3/] },
  { id: 'competency293', patterns: [/135293b/, /135293.*competen/, /293checkride/, /competencycheck/, /^simulator/, /checkride293/] },
  { id: 'instrumentCheck297', patterns: [/135297/, /instrumentproficiency/, /(^|[^a-z])ipc([^a-z]|$)/] },
  { id: 'lineCheck299', patterns: [/135299/, /linecheck/] },
  { id: 'recurrent', patterns: [/135351/, /recurrent/] },
  { id: 'crm', patterns: [/135330/, /^crm/, /crewresourcemanagement/] },
  { id: 'hazmat', patterns: [/hazmat/, /hazardousmaterial/, /dangerousgoods/] },
  { id: 'security', patterns: [/tfssp/, /securitytraining/, /135505/] },
  { id: 'drugAlcohol', patterns: [/drugandalcohol/, /drugprogram/, /alcoholprogram/, /part120/] },
];

function normKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pick(obj, aliases) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const map = new Map();
  for (const [key, value] of Object.entries(obj)) map.set(normKey(key), value);
  for (const alias of aliases) {
    if (map.has(alias)) return map.get(alias);
  }
  return undefined;
}

export function parseWyvernDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(`${candidate}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
      ? candidate
      : '';
  }
  const us = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!us) return '';
  let year = Number(us[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  const candidate = `${year}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : '';
}

function parseHours(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const n = Number(String(value).replace(/,/g, '').replace(/\b(hrs?|hours?)\b/ig, '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseBool(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'enrolled'].includes(text)) return true;
  if (['no', 'n', 'false', '0', 'notenrolled', 'not enrolled'].includes(text)) return false;
  return null;
}

export function isActiveWyvernStatus(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  if (/\b(inactive|terminated|archived|suspended|former|separated|resigned)\b/.test(text)) return false;
  if (['no', 'n', 'false'].includes(text)) return false;
  if (/\bactive\b/.test(text) || ['current', 'employed', 'yes', 'y', 'true', '1'].includes(text)) return true;
  return false;
}

function displayName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  const comma = text.match(/^([^,]+),\s*(.+)$/);
  if (!comma) return text;
  return `${comma[2]} ${comma[1]}`.replace(/\s+/g, ' ').trim();
}

export function normalizePersonName(value) {
  const tokens = displayName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const collapsed = [];
  for (const token of tokens) {
    if (collapsed[collapsed.length - 1] !== token) collapsed.push(token);
  }
  return collapsed.join(' ');
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.includes('@') ? text : '';
}

function namesMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const a = left.split(' ');
  const b = right.split(' ');
  if (a.length < 2 || b.length < 2) return false;
  if (a[0] !== b[0] || a[a.length - 1] !== b[b.length - 1]) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longSet = new Set(longer);
  return shorter.every((token) => longSet.has(token));
}

function userNames(user) {
  return [user?.name, user?.displayName, user?.jetinsightName]
    .map(normalizePersonName)
    .filter(Boolean);
}

function normalizeMedicalClass(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === '1' || text.includes('first') || text.includes('class 1') || text.includes('class i') || text.includes('1st')) return 'First';
  if (text === '2' || text.includes('second') || text.includes('class 2') || text.includes('class ii') || text.includes('2nd')) return 'Second';
  if (text === '3' || text.includes('third') || text.includes('class 3') || text.includes('class iii') || text.includes('3rd')) return 'Third';
  if (text.includes('basic')) return 'BasicMed';
  return '';
}

function familyOf(type) {
  const n = String(type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return 'untyped';
  if (n.includes('lr60') || n.includes('lear60') || n.includes('learjet60')) return 'LR60';
  if (n.includes('sf50') || n.includes('visionjet')) return 'SF50';
  if (n.includes('ce525') || n.includes('c525') || /cj[1-4]/.test(n) || n.includes('citationcj')) return 'CE525';
  return 'untyped';
}

function familiesFor(types) {
  const known = [...new Set((types || []).map(familyOf).filter((family) => family !== 'untyped'))];
  return known.length ? known : ['untyped'];
}

function keysForEvent(id, families) {
  const list = families.length ? families : ['untyped'];
  if (id === 'groundOral293') return ['groundOralGeneral293a'];
  if (id === 'aircraftKnowledge293') return list.map((family) => `groundOral293a_${family}`);
  if (id === 'competency293') {
    return list.map((family) => (family === 'untyped' ? 'competencyCheck293' : `sim293b_${family}`));
  }
  if (id === 'instrumentCheck297') return ['instrumentCheck297'];
  if (id === 'lineCheck299') return ['lineCheck299'];
  if (id === 'recurrent') return ['recurrentTraining351'];
  if (id === 'crm') return ['crmTraining330'];
  if (id === 'hazmat') return ['hazmatTraining'];
  if (id === 'security') return ['tfsspTraining'];
  return [];
}

function eventIdFromStem(stem) {
  if (!stem) return null;
  for (const rule of EVENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(stem))) return rule.id;
  }
  return null;
}

function emptyHours() {
  return {
    totalTime: null,
    pic: null,
    sic: null,
    fixedWing: null,
    rotorWing: null,
    singleEngine: null,
    multiEngine: null,
    picMultiEngine: null,
    multiEngine90: null,
    multiEngine12: null,
    picFixedWing: null,
    turbine: null,
    night: null,
    instrument: null,
    last90Days: null,
    last12Months: null,
    landings: null,
    landings90: null,
    landings12: null,
    timeInType: [],
  };
}

function readHourBag(raw) {
  const nested = pick(raw, ['flighthours', 'flighthour', 'flighttime', 'hours', 'experience', 'hoursummary']);
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : raw;
}

const HOUR_ALIASES = {
  totalTime: ['totaltime', 'totalhours', 'totalt', 'tt', 'total'],
  pic: ['pic', 'pichours', 'pilotincommand', 'commandhours'],
  sic: ['sic', 'sichours', 'secondincommand'],
  fixedWing: ['fixedwing', 'fixedwinghours', 'airplane', 'fw'],
  rotorWing: ['rotorwing', 'rotor', 'helicopter', 'rw'],
  singleEngine: ['singleengine', 'singleenginehours', 'sel'],
  multiEngine: ['multiengine', 'multienginehours', 'me', 'melhours'],
  multiEngine90: ['multiengine90', 'multienginelast90', 'melast90', 'me90'],
  multiEngine12: ['multiengine12', 'multienginelast12', 'multienginelast365', 'melast365', 'me12'],
  turbine: ['turbine', 'turbinehours'],
  night: ['night', 'nighthours'],
  instrument: ['instrument', 'instrumenthours', 'actualinstrument', 'hood'],
  last90Days: ['last90days', 'last90', 'hours90', 'ninetyday', 'ninetydays', 'day90'],
  last12Months: ['last12months', 'last12', 'hours12', 'twelvemonth', 'twelvemonths', 'month12'],
};

function readTimeInType(bag, raw) {
  const direct = pick(bag, ['timeintype', 'hoursbytype', 'hoursbyaircraft', 'aircrafthours', 'bytype'])
    ?? pick(raw, ['timeintype', 'hoursbytype', 'hoursbyaircraft', 'aircrafthours', 'bytype']);
  const rows = [];
  if (Array.isArray(direct)) {
    for (const entry of direct) {
      if (typeof entry === 'string') continue;
      const type = String(pick(entry, ['type', 'aircraft', 'aircrafttype', 'name']) || '').trim();
      const hours = parseHours(pick(entry, ['hours', 'time', 'total', 'totaltime']));
      const picHours = parseHours(pick(entry, ['pichours', 'pic', 'pictime', 'pictimeintype']));
      if (type && hours != null) {
        rows.push({ type: type.slice(0, 80), hours, ...(picHours != null ? { picHours } : {}) });
      }
    }
  } else if (direct && typeof direct === 'object') {
    for (const [type, hours] of Object.entries(direct)) {
      const parsed = parseHours(hours);
      if (type && parsed != null) rows.push({ type: type.slice(0, 80), hours: parsed });
    }
  }
  return rows.slice(0, 24);
}

function cleanTypeName(value) {
  const text = String(value || '').trim();
  if (!text || /^\d{4,}$/.test(text)) return '';
  if (/certificate\s*(no|number)|passport|date of birth|\bdob\b/i.test(text)) return '';
  return text.slice(0, 80);
}

function readTypeRatings(source) {
  const direct = pick(source, ['typeratings', 'typerating', 'ratingsheld', 'aircraftqualifications']);
  const rows = [];
  const push = (value) => {
    const clean = cleanTypeName(value);
    if (clean && !/instrument|multi[-\s]?engine|\batp\b|commercial|private/i.test(clean)) rows.push(clean);
  };
  if (Array.isArray(direct)) {
    for (const entry of direct) {
      if (typeof entry === 'string') push(entry);
      else push(pick(entry, ['type', 'aircraft', 'name', 'rating']));
    }
  } else if (typeof direct === 'string') {
    direct.split(/[,;\n]/).forEach(push);
  }
  return [...new Set(rows)].slice(0, 24);
}

function ratingsBlob(source) {
  const value = pick(source, ['ratings', 'ratingstext', 'certificatesandratings']);
  return typeof value === 'string' ? value : '';
}

function readChecks(raw, aircraftTypes) {
  const checks = {};
  const families = familiesFor(aircraftTypes);
  const apply = (id, completedOn, dueOn, aircraft) => {
    if (id === 'drugAlcohol') return { drug: true, completedOn };
    const eventFamilies = aircraft ? [familyOf(aircraft)] : families;
    for (const key of keysForEvent(id, eventFamilies)) {
      if (!CHECK_KEYS.has(key)) continue;
      const prev = checks[key] || { completedOn: '', dueOn: '', dueSource: '', intervalKey: 'none', notes: '' };
      const explicit = Boolean(dueOn) || prev.dueSource === 'explicit';
      checks[key] = {
        completedOn: completedOn || prev.completedOn || '',
        dueOn: dueOn || prev.dueOn || '',
        dueSource: explicit ? 'explicit' : (prev.dueSource || ''),
        intervalKey: intervalKeyFor(key),
        notes: prev.notes || '',
      };
    }
    return null;
  };

  let drug = null;
  const lists = ['training', 'checks', 'events', 'requirements', 'qualifications', 'trainingevents'];
  for (const listName of lists) {
    const list = pick(raw, [listName]);
    if (!Array.isArray(list)) continue;
    for (const event of list) {
      if (!event || typeof event !== 'object') continue;
      const label = [
        pick(event, ['name', 'type', 'event', 'check', 'requirement', 'code', 'title', 'description']),
        pick(event, ['regulation', 'cfr']),
      ].filter(Boolean).join(' ');
      const id = eventIdFromStem(normKey(label));
      if (!id) continue;
      const completedOn = parseWyvernDate(pick(event, [
        'completed', 'completedon', 'completiondate', 'lastdate', 'datecompleted', 'checkdate',
      ]));
      const dueOn = parseWyvernDate(pick(event, [
        'due', 'duedate', 'expires', 'expiry', 'expiration', 'expirationdate', 'nextdue',
      ]));
      const aircraft = pick(event, ['aircraft', 'aircrafttype', 'type']);
      const drugHit = apply(id, completedOn, dueOn, aircraft);
      if (drugHit?.drug) {
        drug = { enrolled: true, enrolledDate: drugHit.completedOn || '' };
      }
    }
  }

  for (const [key, value] of Object.entries(raw || {})) {
    const norm = normKey(key);
    let kind = null;
    let stem = norm;
    if (/(completedon|completiondate|lastdate|datecompleted|completed)$/.test(norm)) {
      kind = 'completed';
      stem = norm.replace(/(completedon|completiondate|lastdate|datecompleted|completed)$/, '');
    } else if (/(expirationdate|expiration|duedate|nextdue|expires|expiry|due)$/.test(norm)) {
      kind = 'due';
      stem = norm.replace(/(expirationdate|expiration|duedate|nextdue|expires|expiry|due)$/, '');
    }
    const id = eventIdFromStem(stem);
    if (!id || !kind) continue;
    const date = parseWyvernDate(value);
    if (!date) continue;
    const drugHit = apply(id, kind === 'completed' ? date : '', kind === 'due' ? date : '', null);
    if (drugHit?.drug) drug = { enrolled: true, enrolledDate: drugHit.completedOn || '' };
  }

  return { checks, drug };
}

function intervalKeyFor(key) {
  if (key === 'instrumentCheck297') return 'ipc';
  if (key === 'lineCheck299') return 'line';
  if (key === 'recurrentTraining351') return 'recurrent';
  if (String(key).startsWith('groundOral293a_')) return 'aircraft';
  if (String(key).startsWith('sim293b_') || key === 'competencyCheck293') return 'simulator';
  return 'none';
}

function addCalendarMonthsEndDate(dateString, months) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return '';
  const count = Number(months);
  if (!Number.isFinite(count) || count <= 0) return '';
  const date = new Date(`${dateString}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count + 1, 0));
  return end.toISOString().slice(0, 10);
}

function picIntervals(standards) {
  const pic = standards?.positions?.PIC;
  const fallback = { medicalMonths: 12, ipcMonths: 6, lineCheckMonths: 7, aircraftMonths: 12, recurrentMonths: 12, simulatorMonths: 12 };
  const read = (key) => {
    const value = Number(pic?.[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback[key];
  };
  return {
    medical: read('medicalMonths'),
    ipc: read('ipcMonths'),
    line: read('lineCheckMonths'),
    aircraft: read('aircraftMonths'),
    recurrent: read('recurrentMonths'),
    simulator: read('simulatorMonths'),
  };
}

export function applyWyvernIntervals(record, standards = null) {
  if (!record) return record;
  const months = picIntervals(standards);
  if (record.medical && record.medical.expirationSource !== 'explicit' && record.medical.issuedDate) {
    const due = addCalendarMonthsEndDate(record.medical.issuedDate, months.medical);
    if (due) {
      record.medical.expirationDate = due;
      record.medical.expirationSource = 'interval';
    }
  }
  for (const item of Object.values(record.checks || {})) {
    if (!item || item.dueSource === 'explicit' || item.intervalKey === 'none') continue;
    const count = months[item.intervalKey];
    const due = addCalendarMonthsEndDate(item.completedOn, count);
    if (!due) continue;
    item.dueOn = due;
    item.dueSource = 'interval';
  }
  return record;
}

function nestedObject(bag, aliases) {
  const node = pick(bag, aliases);
  return node && typeof node === 'object' && !Array.isArray(node) ? node : null;
}

function readDatedNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  return {
    completedOn: parseWyvernDate(pick(node, ['date', 'completed', 'completedon', 'lastdate', 'checkdate'])),
    explicitDue: parseWyvernDate(pick(node, ['expires', 'expiry', 'expiration', 'expirationdate', 'due', 'duedate'])),
  };
}

function putCheck(checks, key, dated, intervalKey, notes = '') {
  if (!CHECK_KEYS.has(key) || !dated) return;
  if (!dated.completedOn && !dated.explicitDue) return;
  const prev = checks[key];
  const explicit = Boolean(dated.explicitDue) || prev?.dueSource === 'explicit';
  checks[key] = {
    completedOn: dated.completedOn || prev?.completedOn || '',
    dueOn: dated.explicitDue || (explicit ? prev?.dueOn || '' : ''),
    dueSource: explicit ? 'explicit' : (prev?.dueSource || ''),
    intervalKey,
    notes: notes || prev?.notes || '',
  };
}

function putEarliest(checks, key, dated, intervalKey, notes = '') {
  if (!dated?.completedOn && !dated?.explicitDue) return;
  const prev = checks[key];
  if (prev?.completedOn && dated.completedOn && prev.completedOn < dated.completedOn) return;
  putCheck(checks, key, dated, intervalKey, notes);
}

function recordsOnFile(value) {
  if (value == null || String(value).trim() === '') return null;
  if (/no reports/i.test(String(value))) return false;
  return true;
}

function typeUnverified(value) {
  return /type\s*not\s*verified|type rating not confirmed/i.test(String(value || ''));
}

function dutySeat(values) {
  const seats = [...new Set((values || []).map((value) => {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'pic' || text.includes('pilot in command')) return 'PIC';
    if (text === 'sic' || text.includes('second in command')) return 'SIC';
    return '';
  }).filter(Boolean))];
  return seats.length === 1 ? seats[0] : '';
}

function hoursGreater(left, right) {
  return left != null && right != null && Number(left) > Number(right) + 0.001;
}

function applyPassExtract(raw, record) {
  const hourBag = readHourBag(raw);
  const fixed = nestedObject(hourBag, ['fixedwing']);
  const single = nestedObject(hourBag, ['singleengine']);
  const multi = nestedObject(hourBag, ['multiengine']);
  const rotor = nestedObject(hourBag, ['rotorwing']);
  if (record.hours.fixedWing == null && fixed) record.hours.fixedWing = parseHours(pick(fixed, ['total', 'totaltime', 'hours']));
  if (record.hours.picFixedWing == null && fixed) record.hours.picFixedWing = parseHours(pick(fixed, ['pic', 'pichours']));
  if (record.hours.singleEngine == null && single) record.hours.singleEngine = parseHours(pick(single, ['total', 'totaltime', 'hours']));
  if (record.hours.multiEngine == null && multi) record.hours.multiEngine = parseHours(pick(multi, ['total', 'totaltime', 'hours']));
  if (record.hours.picMultiEngine == null && multi) record.hours.picMultiEngine = parseHours(pick(multi, ['pic', 'pichours']));
  if (record.hours.multiEngine90 == null && multi) {
    record.hours.multiEngine90 = parseHours(pick(multi, ['90days', 'last90', 'last90days']));
  }
  if (record.hours.multiEngine12 == null && multi) {
    record.hours.multiEngine12 = parseHours(pick(multi, ['12months', 'last12', 'last12months', 'last365']));
  }
  const landings = nestedObject(hourBag, ['landings']);
  if (landings) {
    if (record.hours.landings90 == null) record.hours.landings90 = parseHours(pick(landings, ['90days', 'last90', 'last90days']));
    if (record.hours.landings12 == null) record.hours.landings12 = parseHours(pick(landings, ['12months', 'last12', 'last12months']));
  } else if (record.hours.landings == null) {
    record.hours.landings = parseHours(pick(hourBag, ['landings']));
  }
  if (record.hours.rotorWing == null && rotor) {
    const rotorHours = nestedObject(rotor, ['hours']) || rotor;
    record.hours.rotorWing = parseHours(pick(rotorHours, ['total', 'totaltime', 'hours']));
  }

  const certificateBag = pick(raw, ['certificate', 'airmancertificate']);
  const certificateSource = certificateBag && typeof certificateBag === 'object' && !Array.isArray(certificateBag)
    ? certificateBag
    : {};
  const country = String(pick(certificateSource, ['issuingcountry', 'country', 'countryofissue']) || '').trim();
  if (country) record.certificate.country = country.slice(0, 40);
  const issuedOn = parseWyvernDate(pick(certificateSource, ['issuedate', 'issued', 'issuedon']));
  if (issuedOn) record.certificateIssuedOn = issuedOn;
  const faaVerifiedOn = parseWyvernDate(pick(certificateSource, ['lastfaaverification', 'faaverification', 'faaverified']));
  if (faaVerifiedOn) record.faaVerifiedOn = faaVerifiedOn;
  const certificateTypeText = String(pick(certificateSource, ['type', 'certificatetype', 'grade']) || '');
  const ratingText = [
    certificateTypeText,
    pick(certificateSource, ['fixedwingratings']),
    pick(certificateSource, ['rotorwingratings']),
  ].filter((value) => typeof value === 'string').join(' ');
  if (record.certificate.instrument == null && /instrument/i.test(ratingText)) record.certificate.instrument = true;
  if (record.certificate.multiEngine == null && /multi[-\s]?engine|\bmel\b/i.test(ratingText)) record.certificate.multiEngine = true;

  const employment = String(pick(raw, ['employmentstatus', 'employment']) || '').trim();
  if (employment) record.background.employment = employment.slice(0, 40);
  const backgroundBag = nestedObject(raw, ['background']);
  if (backgroundBag) {
    record.background.accident = recordsOnFile(pick(backgroundBag, ['aidrecords', 'aid', 'accident']));
    record.background.enforcement = recordsOnFile(pick(backgroundBag, ['eisrecords', 'eis', 'enforcement']));
    const checked = parseWyvernDate(pick(backgroundBag, ['faabackgroundcheckdate', 'backgroundcheckdate', 'checkedon']));
    if (checked) record.backgroundCheckedOn = checked;
  }

  const passStatus = String(pick(raw, ['passstatus']) || '').trim();
  if (passStatus) record.passStatus = passStatus.slice(0, 80);
  const hiredOn = parseWyvernDate(pick(raw, ['dateofhire', 'hiredate', 'hiredon']));
  if (hiredOn) record.hiredOn = hiredOn;
  const base = String(pick(raw, ['pilotbase', 'base', 'homebase']) || '').trim();
  if (base) record.base = base.slice(0, 80);
  const newHire = nestedObject(raw, ['newhireadjustment', 'newhire'])
    || nestedObject(hourBag, ['newhireadjustment', 'newhire']);
  if (newHire) record.newHireHours = parseHours(pick(newHire, ['hours12monthsprior', 'hours', 'total']));

  const checksBag = nestedObject(raw, ['checks']);
  if (checksBag) {
    const named = [
      ['ipc', 'instrumentCheck297', 'ipc'],
      ['linecheck', 'lineCheck299', 'line'],
      ['internationalprocedures', 'internationalProcedures', 'none'],
      ['indoctrination', 'basicIndoctrination', 'none'],
      ['uprt', 'uprt', 'none'],
    ];
    for (const [alias, key, intervalKey] of named) {
      putCheck(record.checks, key, readDatedNode(pick(checksBag, [alias])), intervalKey);
    }
  }

  let unverified = false;
  const duties = [];
  const typeRows = pick(raw, ['typeratings', 'typerating']);
  if (Array.isArray(typeRows)) {
    for (const entry of typeRows) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeUnverified(pick(entry, ['verifiedstatus', 'verified', 'status']))) unverified = true;
      const duty = pick(entry, ['dutyassignment', 'duty', 'seat']);
      if (duty) duties.push(duty);
      const typeName = cleanTypeName(pick(entry, ['type', 'aircraft', 'name']));
      const family = familyOf(typeName);
      putEarliest(record.checks, `groundOral293a_${family}`, readDatedNode(pick(entry, ['aircraftspecificcheck', 'aircraftcheck'])), 'aircraft');
      putEarliest(record.checks, 'recurrentTraining351', readDatedNode(pick(entry, ['recurrenttraining', 'recurrent'])), 'recurrent');
      const simNode = pick(entry, ['simulatortraining', 'simulator', 'sim']);
      const simType = simNode && typeof simNode === 'object' ? String(pick(simNode, ['simtype', 'simulatortype']) || '').trim() : '';
      const vendor = simNode && typeof simNode === 'object' ? String(pick(simNode, ['vendor', 'provider']) || '').trim() : '';
      const simNotes = [simType, vendor].filter(Boolean).join(' · ').slice(0, 120);
      putEarliest(record.checks, `sim293b_${family}`, readDatedNode(simNode), 'simulator', simNotes);
      putEarliest(record.checks, 'enhancedPilotTraining', readDatedNode(pick(entry, ['enhancedpilottraining', 'ept'])), 'none');
    }
  }
  const flags = pick(raw, ['statusflags', 'flags']);
  const flagList = Array.isArray(flags) ? flags : typeof flags === 'string' ? [flags] : [];
  if (flagList.some((flag) => typeUnverified(flag))) unverified = true;
  if (record.certificate.typeRatings.length) record.certificate.typeVerified = !unverified;
  if (!record.position) record.position = dutySeat(duties);

  const warnings = [];
  if (hoursGreater(record.hours.pic, record.hours.totalTime)) warnings.push('PIC time is greater than total time');
  if (fixed && hoursGreater(parseHours(pick(fixed, ['pic', 'pichours'])), parseHours(pick(fixed, ['total', 'totaltime', 'hours'])))) {
    warnings.push('Fixed-wing PIC time is greater than fixed-wing total time');
  }
  if (multi && hoursGreater(parseHours(pick(multi, ['pic', 'pichours'])), parseHours(pick(multi, ['total', 'totaltime', 'hours'])))) {
    warnings.push('Multi-engine PIC time is greater than multi-engine total time');
  }
  for (const entry of record.hours.timeInType || []) {
    if (hoursGreater(entry.picHours, entry.hours)) {
      warnings.push('PIC time in type is greater than total time in type');
      break;
    }
  }
  if ((record.hours.timeInType || []).some((entry) => hoursGreater(entry.hours, record.hours.totalTime))) {
    warnings.push('Time in type is greater than total time');
  }
  const capture = pick(raw, ['capturecomplete', 'capture_complete']);
  if (capture === false || ['false', 'no', 'n'].includes(String(capture ?? '').trim().toLowerCase())) {
    warnings.push('Wyvern marked this capture incomplete');
  }
  if (certificateTypeText.trim() && !record.certificate.level && !record.certificate.rotorLevel) {
    warnings.push('Certificate type was not recognized');
  }
  record.warnings = [...new Set(warnings)];
}

function readAircraftTypes(raw) {
  const direct = pick(raw, ['aircrafttypes', 'aircraft', 'qualifiedaircraft', 'types', 'fleettypes']);
  const rows = [];
  if (Array.isArray(direct)) {
    for (const entry of direct) {
      const type = typeof entry === 'string' ? entry : pick(entry, ['type', 'name', 'aircraft']);
      const clean = cleanTypeName(type);
      if (clean) rows.push(clean);
    }
  } else if (typeof direct === 'string') {
    direct.split(/[,;\n]/).map(cleanTypeName).filter(Boolean).forEach((type) => rows.push(type));
  }
  return [...new Set(rows)].slice(0, 24);
}

export function normalizeWyvernRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = displayName(pick(raw, ['name', 'pilotname', 'fullname', 'pilot', 'crewmember', 'displayname', 'wyvernname']) || '');
  const email = normalizeEmail(pick(raw, ['email', 'emailaddress', 'pilotemail', 'mail']));
  const phone = String(pick(raw, ['phone', 'phonenumber', 'mobile', 'cellphone']) || '').trim().slice(0, 40);
  const wyvernId = String(pick(raw, ['wyvernid', 'wyvernpilotid', 'acesid', 'externalid', 'pilotwyvernid']) || pick(raw, ['id']) || '').trim().slice(0, 80);
  const rosterStatus = pick(raw, ['rosterstatus']);
  const employmentStatus = pick(raw, ['employmentstatus']);
  const status = rosterStatus != null && String(rosterStatus).trim() !== ''
    ? rosterStatus
    : pick(raw, ['status', 'pilotstatus', 'activestatus', 'active']) ?? employmentStatus;
  const active = isActiveWyvernStatus(status);
  const position = String(pick(raw, ['position', 'seat', 'crewposition', 'role']) || '').trim().slice(0, 40);
  const verificationStatus = String(pick(raw, ['verificationstatus', 'verification', 'verifiedstatus', 'wyvernstatus']) || '').trim().slice(0, 80);
  const aircraftTypes = readAircraftTypes(raw);

  const hourBag = readHourBag(raw);
  const hours = emptyHours();
  for (const key of HOUR_KEYS) {
    const aliases = HOUR_ALIASES[key];
    hours[key] = aliases ? parseHours(pick(hourBag, aliases)) : null;
  }
  hours.timeInType = readTimeInType(hourBag, raw);
  const hoursAsOf = parseWyvernDate(pick(hourBag, ['asof', 'asofdate', 'hoursasof', 'effectivedate', 'reportdate', 'lastupdated'])
    ?? pick(raw, ['hoursasof', 'asof', 'asofdate', 'lastupdated']));

  const certificateBag = pick(raw, ['certificate', 'airmancertificate', 'certificates']);
  const certificateSource = certificateBag && typeof certificateBag === 'object' && !Array.isArray(certificateBag)
    ? certificateBag
    : raw;
  const certificateTypeText = String(pick(certificateSource, [
    'level', 'grade', 'certificatetype', 'certtype', 'airmancertificate', 'certificategrade', 'category', 'type',
  ]) || (typeof certificateBag === 'string' ? certificateBag : ''));
  const parsedCertificate = parseAirmanCertificate(certificateTypeText);
  const level = parsedCertificate.fixedWing;
  const blob = `${ratingsBlob(certificateSource)} ${ratingsBlob(raw)}`;
  let instrument = parseBool(pick(certificateSource, ['instrument', 'instrumentrating', 'instrumentrated']));
  let multiEngine = parseBool(pick(certificateSource, ['multiengine', 'multienginerating', 'multirated']));
  if (instrument == null && /instrument/i.test(blob)) instrument = true;
  if (multiEngine == null && /multi[-\s]?engine|\bmel\b/i.test(blob)) multiEngine = true;
  const typeRatings = readTypeRatings(certificateSource);
  for (const type of readTypeRatings(raw)) {
    if (!typeRatings.includes(type)) typeRatings.push(type);
  }

  const medicalBag = pick(raw, ['medical', 'medicalcertificate']);
  const medicalSource = medicalBag && typeof medicalBag === 'object' && !Array.isArray(medicalBag) ? medicalBag : raw;
  const medical = {
    class: normalizeMedicalClass(pick(medicalSource, ['class', 'medicalclass', 'certificateclass'])),
    issuedDate: parseWyvernDate(pick(medicalSource, ['issued', 'issuedate', 'issuedon', 'medicaldate', 'examdate', 'checkdate'])),
    expirationDate: parseWyvernDate(pick(medicalSource, [
      'expiry', 'expiration', 'expirationdate', 'expires', 'medicalexpiry', 'medicalexpiration',
    ])),
    expirationSource: '',
  };
  if (medical.expirationDate) medical.expirationSource = 'explicit';
  const documents = pick(raw, ['documents', 'docs', 'files']);
  if (Array.isArray(documents)) {
    for (const doc of documents) {
      if (!doc || typeof doc !== 'object') continue;
      const label = normKey(pick(doc, ['type', 'name', 'doctype', 'documenttype', 'title']) || '');
      if (!label.includes('medical')) continue;
      if (!medical.expirationDate) {
        medical.expirationDate = parseWyvernDate(pick(doc, ['expiry', 'expiration', 'expirationdate', 'expires', 'duedate']));
        if (medical.expirationDate) medical.expirationSource = 'explicit';
      }
      if (!medical.class) medical.class = normalizeMedicalClass(pick(doc, ['class', 'medicalclass']));
    }
  }

  const { checks, drug } = readChecks(raw, [...aircraftTypes, ...typeRatings]);
  const drugBag = pick(raw, ['drugalcohol', 'drugandalcohol', 'drugandaprogram', 'drugprogram']);
  const drugSource = drugBag && typeof drugBag === 'object' && !Array.isArray(drugBag) ? drugBag : null;
  const enrolled = parseBool(drugSource ? pick(drugSource, ['enrolled', 'active', 'status']) : pick(raw, ['drugalcoholenrolled', 'drugprogramenrolled']));
  const drugAlcohol = {
    enrolled: enrolled == null ? (drug?.enrolled ?? null) : enrolled,
    enrolledDate: parseWyvernDate(drugSource
      ? pick(drugSource, ['enrolleddate', 'date', 'completed', 'startdate'])
      : '') || drug?.enrolledDate || '',
    programName: String(drugSource ? pick(drugSource, ['program', 'programname', 'name']) || '' : '').trim().slice(0, 80),
  };

  if (!name && !email && !wyvernId) return null;
  const record = {
    name: name.slice(0, 80),
    email,
    phone,
    wyvernId,
    status: String(status ?? '').slice(0, 40),
    active,
    position,
    verificationStatus,
    aircraftTypes,
    hours,
    hoursAsOf,
    certificate: {
      level,
      rotorLevel: parsedCertificate.rotorWing,
      instrument,
      multiEngine,
      typeRatings,
      typeVerified: null,
      country: '',
    },
    background: {
      employment: '',
      accident: null,
      enforcement: null,
    },
    medical,
    drugAlcohol,
    checks,
    warnings: [],
    hiredOn: '',
    base: '',
    newHireHours: null,
    passStatus: '',
    certificateIssuedOn: '',
    faaVerifiedOn: '',
    backgroundCheckedOn: '',
  };
  applyPassExtract(raw, record);
  return applyWyvernIntervals(record, null);
}

function parseCsvTable(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = source.split('\n').find((line) => line.trim()) || '';
  const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => String(value || '').trim()));
}

function recordsFromCsv(text) {
  const table = parseCsvTable(text);
  if (table.length < 2) {
    return { records: [], warnings: ['CSV needs a header row and at least one pilot.'] };
  }
  const headers = table[0].map((header) => String(header || '').trim());
  const records = [];
  for (const cells of table.slice(1)) {
    const raw = {};
    headers.forEach((header, index) => {
      if (!header) return;
      raw[header] = cells[index] == null ? '' : String(cells[index]).trim();
    });
    const record = normalizeWyvernRecord(raw);
    if (record) records.push(record);
  }
  return { records, warnings: records.length ? [] : ['No pilot rows recognized in this CSV.'] };
}

function recordsFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { records: [], warnings: [`JSON could not be read (${err.message}).`] };
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.pilots)
      ? data.pilots
      : Array.isArray(data?.records)
        ? data.records
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.crew)
            ? data.crew
            : data && typeof data === 'object' ? [data] : null;
  if (!list) {
    return { records: [], warnings: ['JSON must be a pilot array, or an object with pilots, records, data, or crew.'] };
  }
  const records = list.map(normalizeWyvernRecord).filter(Boolean);
  return {
    records,
    warnings: records.length ? [] : ['JSON did not contain any pilot records.'],
  };
}

export function parseWyvernText(text, filename = '') {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { records: [], warnings: ['The file is empty.'] };
  const jsonName = /\.json$/i.test(filename);
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || jsonName) {
    return recordsFromJson(trimmed);
  }
  return recordsFromCsv(trimmed);
}

export function matchWyvernPilot(record, users = [], logbooks = {}) {
  const list = (users || []).filter((user) => user?.uid && user.approved !== false);
  const email = normalizeEmail(record?.email);
  if (email) {
    const hits = list.filter((user) => normalizeEmail(user.email) === email);
    if (hits.length === 1) return { user: hits[0], reason: 'email', ambiguous: false };
    if (hits.length > 1) {
      return { user: null, reason: `${hits.length} users share this email`, ambiguous: true };
    }
  }
  const name = normalizePersonName(record?.name);
  if (name) {
    const hits = list.filter((user) => userNames(user).some((candidate) => namesMatch(candidate, name)));
    if (hits.length === 1) return { user: hits[0], reason: 'name', ambiguous: false };
    if (hits.length > 1) {
      return { user: null, reason: `${hits.length} pilots share this name`, ambiguous: true };
    }
  }
  if (record?.wyvernId) {
    const hits = list.filter((user) => logbooks?.[user.uid]?.wyvern?.id && logbooks[user.uid].wyvern.id === record.wyvernId);
    if (hits.length === 1) return { user: hits[0], reason: 'wyvern id', ambiguous: false };
    if (hits.length > 1) {
      return { user: null, reason: 'This Wyvern ID is already stored on more than one pilot', ambiguous: true };
    }
  }
  return { user: null, reason: email || name ? 'No matching pilot' : 'Missing name and email', ambiguous: false };
}

function sameNumber(left, right) {
  if (left == null || right == null) return true;
  return Math.abs(Number(left) - Number(right)) < 0.05;
}

function conflict(conflicts, field, existing, incoming) {
  if (incoming == null || incoming === '') return;
  if (existing == null || existing === '') return;
  if (String(existing) === String(incoming)) return;
  conflicts.push({ field, existing: String(existing), incoming: String(incoming) });
}

function typeSet(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))].sort();
}

export function findWyvernConflicts(existingLogbook, existingCurrency, record, user = null) {
  const conflicts = [];
  if (user && record?.name) {
    const incoming = normalizePersonName(record.name);
    const known = userNames(user);
    if (incoming && known.length && !known.some((candidate) => namesMatch(candidate, incoming))) {
      conflicts.push({ field: 'Pilot name', existing: user.name || user.email || '', incoming: record.name });
    }
  }
  const book = existingLogbook || {};
  const savedHours = book.baseline?.asOf ? (book.baseline.hours || {}) : (book.hours || {});
  for (const key of HOUR_KEYS) {
    const incoming = record?.hours?.[key];
    const existing = savedHours?.[key];
    if (incoming == null || existing == null || sameNumber(existing, incoming)) continue;
    conflicts.push({
      field: key,
      existing: String(existing),
      incoming: String(incoming),
    });
  }
  const existingTypes = new Map((savedHours?.timeInType || []).map((entry) => [
    String(entry.type || '').trim().toLowerCase(),
    entry,
  ]));
  for (const entry of record?.hours?.timeInType || []) {
    const prev = existingTypes.get(String(entry.type || '').trim().toLowerCase());
    if (!prev || sameNumber(prev.hours, entry.hours)) continue;
    conflicts.push({ field: `Time in type ${entry.type}`, existing: String(prev.hours), incoming: String(entry.hours) });
  }
  if (record?.certificate?.level && book.certificate?.level && record.certificate.level !== book.certificate.level) {
    conflict(conflicts, 'Certificate', book.certificate.level, record.certificate.level);
  }
  const existingTypesRated = typeSet(book.certificate?.typeRatings);
  const incomingTypesRated = typeSet(record?.certificate?.typeRatings);
  if (existingTypesRated.length && incomingTypesRated.length && existingTypesRated.join('|') !== incomingTypesRated.join('|')) {
    conflict(conflicts, 'Type ratings', existingTypesRated.join(', '), incomingTypesRated.join(', '));
  }
  if (book.drugAlcohol?.enrolled != null && record?.drugAlcohol?.enrolled != null
    && book.drugAlcohol.enrolled !== record.drugAlcohol.enrolled) {
    conflict(conflicts, 'Drug and alcohol', book.drugAlcohol.enrolled ? 'Enrolled' : 'Not enrolled', record.drugAlcohol.enrolled ? 'Enrolled' : 'Not enrolled');
  }
  const medical = existingCurrency?.medical || {};
  if (record?.medical?.class && medical.class && normalizeMedicalClass(medical.class) !== record.medical.class) {
    conflict(conflicts, 'Medical class', medical.class, record.medical.class);
  }
  conflict(conflicts, 'Medical expiration', medical.expirationDate, record?.medical?.expirationDate);
  for (const [key, item] of Object.entries(record?.checks || {})) {
    const prev = existingCurrency?.[key];
    if (!prev || typeof prev !== 'object') continue;
    conflict(conflicts, `${key} completed`, prev.lastDate, item.completedOn);
    conflict(conflicts, `${key} due`, prev.dueDate, item.dueOn);
  }
  return conflicts;
}

function bucketFor(match, conflicts) {
  if (!match?.user) return 'unmatched';
  return conflicts.length ? 'conflict' : 'matched';
}

export function planWyvernImport(records, { users = [], logbooks = {}, currencies = {}, standards = null } = {}) {
  const rows = [];
  const skipped = [];
  for (const record of records || []) {
    applyWyvernIntervals(record, standards);
    if (!record?.active) {
      skipped.push({ record, reason: 'Not marked active' });
      continue;
    }
    const match = matchWyvernPilot(record, users, logbooks);
    const conflicts = match.user
      ? findWyvernConflicts(logbooks?.[match.user.uid], currencies?.[match.user.uid], record, match.user)
      : [];
    const bucket = bucketFor(match, conflicts);
    rows.push({
      record,
      match,
      matchUid: match.user?.uid || null,
      conflicts,
      bucket,
      include: bucket === 'matched' || bucket === 'conflict',
    });
  }
  return { rows, skipped };
}

export function relinkWyvernRow(row, user, logbooks = {}, currencies = {}) {
  const match = user
    ? { user, reason: 'linked by admin', ambiguous: false }
    : { user: null, reason: 'Skipped', ambiguous: false };
  const conflicts = user
    ? findWyvernConflicts(logbooks?.[user.uid], currencies?.[user.uid], row.record, user)
    : [];
  const bucket = bucketFor(match, conflicts);
  return {
    ...row,
    match,
    matchUid: user?.uid || null,
    conflicts,
    bucket,
    include: Boolean(user),
  };
}

function upsertTimeInType(existing, incoming) {
  const list = (existing || []).map((entry) => ({
    type: entry.type,
    hours: entry.hours,
    picHours: entry.picHours ?? null,
  }));
  for (const entry of incoming || []) {
    if (!entry?.type || entry.hours == null) continue;
    const key = entry.type.trim().toLowerCase();
    const index = list.findIndex((item) => String(item.type || '').trim().toLowerCase() === key);
    const picHours = entry.picHours != null ? entry.picHours : (index >= 0 ? list[index].picHours : null);
    const next = { type: entry.type, hours: entry.hours, picHours };
    if (index >= 0) list[index] = next;
    else list.push(next);
  }
  return list;
}

export function wyvernLogbookDraft(existing, record, { uid, pilotName, now = Date.now() } = {}) {
  const book = normalizeLogbook(existing || { uid, pilotName }, uid);
  book.uid = uid;
  book.pilotName = book.pilotName || pilotName || record?.name || '';
  for (const key of HOUR_KEYS) {
    if (record?.hours?.[key] != null) book.hours[key] = record.hours[key];
  }
  if (record?.hours?.timeInType?.length) {
    book.hours.timeInType = upsertTimeInType(book.hours.timeInType, record.hours.timeInType);
  }
  const snapshotAsOf = record?.hoursAsOf
    || (/^\d{4}-\d{2}-\d{2}$/.test(book.baseline?.asOf || '') ? book.baseline.asOf : '')
    || new Date(now).toISOString().slice(0, 10);
  book.baseline = {
    asOf: snapshotAsOf,
    source: 'Wyvern',
    hours: book.hours,
  };
  if (record?.certificate?.level) book.certificate.level = record.certificate.level;
  if (record?.certificate?.rotorLevel) book.certificate.rotorLevel = record.certificate.rotorLevel;
  if (record?.certificate?.instrument != null) book.certificate.instrument = record.certificate.instrument;
  if (record?.certificate?.multiEngine != null) book.certificate.multiEngine = record.certificate.multiEngine;
  if (record?.certificate?.typeRatings?.length) {
    book.certificate.typeRatings = record.certificate.typeRatings.slice(0, 24);
  }
  if (record?.certificate?.country) book.certificate.country = record.certificate.country.slice(0, 40);
  if (record?.certificate?.typeVerified === true || record?.certificate?.typeVerified === false) {
    book.certificate.typeVerified = record.certificate.typeVerified;
  }
  if (record?.background?.employment) book.background.employment = record.background.employment.slice(0, 40);
  if (record?.background?.accident === true || record?.background?.accident === false) {
    book.background.accident = record.background.accident;
  }
  if (record?.background?.enforcement === true || record?.background?.enforcement === false) {
    book.background.enforcement = record.background.enforcement;
  }
  if (record?.drugAlcohol?.enrolled != null) book.drugAlcohol.enrolled = record.drugAlcohol.enrolled;
  if (record?.drugAlcohol?.enrolledDate) book.drugAlcohol.enrolledDate = record.drugAlcohol.enrolledDate;
  if (record?.drugAlcohol?.programName) book.drugAlcohol.programName = record.drugAlcohol.programName;
  book.wyvern = {
    id: record?.wyvernId || book.wyvern?.id || '',
    source: WYVERN_SOURCE,
    importedAt: now,
    hoursAsOf: snapshotAsOf,
    verificationStatus: record?.verificationStatus || book.wyvern?.verificationStatus || '',
    position: record?.position || book.wyvern?.position || '',
    hiredOn: record?.hiredOn || book.wyvern?.hiredOn || '',
    base: record?.base || book.wyvern?.base || '',
    newHireHours: record?.newHireHours != null ? record.newHireHours : (book.wyvern?.newHireHours ?? null),
    passStatus: record?.passStatus || book.wyvern?.passStatus || '',
    certificateIssuedOn: record?.certificateIssuedOn || book.wyvern?.certificateIssuedOn || '',
    faaVerifiedOn: record?.faaVerifiedOn || book.wyvern?.faaVerifiedOn || '',
    backgroundCheckedOn: record?.backgroundCheckedOn || book.wyvern?.backgroundCheckedOn || '',
  };
  return normalizeLogbook(book, uid);
}

export function wyvernCurrencyPatch(existing, record, now = Date.now()) {
  const updates = {};
  let wrote = false;
  if (record?.medical?.class || record?.medical?.expirationDate || record?.medical?.issuedDate) {
    const medical = { ...(existing?.medical && typeof existing.medical === 'object' ? existing.medical : {}) };
    if (record.medical.class) medical.class = record.medical.class;
    if (record.medical.issuedDate) medical.lastDate = record.medical.issuedDate;
    if (record.medical.expirationDate) medical.expirationDate = record.medical.expirationDate;
    if (!medical.notes) medical.notes = 'Imported from Wyvern';
    updates.medical = medical;
    wrote = true;
  }
  for (const [key, item] of Object.entries(record?.checks || {})) {
    if (!CHECK_KEYS.has(key)) continue;
    if (!item?.completedOn && !item?.dueOn) continue;
    const prev = existing?.[key] && typeof existing[key] === 'object' ? existing[key] : {};
    const next = { ...prev };
    if (item.completedOn) next.lastDate = item.completedOn;
    if (item.dueOn) next.dueDate = item.dueOn;
    if (!next.notes) next.notes = item.notes || 'Imported from Wyvern';
    updates[key] = next;
    wrote = true;
  }
  if (!wrote) return null;
  updates.wyvernSource = WYVERN_SOURCE;
  updates.wyvernImportedAt = now;
  return updates;
}

export function wyvernRecordSummary(record) {
  const hours = HOUR_KEYS.filter((key) => record?.hours?.[key] != null).length;
  const checks = Object.keys(record?.checks || {}).length;
  const bits = [
    record?.certificate?.level,
    hours ? `${hours} hour fields` : '',
    checks ? `${checks} checks` : '',
    record?.medical?.class ? `${record.medical.class} medical` : '',
  ].filter(Boolean);
  return bits.join(' · ') || 'No hours or requirements in this row';
}

const HOUR_LABELS = {
  totalTime: 'Total time',
  pic: 'Pilot in command',
  sic: 'Second in command',
  fixedWing: 'Fixed-wing',
  picFixedWing: 'PIC fixed-wing',
  rotorWing: 'Rotor-wing',
  singleEngine: 'Single-engine',
  multiEngine: 'Multi-engine',
  picMultiEngine: 'PIC multi-engine',
  multiEngine90: 'Multi-engine last 90 days',
  multiEngine12: 'Multi-engine last 12 months',
  landings: 'Landings',
  landings90: 'Landings last 90 days',
  landings12: 'Landings last 12 months',
  turbine: 'Turbine',
  night: 'Night',
  instrument: 'Instrument',
  last90Days: 'Last 90 days',
  last12Months: 'Last 12 months',
};

export function wyvernConflictLabel(field) {
  return HOUR_LABELS[field] || field;
}
