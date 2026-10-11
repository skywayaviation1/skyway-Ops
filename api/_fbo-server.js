// Server orchestration for FBO matching, mail, and the public confirm page.
// Firestore database: appusers. The Admin SDK bypasses security rules.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { reviewerSessionBlock } from '../src/reviewer-account.js';
import { cronArrivalFollowUp, scrubFirestoreWrites } from '../src/omit-undefined.js';
import { getAirportTimezone } from '../src/airports.js';
import {
  FBO_DIRECTORY,
  FBO_EMAIL_LOG,
  FBO_LEGS,
  FBO_NOTICES,
  FBO_OPS_EMAIL,
  FBO_SETTINGS_DOC,
  PUBLIC_APP_ORIGIN,
  TOKEN_AFTER_ARRIVAL_MS,
  applyMatchToSide,
  arrivalScheduleDecision,
  blankSide,
  buildArrivalEmail,
  buildArrivalTimeChangeEmail,
  buildArrivalUpdateEmail,
  buildDepartureEmail,
  buildInboundEmail,
  buildOpsNoticeEmail,
  clean,
  clipText,
  composeFboHtml,
  confirmPagePath,
  contactFromMatch,
  defaultFboSettings,
  departureReminderDecision,
  deskCounts,
  directoryDocId,
  filterDeskLegs,
  inboundDecision,
  isCancelledLeg,
  isHandlingProvider,
  iso,
  legInSyncWindow,
  matchFbo,
  mergeSyncedLeg,
  normalizeAirport,
  normalizeLeadHours,
  pickDepartureSignal,
  publicLegView,
  resolveGlobalLeadHours,
  resolveTestMode,
  toMillis,
  validEmail,
} from '../src/fbo-notify.js';
import { applySkywaySignature, withCharterCopy } from './_email-signature.js';
import { deliverNotification } from './_email-transport.js';
import { signFboToken, verifyFboToken } from './_fbo-token.js';
import { getAirportFbos } from './_aviowiki.js';

const READ_ROLES = ['ops', 'admin', 'sales'];
const WRITE_ROLES = ['ops', 'admin'];

let app = null;

export function fboAdminApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const error = new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
    error.status = 503;
    throw error;
  }
  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return app;
}

export function fboDb() {
  return scrubFirestoreWrites(getFirestore(fboAdminApp(), 'appusers'));
}

function readBody(req) {
  if (!req?.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export async function authorizeFbo(req, { write = false } = {}) {
  const body = readBody(req);
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const idToken = (header.replace(/^Bearer\s+/i, '') !== header ? header.replace(/^Bearer\s+/i, '') : '')
    || body.idToken
    || '';
  if (!idToken) {
    const error = new Error('Sign in required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = reviewerSessionBlock(await admin.auth(fboAdminApp()).verifyIdToken(idToken, true));
  } catch {
    const error = new Error('Invalid or revoked session');
    error.status = 401;
    throw error;
  }
  const snap = await fboDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  const roles = write ? WRITE_ROLES : READ_ROLES;
  if (!snap.exists || !roles.includes(profile.role) || profile.active === false || profile.approved !== true) {
    const error = new Error(write ? 'Ops or administrator access required' : 'Flight operations access required');
    error.status = 403;
    throw error;
  }
  return {
    uid: decoded.uid,
    email: decoded.email || profile.email || '',
    name: profile.name || decoded.name || decoded.email || 'Skyway Ops',
    role: profile.role,
  };
}

export async function loadSettings(db = fboDb()) {
  const snap = await db.collection('app-config').doc(FBO_SETTINGS_DOC).get();
  const data = snap.exists ? snap.data() || {} : {};
  const settings = {
    ...defaultFboSettings(),
    ...data,
    arrivalAutoLeadHours: resolveGlobalLeadHours(data, snap.exists),
  };
  if (settings.testMode !== false) settings.testMode = true;
  settings.live = settings.testMode === false && settings.live === true;
  settings.testMode = resolveTestMode(settings);
  return settings;
}

export async function saveSettings(patch, actor, db = fboDb()) {
  const current = await loadSettings(db);
  const nextTest = patch.testMode === false ? false : true;
  const next = {
    testMode: nextTest,
    live: nextTest === false,
    arrivalAutoLeadHours: Object.prototype.hasOwnProperty.call(patch, 'arrivalAutoLeadHours')
      ? normalizeLeadHours(patch.arrivalAutoLeadHours)
      : current.arrivalAutoLeadHours,
    updatedAt: Date.now(),
    updatedByUid: actor?.uid || null,
    updatedByName: actor?.name || null,
  };
  await db.collection('app-config').doc(FBO_SETTINGS_DOC).set(next, { merge: true });
  return { ...next, testMode: resolveTestMode(next) };
}

async function loadDirectoryMap(db, airports) {
  const map = new Map();
  const codes = [...new Set((airports || []).map(normalizeAirport).filter(Boolean))];
  await Promise.all(codes.map(async (airport) => {
    const snap = await db.collection(FBO_DIRECTORY).where('airport', '==', airport).get();
    snap.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data() }));
  }));
  return map;
}

function directoryRow(map, airport, aid) {
  if (!aid) return null;
  return map.get(directoryDocId(airport, aid)) || null;
}

function zoneFor(airport, fallback) {
  return fallback || getAirportTimezone(airport) || 'UTC';
}

async function providersFor(airport) {
  try {
    const result = await getAirportFbos(airport);
    return {
      airportName: result.airportName || '',
      providers: (result.fbos || []).filter(isHandlingProvider),
      unavailable: false,
    };
  } catch (error) {
    return { airportName: '', providers: [], unavailable: true, error: error.message };
  }
}

