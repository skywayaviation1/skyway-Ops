// /api/duty-state.js
//
// Manages pilot duty status with Part 135.267 rule enforcement.
//
// GET ?pilotUid=... → returns duty state for one pilot
// GET                → returns all pilots' duty state (admin/ops only)
// POST { action, pilotUid, ...fields }
//   action = 'duty-on'          → start duty period
//   action = 'duty-off'         → end duty period (any pilot, themselves only)
//   action = 'admin-duty-off'   → admin closes duty for a pilot (with custom time)
//   action = 'override-rest'    → flag the rest override (still goes on duty)
//
// Auth: Firebase idToken required.
// Rules enforced:
//   - 10h minimum rest before duty-on (soft, can override with confirmation)
//   - Duty-on must be within 1h of first scheduled flight (admin can override)
//   - 14h duty cap (warned at 13h, auto-off blocked if exceeds)
//   - 10h flight time cap per duty period
// Note: This is a tool for awareness. Pilots maintain legal duty records per 135.267.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

export const config = { runtime: 'nodejs' };

let adminApp = null;
let _db = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}
function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

const TEN_HOURS_MS = 10 * 60 * 60 * 1000;
const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

async function authorize(req) {
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!idToken) return null;
  try {
    const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken);
    // Look up role
    const userDoc = await getDb().collection('users').doc(decoded.uid).get();
    if (!userDoc.exists) return null;
    return { uid: decoded.uid, ...userDoc.data() };
  } catch (_) {
    return null;
  }
}

function isAdminOrOps(user) {
  return user && (user.role === 'admin' || user.role === 'ops');
}

/**
 * Look up the pilot's next scheduled flight start time by searching the
 * `trips` collection where info.pic or info.sic matches the pilot's name.
 * Returns the earliest upcoming trip's start time (ms), or null.
 */
async function findNextScheduledFlight(pilotName) {
  if (!pilotName) return null;
  const db = getDb();
  const nowIso = new Date().toISOString();
  // Query trips by either PIC or SIC name match. Firestore doesn't support
  // OR queries on different fields easily, so we run two queries in parallel.
  const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [picSnap, sicSnap] = await Promise.all([
      db.collection('trips')
        .where('info.pic', '==', pilotName)
        .where('start', '>=', nowIso)
        .where('start', '<=', sevenDaysOut)
        .orderBy('start', 'asc')
        .limit(1)
        .get(),
      db.collection('trips')
        .where('info.sic', '==', pilotName)
        .where('start', '>=', nowIso)
        .where('start', '<=', sevenDaysOut)
        .orderBy('start', 'asc')
        .limit(1)
        .get(),
    ]);
    const picTrip = picSnap.docs[0]?.data();
    const sicTrip = sicSnap.docs[0]?.data();
    const picStart = picTrip?.start ? new Date(picTrip.start).getTime() : Infinity;
    const sicStart = sicTrip?.start ? new Date(sicTrip.start).getTime() : Infinity;
    const earliest = Math.min(picStart, sicStart);
    return isFinite(earliest) ? earliest : null;
  } catch (e) {
    console.warn('[duty-state] findNextScheduledFlight failed:', e.message);
    return null;
  }
}

/**
 * Sum flight time for this pilot since their current duty-on time, using
 * actual_off/actual_on from any trip where they were PIC or SIC.
 */
async function computeFlightMinutesSinceDutyOn(pilotName, dutyOnMs) {
  if (!pilotName || !dutyOnMs) return 0;
  const db = getDb();
  try {
    const sinceIso = new Date(dutyOnMs).toISOString();
    const [picSnap, sicSnap] = await Promise.all([
      db.collection('trips')
        .where('info.pic', '==', pilotName)
        .where('start', '>=', sinceIso)
        .get(),
      db.collection('trips')
        .where('info.sic', '==', pilotName)
        .where('start', '>=', sinceIso)
        .get(),
    ]);
    const trips = [...picSnap.docs, ...sicSnap.docs].map(d => d.data());
    let totalMs = 0;
    for (const t of trips) {
      // Pull actual_off/actual_on from trip-state if present
      const tsDoc = await db.collection('trip-state').doc(t.uid).get();
      if (!tsDoc.exists) continue;
      const ts = tsDoc.data();
      const off = ts.actualOff ? new Date(ts.actualOff).getTime() : null;
      const on = ts.actualOn ? new Date(ts.actualOn).getTime() : null;
      if (off && on && on > off && off >= dutyOnMs) {
        totalMs += on - off;
      }
    }
    return Math.round(totalMs / 60000);
  } catch (e) {
    console.warn('[duty-state] computeFlightMinutes failed:', e.message);
    return 0;
  }
}

