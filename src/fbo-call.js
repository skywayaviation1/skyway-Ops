/**
 * FBO calling agent — verified facts, matching, and scheduling rules.
 *
 * Voice sessions run on Vapi (LLM) over Twilio PSTN. This module never
 * places a call; it only decides what the agent is allowed to say and when
 * Skyway ops may arm a dial.
 */

import { getAirportTimezone } from './airports.js';

export const SKYWAY_CALLER_NAME = 'Skyway Aviation';
export const SKYWAY_CALLER_ID = '+18138595943';
export const SKYWAY_CALLER_ID_DISPLAY = '+1 (813) 859-5943';
export const VOICE_VENDOR = 'vapi';
export const VOICE_PSTN = 'twilio';

export const DEFAULT_DEP_LEAD_MINUTES = 120;
export const DEFAULT_ARR_LEAD_MINUTES = 120;
export const DEFAULT_RETRY_MINUTES = 15;
export const DEFAULT_MAX_ATTEMPTS = 3;

export const CALL_PURPOSES = Object.freeze(['departure', 'arrival']);

export function unverifiedCallPurposes(purposes = [], verifiedPurposes = []) {
  const verified = new Set(Array.isArray(verifiedPurposes) ? verifiedPurposes : []);
  return (Array.isArray(purposes) ? purposes : [])
    .filter((purpose) => CALL_PURPOSES.includes(purpose) && !verified.has(purpose));
}

export const CALL_STATUSES = Object.freeze({
  preview: 'preview',
  blocked: 'blocked',
  armed: 'armed',
  scheduled: 'scheduled',
  dialing: 'dialing',
  in_progress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  needs_followup: 'needs_followup',
});

export function isFinishedCallStatus(status) {
  return ['completed', 'failed', 'needs_followup', 'cancelled'].includes(status);
}

const GROUND_RE = /\b(ground\s*trans(?:port(?:ation)?)?|limo(?:usine)?|car\s*service|chauffeur|town\s*car|meet\s*(?:and|&)\s*greet|courtesy\s*(?:car|van)|rental\s*car|uber|lyft|taxi)\b/i;
const PARKING_RE = /\b(parking|park|overnight|hangar|hangared|ramp|tie[- ]?down)\b/i;

const clean = (value) => String(value ?? '').trim();

const SMALL_NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS_NUMBERS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];

function speakNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 20) return SMALL_NUMBERS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones ? `${TENS_NUMBERS[tens]} ${SMALL_NUMBERS[ones]}` : TENS_NUMBERS[tens];
}

export function speakMilitaryClock(hours, minutes) {
  const hour = Number(hours);
  const minute = Number(minutes);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
  const hourPart = hour === 0
    ? 'zero'
    : (hour < 10 ? `zero ${SMALL_NUMBERS[hour]}` : speakNumber(hour));
  if (minute === 0) return `${hourPart} hundred`;
  if (minute < 10) return `${hourPart} zero ${SMALL_NUMBERS[minute]}`;
  return `${hourPart} ${speakNumber(minute)}`;
}

export function formatLocalMilitaryTime(value, airportCode) {
  const ms = value instanceof Date
    ? value.getTime()
    : (value == null || value === '' ? NaN : new Date(value).getTime());
  if (!Number.isFinite(ms)) {
    return { display: '', spoken: '', zone: '', date: '', line: '', spokenLine: '' };
  }
  const date = new Date(ms);
  const timeZone = getAirportTimezone(airportCode) || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZoneName: 'short',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || '';
  let hour = Number(part('hour'));
  const minute = Number(part('minute'));
  if (hour === 24) hour = 0;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const display = `${hh}${mm}`;
  const spoken = speakMilitaryClock(hour, minute);
  const zone = part('timeZoneName') || (timeZone === 'UTC' ? 'UTC' : '');
  const dateLine = `${part('day')} ${String(part('month') || '').toUpperCase()} ${part('year')}`.trim();
  const localLabel = zone ? `local ${zone}` : 'local';
  return {
    display,
    spoken,
    zone,
    date: dateLine,
    line: [dateLine, `at ${display} ${localLabel}`].filter(Boolean).join(' '),
    spokenLine: [dateLine, `at ${spoken} ${localLabel}`].filter(Boolean).join(' '),
  };
}

