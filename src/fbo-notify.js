/**
 * FBO notification rules shared by the ops UI, the departure cron, and tests.
 *
 * Trips are addressed by JetInsight trip ID (6–7 letters and digits). A numeric
 * trip number is a different field and is never used here. Each calendar leg
 * is its own record; departure and arrival FBOs are matched independently.
 */

import { readTripId } from './fleet-tracking.js';

export const FBO_TEST_RECIPIENT = 'jake@flyskyway.com';
export const FBO_OPS_EMAIL = 'charters@flyskyway.com';
export const FBO_OPS_PHONE = '727-605-5000';
export const PUBLIC_APP_ORIGIN = 'https://www.skyway.app';
export const DEPARTURE_LEAD_MS = 60 * 60 * 1000;
export const REMINDER_LOCK_MS = 3 * 60 * 1000;
export const DEFAULT_ARRIVAL_LEAD_HOURS = 24;
export const MATERIAL_ETA_MS = 15 * 60 * 1000;
export const DEPARTURE_MATCH_WINDOW_MS = 8 * 60 * 60 * 1000;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TOKEN_AFTER_ARRIVAL_MS = 36 * 60 * 60 * 1000;
export const AUTO_CONFIRM_SCORE = 0.84;
export const SUGGEST_SCORE = 0.62;
export const SYNC_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;
export const SYNC_PAST_MS = 6 * 60 * 60 * 1000;
export const DESK_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

export const FBO_LEGS = 'fbo-legs';
export const FBO_DIRECTORY = 'fbo-directory';
export const FBO_EMAIL_LOG = 'fbo-email-log';
export const FBO_NOTICES = 'fbo-ops-notices';
export const FBO_SETTINGS_DOC = 'fbo-notify';

const GENERIC = new Set([
  'aviation', 'flight', 'support', 'services', 'service', 'international',
  'intl', 'airport', 'group', 'fbo', 'the', 'of', 'and', 'llc', 'inc',
  'corp', 'co', 'ltd',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

/**
 * Firestore rejects `undefined` anywhere in a document write. Omit those
 * keys instead of turning on ignoreUndefinedProperties for the whole app.
 * Null is kept: it is how an optional field is explicitly cleared.
 */
export function omitUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => omitUndefined(item));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = omitUndefined(item);
  }
  return out;
}

export function normalizeAirport(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
}

/** KAPF and APF are the same field. Other codes compare exactly. */
export function sameAirport(a, b) {
  const left = normalizeAirport(a);
  const right = normalizeAirport(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const strip = (code) => (code.length === 4 && code.startsWith('K') ? code.slice(1) : code);
  return strip(left) === strip(right);
}

export function validEmail(value) {
  return EMAIL_RE.test(clean(value));
}

export function directoryDocId(airport, aid) {
  const code = normalizeAirport(airport) || 'UNKNOWN';
  const id = clean(aid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown';
  return `${code}__${id}`;
}

export function defaultFboSettings() {
  return {
    testMode: true,
    live: false,
    arrivalAutoLeadHours: DEFAULT_ARRIVAL_LEAD_HOURS,
  };
}

/** Missing settings use 24 hours. An explicit null or "off" stays off. */
export function resolveGlobalLeadHours(data, exists = true) {
  if (!exists || !data || !Object.prototype.hasOwnProperty.call(data, 'arrivalAutoLeadHours')) {
    return DEFAULT_ARRIVAL_LEAD_HOURS;
  }
  return normalizeLeadHours(data.arrivalAutoLeadHours);
}

/**
 * Test mode is on unless an administrator has explicitly turned it off.
 * FBO_EMAIL_TEST_MODE=1 (or true/on) forces test mode even after that toggle.
 */
export function resolveTestMode(settings, env = process.env) {
  const forced = clean(env?.FBO_EMAIL_TEST_MODE).toLowerCase();
  if (forced === '1' || forced === 'true' || forced === 'on') return true;
  if (settings && settings.testMode === false && settings.live === true) return false;
  return true;
}

export function normalizeLeadHours(value) {
  if (value == null || value === '' || value === false || value === 'off') return null;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const allowed = [1, 2, 3, 4, 6, 12, 24];
  return allowed.includes(hours) ? hours : null;
}

export function fboNameTokens(name) {
  return clean(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !GENERIC.has(token));
}

export function scoreFboNames(hint, candidate) {
  const left = fboNameTokens(hint);
  const right = fboNameTokens(candidate);
  if (!left.length || !right.length) return 0;
  const a = left.join(' ');
  const b = right.join(' ');
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter) && shorter.length >= 4) {
    return Math.min(0.98, 0.86 + (0.12 * shorter.length) / longer.length);
  }
  const setA = new Set(left);
  const setB = new Set(right);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  if (!shared) return 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  let contained = true;
  for (const token of smaller) {
    if (!larger.has(token)) contained = false;
  }
  if (contained && [...smaller].some((token) => token.length >= 4)) return 0.9;
  const union = setA.size + setB.size - shared;
  return union ? shared / union : 0;
}

export function isHandlingProvider(provider) {
  const category = clean(provider?.category).toUpperCase();
  if (provider?.fbo === true) return true;
  if (category === 'FUEL') return false;
  return category === 'HANDLING';
}

/**
 * Pick the aviowiki handling/FBO provider that best matches the names already
 * on the leg. A close call stays unconfirmed so ops can choose. With no name
 * at all, the airport's preferred FBO is only a suggestion.
 */