async function getDutyState(pilotUid) {
  const db = getDb();
  const doc = await db.collection('duty-state').doc(pilotUid).get();
  if (!doc.exists) {
    return {
      pilotUid,
      status: 'off',
      dutyOnAt: null,
      dutyOffAt: null,
      history: [],
    };
  }
  return doc.data();
}

async function handleGet(req, res, user) {
  const pilotUid = req.query?.pilotUid || user.uid;
  // Non-admin can only query themselves
  if (pilotUid !== user.uid && !isAdminOrOps(user)) {
    return res.status(403).json({ error: 'You can only view your own duty state' });
  }
  const state = await getDutyState(pilotUid);

  // Enrich with live flight time + next scheduled if on duty
  let flightMinutes = 0;
  let nextScheduledFlight = null;
  let pilotName = state.pilotName;
  if (!pilotName) {
    const userDoc = await getDb().collection('users').doc(pilotUid).get();
    pilotName = userDoc.exists ? userDoc.data().name : null;
  }
  if (state.status === 'on' && state.dutyOnAt) {
    const onMs = typeof state.dutyOnAt === 'object' ? state.dutyOnAt.toMillis() : new Date(state.dutyOnAt).getTime();
    flightMinutes = await computeFlightMinutesSinceDutyOn(pilotName, onMs);
  } else {
    nextScheduledFlight = await findNextScheduledFlight(pilotName);
  }

  return res.status(200).json({
    ok: true,
    pilotUid,
    pilotName,
    state,
    flightMinutes,
    nextScheduledFlight,
  });
}