const NATO_PHONETIC = Object.freeze({
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
  G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima',
  M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray',
  Y: 'Yankee', Z: 'Zulu',
});

export function spokenTailNumber(value) {
  const characters = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '').split('');
  if (!characters.length) return '';
  const spoken = characters.map((character) => NATO_PHONETIC[character] || character);
  return spoken.reduce((result, word, index) => {
    if (index === 0) return word;
    const previous = characters[index - 1];
    const current = characters[index];
    const separator = /[A-Z]/.test(previous) && /[A-Z]/.test(current)
      ? ' '
      : (index === 1 && /[A-Z]/.test(previous) && /\d/.test(current) ? ' ' : ', ');
    return `${result}${separator}${word}`;
  }, '');
}

export function toE164(phone) {
  const raw = clean(phone);
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return '';
}

export function passengerDisplayName(passenger) {
  if (!passenger || typeof passenger !== 'object') return '';
  const full = clean(passenger.name || passenger.fullName);
  if (full) return full.replace(/\s+/g, ' ');
  return [passenger.firstName, passenger.lastName].map(clean).filter(Boolean).join(' ');
}

export function leadPassengerName(state = {}) {
  const preload = Array.isArray(state.preloadedPax) ? state.preloadedPax : [];
  const scanned = Array.isArray(state.passengers) ? state.passengers : [];
  const primary = preload.find((row) => row?.primary) || scanned.find((row) => row?.primary);
  return passengerDisplayName(primary || preload[0] || scanned[0]);
}

export function notesBlob(state = {}, info = {}) {
  const notes = state.tripSheetNotes && typeof state.tripSheetNotes === 'object'
    ? state.tripSheetNotes
    : {};
  return [
    notes.pax, notes.customer, notes.specialItems, notes.crew,
    info.specialItems, info.notes, info.customerNotes,
  ].map(clean).filter(Boolean).join('\n');
}

export function groundTransportRequested(state = {}, info = {}) {
  return GROUND_RE.test(notesBlob(state, info));
}

export function cateringRequested(state = {}, info = {}) {
  if (state.hasCatering === false) return false;
  if (state.hasCatering === true) return true;
  return /cater/i.test(notesBlob(state, info));
}