function hintsFor(side, fallbackName) {
  return [fallbackName, side?.hintName, ...(side?.hints || [])].filter(Boolean);
}

export async function matchAirport({ airport, hints = [], db = fboDb() }) {
  const code = normalizeAirport(airport);
  const loaded = await providersFor(code);
  const directory = await loadDirectoryMap(db, [code]);
  const preferred = [...directory.values()].find((row) => row.preferred === true);
  const match = matchFbo({
    hints,
    providers: loaded.providers,
    preferredAid: preferred?.aid || null,
  });
  const row = match.provider ? directoryRow(directory, code, match.provider.aid) : null;
  return {
    airport: code,
    airportName: loaded.airportName,
    unavailable: loaded.unavailable,
    providers: loaded.providers.map((provider) => ({
      aid: provider.aid,
      name: provider.name,
      email: provider.email || '',
      phone: provider.phone || '',
      fbo: provider.fbo === true,
      category: provider.category || '',
    })),
    directory: [...directory.values()],
    match: {
      ...match,
      contact: contactFromMatch(match, row),
    },
  };
}

async function enrichSide(side, airport, hints, directory) {
  if (side?.locked === true || ['manual', 'confirmed', 'auto'].includes(side?.matchStatus)) {
    const row = directoryRow(directory, airport, side.aid);
    if (!row) return side;
    return {
      ...side,
      email: validEmail(row.email) ? row.email : side.email,
      phone: row.phone || side.phone,
      contact: row.contact || side.contact,
      optedOut: row.optedOut === true,
      emailSource: validEmail(row.email) ? (side.emailSource || 'directory') : side.emailSource,
    };
  }
  const loaded = await providersFor(airport);
  const preferred = [...directory.values()].find((row) => row.airport === normalizeAirport(airport) && row.preferred);
  const match = matchFbo({
    hints: hintsFor(side, hints),
    providers: loaded.providers,
    preferredAid: preferred?.aid || null,
  });
  const row = match.provider ? directoryRow(directory, airport, match.provider.aid) : null;
  const applied = applyMatchToSide(side, match, row);
  return { ...applied, airportName: loaded.airportName || side?.airportName || '' };
}

export async function syncLegs({ legs = [], complete = false, actor, db = fboDb(), now = Date.now() }) {
  const incoming = (Array.isArray(legs) ? legs : [])
    .map((leg) => ({ ...leg, legUid: clean(leg.legUid || leg.uid) }))
    .filter((leg) => legInSyncWindow(leg, now));
  const uids = incoming.map((leg) => leg.legUid);
  let serviceHints = [];
  try {
    const serviceSnap = await db.collection('service-requests').where('status', '==', 'open').limit(40).get();
    serviceHints = serviceSnap.docs.map((doc) => doc.data() || {});
  } catch {
    serviceHints = [];
  }
  const tripSnaps = await Promise.all(uids.map((uid) => db.collection('trip-state').doc(uid).get()));
  const batch = db.batch();
  let written = 0;
  const airports = new Set();

  for (let i = 0; i < incoming.length; i += 1) {
    const row = incoming[i];
    const state = tripSnaps[i].exists ? tripSnaps[i].data() || {} : {};
    const tail = clean(row.tail).toUpperCase();
    const hintNames = (airport) => serviceHints
      .filter((request) => normalizeAirport(request.location) === airport)
      .filter((request) => !request.tail || clean(request.tail).toUpperCase() === tail)
      .flatMap((request) => [request.fboName, request.shipTo?.fboName])
      .map(clean)
      .filter(Boolean);
    const mergedInput = {
      ...row,
      tripId: row.tripId || state.tripSheetData?.tripCode || state.tripCode || null,
      fromFboName: row.fromFboName || state.fromFbo || hintNames(row.from)[0] || null,
      toFboName: row.toFboName || state.toFbo || hintNames(row.to)[0] || null,
      fromHints: [...(row.fromHints || []), ...hintNames(row.from)],
      toHints: [...(row.toHints || []), ...hintNames(row.to)],
      archived: row.archived === true || state.archived === true,
      cancelled: row.cancelled === true || state.archived === true || state.statuses?.cancelled === true,
    };
    const ref = db.collection(FBO_LEGS).doc(mergedInput.legUid);
    // eslint-disable-next-line no-await-in-loop
    const existingSnap = await ref.get();
    const existing = existingSnap.exists ? existingSnap.data() : null;
    const next = mergeSyncedLeg(existing, mergedInput, now);
    if (next.from) airports.add(next.from);
    if (next.to) airports.add(next.to);
    batch.set(ref, next, { merge: true });
    written += 1;
  }

  if (complete) {
    const windowStart = now - (6 * 60 * 60 * 1000);
    const windowEnd = now + (7 * 24 * 60 * 60 * 1000);
    const snap = await db.collection(FBO_LEGS).get();
    const seen = new Set(uids);
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const startMs = toMillis(data.start);
      if (startMs == null || startMs < windowStart || startMs > windowEnd) return;
      if (seen.has(doc.id) || data.cancelled === true) return;
      batch.set(doc.ref, {
        cancelled: true,
        droppedFromSchedule: true,
        updatedAt: now,
      }, { merge: true });
    });
  }

  if (written || complete) {
    try {
      await batch.commit();
    } catch (error) {
      if (written) throw error;
    }
  }
  return { ok: true, written, actor: actor?.uid || null };
}