export function matchFbo({ hints = [], providers = [], preferredAid = null } = {}) {
  const handling = (providers || []).filter(isHandlingProvider);
  const names = [];
  for (const hint of hints) {
    const value = clean(hint);
    if (value && !names.some((item) => item.toLowerCase() === value.toLowerCase())) names.push(value);
  }
  if (!handling.length) {
    return { status: 'unmatched', score: 0, provider: null, ambiguous: false, reason: 'no-providers' };
  }

  if (!names.length) {
    const preferred = preferredAid
      ? handling.find((provider) => provider.aid && provider.aid === preferredAid)
      : null;
    if (preferred) {
      return {
        status: 'suggested',
        score: 0.7,
        provider: preferred,
        ambiguous: false,
        reason: 'preferred',
        auto: false,
      };
    }
    return { status: 'unmatched', score: 0, provider: null, ambiguous: false, reason: 'no-name' };
  }

  const ranked = handling.map((provider) => {
    const score = Math.max(...names.map((hint) => scoreFboNames(hint, provider.name)));
    return { provider, score };
  }).sort((a, b) => b.score - a.score || clean(a.provider.name).localeCompare(clean(b.provider.name)));

  const best = ranked[0];
  const second = ranked[1];
  const ambiguous = Boolean(second && best.score >= SUGGEST_SCORE && (best.score - second.score) < 0.05);
  let winner = best;
  if (
    preferredAid
    && second
    && second.provider.aid === preferredAid
    && second.score >= SUGGEST_SCORE
    && (best.score - second.score) <= 0.08
  ) {
    winner = second;
  } else if (
    preferredAid
    && best.provider.aid !== preferredAid
  ) {
    const preferred = ranked.find((row) => row.provider.aid === preferredAid && row.score >= best.score - 0.08 && row.score >= SUGGEST_SCORE);
    if (preferred && best.score - preferred.score <= 0.08 && best.score < 0.98) winner = preferred;
  }

  if (!winner || winner.score < SUGGEST_SCORE) {
    return { status: 'unmatched', score: winner?.score || 0, provider: null, ambiguous: false, reason: 'low-score' };
  }
  const auto = !ambiguous && winner.score >= AUTO_CONFIRM_SCORE;
  return {
    status: auto ? 'auto' : 'suggested',
    score: Math.round(winner.score * 1000) / 1000,
    provider: winner.provider,
    ambiguous,
    reason: ambiguous ? 'ambiguous' : (auto ? 'name' : 'review'),
    auto,
  };
}

export function isRepositioning(leg) {
  const kind = `${clean(leg?.legType)} ${clean(leg?.category)}`.toUpperCase();
  return /\b(REPO|FERRY|REPOSITION)/.test(kind);
}

/** Passenger count, or the empty-leg label. Never a passenger name. */
export function paxLabel(leg) {
  const pax = Number(leg?.pax);
  if (!Number.isFinite(pax) || pax <= 0 || (isRepositioning(leg) && pax <= 0)) {
    return 'EMPTY / repositioning';
  }
  return String(Math.round(pax));
}

export function isCancelledLeg(leg) {
  if (!leg) return true;
  if (leg.cancelled === true || leg.archived === true || leg.droppedFromSchedule === true) return true;
  const kind = `${clean(leg.legType)} ${clean(leg.category)} ${clean(leg.status)}`.toUpperCase();
  return /\bCANCEL/.test(kind);
}

export function toMillis(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function iso(value) {
  const ms = toMillis(value);
  return ms == null ? null : new Date(ms).toISOString();
}

export function formatLocalClock(value, timeZone) {
  const ms = toMillis(value);
  if (ms == null) return 'Time not set';
  const zone = timeZone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return `${new Date(ms).toISOString()} UTC`;
  }
}

export function formatSubjectToChange(value, timeZone) {
  const clock = formatLocalClock(value, timeZone);
  if (clock === 'Time not set') return 'Time not set (subject to change)';
  return `${clock} (subject to change)`;
}

function sideOf(leg, side) {
  return (side === 'arrival' ? leg?.arrival : leg?.departure) || {};
}

export function directoryOptedOut(directory, side) {
  if (!side?.aid) return side?.optedOut === true;
  const row = directory?.get?.(directoryDocId(side.airport, side.aid))
    || directory?.[directoryDocId(side.airport, side.aid)]
    || null;
  if (row && row.optedOut === true) return true;
  return side?.optedOut === true && !row;
}

function emailsBlocked(leg, sideName, directory) {
  if (leg?.emailsDisabled === true) return 'trip-disabled';
  const side = sideOf(leg, sideName);
  if (side.suppressed === true) return 'side-disabled';
  if (directoryOptedOut(directory, side)) return 'fbo-opt-out';
  return null;
}

/**
 * Whether the 1-hour departure reminder should go out on this cron pass.
 * A changed departure time is a new idempotency key, so the reminder is
 * retimed. The same departure is never mailed twice.
 */
export function departureReminderDecision(leg, now = Date.now(), directory = null) {
  const startMs = toMillis(leg?.start);
  const key = startMs == null ? null : `${leg.legUid || leg.uid}:dep:${startMs}`;
  const base = { key, startMs, dueAt: startMs == null ? null : startMs - DEPARTURE_LEAD_MS };
  if (isCancelledLeg(leg)) return { ...base, action: 'skip', reason: 'cancelled' };
  const blocked = emailsBlocked(leg, 'departure', directory);
  if (blocked) return { ...base, action: 'skip', reason: blocked };
  const side = sideOf(leg, 'departure');
  if (!validEmail(side.email)) return { ...base, action: 'skip', reason: 'missing-email' };
  const confirmed = side.matchStatus === 'confirmed' || side.matchStatus === 'manual' || side.matchStatus === 'auto';
  if (!confirmed) return { ...base, action: 'skip', reason: 'unconfirmed' };
  if (startMs == null) return { ...base, action: 'skip', reason: 'no-departure' };
  if (now < base.dueAt) return { ...base, action: 'wait', reason: 'before-window' };
  if (now >= startMs) return { ...base, action: 'skip', reason: 'already-departed' };
  if (side.reminderStatus === 'sent' && iso(side.reminderSentForStart) === iso(leg.start)) {
    return { ...base, action: 'skip', reason: 'already-sent' };
  }
  if (side.reminderStatus === 'sending' && Number(side.reminderLockAt) > now - REMINDER_LOCK_MS) {
    return { ...base, action: 'skip', reason: 'in-flight' };
  }
  const previous = iso(side.reminderSentForStart);
  return { ...base, action: 'send', reason: previous && previous !== iso(leg.start) ? 'retimed' : 'due' };
}