async function handlePost(req, res, user) {
  const body = req.body || {};
  const action = String(body.action || '');
  const targetUid = body.pilotUid || user.uid;
  const isSelfAction = targetUid === user.uid;

  // Only admin can act on someone else's duty
  if (!isSelfAction && !isAdminOrOps(user)) {
    return res.status(403).json({ error: 'Only admin/ops can modify another pilot\'s duty state' });
  }

  const db = getDb();
  const ref = db.collection('duty-state').doc(targetUid);
  const stateDoc = await ref.get();
  const state = stateDoc.exists ? stateDoc.data() : {
    pilotUid: targetUid,
    status: 'off',
    dutyOnAt: null,
    dutyOffAt: null,
    history: [],
  };

  // Look up pilot's display name
  let pilotName = state.pilotName;
  if (!pilotName) {
    const userDoc = await db.collection('users').doc(targetUid).get();
    pilotName = userDoc.exists ? userDoc.data().name : 'Pilot';
  }

  const now = Date.now();
  const nowDate = admin.firestore.Timestamp.fromMillis(now);

  // ===== duty-on =====
  if (action === 'duty-on') {
    if (state.status === 'on') {
      return res.status(400).json({ error: 'Already on duty' });
    }
    // Check rest minimum
    const lastOffMs = state.dutyOffAt
      ? (typeof state.dutyOffAt === 'object' ? state.dutyOffAt.toMillis() : new Date(state.dutyOffAt).getTime())
      : null;
    const restMs = lastOffMs ? (now - lastOffMs) : Infinity;
    const restShortBy = TEN_HOURS_MS - restMs;
    const overridingRest = !!body.overrideRest;
    if (restShortBy > 0 && !overridingRest && !isAdminOrOps(user)) {
      return res.status(409).json({
        error: 'rest_insufficient',
        restMs,
        requiredMs: TEN_HOURS_MS,
        shortByMs: restShortBy,
        message: `Less than 10 hours of rest (${Math.floor(restMs / 60000)} min so far). Confirm to override.`,
      });
    }

    // Check 1h-before-first-flight rule
    const nextFlight = await findNextScheduledFlight(pilotName);
    const overridingWindow = !!body.overrideWindow;
    if (nextFlight && !overridingWindow && !isAdminOrOps(user)) {
      const timeUntilFlight = nextFlight - now;
      if (timeUntilFlight > ONE_HOUR_MS) {
        return res.status(409).json({
          error: 'too_early',
          timeUntilFlightMs: timeUntilFlight,
          requiredMs: ONE_HOUR_MS,
          message: `Duty-on allowed within 1h of first flight (${Math.floor(timeUntilFlight / 60000)} min away). Confirm to override.`,
        });
      }
    }

    // Apply
    const newState = {
      ...state,
      pilotUid: targetUid,
      pilotName,
      status: 'on',
      dutyOnAt: nowDate,
      dutyOffAt: state.dutyOffAt || null,
      updatedAt: nowDate,
      updatedBy: user.uid,
      currentOverrides: [
        ...(overridingRest ? [{ type: 'rest', byUid: user.uid, byName: user.name, at: nowDate, restMs, shortByMs: restShortBy }] : []),
        ...(overridingWindow ? [{ type: 'window', byUid: user.uid, byName: user.name, at: nowDate }] : []),
      ],
    };
    await ref.set(newState, { merge: true });
    return res.status(200).json({ ok: true, state: newState });
  }

  // ===== duty-off (regular, by the pilot themselves or auto) =====
  if (action === 'duty-off') {
    if (state.status !== 'on') {
      return res.status(400).json({ error: 'Not currently on duty' });
    }
    const onMs = typeof state.dutyOnAt === 'object' ? state.dutyOnAt.toMillis() : new Date(state.dutyOnAt).getTime();
    const dutyDurationMs = now - onMs;

    // If duty > 14h and not admin, refuse
    if (dutyDurationMs > FOURTEEN_HOURS_MS && !isAdminOrOps(user)) {
      return res.status(409).json({
        error: 'duty_exceeds_14h',
        dutyDurationMs,
        message: 'Duty period exceeds 14 hours. Admin must close this duty period.',
      });
    }

    const flightMinutes = await computeFlightMinutesSinceDutyOn(pilotName, onMs);
    const newHistoryEntry = {
      onAt: state.dutyOnAt,
      offAt: nowDate,
      durationMs: dutyDurationMs,
      flightMinutes,
      restPriorMs: state.dutyOffAt
        ? onMs - (typeof state.dutyOffAt === 'object' ? state.dutyOffAt.toMillis() : new Date(state.dutyOffAt).getTime())
        : null,
      overrides: state.currentOverrides || [],
    };

    const newState = {
      pilotUid: targetUid,
      pilotName,
      status: 'off',
      dutyOnAt: null,
      dutyOffAt: nowDate,
      currentOverrides: [],
      history: [newHistoryEntry, ...(state.history || [])].slice(0, 30),
      updatedAt: nowDate,
      updatedBy: user.uid,
    };
    await ref.set(newState);
    return res.status(200).json({ ok: true, state: newState });
  }

  // ===== admin-duty-off (admin closes with arbitrary time) =====
  if (action === 'admin-duty-off') {
    if (!isAdminOrOps(user)) {
      return res.status(403).json({ error: 'Only admin/ops can use admin-duty-off' });
    }
    if (state.status !== 'on') {
      return res.status(400).json({ error: 'Pilot is not currently on duty' });
    }
    const dutyOffMs = body.dutyOffAt ? new Date(body.dutyOffAt).getTime() : now;
    if (!isFinite(dutyOffMs)) {
      return res.status(400).json({ error: 'Invalid dutyOffAt timestamp' });
    }
    const onMs = typeof state.dutyOnAt === 'object' ? state.dutyOnAt.toMillis() : new Date(state.dutyOnAt).getTime();
    const dutyDurationMs = dutyOffMs - onMs;
    if (dutyDurationMs < 0) {
      return res.status(400).json({ error: 'duty-off cannot be before duty-on' });
    }

    const flightMinutes = await computeFlightMinutesSinceDutyOn(pilotName, onMs);
    const offTimestamp = admin.firestore.Timestamp.fromMillis(dutyOffMs);
    const newHistoryEntry = {
      onAt: state.dutyOnAt,
      offAt: offTimestamp,
      durationMs: dutyDurationMs,
      flightMinutes,
      restPriorMs: state.dutyOffAt
        ? onMs - (typeof state.dutyOffAt === 'object' ? state.dutyOffAt.toMillis() : new Date(state.dutyOffAt).getTime())
        : null,
      overrides: [
        ...(state.currentOverrides || []),
        { type: 'admin-close', byUid: user.uid, byName: user.name, at: nowDate, reason: body.reason || null },
      ],
    };

    const newState = {
      pilotUid: targetUid,
      pilotName,
      status: 'off',
      dutyOnAt: null,
      dutyOffAt: offTimestamp,
      currentOverrides: [],
      history: [newHistoryEntry, ...(state.history || [])].slice(0, 30),
      updatedAt: nowDate,
      updatedBy: user.uid,
    };
    await ref.set(newState);
    return res.status(200).json({ ok: true, state: newState });
  }

  return res.status(400).json({ error: 'Unknown action' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const user = await authorize(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  try {
    if (req.method === 'GET') return await handleGet(req, res, user);
    if (req.method === 'POST') return await handlePost(req, res, user);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[duty-state] error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