async function ensureMatches(leg, db) {
  const directory = await loadDirectoryMap(db, [leg.from, leg.to]);
  const departure = await enrichSide(leg.departure || blankSide({ airport: leg.from }), leg.from, leg.fromFboName, directory);
  const arrival = await enrichSide(leg.arrival || blankSide({ airport: leg.to }), leg.to, leg.toFboName, directory);
  const next = {
    ...leg,
    departure: { ...blankSide({ airport: leg.from }), ...departure, airport: leg.from },
    arrival: { ...blankSide({ airport: leg.to }), ...arrival, airport: leg.to },
    departureAirportName: departure.airportName || leg.departureAirportName || '',
    arrivalAirportName: arrival.airportName || leg.arrivalAirportName || '',
  };
  await db.collection(FBO_LEGS).doc(leg.legUid).set({
    departure: next.departure,
    arrival: next.arrival,
    departureAirportName: next.departureAirportName || null,
    arrivalAirportName: next.arrivalAirportName || null,
    updatedAt: Date.now(),
  }, { merge: true });
  return next;
}

async function writeAudit(db, entry) {
  const id = `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.collection(FBO_EMAIL_LOG).doc(id).set({
    id,
    at: Date.now(),
    ...entry,
  });
  return id;
}

async function notifyOps(db, { kind, leg, csrName, notes }) {
  const id = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const notice = {
    id,
    kind,
    legUid: leg.legUid,
    tripId: leg.tripId || null,
    tail: leg.tail || '',
    airport: leg.to || '',
    fboName: leg.arrival?.name || '',
    csrName: clean(csrName),
    notes: clipText(notes, 2000),
    createdAt: Date.now(),
    read: false,
  };
  await db.collection(FBO_NOTICES).doc(id).set(notice);
  const built = buildOpsNoticeEmail({ kind, leg, csrName, notes });
  const html = applySkywaySignature(built.html);
  const recipients = [FBO_OPS_EMAIL];
  const extra = String(process.env.OPS_ALERT_EMAILS || '').split(',').map((item) => item.trim()).filter(validEmail);
  for (const email of extra) {
    if (!recipients.some((item) => item.toLowerCase() === email.toLowerCase())) recipients.push(email);
  }
  const { to, cc } = withCharterCopy({ to: recipients });
  let status = 'sent';
  let error = null;
  try {
    const result = await deliverNotification({ to, cc, subject: built.subject, html, text: built.text });
    if (!result.ok) {
      status = 'failed';
      error = result.error || 'ops notice failed';
    }
  } catch (err) {
    status = 'failed';
    error = err.message || 'ops notice failed';
  }
  await writeAudit(db, {
    type: 'ops_notice',
    legUid: leg.legUid,
    tripId: leg.tripId || null,
    airport: leg.to || '',
    intendedTo: recipients.join(', '),
    deliveredTo: recipients.join(', '),
    testMode: false,
    status,
    error,
    subject: built.subject,
  });
  return notice;
}

async function deliverFbo({
  db, leg, type, built, intendedTo, testMode, idempotencyKey,
}) {
  const routed = testMode
    ? { to: ['jake@flyskyway.com'], intended: intendedTo }
    : { to: [intendedTo], intended: intendedTo };
  const html = applySkywaySignature(composeFboHtml({
    html: built.html,
    testMode,
    intendedTo: routed.intended,
  }));
  const { to, cc } = withCharterCopy({ to: routed.to });
  let status = 'sent';
  let error = null;
  try {
    const result = await deliverNotification({
      to,
      cc,
      subject: built.subject,
      html,
    });
    if (!result.ok) {
      status = 'failed';
      error = result.error || 'delivery failed';
    }
  } catch (err) {
    status = 'failed';
    error = err.message || 'delivery failed';
  }
  await writeAudit(db, {
    type,
    legUid: leg.legUid,
    tripId: leg.tripId || null,
    airport: type === 'departure_reminder' ? leg.from : leg.to,
    intendedTo: routed.intended,
    deliveredTo: to.concat(cc).join(', '),
    testMode: testMode === true,
    status,
    error,
    subject: built.subject,
    idempotencyKey: idempotencyKey || null,
  });
  return { status, error, deliveredTo: to };
}

export async function sendDepartureReminder(leg, { db = fboDb(), now = Date.now(), settings, force = false } = {}) {
  const live = settings || await loadSettings(db);
  const directory = await loadDirectoryMap(db, [leg.from]);
  const decision = departureReminderDecision(leg, now, directory);
  if (!force && decision.action !== 'send') return { ok: true, skipped: decision.reason };
  const intended = leg.departure?.email;
  if (!validEmail(intended)) return { ok: false, error: 'Departure FBO has no email' };
  const ref = db.collection(FBO_LEGS).doc(leg.legUid);
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = { legUid: leg.legUid, ...(snap.data() || {}), departure: { ...(leg.departure || {}), ...(snap.data()?.departure || {}) } };
    const decisionNow = departureReminderDecision(current, now, directory);
    if (!force && decisionNow.action !== 'send') return { claimed: false, reason: decisionNow.reason, key: decisionNow.key };
    if (force && current.departure?.reminderStatus === 'sending' && Number(current.departure.reminderLockAt) > now - 60_000) {
      return { claimed: false, reason: 'in-flight', key: decisionNow.key };
    }
    tx.set(ref, {
      departure: {
        ...(current.departure || {}),
        reminderStatus: 'sending',
        reminderLockAt: now,
        reminderIdempotencyKey: decisionNow.key || decision.key,
      },
    }, { merge: true });
    return { claimed: true, key: decisionNow.key || decision.key, departure: current.departure };
  });
  if (!claim.claimed) return { ok: true, skipped: claim.reason };
  const built = buildDepartureEmail(leg, { timeZone: zoneFor(leg.from, leg.departureTimeZone) });
  const result = await deliverFbo({
    db,
    leg,
    type: 'departure_reminder',
    built,
    intendedTo: intended,
    testMode: live.testMode !== false,
    idempotencyKey: claim.key,
  });
  await ref.set({
    departure: {
      ...(leg.departure || {}),
      reminderStatus: result.status === 'sent' ? 'sent' : 'failed',
      reminderSentForStart: result.status === 'sent' ? leg.start : (leg.departure?.reminderSentForStart || null),
      reminderSentAt: result.status === 'sent' ? now : (leg.departure?.reminderSentAt || null),
      reminderError: result.error,
      reminderLockAt: null,
      reminderIdempotencyKey: claim.key,
    },
    updatedAt: now,
  }, { merge: true });
  return { ok: result.status === 'sent', ...result };
}

function arrivalMailFor(kind, leg, link, timeZone, previousEta) {
  if (kind === 'update') return buildArrivalUpdateEmail(leg, link, { timeZone, previousEta });
  if (kind === 'time-change') return buildArrivalTimeChangeEmail(leg, link, { timeZone, previousEta });
  return buildArrivalEmail(leg, link, { timeZone });
}

export async function sendArrivalSchedule(leg, {
  db = fboDb(), now = Date.now(), settings, actor, services, notes, kind = 'schedule', idempotencyKey,
} = {}) {
  const live = settings || await loadSettings(db);
  if (isCancelledLeg(leg)) return { ok: false, error: 'Cancelled legs are not scheduled' };
  if (leg.emailsDisabled || leg.arrival?.suppressed) return { ok: false, error: 'Emails are disabled for this trip' };
  const directory = await loadDirectoryMap(db, [leg.to]);
  const row = directoryRow(directory, leg.to, leg.arrival?.aid);
  if (row?.optedOut || leg.arrival?.optedOut) return { ok: false, error: 'This FBO is opted out of email' };
  const intended = validEmail(row?.email) ? row.email : leg.arrival?.email;
  if (!validEmail(intended)) return { ok: false, error: 'Arrival FBO has no email' };
  const issuedAt = leg.arrival?.tokenIssuedAt || now;
  let token;
  try {
    token = signFboToken(leg.legUid, issuedAt);
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || null };
  }
  const origin = process.env.PUBLIC_APP_ORIGIN || PUBLIC_APP_ORIGIN;
  const previousEta = leg.arrival?.sentForEnd
    ? new Date(leg.arrival.sentForEnd).toISOString()
    : '';
  const timeZone = zoneFor(leg.to, leg.arrivalTimeZone);
  const nextArrival = {
    ...(leg.arrival || {}),
    email: intended,
    services: services != null ? clipText(services, 2000) : (leg.arrival?.services || ''),
    opsNotes: notes != null ? clipText(notes, 2000) : (leg.arrival?.opsNotes || ''),
    sendLockAt: now,
    pendingKey: idempotencyKey || null,
    tokenIssuedAt: issuedAt,
  };
  const withNotes = { ...leg, arrival: nextArrival };
  const built = arrivalMailFor(kind, withNotes, confirmPagePath(origin, token), timeZone, previousEta);
  const result = await deliverFbo({
    db,
    leg: withNotes,
    type: built.type,
    built,
    intendedTo: intended,
    testMode: live.testMode !== false,
    idempotencyKey: idempotencyKey || `${leg.legUid}:arr:${iso(leg.end) || issuedAt}`,
  });
  const sent = result.status === 'sent';
  let arrivalStatus = leg.arrival?.arrivalStatus || 'not_sent';
  if (sent && kind === 'time-change') arrivalStatus = 'needs_reconfirm';
  else if (sent) arrivalStatus = 'sent';
  else if (kind === 'schedule' && arrivalStatus === 'sending') arrivalStatus = 'not_sent';
  await db.collection(FBO_LEGS).doc(leg.legUid).set({
    arrival: {
      ...nextArrival,
      arrivalStatus,
      sentAt: sent ? now : (leg.arrival?.sentAt || null),
      sentForEnd: sent ? (leg.end || null) : (leg.arrival?.sentForEnd || null),
      timeChangeForEnd: sent && kind === 'time-change' ? (leg.end || null) : (leg.arrival?.timeChangeForEnd || null),
      sendLockAt: null,
      pendingKey: null,
      lastSendError: result.error,
      lastSentBy: actor?.name || 'Skyway Ops',
    },
    updatedAt: now,
  }, { merge: true });
  return { ok: sent, ...result, tokenIssuedAt: issuedAt, kind };
}

export async function sendInboundNotice(leg, {
  db = fboDb(), now = Date.now(), settings, actor, departedAt, source, idempotencyKey,
} = {}) {
  const live = settings || await loadSettings(db);
  if (isCancelledLeg(leg)) return { ok: false, error: 'Cancelled legs are not notified' };
  if (leg.emailsDisabled || leg.arrival?.suppressed) return { ok: false, error: 'Emails are disabled for this trip' };
  if (leg.arrival?.inboundStatus === 'sent') return { ok: true, skipped: 'already-sent' };
  const directory = await loadDirectoryMap(db, [leg.to]);
  const row = directoryRow(directory, leg.to, leg.arrival?.aid);
  if (row?.optedOut || leg.arrival?.optedOut) return { ok: false, error: 'This FBO is opted out of email' };
  const intended = validEmail(row?.email) ? row.email : leg.arrival?.email;
  if (!validEmail(intended)) return { ok: false, error: 'Arrival FBO has no email' };
  const issuedAt = leg.arrival?.tokenIssuedAt || now;
  let token;
  try {
    token = signFboToken(leg.legUid, issuedAt);
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || null };
  }
  const origin = process.env.PUBLIC_APP_ORIGIN || PUBLIC_APP_ORIGIN;
  const when = departedAt || leg.departedAt || leg.actualOff || leg.start;
  const nextArrival = {
    ...(leg.arrival || {}),
    email: intended,
    inboundStatus: 'sending',
    inboundLockAt: now,
    tokenIssuedAt: issuedAt,
  };
  const built = buildInboundEmail({ ...leg, arrival: nextArrival }, confirmPagePath(origin, token), {
    timeZone: zoneFor(leg.to, leg.arrivalTimeZone),
    originTimeZone: zoneFor(leg.from, leg.departureTimeZone),
    departedAt: when,
  });
  const result = await deliverFbo({
    db,
    leg,
    type: 'inbound_notice',
    built,
    intendedTo: intended,
    testMode: live.testMode !== false,
    idempotencyKey: idempotencyKey || `${leg.legUid}:inbound`,
  });
  const sent = result.status === 'sent';
  await db.collection(FBO_LEGS).doc(leg.legUid).set({
    departedAt: iso(when),
    departedSource: source || leg.departedSource || null,
    arrival: {
      ...nextArrival,
      inboundStatus: sent ? 'sent' : 'failed',
      inboundSentAt: sent ? now : (leg.arrival?.inboundSentAt || null),
      inboundLockAt: null,
      inboundError: result.error,
    },
    updatedAt: now,
  }, { merge: true });
  return { ok: sent, ...result, kind: 'inbound' };
}

async function loadDepartureSignal(leg, db) {
  let tripState = null;
  let flightaware = null;
  try {
    const snap = await db.collection('trip-state').doc(leg.legUid).get();
    if (snap.exists) tripState = snap.data() || {};
  } catch (error) {
    console.warn('[fbo-cron] trip-state read failed', leg.legUid, error.message);
  }
  try {
    const tail = clean(leg.tail).toUpperCase();
    if (tail) {
      const snap = await db.collection('flightaware-state').doc(tail).get();
      if (snap.exists) flightaware = snap.data() || {};
    }
  } catch (error) {
    console.warn('[fbo-cron] flightaware-state read failed', leg.tail, error.message);
  }
  return pickDepartureSignal(leg, { tripState, flightaware });
}

function cronRelevant(leg, settings, now) {
  const startMs = toMillis(leg.start);
  const endMs = toMillis(leg.end);
  const override = normalizeLeadHours(leg.arrival?.leadHours);
  const globalLead = normalizeLeadHours(settings.arrivalAutoLeadHours) || 0;
  const lead = Math.max(globalLead, override || 0, 24);
  if (startMs != null && startMs > now - 12 * 60 * 60 * 1000 && startMs < now + 3 * 60 * 60 * 1000) return true;
  if (endMs != null && endMs > now - 2 * 60 * 60 * 1000 && endMs < now + (lead + 1) * 60 * 60 * 1000) return true;
  const sendAt = toMillis(leg.arrival?.sendAt);
  if (sendAt != null && sendAt < now + 15 * 60 * 1000 && endMs != null && endMs > now) return true;
  if (leg.arrival?.sentForEnd && iso(leg.arrival.sentForEnd) !== iso(leg.end) && endMs != null && endMs > now) return true;
  if (leg.actualOff || leg.actualOut || leg.departedManualAt || leg.departedAt) return true;
  return false;
}

export async function runFboCron({ db = fboDb(), now = Date.now() } = {}) {
  db = scrubFirestoreWrites(db);
  const settings = await loadSettings(db);
  const snap = await db.collection(FBO_LEGS).get();
  const summary = {
    scanned: snap.size,
    departureSent: 0,
    departureSkipped: 0,
    departureFailed: 0,
    arrivalSent: 0,
    arrivalFailed: 0,
    arrivalUpdated: 0,
    timeChangeSent: 0,
    inboundSent: 0,
    inboundFailed: 0,
    matched: 0,
  };
  for (const doc of snap.docs) {
    let leg = { legUid: doc.id, ...doc.data() };
    if (!cronRelevant(leg, settings, now) || isCancelledLeg(leg)) {
      summary.departureSkipped += 1;
      continue;
    }
    const needsMatch = !['auto', 'confirmed', 'manual'].includes(leg.departure?.matchStatus)
      || !['auto', 'confirmed', 'manual'].includes(leg.arrival?.matchStatus);
    if (needsMatch) {
      try {
        leg = await ensureMatches(leg, db);
        summary.matched += 1;
      } catch (error) {
        console.warn('[fbo-cron] match failed', leg.legUid, error.message);
      }
    }
    const directory = await loadDirectoryMap(db, [leg.from, leg.to]);
    const departure = departureReminderDecision(leg, now, directory);
    if (departure.action === 'send') {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendDepartureReminder(leg, { db, now, settings });
      if (result.ok && !result.skipped) summary.departureSent += 1;
      else if (result.skipped) summary.departureSkipped += 1;
      else summary.departureFailed += 1;
    } else summary.departureSkipped += 1;

    const arrival = arrivalScheduleDecision(leg, now, settings.arrivalAutoLeadHours, directory);
    if (arrival.action === 'send' || arrival.action === 'update' || arrival.action === 'time-change') {
      const kind = arrival.action === 'update' ? 'update' : (arrival.action === 'time-change' ? 'time-change' : 'schedule');
      // eslint-disable-next-line no-await-in-loop
      const result = await sendArrivalSchedule(leg, {
        db, now, settings, actor: { name: 'FBO cron' }, kind, idempotencyKey: arrival.key,
      });
      if (result.ok && kind === 'time-change') summary.timeChangeSent += 1;
      else if (result.ok && kind === 'update') summary.arrivalUpdated += 1;
      else if (result.ok) summary.arrivalSent += 1;
      else summary.arrivalFailed += 1;
      if (result.ok) {
        leg = {
          ...leg,
          arrival: cronArrivalFollowUp(leg, kind),
        };
      }
    }

    const signal = await loadDepartureSignal(leg, db);
    if (signal && iso(leg.departedAt) !== signal.at) {
      leg = { ...leg, departedAt: signal.at, departedSource: signal.source, actualOff: leg.actualOff || (signal.source === 'flightaware' || signal.source === 'actual_off' || signal.source === 'wheels_up' ? signal.at : leg.actualOff) };
    }
    const inbound = inboundDecision(leg, now, directory, signal);
    if (inbound.action === 'send') {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendInboundNotice(leg, {
        db, now, settings, actor: { name: 'FBO cron' },
        departedAt: signal.at, source: signal.source, idempotencyKey: inbound.key,
      });
      if (result.ok && !result.skipped) summary.inboundSent += 1;
      else if (!result.ok) summary.inboundFailed += 1;
    }
  }
  return summary;
}

function sidePatch(leg, side, patch) {
  const current = side === 'arrival' ? (leg.arrival || {}) : (leg.departure || {});
  return {
    ...blankSide({ airport: side === 'arrival' ? leg.to : leg.from }),
    ...current,
    ...patch,
  };
}

export async function runFboAction({ action, payload, actor, db = fboDb(), now = Date.now() }) {
  if (action === 'mark-notice-read') {
    const noticeId = clean(payload.noticeId);
    if (!noticeId) {
      const error = new Error('noticeId required');
      error.status = 400;
      throw error;
    }
    await db.collection(FBO_NOTICES).doc(noticeId).set({ read: true, readAt: now, readBy: actor?.uid || null }, { merge: true });
    return { ok: true };
  }
  const legUid = clean(payload?.legUid);
  if (!legUid) {
    const error = new Error('legUid required');
    error.status = 400;
    throw error;
  }
  const ref = db.collection(FBO_LEGS).doc(legUid);
  const snap = await ref.get();
  if (!snap.exists) {
    const error = new Error('Leg not found. Open the trip so it can sync.');
    error.status = 404;
    throw error;
  }
  let leg = { legUid, ...snap.data() };
  const sideName = payload.side === 'arrival' ? 'arrival' : 'departure';

  if (action === 'rematch') {
    if (payload.unlock === true) {
      leg = {
        ...leg,
        departure: { ...(leg.departure || {}), locked: false, matchStatus: 'unmatched' },
        arrival: { ...(leg.arrival || {}), locked: false, matchStatus: 'unmatched' },
      };
    }
    const next = await ensureMatches(leg, db);
    return { ok: true, leg: next };
  }

  if (action === 'select-fbo' || action === 'confirm-match' || action === 'save-contact') {
    const directory = await loadDirectoryMap(db, [sideName === 'arrival' ? leg.to : leg.from]);
    let patch = {};
    if (action === 'select-fbo') {
      patch = {
        aid: clean(payload.aid) || null,
        name: clipText(payload.name, 120),
        email: clipText(payload.email, 160),
        phone: clipText(payload.phone, 40),
        contact: clipText(payload.contact, 120),
        matchStatus: 'manual',
        locked: true,
        matchScore: 1,
        emailSource: payload.email ? 'ops' : '',
      };
    } else if (action === 'confirm-match') {
      patch = { matchStatus: 'confirmed', locked: true };
    } else {
      patch = {
        email: clipText(payload.email, 160),
        phone: clipText(payload.phone, 40),
        contact: clipText(payload.contact, 120),
        emailSource: 'ops',
        locked: true,
        matchStatus: leg[sideName]?.matchStatus === 'unmatched' ? 'manual' : (leg[sideName]?.matchStatus || 'manual'),
      };
    }
    if (patch.email && !validEmail(patch.email)) {
      const error = new Error('Enter a valid email address');
      error.status = 400;
      throw error;
    }
    const airport = sideName === 'arrival' ? leg.to : leg.from;
    const aid = patch.aid || leg[sideName]?.aid;
    if (payload.saveDirectory && aid) {
      await upsertDirectory({
        airport,
        aid,
        name: patch.name || leg[sideName]?.name,
        email: patch.email != null ? patch.email : leg[sideName]?.email,
        phone: patch.phone != null ? patch.phone : leg[sideName]?.phone,
        contact: patch.contact != null ? patch.contact : leg[sideName]?.contact,
        preferred: payload.preferred === true,
        optedOut: payload.optedOut === true,
        actor,
        db,
      });
    } else if (payload.optedOut != null && aid) {
      await upsertDirectory({
        airport,
        aid,
        name: leg[sideName]?.name,
        optedOut: payload.optedOut === true,
        preferred: payload.preferred === true,
        actor,
        db,
      });
    }
    const nextSide = sidePatch(leg, sideName, patch);
    await ref.set({ [sideName]: nextSide, updatedAt: now }, { merge: true });
    return { ok: true, leg: { ...leg, [sideName]: nextSide } };
  }

  if (action === 'set-disabled') {
    const emailsDisabled = payload.emailsDisabled === true;
    const sideSuppressed = payload.side ? { [sideName]: sidePatch(leg, sideName, { suppressed: payload.suppressed === true }) } : {};
    await ref.set({ emailsDisabled, ...sideSuppressed, updatedAt: now }, { merge: true });
    return { ok: true, leg: { ...leg, emailsDisabled, ...sideSuppressed } };
  }

  if (action === 'set-services') {
    const arrival = sidePatch(leg, 'arrival', {
      services: clipText(payload.services, 2000),
      opsNotes: clipText(payload.notes, 2000),
    });
    await ref.set({ arrival, updatedAt: now }, { merge: true });
    return { ok: true, leg: { ...leg, arrival } };
  }

  if (action === 'set-arrival-schedule') {
    const disabled = payload.scheduleDisabled === true || payload.leadHours === 'off';
    const leadHours = disabled ? 'off' : (payload.leadHours == null || payload.leadHours === '' || payload.leadHours === 'default'
      ? null
      : normalizeLeadHours(payload.leadHours));
    const sendAt = payload.clearSendAt || disabled ? null : (payload.sendAt ? iso(payload.sendAt) : null);
    const arrival = sidePatch(leg, 'arrival', {
      scheduleDisabled: disabled,
      leadHours: disabled ? 'off' : leadHours,
      sendAt,
    });
    if (payload.arrivalScheduleOff != null && leg.arrival?.aid) {
      await upsertDirectory({
        airport: leg.to,
        aid: leg.arrival.aid,
        name: leg.arrival.name,
        arrivalScheduleOff: payload.arrivalScheduleOff === true,
        actor,
        db,
      });
    }
    await ref.set({ arrival, updatedAt: now }, { merge: true });
    return { ok: true, leg: { ...leg, arrival } };
  }

  if (action === 'mark-departed') {
    const departedManualAt = iso(now);
    const next = { ...leg, departedManualAt, departedAt: departedManualAt, departedSource: 'manual' };
    await ref.set({ departedManualAt, departedSource: 'manual', updatedAt: now }, { merge: true });
    const result = await sendInboundNotice(next, {
      db, now, actor, departedAt: departedManualAt, source: 'manual', idempotencyKey: `${leg.legUid}:inbound`,
    });
    const fresh = await ref.get();
    return { ...result, leg: { legUid, ...fresh.data() } };
  }

  if (action === 'send-arrival' || action === 'resend-arrival') {
    if (!['auto', 'confirmed', 'manual'].includes(leg.arrival?.matchStatus)) {
      leg = await ensureMatches(leg, db);
    }
    const result = await sendArrivalSchedule(leg, {
      db,
      now,
      actor,
      services: payload.services,
      notes: payload.notes,
    });
    const fresh = await ref.get();
    return { ...result, leg: { legUid, ...fresh.data() } };
  }

  if (action === 'resend-departure') {
    if (!['auto', 'confirmed', 'manual'].includes(leg.departure?.matchStatus)) {
      leg = await ensureMatches(leg, db);
    }
    const forced = {
      ...leg,
      departure: { ...(leg.departure || {}), reminderStatus: 'scheduled', reminderSentForStart: null },
    };
    const result = await sendDepartureReminder(forced, { db, now, force: true });
    const fresh = await ref.get();
    return { ...result, leg: { legUid, ...fresh.data() } };
  }

  if (action === 'manual-confirm' || action === 'mark-scheduled') {
    const note = clipText(payload.note, 2000);
    const who = actor?.name || 'Skyway Ops';
    const arrival = sidePatch(leg, 'arrival', action === 'manual-confirm'
      ? {
        arrivalStatus: 'confirmed',
        confirmedBy: `Ops: ${who}`,
        confirmedAt: now,
        manualBy: who,
        manualNote: note,
        manualAt: now,
        csrNotes: note,
      }
      : {
        arrivalStatus: 'scheduled_manual',
        manualBy: who,
        manualNote: note,
        manualAt: now,
      });
    await ref.set({ arrival, updatedAt: now }, { merge: true });
    return { ok: true, leg: { ...leg, arrival } };
  }

  const error = new Error('Unknown action');
  error.status = 400;
  throw error;
}

export async function upsertDirectory({
  airport, aid, name, email, phone, contact, preferred, optedOut, arrivalScheduleOff, actor, db = fboDb(),
}) {
  const code = normalizeAirport(airport);
  if (!code || !clean(aid)) {
    const error = new Error('airport and aviowiki aid are required');
    error.status = 400;
    throw error;
  }
  if (email && !validEmail(email)) {
    const error = new Error('Enter a valid email address');
    error.status = 400;
    throw error;
  }
  const id = directoryDocId(code, aid);
  const ref = db.collection(FBO_DIRECTORY).doc(id);
  const prev = await ref.get();
  const before = prev.exists ? prev.data() || {} : {};
  const row = {
    airport: code,
    aid: clean(aid),
    name: clipText(name || before.name, 120),
    email: email != null ? clipText(email, 160) : (before.email || ''),
    phone: phone != null ? clipText(phone, 40) : (before.phone || ''),
    contact: contact != null ? clipText(contact, 120) : (before.contact || ''),
    preferred: preferred != null ? preferred === true : before.preferred === true,
    optedOut: optedOut != null ? optedOut === true : before.optedOut === true,
    arrivalScheduleOff: arrivalScheduleOff != null ? arrivalScheduleOff === true : before.arrivalScheduleOff === true,
    updatedAt: Date.now(),
    updatedByUid: actor?.uid || null,
    updatedByName: actor?.name || null,
  };
  await ref.set(row, { merge: true });
  if (row.preferred) {
    const others = await db.collection(FBO_DIRECTORY).where('airport', '==', code).get();
    const batch = db.batch();
    let writes = 0;
    others.forEach((doc) => {
      if (doc.id !== id && doc.data()?.preferred === true) {
        batch.set(doc.ref, { preferred: false }, { merge: true });
        writes += 1;
      }
    });
    if (writes) await batch.commit();
  }
  return { id, ...row };
}

export async function loadDesk({ filters, actor, db = fboDb(), now = Date.now() }) {
  const [legsSnap, noticeSnap, settings, auditSnap] = await Promise.all([
    db.collection(FBO_LEGS).get(),
    db.collection(FBO_NOTICES).orderBy('createdAt', 'desc').limit(30).get().catch(async () => {
      const fallback = await db.collection(FBO_NOTICES).limit(30).get();
      return fallback;
    }),
    loadSettings(db),
    actor?.role === 'admin'
      ? db.collection(FBO_EMAIL_LOG).orderBy('at', 'desc').limit(25).get().catch(async () => db.collection(FBO_EMAIL_LOG).limit(25).get())
      : Promise.resolve(null),
  ]);
  const legs = legsSnap.docs.map((doc) => ({ legUid: doc.id, ...doc.data() }));
  const notices = noticeSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const visible = filterDeskLegs(legs, filters || {}, now);
  return {
    ok: true,
    settings,
    counts: deskCounts(legs, now),
    unread: notices.filter((notice) => notice.read !== true).length,
    legs: visible,
    notices,
    audit: auditSnap ? auditSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) : [],
  };
}

export async function loadLeg(legUid, db = fboDb()) {
  const snap = await db.collection(FBO_LEGS).doc(legUid).get();
  if (!snap.exists) return null;
  return { legUid, ...snap.data() };
}

export async function publicGet(token, db = fboDb(), now = Date.now()) {
  const verified = verifyFboToken(token, now);
  if (!verified.ok) return { error: 'This link is invalid or has expired.', status: 401 };
  const leg = await loadLeg(verified.legUid, db);
  if (!leg) return { error: 'This arrival is no longer on file.', status: 404 };
  if (isCancelledLeg(leg)) return { error: 'This leg was cancelled. The link is closed.', status: 410 };
  if (leg.arrival?.tokenIssuedAt && verified.issuedAtMs !== leg.arrival.tokenIssuedAt) {
    return { error: 'This link has been replaced. Use the newest email from Skyway.', status: 403 };
  }
  const endMs = toMillis(leg.end);
  if (endMs != null && now > endMs + TOKEN_AFTER_ARRIVAL_MS) {
    return {
      error: 'This confirmation link has expired.',
      status: 410,
      view: publicLegView(leg, { timeZone: zoneFor(leg.to), expired: true }),
    };
  }
  if (leg.arrival?.arrivalStatus === 'sent' && !leg.arrival?.openedAt) {
    const arrival = {
      ...(leg.arrival || {}),
      openedAt: now,
      arrivalStatus: 'opened',
    };
    await db.collection(FBO_LEGS).doc(leg.legUid).set({ arrival, updatedAt: now }, { merge: true });
    leg.arrival = arrival;
  }
  return { ok: true, view: publicLegView(leg, { timeZone: zoneFor(leg.to) }) };
}

export async function publicRespond({ token, csrName, notes, kind, db = fboDb(), now = Date.now() }) {
  const loaded = await publicGet(token, db, now);
  if (!loaded.ok && loaded.status) {
    if (loaded.view?.expired) return loaded;
    if (!loaded.ok) return loaded;
  }
  const verified = verifyFboToken(token, now);
  if (!verified.ok) return { error: 'This link is invalid or has expired.', status: 401 };
  const leg = await loadLeg(verified.legUid, db);
  if (!leg) return { error: 'This arrival is no longer on file.', status: 404 };
  const name = clipText(csrName, 80);
  if (name.length < 2) return { error: 'Enter your name.', status: 400 };
  const text = clipText(notes, 2000);
  const question = kind === 'question';
  if (question && text.length < 2) return { error: 'Enter the question you want Skyway to see.', status: 400 };
  const arrival = {
    ...(leg.arrival || {}),
    arrivalStatus: question ? 'question' : 'confirmed',
    confirmedBy: name,
    confirmedAt: question ? (leg.arrival?.confirmedAt || null) : now,
    csrNotes: question ? (leg.arrival?.csrNotes || '') : text,
    question: question ? text : (leg.arrival?.question || ''),
    questionAt: question ? now : (leg.arrival?.questionAt || null),
    openedAt: leg.arrival?.openedAt || now,
  };
  await db.collection(FBO_LEGS).doc(leg.legUid).set({ arrival, updatedAt: now }, { merge: true });
  const saved = { ...leg, arrival };
  await notifyOps(db, { kind: question ? 'question' : 'confirmed', leg: saved, csrName: name, notes: text });
  return { ok: true, view: publicLegView(saved, { timeZone: zoneFor(leg.to) }) };
}

export function jsonError(res, error) {
  const status = error.status || 500;
  console.error('[fbo]', error.code || '', error.message);
  res.status(status).json({ error: error.message || 'FBO request failed', code: error.code || null });
}

export { readBody };