function directoryRowFor(directory, side) {
  if (!side?.aid) return null;
  return directory?.get?.(directoryDocId(side.airport, side.aid))
    || directory?.[directoryDocId(side.airport, side.aid)]
    || null;
}

export function directoryArrivalScheduleOff(directory, side) {
  return directoryRowFor(directory, side)?.arrivalScheduleOff === true;
}

/**
 * When the advance arrival email is due.
 * A per-leg "off" or a specific send time wins over the global lead.
 * A per-leg hour override wins over the global default (24h).
 */
export function arrivalSendPlan(leg, globalLeadHours = DEFAULT_ARRIVAL_LEAD_HOURS) {
  const side = sideOf(leg, 'arrival');
  const endMs = toMillis(leg?.end);
  if (side.scheduleDisabled === true || side.leadHours === 'off' || side.leadHours === 0) {
    return { mode: 'off', dueAt: null, leadHours: null, endMs };
  }
  const sendAt = toMillis(side.sendAt);
  if (sendAt != null) return { mode: 'at', dueAt: sendAt, leadHours: null, endMs };
  const override = side.leadHours != null && side.leadHours !== ''
    ? normalizeLeadHours(side.leadHours)
    : null;
  const hours = override != null ? override : normalizeLeadHours(globalLeadHours);
  if (hours == null) return { mode: 'off', dueAt: null, leadHours: null, endMs };
  return {
    mode: override != null ? 'override' : 'default',
    dueAt: endMs == null ? null : endMs - hours * 60 * 60 * 1000,
    leadHours: hours,
    endMs,
  };
}

function etaMoved(leg) {
  const endMs = toMillis(leg?.end);
  const sentMs = toMillis(leg?.arrival?.sentForEnd);
  if (endMs == null || sentMs == null) return false;
  return Math.abs(endMs - sentMs) >= MATERIAL_ETA_MS;
}

function freshLock(side, now, key) {
  return Number(side?.sendLockAt) > now - REMINDER_LOCK_MS && side?.pendingKey && side.pendingKey === key;
}

/**
 * Advance arrival mail: initial request, an update when the ETA moves before
 * confirmation, or a time-change notice after the FBO has already confirmed.
 */
export function arrivalScheduleDecision(leg, now = Date.now(), globalLeadHours = DEFAULT_ARRIVAL_LEAD_HOURS, directory = null) {
  const plan = arrivalSendPlan(leg, globalLeadHours);
  const side = sideOf(leg, 'arrival');
  const endMs = plan.endMs;
  const uid = leg?.legUid || leg?.uid || 'leg';
  const base = { ...plan, key: null };
  if (isCancelledLeg(leg)) return { ...base, action: 'skip', reason: 'cancelled' };
  const blocked = emailsBlocked(leg, 'arrival', directory);
  if (blocked) return { ...base, action: 'skip', reason: blocked };
  if (!validEmail(side.email)) return { ...base, action: 'skip', reason: 'missing-email' };
  const matched = side.matchStatus === 'confirmed' || side.matchStatus === 'manual' || side.matchStatus === 'auto';
  if (!matched) return { ...base, action: 'skip', reason: 'unconfirmed' };
  if (endMs == null) return { ...base, action: 'skip', reason: 'no-eta' };
  if (now >= endMs) return { ...base, action: 'skip', reason: 'already-arrived' };

  const status = side.arrivalStatus || 'not_sent';
  const moved = etaMoved(leg);
  const endKey = endMs;

  if (status === 'confirmed' && moved) {
    const key = `${uid}:arr-change:${endKey}`;
    if (iso(side.timeChangeForEnd) === iso(leg.end)) return { ...base, action: 'skip', reason: 'already-notified', key };
    if (freshLock(side, now, key)) return { ...base, action: 'skip', reason: 'in-flight', key };
    return { ...base, action: 'time-change', reason: 'eta-moved', key, kind: 'arrival_time_change' };
  }
  if (status === 'needs_reconfirm') {
    const key = `${uid}:arr-change:${endKey}`;
    if (iso(side.timeChangeForEnd) === iso(leg.end) || !moved) {
      return { ...base, action: 'skip', reason: 'awaiting-reconfirm', key };
    }
    if (freshLock(side, now, key)) return { ...base, action: 'skip', reason: 'in-flight', key };
    return { ...base, action: 'time-change', reason: 'eta-moved', key, kind: 'arrival_time_change' };
  }

  if (['sent', 'opened', 'question'].includes(status) && moved) {
    const key = `${uid}:arr-update:${endKey}`;
    if (directoryArrivalScheduleOff(directory, side) || side.scheduleDisabled === true) {
      return { ...base, action: 'skip', reason: 'advance-off', key };
    }
    if (freshLock(side, now, key)) return { ...base, action: 'skip', reason: 'in-flight', key };
    return { ...base, action: 'update', reason: 'eta-moved', key, kind: 'arrival_update' };
  }

  if (directoryArrivalScheduleOff(directory, side) || side.scheduleDisabled === true) {
    return { ...base, mode: 'off', action: 'skip', reason: 'advance-off' };
  }
  if (status === 'scheduled_manual') return { ...base, action: 'skip', reason: 'marked-scheduled' };
  if (['sent', 'opened', 'question', 'confirmed'].includes(status)) {
    return { ...base, action: 'skip', reason: 'already-sent', key: `${uid}:arr:${endKey}` };
  }
  if (plan.mode === 'off' || plan.dueAt == null) return { ...base, action: 'skip', reason: 'auto-off' };
  const key = `${uid}:arr:${endKey}`;
  if (freshLock(side, now, key) || (status === 'sending' && Number(side.sendLockAt) > now - REMINDER_LOCK_MS)) {
    return { ...base, action: 'skip', reason: 'in-flight', key };
  }
  if (now < plan.dueAt) return { ...base, action: 'wait', reason: 'before-window', key };
  return { ...base, action: 'send', reason: 'due', key, kind: 'arrival_schedule' };
}