function toIso(value) {
  if (!value) return '';
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function toMillis(value) {
  if (value == null || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function materialFacts(trip = {}, state = {}) {
  const info = trip.info || {};
  return {
    from: clean(info.from).toUpperCase(),
    to: clean(info.to).toUpperCase(),
    start: toIso(trip.start),
    end: toIso(trip.end),
    fromFbo: clean(state.fromFbo),
    toFbo: clean(state.toFbo),
    fromFboPhone: resolveDialPhone(state, 'departure').display,
    toFboPhone: resolveDialPhone(state, 'arrival').display,
    pax: Number.isFinite(Number(state.paxOverride))
      ? Number(state.paxOverride)
      : Number(info.pax || 0),
    hasCatering: cateringRequested(state, info),
    specialItems: clean(state.tripSheetNotes?.specialItems),
    ground: groundTransportRequested(state, info),
  };
}

export function tripSheetDialPhone(state = {}, purpose) {
  const sheet = state.tripSheetData && typeof state.tripSheetData === 'object'
    ? state.tripSheetData
    : {};
  return clean(purpose === 'arrival' ? sheet.toAirportPhone : sheet.fromAirportPhone);
}

export function resolveDialPhone(state = {}, purpose) {
  const overrides = state.fboCallDialOverrides && typeof state.fboCallDialOverrides === 'object'
    ? state.fboCallDialOverrides
    : {};
  const override = clean(overrides[purpose]);
  return {
    display: override || tripSheetDialPhone(state, purpose),
    source: override ? 'override' : 'trip_sheet',
    isOverride: Boolean(override),
  };
}

export function materialHash(facts) {
  const json = JSON.stringify(facts || {});
  let hash = 5381;
  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash) + json.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function scheduledDialAt({
  purpose,
  startMs,
  endMs,
  depLeadMinutes = DEFAULT_DEP_LEAD_MINUTES,
  arrLeadMinutes = DEFAULT_ARR_LEAD_MINUTES,
} = {}) {
  if (purpose === 'arrival') {
    const arrival = Number.isFinite(endMs) ? endMs : (Number(startMs) || 0) + 90 * 60_000;
    return arrival - Number(arrLeadMinutes) * 60_000;
  }
  return Number(startMs) - Number(depLeadMinutes) * 60_000;
}

export function resolveDialAt(plannedAt, now, eventMs) {
  if (!Number.isFinite(eventMs)) return { ok: false, reason: 'Flight time is missing' };
  if (now > eventMs + 30 * 60_000) {
    return { ok: false, reason: 'This movement already occurred; a new call would be too late' };
  }
  const dialAt = Number.isFinite(plannedAt) && plannedAt > now ? plannedAt : now;
  return { ok: true, dialAt };
}

export function armDialPlan({
  purpose,
  plannedAt,
  resolvedDialAt,
  now,
  dialImmediately = true,
} = {}) {
  if (dialImmediately) {
    const plan = [{ callPhase: 'initial', dialAt: now, dialMode: 'immediate' }];
    if (purpose === 'arrival' && plannedAt > now + 60_000) {
      plan.push({
        callPhase: 'arrival_reverification',
        dialAt: plannedAt,
        dialMode: 'scheduled',
      });
    }
    return plan;
  }
  return [{
    callPhase: purpose === 'arrival' ? 'arrival_reverification' : 'initial',
    dialAt: resolvedDialAt,
    dialMode: 'scheduled',
  }];
}

export function nextRetryAt(now, retryMinutes = DEFAULT_RETRY_MINUTES) {
  return now + Number(retryMinutes) * 60_000;
}

export function publicCallSummary(call) {
  if (!call || typeof call !== 'object') return null;
  return {
    id: call.id,
    tripId: call.tripId,
    purpose: call.purpose,
    status: call.status,
    isUpdate: call.isUpdate === true,
    callPhase: call.callPhase || 'initial',
    dialMode: call.dialMode || 'scheduled',
    airport: call.airport || '',
    fboName: call.fboName || '',
    phone: call.phoneDisplay || call.phoneE164 || '',
    hours: call.hours || '',
    hoursKnown: Boolean(call.hours),
    dialAt: call.dialAt || null,
    scheduledDialAt: call.scheduledDialAt || null,
    startedAt: call.startedAt || null,
    endedAt: call.endedAt || null,
    attempts: call.attempts || 0,
    lastError: call.lastError || '',
    confirmations: call.confirmations || null,
    summary: call.summary || '',
    transcript: call.transcript || '',
    factsHash: call.factsHash || '',
    leadPassengerDisclosed: call.leadPassengerDisclosed === true,
    armedByName: call.armedByName || '',
    armedAt: call.armedAt || null,
    vendor: call.vendor || VOICE_VENDOR,
    callerId: call.callerId || SKYWAY_CALLER_ID,
    callerName: call.callerName || SKYWAY_CALLER_NAME,
    phoneSource: call.phoneSource || call.facts?.phoneSource || 'trip_sheet',
    scheduledLocalLine: call.scheduledLocalLine || call.facts?.scheduledLocalLine || '',
    listenAvailable: ['dialing', 'in_progress'].includes(call.status) && Boolean(call.vendorCallId),
    recordingAvailable: Boolean(
      call.recordingAvailable
      || (call.vendorCallId && ['completed', 'failed', 'needs_followup'].includes(call.status)),
    ),
  };
}

/**
 * Facts the voice agent may speak. Passenger identity is included only when
 * ground transportation is on the trip, and only the lead passenger name.
 */
export function buildSpeakableFacts({
  trip = {},
  state = {},
  purpose,
} = {}) {
  const info = trip.info || {};
  const airport = purpose === 'arrival'
    ? clean(info.to).toUpperCase()
    : clean(info.from).toUpperCase();
  const requestedName = purpose === 'arrival'
    ? clean(state.toFbo)
    : clean(state.fromFbo);
  const dialPhone = resolveDialPhone(state, purpose);
  const phoneDisplay = dialPhone.display;
  const phone = toE164(phoneDisplay);
  const ground = groundTransportRequested(state, info);
  const lead = ground ? leadPassengerName(state) : '';
  const paxCount = Number.isFinite(Number(state.paxOverride))
    ? Number(state.paxOverride)
    : Number(info.pax || 0);
  const startMs = toMillis(trip.start);
  const endMs = toMillis(trip.end);
  const blockers = [];
  if (!clean(state.tripSheetUrl)) blockers.push('No trip sheet uploaded');
  if (!airport) blockers.push('Airport is missing');
  if (airport && !getAirportTimezone(airport)) blockers.push('Airport local timezone is missing');
  if (!requestedName) blockers.push('FBO name is missing from the trip sheet');
  if (!phone) {
    blockers.push(dialPhone.isOverride
      ? 'The call phone override is not a valid phone number'
      : 'No FBO phone number on the trip sheet');
  }

  const startLocal = formatLocalMilitaryTime(trip.start, purpose === 'arrival' ? airport : clean(info.from).toUpperCase());
  const endLocal = formatLocalMilitaryTime(trip.end, purpose === 'arrival' ? airport : clean(info.to).toUpperCase());
  const scheduledLocal = purpose === 'arrival' ? endLocal : startLocal;
  const fromAirport = clean(info.from).toUpperCase();
  const toAirport = clean(info.to).toUpperCase();
  const specialInstructions = clean(state.tripSheetNotes?.specialItems);
  const parkingRequest = PARKING_RE.test(specialInstructions)
    ? specialInstructions
    : 'not confirmed on the trip details';
  const aircraftType = clean(info.aircraftType || state.tripSheetData?.aircraftType);

  const facts = {
    callerName: SKYWAY_CALLER_NAME,
    callerId: SKYWAY_CALLER_ID,
    callerIdDisplay: SKYWAY_CALLER_ID_DISPLAY,
    purpose,
    airport,
    otherAirport: purpose === 'arrival' ? clean(info.from).toUpperCase() : clean(info.to).toUpperCase(),
    airportSpoken: spokenTailNumber(airport),
    otherAirportSpoken: spokenTailNumber(
      purpose === 'arrival' ? clean(info.from).toUpperCase() : clean(info.to).toUpperCase(),
    ),
    routeSpoken: `${spokenTailNumber(fromAirport)} to ${spokenTailNumber(toAirport)}`,
    tail: clean(info.tail).toUpperCase(),
    tailSpoken: spokenTailNumber(info.tail),
    aircraftType,
    fboName: requestedName,
    fboNameSource: 'trip_sheet',
    requestedFboName: requestedName,
    matchConfidence: 'trip_sheet',
    phoneE164: phone,
    phoneDisplay,
    phoneSource: dialPhone.source,
    hours: '',
    hoursKnown: false,
    fuelBrand: '',
    website: '',
    startIso: toIso(trip.start),
    endIso: toIso(trip.end),
    scheduledLocalDisplay: scheduledLocal.display,
    scheduledLocalSpoken: scheduledLocal.spoken,
    scheduledLocalZone: scheduledLocal.zone,
    scheduledLocalLine: scheduledLocal.line,
    scheduledLocalSpokenLine: scheduledLocal.spokenLine,
    startLocalLine: startLocal.line,
    endLocalLine: endLocal.line,
    arrivalDateLocal: endLocal.date,
    arrivalTimeLocal: endLocal.display,
    arrivalTimeSpoken: endLocal.spoken,
    arrivalTimeZone: endLocal.zone,
    departureDateLocal: startLocal.date,
    departureTimeLocal: startLocal.display,
    departureTimeSpoken: startLocal.spoken,
    departureTimeZone: startLocal.zone,
    arrivingPaxCount: paxCount,
    departingPaxCount: paxCount,
    parkingRequest,
    paxCount,
    hasCatering: cateringRequested(state, info),
    specialItems: specialInstructions,
    specialInstructions,
    groundTransport: ground,
    leadPassengerName: lead,
    pic: clean(info.pic),
    sic: clean(info.sic),
    startMs,
    endMs,
  };

  return {
    ok: blockers.length === 0,
    blockers,
    facts,
    material: materialFacts(trip, state),
    hash: materialHash(materialFacts(trip, state)),
  };
}

export function dueForDial(job, now) {
  if (!job) return false;
  if (!['armed', 'scheduled', 'retry'].includes(job.status) && job.status !== CALL_STATUSES.armed && job.status !== CALL_STATUSES.scheduled) {
    return false;
  }
  if (['dialing', 'in_progress', 'completed', 'cancelled'].includes(job.status)) return false;
  if (job.status === CALL_STATUSES.failed && (job.attempts || 0) >= (job.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
    return false;
  }
  const when = Number(job.dialAt);
  return Number.isFinite(when) && when <= now;
}

export function shouldQueueUpdate(previousHash, nextHash, previousStatus) {
  if (!previousHash || !nextHash || previousHash === nextHash) return false;
  return ['completed', 'needs_followup', 'failed'].includes(previousStatus);
}

export function fboCallOutstanding(trip, state, now = Date.now()) {
  const info = trip?.info || {};
  if (info.legType && info.legType !== 'REVENUE') return [];
  const start = toMillis(trip?.start);
  if (start == null) return [];
  const hours = (start - now) / 3600_000;
  if (hours > 36 || hours < -2) return [];
  const calls = Array.isArray(state?.fboCalls) ? state.fboCalls : [];
  const items = [];
  const failed = calls.find((call) => call.status === CALL_STATUSES.failed || call.status === CALL_STATUSES.needs_followup);
  if (failed) {
    items.push({
      code: 'fbo-call-followup',
      label: `FBO call needs follow-up (${failed.fboName || failed.purpose || 'FBO'})`,
      severity: 'critical',
    });
    return items;
  }
  const active = calls.some((call) => ['armed', 'scheduled', 'dialing', 'in_progress', 'completed'].includes(call.status));
  if (!active && hours <= 6) {
    items.push({
      code: 'fbo-call-unarmed',
      label: 'FBO calls not armed',
      severity: hours <= 2 ? 'warn' : 'info',
    });
  }
  return items;
}

/**
 * Names Skyway accepts for each Vapi credential. The canonical name is first;
 * the rest are names operators commonly use because that is how Vapi's own
 * dashboard labels the value.
 */
const VAPI_ENV_NAMES = Object.freeze({
  apiKey: ['VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'VAPI_KEY', 'VAPI_TOKEN'],
  phoneNumberId: ['VAPI_PHONE_NUMBER_ID', 'VAPI_PHONE_ID'],
  phoneNumber: ['VAPI_PHONE_NUMBER'],
  assistantId: ['VAPI_ASSISTANT_ID'],
  webhookSecret: ['VAPI_WEBHOOK_SECRET'],
});

/**
 * Values pasted into the Vercel dashboard routinely arrive wrapped in quotes or
 * with a trailing newline. Vapi rejects those as an invalid key, which reads as
 * a missing-configuration problem.
 */
function envValue(env, name) {
  return String(env?.[name] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

export function vapiEnvValue(env = {}, field) {
  for (const name of VAPI_ENV_NAMES[field] || []) {
    const value = envValue(env, name);
    if (value) return value;
  }
  return '';
}

export function vendorEnvDiagnostics(env = {}) {
  const apiKey = vapiEnvValue(env, 'apiKey');
  const phoneNumberId = vapiEnvValue(env, 'phoneNumberId');
  const phoneNumber = vapiEnvValue(env, 'phoneNumber');
  const assistantId = vapiEnvValue(env, 'assistantId');
  const missing = [];
  if (!apiKey) missing.push('VAPI_API_KEY');
  // The prompt and voice live in Vapi, so a saved assistant is required.
  if (!assistantId) missing.push('VAPI_ASSISTANT_ID');
  const warnings = Object.keys(env || {})
    .filter((name) => name.startsWith('VITE_VAPI'))
    .map((name) => `${name} is exposed to browsers. Rename it to ${name.replace(/^VITE_/, '')}.`);
  return {
    hasApiKey: Boolean(apiKey),
    hasPhoneNumber: Boolean(phoneNumberId || phoneNumber),
    phoneNumberLookup: !phoneNumberId && !phoneNumber ? 'automatic_by_number' : 'environment',
    callerNumber: SKYWAY_CALLER_ID,
    hasAssistant: Boolean(vapiEnvValue(env, 'assistantId')),
    hasWebhookSecret: Boolean(vapiEnvValue(env, 'webhookSecret')),
    missing,
    warnings,
  };
}

export function vendorConfigured(env = {}) {
  return vendorEnvDiagnostics(env).missing.length === 0;
}
