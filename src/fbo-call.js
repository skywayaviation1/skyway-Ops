/**
 * FBO calling agent — verified facts, matching, and scheduling rules.
 *
 * Voice sessions run on Vapi (LLM) over Twilio PSTN. This module never
 * places a call; it only decides what the agent is allowed to say and when
 * Skyway ops may arm a dial.
 */

export const SKYWAY_CALLER_NAME = 'Skyway Aviation';
export const SKYWAY_CALLER_ID = '+17276055000';
export const SKYWAY_CALLER_ID_DISPLAY = '1-727-605-5000';
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

const GROUND_RE = /\b(ground\s*trans(?:port(?:ation)?)?|limo(?:usine)?|car\s*service|chauffeur|town\s*car|meet\s*(?:and|&)\s*greet|courtesy\s*(?:car|van)|rental\s*car|uber|lyft|taxi)\b/i;

const clean = (value) => String(value ?? '').trim();

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
    listenAvailable: ['dialing', 'in_progress'].includes(call.status) && Boolean(call.vendorCallId),
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
  if (!requestedName) blockers.push('FBO name is missing from the trip sheet');
  if (!phone) {
    blockers.push(dialPhone.isOverride
      ? 'The call phone override is not a valid phone number'
      : 'No FBO phone number on the trip sheet');
  }

  const facts = {
    callerName: SKYWAY_CALLER_NAME,
    callerId: SKYWAY_CALLER_ID,
    callerIdDisplay: SKYWAY_CALLER_ID_DISPLAY,
    purpose,
    airport,
    otherAirport: purpose === 'arrival' ? clean(info.from).toUpperCase() : clean(info.to).toUpperCase(),
    tail: clean(info.tail).toUpperCase(),
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
    paxCount,
    hasCatering: cateringRequested(state, info),
    specialItems: clean(state.tripSheetNotes?.specialItems),
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

export function assistantSystemPrompt(facts) {
  const hoursLine = facts.hoursKnown
    ? `Published hours (verify, do not invent): ${facts.hours}`
    : 'Hours are not on the uploaded trip sheet. Say that Skyway does not have published hours on file and offer to have operations follow up. Never guess hours.';
  const groundLine = facts.groundTransport
    ? `Ground transportation is requested. You may give the lead passenger name (${facts.leadPassengerName || 'name not on file'}) ONLY when discussing ground transportation. Do not volunteer the name for fuel, hangar, or catering.`
    : 'Do not speak any passenger names.';
  return [
    `You are an automated operations assistant for ${facts.callerName}.`,
    `Caller ID on this call is ${facts.callerName}, ${facts.callerIdDisplay}.`,
    'Introduce yourself as a Skyway Aviation automated ops assistant. You are not a pilot and not a passenger.',
    'Speak only the verified trip and service facts below. If a question is not covered, say you will transfer to Skyway operations.',
    'Never invent FBOs, times, fuel prices, hangar availability, or passenger details.',
    'If the person is not the FBO, apologize and end the call.',
    '',
    'Verified trip:',
    `- Aircraft: ${facts.tail || 'not on file'}`,
    `- Route: ${facts.purpose === 'arrival' ? `${facts.otherAirport} to ${facts.airport}` : `${facts.airport} to ${facts.otherAirport}`}`,
    `- This call is the ${facts.purpose} FBO: ${facts.fboName} at ${facts.airport}`,
    `- Scheduled ${facts.purpose === 'arrival' ? 'arrival' : 'departure'}: ${facts.purpose === 'arrival' ? facts.endIso : facts.startIso}`,
    `- Passenger count: ${facts.paxCount}`,
    `- Catering requested: ${facts.hasCatering ? 'yes' : 'no'}`,
    `- Special items: ${facts.specialItems || 'none on file'}`,
    `- Ground transportation requested: ${facts.groundTransport ? 'yes' : 'no'}`,
    `- ${hoursLine}`,
    `- ${groundLine}`,
    facts.fuelBrand ? `- Fuel brand on file: ${facts.fuelBrand}` : '',
    '',
    'Collect and confirm, then summarize back:',
    '1. They have the movement on the board',
    '2. Fuel / handling if asked by Skyway or offered by them',
    '3. Hangar or overnight if relevant',
    '4. Catering if catering is requested',
    '5. Ground transportation if requested',
    '6. Any restriction they volunteer (hours, call-out, GPU, lav)',
    '',
    'Sensitive topics (pricing contracts, incidents, medical, security, customs beyond routine, anything you are unsure of): offer a live transfer to Skyway operations.',
    'When the FBO asks to speak with a person, transfer to operations.',
  ].filter(Boolean).join('\n');
}

export function firstMessage(facts) {
  return `Hello, this is an automated operations assistant calling from ${facts.callerName} regarding a charter flight. Is this ${facts.fboName} at ${facts.airport}?`;
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

export function vendorConfigured(env = {}) {
  return Boolean(clean(env.VAPI_API_KEY) && (clean(env.VAPI_PHONE_NUMBER_ID) || clean(env.VAPI_PHONE_NUMBER)));
}