export function arrivalAutoDecision(leg, now, leadHours, directory = null) {
  const decision = arrivalScheduleDecision(leg, now, leadHours, directory);
  if (decision.action === 'update' || decision.action === 'time-change') {
    return { ...decision, action: 'send' };
  }
  return decision;
}

/**
 * Actual departure, preferring FlightAware / off-block / wheels-up over a
 * manual "departed" tap. Scheduled time alone does not count as departed.
 */
export function pickDepartureSignal(leg, { tripState = null, flightaware = null } = {}) {
  const candidates = [];
  const push = (at, source, rank) => {
    const ms = toMillis(at);
    if (ms == null) return;
    candidates.push({ at: new Date(ms).toISOString(), ms, source, rank });
  };
  push(leg?.actualOff, 'actual_off', 1);
  const statuses = tripState?.statuses || leg?.statuses || {};
  push(statuses.wheels_up?.timestamp, 'wheels_up', 1);
  push(leg?.actualOut, 'actual_out', 2);
  push(statuses.taxi_dep?.timestamp, 'taxi_dep', 2);
  if (flightaware?.actualOff && sameAirport(flightaware.origin, leg?.from)) {
    const offMs = toMillis(flightaware.actualOff);
    const startMs = toMillis(leg?.start);
    const near = startMs == null || (offMs != null && Math.abs(offMs - startMs) <= DEPARTURE_MATCH_WINDOW_MS);
    const destOk = !flightaware.destination || sameAirport(flightaware.destination, leg?.to);
    if (near && destOk) push(flightaware.actualOff, 'flightaware', 1);
  }
  push(leg?.departedManualAt, 'manual', 5);
  candidates.sort((a, b) => a.rank - b.rank || a.ms - b.ms);
  return candidates[0] || null;
}

export function inboundDecision(leg, now = Date.now(), directory = null, departed = null) {
  const uid = leg?.legUid || leg?.uid || 'leg';
  const key = `${uid}:inbound`;
  const side = sideOf(leg, 'arrival');
  const base = { key, departedAt: departed?.at || null, source: departed?.source || null };
  if (isCancelledLeg(leg)) return { ...base, action: 'skip', reason: 'cancelled' };
  const blocked = emailsBlocked(leg, 'arrival', directory);
  if (blocked) return { ...base, action: 'skip', reason: blocked };
  if (!validEmail(side.email)) return { ...base, action: 'skip', reason: 'missing-email' };
  const matched = side.matchStatus === 'confirmed' || side.matchStatus === 'manual' || side.matchStatus === 'auto';
  if (!matched) return { ...base, action: 'skip', reason: 'unconfirmed' };
  if (side.inboundStatus === 'sent') return { ...base, action: 'skip', reason: 'already-sent' };
  if (side.inboundStatus === 'sending' && Number(side.inboundLockAt) > now - REMINDER_LOCK_MS) {
    return { ...base, action: 'skip', reason: 'in-flight' };
  }
  if (!departed?.at) return { ...base, action: 'skip', reason: 'not-departed' };
  const endMs = toMillis(leg?.end);
  if (endMs != null && now > endMs + 60 * 60 * 1000) return { ...base, action: 'skip', reason: 'too-late' };
  return { ...base, action: 'send', reason: departed.source || 'departed', kind: 'inbound_notice' };
}

export function reminderView(leg, now = Date.now(), directory = null) {
  const decision = departureReminderDecision(leg, now, directory);
  const side = sideOf(leg, 'departure');
  if (decision.action === 'wait' || (decision.action === 'send' && decision.reason !== 'retimed' && side.reminderStatus !== 'failed')) {
    return { status: 'scheduled', dueAt: decision.dueAt, reason: decision.reason };
  }
  if (decision.reason === 'already-sent') {
    return { status: 'sent', sentAt: side.reminderSentAt || null, dueAt: decision.dueAt };
  }
  if (side.reminderStatus === 'failed' && decision.action === 'send') {
    return { status: 'failed', error: side.reminderError || 'Delivery failed', dueAt: decision.dueAt };
  }
  if (decision.action === 'skip' && decision.reason === 'missing-email') {
    return { status: 'scheduled', reason: 'missing-email', dueAt: decision.dueAt };
  }
  if (decision.action === 'skip') {
    return { status: side.reminderStatus === 'sent' ? 'sent' : 'scheduled', reason: decision.reason, dueAt: decision.dueAt };
  }
  return { status: 'scheduled', dueAt: decision.dueAt, reason: decision.reason };
}

export function arrivalView(side = {}) {
  const status = side.arrivalStatus || 'not_sent';
  return {
    status,
    label: arrivalStatusLabel(status, side),
    sentAt: side.sentAt || null,
    openedAt: side.openedAt || null,
    confirmedBy: side.confirmedBy || null,
    confirmedAt: side.confirmedAt || null,
    notes: side.csrNotes || side.manualNote || '',
    question: side.question || '',
    inboundStatus: side.inboundStatus || 'not_sent',
    inboundSentAt: side.inboundSentAt || null,
  };
}

export function arrivalPlanView(leg, globalLeadHours = DEFAULT_ARRIVAL_LEAD_HOURS, now = Date.now()) {
  const decision = arrivalScheduleDecision(leg, now, globalLeadHours);
  const inbound = inboundDecision(leg, now, null, pickDepartureSignal(leg));
  return {
    ...arrivalView(leg?.arrival || {}),
    dueAt: decision.dueAt,
    mode: decision.mode,
    leadHours: decision.leadHours,
    scheduleReason: decision.reason,
    scheduleAction: decision.action,
    inboundAction: inbound.action,
    inboundReason: inbound.reason,
    departedAt: inbound.departedAt || leg?.departedAt || null,
    departedSource: inbound.source || leg?.departedSource || null,
  };
}

export function arrivalStatusLabel(status, side = {}) {
  if (status === 'confirmed') {
    const who = clean(side.confirmedBy) || 'CSR';
    return `Confirmed by ${who}`;
  }
  if (status === 'needs_reconfirm') return 'Needs re-confirm';
  if (status === 'question') return 'Question from FBO';
  if (status === 'opened') return 'Opened';
  if (status === 'sent') return 'Sent';
  if (status === 'scheduled_manual') return 'Marked scheduled';
  if (status === 'sending') return 'Sending';
  return 'Not sent';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function testModeBanner(intendedTo) {
  const who = escapeHtml(intendedTo || 'unknown recipient');
  return `<div style="background:#fef3c7;border:1px solid #d97706;border-radius:8px;padding:12px 14px;margin:0 0 16px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;color:#78350f;">
    <strong>TEST MODE.</strong> This FBO email was redirected and was not delivered to the FBO.
    Intended recipient: <strong>${who}</strong>.
  </div>`;
}

function detailTable(rows) {
  const body = rows.map(([label, value]) => `<tr>
    <td style="padding:6px 12px 6px 0;font-size:13px;color:#6b7280;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:600;">${value}</td>
  </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px 0;">${body}</table>`;
}

export function tripIdLabel(leg) {
  return readTripId(leg?.tripId, leg) || 'Unavailable';
}

export function applyTestRecipient(intendedTo, testMode) {
  const intended = clean(intendedTo);
  if (!testMode) return { to: intended, intendedTo: intended, testMode: false };
  return { to: FBO_TEST_RECIPIENT, intendedTo: intended, testMode: true };
}

export function buildDepartureEmail(leg, { timeZone } = {}) {
  const tripId = tripIdLabel(leg);
  const when = formatSubjectToChange(leg.start, timeZone);
  const destination = clean(leg.arrivalAirportName)
    ? `${normalizeAirport(leg.to)} · ${clean(leg.arrivalAirportName)}`
    : (normalizeAirport(leg.to) || 'Destination on file');
  const subject = `Skyway departure reminder · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.from)}`;
  const rows = [
    ['Tail', escapeHtml(clean(leg.tail) || '—')],
    ['Trip ID', escapeHtml(tripId)],
    ['Passengers', escapeHtml(paxLabel(leg))],
    ['Scheduled departure', escapeHtml(when)],
    ['Arrival', escapeHtml(destination)],
    ['Skyway ops', `${escapeHtml(FBO_OPS_EMAIL)} · ${escapeHtml(FBO_OPS_PHONE)}`],
  ];
  const html = `<p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;">Departure reminder for a Skyway aircraft.</p>
    ${detailTable(rows)}
    <p style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;color:#4b5563;">The departure time is subject to change. Contact Skyway ops with any conflict.</p>`;
  const text = [
    'Departure reminder for a Skyway aircraft.',
    '',
    `Tail: ${clean(leg.tail) || '—'}`,
    `Trip ID: ${tripId}`,
    `Passengers: ${paxLabel(leg)}`,
    `Scheduled departure: ${when}`,
    `Arrival: ${destination}`,
    `Skyway ops: ${FBO_OPS_EMAIL} · ${FBO_OPS_PHONE}`,
    '',
    'The departure time is subject to change.',
  ].join('\n');
  return { subject, html, text, type: 'departure_reminder' };
}

export function buildArrivalEmail(leg, confirmLink, { timeZone } = {}) {
  const tripId = tripIdLabel(leg);
  const eta = formatSubjectToChange(leg.end || leg.start, timeZone);
  const services = clean(leg.arrival?.services) || 'None listed';
  const notes = clean(leg.arrival?.opsNotes) || 'None';
  const subject = `Skyway arrival · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.to)}`;
  const link = escapeHtml(confirmLink);
  const rows = [
    ['Tail', escapeHtml(clean(leg.tail) || '—')],
    ['Trip ID', escapeHtml(tripId)],
    ['ETA', escapeHtml(eta)],
    ['Passengers', escapeHtml(paxLabel(leg))],
    ['Services requested', escapeHtml(services)],
    ['Notes', escapeHtml(notes)],
    ['Skyway ops', `${escapeHtml(FBO_OPS_EMAIL)} · ${escapeHtml(FBO_OPS_PHONE)}`],
  ];
  const html = `<p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;">Please confirm this Skyway arrival is on your schedule.</p>
    ${detailTable(rows)}
    <p style="margin:16px 0;">
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;font-weight:600;padding:12px 18px;border-radius:8px;">You're on our schedule</a>
    </p>
    <p style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#6b7280;">Or open this link: <a href="${link}" style="color:#12708C;">${link}</a></p>`;
  const text = [
    'Please confirm this Skyway arrival is on your schedule.',
    '',
    `Tail: ${clean(leg.tail) || '—'}`,
    `Trip ID: ${tripId}`,
    `ETA: ${eta}`,
    `Passengers: ${paxLabel(leg)}`,
    `Services requested: ${services}`,
    `Notes: ${notes}`,
    `Skyway ops: ${FBO_OPS_EMAIL} · ${FBO_OPS_PHONE}`,
    '',
    `Confirm: ${confirmLink}`,
  ].join('\n');
  return { subject, html, text, type: 'arrival_schedule' };
}

function arrivalDetailEmail(leg, confirmLink, { timeZone, intro, subject, type, previousEta } = {}) {
  const tripId = tripIdLabel(leg);
  const eta = formatSubjectToChange(leg.end || leg.start, timeZone);
  const services = clean(leg.arrival?.services) || 'None listed';
  const notes = clean(leg.arrival?.opsNotes) || 'None';
  const link = escapeHtml(confirmLink);
  const rows = [
    ['Tail', escapeHtml(clean(leg.tail) || '—')],
    ['Trip ID', escapeHtml(tripId)],
    ...(previousEta ? [['Previous ETA', escapeHtml(formatLocalClock(previousEta, timeZone))]] : []),
    ['ETA', escapeHtml(eta)],
    ['Passengers', escapeHtml(paxLabel(leg))],
    ['Services requested', escapeHtml(services)],
    ['Notes', escapeHtml(notes)],
    ['Skyway ops', `${escapeHtml(FBO_OPS_EMAIL)} · ${escapeHtml(FBO_OPS_PHONE)}`],
  ];
  const html = `<p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;">${intro}</p>
    ${detailTable(rows)}
    <p style="margin:16px 0;">
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;font-weight:600;padding:12px 18px;border-radius:8px;">You're on our schedule</a>
    </p>
    <p style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#6b7280;">Or open this link: <a href="${link}" style="color:#12708C;">${link}</a></p>`;
  const text = [
    intro.replace(/<[^>]+>/g, ''),
    '',
    `Tail: ${clean(leg.tail) || '—'}`,
    `Trip ID: ${tripId}`,
    ...(previousEta ? [`Previous ETA: ${formatLocalClock(previousEta, timeZone)}`] : []),
    `ETA: ${eta}`,
    `Passengers: ${paxLabel(leg)}`,
    `Services requested: ${services}`,
    `Notes: ${notes}`,
    `Skyway ops: ${FBO_OPS_EMAIL} · ${FBO_OPS_PHONE}`,
    '',
    `Confirm: ${confirmLink}`,
  ].join('\n');
  return { subject, html, text, type };
}

export function buildArrivalUpdateEmail(leg, confirmLink, { timeZone, previousEta } = {}) {
  const tripId = tripIdLabel(leg);
  return arrivalDetailEmail(leg, confirmLink, {
    timeZone,
    previousEta,
    type: 'arrival_update',
    subject: `Skyway arrival update · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.to)}`,
    intro: 'The arrival time changed before this flight was confirmed. Please confirm the updated schedule.',
  });
}

export function buildArrivalTimeChangeEmail(leg, confirmLink, { timeZone, previousEta } = {}) {
  const tripId = tripIdLabel(leg);
  return arrivalDetailEmail(leg, confirmLink, {
    timeZone,
    previousEta,
    type: 'arrival_time_change',
    subject: `Skyway arrival time change · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.to)}`,
    intro: 'This arrival was confirmed, and the time has since changed. Please reconfirm you are still on our schedule.',
  });
}

export function buildInboundEmail(leg, confirmLink, { timeZone, originTimeZone, departedAt } = {}) {
  const tripId = tripIdLabel(leg);
  const origin = normalizeAirport(leg.from) || 'origin';
  const departed = formatLocalClock(departedAt, originTimeZone);
  const eta = formatSubjectToChange(leg.end || leg.start, timeZone);
  const services = clean(leg.arrival?.services) || 'None listed';
  const headline = `Inbound — departed ${origin} at ${departed}`;
  const subject = `Skyway inbound · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · departed ${origin}`;
  const link = escapeHtml(confirmLink);
  const rows = [
    ['Tail', escapeHtml(clean(leg.tail) || '—')],
    ['Trip ID', escapeHtml(tripId)],
    ['Departed', escapeHtml(`${origin} at ${departed}`)],
    ['Passengers', escapeHtml(paxLabel(leg))],
    ['ETA', escapeHtml(eta)],
    ['Services requested', escapeHtml(services)],
    ['Skyway ops', `${escapeHtml(FBO_OPS_EMAIL)} · ${escapeHtml(FBO_OPS_PHONE)}`],
  ];
  const html = `<p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;">${escapeHtml(headline)}</p>
    ${detailTable(rows)}
    <p style="margin:16px 0;">
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;font-weight:600;padding:12px 18px;border-radius:8px;">You're on our schedule</a>
    </p>
    <p style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;font-size:12px;color:#6b7280;">Or open this link: <a href="${link}" style="color:#12708C;">${link}</a></p>`;
  const text = [
    headline,
    '',
    `Tail: ${clean(leg.tail) || '—'}`,
    `Trip ID: ${tripId}`,
    `Passengers: ${paxLabel(leg)}`,
    `ETA: ${eta}`,
    `Services requested: ${services}`,
    `Skyway ops: ${FBO_OPS_EMAIL} · ${FBO_OPS_PHONE}`,
    '',
    `Confirm: ${confirmLink}`,
  ].join('\n');
  return { subject, html, text, type: 'inbound_notice' };
}

export function buildOpsNoticeEmail({ kind, leg, csrName, notes }) {
  const tripId = tripIdLabel(leg);
  const verb = kind === 'question' ? 'asked a question' : 'confirmed the arrival';
  const subject = kind === 'question'
    ? `FBO question · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.to)}`
    : `FBO confirmed · ${clean(leg.tail) || 'Aircraft'} · Trip ${tripId} · ${normalizeAirport(leg.to)}`;
  const who = clean(csrName) || 'FBO';
  const body = clean(notes) || (kind === 'question' ? 'No question text was included.' : 'No notes.');
  const html = `<p style="margin:0 0 12px 0;font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;">${escapeHtml(who)} ${escapeHtml(verb)}.</p>
    ${detailTable([
      ['Tail', escapeHtml(clean(leg.tail) || '—')],
      ['Trip ID', escapeHtml(tripId)],
      ['Airport', escapeHtml(normalizeAirport(leg.to) || '—')],
      ['FBO', escapeHtml(clean(leg.arrival?.name) || '—')],
      [kind === 'question' ? 'Question' : 'Notes', escapeHtml(body)],
    ])}`;
  const text = [
    `${who} ${verb}.`,
    '',
    `Tail: ${clean(leg.tail) || '—'}`,
    `Trip ID: ${tripId}`,
    `Airport: ${normalizeAirport(leg.to) || '—'}`,
    `FBO: ${clean(leg.arrival?.name) || '—'}`,
    `${kind === 'question' ? 'Question' : 'Notes'}: ${body}`,
  ].join('\n');
  return { subject, html, text, type: 'ops_notice' };
}

export function composeFboHtml({ html, testMode, intendedTo }) {
  const banner = testMode ? testModeBanner(intendedTo) : '';
  return `${banner}${html}`;
}

/** Public confirm page payload. Passenger names are never included. */
export function publicLegView(leg, { timeZone, expired = false } = {}) {
  return {
    tail: clean(leg?.tail),
    tripId: tripIdLabel(leg) === 'Unavailable' ? '' : tripIdLabel(leg),
    from: normalizeAirport(leg?.from),
    to: normalizeAirport(leg?.to),
    airportName: clean(leg?.arrivalAirportName),
    fboName: clean(leg?.arrival?.name),
    eta: formatSubjectToChange(leg?.end || leg?.start, timeZone),
    passengers: paxLabel(leg),
    services: clean(leg?.arrival?.services),
    notes: clean(leg?.arrival?.opsNotes),
    opsEmail: FBO_OPS_EMAIL,
    opsPhone: FBO_OPS_PHONE,
    arrivalStatus: leg?.arrival?.arrivalStatus || 'not_sent',
    confirmedBy: clean(leg?.arrival?.confirmedBy),
    expired,
  };
}

export function legSyncRecord(trip, extras = {}) {
  const info = trip?.info || {};
  const cancelled = extras.cancelled === true
    || /cancel/i.test(clean(trip?.raw?.STATUS))
    || /cancel/i.test(clean(info.category))
    || /cancel/i.test(clean(info.legType));
  return {
    legUid: clean(trip?.uid || extras.uid),
    tripId: readTripId(extras.tripId, info.tripCode, info.tripId, trip) || null,
    tail: clean(info.tail || extras.tail).toUpperCase(),
    from: normalizeAirport(info.from || extras.from),
    to: normalizeAirport(info.to || extras.to),
    start: iso(extras.start || trip?.start),
    end: iso(extras.end || trip?.end),
    pax: Number.isFinite(Number(extras.pax ?? info.pax)) ? Number(extras.pax ?? info.pax) : 0,
    legType: clean(extras.legType || info.legType).toUpperCase(),
    category: clean(extras.category || info.category).toUpperCase(),
    isFlight: extras.isFlight != null ? extras.isFlight !== false : info.isFlight !== false,
    fromFboName: clean(extras.fromFboName || extras.fromFbo || info.fromFbo) || null,
    toFboName: clean(extras.toFboName || extras.toFbo || info.toFbo) || null,
    fromHints: Array.isArray(extras.fromHints) ? extras.fromHints.map(clean).filter(Boolean).slice(0, 8) : [],
    toHints: Array.isArray(extras.toHints) ? extras.toHints.map(clean).filter(Boolean).slice(0, 8) : [],
    cancelled,
    archived: extras.archived === true,
    actualOff: iso(extras.actualOff) || null,
    actualOut: iso(extras.actualOut) || null,
  };
}

export function legInSyncWindow(record, now = Date.now()) {
  if (!record?.legUid || record.isFlight === false) return false;
  if (!record.from || !record.to || !record.tail) return false;
  const startMs = toMillis(record.start);
  if (startMs == null) return false;
  return startMs >= now - SYNC_PAST_MS && startMs <= now + SYNC_FUTURE_MS;
}

export function mergeSyncedLeg(existing, incoming, now = Date.now()) {
  const prev = existing || {};
  const next = {
    ...prev,
    legUid: incoming.legUid,
    tripId: incoming.tripId || prev.tripId || null,
    tail: incoming.tail || prev.tail || '',
    from: incoming.from || prev.from || '',
    to: incoming.to || prev.to || '',
    start: incoming.start || prev.start || null,
    end: incoming.end || prev.end || null,
    pax: Number.isFinite(Number(incoming.pax)) ? Number(incoming.pax) : (Number.isFinite(Number(prev.pax)) ? Number(prev.pax) : 0),
    legType: incoming.legType || prev.legType || '',
    category: incoming.category || prev.category || '',
    cancelled: incoming.cancelled === true || incoming.archived === true,
    archived: incoming.archived === true,
    droppedFromSchedule: false,
    fromFboName: incoming.fromFboName || prev.fromFboName || null,
    toFboName: incoming.toFboName || prev.toFboName || null,
    actualOff: incoming.actualOff || prev.actualOff || null,
    actualOut: incoming.actualOut || prev.actualOut || null,
    departedManualAt: prev.departedManualAt || null,
    departedAt: prev.departedAt || null,
    departedSource: prev.departedSource || null,
    syncedAt: now,
    updatedAt: now,
  };
  next.departure = retainSide(prev.departure, {
    airport: next.from,
    hintName: next.fromFboName,
    hints: incoming.fromHints,
  }, prev.fromFboName);
  next.arrival = retainSide(prev.arrival, {
    airport: next.to,
    hintName: next.toFboName,
    hints: incoming.toHints,
  }, prev.toFboName);
  if (next.departure.reminderSentForStart && next.departure.reminderSentForStart !== next.start && next.departure.reminderStatus === 'sent') {
    next.departure = { ...next.departure, reminderStatus: 'scheduled' };
  }
  return next;
}

function retainSide(previous, seed, previousHint) {
  const prev = previous || {};
  const hintChanged = seed.hintName && previousHint && seed.hintName !== previousHint;
  if (hintChanged && prev.matchStatus !== 'manual' && prev.locked !== true) {
    return blankSide(seed);
  }
  return {
    ...blankSide(seed),
    ...prev,
    airport: seed.airport || prev.airport || '',
    hintName: seed.hintName || prev.hintName || null,
    hints: seed.hints?.length ? seed.hints : (prev.hints || []),
  };
}

export function blankSide(seed = {}) {
  return {
    airport: seed.airport || '',
    hintName: seed.hintName || null,
    hints: seed.hints || [],
    aid: null,
    name: '',
    email: '',
    phone: '',
    contact: '',
    emailSource: '',
    matchScore: 0,
    matchStatus: 'unmatched',
    locked: false,
    suppressed: false,
    reminderStatus: 'scheduled',
    reminderSentForStart: null,
    reminderSentAt: null,
    reminderError: null,
    reminderLockAt: null,
    arrivalStatus: 'not_sent',
    services: '',
    opsNotes: '',
    sentAt: null,
    sentForEnd: null,
    openedAt: null,
    tokenIssuedAt: null,
    confirmedBy: '',
    confirmedAt: null,
    csrNotes: '',
    question: '',
    questionAt: null,
    manualBy: '',
    manualNote: '',
    manualAt: null,
    sendLockAt: null,
    pendingKey: null,
    leadHours: null,
    sendAt: null,
    scheduleDisabled: false,
    timeChangeForEnd: null,
    inboundStatus: 'not_sent',
    inboundSentAt: null,
    inboundLockAt: null,
    inboundError: null,
  };
}

export function contactFromMatch(match, directoryRow) {
  const provider = match?.provider || {};
  const directoryEmail = clean(directoryRow?.email);
  const aviowikiEmail = clean(provider.email);
  const email = validEmail(directoryEmail) ? directoryEmail : (validEmail(aviowikiEmail) ? aviowikiEmail : '');
  let emailSource = '';
  if (validEmail(directoryEmail) && directoryEmail.toLowerCase() !== aviowikiEmail.toLowerCase()) emailSource = 'directory';
  else if (validEmail(aviowikiEmail)) emailSource = 'aviowiki';
  else if (validEmail(directoryEmail)) emailSource = 'directory';
  return {
    aid: provider.aid || null,
    name: clean(provider.name),
    email,
    phone: clean(directoryRow?.phone) || clean(provider.phone),
    contact: clean(directoryRow?.contact),
    emailSource,
    matchScore: match?.score || 0,
    matchStatus: match?.status === 'auto' ? 'auto' : (match?.provider ? 'suggested' : 'unmatched'),
    optedOut: directoryRow?.optedOut === true,
  };
}

export function applyMatchToSide(side, match, directoryRow) {
  const contact = contactFromMatch(match, directoryRow);
  return {
    ...blankSide(),
    ...side,
    ...contact,
    airport: side?.airport || '',
    hintName: side?.hintName || null,
    hints: side?.hints || [],
    locked: side?.locked === true,
    suppressed: side?.suppressed === true,
    services: side?.services || '',
    opsNotes: side?.opsNotes || '',
    arrivalStatus: side?.arrivalStatus || 'not_sent',
    reminderStatus: side?.reminderStatus || 'scheduled',
    reminderSentForStart: side?.reminderSentForStart || null,
    reminderSentAt: side?.reminderSentAt || null,
    reminderError: side?.reminderError || null,
    sentAt: side?.sentAt || null,
    sentForEnd: side?.sentForEnd || null,
    openedAt: side?.openedAt || null,
    tokenIssuedAt: side?.tokenIssuedAt || null,
    confirmedBy: side?.confirmedBy || '',
    confirmedAt: side?.confirmedAt || null,
    csrNotes: side?.csrNotes || '',
    question: side?.question || '',
  };
}

const OPEN_ARRIVAL = new Set(['not_sent', 'sent', 'opened', 'sending', 'question', 'needs_reconfirm', '']);

export function arrivalStillOpen(leg) {
  const status = leg?.arrival?.arrivalStatus || 'not_sent';
  return OPEN_ARRIVAL.has(status);
}

export function filterDeskLegs(legs, filters = {}, now = Date.now()) {
  const date = clean(filters.date || 'upcoming').toLowerCase();
  const airport = normalizeAirport(filters.airport);
  const status = clean(filters.status || 'open').toLowerCase();
  const missingOnly = filters.missingEmail === true || filters.missingEmail === '1';
  const fromMs = Number(filters.fromMs);
  const toMs = Number(filters.toMs);
  const hasRange = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  return (legs || []).filter((leg) => {
    if (isCancelledLeg(leg)) return status === 'cancelled';
    const startMs = toMillis(leg.start);
    if (startMs == null) return false;
    if (hasRange) {
      if (startMs < fromMs || startMs >= toMs) return false;
    } else if (startMs < now - SYNC_PAST_MS || startMs > now + DESK_HORIZON_MS) {
      if (date !== 'all') return false;
    }
    if (airport && !sameAirport(leg.from, airport) && !sameAirport(leg.to, airport)) return false;
    const arrival = leg.arrival?.arrivalStatus || 'not_sent';
    const missing = !validEmail(leg.departure?.email) || !validEmail(leg.arrival?.email);
    if (missingOnly && !missing) return false;
    if (status === 'all') return true;
    if (status === 'open') return arrivalStillOpen(leg) && arrival !== 'question';
    if (status === 'missing-email') return missing;
    if (status === 'reminder-failed') return leg.departure?.reminderStatus === 'failed';
    if (status === 'question') return arrival === 'question';
    if (status === 'needs_reconfirm' || status === 'needs-reconfirm') return arrival === 'needs_reconfirm';
    if (status === 'confirmed') return arrival === 'confirmed' || arrival === 'scheduled_manual';
    return arrival === status;
  }).sort((a, b) => (toMillis(a.start) || 0) - (toMillis(b.start) || 0));
}

export function deskCounts(legs, now = Date.now()) {
  const upcoming = (legs || []).filter((leg) => {
    const startMs = toMillis(leg.start);
    return startMs != null && !isCancelledLeg(leg) && startMs >= now - SYNC_PAST_MS && startMs <= now + DESK_HORIZON_MS;
  });
  return {
    open: upcoming.filter((leg) => arrivalStillOpen(leg) && (leg.arrival?.arrivalStatus || 'not_sent') !== 'question').length,
    missingEmail: upcoming.filter((leg) => !validEmail(leg.departure?.email) || !validEmail(leg.arrival?.email)).length,
    reminderFailed: upcoming.filter((leg) => leg.departure?.reminderStatus === 'failed').length,
    questions: upcoming.filter((leg) => leg.arrival?.arrivalStatus === 'question').length,
    confirmed: upcoming.filter((leg) => ['confirmed', 'scheduled_manual'].includes(leg.arrival?.arrivalStatus)).length,
  };
}

export function confirmPagePath(origin, token) {
  const base = clean(origin || PUBLIC_APP_ORIGIN).replace(/\/+$/, '') || PUBLIC_APP_ORIGIN;
  return `${base}/fbo-confirm?token=${encodeURIComponent(token)}`;
}

export function clipText(value, max) {
  return clean(value).slice(0, max);
}

/** Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Missing secret denies. */
export function cronAuthorized(req, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  return header === `Bearer ${secret}`;
}
